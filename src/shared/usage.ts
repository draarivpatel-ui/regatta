// Usage read from what each CLI records on this computer. See docs/design/phase4.md, Usage.

import type { AgentKind } from './types'

export interface AgentUsage {
  agent: AgentKind
  /** Sessions or headless runs counted this month. */
  runs: number
  tokensToday: number
  tokensMonth: number
  /** Tokens per day for the last 14 days, oldest first. */
  daily: number[]
  /** False when this CLI records nothing Regatta can read. */
  reported: boolean
}

export interface LiveLimits {
  agent: AgentKind
  fiveHourPct: number | null
  fiveHourResetsAt: number | null
  weeklyPct: number | null
  weeklyResetsAt: number | null
  /** When the CLI last recorded these numbers. */
  seenAt: number
}

export interface UsageSummary {
  agents: AgentUsage[]
  limits: LiveLimits[]
  checkedAt: number
}
