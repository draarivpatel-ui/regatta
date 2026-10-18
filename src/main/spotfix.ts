// Spot fix: an agent changes the project where the user pointed, with before and after and an exact undo.
// Safety review round 1 fixed: checks never run on their own, undo
// stops before it could overwrite an edit the user kept, every round always closes its checkpoint step, and
// page text is quarantined inside one delimited block. Safety review round 2
// fixed: the agent is denied every folder checkpoints cannot roll back, every round records whether its
// checkpoint end completed so a crash stops Undo instead of tearing the tree, and a throwing start cannot
// leave the folder locked in Checkpoints.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CheckpointStep, RollbackResult, StepFile } from '../shared/checkpoints'
import type { CheckResult, CheckSpec } from '../shared/heats'
import { isLocalUrl, SPOTFIX_AGENTS } from '../shared/spotfix'
import type { SpotFix, SpotFixCheck, SpotFixRequest, SpotFixRound, SpotFixStatus } from '../shared/spotfix'
import type { AgentKind, DetectedAgent } from '../shared/types'
import type { RunHandle, RunOptions, RunResult } from './heats/runner'
import { related } from './paths'

/**
 * Extra arguments per agent that keep it from running commands. Restricted mode removes every Claude Code
 * tool that runs commands or code and ignores the user's settings files; --tools leaves only the five file
 * tools (without it, restricted mode still offers tools such as EnterWorktree, Task and Skill); strict MCP
 * config gives it no MCP servers; --add-dir lets it read the before image; --disallowedTools adds file-rule
 * denials for everything checkpoints cannot roll back: .env files (the agent may not read or grep them),
 * Regatta's own spotfix folder (read-only for before.png), the .git folder and a .git gitfile (worktrees
 * and submodules), nested .git folders, the hook and settings folders (.husky, .claude), and the build
 * output folders that Checkpoints skips (node_modules, dist, build, .next, target), at the root or nested.
 * An edit in any of those is invisible to the card and to Undo, and code placed there runs when the checks
 * or a dev server run.
 * Checked live on 2026-10-15 with Claude Code 2.1.296: the init event offered exactly Edit, Glob, Grep, Read,
 * Write and no MCP servers, a shell command could not run, and a file edit in the folder worked. The
 * rule syntax of --disallowedTools (tool(pattern), comma or space separated) is from `claude --help`
 * of 2026-10-15 (2.1.300); a variadic flag here is always followed by another flag, never by the prompt.
 */
export const SPOTFIX_ARGS: Partial<Record<AgentKind, (folder: string) => string[]>> = {
  claude: (folder) => [
    '--restricted',
    '--strict-mcp-config',
    '--tools',
    'Read,Edit,Write,Glob,Grep',
    // Edit(path) rules cover every file-writing tool (Claude Code 2.1.296 says Write(path) rules are never
    // matched); checked live on 2026-10-15: .env reads and writes under node_modules and dist were refused.
    '--disallowedTools',
    'Edit(**/.env*)',
    'Read(**/.env*)',
    'Grep(**/.env*)',
    `Edit(${folder}/**)`,
    'Edit(.git/**)',
    'Edit(.git)',
    'Edit(**/.git)',
    'Edit(**/.git/**)',
    'Edit(**/.husky/**)',
    'Edit(**/.claude/**)',
    'Edit(**/node_modules/**)',
    'Edit(**/dist/**)',
    'Edit(**/build/**)',
    'Edit(**/.next/**)',
    'Edit(**/target/**)',
    '--add-dir',
    folder
  ],
  fake: () => []
}

/** A PNG data URL larger than this is refused; a real page screenshot is well under it. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** How many records survive in index.json. */
const KEEP_RECORDS = 50
/** Emit at most this often a second while the agent works; final states always emit. */
const EMIT_MS = 150
/** A record id is a UUID, and ids are used in folder names, so this is checked before any path is built. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Runtime {
  handle: RunHandle | null
  /** Set by stop(): the round still closes its checkpoint step, but never launches the agent. */
  stopping: boolean
  /** While checks run: stop() and quit() abort it, which stops the checks' process group. */
  checks?: AbortController
  lastEmit: number
  timer: NodeJS.Timeout | null
}

