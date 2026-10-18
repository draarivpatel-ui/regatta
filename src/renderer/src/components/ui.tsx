// Small UI primitives shared by every mode.

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
export { cx }

type Variant = 'ghost' | 'outline' | 'accent' | 'subtle'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  active?: boolean
  size?: 'sm' | 'md'
}

const VARIANTS: Record<Variant, string> = {
  ghost: 'text-muted hover:text-fg hover:bg-hover',
  subtle: 'text-fg bg-raised hover:bg-hover border border-line',
  outline: 'text-fg border border-line-strong hover:bg-hover',
  accent: 'text-accent-ink bg-accent hover:bg-accent-bright font-semibold shadow-[0_0_0_1px_rgba(94,234,212,0.25),0_6px_20px_-8px_rgba(45,212,191,0.6)]'
}

export function Button({ variant = 'ghost', active, size = 'md', className, children, ...rest }: ButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={cx(
        'no-drag inline-flex items-center gap-1.5 rounded-md whitespace-nowrap transition-colors duration-150 outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 disabled:pointer-events-none',
        size === 'sm' ? 'h-7 px-2 text-[12px]' : 'h-8 px-2.5 text-[12.5px]',
        VARIANTS[variant],
        active && 'bg-press text-fg',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function IconButton({ className, children, ...rest }: ButtonProps): React.JSX.Element {
  return (
    <Button className={cx('!px-0 w-7 justify-center', className)} size="sm" {...rest}>
      {children}
    </Button>
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-line-strong bg-panel px-1.5 py-px font-mono text-[10.5px] text-faint">{children}</kbd>
  )
}

interface PopoverProps {
  button: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'start' | 'end'
  width?: number
  testId?: string
}

/** A click-to-open panel anchored under its button. Closes on outside click or Escape. */
export function Popover({ button, children, align = 'start', width = 260, testId }: PopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative no-drag">
      {button({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          data-testid={testId}
          style={{ width }}
          className={cx(
            'absolute top-[calc(100%+6px)] z-50 rounded-xl border border-line-strong bg-raised/95 p-1.5 backdrop-blur-xl',
            'shadow-[0_18px_50px_-12px_rgba(0,0,0,0.75)] animate-pop-in origin-top',
            align === 'end' ? 'right-0' : 'left-0'
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  icon,
  label,
  hint,
  onClick,
  disabled,
  danger
}: {
  icon?: ReactNode
  label: ReactNode
  hint?: ReactNode
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors',
        'hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent',
        danger ? 'text-st-failed' : 'text-fg'
      )}
    >
      {icon && <span className="flex w-5 justify-center text-muted">{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </button>
  )
}

export function MenuLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-faint">{children}</div>
}

export function MenuDivider(): React.JSX.Element {
  return <div className="my-1 h-px bg-line" />
}
