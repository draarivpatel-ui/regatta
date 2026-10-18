import { useCallback, useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { bridge } from '../../lib/bridge'
import type { GitOverview } from '@shared/types'
import { Button } from '../../components/ui'
import { cleanError } from './errors'

interface GitCommitBoxProps {
  /** The folder this box commits in. The panel gives the box a new key when the folder changes. */
  folder: string
  overview: GitOverview
  /** Called after a commit went through, so the lists and the history can refresh. */
  onCommitted: () => void
}

const isStaged = (letter: string): boolean => letter !== ' ' && letter !== '?'

/**
 * The commit box stays mounted while the lists refresh, so a message being typed and a commit in
 * flight are never lost to a refresh. The ref is the real guard against a second commit; the state
 * only drives what is drawn.
 */
export function GitCommitBox({ folder, overview, onCommitted }: GitCommitBoxProps): React.JSX.Element {
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const inFlight = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  const staged = overview.files.filter((f) => isStaged(f.staged))
  const stagedCount = staged.length
  const hooks = overview.hooks ?? []
  const canCommit = stagedCount > 0 && message.trim().length > 0 && !overview.busy && !committing && hooks.length === 0

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
    }
  }, [])

  const handleCommit = useCallback(async () => {
    if (inFlight.current || !canCommit) return
    inFlight.current = true
    setCommitting(true)
    setError(null)
    setSuccess(null)
    try {
      const expected = staged.map((f) => f.path)
      const commit = await bridge.invoke('git:commit', folder, message.trim(), expected)
      if (!alive.current) return
      setSuccess(`Committed ${commit.hash.slice(0, 7)}`)
      setMessage('')
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
      successTimerRef.current = setTimeout(() => setSuccess(null), 4000)
      onCommitted()
    } catch (err) {
      if (alive.current) setError(cleanError(err, 'The commit failed'))
    } finally {
      inFlight.current = false
      if (alive.current) {
        setCommitting(false)
        textareaRef.current?.focus()
      }
    }
  }, [canCommit, staged, folder, message, onCommitted])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleCommit()
    }
  }

  return (
    <div className="shrink-0 border-t border-line bg-panel/50 p-3" data-testid="git-commit-box">
      <textarea
        ref={textareaRef}
        data-testid="git-message"
        placeholder="Commit message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        className="h-20 min-h-[60px] w-full resize-none rounded-md border border-line bg-term px-3 py-2 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent"
        readOnly={committing}
        rows={3}
      />
      {hooks.length > 0 && (
        <p data-testid="git-hooks-notice" className="mt-2 text-[12px] text-st-waiting">
          This repository has git hooks ({hooks.join(', ')}). The Git panel does not run hooks yet, so commit from a terminal.
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        {error && (
          <span data-testid="git-commit-error" className="flex-1 text-[12px] text-st-failed">
            {error}
          </span>
        )}
        {success && (
          <span data-testid="git-commit-success" className="flex flex-1 items-center gap-1 text-[12px] text-st-idle">
            <Check size={12} />
            {success}
          </span>
        )}
        {!error && !success && <span className="flex-1" />}
        <Button data-testid="git-commit" variant="accent" size="sm" onClick={() => void handleCommit()} disabled={!canCommit}>
          {committing ? 'Committing…' : `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  )
}