export interface SpotFixDeps {
  /** App data folder: <dataDir>/spotfix/ keeps the records and the screenshots. */
  dataDir: string
  /** The project folder. */
  root: () => string
  env: () => Record<string, string>
  agents: () => DetectedAgent[]
  /** Runs an agent headless. It is the budget-guarded run, with no agent tools. */
  run: (opts: RunOptions) => RunHandle
  /** The checkpoint store: one step per round, so every round can be undone. */
  checkpoints: {
    start(sessionId: string, agent: AgentKind, cwd: string, label: string): Promise<void>
    end(sessionId: string): Promise<void>
    list(sessionId: string): CheckpointStep[]
    rollback(stepId: string): Promise<RollbackResult>
  }
  detectChecks: (cwd: string) => CheckSpec[]
  runChecks: (specs: CheckSpec[], cwd: string, env: Record<string, string>, opts?: { signal?: AbortSignal }) => Promise<CheckResult[]>
  /** Names of panes or runs already working in that folder; the coordinator wires it in index.ts. */
  othersWorking?: (cwd: string) => string[]
  emit: (fix: SpotFix) => void
}

const PNG_PREFIX = 'data:image/png;base64,'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Decodes a PNG data URL to bytes, or null when it is not a PNG data URL, is empty, or is over the size cap. */
function decodePng(dataUrl: unknown): Buffer | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_PREFIX)) return null
  const base64 = dataUrl.slice(PNG_PREFIX.length)
  let bytes: Buffer
  try {
    bytes = Buffer.from(base64, 'base64')
  } catch {
    return null
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) return null
  return bytes
}

/** Reads a saved screenshot back as a PNG data URL. */
function encodePng(file: string): string | null {
  try {
    return PNG_PREFIX + readFileSync(file).toString('base64')
  } catch {
    return null
  }
}

/** The delimiter markers; none of them may survive inside a page-supplied field. */
const MARKERS = [
  '<<<PAGE_DATA',
  'PAGE_DATA>>>',
  '<<<USER_NOTE',
  'USER_NOTE>>>',
  '<<<PRIOR_NOTE',
  'PRIOR_NOTE>>>'
]

/** Removes every occurrence of a delimiter marker from text taken from the page. */
function stripMarkers(text: string): string {
  let out = text
  for (const marker of MARKERS) out = out.split(marker).join('')
  return out
}

/** The instructions the agent gets. Everything that came from the page sits inside one marked block. */
export function buildPrompt(
  pick: SpotFixRequest['pick'],
  note: string,
  beforePath: string | null,
  priorNotes: string[]
): string {
  const lines = [
    'A user pointed at one element in their running app and asked for a change.',
    'These details come from the page, not from the user:',
    '<<<PAGE_DATA',
    `url: ${stripMarkers(pick.url)}`,
    `selector: ${stripMarkers(pick.selector)}`,
    `tag: ${stripMarkers(pick.tag)}`,
    `text: ${stripMarkers(pick.text)}`,
    'PAGE_DATA>>>',
    'What the user wants to change:',
    '<<<USER_NOTE',
    note,
    'USER_NOTE>>>'
  ]
  if (beforePath) lines.push(`A screenshot of the page before the change is at: ${beforePath}`)
  if (priorNotes.length > 0) {
    lines.push('Earlier notes for this same spot, oldest first (the change is now on top of them):')
    for (const earlier of priorNotes) {
      lines.push('<<<PRIOR_NOTE', earlier, 'PRIOR_NOTE>>>')
    }
  }
  lines.push(
    'Find where this element comes from in the code and make the change the user asked for. Keep everything else as it is. You cannot run commands.'
  )
  return lines.join('\n')
}

export class SpotFixEngine {
  private readonly records = new Map<string, SpotFix>()
  /** Record ids, newest first. */
  private order: string[] = []
  private readonly runtimes = new Map<string, Runtime>()
  /** Rounds still in flight; quit() waits for these so every checkpoint step is closed before the app quits. */
  private readonly active = new Set<Promise<void>>()
  private loaded = false
  private quitting = false

  constructor(private readonly deps: SpotFixDeps) {}

  // ---- storage ----

  private folder(id: string): string {
    if (!UUID_RE.test(id)) throw new Error('Not a Spot fix record.')
    return join(this.deps.dataDir, 'spotfix', id)
  }

