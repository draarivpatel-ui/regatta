// Settings > Usage > Daily budgets: a token budget per agent.

import { useEffect, useMemo, useState } from 'react'
import { AGENTS, AGENT_ORDER } from '@shared/agents'
import type { BudgetLevel, BudgetPrefs, BudgetState } from '@shared/budgets'
import type { AgentKind, DetectedAgent } from '@shared/types'
import type { AgentUsage, UsageSummary } from '@shared/usage'
import { bridge } from '../../../lib/bridge'
import { useSessions } from '../../../store/sessions'
import { AgentBadge } from '../../../components/marks'
import { cx } from '../../../components/ui'

/** "0", "942", "4.1k", "86.3k", "1.2m". */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(1)}m`
}

function agentOrder(kind: AgentKind): number {
  const index = AGENT_ORDER.indexOf(kind)
  return index === -1 ? AGENT_ORDER.length : index
}

function levelBadge(level: BudgetLevel | null): { text: string; className: string } {
  if (level === 'over') {
    return { text: 'Over budget', className: 'border-st-failed/40 bg-st-failed/10 text-st-failed' }
  }
  if (level === 'near') {
    return { text: 'Near budget', className: 'border-st-waiting/40 bg-st-waiting/10 text-st-waiting' }
  }
  if (level === 'ok') {
    return { text: 'Within budget', className: 'border-st-idle/35 bg-st-idle/10 text-st-idle' }
  }
  return { text: 'No limit', className: 'border-line bg-raised text-faint' }
}

export function BudgetsPanel({ summary }: { summary?: UsageSummary | null }): React.JSX.Element {
  const agents = useSessions((s) => s.agents)
  const [localSummary, setLocalSummary] = useState<UsageSummary | null>(null)
  const [prefs, setPrefs] = useState<BudgetPrefs>({ daily: {} })
  const [states, setStates] = useState<BudgetState[]>([])
  const [drafts, setDrafts] = useState<Partial<Record<AgentKind, string>>>({})

  const effectiveSummary = summary ?? localSummary

  useEffect(() => {
    let alive = true
    void Promise.all([
      bridge.invoke('budgets:get').catch(() => ({ daily: {} })),
      bridge.invoke('budgets:states').catch(() => []),
      summary === undefined ? bridge.invoke('usage:summary').catch(() => null) : Promise.resolve(null)
    ]).then(([nextPrefs, nextStates, fetchedSummary]) => {
      if (!alive) return
      setPrefs(nextPrefs)
      setStates(nextStates)
      if (fetchedSummary) setLocalSummary(fetchedSummary)
      const initDrafts: Partial<Record<AgentKind, string>> = {}
      for (const [k, v] of Object.entries(nextPrefs.daily)) {
        if (typeof v === 'number' && v > 0) initDrafts[k as AgentKind] = String(v)
      }
      setDrafts(initDrafts)
    })

    const off = bridge.on('budgets:changed', (next) => {
      if (alive) setStates(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [summary])

  const rows = useMemo(() => {
    const byKind = new Map<AgentKind, AgentUsage>()
    for (const u of effectiveSummary?.agents ?? []) byKind.set(u.agent, u)
    const stateByKind = new Map<AgentKind, BudgetState>()
    for (const s of states) stateByKind.set(s.agent, s)

    const list: { agent: DetectedAgent; usedToday: number; state: BudgetState | null }[] = []
    const seen = new Set<AgentKind>()

    for (const agent of agents) {
      if (agent.kind === 'shell' || seen.has(agent.kind)) continue
      const usage = byKind.get(agent.kind) ?? null
      const st = stateByKind.get(agent.kind) ?? null
      if (!agent.installed && !usage && !st) continue
      seen.add(agent.kind)
      const usedToday = st?.usedToday ?? usage?.tokensToday ?? 0
      list.push({ agent, usedToday, state: st })
    }

    for (const [kind, usage] of byKind) {
      if (kind === 'shell' || seen.has(kind)) continue
      seen.add(kind)
      const st = stateByKind.get(kind) ?? null
      list.push({
        agent: { ...AGENTS[kind], installed: true, path: null, version: null },
        usedToday: st?.usedToday ?? usage.tokensToday,
        state: st
      })
    }

    return list.sort((a, b) => agentOrder(a.agent.kind) - agentOrder(b.agent.kind))
  }, [agents, effectiveSummary, states])

  const handleChange = (kind: AgentKind, raw: string): void => {
    setDrafts((prev) => ({ ...prev, [kind]: raw }))
    const trimmed = raw.trim()
    const num = trimmed === '' ? null : Number(trimmed)
    if (trimmed !== '' && (!Number.isFinite(num) || num! <= 0)) return
    const tokens = num === null ? null : Math.round(num)
    void bridge
      .invoke('budgets:set', kind, tokens)
      .then((nextPrefs) => {
        setPrefs(nextPrefs)
        return bridge.invoke('budgets:states')
      })
      .then((nextStates) => setStates(nextStates))
      .catch(() => undefined)
  }

  return (
    <div className="mt-6" data-testid="budgets-panel">
      <h4 className="text-[14px] font-semibold tracking-[-0.01em]">Daily budgets</h4>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        Headless runs stop when an agent passes its daily token budget. Chat and panes show a warning and keep running.
      </p>

      <div className="mt-3 space-y-1.5">
        {rows.map(({ agent, usedToday, state }) => {
          const savedBudget = prefs.daily[agent.kind]
          const inputValue = drafts[agent.kind] ?? (savedBudget !== undefined ? String(savedBudget) : '')
          const badge = levelBadge(state?.level ?? null)
          return (
            <div
              key={agent.kind}
              data-testid={`budget-row-${agent.kind}`}
              className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2"
            >
              <AgentBadge kind={agent.kind} size={20} />
              <div className="min-w-0 flex-1">
                <span className="truncate text-[12.5px] font-medium text-fg">{agent.name}</span>
                <span className="ml-2.5 text-[11.5px] text-muted tabular-nums">
                  {formatTokens(usedToday)} today
                </span>
              </div>
              <input
                type="number"
                min={1}
                step={1000}
                data-testid={`budget-${agent.kind}`}
                aria-label={`Daily token budget for ${agent.name}`}
                placeholder="No limit"
                value={inputValue}
                onChange={(e) => handleChange(agent.kind, e.target.value)}
                className="h-7 w-[120px] rounded-md border border-line-strong bg-raised px-2 text-right font-mono text-[12px] text-fg tabular-nums outline-none transition-colors duration-150 placeholder:font-sans placeholder:text-faint focus:border-accent/60"
              />
              <span
                data-testid={`budget-state-${agent.kind}`}
                data-state={state?.level ?? 'none'}
                className={cx(
                  'inline-flex min-w-[96px] shrink-0 items-center justify-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  badge.className
                )}
              >
                {badge.text}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
