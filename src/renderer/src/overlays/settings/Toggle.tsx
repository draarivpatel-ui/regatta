// Reusable toggle switch for Settings.

import { cx } from '../../components/ui'

interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  testId?: string
  label?: string
  disabled?: boolean
}

export function Toggle({ checked, onChange, testId, label, disabled }: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40',
        checked ? 'border-accent bg-accent' : 'border-line-strong bg-press'
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'inline-block h-4 w-4 rounded-full transition-transform duration-150',
          checked ? 'translate-x-[18px] bg-accent-ink' : 'translate-x-[2px] bg-muted'
        )}
      />
    </button>
  )
}
