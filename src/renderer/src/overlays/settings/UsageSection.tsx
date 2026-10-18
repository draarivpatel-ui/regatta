// Settings > Usage: tokens per agent and Codex's live limits, read from each CLI's own files.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { AGENTS, AGENT_ORDER } from '@shared/agents'
import type { AgentKind, DetectedAgent } from '@shared/types'
import type { AgentUsage, LiveLimits, UsageSummary } from '@shared/usage'
import { bridge } from '../../lib/bridge'
import { useNow } from '../../lib/useNow'
import { useSessions } from '../../store/sessions'
import { AgentBadge } from '../../components/marks'
import { Button, cx } from '../../components/ui'
import { BudgetsPanel } from './usage/BudgetsPanel'

const DAYS = 14

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "0", "942", "4.1k", "86.3k", "1.2m". */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(1)}m`
}

/** "18:42" in local time. */
function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Day keys for the last 14 days ending today, oldest first, matching what the main process sends. */
function dayKeys(count: number): string[] {
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const keys = [`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`]
  for (let i = 1; i < count; i += 1) {
    cursor.setDate(cursor.getDate() - 1)
    keys.unshift(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`)
  }
  return keys
}

/** "Jun 12" from a "YYYY-MM-DD" key. */
function dayLabel(key: string): string {
  const [, month, day] = key.split('-')
  const name = MONTHS[Number(month) - 1] ?? month ?? ''
  return `${name} ${Number(day ?? '0')}`
}

/** "resets in 2 h 10 m", "resets in 10 m", "resets in 5 d 5 h" or "resets any moment". */
function resetIn(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes <= 0) return 'resets any moment'
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    if (hours === 0) return `resets in ${minutes} m`
    return `resets in ${hours} h ${minutes % 60} m`
  }
  return `resets in ${Math.floor(hours / 24)} d ${hours % 24} h`
}

