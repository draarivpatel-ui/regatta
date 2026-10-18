// StatusTracker: one per session. Pure logic, no Electron, so it is fully unit tested.
//
// Inputs:
//   onOutput  raw pty chunks (only used as an activity signal)
//   onScreen  the text currently visible on the session's screen (from a headless terminal)
//   onInput   what the user typed
//   onHook    events the agent reports itself (Claude Code hooks, Codex notify)
//   onExit    process exit
//   tick      time passing
//
// Silence never counts as finished. A silent agent is "quiet" until something says otherwise.

import type { AgentKind, SessionState, SessionStatus, SignalSource } from '../../shared/types'
import { hasVisibleText } from './ansi'
import { looksLikeAgentPrompt, looksLikeShellPrompt, matchWaiting, matchWorking } from './patterns'

export interface TrackerOptions {
  now?: () => number
  /** Silence after which a working or starting session becomes quiet. */
  quietAfterMs?: number
  /** How long after the user presses Enter new output still counts as the agent working. */
  submitWindowMs?: number
  /** How long a hook keeps authority over working and idle. */
  hookAuthorityMs?: number
}

const FINAL: SessionState[] = ['done', 'failed']

export class StatusTracker {
  private status: SessionStatus
  private lastOutputAt = 0
  private lastSubmitAt = 0
  private lastHookAt = 0
  /** Text of the question currently shown, and of the last question the user answered. */
  private liveQuestion: string | null = null
  private answeredQuestion: string | null = null
  private readonly now: () => number
  private readonly quietAfterMs: number
  private readonly submitWindowMs: number
  private readonly hookAuthorityMs: number

  constructor(
    private readonly agent: AgentKind,
    private readonly signals: SignalSource,
    opts: TrackerOptions = {}
  ) {
    this.now = opts.now ?? Date.now
    this.quietAfterMs = opts.quietAfterMs ?? 8000
    this.submitWindowMs = opts.submitWindowMs ?? 30000
    this.hookAuthorityMs = opts.hookAuthorityMs ?? 10 * 60 * 1000
    this.status = { state: 'starting', since: this.now(), reason: 'launched', source: 'process' }
  }

  get(): SessionStatus {
    return this.status
  }

  /** Raw output arrived. Only counts as activity. */
  onOutput(chunk: string): SessionStatus | null {
    if (this.isFinal() || !hasVisibleText(chunk)) return null
    const t = this.now()
    this.lastOutputAt = t
    if (this.hookAuthority(t)) return null
    const submittedRecently = this.lastSubmitAt > 0 && t - this.lastSubmitAt <= this.submitWindowMs
    const s = this.status.state
    if (s === 'quiet') return this.set('working', 'printing output', 'output')
    if ((s === 'starting' || s === 'idle') && submittedRecently && this.agent !== 'shell') {
      return this.set('working', 'printing output', 'output')
    }
    if (s === 'idle' && submittedRecently && this.agent === 'shell') {
      return this.set('working', 'running a command', 'output')
    }
    return null
  }

  /**
   * The text now visible on screen, one entry per row, and the row the cursor is on (-1 if unknown).
   * Called after output settles.
   */
  onScreen(screen: string, cursorRow = -1): SessionStatus | null {
    if (this.isFinal()) return null
    const filled = screen
      .split('\n')
      .map((text, row) => ({ text, row }))
      .filter((r) => r.text.trim().length > 0)
    const recent = filled.slice(-8)
    const bottom = recent.map((r) => r.text).join('\n')
    const lastLine = filled[filled.length - 1]?.text ?? ''

    // The lowest question on screen is live if the cursor sits on it, or if nobody answered it
    // and the agent has not started working again below it.
    for (let k = recent.length - 1; k >= 0; k--) {
      const line = recent[k]!
      const pattern = matchWaiting(line.text)
      if (!pattern) continue
      const onCursor = line.row === cursorRow
      const resumed = matchWorking(recent.slice(k + 1).map((r) => r.text).join('\n')) !== null
      const answered = this.answeredQuestion !== null && line.text.trim().startsWith(this.answeredQuestion)
      if (onCursor || (!resumed && !answered)) {
        this.liveQuestion = line.text.trim()
        return this.set('waiting', pattern.label, 'output')
      }
      break
    }

    if (this.status.state === 'waiting' && this.status.source === 'output') {
      // The question left the screen or was answered.
      return this.set('working', 'answered', 'output')
    }

    const t = this.now()
    const authority = this.hookAuthority(t)
    if (!authority) {
      const working = matchWorking(bottom)
      if (working) return this.set('working', working.label, 'output')
    }

    if (looksLikeShellPrompt(this.agent, lastLine)) return this.set('idle', 'shell prompt', 'output')
    if (!authority && looksLikeAgentPrompt(this.agent, lastLine)) {
      return this.set('idle', this.status.state === 'starting' ? 'at its prompt' : 'back at its prompt', 'output')
    }
    return null
  }

