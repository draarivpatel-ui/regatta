// Night watch: a queue of tasks that run one by one, each in its own worktree, while the user is away.
// Each task is a single heat lane judged by the same gates. Nothing is merged or pushed automatically.
// See docs/design/phase4.md, section Night watch.

import type { AgentKind } from './types'
import type { CheckResult, CheckSpec, GateResult, TestCounts } from './heats'

export interface NightTask {
  id: string
  prompt: string
  agent: AgentKind
  checks: CheckSpec[]
  createdAt: number
}

export type NightTaskStatus = 'queued' | 'running' | 'checking' | 'ready' | 'failed' | 'stopped' | 'merged' | 'discarded'

export interface NightTaskRun {
  id: string
  taskId: string
  prompt: string
  agent: AgentKind
  status: NightTaskStatus
  worktree: string | null
  branch: string | null
  base: string | null
  /** The commit the checks tested (the run's committed tip), saved so merge and discard work after a restart. */
  tip?: string | null
  startedAt: number | null
  endedAt: number | null
  exitCode: number | null
  durationMs: number | null
  diff: { files: number; added: number; removed: number }
  tokens: number | null
  latest: string
  checkSpecs: CheckSpec[]
  checks: CheckResult[]
  gates: GateResult[]
  tests: TestCounts | null
  /** Why it failed or what was merged. */
  note: string
  /** Latest diff sampler error when a live measurement failed, or null when clear. */
  error?: string | null
}

export interface Night {
  id: string
  /** Project folder the night ran in. */
  root: string
  /** When the night is scheduled to start, or started. */
  startAt: number
  status: 'scheduled' | 'running' | 'finished' | 'cancelled'
  runs: NightTaskRun[]
  finishedAt: number | null
  /** What the engine kept and why (a worktree or branch it could not safely remove, a held folder). */
  notes?: string[]
}

export interface NightState {
  queue: NightTask[]
  nights: Night[]
  /** True while a night is running and the computer is being kept awake. */
  keepingAwake: boolean
}
