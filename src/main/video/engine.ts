// Video projects, agent turns, checks and renders.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DetectedAgent } from '../../shared/types'
import type { NewVideo, PointNote, VideoAgent, VideoCheck, VideoProject, VideoRender, VideoTurn } from '../../shared/video'
import type { RunHandle, RunOptions } from '../heats/runner'
import { findOnPath } from '../env'
import { copyBrandAssets } from './assets'
import { buildTurnPrompt, turnNote, type TurnKind } from './prompt'
import type { RenderJob } from './render-child'
import { checksOf, parseReport, thumbName, type RenderReport } from './report'
import * as store from './store'

/** Every video runs at this frame rate. */
export const VIDEO_FPS = 30
/** How much of PLAN.md the user may save. */
export const PLAN_LIMIT = 50000
/** How long a note against a point on a frame may be. */
export const NOTE_LIMIT = 1000
/** Lines of agent activity kept against a turn. */
export const LATEST_LINES = 10
/** Snapshots kept per video. */
export const HISTORY_KEEP = store.SNAPSHOT_KEEP
/** Emissions a second while a turn or a render runs: one every this many milliseconds. */
const EMIT_EVERY_MS = 250

const AGENT_NAMES: Record<VideoAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  fake: 'Test Agent'
}

/** Agents that can take a video turn on their own. */
export function canRunHeadless(kind: VideoAgent): boolean {
  return kind === 'claude' || kind === 'codex' || kind === 'fake'
}

export interface VideoEngineDeps {
  /** App data folder: videos live in <dataDir>/videos/<id>/. */
  dataDir: string
  /** Folder with regatta-video.js, regatta-video.css, AGENT_GUIDE.md and example/. */
  resourcesDir: string
  /** The open project folder; new videos are about it. */
  root: () => string
  env: () => Record<string, string>
  agents: () => DetectedAgent[]
  /** Runs one agent CLI headless on the turn's prompt (see src/main/heats/runner.ts). */
  run: (opts: RunOptions) => RunHandle
  /** Starts a render process for a job file (the app binary with --regatta-render=<file>). */
  spawnRender: (jobFile: string) => { done: Promise<number | null>; stop: () => void; output: (fn: (line: string) => void) => void }
  emit: (video: VideoProject) => void
  emitRemoved: (id: string) => void
  now?: () => number
}

interface VideoState {
  project: VideoProject
  folder: string
  removed: boolean
}

/** Something running for one video: a turn, the checks, or a render. Stopping it is idempotent. */
interface Op {
  stop: () => void
  stopped: boolean
  /** Settles when the render process has ended (renders and checks only). */
  ended?: Promise<unknown>
}

/** How a run of the render process ended. */
interface ChildOutcome {
  /** What the process wrote to its report file, or null when it wrote nothing usable. */
  report: RenderReport | null
  code: number | null
  stopped: boolean
  /** Why there is no report, when the process could not even be started. */
  error?: string
}

function appendLatest(previous: string, line: string): string {
  const lines = previous ? previous.split('\n') : []
  lines.push(line)
  return lines.slice(-LATEST_LINES).join('\n')
}

function messageOf(err: unknown): string {
  const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)
  return message || 'Something went wrong.'
}

