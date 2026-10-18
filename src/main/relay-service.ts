// Relay actions on live sessions: resume at reset, or continue now in another agent.

import { execFile } from 'node:child_process'
import { AGENTS } from '../shared/agents'
import type { AgentKind, LimitInfo, SessionInfo } from '../shared/types'
import type { SessionManager } from './sessions'
import { withoutRepoRouting } from './env'
import { buildBrief } from './relay'

/** How long after the reset time the agent is told to carry on. */
const RESUME_DELAY_MS = 30_000

/** How long after the text Enter is pressed, so a TUI sees a submit and not a paste. */
const ENTER_DELAY_MS = 80

/** Git never needs longer than this to describe the work so far. */
const GIT_TIMEOUT_MS = 5_000

/** How long a fresh pane gets to leave "starting" before the brief is typed into it. */
const START_TIMEOUT_MS = 4_000

export interface RelayDeps {
  sessions: SessionManager
  emitLimit: (id: string, limit: LimitInfo | null) => void
}

export class RelayService {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly deps: RelayDeps) {
    // Typing in the pane cancels a resume the user was waiting for.
    this.deps.sessions.onUserInput = (id) => this.cancelSchedule(id)
  }

  /** Waits for the reset, then types "continue" into the pane and presses Enter. */
  resumeLater(sessionId: string): void {
    const info = this.deps.sessions.get(sessionId)
    const limit = info?.limit
    if (!info || !limit || limit.resetsAt === null) {
      throw new Error('This agent did not say when its limit resets, so there is no time to wait for')
    }
    const resetsAt = limit.resetsAt
    this.clearTimer(sessionId)
    this.setLimit(sessionId, { ...limit, resumeScheduled: true })
    const delay = Math.max(0, resetsAt + RESUME_DELAY_MS - Date.now())
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      this.resume(sessionId)
    }, delay)
    this.timers.set(sessionId, timer)
  }

  /** Stops a scheduled resume, or drops the card when nothing was scheduled. */
  cancel(sessionId: string): void {
    this.clearTimer(sessionId)
    const limit = this.deps.sessions.get(sessionId)?.limit
    if (limit?.resumeScheduled) this.setLimit(sessionId, { ...limit, resumeScheduled: false })
    else if (limit) this.deps.sessions.dismissLimit(sessionId)
  }

  /** Only the schedule: typing in the pane must not hide the limit card. */
  private cancelSchedule(sessionId: string): void {
    const limit = this.deps.sessions.get(sessionId)?.limit
    if (!limit?.resumeScheduled) return
    this.clearTimer(sessionId)
    this.setLimit(sessionId, { ...limit, resumeScheduled: false })
  }

  /**
   * Opens a new pane with another agent in the same folder, sends it a brief built from
   * records, and forgets the old pane's limit.
   */
  async continueIn(sessionId: string, agent: AgentKind): Promise<SessionInfo> {
    if (agent === 'shell') throw new Error('Pick an agent, not the Terminal')
    const from = this.deps.sessions.get(sessionId)
    if (!from) throw new Error(`No session ${sessionId}`)
    const [gitStatus, diffStat] = await Promise.all([this.git(['status', '--short'], from.cwd), this.git(['diff', '--stat'], from.cwd)])
    const brief = buildBrief({
      agentName: AGENTS[from.agent].name,
      lastPrompt: this.deps.sessions.lastPrompt(sessionId),
      gitStatus,
      diffStat,
      screenTail: this.deps.sessions.screenText(sessionId)
    })
    const { cols, rows } = this.deps.sessions.size(sessionId)
    const created = await this.deps.sessions.create({ agent, cols, rows, cwd: from.cwd })
    await this.waitForStart(created.id)
    this.type(created.id, brief)
    this.deps.sessions.dismissLimit(sessionId)
    return created
  }

  /** The reset time came: tell the agent to carry on. */
  private resume(sessionId: string): void {
    const info = this.deps.sessions.get(sessionId)
    if (!info) return
    this.type(sessionId, 'continue')
    if (info.limit?.resumeScheduled) this.setLimit(sessionId, { ...info.limit, resumeScheduled: false })
  }

  /** Types text, then presses Enter a moment later. */
  private type(id: string, text: string): void {
    this.deps.sessions.write(id, text, false)
    setTimeout(() => this.deps.sessions.write(id, '\r', false), ENTER_DELAY_MS)
  }

  /** Waits until a fresh pane is past "starting", or four seconds, whichever comes first. */
  private waitForStart(id: string): Promise<void> {
    const startedAt = Date.now()
    return new Promise((done) => {
      const check = (): void => {
        const info = this.deps.sessions.get(id)
        if (!info || info.status.state !== 'starting' || Date.now() - startedAt >= START_TIMEOUT_MS) {
          done()
          return
        }
        setTimeout(check, 100)
      }
      check()
    })
  }

  /** Runs git in the session's folder. Empty on failure: a brief is never worth an error. */
  private git(args: string[], cwd: string): Promise<string> {
    return new Promise((done) => {
      execFile('git', args, { cwd, env: withoutRepoRouting({ ...process.env }), timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        done(err ? '' : String(stdout).trim())
      })
    })
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(sessionId)
  }

  private setLimit(sessionId: string, limit: LimitInfo | null): void {
    const info = this.deps.sessions.get(sessionId)
    if (!info) return
    info.limit = limit
    this.deps.emitLimit(sessionId, limit)
  }
}