  /** The user typed into the pane. Enter counts as a submit. */
  onInput(data: string): SessionStatus | null {
    if (this.isFinal() || !/[\r\n]/.test(data)) return null
    this.lastSubmitAt = this.now()
    const s = this.status.state
    if (s === 'waiting') {
      this.answeredQuestion = this.liveQuestion
      return this.set('working', 'answered', 'input')
    }
    if (this.agent === 'shell') return null
    if (s === 'idle' || s === 'quiet' || s === 'starting') return this.set('working', 'prompt sent', 'input')
    return null
  }

  /**
   * An agent reported an event. `event` is a Claude Code hook name, or "notify" for Codex.
   * `payload` is the JSON the agent sent.
   */
  onHook(event: string, payload: unknown): SessionStatus | null {
    if (this.isFinal()) return null
    this.lastHookAt = this.now()
    const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
    const message = String(p['message'] ?? '')
    const type = String(p['type'] ?? '')
    switch (event) {
      case 'SessionStart':
        return this.set('idle', 'ready for a prompt', 'hook')
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
      case 'SubagentStop':
      case 'PreCompact':
        return this.set('working', 'working', 'hook')
      case 'Notification':
        if (/waiting for your input/i.test(message)) return this.set('idle', 'ready for a prompt', 'hook')
        return this.set('waiting', message || 'needs you', 'hook')
      case 'Stop':
        return this.set('idle', 'turn finished', 'hook')
      case 'SessionEnd':
        return this.set('idle', 'session ended', 'hook')
      case 'notify':
        if (/approval|permission/i.test(type)) return this.set('waiting', 'needs approval', 'hook')
        return this.set('idle', 'turn finished', 'hook')
      default:
        return null
    }
  }

  onExit(code: number | null): SessionStatus {
    if (code === 0) this.set('done', 'exited with code 0', 'process')
    else this.set('failed', code === null ? 'process was stopped' : `exited with code ${code}`, 'process')
    return this.status
  }

  /**
   * The agent hit its usage limit, so it is waiting for the reset, not for an answer.
   * `text` is empty, or a reset label such as "resets 6:30 PM" formatted by the caller.
   */
  onLimit(text: string): SessionStatus | null {
    if (this.isFinal()) return null
    const label = text.trim()
    const reason = label ? `hit its usage limit (${label})` : 'hit its usage limit'
    return this.set('waiting', reason, 'output')
  }

  /** Call about once a second for transitions that come from time passing. */
  tick(): SessionStatus | null {
    if (this.isFinal()) return null
    const t = this.now()
    const s = this.status.state
    if (s !== 'working' && s !== 'starting') return null
    if (this.status.source === 'hook' && this.hookAuthority(t)) return null
    const silentFor = t - Math.max(this.lastOutputAt, this.status.since)
    if (silentFor >= this.quietAfterMs) {
      return this.set('quiet', `no output for ${Math.round(silentFor / 1000)} s`, 'timer')
    }
    return null
  }

  /** Agents with hooks are trusted over screen guesses once they have spoken. */
  private hookAuthority(t: number): boolean {
    return this.signals !== 'output' && this.lastHookAt > 0 && t - this.lastHookAt < this.hookAuthorityMs && this.signals === 'hooks'
  }

  private isFinal(): boolean {
    return FINAL.includes(this.status.state)
  }

  private set(state: SessionState, reason: string, source: SessionStatus['source']): SessionStatus | null {
    if (this.status.state === state && this.status.reason === reason) return null
    const since = this.status.state === state ? this.status.since : this.now()
    this.status = { state, since, reason, source }
    return this.status
  }
}