function shortId(prefix: string, at: number): string {
  return `${prefix}${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** One line of progress from a render process: {"frame":120,"of":360}. */
export function parseFrameLine(line: string): { frame: number; of: number } | null {
  try {
    const data = JSON.parse(line) as { frame?: unknown; of?: unknown }
    if (typeof data.frame === 'number' && typeof data.of === 'number' && data.of > 0) {
      return { frame: data.frame, of: data.of }
    }
  } catch {
    // Not a progress line.
  }
  return null
}

/** A point the user chose, with the text cut to a sane size and the numbers made real. */
function cleanPoint(note: PointNote, wish: string): PointNote {
  const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)
  return {
    time: Math.max(0, finite(note.time)),
    scene: typeof note.scene === 'string' ? note.scene.slice(0, 120) : null,
    selector: typeof note.selector === 'string' ? note.selector.slice(0, 300) : null,
    text: typeof note.text === 'string' ? note.text.slice(0, 300) : '',
    x: finite(note.x),
    y: finite(note.y),
    note: wish
  }
}

export class VideoEngine {
  private readonly videos = new Map<string, VideoState>()
  private readonly ops = new Map<string, Op>()
  private readonly lastEmit = new Map<string, number>()

  constructor(private readonly deps: VideoEngineDeps) {
    this.loadAll()
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /**
   * Loads every video under <dataDir>/videos/. A video.json that is broken, or that is not the
   * folder's own, is skipped. Whatever was running when the app quit is settled as stopped, and
   * the half-written file of a render that was cut off is removed.
   */
  private loadAll(): void {
    for (const folder of store.listVideoFolders(this.deps.dataDir)) {
      const loaded = store.readProject(folder)
      if (!loaded) continue
      const project = store.settleAfterRestart(loaded, this.now())
      for (const render of loaded.renders) {
        if (render.status !== 'rendering') continue
        try {
          rmSync(join(folder, render.path), { force: true })
        } catch {
          // A file that cannot be removed is left for the user.
        }
      }
      if (JSON.stringify(project) !== JSON.stringify(loaded)) {
        try {
          store.writeProject(folder, project)
        } catch {
          // It is written again at the next save.
        }
      }
      this.videos.set(project.id, { project, folder, removed: false })
    }
  }

  /** A copy of a video for the renderer, with the fields that are derived from the folder. */
  private view(state: VideoState): VideoProject {
    const project = state.project
    return {
      ...project,
      scenes: project.scenes.map((scene) => ({ ...scene })),
      turns: project.turns.map((turn) => ({ ...turn })),
      checks: project.checks.map((check) => ({ ...check })),
      renders: project.renders.map((render) => ({ ...render })),
      thumbnails: { ...project.thumbnails },
      canUndo: store.listSnapshots(state.folder).length > 0
    }
  }

  /** Writes video.json and tells the renderer. Never throws: a disk that is full must not stop a turn. */
  private save(state: VideoState): void {
    if (state.removed) return
    state.project.updatedAt = this.now()
    try {
      store.writeProject(state.folder, state.project)
    } catch (err) {
      console.error('[video] could not save', state.project.id, err)
    }
    this.deps.emit(this.view(state))
  }

  /** Saves and emits at most four times a second while something runs. */
  private touch(state: VideoState): void {
    // The real clock, not deps.now: this only keeps the renderer from being flooded.
    const at = Date.now()
    if (at - (this.lastEmit.get(state.project.id) ?? 0) < EMIT_EVERY_MS) return
    this.lastEmit.set(state.project.id, at)
    this.save(state)
  }

  private stateOf(id: string): VideoState {
    const state = this.videos.get(id)
    if (!state) throw new Error('That video no longer exists.')
    return state
  }

  private checkIdle(id: string): void {
    if (this.ops.has(id)) throw new Error('This video is busy.')
  }

  list(): VideoProject[] {
    return [...this.videos.values()]
      .map((state) => this.view(state))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The folder of a video, or null for an unknown id. Used by the regatta-video protocol. */
  folderOf(id: string): string | null {
    return this.videos.get(id)?.folder ?? null
  }

  /** The installed agent for a video, or the reason there is not one. */
  private agentFor(kind: VideoAgent): DetectedAgent {
    if (!canRunHeadless(kind)) throw new Error('That agent cannot work on videos yet.')
    const detected = this.deps.agents().find((agent) => agent.kind === kind && agent.installed && agent.path)
    if (!detected) throw new Error(`${AGENT_NAMES[kind]} is not installed. Install it, then start the video.`)
    return detected
  }

  create(opts: NewVideo): VideoProject {
    const title = String(opts.title ?? '').trim()
    if (title.length === 0 || title.length > 80) throw new Error('Give the video a title of 1 to 80 characters.')
    const brief = String(opts.brief ?? '').trim()
    if (brief.length === 0 || brief.length > 2000) throw new Error('Describe the video in 1 to 2000 characters.')
    const size = store.sizeOf(opts.aspect)
    this.agentFor(opts.agent)
    const projectRoot = this.deps.root()
    if (!projectRoot) throw new Error('Open a project folder before creating a video.')

    let id = store.newVideoId()
    while (existsSync(store.videoFolder(this.deps.dataDir, id))) id = store.newVideoId()
    const folder = store.videoFolder(this.deps.dataDir, id)
    try {
      for (const dir of [store.ASSETS_DIR, store.RENDERS_DIR, store.THUMBS_DIR, store.HISTORY_DIR]) {
        mkdirSync(join(folder, dir), { recursive: true })
      }
      store.copyRuntimeFiles(this.deps.resourcesDir, folder)
      writeFileSync(store.indexPath(folder), store.starterHtml(title, size.width, size.height, VIDEO_FPS), 'utf8')
      copyBrandAssets(projectRoot, folder)
      const at = this.now()
      const project: VideoProject = {
        id,
        title,
        brief,
        aspect: opts.aspect,
        width: size.width,
        height: size.height,
        fps: VIDEO_FPS,
        agent: opts.agent,
        projectRoot,
        status: 'new',
        duration: null,
        scenes: [],
        turns: [],
        checks: [],
        renders: [],
        thumbnails: {},
        canUndo: false,
        createdAt: at,
        updatedAt: at
      }
      store.writeProject(folder, project)
      const state: VideoState = { project, folder, removed: false }
      this.videos.set(id, state)
      this.deps.emit(this.view(state))
      return this.view(state)
    } catch (err) {
      this.videos.delete(id)
      try {
        store.removeVideoFolder(this.deps.dataDir, id)
      } catch {
        // Nothing more can be done about a folder that will not go.
      }
      throw new Error(`The video could not be created: ${messageOf(err)}`)
    }
  }

  /** Stops anything running for the video, then deletes its folder and nothing else. */
  remove(id: string): void {
    const state = this.videos.get(id)
    if (!state) return
    // Marked first, so a turn or render that is still winding down cannot save the folder back.
    state.removed = true
    this.ops.get(id)?.stop()
    try {
      store.removeVideoFolder(this.deps.dataDir, id)
    } catch {
      state.removed = false
      throw new Error('The video could not be deleted. Close anything that is using its folder, then try again.')
    }
    this.ops.delete(id)
    this.videos.delete(id)
    this.lastEmit.delete(id)
    this.deps.emitRemoved(id)
  }

  plan(id: string): Promise<VideoProject> {
    return this.runTurn(id, 'plan')
  }

  build(id: string): Promise<VideoProject> {
    return this.runTurn(id, 'build')
  }

  readPlan(id: string): string {
    return store.readPlan(this.stateOf(id).folder)
  }

  /** Saves PLAN.md; with `tell`, the agent revises the video to match it. */
  async savePlan(id: string, text: string, tell: boolean): Promise<VideoProject> {
    const state = this.stateOf(id)
    this.checkIdle(id)
    const body = String(text ?? '')
    if (body.length > PLAN_LIMIT) throw new Error(`PLAN.md is too long. Keep it under ${PLAN_LIMIT} characters.`)
    if (tell && body.trim().length === 0) throw new Error('Write the plan before asking the agent to follow it.')
    store.writePlan(state.folder, body)
    const project = state.project
    const lastTurn = project.turns[project.turns.length - 1]
    // A plan the user wrote makes a video that has none (or whose plan turn failed) ready to build.
    if (body.trim().length > 0 && (project.status === 'new' || (project.status === 'failed' && lastTurn?.kind === 'plan'))) {
      project.status = 'planned'
    }
    this.save(state)
    if (!tell) return this.view(state)
    return this.runTurn(id, 'revise')
  }

  async changeAt(id: string, note: PointNote): Promise<VideoProject> {
    this.stateOf(id)
    this.checkIdle(id)
    const wish = String(note?.note ?? '').trim()
    if (wish.length === 0 || wish.length > NOTE_LIMIT) {
      throw new Error(`Describe the change in 1 to ${NOTE_LIMIT} characters.`)
    }
    return this.runTurn(id, 'change', cleanPoint(note, wish))
  }

  async undo(id: string): Promise<VideoProject> {
    const state = this.stateOf(id)
    this.checkIdle(id)
    const names = store.listSnapshots(state.folder)
    const newest = names[names.length - 1]
    if (!newest) throw new Error('Nothing to undo.')
    store.restoreSnapshot(state.folder, newest)
    store.copyRuntimeFiles(this.deps.resourcesDir, state.folder)
    this.save(state)
    await this.runChecks(state, { allowFix: false, turn: null })
    return this.view(state)
  }

  stop(id: string): void {
    this.ops.get(id)?.stop()
  }

  /** On quit: stops every turn and render, and waits until each render process has ended. */
  async quit(): Promise<void> {
    const running = [...this.ops.values()]
    for (const op of running) op.stop()
    await Promise.allSettled(running.map((op) => op.ended))
  }

  async render(id: string): Promise<VideoProject> {
    const state = this.stateOf(id)
    this.checkIdle(id)
    const project = state.project
    if (project.status !== 'ready') throw new Error('Build the video and pass its checks before rendering it.')
    const ffmpeg = findOnPath('ffmpeg', this.deps.env())
    if (!ffmpeg) throw new Error('Rendering needs ffmpeg. Install it with Homebrew: brew install ffmpeg')
    // The page renders on Regatta's runtime, whatever the agent did to the copy in the folder.
    store.copyRuntimeFiles(this.deps.resourcesDir, state.folder)

    const startedAt = this.now()
    const render: VideoRender = {
      id: shortId('r', startedAt),
      path: store.uniqueRenderPath(state.folder, project.title, startedAt, project.renders.map((r) => r.path)),
      status: 'rendering',
      progress: 0,
      startedAt,
      endedAt: null,
      sizeBytes: null,
      loudness: null,
      note: ''
    }
    project.renders.unshift(render)
    this.save(state)

    const file = join(state.folder, render.path)
    const outcome = await this.runChild(state, 'render', {
      out: file,
      ffmpeg,
      onLine: (line) => {
        const progress = parseFrameLine(line)
        if (!progress) return
        render.progress = Math.max(0, Math.min(1, progress.frame / progress.of))
        this.touch(state)
      }
    })
    if (state.removed) return this.view(state)

    render.endedAt = this.now()
    const report = outcome.report
    // A report that says it worked, and the file it names, mean it finished, even if Stop came late.
    const size = store.fileSize(file)
    if (report?.ok && size !== null && size > 0) {
      render.status = 'done'
      render.progress = 1
      render.sizeBytes = size
      render.loudness = report.loudness
      const loudness = report.loudness !== null ? `${report.loudness} LUFS` : 'Rendered, with no music.'
      render.note = report.note ? `${loudness}. ${report.note}` : loudness
    } else {
      render.status = outcome.stopped ? 'stopped' : 'failed'
      render.note = outcome.stopped
        ? 'Stopped.'
        : report?.error || outcome.error || `The render process exited with code ${outcome.code}.`
      if (!outcome.stopped) render.progress = 0
      // A render that did not finish leaves no half-written file behind.
      try {
        rmSync(file, { force: true })
      } catch {
        // A file that cannot be removed is left for the user.
      }
    }
    this.save(state)
    return this.view(state)
  }

  /**
   * Runs the render process once, for a check or a render, and says how it ended. The job and report
   * files live in a scratch folder that is removed afterwards.
   */
  private async runChild(
    state: VideoState,
    kind: 'check' | 'render',
    extra: { out?: string; ffmpeg?: string; onLine?: (line: string) => void }
  ): Promise<ChildOutcome> {
    const project = state.project
    const op: Op = { stop: () => {}, stopped: false }
    this.ops.set(project.id, op)
    let dir: string | null = null
    try {
      dir = store.makeJobDir()
      const reportFile = join(dir, 'report.json')
      const job: RenderJob = {
        folder: state.folder,
        width: project.width,
        height: project.height,
        fps: project.fps,
        kind,
        out: extra.out ?? '',
        report: reportFile,
        ffmpeg: extra.ffmpeg ?? null
      }
      const jobFile = join(dir, 'job.json')
      writeFileSync(jobFile, JSON.stringify(job), 'utf8')
      const child = this.deps.spawnRender(jobFile)
      op.ended = child.done
      op.stop = () => {
        op.stopped = true
        child.stop()
      }
      // Always read: a process whose output nobody reads would stall once the pipe fills.
      child.output((line) => extra.onLine?.(line))
      const code = await child.done
      return { report: parseReport(store.readJson<unknown>(reportFile)), code, stopped: op.stopped }
    } catch (err) {
      return { report: null, code: null, stopped: op.stopped, error: messageOf(err) }
    } finally {
      this.ops.delete(project.id)
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch {
          // A scratch folder that will not go is left to the system's temp cleaning.
        }
      }
      this.sweep(state)
    }
  }

  /**
   * A video that was removed while something ran for it: the process that was winding down may have
   * written into its folder after the delete (a thumbnail, a half-written file), so it goes again.
   */
  private sweep(state: VideoState): void {
    if (!state.removed) return
    try {
      store.removeVideoFolder(this.deps.dataDir, state.project.id)
    } catch {
      // Nothing more can be done about a folder that will not go.
    }
  }

  /** One agent turn: snapshot, run, then whatever the turn is for. */
  private async runTurn(id: string, kind: TurnKind, note?: PointNote, failing?: VideoCheck[]): Promise<VideoProject> {
    const state = this.stateOf(id)
    this.checkIdle(id)
    const project = state.project
    const agent = this.agentFor(project.agent)
    const folder = state.folder

    const snapshot = store.nextSnapshotName(folder)
    store.snapshotFolder(folder, snapshot)
    store.trimSnapshots(folder, HISTORY_KEEP)
    store.copyRuntimeFiles(this.deps.resourcesDir, folder)

    const startedAt = this.now()
    const turn: VideoTurn = {
      id: shortId('t', startedAt),
      kind,
      status: 'running',
      startedAt,
      endedAt: null,
      note: turnNote(kind, note),
      tokens: null,
      latest: ''
    }
    project.turns.push(turn)
    project.status = kind === 'plan' ? 'planning' : 'building'
    this.save(state)

    const op: Op = { stop: () => {}, stopped: false }
    this.ops.set(id, op)
    try {
      const prompt = buildTurnPrompt({
        videoFolder: folder,
        projectRoot: project.projectRoot,
        resourcesDir: this.deps.resourcesDir,
        title: project.title,
        brief: project.brief,
        width: project.width,
        height: project.height,
        fps: project.fps,
        kind,
        note,
        failing
      })
      const handle = this.deps.run({
        agent: project.agent,
        command: agent.path ?? agent.command,
        // Claude may read the project it is about; nothing extra for the others.
        baseArgs: agent.kind === 'claude' ? [...agent.args, '--add-dir', project.projectRoot] : [...agent.args],
        prompt,
        cwd: folder,
        env: this.deps.env(),
        allowCommands: false,
        onActivity: (line) => {
          turn.latest = appendLatest(turn.latest, line)
          this.touch(state)
        },
        onTokens: (total) => {
          turn.tokens = total
          this.touch(state)
        }
      })
      op.stop = () => {
        op.stopped = true
        handle.stop()
      }
      const result = await handle.done
      turn.endedAt = this.now()
      if (result.tokens !== null) turn.tokens = result.tokens
      if (op.stopped) {
        turn.status = 'stopped'
        project.status = 'failed'
      } else if (result.exitCode !== 0) {
        turn.status = 'failed'
        turn.latest = appendLatest(
          turn.latest,
          result.exitCode === null ? 'The agent could not run.' : `The agent exited with code ${result.exitCode}.`
        )
        project.status = 'failed'
      } else {
        turn.status = 'done'
      }
      this.save(state)
    } catch (err) {
      turn.status = 'failed'
      turn.endedAt = this.now()
      turn.latest = appendLatest(turn.latest, messageOf(err))
      project.status = 'failed'
      this.save(state)
    } finally {
      this.ops.delete(id)
    }

    if (state.removed) {
      this.sweep(state)
      return this.view(state)
    }
    if (turn.status === 'done' && kind === 'plan') {
      if (store.planIsFilled(folder)) {
        project.status = 'planned'
      } else {
        turn.status = 'failed'
        turn.latest = appendLatest(turn.latest, 'No PLAN.md was written.')
        project.status = 'failed'
      }
      this.save(state)
    }
    if (turn.status === 'done' && kind !== 'plan') await this.runChecks(state, { allowFix: true, turn })
    return this.view(state)
  }

  /**
   * Runs the checks in a render process and records what they found. Failed checks send the agent
   * one fix turn, unless this follows a fix turn already or the checks could not run at all (that is
   * the machine's fault, not the video's).
   */
  private async runChecks(state: VideoState, opts: { allowFix: boolean; turn: VideoTurn | null }): Promise<void> {
    try {
      await this.checkAndSettle(state, opts)
    } catch (err) {
      // Whatever went wrong, the video must not stay "checking" with nothing running for it.
      if (state.removed) return
      state.project.checks = [{ name: 'loads', passed: false, detail: `The checks could not run: ${messageOf(err)}` }]
      state.project.status = 'failed'
      this.save(state)
    }
  }

  private async checkAndSettle(state: VideoState, opts: { allowFix: boolean; turn: VideoTurn | null }): Promise<void> {
    const project = state.project
    project.status = 'checking'
    this.save(state)
    // The page must run on Regatta's runtime, whatever the agent did to the copy in the folder.
    store.copyRuntimeFiles(this.deps.resourcesDir, state.folder)
    const outcome = await this.runChild(state, 'check', {})
    if (state.removed) return

    const report = outcome.report
    if (outcome.stopped || !report || (!report.ok && report.failure !== 'page')) {
      // Stopped, or the process could not run the checks: nothing is known about the video.
      if (outcome.stopped && opts.turn && opts.turn.status === 'done') opts.turn.status = 'stopped'
      const why = outcome.stopped
        ? 'The checks were stopped before they finished.'
        : `The checks could not run: ${report?.error || outcome.error || `the render process exited with code ${outcome.code}`}.`
      project.checks = [{ name: 'loads', passed: false, detail: why }]
      project.status = 'failed'
      this.save(state)
      return
    }

    project.checks = checksOf(report)
    project.duration = report.ok && report.duration > 0 ? report.duration : null
    project.scenes = report.ok ? report.scenes.map((scene) => ({ ...scene })) : []
    const thumbnails: Record<string, string> = {}
    for (const sceneId of report.thumbnails) {
      const path = `${store.THUMBS_DIR}/${thumbName(sceneId)}.png`
      if (project.scenes.some((scene) => scene.id === sceneId) && store.fileSize(join(state.folder, path)) !== null) {
        thumbnails[sceneId] = path
      }
    }
    project.thumbnails = thumbnails

    const failed = project.checks.filter((check) => !check.passed)
    if (failed.length === 0) {
      project.status = 'ready'
      this.save(state)
      return
    }
    const last = project.turns[project.turns.length - 1]
    if (!opts.allowFix || last?.kind === 'fix') {
      project.status = 'failed'
      this.save(state)
      return
    }
    // One fix turn, then the checks again; a second failure is shown to the user.
    try {
      await this.runTurn(project.id, 'fix', undefined, failed)
    } catch {
      project.status = 'failed'
      this.save(state)
    }
  }
}
