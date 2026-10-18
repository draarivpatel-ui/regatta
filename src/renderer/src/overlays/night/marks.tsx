// The small status marks of Night watch: a dot and a pill in the color of a state.

import { cx } from '../../components/ui'
import type { Look } from './helpers'

/** A status dot. A running state pulses. */
export function LookDot({ look, pulse, size = 8 }: { look: Look; pulse?: boolean; size?: number }): React.JSX.Element {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} role="img" aria-label={look.label} title={look.label}>
      {pulse && <span className={cx('absolute inset-0 rounded-full opacity-60 animate-ping', look.dot)} />}
      <span className={cx('relative inline-block rounded-full', look.dot, pulse && 'animate-breathe')} style={{ width: size, height: size }} />
    </span>
  )
}

/** A status pill: the state's own color on its own faint border. */
export function LookPill({
  look,
  pulse,
  small,
  testId,
  status
}: {
  look: Look
  pulse?: boolean
  small?: boolean
  testId?: string
  status?: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      data-status={status}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        small ? 'h-[19px] px-2 text-[10.5px]' : 'h-[20px] px-2 text-[11px]',
        look.text,
        look.border
      )}
    >
      {!small && <LookDot look={look} pulse={pulse} size={6} />}
      {look.label}
    </span>
  )
}
