// Shared formatting for the Skipper heat views.

import { AGENTS } from '@shared/agents'
import type { HeatState, LaneState } from '@shared/heats'

/** What a lane is called: its label when the same agent races more than once, else the agent name. */
export function laneName(lane: Pick<LaneState, 'agent' | 'label'>): string {
  return lane.label ?? AGENTS[lane.agent]?.name ?? lane.agent
}

/** Tokens as "86.3k", a plain count, or "not reported" when the agent said nothing. */
export function formatTokens(tokens: number | null): string {
  if (tokens === null) return 'not reported'
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return `${tokens}`
}

/** Live diff as "+10 -1". */
export function formatDiff(added: number, removed: number): string {
  return `+${added} -${removed}`
}

/** Milliseconds as "48 s" below a minute, "3 m" above it. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  return `${Math.floor(s / 60)} m`
}

/** Elapsed time for one lane, live while it runs. */
export function laneElapsed(startedAt: number | null, endedAt: number | null, now: number): string {
  if (startedAt === null) return 'queued'
  return formatElapsed((endedAt ?? now) - startedAt)
}

function longestLaneMs(heat: HeatState, now: number): number {
  const ends = heat.lanes.map((l) => {
    if (l.durationMs !== null) return l.durationMs
    if (l.startedAt !== null) return (l.endedAt ?? now) - l.startedAt
    return 0
  })
  return Math.max(0, ...ends)
}

/** Header status text, for example "Racing, 3 lanes" style with a middle dot. */
export function heatStatusText(heat: HeatState, now: number): string {
  const n = heat.lanes.length
  switch (heat.status) {
    case 'baseline':
      return 'Running the baseline'
    case 'waiting':
      return 'Waiting for your go-ahead'
    case 'racing':
      if (heat.mode === 'handoff') return `Handing off \u00B7 ${heat.lanes.filter((lane) => lane.startedAt !== null).length} of ${n} attempts`
      return `Racing \u00B7 ${n} ${n === 1 ? 'lane' : 'lanes'}`
    case 'decided':
      if (heat.mode === 'handoff') return `Decided \u00B7 ${heat.lanes.filter((lane) => lane.startedAt !== null).length} attempts`
      return `Decided \u00B7 ${n} ${n === 1 ? 'lane' : 'lanes'} \u00B7 ${formatElapsed(longestLaneMs(heat, now))}`
    case 'merged':
      return 'Merged'
    case 'cancelled':
      return 'Cancelled'
    case 'error':
      return heat.error ?? 'Error'
  }
}

/** Short badge text for the heat list. */
export function heatBadgeText(status: HeatState['status']): string {
  switch (status) {
    case 'baseline':
      return 'Baseline'
    case 'waiting':
      return 'Waiting'
    case 'racing':
      return 'Racing'
    case 'decided':
      return 'Decided'
    case 'merged':
      return 'Merged'
    case 'cancelled':
      return 'Cancelled'
    case 'error':
      return 'Error'
  }
}

/** Baseline line, for example "Baseline on a1b2c3d: done failing, guard passing". */
export function baselineLine(heat: HeatState): string {
  if (!heat.base) return 'Baseline running...'
  const short = heat.base.slice(0, 7)
  if (heat.baseline.length === 0) return `Baseline on ${short}: checks running...`
  const parts = heat.baseline.map((c) => `${c.name} ${c.passed ? 'passing' : 'failing'}`)
  return `Baseline on ${short}: ${parts.join(' \u00B7 ')}`
}
