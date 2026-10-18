// Daily token budgets per agent, and the guard that keeps headless runs inside them and out of loops.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_ORDER } from '../shared/agents'
import type { BudgetLevel, BudgetPrefs, BudgetState } from '../shared/budgets'
import type { AgentKind } from '../shared/types'
import type { UsageSummary } from '../shared/usage'
import type { RunHandle, RunOptions, RunResult } from './heats/runner'

/** Starts one headless agent run. */
export type RunFn = (opts: RunOptions) => RunHandle

export interface BudgetDeps {
  /** App data folder: <dataDir>/budgets.json keeps the budgets and the ledger of headless runs. */
  dataDir: string
  usage: () => Promise<UsageSummary>
  /** The agent's display name, for messages. */
  agentName: (agent: AgentKind) => string
  emit: (states: BudgetState[]) => void
  /** Overridable clock for tests. */
  now?: () => number
}

interface StoredBudgets {
  daily: Partial<Record<AgentKind, number>>
  /** Headless tokens per local calendar day ("YYYY-MM-DD"), per agent. Kept 14 days. */
  ledger: Record<string, Partial<Record<AgentKind, number>>>
}

const BUDGETS_FILE = 'budgets.json'
const LEDGER_DAYS = 14
const USAGE_CACHE_MS = 60_000
const LOOP_THRESHOLD = 3
const MAX_REFUSED_OUTPUT_LINES = 20

/** Local calendar day key, "YYYY-MM-DD". */
function dayKey(ms: number): string {
  const day = new Date(ms)
  const month = String(day.getMonth() + 1).padStart(2, '0')
  const date = String(day.getDate()).padStart(2, '0')
  return `${day.getFullYear()}-${month}-${date}`
}

/** Day keys for the last `count` days ending today, oldest first. */
function recentDayKeys(now: number, count: number): Set<string> {
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  const keys = new Set<string>([dayKey(cursor.getTime())])
  for (let i = 1; i < count; i += 1) {
    cursor.setDate(cursor.getDate() - 1)
    keys.add(dayKey(cursor.getTime()))
  }
  return keys
}

function agentRank(agent: AgentKind): number {
  const idx = AGENT_ORDER.indexOf(agent)
  return idx === -1 ? AGENT_ORDER.length : idx
}

function computeLevel(usedToday: number, budget: number): BudgetLevel {
  if (usedToday > budget) return 'over'
  if (usedToday >= budget * 0.8) return 'near'
  return 'ok'
}

/**
 * Normalizes command output for the loop guard: trims, removes timestamps and durations
 * (such as `12ms`, `0.84s`, `1.2 m`, ISO dates, or `12:34:56`), and collapses whitespace.
 */
export function normalizeCommandOutput(output: string): string {
  return output
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m|min|mins|minutes)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function lastLines(text: string, maxLines: number): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const lines = trimmed.split(/\r?\n/)
  return lines.slice(-maxLines).join('\n')
}

export class BudgetGuard {
  private readonly file: string
  private data: StoredBudgets = { daily: {}, ledger: {} }
  private cachedUsage: { summary: UsageSummary; fetchedAt: number } | null = null
  private inflightUsage: Promise<UsageSummary> | null = null
  private lastLevels: Map<AgentKind, BudgetLevel> | null = null

