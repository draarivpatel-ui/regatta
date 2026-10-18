import { useMemo } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { GitDiff } from '@shared/types'
import { Button, cx } from '../../components/ui'
import { parseDiff, diffTitle, type DiffRow } from './diffLines'

interface GitDiffViewProps {
  diff: GitDiff
  onBack: () => void
}

const ROW_CLASS: Record<DiffRow['kind'], string> = {
  add: 'bg-st-idle/10 text-st-idle',
  del: 'bg-st-failed/10 text-st-failed',
  ctx: 'text-fg',
  hunk: 'text-[11px] text-faint',
  note: 'text-faint italic'
}

export function GitDiffView({ diff, onBack }: GitDiffViewProps): React.JSX.Element {
  const rows = useMemo(() => (diff.binary || diff.tooLarge ? [] : parseDiff(diff.text)), [diff])
  const title = useMemo(() => diffTitle(diff.path, diff.text), [diff.path, diff.text])
  // "No changes" is shown when there are no diff rows; raw header lines are never shown.
  const empty = !diff.binary && !diff.tooLarge && (diff.text.trim() === '' || rows.length === 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="git-diff">
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-line bg-panel/60 px-3">
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="git-diff-back" aria-label="Back">
          <ArrowLeft size={14} />
        </Button>
        <span className="flex-1 truncate font-mono text-[12.5px] text-fg" data-testid="git-diff-path">
          {title}
        </span>
        <span
          className={cx(
            'shrink-0 rounded px-2 py-0.5 text-[11px] font-medium',
            diff.staged ? 'bg-accent/20 text-accent' : 'bg-st-working/20 text-st-working'
          )}
        >
          {diff.staged ? 'Staged' : 'Not staged'}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-term py-2 font-mono text-[12px] leading-[1.5]">
        {diff.binary && <p className="px-3 italic text-faint">This is a binary file, so no diff is shown.</p>}
        {diff.tooLarge && <p className="px-3 italic text-faint">This diff is over 1 MB, so it is not shown.</p>}
        {empty && <p className="px-3 italic text-faint">No changes.</p>}
        {rows.length > 0 && (
          <div data-testid="git-diff-lines" className="w-max min-w-full">
            {rows.map((row, i) => (
              <div key={i} className={cx('flex', ROW_CLASS[row.kind])} data-kind={row.kind}>
                <span data-testid="git-diff-old" className="w-10 shrink-0 select-none pr-2 text-right text-faint/70">
                  {row.oldNo ?? ''}
                </span>
                <span data-testid="git-diff-new" className="w-10 shrink-0 select-none pr-2 text-right text-faint/70">
                  {row.newNo ?? ''}
                </span>
                <span className="w-4 shrink-0 select-none text-center">
                  {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''}
                </span>
                <span className="whitespace-pre pr-3">{row.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