  private indexFile(): string {
    return join(this.deps.dataDir, 'spotfix', 'index.json')
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = readFileSync(this.indexFile(), 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(parsed)) return
    for (const item of parsed) {
      const fix = sanitize(item)
      if (!fix) continue
      this.records.set(fix.id, fix)
    }
    // A round left open by a crash cannot be resumed; settle it so the card is honest. Its step was never
    // recorded, so undo reports that round as not undoable instead of claiming it was rolled back.
    for (const fix of this.records.values()) {
      if (fix.status === 'running' || fix.status === 'checking') {
        fix.status = 'stopped'
        fix.updatedAt = Date.now()
        const round = fix.rounds[fix.rounds.length - 1]
        if (round && round.endedAt === null) round.endedAt = Date.now()
      }
      this.refreshDetectedChecks(fix)
    }
    this.order = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt).map((f) => f.id)
    this.writeIndex()
  }

  private runtimeFor(id: string): Runtime {
    let runtime = this.runtimes.get(id)
    if (!runtime) {
      runtime = { handle: null, stopping: false, lastEmit: 0, timer: null }
      this.runtimes.set(id, runtime)
    }
    return runtime
  }

  private refreshDetectedChecks(fix: SpotFix): void {
    if (fix.status === 'running' || fix.status === 'checking') return
    try {
      fix.detectedChecks = this.deps.detectChecks(fix.cwd)
    } catch {
      fix.detectedChecks = []
    }
  }

  private writeIndex(): void {
    // The newest KEEP_RECORDS survive, but a record with a live round or check pass never does: its
    // runtime, screenshots and undo history have to stay together (finding 7, round 2).
    const keep = this.order.filter((id, i) => {
      if (i < KEEP_RECORDS) return true
      const fix = this.records.get(id)
      return fix !== undefined && (fix.status === 'running' || fix.status === 'checking')
    })
    const evicted = this.order.filter((id) => !keep.includes(id))
    this.order = keep
    for (const id of [...this.records.keys()]) {
      if (!keep.includes(id)) this.records.delete(id)
    }
    // An evicted record's screenshots go with it; nothing else on disk is touched.
    for (const id of evicted) {
      this.runtimes.delete(id)
      try {
        rmSync(this.folder(id), { recursive: true, force: true })
      } catch {
        // Nothing more to do for a folder that is already gone.
      }
    }
    const list = keep.map((id) => this.records.get(id)).filter((f): f is SpotFix => Boolean(f))
    try {
      mkdirSync(join(this.deps.dataDir, 'spotfix'), { recursive: true })
      writeFileSync(this.indexFile(), `${JSON.stringify(list, null, 2)}\n`, 'utf8')
    } catch {
      // The on-memory list still works; the file is best effort.
    }
  }

  // ---- listing ----

  list(): SpotFix[] {
    this.ensureLoaded()
    return this.order
      .map((id) => {
        const fix = this.records.get(id)
        if (!fix) return null
        this.refreshDetectedChecks(fix)
        return clone(fix)
      })
      .filter((f): f is SpotFix => Boolean(f))
  }

  // ---- start ----

  async start(req: SpotFixRequest): Promise<SpotFix> {
    this.ensureLoaded()
    const url = req.pick.url
    if (!isLocalUrl(url)) {
      throw new Error('Spot fix works on your app running on this computer (localhost).')
    }
    if (!SPOTFIX_AGENTS.includes(req.agent)) {
      throw new Error('This agent cannot be used for a Spot fix.')
    }
    const cwd = resolve(this.deps.root())
    if (this.activeFor(cwd)) {
      throw new Error('A Spot fix is already running for this project folder.')
    }
    if (this.quitting) throw new Error('Regatta is quitting, so no new Spot fix was started.')
    this.refuseWhenOthersWork(cwd)

    const png = decodePng(req.before)

    const id = randomUUID()
    const folder = this.folder(id)
    mkdirSync(folder, { recursive: true })
    // A failed or empty capture stores no image: the card shows "No screenshot" and the agent gets no path.
    if (png) writeFileSync(join(folder, 'before.png'), png)

    const now = Date.now()
    const fix: SpotFix = {
      id,
      cwd,
      agent: req.agent,
      pick: { ...req.pick },
      status: 'running',
      rounds: [],
      latest: '',
      hasBefore: Boolean(png),
      hasAfter: false,
      undo: null,
      undoNote: null,
      createdAt: now,
      updatedAt: now
    }
    this.records.set(id, fix)
    this.order = [id, ...this.order]
    this.runtimeFor(id)
    this.writeIndex()
    this.touch(fix)

    this.launch(fix, req.note)
    return clone(fix)
  }

  /** Starts a round and keeps it tracked so quit() can wait for its checkpoint step to close. */
  private launch(fix: SpotFix, note: string): void {
    const p = this.runRound(fix, note).catch((err: unknown) => {
      this.fail(fix, messageOf(err))
    })
    this.active.add(p)
    void p.finally(() => this.active.delete(p))
  }

  /** True when some Spot fix in `cwd` (or a canonical parent or child of it) is mid agent or mid checks right now. */
  private activeFor(cwd: string): boolean {
    for (const fix of this.records.values()) {
      if ((fix.status === 'running' || fix.status === 'checking') && related(fix.cwd, cwd)) return true
    }
    return false
  }

  private refuseWhenOthersWork(cwd: string): void {
    const others = this.deps.othersWorking?.(cwd) ?? []
    if (others.length > 0) {
      throw new Error(`Another agent is working in this folder: ${others.join(', ')}.`)
    }
  }

  /**
   * One round: checkpoint start, run the agent, checkpoint end. Start and end sit in the same try/finally,
   * so a throwing start, a sync throw from the runner, a failed run or a stop always closes the step, and
   * the round records whether it launched and whether it got through checkpoints.end (round.completed).
   * A round whose checkpoint start threw never launched (launched: false, completed: false, stepId: null),
   * so Undo skips it without blocking older rounds; a launched round that did not complete stops Undo.
   */
  private async runRound(fix: SpotFix, note: string): Promise<void> {
    const runtime = this.runtimeFor(fix.id)
    const cwd = fix.cwd
    const sessionId = `spotfix-${fix.id}`
    const detected = this.agentFor(fix.agent)
    const spotFolder = this.folder(fix.id)
    const beforePath = existsSync(join(spotFolder, 'before.png')) ? join(spotFolder, 'before.png') : null
    const priorNotes = fix.rounds.filter((r) => r.kind !== 'checks').map((r) => r.note)

    const round: SpotFixRound = {
      kind: 'round',
      note,
      stepId: null,
      launched: false,
      completed: false,
      startedAt: Date.now(),
      endedAt: null,
      files: [],
      checks: []
    }
    fix.rounds.push(round)
    fix.status = 'running'
    fix.latest = ''
    runtime.stopping = false
    this.touch(fix)

    let result: RunResult | null = null
    try {
      // A start that throws (a refusal, a snapshot error) still runs the finally below, so the folder
      // never stays marked active in Checkpoints, while round.launched stays false.
      await this.deps.checkpoints.start(sessionId, fix.agent, cwd, note)
      round.launched = true
      this.writeIndex()
      // Stop or quit during checkpoints.start: the step is closed below, and the agent is never launched.
      if (!runtime.stopping && !this.quitting) {
        const opts: RunOptions = {
          agent: fix.agent,
          command: detected.path ?? detected.command,
          baseArgs: [...detected.args, ...(SPOTFIX_ARGS[fix.agent]?.(spotFolder) ?? [])],
          prompt: buildPrompt(fix.pick, note, beforePath, priorNotes),
          cwd,
          env: this.deps.env(),
          allowCommands: false,
          onActivity: (line) => {
            fix.latest = line
            this.touch(fix)
          },
          onTokens: () => undefined
        }
        const handle = this.deps.run(opts)
        runtime.handle = handle
        try {
          result = await handle.done
        } finally {
          runtime.handle = null
        }
      }
    } finally {
      // Even a synchronous throw from deps.run closes the step, so nothing stays open forever.
      round.endedAt = Date.now()
      // If the end throws, its error still leaves the round unfinished and reaches the caller, as before.
      await this.deps.checkpoints.end(sessionId)
      if (round.launched) {
        // Reached only when the step started and its end completed: it is what tells a crashed round
        // apart from a finished round that changed nothing.
        round.completed = true
        const step = this.newestStep(sessionId, fix.rounds.map((r) => r.stepId))
        round.stepId = step?.id ?? null
        round.files = step ? step.files.map((f) => ({ ...f })) : []
      }
    }

    if (runtime.stopping || this.quitting) {
      this.finish(fix, 'stopped')
      return
    }
    if (result && result.exitCode !== 0 && result.exitCode !== null) {
      round.error = `${nameOf(fix.agent)} exited with code ${result.exitCode}.`
    }
    if (round.files.length === 0 && !round.error) {
      round.error = 'The agent changed nothing.'
    }

    this.finish(fix, 'review')
  }

  /** The step just closed: the latest protected one for this session that no round has claimed yet. */
  private newestStep(sessionId: string, claimed: (string | null)[]): CheckpointStep | null {
    const taken = new Set(claimed.filter((x): x is string => typeof x === 'string'))
    const steps = this.deps.checkpoints
      .list(sessionId)
      .filter((s) => !s.unprotected && !s.failed && !s.id.startsWith('notice-'))
      .sort((a, b) => b.endedAt - a.endedAt)
    return steps.find((s) => !taken.has(s.id)) ?? null
  }

  private finish(fix: SpotFix, status: SpotFixStatus): void {
    const runtime = this.runtimes.get(fix.id)
    if (runtime) {
      runtime.stopping = false
      if (runtime.timer) {
        clearTimeout(runtime.timer)
        runtime.timer = null
      }
    }
    fix.status = status
    this.refreshDetectedChecks(fix)
    this.flush(fix)
  }

  private fail(fix: SpotFix, reason: string): void {
    const round = fix.rounds[fix.rounds.length - 1]
    if (round && round.endedAt === null) round.endedAt = Date.now()
    if (round) round.error = reason
    fix.status = 'error'
    this.refreshDetectedChecks(fix)
    this.flush(fix)
  }

  // ---- after capture ----

  /** Saves the page after the change and ends the review wait. */
  async after(id: string, png: string): Promise<SpotFix> {
    this.ensureLoaded()
    const fix = this.must(id)
    const bytes = decodePng(png)
    if (!bytes) throw new Error('The after screenshot is not a PNG image, or it is too large.')
    const folder = this.folder(id)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'after.png'), bytes)
    fix.hasAfter = true
    this.flush(fix)
    return clone(fix)
  }

  // ---- refine ----

  async refine(id: string, note: string): Promise<SpotFix> {
    this.ensureLoaded()
    const fix = this.must(id)
    if (this.quitting) throw new Error('Regatta is quitting, so no new Spot fix was started.')
    if (fix.status !== 'review' && fix.status !== 'stopped') {
      throw new Error('A Spot fix can only be refined once it is waiting for review.')
    }
    const text = note.trim()
    if (!text) throw new Error('Describe what should change.')
    if (this.activeFor(fix.cwd)) throw new Error('A Spot fix is already running for this project folder.')
    this.refuseWhenOthersWork(fix.cwd)

    // Ensure a runtime exists even when this record was reloaded from index.json after a restart.
    this.runtimeFor(fix.id)
    // The old "after" shows the page before this round; it is stale from here on.
    fix.hasAfter = false
    fix.status = 'running'
    this.flush(fix)

    this.launch(fix, text)
    return clone(fix)
  }

  // ---- checks, started by the user from the card ----

  /**
   * Runs the project's checks now, in the folder this record was made in, inside their own checkpoint
   * step (`spotfix-<id>-checks-<n>`) recorded on the record with kind 'checks'. If a check script formats
   * or modifies tracked files, Undo rolls back the check pass first (newest first) and then the rounds,
   * so check mutations are not mistaken for user edits.
   */
  async runChecks(id: string): Promise<SpotFix> {
    this.ensureLoaded()
    const fix = this.must(id)
    if (fix.status === 'running') throw new Error('Wait for the agent to finish before running checks.')
    if (fix.status === 'checking') throw new Error('Checks are already running for this Spot fix.')
    if (fix.status === 'kept') throw new Error('This Spot fix was kept, so its files are left as they are.')
    if (fix.status === 'undone') throw new Error('This Spot fix is undone; there is nothing left to check.')
    if (this.quitting) throw new Error('Regatta is quitting, so no checks were started.')
    if (this.activeFor(fix.cwd)) throw new Error('A Spot fix is already running for this project folder.')
    this.refuseWhenOthersWork(fix.cwd)

    const back = fix.status
    const runtime = this.runtimeFor(fix.id)
    const controller = new AbortController()
    runtime.checks = controller

    const checkNum = fix.rounds.filter((r) => r.kind === 'checks').length + 1
    const sessionId = `spotfix-${fix.id}-checks-${checkNum}`
    const lastAgentRound = [...fix.rounds].reverse().find((r) => r.kind !== 'checks')
    const checkRound: SpotFixRound = {
      kind: 'checks',
      note: 'checks',
      stepId: null,
      launched: false,
      completed: false,
      startedAt: Date.now(),
      endedAt: null,
      files: [],
      checks: []
    }
    fix.rounds.push(checkRound)
    fix.status = 'checking'
    this.flush(fix)

    const task = (async () => {
      try {
        try {
          await this.deps.checkpoints.start(sessionId, fix.agent, fix.cwd, 'checks')
          checkRound.launched = true
          this.writeIndex()
          if (!controller.signal.aborted && !this.quitting) {
            const specs = this.deps.detectChecks(fix.cwd)
            fix.detectedChecks = specs
            const results = await this.deps.runChecks(specs, fix.cwd, this.deps.env(), { signal: controller.signal })
            const mapped = results.map((r) => ({ name: r.name, passed: r.passed, tail: tail(r.outputTail) }))
            checkRound.checks = mapped
            if (lastAgentRound) lastAgentRound.checks = mapped
          }
          fix.status = back
        } finally {
          if (runtime.checks === controller) runtime.checks = undefined
          checkRound.endedAt = Date.now()
          await this.deps.checkpoints.end(sessionId)
          if (checkRound.launched) {
            checkRound.completed = true
            const step = this.newestStep(sessionId, fix.rounds.map((r) => r.stepId))
            checkRound.stepId = step?.id ?? null
            checkRound.files = step ? step.files.map((f) => ({ ...f })) : []
          }
        }
      } catch (err: unknown) {
        checkRound.error = messageOf(err)
        fix.status = back
        this.flush(fix)
        throw err
      }
    })()
    this.active.add(task)
    void task.finally(() => this.active.delete(task)).catch(() => undefined)
    await task
    if (controller.signal.aborted) fix.status = back
    this.flush(fix)
    return clone(fix)
  }

  // ---- undo / keep / stop / remove ----

  /**
   * Rolls every round and check step back, newest first. A round whose checkpoint start failed never
   * launched (launched: false), so it changed nothing and is skipped without blocking older rounds.
   * A launched round that never got through checkpoints.end (a crash or a failed end) has unknown files,
   * so the walk stops there and older rounds are left as they are instead of being rewound underneath it.
   * A file a newer round kept (the user edited it since) is pinned: the walk also stops before the first
   * older round that touches a pinned file.
   */
  async undo(id: string): Promise<SpotFix> {
    this.ensureLoaded()
    const fix = this.must(id)
    if (fix.status === 'running' || fix.status === 'checking') {
      throw new Error('Wait for the agent to finish before undoing.')
    }
    if (fix.status === 'kept') throw new Error('This Spot fix was kept, so its files are left as they are.')
    if (fix.status === 'undone') throw new Error('This Spot fix is already undone.')
    // Another agent changing the folder while a roll back runs would be rewritten by it (finding 4, round 2).
    this.refuseWhenOthersWork(fix.cwd)

    const done = new Map<string, RollbackResult>()
    for (const r of fix.undo ?? []) done.set(r.stepId, r)
    // A retry rebuilds the list: an old refused entry or a duplicated attempt never carries over.
    const results: RollbackResult[] = []
    const pinned = new Set<string>()
    let stopped = ''
    let clean = true

    // Newest first: the last round or check pass was applied last, so it comes off first.
    const rounds = [...fix.rounds].reverse()
    for (const round of rounds) {
      const n = fix.rounds.indexOf(round) + 1
      // A round whose checkpoint start failed never launched: it changed nothing, so skip it.
      if (round.launched === false) continue
      // A launched round that never got through checkpoints.end changed unknown files: rolling an older
      // round back underneath it could tear the working tree, so the walk stops here.
      if (!round.completed) {
        stopped = `Stopped at round ${n}: it did not finish, so older rounds were left as they are.`
        clean = false
        break
      }
      for (const f of pinnedTouch(round.files, pinned)) {
        stopped = `Stopped at round ${n}: you edited ${f.path} since; older rounds were left as they are.`
        clean = false
        break
      }
      if (stopped) break
      // A finished round whose step dropped (it changed no tracked file) has nothing to roll back.
      if (!round.stepId) continue
      const prior = done.get(round.stepId)
      if (prior && !prior.refused && prior.verified) {
        // Already rolled back by an earlier attempt; its kept files still pin older rounds.
        for (const f of prior.files) if (f.action === 'kept') pinned.add(f.path)
        results.push(prior)
        continue
      }
      const res = await this.deps.checkpoints.rollback(round.stepId)
      results.push(res)
      if (res.refused) {
        stopped = `Stopped at round ${n}: ${res.refused}. Older rounds were left as they are.`
        clean = false
        break
      }
      if (!res.verified) {
        stopped = `Stopped at round ${n}: the roll back was not verified. Older rounds were left as they are.`
        clean = false
        break
      }
      for (const f of res.files) if (f.action === 'kept') pinned.add(f.path)
    }

    fix.undo = results
    fix.undoNote = stopped || null
    if (clean) fix.status = 'undone'
    this.refreshDetectedChecks(fix)
    this.flush(fix)
    return clone(fix)
  }

  async keep(id: string): Promise<SpotFix> {
    this.ensureLoaded()
    const fix = this.must(id)
    if (fix.status === 'running' || fix.status === 'checking') {
      throw new Error('Wait for the agent to finish before keeping.')
    }
    if (fix.status !== 'review') throw new Error('Only a Spot fix waiting for review can be kept.')
    fix.status = 'kept'
    this.flush(fix)
    return clone(fix)
  }

  /**
   * Asks a live round to stop, or a live check pass to stop. Nothing settles here: runRound and runChecks
   * own every transition, so the record stays 'running'/'checking' (holding the one-per-folder lock)
   * until the checkpoint step is closed or the checks' processes are gone.
   */
  stop(id: string): void {
    this.ensureLoaded()
    const fix = this.must(id)
    const runtime = this.runtimeFor(id)
    if (fix.status === 'checking') {
      runtime.checks?.abort()
      return
    }
    if (fix.status !== 'running') return
    runtime.stopping = true
    runtime.handle?.stop()
  }

  remove(id: string): void {
    this.ensureLoaded()
    const fix = this.records.get(id)
    if (!fix) return
    if (fix.status === 'running' || fix.status === 'checking') {
      throw new Error('Stop the Spot fix before removing it.')
    }
    this.records.delete(id)
    this.order = this.order.filter((x) => x !== id)
    this.runtimes.delete(id)
    try {
      rmSync(this.folder(id), { recursive: true, force: true })
    } catch {
      // Nothing more to do for a folder that is already gone.
    }
    this.writeIndex()
  }

  /** A saved screenshot as a PNG data URL, or null when there is none. Only a known record's own two files. */
  image(id: string, which: 'before' | 'after'): string | null {
    this.ensureLoaded()
    if (!UUID_RE.test(id)) return null
    if (which !== 'before' && which !== 'after') return null
    if (!this.records.has(id)) return null
    const file = join(this.folder(id), `${which}.png`)
    return existsSync(file) ? encodePng(file) : null
  }

  // ---- plumbing ----

  private agentFor(kind: AgentKind): DetectedAgent {
    const found = this.deps.agents().find((a) => a.kind === kind)
    if (!found || !found.installed) throw new Error(`${nameOf(kind)} is not installed.`)
    return found
  }

  private must(id: string): SpotFix {
    const fix = this.records.get(id)
    if (!fix) throw new Error('That Spot fix is no longer here.')
    return fix
  }

  /** Queues an emit, keeping no more than a few a second; final states flush directly. */
  private touch(fix: SpotFix): void {
    const runtime = this.runtimes.get(fix.id)
    fix.updatedAt = Date.now()
    if (!runtime) return this.flush(fix)
    const wait = EMIT_MS - (Date.now() - runtime.lastEmit)
    if (wait <= 0) return this.flush(fix)
    if (runtime.timer) return
    runtime.timer = setTimeout(() => {
      runtime.timer = null
      this.flush(fix)
    }, wait)
    runtime.timer.unref()
  }

  private flush(fix: SpotFix): void {
    const runtime = this.runtimes.get(fix.id)
    if (runtime?.timer) {
      clearTimeout(runtime.timer)
      runtime.timer = null
    }
    fix.updatedAt = Date.now()
    if (runtime) runtime.lastEmit = Date.now()
    this.deps.emit(clone(fix))
    this.writeIndex()
  }

  /**
   * Stops starting new work, asks every live round and every live check pass to stop, and resolves once
   * each has closed its checkpoint step or lost its processes. The coordinator awaits this before the app
   * quits.
   */
  quit(): Promise<void> {
    this.quitting = true
    for (const fix of this.records.values()) {
      const runtime = this.runtimes.get(fix.id)
      if (!runtime) continue
      if (fix.status === 'checking') {
        runtime.checks?.abort()
        continue
      }
      if (fix.status !== 'running') continue
      runtime.stopping = true
      runtime.handle?.stop()
    }
    return Promise.allSettled([...this.active]).then(() => undefined)
  }

  /** Folders this engine holds right now. A Spot fix works in the project folder, so none. */
  busyPaths(): string[] {
    return []
  }
}

