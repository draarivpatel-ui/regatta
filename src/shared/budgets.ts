// Daily token budgets per agent and the loop guard.

import type { AgentKind } from './types'

/** Daily token budgets. An agent with no entry has no budget. */
export interface BudgetPrefs {
  daily: Partial<Record<AgentKind, number>>
}

/** `near` starts at 80% of the budget. */
export type BudgetLevel = 'ok' | 'near' | 'over'

export interface BudgetState {
  agent: AgentKind
  budget: number
  usedToday: number
  level: BudgetLevel
}
