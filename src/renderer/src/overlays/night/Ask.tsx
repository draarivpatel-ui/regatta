// A question asked in place before something that cannot be undone: the answer is two buttons.
// It replaces window.confirm, which blocks the whole window, cannot be seen in a screenshot, and is dismissed
// by a test driver without anyone answering it.

import { useEffect, useRef } from 'react'
import { Button, cx } from '../../components/ui'

export function Ask({
  testId,
  text,
  confirmLabel,
  confirmTestId,
  danger,
  busy,
  onConfirm,
  onCancel
}: {
  testId: string
  text: string
  confirmLabel: string
  confirmTestId: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  // The question comes up at the bottom of a long card: bring all of it, buttons included, into view.
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest' })
  }, [])
  return (
    <div
      ref={box}
      role="group"
      aria-label={text}
      data-testid={testId}
      className="rounded-lg border border-line-strong bg-raised p-3 animate-fade-up"
    >
      <p className="text-[12.5px] leading-relaxed">{text}</p>
      <div className="mt-3 flex gap-2">
        <Button
          variant={danger ? 'outline' : 'accent'}
          size="sm"
          data-testid={confirmTestId}
          disabled={busy}
          // Focus lands on the safe answer: Merge can be undone with git, Discard and Stop cannot.
          autoFocus={!danger}
          className={cx(danger && 'border-st-failed/40 text-st-failed hover:bg-st-failed/10')}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
        <Button variant="ghost" size="sm" data-testid="night-ask-cancel" autoFocus={danger} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
