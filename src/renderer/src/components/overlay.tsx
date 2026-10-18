// Shared frames for overlays: a centered dialog and a panel that slides in from the right.

import { useEffect, type ReactNode } from 'react'
import { Hammer, X } from 'lucide-react'
import { IconButton } from './ui'

function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
}

interface FrameProps {
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  testId?: string
}

/** Centered dialog. Scales in from 96% with a fade (180 ms). Escape or a click outside closes it. */
export function Modal({ title, subtitle, onClose, children, footer, width = 520, testId }: FrameProps): React.JSX.Element {
  useEscape(onClose)
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/45 pt-[12vh] backdrop-blur-[2px] animate-fade-in" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        data-testid={testId}
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[76vh] overflow-hidden rounded-2xl border border-line-strong bg-raised shadow-[0_30px_80px_-20px_rgba(0,0,0,0.85)] animate-dialog-in flex flex-col"
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
            {subtitle && <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{subtitle}</p>}
          </div>
          <IconButton onClick={onClose} aria-label="Close" title="Close">
            <X size={15} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-panel/60 px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

/** Panel that slides in from the right edge (250 ms). Escape or a click outside closes it. */
export function SlideOver({ title, subtitle, onClose, children, footer, width = 440, testId }: FrameProps): React.JSX.Element {
  useEscape(onClose)
  return (
    <div className="fixed inset-0 top-[50px] z-30 flex justify-end bg-black/25 animate-fade-in" onMouseDown={onClose}>
      <aside
        data-testid={testId}
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-full flex-col border-l border-line-strong bg-raised shadow-[-30px_0_80px_-30px_rgba(0,0,0,0.8)] animate-slide-in"
      >
        <div className="flex items-start gap-3 border-b border-line px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>}
          </div>
          <IconButton onClick={onClose} aria-label="Close" title="Close">
            <X size={15} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex items-center gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </aside>
    </div>
  )
}

/** Placeholder body for features whose package has not landed yet. */
export function NotBuiltYet({ feature }: { feature: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <Hammer size={20} className="text-faint" />
      <p className="text-[12.5px] text-muted">{feature} is being built.</p>
    </div>
  )
}