  constructor(private readonly deps: BudgetDeps) {
    this.file = join(deps.dataDir, BUDGETS_FILE)
    this.load()
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object') return
      const obj = raw as Record<string, unknown>
      const daily: Partial<Record<AgentKind, number>> = {}
      if (obj['daily'] && typeof obj['daily'] === 'object') {
        for (const [k, v] of Object.entries(obj['daily'] as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
            daily[k as AgentKind] = Math.round(v)
          }
        }
      }
      const ledger: Record<string, Partial<Record<AgentKind, number>>> = {}
      if (obj['ledger'] && typeof obj['ledger'] === 'object') {
        for (const [day, entries] of Object.entries(obj['ledger'] as Record<string, unknown>)) {
          if (entries && typeof entries === 'object') {
            const dayMap: Partial<Record<AgentKind, number>> = {}
            for (const [agent, tokens] of Object.entries(entries as Record<string, unknown>)) {
              if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
                dayMap[agent as AgentKind] = Math.round(tokens)
              }
            }
            if (Object.keys(dayMap).length > 0) ledger[day] = dayMap
          }
        }
      }
      this.data = { daily, ledger }
      this.pruneLedger()
    } catch {
      this.data = { daily: {}, ledger: {} }
    }
  }

  private pruneLedger(): void {
    const keep = recentDayKeys(this.now(), LEDGER_DAYS)
    for (const day of Object.keys(this.data.ledger)) {
      if (!keep.has(day)) delete this.data.ledger[day]
    }
  }

  private save(): void {
    this.pruneLedger()
    try {
      mkdirSync(this.deps.dataDir, { recursive: true })
      const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // Keep working in memory if the disk write fails.
    }
  }

  private async getUsage(): Promise<UsageSummary> {
    const now = this.now()
    if (this.cachedUsage && now - this.cachedUsage.fetchedAt < USAGE_CACHE_MS) {
      return this.cachedUsage.summary
    }
    if (this.inflightUsage) {
      return this.inflightUsage
    }
    this.inflightUsage = (async () => {
      try {
        const summary = await this.deps.usage()
        this.cachedUsage = { summary, fetchedAt: this.now() }
        return summary
      } catch {
        return { agents: [], limits: [], checkedAt: this.now() }
      } finally {
        this.inflightUsage = null
      }
    })()
    return this.inflightUsage
  }

  private ledgerToday(agent: AgentKind): number {
    // Codex usage already reads every rollout file on disk, so ledger tokens are not added for Codex.
    if (agent === 'codex') return 0
    const today = dayKey(this.now())
    return this.data.ledger[today]?.[agent] ?? 0
  }

  private addLedgerTokens(agent: AgentKind, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    const today = dayKey(this.now())
    const dayEntry = this.data.ledger[today] ?? {}
    dayEntry[agent] = (dayEntry[agent] ?? 0) + Math.round(tokens)
    this.data.ledger[today] = dayEntry
    this.save()
  }

  private async usedTodayFor(agent: AgentKind, summary?: UsageSummary): Promise<number> {
    const u = summary ?? (await this.getUsage())
    const fromUsage = u.agents.find((a) => a.agent === agent)?.tokensToday ?? 0
    return fromUsage + this.ledgerToday(agent)
  }

  private buildStates(summary: UsageSummary): BudgetState[] {
    const entries = Object.entries(this.data.daily) as [AgentKind, number | undefined][]
    const list: BudgetState[] = []
    for (const [agent, budget] of entries) {
      if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) continue
      const fromUsage = summary.agents.find((a) => a.agent === agent)?.tokensToday ?? 0
      const usedToday = fromUsage + this.ledgerToday(agent)
      list.push({
        agent,
        budget,
        usedToday,
        level: computeLevel(usedToday, budget)
      })
    }
    list.sort((a, b) => agentRank(a.agent) - agentRank(b.agent))
    return list
  }

  private checkAndEmit(states: BudgetState[], forceEmit = false): void {
    const nextLevels = new Map<AgentKind, BudgetLevel>()
    for (const s of states) nextLevels.set(s.agent, s.level)

    let changed = forceEmit
    if (!changed && this.lastLevels !== null) {
      if (this.lastLevels.size !== nextLevels.size) {
        changed = true
      } else {
        for (const [agent, level] of nextLevels) {
          if (this.lastLevels.get(agent) !== level) {
            changed = true
            break
          }
        }
      }
    } else if (!changed && this.lastLevels === null) {
      for (const level of nextLevels.values()) {
        if (level !== 'ok') {
          changed = true
          break
        }
      }
    }

    this.lastLevels = nextLevels
    if (changed) {
      this.deps.emit(states)
    }
  }

  prefs(): BudgetPrefs {
    return { daily: { ...this.data.daily } }
  }

  /** Sets an agent's daily budget, or clears it with null. */
  set(agent: AgentKind, tokens: number | null): BudgetPrefs {
    const prevBudget = this.data.daily[agent]
    if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) {
      delete this.data.daily[agent]
    } else {
      this.data.daily[agent] = Math.round(tokens)
    }
    this.save()
    const changedBudget = prevBudget !== this.data.daily[agent]
    void this.getUsage().then((summary) => {
      const next = this.buildStates(summary)
      this.checkAndEmit(next, changedBudget)
    })
    return this.prefs()
  }

  async states(): Promise<BudgetState[]> {
    const summary = await this.getUsage()
    const next = this.buildStates(summary)
    this.checkAndEmit(next, false)
    return next
  }

  /** The guarded run: refuses or stops runs past their budget, and runs caught in a loop. */
  wrap(run: RunFn): RunFn {
    return (opts: RunOptions): RunHandle => {
      const { agent, onActivity, onTokens, onCommand } = opts
      let inner: RunHandle | null = null
      let stopRequested = false
      let guardReason: string | null = null
      let latestTokens: number | null = null

      const stopAll = (): void => {
        stopRequested = true
        inner?.stop()
      }

      const done = (async (): Promise<RunResult> => {
        const summary = await this.getUsage()
        const budget = this.data.daily[agent]
        const baseUsed = await this.usedTodayFor(agent, summary)

        if (budget !== undefined && baseUsed > budget) {
          const name = this.deps.agentName(agent)
          const line = `Not started: ${name} is past its daily budget (${baseUsed} of ${budget} tokens).`
          onActivity(line)
          return {
            exitCode: null,
            durationMs: 0,
            tokens: null,
            stopped: true,
            refused: line
          }
        }

        if (stopRequested) {
          return {
            exitCode: null,
            durationMs: 0,
            tokens: null,
            stopped: true
          }
        }

        let streakCmd: string | null = null
        let streakNormOut: string | null = null
        let streakCount = 0

        const triggerGuardStop = (activityLine: string, refusedText: string): void => {
          if (guardReason !== null) return
          guardReason = refusedText
          onActivity(activityLine)
          inner?.stop()
        }

        inner = run({
          ...opts,
          onActivity: (line: string) => {
            if (guardReason !== null) return
            onActivity(line)
          },
          onTokens: (total: number) => {
            latestTokens = total
            if (guardReason === null) {
              onTokens(total)
            }
            const currentBudget = this.data.daily[agent]
            if (guardReason === null && currentBudget !== undefined) {
              const projected = baseUsed + Math.max(0, total)
              if (projected > currentBudget) {
                const name = this.deps.agentName(agent)
                const msg = `Stopped: ${name} passed its daily budget (${projected} of ${currentBudget} tokens).`
                triggerGuardStop(msg, msg)
              }
            }
          },
          onCommand: (c) => {
            onCommand?.(c)
            if (guardReason !== null) return
            if (!c.failed) {
              streakCmd = null
              streakNormOut = null
              streakCount = 0
              return
            }
            const cmdTrimmed = c.command.trim()
            const normOut = normalizeCommandOutput(c.output)
            if (streakCmd === cmdTrimmed && streakNormOut === normOut) {
              streakCount += 1
            } else {
              streakCmd = cmdTrimmed
              streakNormOut = normOut
              streakCount = 1
            }
            if (streakCount >= LOOP_THRESHOLD) {
              const headline = `Stopped: \`${cmdTrimmed}\` failed the same way 3 times.`
              const tail = lastLines(c.output, MAX_REFUSED_OUTPUT_LINES)
              const refused = tail ? `${headline}\n${tail}` : headline
              triggerGuardStop(headline, refused)
            }
          }
        })

        if (stopRequested) {
          inner.stop()
        }

        const result = await inner.done
        const finalTokens = result.tokens ?? latestTokens
        if (finalTokens !== null && finalTokens > 0) {
          this.addLedgerTokens(agent, finalTokens)
          const latestSummary = await this.getUsage()
          this.checkAndEmit(this.buildStates(latestSummary), false)
        }

        if (guardReason !== null) {
          return {
            ...result,
            tokens: finalTokens,
            stopped: true,
            refused: guardReason
          }
        }

        return result
      })()

      return {
        done,
        stop: stopAll
      }
    }
  }
}
