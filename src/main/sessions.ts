// SessionManager: owns every agent terminal (pty), its hidden screen copy and its status tracker.

import { randomUUID } from 'node:crypto'
import { spawn, type IPty } from '@lydell/node-pty'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { EventChannels } from '../shared/ipc'
import type { AgentKind, CreateSessionOptions, DetectedAgent, LaunchSetOptions, LimitInfo, SessionInfo, SessionStatus, WorktreeInfo } from '../shared/types'
import type { HookServer } from './hooks'
import { detectLimit, formatResetTime } from './relay'
import { StatusTracker } from './status/tracker'

const SNAPSHOT_LIMIT = 512 * 1024
const FLUSH_MS = 8
const SCREEN_MS = 120
/** Input waits this long at most for the opening checkpoint, so a stuck git cannot swallow a keypress. */
const STEP_START_CEILING_MS = 30_000
/** The hook answer must come before the agent's own 30 second wait for it ends. */
const HOOK_START_CEILING_MS = 25_000

/** Input waiting for the opening checkpoint (or queued behind input that is). */
interface QueuedInput {
  data: string
  fromUser: boolean
  /** The data contains Enter. */
  submit: boolean
  /** The line Enter submitted, for the step label and the slash-command rule. */
  submitted: string
}

interface Session {
  info: SessionInfo
  opts: CreateSessionOptions
  pty: IPty | null
  tracker: StatusTracker
  screen: HeadlessTerminal
  chunks: string[]
  chunkBytes: number
  pending: string
  flushTimer: NodeJS.Timeout | null
  screenTimer: NodeJS.Timeout | null
  /** What the user is typing on the current line, and the last line they submitted. */
  typed: string
  lastPrompt: string
  /** A checkpoint step is open (or its start is in flight) for this session. */
  stepOpen: boolean
  /** Claude Code can report turn boundaries through hooks (UserPromptSubmit and Stop). */
  hookCapable: boolean
  /** A hook event has arrived, so the hooks are known to work and now mark the step boundaries. */
  hookSeen: boolean
  /** Input held back until the opening checkpoint exists, in order. */
  inputQueue: QueuedInput[]
  draining: boolean
  /** The opening checkpoint while it is still being made. */
  opening: Promise<void> | null
  /** Bumped when pending input is cancelled (Ctrl-C) or the session goes away. */
  epoch: number
  /** Set when the user acted on the limit message now on screen, so it must not come back. */
  limitHandled: boolean
}

/** True when two limit readings describe the same message on screen. */
function sameLimit(a: LimitInfo | null, b: LimitInfo | null): boolean {
  return a?.text === b?.text && a?.resetsAt === b?.resetsAt
}

export interface SessionDeps {
  env: () => Record<string, string>
  agents: () => DetectedAgent[]
  hooks: HookServer
  workspaceRoot: () => string
  emit: <K extends keyof EventChannels>(channel: K, payload: EventChannels[K]) => void
  /** Seconds of silence before a working session counts as quiet. */
  quietAfterSec: () => number
  /** Extra command line arguments for an agent's pane (for example tools from an MCP server). */
  extraArgs?: (agent: AgentKind) => string[]
  /** Longest an Enter waits for the opening checkpoint (default 30 s). */
  stepCeilingMs?: number
  /** Creates an isolated worktree for a new session. */
  createWorktree: (name: string) => Promise<WorktreeInfo>
  /** Sign-ins: the effective account for a new pane and the environment that selects it. */
  accounts?: {
    resolve: (agent: AgentKind, account: string | null) => string | null
    envFor: (agent: AgentKind, account: string | null) => Record<string, string>
  }
  /**
   * Told when an agent starts and stops a step, for checkpoints. `start` resolves once the opening
   * snapshot exists; submitted input is held back until then.
   */
  steps?: {
    start: (sessionId: string, agent: AgentKind, cwd: string, label: string) => Promise<void> | void
    end: (sessionId: string) => Promise<void> | void
    /** The agent was let run before the opening snapshot finished: record the step as unprotected. */
    unprotected?: (sessionId: string, reason: string) => void
    /** Gives the open step its real label (the prompt a hook reported). */
    relabel?: (sessionId: string, label: string) => void
  }
}

