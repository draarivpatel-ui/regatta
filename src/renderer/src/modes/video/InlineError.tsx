// The error main last sent back for a Video action, shown at the top of the tab where it happened.

import { X } from 'lucide-react'
import { useVideo } from '../../store/video'

export function InlineError(): React.JSX.Element | null {
  const error = useVideo((s) => s.error)
  const clear = useVideo((s) => s.clearError)
  if (!error) return null
  return (
    <p
      role="alert"
      data-testid="video-error"
      className="flex shrink-0 items-start justify-between gap-2 rounded-lg border border-st-failed/40 bg-st-failed/10 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-st-failed"
    >
      <span className="min-w-0 flex-1">{error}</span>
      <button type="button" onClick={clear} className="mt-0.5 shrink-0 text-muted transition-colors hover:text-fg" aria-label="Dismiss">
        <X size={12} />
      </button>
    </p>
  )
}
