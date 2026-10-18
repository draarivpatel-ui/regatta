// One leftover worktree row in Settings > Storage.
// A removable row has a checkbox. A kept row has none: it shows why it is kept and lets the user
// look at it (Show in Finder) or copy the command to remove it themselves. Nothing here forces anything.

import { useEffect, useRef, useState } from 'react'
import { Check, Copy, FolderOpen, Lock } from 'lucide-react'
import type { LeftoverWorktree } from '@shared/types'
import { basename } from '../../../lib/format'
import { Button, cx } from '../../../components/ui'
import { bytesLabel, changedLabel, removeCommand } from './labels'

export function LeftoverRow({
  leftover,
  index,
  checked,
  now,
  disabled,
  onToggle,
  onReveal
}: {
  leftover: LeftoverWorktree
  index: number
  checked: boolean
  now: number
  disabled: boolean
  onToggle: (next: boolean) => void
  onReveal: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const repo = leftover.repo
  const copy = (): void => {
    if (repo === null) return
    try {
      void navigator.clipboard
        ?.writeText(removeCommand(repo, leftover.path))
        .then(() => {
          setCopied(true)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setCopied(false), 1500)
        })
        .catch(() => undefined)
    } catch {
      // No clipboard here; nothing else to do.
    }
  }

  return (
    <div
      data-testid="storage-leftover"
      data-path={leftover.path}
      data-removable={String(leftover.removable)}
      className={cx(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors',
        leftover.removable && checked ? 'border-accent/50 bg-press' : 'border-line bg-panel'
      )}
    >
      <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {leftover.removable ? (
          <input
            type="checkbox"
            data-testid={`storage-select-${index}`}
            aria-label={`Select ${basename(leftover.path)}`}
            checked={checked}
            disabled={disabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
        ) : (
          <Lock size={13} className="text-faint" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[12.5px]">{basename(leftover.path)}</span>
        <p className="mt-0.5 truncate text-[11.5px] text-muted">
          {repo ? basename(repo) : 'unknown repository'}
          {leftover.branch ? ` on ${leftover.branch}` : repo ? ' (no branch checked out)' : ''}
        </p>
        <p className="mt-0.5 text-[11.5px] text-faint">
          {bytesLabel(leftover.bytes)} · {changedLabel(leftover.changedAt, now)}
        </p>
        {!leftover.removable && (
          <>
            {leftover.reason && (
              <p data-testid="storage-leftover-reason" className="mt-1.5 text-[11.5px] leading-relaxed text-st-waiting">
                {leftover.reason}
              </p>
            )}
            <div className="-ml-2 mt-1 flex items-center gap-0.5">
              <Button variant="ghost" size="sm" data-testid="storage-leftover-reveal" onClick={onReveal}>
                <FolderOpen size={12} />
                Show in Finder
              </Button>
              {repo !== null && (
                <Button variant="ghost" size="sm" data-testid="storage-leftover-copy" onClick={copy}>
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? 'Copied' : 'Copy command'}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