/** The visible rows of a session's hidden screen, joined into one string. */
function readScreen(session: Session): string {
  const buf = session.screen.buffer.active
  const lines: string[] = []
  for (let y = buf.viewportY; y < buf.viewportY + session.screen.rows; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  return lines.join('\n')
}

export class SessionManager {
  private sessions = new Map<string, Session>()
  private ticker: NodeJS.Timeout
  /** Told when the user types into a pane. The relay service uses it to cancel a scheduled resume. */
  onUserInput: ((id: string) => void) | null = null

  constructor(private readonly deps: SessionDeps) {
    this.ticker = setInterval(() => this.tickAll(), 1000)
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info
  }

  async create(opts: CreateSessionOptions): Promise<SessionInfo> {
    const agent = this.deps.agents().find((a) => a.kind === opts.agent)
    if (!agent) throw new Error(`Unknown agent: ${opts.agent}`)
    if (!agent.installed || !agent.path) throw new Error(`${agent.name} is not installed (could not find "${agent.command}" on PATH)`)

    const id = randomUUID().slice(0, 8)
    let cwd = opts.cwd || this.deps.workspaceRoot()
    let worktree: WorktreeInfo | null = null
    if (opts.isolate) {
      worktree = await this.deps.createWorktree(`${agent.short}-${id}`)
      cwd = worktree.path
    }
    const info: SessionInfo = {
      id,
      agent: agent.kind,
      title: opts.title || agent.short,
      cwd,
      command: agent.path,
      args: [],
      createdAt: Date.now(),
      pid: null,
      status: { state: 'starting', since: Date.now(), reason: 'launched', source: 'process' },
      exitCode: null,
      signals: agent.signals,
      worktree: worktree?.path ?? null,
      branch: worktree?.branch ?? null,
      limit: null,
      transcriptPath: null,
      account: this.deps.accounts?.resolve(agent.kind, opts.account ?? null) ?? null
    }
    const session: Session = {
      info,
      opts: { ...opts, cwd, isolate: false },
      pty: null,
      tracker: new StatusTracker(agent.kind, agent.signals, { quietAfterMs: this.deps.quietAfterSec() * 1000 }),
      screen: new HeadlessTerminal({ cols: opts.cols, rows: opts.rows, scrollback: 0, allowProposedApi: true }),
      chunks: [],
      chunkBytes: 0,
      pending: '',
      flushTimer: null,
      screenTimer: null,
      typed: '',
      lastPrompt: '',
      stepOpen: false,
      hookCapable: agent.kind === 'claude' && agent.signals === 'hooks',
      hookSeen: false,
      inputQueue: [],
      draining: false,
      opening: null,
      epoch: 0,
      limitHandled: false
    }
    this.sessions.set(id, session)
    this.launch(session, agent)
    this.deps.emit('session:created', info)
    return info
  }

  private launch(session: Session, agent: DetectedAgent): void {
    const { info, opts } = session
    const args = [...agent.args, ...(opts.args ?? [])]
    if (agent.kind === 'shell') args.push('-l')
    if (agent.signals === 'hooks' && agent.kind === 'claude') args.push('--settings', this.deps.hooks.claudeSettings(info.id))
    if (agent.signals === 'notify' && agent.kind === 'codex') args.push(...this.deps.hooks.codexArgs(info.id))
    // Last: Claude's --mcp-config takes several values, so nothing positional may follow it.
    args.push(...(this.deps.extraArgs?.(agent.kind) ?? []))
    info.args = args

    const env = {
      ...this.deps.env(),
      ...(this.deps.accounts?.envFor(info.agent, info.account) ?? {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Regatta',
      REGATTA_SESSION_ID: info.id
    }
    const pty = spawn(agent.path!, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: info.cwd, env })
    session.pty = pty
    info.pid = pty.pid

    pty.onData((data) => this.onData(session, data))
    pty.onExit(({ exitCode, signal }) => {
      session.pty = null
      this.flush(session)
      const code = signal ? null : exitCode
      info.exitCode = code
      this.applyStatus(session, session.tracker.onExit(code))
      this.deps.emit('session:exit', { id: info.id, exitCode: code })
    })
  }

  private onData(session: Session, data: string): void {
    this.applyStatus(session, session.tracker.onOutput(data))
    session.chunks.push(data)
    session.chunkBytes += data.length
    while (session.chunkBytes > SNAPSHOT_LIMIT && session.chunks.length > 1) {
      session.chunkBytes -= session.chunks.shift()!.length
    }
    session.screen.write(data)
    if (!session.screenTimer) {
      session.screenTimer = setTimeout(() => {
        session.screenTimer = null
        // The empty write resolves only after every earlier chunk is parsed, so we read the final screen.
        session.screen.write('', () => {
          if (this.sessions.has(session.info.id)) this.analyzeScreen(session)
        })
      }, SCREEN_MS)
    }
    session.pending += data
    if (!session.flushTimer) session.flushTimer = setTimeout(() => this.flush(session), FLUSH_MS)
  }

  private analyzeScreen(session: Session): void {
    const screen = readScreen(session)
    const buf = session.screen.buffer.active
    const cursorRow = buf.baseY + buf.cursorY - buf.viewportY
    this.applyStatus(session, session.tracker.onScreen(screen, cursorRow))
    this.checkLimit(session, screen)
  }

  /**
   * Reads the screen for a usage limit message (see docs/design/phase4.md, Relay).
   * The limit is stored on the session, pushed to the renderer for the pane card and the
   * inbox, and reported to the tracker. Shells are never asked about limits.
   */
  private checkLimit(session: Session, screen: string): void {
    if (session.info.agent === 'shell') return
    const found = detectLimit(screen, Date.now())
    if (found) {
      // The user already acted on the message on this screen: it must not come back until it
      // has scrolled away, even when the same message reads differently as the screen moves.
      if (session.limitHandled) return
      if (sameLimit(found, session.info.limit)) return
      session.info.limit = found
      this.deps.emit('session:limit', { id: session.info.id, limit: found })
      const label = found.resetsAt !== null ? `resets ${formatResetTime(found.resetsAt)}` : ''
      this.applyStatus(session, session.tracker.onLimit(label))
      return
    }
    // No message on screen, so a later one is a new limit.
    session.limitHandled = false
    if (session.info.limit) {
      session.info.limit = null
      this.deps.emit('session:limit', { id: session.info.id, limit: null })
    }
  }

  /**
   * Forgets the limit on this session (the user cancelled a resume, dismissed the card, or the
   * work moved to another agent) and keeps the card away while the message stays on screen.
   */
  dismissLimit(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.limitHandled = detectLimit(readScreen(s), Date.now()) !== null
    if (s.info.limit) {
      s.info.limit = null
      this.deps.emit('session:limit', { id, limit: null })
    }
  }

  /** The last prompt the user sent to this session, for a carry-over brief. */
  lastPrompt(id: string): string {
    return this.sessions.get(id)?.lastPrompt ?? ''
  }

  /** The text now visible on this session's screen, one entry per row. */
  screenText(id: string): string {
    const s = this.sessions.get(id)
    return s ? readScreen(s) : ''
  }

  /** The terminal size of this session, so a new pane can start the same shape. */
  size(id: string): { cols: number; rows: number } {
    const s = this.sessions.get(id)
    return { cols: s?.opts.cols ?? 100, rows: s?.opts.rows ?? 30 }
  }

  private flush(session: Session): void {
    if (session.flushTimer) clearTimeout(session.flushTimer)
    session.flushTimer = null
    if (!session.pending) return
    const data = session.pending
    session.pending = ''
    this.deps.emit('session:data', { id: session.info.id, data })
  }

  private applyStatus(session: Session, status: SessionStatus | null): void {
    if (!status) return
    const before = session.info.status.state
    session.info.status = status
    this.deps.emit('session:status', { id: session.info.id, status })
    const { info } = session
    if (!this.deps.steps || info.agent === 'shell') return
    if (this.usesHooks(session)) {
      // Claude Code: hooks mark the turn boundaries (see onHook), not status changes, so one permission
      // prompt stays inside one step. Only the process ending closes a step here.
      if (status.state === 'done' || status.state === 'failed') void this.endStep(session)
      return
    }
    // Other agents (and Claude until its first hook arrives): a step is one stretch of working.
    if (before !== 'working' && status.state === 'working') void this.beginStep(session)
    else if (before === 'working' && status.state !== 'working') void this.endStep(session)
  }

  private usesHooks(session: Session): boolean {
    return session.hookCapable && session.hookSeen
  }

  /** Opens a checkpoint step for the session unless one is already open. Never rejects. */
  private beginStep(session: Session, label?: string): Promise<void> {
    const steps = this.deps.steps
    const { info } = session
    if (!steps || info.agent === 'shell') return Promise.resolve()
    // A step that is already opening is not opened twice, but callers can still wait for its baseline.
    if (session.stepOpen) return session.opening ?? Promise.resolve()
    session.stepOpen = true
    const name = label || session.lastPrompt || `Turn at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    const opening = Promise.resolve()
      .then(() => steps.start(info.id, info.agent, info.cwd, name))
      .catch(() => undefined)
    session.opening = opening
    void opening.then(() => {
      if (session.opening === opening) session.opening = null
    })
    return opening
  }

  /** Waits for the opening checkpoint, but not forever: past the ceiling the step is recorded as unprotected. */
  private async startWithCeiling(session: Session, ceilingMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    const ceiling = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        resolve()
      }, ceilingMs)
    })
    try {
      await Promise.race([this.beginStep(session), ceiling])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (timedOut) {
      this.deps.steps?.unprotected?.(
        session.info.id,
        `the opening snapshot was still running after ${Math.round(ceilingMs / 1000)} seconds, so the agent was let start without it`
      )
    }
  }

  private endStep(session: Session): Promise<void> {
    if (!session.stepOpen) return Promise.resolve()
    session.stepOpen = false
    const steps = this.deps.steps
    if (!steps) return Promise.resolve()
    return Promise.resolve()
      .then(() => steps.end(session.info.id))
      .catch(() => undefined)
  }

  /**
   * Does pressing Enter now start work that needs an opening checkpoint? Once Claude's hooks are known
   * to work, the awaited UserPromptSubmit hook opens the step, so Enter (which may be a menu key) does not.
   */
  private needsStep(s: Session): boolean {
    const state = s.info.status.state
    return (
      Boolean(this.deps.steps) &&
      s.info.agent !== 'shell' &&
      !this.usesHooks(s) &&
      !s.stepOpen &&
      state !== 'working' &&
      state !== 'done' &&
      state !== 'failed'
    )
  }

  private deliver(s: Session, job: QueuedInput): void {
    if (!s.pty) return
    s.pty.write(job.data)
    this.applyStatus(s, s.tracker.onInput(job.data))
    if (job.fromUser) this.onUserInput?.(s.info.id)
  }

  /** Cancels input that is still waiting for its checkpoint (Ctrl-C, or the session going away). */
  private cancelQueued(s: Session): void {
    s.epoch++
    s.inputQueue.length = 0
    s.typed = ''
  }

  private async drain(s: Session): Promise<void> {
    if (s.draining) return
    s.draining = true
    try {
      while (s.inputQueue.length > 0) {
        const job = s.inputQueue.shift()!
        const alive = (): boolean => this.sessions.get(s.info.id) === s && s.pty !== null
        if (!alive()) break
        const epoch = s.epoch
        if (job.submit && this.needsStep(s)) {
          await this.startWithCeiling(s, this.deps.stepCeilingMs ?? STEP_START_CEILING_MS)
          if (!alive()) break
          if (s.epoch !== epoch) {
            // Cancelled while the checkpoint was being made: close the unused step unless the agent is busy.
            if (s.info.status.state !== 'working') void this.endStep(s)
            continue
          }
        }
        this.deliver(s, job)
      }
    } finally {
      s.draining = false
    }
  }

  write(id: string, data: string, fromUser = true): void {
    const s = this.sessions.get(id)
    if (!s?.pty) return
    // Ctrl-C passes straight through and cancels a submit that is still waiting for its checkpoint.
    const interrupt = data.includes('\x03')
    if (interrupt) this.cancelQueued(s)
    let submitted = ''
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        if (s.typed.trim()) s.lastPrompt = submitted = s.typed.trim().slice(0, 200)
        s.typed = ''
      } else if (ch === '\x7f' || ch === '\b') s.typed = s.typed.slice(0, -1)
      else if (ch >= ' ') s.typed += ch
    }
    const job: QueuedInput = { data, fromUser, submit: /[\r\n]/.test(data), submitted }
    // Pressing Enter on an idle agent starts its work. The opening checkpoint must exist before the
    // agent can touch a file, so the Enter (and anything typed after it) waits for the snapshot.
    const waits = job.submit && this.needsStep(s)
    if (interrupt || (!s.draining && s.inputQueue.length === 0 && !waits)) {
      this.deliver(s, job)
      return
    }
    s.inputQueue.push(job)
    void this.drain(s)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s || cols < 2 || rows < 2) return
    s.opts.cols = cols
    s.opts.rows = rows
    s.screen.resize(cols, rows)
    try {
      s.pty?.resize(cols, rows)
    } catch {
      // The process may have just exited.
    }
  }

  snapshot(id: string): string {
    return this.sessions.get(id)?.chunks.join('') ?? ''
  }

  /** Types `text` into each session, then presses Enter a moment later (so TUIs see a submit, not a paste). */
  broadcast(ids: string[], text: string): number {
    let sent = 0
    for (const id of ids) {
      const s = this.sessions.get(id)
      if (!s?.pty) continue
      this.write(id, text)
      setTimeout(() => this.write(id, '\r'), 80)
      sent++
    }
    return sent
  }

  kill(id: string): void {
    this.sessions.get(id)?.pty?.kill()
  }

  remove(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.pty?.kill()
    this.cancelQueued(s)
    void this.endStep(s)
    if (s.flushTimer) clearTimeout(s.flushTimer)
    if (s.screenTimer) clearTimeout(s.screenTimer)
    s.screen.dispose()
    this.sessions.delete(id)
    this.deps.emit('session:removed', { id })
  }

  async restart(id: string): Promise<SessionInfo> {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`No session ${id}`)
    const opts = { ...s.opts, cwd: s.info.cwd, title: s.info.title, isolate: false, account: s.info.account }
    this.remove(id)
    return this.create(opts)
  }

  /** Restarts a pane with another sign-in (an AccountInfo id). */
  async setAccount(id: string, account: string): Promise<SessionInfo> {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`No session ${id}`)
    s.info.account = account
    return this.restart(id)
  }

  /** Starts a crew: every requested agent, `count` times each, optionally each in its own worktree. */
  async launchSet(opts: LaunchSetOptions): Promise<SessionInfo[]> {
    const started: SessionInfo[] = []
    for (const { kind, count } of opts.agents) {
      for (let i = 0; i < count; i++) {
        started.push(await this.create({ agent: kind, cols: opts.cols, rows: opts.rows, isolate: opts.isolate }))
      }
    }
    return started
  }

  onHook(id: string, event: string, payload: unknown): Promise<void> | void {
    const s = this.sessions.get(id)
    if (!s) return
    if (typeof payload === 'object' && payload !== null) {
      const transcript = (payload as Record<string, unknown>)['transcript_path']
      if (typeof transcript === 'string' && transcript) s.info.transcriptPath = transcript
    }
    if (event === 'UserPromptSubmit' && typeof payload === 'object' && payload !== null) {
      const prompt = (payload as Record<string, unknown>)['prompt']
      if (typeof prompt === 'string' && prompt.trim()) s.lastPrompt = prompt.trim().slice(0, 200)
    }
    // The first hook proves the hooks work; from then on they, not status changes, mark the steps.
    if (s.hookCapable) s.hookSeen = true
    this.applyStatus(s, s.tracker.onHook(event, payload))
    if (!this.usesHooks(s) || !this.deps.steps || s.info.agent === 'shell') return
    if (event === 'UserPromptSubmit') {
      // Answer only once the baseline exists, whether this hook opened the step or an Enter already did.
      const wasOpen = s.stepOpen
      const ready = this.startWithCeiling(s, Math.min(this.deps.stepCeilingMs ?? STEP_START_CEILING_MS, HOOK_START_CEILING_MS))
      if (wasOpen && s.lastPrompt) this.deps.steps.relabel?.(s.info.id, s.lastPrompt)
      return ready
    } else if (event === 'Stop' || event === 'SessionEnd') return this.endStep(s)
  }

  private tickAll(): void {
    for (const s of this.sessions.values()) this.applyStatus(s, s.tracker.tick())
  }

  disposeAll(): void {
    clearInterval(this.ticker)
    for (const id of [...this.sessions.keys()]) this.remove(id)
  }
}
