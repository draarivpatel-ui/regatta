// The engine end to end, against a fake agent and a fake render process: projects, turns, checks,
// undo, stop and renders.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENTS } from '../../shared/agents'
import type { DetectedAgent } from '../../shared/types'
import type { NewVideo, PointNote, VideoAgent, VideoAspect, VideoProject } from '../../shared/video'
import type { RunHandle, RunOptions, RunResult } from '../heats/runner'
import { VideoEngine, parseFrameLine, type VideoEngineDeps } from './engine'
import type { RenderJob } from './render-child'
import { thumbName, type RenderReport } from './report'

const repoVideo = fileURLToPath(new URL('../../../resources/video', import.meta.url))

const scenes = [
  { id: 'panes', title: 'Side by side', start: 0, duration: 3 },
  { id: 'status', title: 'Who needs you', start: 3, duration: 3 },
  { id: 'checks', title: 'Checks decide', start: 6, duration: 3 },
  { id: 'name', title: 'Regatta', start: 9, duration: 3 }
]

const passing = {
  loads: { name: 'loads', passed: true, detail: 'Loaded with 4 scenes, 12 s long.' },
  stable: { name: 'stable', passed: true, detail: '28 of 28 frames rendered the same twice' },
  captions: { name: 'captions', passed: true, detail: '4 captions, all inside the video.' }
} as const

const failingStable = {
  name: 'stable',
  passed: false,
  detail: '12 of 28 frames rendered the same twice. The largest difference was 200 of 255 levels, first at 4.5 s in scene status.'
} as const

function checkReport(overrides: Partial<RenderReport> = {}): RenderReport {
  return {
    kind: 'check',
    ok: true,
    errors: [],
    duration: 12,
    fps: 30,
    scenes,
    thumbnails: ['panes', 'status', 'checks', 'name'],
    ...passing,
    samples: [],
    maxDiff: 0,
    viewport: { width: 1280, height: 720, ratio: 1 },
    frames: 56,
    framesDone: 56,
    sizeBytes: null,
    loudness: null,
    out: '',
    ...overrides
  }
}

function renderReport(job: RenderJob, overrides: Partial<RenderReport> = {}): RenderReport {
  return {
    kind: 'render',
    ok: true,
    errors: [],
    duration: 12,
    fps: 30,
    scenes,
    thumbnails: [],
    ...passing,
    samples: [],
    maxDiff: 0,
    viewport: { width: 1280, height: 720, ratio: 1 },
    frames: 360,
    framesDone: 360,
    sizeBytes: 14,
    loudness: -14.2,
    out: job.out,
    ...overrides
  }
}

/** The report a render process writes when it could not do its job. */
function failedReport(kind: 'check' | 'render', failure: 'page' | 'system', error: string): RenderReport {
  return checkReport({
    kind,
    ok: false,
    failure,
    error,
    duration: 0,
    scenes: [],
    thumbnails: [],
    loads: { name: 'loads', passed: false, detail: error }
  })
}

/** Gets item `i`, failing the test (not the type checker) when it is not there. */
function at<T>(list: readonly T[], i: number): T {
  const item = list[i]
  if (item === undefined) throw new Error(`There is no item ${i} in a list of ${list.length}`)
  return item
}

