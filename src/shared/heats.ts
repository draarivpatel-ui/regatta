// Heats: several agents race on one task, each in its own worktree; the project's checks decide.
// Types plus the pure gate and decision logic (unit tested). See docs/design/heats.md.

import type { AgentKind } from './types'

export interface CheckSpec {
  name: string
  command: string
  /** Required checks must pass in a lane. Guard checks must not regress against the baseline. */
  kind: 'required' | 'guard'
}

export interface CheckResult {
  name: string
  passed: boolean
  exitCode: number | null
  durationMs: number
  /** Last lines of the check's output. */
  outputTail: string
  /** True when a process the check started could not be stopped, so the folder it ran in was kept. */
  stuck?: boolean
}

export type GateId = 'finished' | 'changed' | 'checks' | 'no-regressions' | 'integrity'

export interface GateResult {
  id: GateId
  passed: boolean
  detail: string
}

export type LanePhase = 'queued' | 'preparing' | 'running' | 'checking' | 'done'

export interface TestCounts {
  /** Test file path to the number of test cases and assertions it contains. */
  [path: string]: { cases: number; assertions: number }
}

export interface LaneState {
  /** Unique inside the heat, even when the same agent races more than once. */
  id: string
  agent: AgentKind
  /** One-based attempt number in a hand-off. */
  attempt?: number
  /** Shown instead of the agent name when the same agent races more than once, for example "Claude Code 2". */
  label?: string
  worktree: string | null
  branch: string | null
  /** The commit that was committed, checked and scored. Only this exact commit is ever merged. */
  tip?: string
  phase: LanePhase
  startedAt: number | null
  endedAt: number | null
  exitCode: number | null
  durationMs: number | null
  timedOut: boolean
  diff: { files: number; added: number; removed: number }
  tokens: number | null
  latest: string
  checks: CheckResult[]
  /** Test counts in the lane after it finished (for the integrity gate). */
  tests: TestCounts | null
  gates: GateResult[]
  error: string | null
}

export type HeatStatus = 'baseline' | 'racing' | 'waiting' | 'decided' | 'merged' | 'cancelled' | 'error'

export interface Decision {
  kind: 'winner' | 'tie' | 'none'
  laneIds: string[]
  note: string
}

export interface HeatState {
  /** Older states without a mode are races. */
  mode?: 'race' | 'handoff'
  /** Project history when this heat was last decided. */
  handoffHistory?: HandoffHistory
  id: string
  task: string
  root: string
  base: string | null
  createdAt: number
  status: HeatStatus
  checks: CheckSpec[]
  baseline: CheckResult[]
  /** Test counts at the base commit. */
  baselineTests: TestCounts | null
  lanes: LaneState[]
  decision: Decision | null
  error: string | null
  /**
   * What the engine kept instead of removing, and why: a worktree with uncommitted changes, one a
   * process is still using, a branch that moved on. Shown to the user; never an error.
   */
  notes?: string[]
}

/** Paths that count as test files for the integrity gate. */
export function isTestFile(path: string): boolean {
  const p = path.replace(/\\/g, '/')
  return (
    /(^|\/)(test|tests|__tests__|spec)\//.test(p) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(p) ||
    /_test\.[a-z0-9]+$/i.test(p) ||
    /(^|\/)test_[^/]*\.py$/i.test(p)
  )
}

