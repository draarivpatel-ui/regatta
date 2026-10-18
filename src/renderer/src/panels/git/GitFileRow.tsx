import type { MouseEvent } from 'react'
import type { GitFileChange } from '@shared/types'
import { Button, cx } from '../../components/ui'

interface GitFileRowProps {
  file: GitFileChange
  isStaged: boolean
  /** Staging is off (a hook would run), so the buttons are disabled. */
  indexLocked?: boolean
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onClick: () => void
  testId: string
}

const STATUS_COLORS: Record<string, string> = {
  M: 'text-st-working',
  A: 'text-st-idle',
  D: 'text-st-failed',
  R: 'text-accent',
  C: 'text-accent',
  U: 'text-st-waiting',
  '?': 'text-faint',
  ' ': 'text-faint'
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Conflict',
  '?': 'New file'
}

export function GitFileRow({ file, isStaged, indexLocked = false, onStage, onUnstage, onClick, testId }: GitFileRowProps): React.JSX.Element {
  const status = isStaged ? file.staged : file.unstaged
  const colorClass = STATUS_COLORS[status] ?? 'text-faint'
  const label = STATUS_LABELS[status] ?? status

  const parts = file.path.split('/')
  const name = parts.pop() ?? file.path
  const folder = parts.join('/')

  const handle = (action: (path: string) => void) => (e: MouseEvent) => {
    e.stopPropagation()
    action(file.path)
  }

  return (
    <div
      data-testid={testId}
      className={cx(
        'group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-hover'
      )}
      onClick={onClick}
      title={file.from && isStaged ? `Renamed from ${file.from}` : file.path}
    >
      <span className={cx('w-5 shrink-0 text-center font-mono text-[11.5px]', colorClass)} title={label}>
        {status}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{name}</span>
      {folder && <span className="max-w-[40%] shrink truncate font-mono text-[11px] text-faint">{folder}/</span>}
      <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {isStaged ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handle(onUnstage)}
            disabled={indexLocked}
            data-testid={`git-unstage-${file.path}`}
            title="Unstage"
            aria-label={`Unstage ${file.path}`}
          >
            −
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={handle(onStage)}
            disabled={indexLocked}
            data-testid={`git-stage-${file.path}`}
            title="Stage"
            aria-label={`Stage ${file.path}`}
          >
            +
          </Button>
        )}
      </div>
    </div>
  )
}