/** Fourteen bars, tallest one full height, with the date and count in a tooltip. */
function DailyBars({ daily }: { daily: number[] }): React.JSX.Element {
  const keys = useMemo(() => dayKeys(daily.length || DAYS), [daily.length])
  const max = Math.max(1, ...daily)
  return (
    <div className="mt-2 flex h-9 items-end gap-[3px]" data-testid="usage-chart">
      {daily.map((value, index) => {
        const key = keys[index] ?? ''
        const height = value > 0 ? Math.max(10, Math.round((value / max) * 100)) : 0
        return (
          <div
            key={key || index}
            data-testid="usage-bar"
            title={value > 0 ? `${dayLabel(key)}: ${formatTokens(value)} tokens` : `${dayLabel(key)}: no tokens`}
            className="group relative h-full min-w-[3px] flex-1"
          >
            {value > 0 ? (
              <div
                className={cx('w-full rounded-[2px]', index === daily.length - 1 ? 'bg-accent' : 'bg-accent/60')}
                style={{ height: `${height}%` }}
              />
            ) : (
              <div className="h-[2px] w-full rounded-[2px] bg-line" />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** One percent bar for a live limit window. */
function LimitRow({
  label,
  pct,
  resetsAt,
  now
}: {
  label: string
  pct: number | null
  resetsAt: number | null
  now: number
}): React.JSX.Element {
  const value = pct === null ? null : Math.min(100, Math.max(0, Math.round(pct)))
  return (
    <div data-testid="usage-limit" className="flex items-center gap-3 py-[3px]">
      <span className="w-[92px] shrink-0 text-[12px] text-muted">{label}</span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-press">
        {value !== null && <div className="h-full rounded-full bg-accent" style={{ width: `${value}%` }} />}
      </div>
      <span className="w-[64px] shrink-0 text-right text-[12px] tabular-nums">{value === null ? 'not reported' : `${value}%`}</span>
      <span className="w-[104px] shrink-0 text-right text-[11.5px] text-faint">
        {resetsAt === null ? '' : resetIn(resetsAt - now)}
      </span>
    </div>
  )
}

function AgentCard({ agent, usage }: { agent: DetectedAgent; usage: AgentUsage | null }): React.JSX.Element {
  return (
    <div data-testid="usage-card" data-agent={agent.kind} className="rounded-lg border border-line bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <AgentBadge kind={agent.kind} size={20} />
        <span className="truncate text-[12.5px] font-medium">{agent.name}</span>
        <span className="ml-auto shrink-0 text-[11.5px] text-faint tabular-nums">
          {usage ? `${usage.runs} ${usage.runs === 1 ? 'run' : 'runs'}` : ''}
        </span>
      </div>
      {usage ? (
        <>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="text-[12px] tabular-nums">{formatTokens(usage.tokensMonth)} tokens this month</span>
            <span className="text-[11.5px] text-muted tabular-nums">{formatTokens(usage.tokensToday)} today</span>
          </div>
          <DailyBars daily={usage.daily} />
        </>
      ) : (
        <p className="mt-1.5 text-[12px] text-muted">Not reported by this CLI</p>
      )}
    </div>
  )
}

function agentOrder(kind: AgentKind): number {
  const index = AGENT_ORDER.indexOf(kind)
  return index === -1 ? AGENT_ORDER.length : index
}

export function UsageSection(): React.JSX.Element {
  const now = useNow()
  const agents = useSessions((s) => s.agents)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [busy, setBusy] = useState(true)

  const load = useCallback(() => {
    setBusy(true)
    void bridge
      .invoke('usage:summary')
      .then((next) => setSummary(next))
      .catch(() => setSummary({ agents: [], limits: [], checkedAt: Date.now() }))
      .finally(() => setBusy(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // A card for every CLI that is installed or has runs; the first kind wins if the list repeats.
  const cards = useMemo(() => {
    const byKind = new Map<AgentKind, AgentUsage>()
    for (const usage of summary?.agents ?? []) byKind.set(usage.agent, usage)
    const rows: { agent: DetectedAgent; usage: AgentUsage | null }[] = []
    const seen = new Set<AgentKind>()
    for (const agent of agents) {
      if (agent.internal || seen.has(agent.kind)) continue
      const usage = byKind.get(agent.kind) ?? null
      if (!agent.installed && !usage) continue
      seen.add(agent.kind)
      rows.push({ agent, usage })
    }
    for (const [kind, usage] of byKind) {
      if (seen.has(kind)) continue
      rows.push({ agent: { ...AGENTS[kind], installed: true, path: null, version: null }, usage })
    }
    return rows.sort((a, b) => agentOrder(a.agent.kind) - agentOrder(b.agent.kind))
  }, [agents, summary])

  const limits = summary?.limits ?? []

  return (
    <div className="max-w-[620px]">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold tracking-[-0.01em]">Usage</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            This month, from each CLI&apos;s own records on this computer.
          </p>
        </div>
        <Button variant="subtle" size="sm" data-testid="usage-refresh" onClick={load} disabled={busy}>
          <RefreshCw size={13} className={busy ? 'animate-spin' : undefined} />
          {busy ? 'Checking' : 'Refresh'}
        </Button>
      </div>

      <div className="mt-3 space-y-1.5" data-testid="usage-cards">
        {cards.map((card) => (
          <AgentCard key={card.agent.kind} agent={card.agent} usage={card.usage} />
        ))}
      </div>

      {cards.length === 0 && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
          No CLI records yet. Start an agent and its runs show up here.
        </p>
      )}

      {limits.length > 0 && (
        <div className="mt-4" data-testid="usage-limits">
          <p className="text-[12.5px] font-medium">Live limits from Codex</p>
          {limits.map((limit) => (
            <LimitsCard key={limit.agent} limit={limit} now={now} />
          ))}
        </div>
      )}

      {summary && <p className="mt-3 text-[11.5px] text-faint">Checked {clock(summary.checkedAt)}</p>}

      <BudgetsPanel summary={summary} />
    </div>
  )
}

function LimitsCard({ limit, now }: { limit: LiveLimits; now: number }): React.JSX.Element {
  return (
    <div className="mt-2 rounded-lg border border-line bg-panel px-3 py-2">
      <LimitRow label="5 hour window" pct={limit.fiveHourPct} resetsAt={limit.fiveHourResetsAt} now={now} />
      <LimitRow label="Weekly window" pct={limit.weeklyPct} resetsAt={limit.weeklyResetsAt} now={now} />
    </div>
  )
}
