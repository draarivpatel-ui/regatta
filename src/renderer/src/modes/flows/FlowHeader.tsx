// The top of the studio: the flow's name (click to rename), whether it is saved, delete and Run flow.

import { useEffect, useState } from 'react'
import { Play, Trash2 } from 'lucide-react'
import type { Flow } from '@shared/flows'
import { Button, IconButton, cx } from '../../components/ui'

interface FlowHeaderProps {
  flow: Flow
  /** Absent when saved. */
  saveState: 'saving' | 'error' | undefined
  /** The engine's sentence when it refused the save. */
  saveError: string | undefined
  onRename: (name: string) => void
  onDelete: () => void
  onRun: () => void
  runDisabled: boolean
}

export function FlowHeader({ flow, saveState, saveError, onRename, onDelete, onRun, runDisabled }: FlowHeaderProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(flow.name)

  useEffect(() => {
    setEditing(false)
    setDraft(flow.name)
  }, [flow.id, flow.name])

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    // The engine refuses a flow without a name, so an empty name puts the old one back.
    if (next && next !== flow.name) onRename(next)
    else setDraft(flow.name)
  }

  const label = saveState === 'saving' ? 'Saving…' : saveState === 'error' ? `Not saved${saveError ? `: ${saveError}` : ''}` : 'Saved'

  return (
    <header data-testid="flow-header" className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-chrome/60 px-6 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {editing ? (
          <input
            data-testid="flow-name-input"
            aria-label="Flow name"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') {
                setEditing(false)
                setDraft(flow.name)
              }
            }}
            className="min-w-0 max-w-[420px] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1 text-[15px] font-semibold tracking-[-0.01em] text-fg outline-none focus:border-accent/60"
          />
        ) : (
          <button
            type="button"
            data-testid="flow-name"
            title="Click to rename"
            onClick={() => setEditing(true)}
            className="min-w-0 max-w-[50%] shrink-0 truncate text-left text-[15px] font-semibold tracking-[-0.01em] text-fg transition-colors duration-150 hover:text-accent-bright"
          >
            {flow.name}
          </button>
        )}
        <span
          data-testid="flow-save-state"
          data-state={saveState ?? 'saved'}
          title={saveError}
          className={cx('min-w-0 truncate text-[11.5px]', saveState === 'error' ? 'text-st-waiting' : 'text-faint')}
        >
          {label}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <IconButton data-testid="flow-delete" title="Delete this flow" aria-label="Delete this flow" onClick={onDelete}>
          <Trash2 size={14} />
        </IconButton>
        <Button variant="accent" data-testid="flow-run" disabled={runDisabled} onClick={onRun}>
          <Play size={13} fill="currentColor" />
          Run flow
        </Button>
      </div>
    </header>
  )
}