/** Counts test cases and assertions in one file's text. */
export function countTests(text: string): { cases: number; assertions: number } {
  const cases = (text.match(/\b(?:it|test)\s*\(|\bdef test_|\bfunc Test/g) ?? []).length
  const assertions = (text.match(/\bexpect\s*\(|\bassert/g) ?? []).length
  return { cases, assertions }
}

/** Check names that appear more than once. */
export function duplicateNames(checks: Pick<CheckSpec, 'name'>[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const check of checks) {
    if (seen.has(check.name)) repeated.add(check.name)
    seen.add(check.name)
  }
  return [...repeated]
}

const SECONDS = (ms: number | null): string => (ms === null ? '?' : `${Math.round(ms / 1000)} s`)

/** Evaluates the five gates for one finished lane. */
export function evaluateGates(
  lane: Pick<LaneState, 'exitCode' | 'timedOut' | 'diff' | 'checks' | 'tests'>,
  checks: CheckSpec[],
  baseline: CheckResult[],
  baselineTests: TestCounts | null
): GateResult[] {
  const gates: GateResult[] = []

  const finished = lane.exitCode === 0 && !lane.timedOut
  gates.push({
    id: 'finished',
    passed: finished,
    detail: finished ? 'finished' : lane.timedOut ? 'ran out of time' : `exited with code ${lane.exitCode ?? 'none'}`
  })

  const changed = lane.diff.files > 0
  gates.push({ id: 'changed', passed: changed, detail: changed ? `changed ${lane.diff.files} file${lane.diff.files === 1 ? '' : 's'}` : 'changed nothing' })

  const result = (name: string): CheckResult | undefined => lane.checks.find((c) => c.name === name)
  const required = checks.filter((c) => c.kind === 'required')
  const failedRequired = required.filter((c) => !result(c.name)?.passed).map((c) => c.name)
  // Results are matched to checks by name, so a repeated name could hide a failure behind a pass.
  const repeated = duplicateNames(checks)
  gates.push({
    id: 'checks',
    passed: failedRequired.length === 0 && repeated.length === 0,
    detail:
      repeated.length > 0
        ? `check names repeat: ${repeated.join(', ')}`
        : failedRequired.length === 0
          ? 'required checks pass'
          : `failing: ${failedRequired.join(', ')}`
  })

  const regressed = checks
    .filter((c) => c.kind === 'guard')
    .filter((c) => baseline.find((b) => b.name === c.name)?.passed && !result(c.name)?.passed)
    .map((c) => c.name)
  gates.push({
    id: 'no-regressions',
    passed: regressed.length === 0,
    detail: regressed.length === 0 ? 'nothing that passed before fails now' : `broke: ${regressed.join(', ')}`
  })

  const problems: string[] = []
  if (baselineTests && lane.tests) {
    for (const [path, before] of Object.entries(baselineTests)) {
      const after = lane.tests[path]
      if (!after) problems.push(`deleted ${path}`)
      else if (after.cases < before.cases) problems.push(`fewer tests in ${path}`)
      else if (after.assertions < before.assertions) problems.push(`fewer assertions in ${path}`)
    }
  }
  gates.push({
    id: 'integrity',
    passed: problems.length === 0,
    detail: problems.length === 0 ? 'tests left intact' : problems.join('; ')
  })
  return gates
}

/** Share of the fastest time within which a slower lane counts as a tie. */
export const TIE_BAND = 0.2

/** Picks the winner, a tie for the user to break, or nobody. Lanes must already have gates. */
export function decide(
  lanes: Pick<LaneState, 'id' | 'agent' | 'label' | 'durationMs' | 'gates'>[],
  names: (agent: AgentKind) => string
): Decision {
  const nameOf = (lane: Pick<LaneState, 'agent' | 'label'>): string => lane.label ?? names(lane.agent)
  const eligible = lanes.filter((l) => l.gates.length > 0 && l.gates.every((g) => g.passed))
  if (eligible.length === 0) {
    const why = lanes
      .map((l) => {
        const failed = l.gates.find((g) => !g.passed)
        return `${nameOf(l)}: ${failed ? failed.detail : 'did not finish'}`
      })
      .join('; ')
    return { kind: 'none', laneIds: [], note: `No lane passed every gate. ${why}.` }
  }
  const sorted = [...eligible].sort((a, b) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity))
  const best = sorted[0]!
  const limit = (best.durationMs ?? 0) * (1 + TIE_BAND)
  const band = sorted.filter((l) => (l.durationMs ?? Infinity) <= limit)
  if (band.length > 1) {
    const list = band.map((l) => `${nameOf(l)} (${SECONDS(l.durationMs)})`).join(', ')
    return { kind: 'tie', laneIds: band.map((l) => l.id), note: `Tie: ${list} all passed every gate within 20% of each other. You pick.` }
  }
  const runnerUp = sorted[1]
  const tail = runnerUp ? `, outside the 20% band of ${nameOf(runnerUp)} (${SECONDS(runnerUp.durationMs)})` : ''
  return {
    kind: 'winner',
    laneIds: [best.id],
    note: `${nameOf(best)} wins: every gate passed and it finished in ${SECONDS(best.durationMs)}${tail}.`
  }
}


export type HandoffPreference = 'balanced' | 'quality' | 'speed'

export interface HandoffHistory {
  [agent: string]: { wins: number; fails: number }
}

/** Preference rules, not measured performance claims. Only supported headless agents are ranked. */
export const HANDOFF_RANKING: Record<HandoffPreference, readonly AgentKind[]> = {
  balanced: ['codex', 'claude', 'gemini', 'opencode', 'grok', 'fake'],
  quality: ['claude', 'codex', 'opencode', 'gemini', 'grok', 'fake'],
  speed: ['gemini', 'grok', 'opencode', 'codex', 'claude', 'fake']
}

/** A net two wins moves an agent up one place; a net two failures moves it down one place. */
export function suggestOrder(preference: HandoffPreference, installed: AgentKind[], history: HandoffHistory): AgentKind[] {
  const ranked = HANDOFF_RANKING[preference].filter((agent) => installed.includes(agent))
  const score = (agent: AgentKind, index: number): number => {
    const entry = history[agent]
    const delta = entry ? Math.trunc((entry.wins - entry.fails) / 2) : 0
    return index - delta
  }
  return ranked.map((agent, index) => ({ agent, index, score: score(agent, index), shift: index - score(agent, index) }))
    .sort((a, b) => a.score - b.score || b.shift - a.shift || a.index - b.index)
    .map(({ agent }) => agent)
}