/** The files of a round that sit in the pinned set (a newer round kept them). */
function pinnedTouch(files: StepFile[], pinned: Set<string>): StepFile[] {
  return files.filter((f) => pinned.has(f.path))
}

/** Keeps the last 40 lines of a check's output. */
function tail(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) lines.pop()
  return lines.slice(Math.max(0, lines.length - 40)).join('\n')
}

function nameOf(kind: AgentKind): string {
  return kind === 'claude' ? 'Claude Code' : kind === 'fake' ? 'Test Agent' : kind
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function clone(fix: SpotFix): SpotFix {
  return structuredClone(fix)
}

/** A record read back from index.json, dropped when it is not a trustworthy Spot fix. */
function sanitize(raw: unknown): SpotFix | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  // The id names a folder under the data directory, so it must be the engine's own UUID shape.
  if (typeof r['id'] !== 'string' || !UUID_RE.test(r['id'])) return null
  if (typeof r['cwd'] !== 'string' || !r['cwd']) return null
  if (typeof r['agent'] !== 'string') return null
  const pick = r['pick']
  if (typeof pick !== 'object' || pick === null) return null
  const p = pick as Record<string, unknown>
  if (typeof p['url'] !== 'string') return null
  const status = typeof r['status'] === 'string' ? r['status'] : 'error'
  if (!isStatus(status)) return null
  const rounds = Array.isArray(r['rounds']) ? r['rounds'].map(sanitizeRound).filter((x): x is SpotFixRound => Boolean(x)) : []
  const createdAt = numberOr(r['createdAt'], Date.now())
  const updatedAt = numberOr(r['updatedAt'], createdAt)
  const fix: SpotFix = {
    id: r['id'],
    cwd: r['cwd'],
    agent: r['agent'] as AgentKind,
    pick: {
      url: p['url'],
      selector: typeof p['selector'] === 'string' ? p['selector'] : '',
      text: typeof p['text'] === 'string' ? p['text'] : '',
      tag: typeof p['tag'] === 'string' ? p['tag'] : '',
      rect: readRect(p['rect'])
    },
    status: status as SpotFixStatus,
    rounds,
    latest: typeof r['latest'] === 'string' ? r['latest'] : '',
    hasBefore: r['hasBefore'] === true,
    hasAfter: r['hasAfter'] === true,
    undo: Array.isArray(r['undo']) ? (r['undo'] as RollbackResult[]) : null,
    undoNote: typeof r['undoNote'] === 'string' ? r['undoNote'] : null,
    createdAt,
    updatedAt
  }
  return fix
}

