// Regatta's trash block in Settings > Storage: lists retired worktrees in .regatta-trash and lets
// the user empty the trash after one confirmation.

import { FolderOpen, Trash2 } from 'lucide-react'
import type { EmptyTrashEntryReport, TrashEntry } from '@shared/types'
import { basename } from '../../../lib/format'
import { Button } from '../../../components/ui'
import { movedLabel, upToBytesLabel } from './labels'

const ALTERED_ENTRY_STATE = 'altered, left alone'
const MOVED_OUT_ENTRY_STATE = 'moved out of the trash; Regatta leaves it and its git records alone'

function specialEntryState(entry: TrashEntry): string | null {
  const reason = entry.repairError ?? null
  if (reason === ALTERED_ENTRY_STATE || reason === MOVED_OUT_ENTRY_STATE) return reason
  return null
}

function changedSinceMovedText(state: TrashEntry['changedSinceMoved']): string {
  if (state === 'yes') return 'changed since moved (by modification time)'
  if (state === 'unknown') return 'could not check every file'
  return 'unchanged since moved (by modification time)'
}

export function TrashBlock({
  trash,
  now,
  scanning,
  emptying,
  showConfirm,
  emptyError,
  outcomes,
  onOpenConfirm,
  onCancelConfirm,
  onConfirmEmpty,
  onReveal
}: {
  trash: TrashEntry[]
  now: number
  scanning: boolean
  emptying: boolean
  showConfirm: boolean
  emptyError: string | null
  outcomes: EmptyTrashEntryReport[] | null
  onOpenConfirm: () => void
  onCancelConfirm: () => void
  onConfirmEmpty: () => void
  onReveal: (path: string) => void
}): React.JSX.Element {
  const toDelete = trash.filter((entry) => entry.inUse.length === 0 && specialEntryState(entry) === null)
  const toSkip = trash.filter((entry) => entry.inUse.length > 0 || specialEntryState(entry) !== null)

  return (
    <div className="mt-5" data-testid="storage-trash">
      <h4 className="text-[13px] font-medium">Regatta&apos;s trash</h4>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-faint" data-testid="storage-trash-note">
        Retired lane worktrees stay here with their branches until you empty the trash. Changed since moved (by modification time) skips the provided node_modules copy.
      </p>

      {trash.length === 0 && !scanning && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted" data-testid="storage-trash-empty">
          Trash is empty.
        </p>
      )}

      {trash.length > 0 && (
        <>
          <div className="mt-2 space-y-1.5" data-testid="storage-trash-list">
            {trash.map((entry) => {
              const errText = entry.lastEmptyError ?? entry.emptyError ?? null
              const specialState = specialEntryState(entry)
              return (
                <div
                  key={entry.entryPath}
                  data-testid="storage-trash-entry"
                  data-entry-id={entry.entryId}
                  data-original-path={entry.originalPath}
                  data-trash-path={entry.trashPath}
                  className="rounded-lg border border-line bg-panel px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12.5px]">{basename(entry.originalPath)}</span>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-faint" data-testid="storage-trash-original-path">
                        {entry.originalPath}
                      </p>
                      <p className="mt-0.5 truncate text-[11.5px] text-muted">
                        {entry.branch ? `on ${entry.branch}` : '(no branch checked out)'}
                        {' · '}
                        {specialState
                          ? specialState
                          : entry.repaired
                            ? 'repaired'
                            : `not repaired${entry.repairError ? ` (${entry.repairError})` : ''}`}
                      </p>
                      <p className="mt-0.5 text-[11.5px] text-faint">
                        {upToBytesLabel(entry.bytes)} · {movedLabel(entry.movedAt, now)} · {changedSinceMovedText(entry.changedSinceMoved)}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" data-testid="storage-trash-reveal" onClick={() => onReveal(entry.trashPath)}>
                      <FolderOpen size={12} />
                      Show in Finder
                    </Button>
                  </div>

                  {specialState && (
                    <p data-testid="storage-trash-state" className="mt-1.5 text-[11.5px] leading-relaxed text-st-waiting">
                      {specialState}. Emptying the trash will skip this entry.
                    </p>
                  )}

                  {entry.inUse.length > 0 && (
                    <p data-testid="storage-trash-in-use" className="mt-1.5 text-[11.5px] leading-relaxed text-st-waiting">
                      In use by {entry.inUse.join(', ')}. Emptying the trash will skip this entry.
                    </p>
                  )}

                  {errText && (
                    <p data-testid="storage-trash-error" className="mt-1.5 text-[11.5px] leading-relaxed text-st-failed">
                      {errText}
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-2.5 flex items-center gap-1.5">
            <Button
              variant="subtle"
              size="sm"
              data-testid="storage-empty-trash"
              onClick={onOpenConfirm}
              disabled={emptying}
            >
              <Trash2 size={12} />
              Empty trash
            </Button>
          </div>

          {showConfirm && (
            <div data-testid="storage-empty-trash-confirm-panel" className="mt-3 rounded-lg border border-line-strong bg-raised px-3 py-2.5">
              <p className="text-[12.5px] font-medium">Empty Regatta&apos;s trash?</p>
              {toDelete.length > 0 ? (
                <div className="mt-1.5 text-[12px] text-muted" data-testid="storage-empty-trash-will-delete">
                  <span>Will delete ({toDelete.length}): </span>
                  <span className="font-mono">
                    {toDelete.map((e) => `${basename(e.originalPath)}${e.branch ? ` (${e.branch})` : ''}`).join(', ')}
                  </span>
                </div>
              ) : (
                <p className="mt-1.5 text-[12px] text-muted" data-testid="storage-empty-trash-will-delete">
                  Nothing will be deleted because every entry is currently in use or left alone.
                </p>
              )}

              {toSkip.length > 0 && (
                <div className="mt-1 text-[12px] text-st-waiting" data-testid="storage-empty-trash-will-skip">
                  <span>Will skip ({toSkip.length}): </span>
                  <span className="font-mono">
                    {toSkip
                      .map((e) => {
                        const why = e.inUse.length > 0 ? e.inUse.join(', ') : (specialEntryState(e) ?? 'skipped')
                        return `${basename(e.originalPath)} (${why})`
                      })
                      .join(', ')}
                  </span>
                </div>
              )}

              {emptyError && <p className="mt-2 text-[12px] text-st-failed">{emptyError}</p>}

              <div className="mt-2.5 flex items-center gap-1.5">
                <Button variant="accent" size="sm" data-testid="storage-empty-trash-confirm" onClick={onConfirmEmpty} disabled={emptying}>
                  {emptying ? 'Emptying' : 'Empty trash'}
                </Button>
                <Button variant="ghost" size="sm" data-testid="storage-empty-trash-cancel" onClick={onCancelConfirm} disabled={emptying}>
                  Keep
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {outcomes && outcomes.length > 0 && (
        <div className="mt-2 space-y-1 text-[12px] text-muted" data-testid="storage-empty-trash-result">
          {outcomes.map((o) => (
            <p key={o.entryPath} data-testid="storage-empty-trash-outcome">
              <span className="font-mono">{basename(o.originalPath)}</span>:{' '}
              {o.status === 'deleted'
                ? `Deleted folder${o.branchDeleted && o.branch ? ` and branch ${o.branch}` : ''}${o.keepRef ? ` (commits kept at ${o.keepRef})` : ''}.${o.reason ? ` ${o.reason}` : ''}`
                : (o.reason ?? o.status)}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
