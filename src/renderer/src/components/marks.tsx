// Regatta's own marks: the app logo, agent monogram badges and the status chip.

import { AGENTS } from '@shared/agents'
import type { AgentKind, SessionStatus } from '@shared/types'
import { SquareTerminal } from 'lucide-react'
import { STATE_COLOR, STATE_LABEL, ago } from '../lib/format'
import { cx } from './ui'

export function Logo({ size = 22 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Regatta">
      <defs>
        <linearGradient id="rg-logo" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5eead4" />
          <stop offset="1" stopColor="#0d9488" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6.5" fill="url(#rg-logo)" />
      <path d="M11.2 4.6v11H5.6z" fill="#042f2b" />
      <path d="M12.9 7.2v8.4h4.6z" fill="#042f2b" opacity=".62" />
      <path d="M4.8 18.6c2.4-1.3 4.8-1.3 7.2 0s4.8 1.3 7.2 0" stroke="#042f2b" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function AgentBadge({ kind, size = 18 }: { kind: AgentKind; size?: number }): React.JSX.Element {
  const def = AGENTS[kind]
  if (kind === 'shell') {
    return (
      <span className="inline-flex items-center justify-center text-muted" style={{ width: size, height: size }}>
        <SquareTerminal size={size - 2} strokeWidth={1.75} />
      </span>
    )
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[5px] font-mono font-semibold leading-none tracking-tight"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.48,
        color: def.color,
        background: `color-mix(in srgb, ${def.color} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${def.color} 38%, transparent)`
      }}
      title={def.name}
    >
      {def.monogram}
    </span>
  )
}

export function StatusDot({ state, size = 7 }: { state: SessionStatus['state']; size?: number }): React.JSX.Element {
  const live = state === 'working' || state === 'starting'
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      {state === 'waiting' && (
        <span className="absolute inset-0 rounded-full animate-ping" style={{ background: STATE_COLOR[state], opacity: 0.55 }} />
      )}
      <span
        className={cx('relative inline-block rounded-full', live && 'animate-breathe')}
        style={{ width: size, height: size, background: STATE_COLOR[state] }}
      />
    </span>
  )
}

export function StatusChip({
  status,
  now,
  showElapsed = true
}: {
  status: SessionStatus
  now: number
  showElapsed?: boolean
}): React.JSX.Element {
  const color = STATE_COLOR[status.state]
  return (
    <span
      data-testid="status-chip"
      data-state={status.state}
      title={status.reason}
      className="inline-flex h-[20px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium whitespace-nowrap"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 26%, transparent)`
      }}
    >
      <StatusDot state={status.state} size={6} />
      {STATE_LABEL[status.state]}
      {showElapsed && <span className="font-normal opacity-70">· {ago(status.since, now)}</span>}
    </span>
  )
}