interface Harness {
  engine: VideoEngine
  dataDir: string
  project: string
  resources: string
  bin: string
  prompts: string[]
  runs: RunOptions[]
  jobs: RenderJob[]
  emitted: VideoProject[]
  removed: string[]
  ctl: {
    /** The agent never finishes until `release` is called. */
    hang: boolean
    hangCheck: boolean
    hangRender: boolean
    /** A render process that is stopped writes one more file into the video folder before it exits. */
    lateWrite: boolean
    exitCode: number | null
    skipPlan: boolean
    withClaude: boolean
    /** The Test Agent is no longer installed (it was uninstalled while a video was being made). */
    agentGone: boolean
    /** Makes the fake agent write something into the folder before it finishes. */
    agentWrites: (cwd: string) => void
    report: (job: RenderJob) => RenderReport | null
    /** Whether the runtime copy in the folder matched Regatta's at the time a check started. */
    runtimeAtCheck: boolean[]
    /** The lines a render process prints, one by one, as it starts. */
    progressLines: string[]
    env: () => Record<string, string>
    now: number
    release: () => void
  }
  /** A second engine over the same data, as after a restart. */
  restart(): VideoEngine
  folderOf(id: string): string
}

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function startVideo(): Harness {
  const dataDir = tempDir('rg-video-data-')
  const project = tempDir('rg-video-proj-')
  const resources = tempDir('rg-video-res-')
  const bin = tempDir('rg-video-bin-')
  mkdirSync(join(resources, 'example'), { recursive: true })
  copyFileSync(join(repoVideo, 'example', 'index.html'), join(resources, 'example', 'index.html'))
  for (const name of ['regatta-video.js', 'regatta-video.css']) {
    copyFileSync(join(repoVideo, name), join(resources, name))
  }
  // A stand-in ffmpeg: the engine only needs to find an executable called ffmpeg on the PATH.
  writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'ffmpeg'), 0o755)
  // A project with a logo at the root, a hidden one, and one inside node_modules that must be skipped.
  writeFileSync(join(project, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  writeFileSync(join(project, '.hidden-logo.png'), 'hidden')
  mkdirSync(join(project, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(project, 'node_modules', 'x', 'logo.png'), 'not a real png')

  const prompts: string[] = []
  const runs: RunOptions[] = []
  const jobs: RenderJob[] = []
  const emitted: VideoProject[] = []
  const removed: string[] = []
  const finishers: Array<() => void> = []
  const ctl: Harness['ctl'] = {
    hang: false,
    hangCheck: false,
    hangRender: false,
    lateWrite: false,
    exitCode: 0,
    skipPlan: false,
    withClaude: false,
    agentGone: false,
    agentWrites: () => undefined,
    report: (job) => (job.kind === 'check' ? checkReport() : renderReport(job)),
    runtimeAtCheck: [],
    progressLines: ['{"frame":180,"of":360}'],
    env: () => ({ PATH: bin }),
    now: new Date(2026, 9, 14, 9, 5).getTime(),
    release: () => {
      while (finishers.length > 0) finishers.pop()?.()
    }
  }
  const agents = (): DetectedAgent[] => {
    const list: DetectedAgent[] = [
      ctl.agentGone
        ? { ...AGENTS.fake, installed: false, path: null, version: null }
        : { ...AGENTS.fake, installed: true, path: '/usr/bin/node', version: 'test' }
    ]
    if (ctl.withClaude) {
      list.push({ ...AGENTS.claude, installed: true, path: '/opt/bin/claude', version: '1.0' })
      list.push({ ...AGENTS.codex, installed: true, path: '/opt/bin/codex', version: '1.0' })
    } else {
      list.push({ ...AGENTS.claude, installed: false, path: null, version: null })
    }
    return list
  }
  const deps: VideoEngineDeps = {
    dataDir,
    resourcesDir: resources,
    root: () => project,
    env: () => ctl.env(),
    agents,
    run: (opts: RunOptions): RunHandle => {
      prompts.push(opts.prompt)
      runs.push(opts)
      let finish: () => void = () => undefined
      const done = new Promise<RunResult>((resolve) => {
        // A plan turn writes only the plan, as the prompt asks.
        const planOnly = opts.prompt.includes('Do not write index.html yet')
        if (ctl.hang) {
          finish = () => resolve({ exitCode: 0, durationMs: 1, tokens: null, stopped: true })
          finishers.push(finish)
          return
        }
        if (!ctl.skipPlan && planOnly) {
          writeFileSync(join(opts.cwd, 'PLAN.md'), '# Plan\n\nFour scenes, 12 seconds.\n', 'utf8')
        }
        if (!planOnly) copyFileSync(join(resources, 'example', 'index.html'), join(opts.cwd, 'index.html'))
        ctl.agentWrites(opts.cwd)
        opts.onActivity('read the guide')
        opts.onActivity('wrote index.html')
        opts.onTokens(4321)
        resolve({ exitCode: ctl.exitCode, durationMs: 12, tokens: 4321, stopped: false })
      })
      return { done, stop: () => finish() }
    },
    spawnRender: (jobFile) => {
      const job = JSON.parse(readFileSync(jobFile, 'utf8')) as RenderJob
      jobs.push(job)
      if (job.kind === 'check') {
        ctl.runtimeAtCheck.push(
          readFileSync(join(job.folder, 'regatta-video.js'), 'utf8') === readFileSync(join(resources, 'regatta-video.js'), 'utf8')
        )
      }
      const report = ctl.report(job)
      const hold = job.kind === 'check' ? ctl.hangCheck : ctl.hangRender
      if (report && job.kind === 'check') {
        mkdirSync(join(job.folder, 'thumbs'), { recursive: true })
        for (const id of report.thumbnails) writeFileSync(join(job.folder, 'thumbs', `${thumbName(id)}.png`), 'png')
      }
      if (job.kind === 'render') {
        mkdirSync(join(job.out, '..'), { recursive: true })
        // The process starts writing the file at once; it is only a whole file when the report says ok.
        writeFileSync(job.out, report?.ok ? 'fake mp4 bytes' : 'half a file')
      }
      const finalize = (): void => {
        if (report) writeFileSync(job.report, JSON.stringify(report, null, 2), 'utf8')
      }
      let end: (code: number | null) => void = () => undefined
      const done = new Promise<number | null>((resolve) => {
        end = resolve
        if (hold) {
          finishers.push(() => resolve(null))
          return
        }
        finalize()
        resolve(report ? 0 : 1)
      })
      return {
        done,
        stop: () => {
          if (!ctl.lateWrite) return end(null)
          // The process is slow to die and writes a thumbnail on its way out.
          setTimeout(() => {
            mkdirSync(join(job.folder, 'thumbs'), { recursive: true })
            writeFileSync(join(job.folder, 'thumbs', 'late.png'), 'x')
            end(null)
          }, 20)
        },
        output: (fn) => {
          if (job.kind === 'render') for (const line of ctl.progressLines) fn(line)
        }
      }
    },
    emit: (video) => emitted.push(video),
    emitRemoved: (id) => removed.push(id),
    now: () => ctl.now
  }
  return {
    engine: new VideoEngine(deps),
    dataDir,
    project,
    resources,
    bin,
    prompts,
    runs,
    jobs,
    emitted,
    removed,
    ctl,
    restart: () => new VideoEngine(deps),
    folderOf: (id) => join(dataDir, 'videos', id)
  }
}

const newVideo: NewVideo = {
  title: 'Launch clip',
  brief: 'Show four agents side by side.',
  aspect: '16:9',
  agent: 'fake'
}

const note: PointNote = {
  time: 4.2,
  scene: 'status',
  selector: 'section[data-scene="status"] > h1',
  text: 'See who needs you',
  x: 640,
  y: 300,
  note: 'make the title bigger'
}

function videoAt(h: Harness, id: string): VideoProject {
  const found = h.engine.list().find((video) => video.id === id)
  if (!found) throw new Error('the video is gone')
  return found
}

/** Lets the engine's pending promises run, so a turn that was started has reached its first wait. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('create', () => {
  it('refuses a bad title, brief, shape or agent', () => {
    const h = startVideo()
    expect(() => h.engine.create({ ...newVideo, title: '  ' })).toThrow('Give the video a title of 1 to 80 characters.')
    expect(() => h.engine.create({ ...newVideo, title: 'x'.repeat(81) })).toThrow('Give the video a title of 1 to 80 characters.')
    expect(() => h.engine.create({ ...newVideo, brief: '' })).toThrow('Describe the video in 1 to 2000 characters.')
    expect(() => h.engine.create({ ...newVideo, brief: 'x'.repeat(2001) })).toThrow('Describe the video in 1 to 2000 characters.')
    expect(() => h.engine.create({ ...newVideo, aspect: '4:3' as VideoAspect })).toThrow('Pick one of these shapes')
    expect(() => h.engine.create({ ...newVideo, agent: 'claude' })).toThrow('Claude Code is not installed')
    expect(() => h.engine.create({ ...newVideo, agent: 'shell' as VideoAgent })).toThrow('cannot work on videos yet')
    expect(h.engine.list()).toHaveLength(0)
    expect(h.emitted).toHaveLength(0)
    expect(existsSync(join(h.dataDir, 'videos'))).toBe(false)
  })

  it('accepts titles and briefs at the limits', () => {
    const h = startVideo()
    expect(h.engine.create({ ...newVideo, title: 'x'.repeat(80), brief: 'y'.repeat(2000) }).status).toBe('new')
  })

  it('writes the starter project and the brand assets', () => {
    const h = startVideo()
    const video = h.engine.create({ ...newVideo, aspect: '9:16' })
    expect(video.status).toBe('new')
    expect([video.width, video.height, video.fps]).toEqual([720, 1280, 30])
    expect(video.projectRoot).toBe(h.project)
    expect(video.id).toHaveLength(8)
    const folder = h.folderOf(video.id)
    expect(readFileSync(join(folder, 'index.html'), 'utf8')).toContain('width=720,height=1280,fps=30')
    expect(readFileSync(join(folder, 'index.html'), 'utf8')).toContain('<main id="stage"></main>')
    expect(existsSync(join(folder, 'regatta-video.js'))).toBe(true)
    expect(existsSync(join(folder, 'regatta-video.css'))).toBe(true)
    expect(existsSync(join(folder, 'assets', 'logo.svg'))).toBe(true)
    const index = readFileSync(join(folder, 'assets', 'INDEX.md'), 'utf8')
    expect(index).toContain(`logo.svg: ${join(h.project, 'logo.svg')}`)
    expect(existsSync(join(folder, 'assets', 'logo.png'))).toBe(false)
    expect(existsSync(join(folder, 'assets', '.hidden-logo.png'))).toBe(false)
    for (const dir of ['renders', 'thumbs', '.history']) expect(existsSync(join(folder, dir))).toBe(true)
    expect(h.emitted).toHaveLength(1)
    expect(h.engine.folderOf(video.id)).toBe(folder)
    expect(h.engine.folderOf('nope')).toBeNull()
    expect(videoAt(h, video.id).title).toBe('Launch clip')
  })

  it('stores the project on disk without the derived fields', () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    const onDisk = JSON.parse(readFileSync(join(h.folderOf(video.id), 'video.json'), 'utf8')) as Record<string, unknown>
    expect(onDisk['id']).toBe(video.id)
    expect(onDisk['title']).toBe('Launch clip')
    expect(onDisk['status']).toBe('new')
    expect('canUndo' in onDisk).toBe(false)
    expect(readdirSync(h.folderOf(video.id)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('plan and build', () => {
  it('plans, builds and goes ready when the checks pass', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    const planned = await h.engine.plan(video.id)
    expect(planned.status).toBe('planned')
    expect(at(planned.turns, 0).status).toBe('done')
    expect(at(planned.turns, 0).note).toBe('Write the plan')
    expect(at(planned.turns, 0).tokens).toBe(4321)
    expect(at(planned.turns, 0).latest).toContain('wrote index.html')
    expect(h.prompts[0]).toContain('Write PLAN.md for this video')
    const built = await h.engine.build(video.id)
    expect(built.status).toBe('ready')
    expect(built.checks.map((check) => check.passed)).toEqual([true, true, true])
    expect(built.duration).toBe(12)
    expect(built.scenes.map((scene) => scene.id)).toEqual(['panes', 'status', 'checks', 'name'])
    expect(built.thumbnails).toEqual({
      panes: 'thumbs/panes.png',
      status: 'thumbs/status.png',
      checks: 'thumbs/checks.png',
      name: 'thumbs/name.png'
    })
    expect(built.canUndo).toBe(true)
    expect(h.prompts[1]).toContain('Build index.html to match PLAN.md.')
  })

  it('runs the checks in a render process for this video, at its size', async () => {
    const h = startVideo()
    const video = h.engine.create({ ...newVideo, aspect: '1:1' })
    await h.engine.build(video.id)
    const job = at(h.jobs, 0)
    expect(job.kind).toBe('check')
    expect(job.folder).toBe(h.folderOf(video.id))
    expect([job.width, job.height, job.fps]).toEqual([1080, 1080, 30])
    expect(job.ffmpeg).toBeNull()
  })

  it('shows the checks and thumbnails on the video that was emitted', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    const statuses = h.emitted.map((v) => v.status)
    expect(statuses).toContain('building')
    expect(statuses).toContain('checking')
    expect(statuses[statuses.length - 1]).toBe('ready')
  })

  it('does not list a thumbnail whose file is not there', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.report = (job) => (job.kind === 'check' ? checkReport({ thumbnails: ['panes', 'ghost'] }) : renderReport(job))
    const built = await h.engine.build(video.id)
    expect(Object.keys(built.thumbnails)).toEqual(['panes'])
  })

  it('fails the turn when the agent wrote no plan', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.skipPlan = true
    const failed = await h.engine.plan(video.id)
    expect(failed.status).toBe('failed')
    expect(at(failed.turns, 0).status).toBe('failed')
    expect(at(failed.turns, 0).latest).toContain('No PLAN.md')
    expect(h.engine.readPlan(video.id)).toBe('')
  })

  it('fails the turn when the agent exits badly, and does not check a video it failed to change', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.exitCode = 3
    const failed = await h.engine.build(video.id)
    expect(failed.status).toBe('failed')
    expect(at(failed.turns, 0).status).toBe('failed')
    expect(at(failed.turns, 0).latest).toContain('exited with code 3')
    expect(h.jobs).toHaveLength(0)
  })

  it('says so when the agent could not run at all', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.exitCode = null
    const failed = await h.engine.build(video.id)
    expect(at(failed.turns, 0).latest).toContain('could not run')
  })

  it('sends one fix turn when a check fails, and passes once it is fixed', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.report = (job) => (job.kind === 'check' ? checkReport({ stable: failingStable }) : renderReport(job))
    const failed = await h.engine.build(video.id)
    expect(failed.turns.map((turn) => turn.kind)).toEqual(['build', 'fix'])
    expect(failed.status).toBe('failed')
    expect(failed.checks.find((check) => check.name === 'stable')?.passed).toBe(false)
    expect(h.prompts[1]).toContain('12 of 28 frames rendered the same twice')
    expect(h.prompts[1]).toContain('first at 4.5 s in scene status')
    expect(h.prompts[1]).toContain('Fix the cause.')
    // Two check runs: one after the build, one after the fix. A third would be a second fix.
    expect(h.jobs.filter((job) => job.kind === 'check')).toHaveLength(2)
    h.ctl.report = (job) => (job.kind === 'check' ? checkReport() : renderReport(job))
    const fixed = await h.engine.build(video.id)
    expect(fixed.status).toBe('ready')
    expect(fixed.turns.map((turn) => turn.kind)).toEqual(['build', 'fix', 'build'])
  })

  it('goes ready when the fix turn fixes it', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    let checks = 0
    h.ctl.report = (job) => {
      if (job.kind !== 'check') return renderReport(job)
      checks++
      return checks === 1 ? checkReport({ stable: failingStable }) : checkReport()
    }
    const done = await h.engine.build(video.id)
    expect(done.turns.map((turn) => turn.kind)).toEqual(['build', 'fix'])
    expect(done.status).toBe('ready')
    expect(done.checks.every((check) => check.passed)).toBe(true)
  })

  it('sends a page that could not load back to the agent, with the reason', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.report = (job) =>
      job.kind === 'check' ? failedReport('check', 'page', 'The page did not load the video runtime. Keep the regatta-video.js script tag.') : renderReport(job)
    const failed = await h.engine.build(video.id)
    expect(failed.turns.map((turn) => turn.kind)).toEqual(['build', 'fix'])
    expect(h.prompts[1]).toContain('did not load the video runtime')
    expect(failed.status).toBe('failed')
    expect(failed.checks).toEqual([
      { name: 'loads', passed: false, detail: 'The page did not load the video runtime. Keep the regatta-video.js script tag.' }
    ])
    expect(failed.duration).toBeNull()
    expect(failed.scenes).toEqual([])
  })

  it('does not bother the agent when the machine could not run the checks', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.report = (job) =>
      job.kind === 'check' ? failedReport('check', 'system', 'The screen scale is 1.5. Rendering needs a whole number such as 1 or 2.') : renderReport(job)
    const failed = await h.engine.build(video.id)
    expect(failed.turns.map((turn) => turn.kind)).toEqual(['build'])
    expect(failed.status).toBe('failed')
    const check = at(failed.checks, 0)
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('The checks could not run')
    expect(check.detail).toContain('screen scale is 1.5')
  })

  it('treats a render process that left no report as a machine problem', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.report = () => null
    const failed = await h.engine.build(video.id)
    expect(failed.turns.map((turn) => turn.kind)).toEqual(['build'])
    expect(failed.status).toBe('failed')
    expect(at(failed.checks, 0).detail).toContain('exited with code 1')
  })

  it('never leaves a video checking, even when the fix turn cannot start', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    // The agent is uninstalled while the checks run, so the fix turn they ask for cannot start.
    h.ctl.report = (job) => {
      if (job.kind !== 'check') return renderReport(job)
      h.ctl.agentGone = true
      return checkReport({ stable: failingStable })
    }
    const failed = await h.engine.build(video.id)
    expect(failed.status).toBe('failed')
    expect(failed.turns.map((turn) => turn.kind)).toEqual(['build'])
    expect(videoAt(h, video.id).status).toBe('failed')
  })

  it('puts Regatta\'s runtime back before the checks, whatever the agent did to it', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.agentWrites = (cwd) => writeFileSync(join(cwd, 'regatta-video.js'), '// the agent was here\n')
    await h.engine.build(video.id)
    expect(h.ctl.runtimeAtCheck).toEqual([true])
  })

  it('does not leave a video checking when the checks cannot even start', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    // Regatta's runtime goes missing while the agent works, so putting it back before the checks fails.
    h.ctl.agentWrites = () => rmSync(join(h.resources, 'regatta-video.js'))
    const failed = await h.engine.build(video.id)
    expect(failed.status).toBe('failed')
    expect(videoAt(h, video.id).status).toBe('failed')
    const check = at(failed.checks, 0)
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('The checks could not run')
    expect(check.detail).toContain('regatta-video.js')
    expect(h.jobs).toHaveLength(0)
    expect(failed.turns.map((turn) => turn.kind)).toEqual(['build'])
  })

  it('stops the checks when Stop is pressed, and leaves the video failed', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.hangCheck = true
    const building = h.engine.build(video.id)
    await settle()
    expect(videoAt(h, video.id).status).toBe('checking')
    h.engine.stop(video.id)
    const after = await building
    expect(after.status).toBe('failed')
    expect(at(after.turns, 0).status).toBe('stopped')
    expect(at(after.checks, 0).detail).toContain('stopped')
    // And it is not a reason to send the agent a fix turn.
    expect(after.turns).toHaveLength(1)
  })
})

describe('savePlan', () => {
  it('writes PLAN.md, and starts a revise turn when asked', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    const saved = await h.engine.savePlan(video.id, '# Plan\n\nNew scenes.\n', false)
    expect(readFileSync(join(h.folderOf(video.id), 'PLAN.md'), 'utf8')).toBe('# Plan\n\nNew scenes.\n')
    expect(saved.turns).toHaveLength(0)
    const told = await h.engine.savePlan(video.id, '# Plan\n\nNewer scenes.\n', true)
    expect(told.turns.map((turn) => turn.kind)).toEqual(['revise'])
    expect(told.status).toBe('ready')
    expect(h.prompts[0]).toContain('PLAN.md changed. Update index.html to match it.')
    expect(h.engine.readPlan(video.id)).toBe('# Plan\n\nNewer scenes.\n')
    await expect(h.engine.savePlan(video.id, 'x'.repeat(50001), false)).rejects.toThrow('PLAN.md is too long')
    expect((await h.engine.savePlan(video.id, 'x'.repeat(50000), false)).status).toBe('ready')
  })

  it('lets a plan the user wrote make a new video ready to build', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    expect((await h.engine.savePlan(video.id, '   ', false)).status).toBe('new')
    expect((await h.engine.savePlan(video.id, '# My plan\n', false)).status).toBe('planned')
  })

  it('lets a plan the user wrote rescue a plan turn that failed', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.skipPlan = true
    expect((await h.engine.plan(video.id)).status).toBe('failed')
    expect((await h.engine.savePlan(video.id, '# My plan\n', false)).status).toBe('planned')
  })

  it('does not ask the agent to follow a plan that is empty', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await expect(h.engine.savePlan(video.id, '  ', true)).rejects.toThrow('Write the plan')
    expect(h.prompts).toHaveLength(0)
  })

  it('refuses while a turn is running', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.hang = true
    const running = h.engine.plan(video.id)
    await expect(h.engine.savePlan(video.id, '# Plan\n', false)).rejects.toThrow('This video is busy.')
    h.engine.stop(video.id)
    await running
  })
})

describe('changeAt', () => {
  it('asks for the change at that point, then checks', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    const after = await h.engine.changeAt(video.id, note)
    const prompt = at(h.prompts, 0)
    expect(prompt).toContain('At 4.2 s')
    expect(prompt).toContain('section[data-scene="status"] > h1')
    expect(prompt).toContain('"See who needs you"')
    expect(prompt).toContain('make the title bigger')
    expect(prompt).toContain('Change only that.')
    expect(at(after.turns, 0).kind).toBe('change')
    expect(at(after.turns, 0).note).toBe('Change at 4.2 s: make the title bigger')
    expect(after.status).toBe('ready')
  })

  it('refuses a note that is empty or too long', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await expect(h.engine.changeAt(video.id, { ...note, note: '  ' })).rejects.toThrow('1 to 1000 characters')
    await expect(h.engine.changeAt(video.id, { ...note, note: 'x'.repeat(1001) })).rejects.toThrow('1 to 1000 characters')
    expect(h.prompts).toHaveLength(0)
    await h.engine.changeAt(video.id, { ...note, note: 'x'.repeat(1000) })
    expect(h.prompts).toHaveLength(1)
  })

  it('cleans a point that came with bad numbers or very long text', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.changeAt(video.id, { ...note, time: Number.NaN, x: Number.POSITIVE_INFINITY, y: Number.NaN, text: 'w'.repeat(5000) })
    const prompt = at(h.prompts, 0)
    expect(prompt).toContain('At 0 s')
    expect(prompt).toContain('(at 0, 0 on the stage)')
    expect(prompt).toContain(`"${'w'.repeat(300)}"`)
    expect(prompt).not.toContain('w'.repeat(301))
  })
})

describe('undo', () => {
  it('puts the folder back as it was before the last turn', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.plan(video.id)
    await h.engine.build(video.id)
    const folder = h.folderOf(video.id)
    expect(readFileSync(join(folder, 'index.html'), 'utf8')).toContain('data-scene')
    const undone = await h.engine.undo(video.id)
    expect(readFileSync(join(folder, 'index.html'), 'utf8')).not.toContain('data-scene')
    expect(undone.status).toBe('ready')
    expect(undone.canUndo).toBe(true)
    expect(existsSync(join(folder, 'renders'))).toBe(true)
    const again = await h.engine.undo(video.id)
    expect(readFileSync(join(folder, 'index.html'), 'utf8')).toContain('width=1280')
    expect(again.canUndo).toBe(false)
    await expect(h.engine.undo(video.id)).rejects.toThrow('Nothing to undo.')
  })

  it('checks the video again, and does not send the agent after it', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    h.ctl.report = (job) => (job.kind === 'check' ? checkReport({ stable: failingStable }) : renderReport(job))
    const before = h.prompts.length
    const checksBefore = h.jobs.filter((job) => job.kind === 'check').length
    const undone = await h.engine.undo(video.id)
    expect(h.jobs.filter((job) => job.kind === 'check').length).toBe(checksBefore + 1)
    expect(h.prompts.length).toBe(before)
    expect(undone.status).toBe('failed')
  })

  it('keeps the record of the turns and the renders', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.plan(video.id)
    await h.engine.build(video.id)
    await h.engine.render(video.id)
    const undone = await h.engine.undo(video.id)
    expect(undone.turns.map((turn) => turn.kind)).toEqual(['plan', 'build'])
    expect(undone.renders).toHaveLength(1)
    expect(readFileSync(join(h.folderOf(video.id), undone.renders[0]?.path ?? 'missing'), 'utf8')).toBe('fake mp4 bytes')
  })
})

describe('busy and stop', () => {
  it('refuses a second turn while one is running', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.hang = true
    const running = h.engine.plan(video.id)
    await expect(h.engine.build(video.id)).rejects.toThrow('This video is busy.')
    await expect(h.engine.changeAt(video.id, note)).rejects.toThrow('This video is busy.')
    await expect(h.engine.undo(video.id)).rejects.toThrow('This video is busy.')
    await expect(h.engine.render(video.id)).rejects.toThrow('This video is busy.')
    expect(videoAt(h, video.id).status).toBe('planning')
    h.engine.stop(video.id)
    const after = await running
    expect(at(after.turns, 0).status).toBe('stopped')
    expect(after.status).toBe('failed')
  })

  it('lets the next turn start once the last one has ended', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.plan(video.id)
    await expect(h.engine.build(video.id)).resolves.toBeDefined()
  })

  it('stops a render that is running, and leaves no half-written file', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    expect(videoAt(h, video.id).status).toBe('ready')
    h.ctl.hangRender = true
    const rendering = h.engine.render(video.id)
    await settle()
    const render = at(videoAt(h, video.id).renders, 0)
    expect(render.status).toBe('rendering')
    h.engine.stop(video.id)
    const after = await rendering
    expect(at(after.renders, 0).status).toBe('stopped')
    expect(at(after.renders, 0).note).toBe('Stopped.')
    expect(after.status).toBe('ready')
    expect(readdirSync(join(h.folderOf(video.id), 'renders'))).toEqual([])
  })

  it('stops a running render on quit and waits for its process to end (sol-loop S9)', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    h.ctl.hangRender = true
    const rendering = h.engine.render(video.id)
    await settle()
    await h.engine.quit()
    const after = await rendering
    expect(at(after.renders, 0).status).toBe('stopped')
    expect(readdirSync(join(h.folderOf(video.id), 'renders'))).toEqual([])
  })

  it('does nothing when there is nothing to stop', () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    expect(() => h.engine.stop(video.id)).not.toThrow()
    expect(() => h.engine.stop('nope')).not.toThrow()
  })
})

describe('reload after a restart', () => {
  it('marks a turn that was running when the app stopped as stopped', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.hang = true
    const running = h.engine.plan(video.id)
    const onDisk = JSON.parse(readFileSync(join(h.folderOf(video.id), 'video.json'), 'utf8')) as VideoProject
    expect(onDisk.status).toBe('planning')
    expect(at(onDisk.turns, 0).status).toBe('running')
    const loaded = at(h.restart().list(), 0)
    expect(at(loaded.turns, 0).status).toBe('stopped')
    expect(loaded.status).toBe('failed')
    h.engine.stop(video.id)
    await running
  })

  it('marks a render that was running as stopped and removes its half-written file', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    h.ctl.hangRender = true
    const rendering = h.engine.render(video.id)
    await settle()
    const path = at(videoAt(h, video.id).renders, 0).path
    expect(existsSync(join(h.folderOf(video.id), path))).toBe(true)
    const loaded = at(h.restart().list(), 0)
    expect(at(loaded.renders, 0).status).toBe('stopped')
    expect(at(loaded.renders, 0).note).toContain('Stopped')
    expect(loaded.status).toBe('ready')
    expect(existsSync(join(h.folderOf(video.id), path))).toBe(false)
    h.engine.stop(video.id)
    await rendering
  })

  it('keeps a finished video as it was, and does not touch its time of last change', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    const before = videoAt(h, video.id)
    h.ctl.now += 3_600_000
    const loaded = at(h.restart().list(), 0)
    expect(loaded.status).toBe('ready')
    expect(at(loaded.turns, 0).status).toBe('done')
    expect(loaded.updatedAt).toBe(before.updatedAt)
    expect(loaded.duration).toBe(12)
    expect(loaded.scenes).toHaveLength(4)
    expect(Object.keys(loaded.thumbnails)).toHaveLength(4)
    expect(loaded.canUndo).toBe(true)
  })

  it('skips a video.json that is broken, wrong, or someone else\'s, without failing', () => {
    const h = startVideo()
    const good = h.engine.create(newVideo)
    const videos = join(h.dataDir, 'videos')
    const plant = (name: string, body: string): void => {
      mkdirSync(join(videos, name), { recursive: true })
      writeFileSync(join(videos, name, 'video.json'), body)
    }
    plant('badjson1', '{ not json')
    plant('arrayone', '[]')
    plant('justanid', '{"id":"justanid"}')
    plant('wrongid11', JSON.stringify({ ...JSON.parse(readFileSync(join(videos, good.id, 'video.json'), 'utf8')), id: 'somebody' }))
    mkdirSync(join(videos, 'novideojson'), { recursive: true })
    const loaded = h.restart().list()
    expect(loaded.map((video) => video.id)).toEqual([good.id])
  })

  it('drops the bad entries of a video.json and keeps the rest', () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    const file = join(h.folderOf(video.id), 'video.json')
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    stored['turns'] = [{ id: 't1', kind: 'plan', status: 'done', startedAt: 1, endedAt: 2, note: 'ok', tokens: null, latest: '' }, 'junk', { id: 'x' }]
    stored['renders'] = [{ id: 'r1', path: '../../escape.mp4', status: 'done', progress: 1, startedAt: 1, endedAt: 2, sizeBytes: 1, loudness: null, note: '' }]
    stored['thumbnails'] = { hook: 'thumbs/hook.png', bad: '../../etc/passwd' }
    writeFileSync(file, JSON.stringify(stored))
    const loaded = at(h.restart().list(), 0)
    expect(loaded.turns.map((turn) => turn.id)).toEqual(['t1'])
    expect(loaded.renders).toEqual([])
    expect(loaded.thumbnails).toEqual({ hook: 'thumbs/hook.png' })
  })
})

describe('remove', () => {
  it('deletes only the folder it was asked about', () => {
    const h = startVideo()
    const first = h.engine.create(newVideo)
    const second = h.engine.create({ ...newVideo, title: 'Second clip' })
    h.engine.remove(first.id)
    expect(existsSync(h.folderOf(first.id))).toBe(false)
    expect(existsSync(h.folderOf(second.id))).toBe(true)
    expect(h.removed).toEqual([first.id])
    expect(h.engine.list().map((video) => video.id)).toEqual([second.id])
    expect(h.engine.folderOf(first.id)).toBeNull()
    h.engine.remove('nope')
    expect(h.removed).toHaveLength(1)
  })

  it('ignores an id that is not a video, and leaves its neighbours alone', () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    const neighbour = join(h.dataDir, 'neighbour')
    mkdirSync(neighbour)
    writeFileSync(join(neighbour, 'keep.txt'), 'mine')
    h.engine.remove('../neighbour')
    h.engine.remove('..')
    expect(readFileSync(join(neighbour, 'keep.txt'), 'utf8')).toBe('mine')
    expect(existsSync(h.folderOf(video.id))).toBe(true)
  })

  it('removes the folder again when a process that was winding down writes into it', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.hangCheck = true
    h.ctl.lateWrite = true
    const building = h.engine.build(video.id)
    await settle()
    expect(videoAt(h, video.id).status).toBe('checking')
    h.engine.remove(video.id)
    expect(existsSync(h.folderOf(video.id))).toBe(false)
    await building
    // The check process wrote a thumbnail after the delete; that was cleaned up too.
    expect(existsSync(h.folderOf(video.id))).toBe(false)
    expect(h.removed).toEqual([video.id])
  })

  it('stops what is running first, and the folder stays gone when it winds down', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    h.ctl.hang = true
    const running = h.engine.plan(video.id)
    await settle()
    h.engine.remove(video.id)
    h.ctl.release()
    await running.catch(() => undefined)
    await settle()
    expect(existsSync(h.folderOf(video.id))).toBe(false)
    expect(h.engine.list()).toEqual([])
    expect(h.removed).toEqual([video.id])
  })
})

describe('render', () => {
  it('renders an MP4 and records its size and loudness', async () => {
    const h = startVideo()
    const video = h.engine.create({ ...newVideo, title: 'My Clip!' })
    await h.engine.build(video.id)
    const rendered = await h.engine.render(video.id)
    const render = at(rendered.renders, 0)
    expect(rendered.status).toBe('ready')
    expect(render.status).toBe('done')
    expect(render.progress).toBe(1)
    expect(render.path).toBe('renders/my-clip-20261014-0905.mp4')
    expect(render.sizeBytes).toBe(Buffer.byteLength('fake mp4 bytes'))
    expect(render.loudness).toBe(-14.2)
    expect(render.note).toBe('-14.2 LUFS')
    const job = h.jobs.find((j) => j.kind === 'render')
    expect(job?.out).toBe(join(h.folderOf(video.id), render.path))
    expect(job?.ffmpeg).toBe(join(h.bin, 'ffmpeg'))
    expect([job?.width, job?.height, job?.fps]).toEqual([1280, 720, 30])
  })

  it('names a second render of the same minute differently, and keeps both', async () => {
    const h = startVideo()
    const video = h.engine.create({ ...newVideo, title: 'My Clip' })
    await h.engine.build(video.id)
    const first = at((await h.engine.render(video.id)).renders, 0)
    const after = await h.engine.render(video.id)
    const names = after.renders.map((render) => render.path)
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    expect(names).toContain(first.path)
    expect(names).toContain('renders/my-clip-20261014-0905-2.mp4')
    for (const name of names) expect(existsSync(join(h.folderOf(video.id), name))).toBe(true)
  })

  it('puts the newest render first', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    await h.engine.render(video.id)
    h.ctl.now += 120_000
    const after = await h.engine.render(video.id)
    expect(at(after.renders, 0).startedAt).toBeGreaterThan(at(after.renders, 1).startedAt)
  })

  it('puts Regatta\'s runtime back before the render', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    writeFileSync(join(h.folderOf(video.id), 'regatta-video.js'), '// changed after the checks\n')
    h.ctl.hangRender = true
    const rendering = h.engine.render(video.id)
    await settle()
    expect(readFileSync(join(h.folderOf(video.id), 'regatta-video.js'), 'utf8')).toBe(readFileSync(join(h.resources, 'regatta-video.js'), 'utf8'))
    h.engine.stop(video.id)
    await rendering
  })

  it('tracks progress, but emits at most about four times a second', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    h.ctl.progressLines = Array.from({ length: 360 }, (_, i) => JSON.stringify({ frame: i + 1, of: 360 }))
    // The build's own activity just used up the quarter second the engine leaves between emissions.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const before = h.emitted.length
    await h.engine.render(video.id)
    const during = h.emitted.slice(before)
    // The first progress line, the start and the end: far fewer than the 360 lines.
    expect(during.length).toBeLessThan(10)
    const running = during.filter((v) => at(v.renders, 0).status === 'rendering' && at(v.renders, 0).progress > 0)
    expect(running.length).toBeGreaterThanOrEqual(1)
    expect(at(during[during.length - 1]?.renders ?? [], 0).status).toBe('done')
  })

  it('records why a render failed, and removes the half-written file', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    h.ctl.report = (job) =>
      job.kind === 'check' ? checkReport() : failedReport('render', 'system', 'ffmpeg exited with code 1. Unknown encoder')
    const failed = await h.engine.render(video.id)
    expect(at(failed.renders, 0).status).toBe('failed')
    expect(at(failed.renders, 0).note).toContain('Unknown encoder')
    expect(at(failed.renders, 0).progress).toBe(0)
    expect(failed.status).toBe('ready')
    expect(readdirSync(join(h.folderOf(video.id), 'renders'))).toEqual([])
  })

  it('records a render process that left no report', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    h.ctl.report = (job) => (job.kind === 'check' ? checkReport() : null)
    const failed = await h.engine.render(video.id)
    expect(at(failed.renders, 0).status).toBe('failed')
    expect(at(failed.renders, 0).note).toContain('exited with code 1')
  })

  it('passes on a note about the music', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    h.ctl.report = (job) => (job.kind === 'check' ? checkReport() : renderReport(job, { loudness: -20, note: 'The music could not be mastered, so it is at its original level.' }))
    const rendered = await h.engine.render(video.id)
    expect(at(rendered.renders, 0).note).toBe('-20 LUFS. The music could not be mastered, so it is at its original level.')
  })

  it('explains how to install ffmpeg when it is missing', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.build(video.id)
    h.ctl.env = () => ({ PATH: '/definitely/not/here' })
    await expect(h.engine.render(video.id)).rejects.toThrow('Rendering needs ffmpeg. Install it with Homebrew: brew install ffmpeg')
    expect(videoAt(h, video.id).renders).toEqual([])
  })

  it('refuses to render a video that is not ready', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await expect(h.engine.render(video.id)).rejects.toThrow('Build the video and pass its checks')
  })
})

describe('the turn that runs the agent', () => {
  it('runs it in the video folder, headless, with the project readable', async () => {
    const h = startVideo()
    h.ctl.withClaude = true
    const video = h.engine.create({ ...newVideo, agent: 'claude' })
    await h.engine.build(video.id)
    const run = at(h.runs, 0)
    expect(run.agent).toBe('claude')
    expect(run.command).toBe('/opt/bin/claude')
    expect(run.cwd).toBe(h.folderOf(video.id))
    expect(run.allowCommands).toBe(false)
    expect(run.baseArgs).toContain('--add-dir')
    expect(run.baseArgs[run.baseArgs.indexOf('--add-dir') + 1]).toBe(h.project)
    expect(readdirSync(h.folderOf(video.id))).toContain('video.json')
  })

  it('gives Codex no extra folder', async () => {
    const h = startVideo()
    h.ctl.withClaude = true
    const video = h.engine.create({ ...newVideo, agent: 'codex' })
    await h.engine.build(video.id)
    const run = at(h.runs, 0)
    expect(run.agent).toBe('codex')
    expect(run.baseArgs).not.toContain('--add-dir')
    expect(run.baseArgs).toEqual([...AGENTS.codex.args])
  })

  it('snapshots the folder before every turn and keeps the last ten', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    for (let i = 0; i < 12; i++) await h.engine.changeAt(video.id, note)
    const snapshots = readdirSync(join(h.folderOf(video.id), '.history'))
    expect(snapshots).toHaveLength(10)
    expect(snapshots).toContain('12')
    expect(snapshots).not.toContain('2')
  })

  it('names the paths the agent needs, the guide and the example', async () => {
    const h = startVideo()
    const video = h.engine.create(newVideo)
    await h.engine.plan(video.id)
    const prompt = at(h.prompts, 0)
    expect(prompt).toContain(h.folderOf(video.id))
    expect(prompt).toContain(h.project)
    expect(prompt).toContain(join(h.resources, 'AGENT_GUIDE.md'))
    expect(prompt).toContain(join(h.resources, 'example', 'index.html'))
    expect(prompt).toContain('Launch clip')
    expect(prompt).toContain('Show four agents side by side.')
    expect(prompt).toContain('1280 by 720')
  })
})

describe('parseFrameLine', () => {
  it('reads a progress line from a render process', () => {
    expect(parseFrameLine('{"frame":120,"of":360}')).toEqual({ frame: 120, of: 360 })
  })

  it('ignores anything else', () => {
    expect(parseFrameLine('not json')).toBeNull()
    expect(parseFrameLine('{"error":"nope"}')).toBeNull()
    expect(parseFrameLine('{"frame":"1","of":2}')).toBeNull()
    expect(parseFrameLine('{"frame":1,"of":0}')).toBeNull()
  })
})