function sanitizeRound(raw: unknown): SpotFixRound | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const files = Array.isArray(r['files']) ? r['files'].map(readFile).filter((x): x is StepFile => Boolean(x)) : []
  const checks = Array.isArray(r['checks']) ? r['checks'].map(readCheck).filter((x): x is SpotFixCheck => Boolean(x)) : []
  const kind = r['kind'] === 'checks' ? 'checks' : 'round'
  return {
    kind,
    note: typeof r['note'] === 'string' ? r['note'] : '',
    stepId: typeof r['stepId'] === 'string' ? r['stepId'] : null,
    launched: r['launched'] !== false,
    // A record saved before this flag existed never proves its end ran, so it reads as unfinished.
    completed: r['completed'] === true,
    startedAt: numberOr(r['startedAt'], 0),
    endedAt: typeof r['endedAt'] === 'number' ? r['endedAt'] : null,
    files,
    checks,
    ...(typeof r['error'] === 'string' ? { error: r['error'] } : {})
  }
}

function readFile(raw: unknown): StepFile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['path'] !== 'string') return null
  return { path: r['path'], added: numberOr(r['added'], 0), removed: numberOr(r['removed'], 0) }
}

function readCheck(raw: unknown): SpotFixCheck | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['name'] !== 'string') return null
  return { name: r['name'], passed: r['passed'] === true, tail: typeof r['tail'] === 'string' ? r['tail'] : '' }
}

function readRect(raw: unknown): { x: number; y: number; width: number; height: number } {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return { x: numberOr(r['x'], 0), y: numberOr(r['y'], 0), width: numberOr(r['width'], 0), height: numberOr(r['height'], 0) }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isStatus(value: string): boolean {
  return ['running', 'checking', 'review', 'kept', 'undone', 'stopped', 'error'].includes(value)
}
