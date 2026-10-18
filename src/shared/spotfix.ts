// Spot fix: point at something in the running app, say what should change, and an agent changes the
// project.

import type { RollbackResult, StepFile } from './checkpoints'
import type { CheckSpec } from './heats'
import type { AgentKind } from './types'

/**
 * The agents Regatta can keep from running commands during a Spot fix. Codex cannot be kept from
 * running commands, so it is not offered.
 */
export const SPOTFIX_AGENTS: AgentKind[] = ['claude', 'fake']

export type SpotFixStatus = 'running' | 'checking' | 'review' | 'kept' | 'undone' | 'stopped' | 'error'

/** The element the user pointed at, in the page's own terms. */
export interface SpotFixPick {
  url: string
  selector: string
  text: string
  tag: string
  /** In CSS pixels. */
  rect: { x: number; y: number; width: number; height: number }
}

export interface SpotFixRequest {
  pick: SpotFixPick
  note: string
  agent: AgentKind
  /** A PNG data URL of the page as it was before, or null when the capture failed. */
  before: string | null
}

export interface SpotFixCheck {
  name: string
  passed: boolean
  /** The last lines of the check's output. */
  tail: string
}

/** One go at the change: the first request, a refinement, or a check pass recorded as its own step. */
export interface SpotFixRound {
  kind?: 'round' | 'checks'
  note: string
  /** The checkpoint step of this round, once it exists. */
  stepId: string | null
  /**
   * True once `checkpoints.start` succeeded for this round. A round whose checkpoint start failed
   * never launched (launched: false, completed: false): it changed nothing, so Undo skips it without
   * blocking older rounds.
   */
  launched?: boolean
  /**
   * True when the round got through `checkpoints.end`. A crash or a failed end on a launched round leaves
   * it false: the files the agent changed there are unknown, so Undo must stop at that round instead of
   * rewinding older rounds underneath it. A round that finished with no edits keeps it true.
   */
  completed: boolean
  startedAt: number
  endedAt: number | null
  files: StepFile[]
  checks: SpotFixCheck[]
  error?: string
}

export interface SpotFix {
  id: string
  /** The project folder the agent worked in. */
  cwd: string
  agent: AgentKind
  pick: SpotFixPick
  status: SpotFixStatus
  rounds: SpotFixRound[]
  /** The checks detected in `cwd` (never from a different workspace root). */
  detectedChecks?: CheckSpec[]
  /** The agent's latest activity line. */
  latest: string
  hasBefore: boolean
  hasAfter: boolean
  /** What Undo rewound, once the user undid it. */
  undo: RollbackResult[] | null
  /** Why Undo stopped part way (a kept file, a refused roll back, a round with no step), or null. */
  undoNote: string | null
  createdAt: number
  updatedAt: number
}

/** True only for http and https pages on this computer: localhost, *.localhost, 127.0.0.1 and [::1]. */
export function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname
    return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}
