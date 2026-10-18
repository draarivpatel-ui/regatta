// A small button that puts one piece of text on the clipboard and says so for a moment.

import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cx } from '../../components/ui'

export function CopyButton({
  text,
  label,
  testId,
  title,
  className
}: {
  text: string
  /** Words next to the icon. Without them the button is just the icon. */
  label?: string
  testId?: string
  title?: string
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = (): void => {
    try {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => {
          setCopied(true)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setCopied(false), 1500)
        })
        .catch(() => undefined)
    } catch {
      // No clipboard here; the text on screen can still be selected.
    }
  }

  return (
    <button
      type="button"
      data-testid={testId}
      data-copied={copied ? 'true' : 'false'}
      onClick={copy}
      title={title ?? (label ? undefined : 'Copy')}
      aria-label={label ? undefined : (title ?? 'Copy')}
      className={cx(
        'no-drag inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted outline-none',
        'transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50',
        className
      )}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {label && <span>{copied ? 'Copied' : label}</span>}
    </button>
  )
}
