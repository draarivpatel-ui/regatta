import type { SessionState } from '@shared/types'

/** "4 s", "3 m", "2 h" since `since`. */
export function ago(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} m`
  return `${Math.floor(m / 60)} h`
}

export const STATE_LABEL: Record<SessionState, string> = {
  starting: 'starting',
  working: 'working',
  waiting: 'needs you',
  idle: 'ready',
  quiet: 'quiet',
  done: 'exited',
  failed: 'failed'
}

export const STATE_COLOR: Record<SessionState, string> = {
  starting: 'var(--color-st-starting)',
  working: 'var(--color-st-working)',
  waiting: 'var(--color-st-waiting)',
  idle: 'var(--color-st-idle)',
  quiet: 'var(--color-st-quiet)',
  done: 'var(--color-st-done)',
  failed: 'var(--color-st-failed)'
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
