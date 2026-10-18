// The card beside the preview: before and after, the changed files of every round, the checks the user
// starts by hand, and the keep, undo, refine and stop controls.

import { useEffect, useState } from 'react'
import { Check, Loader2, RotateCcw, Trash2, Wand2, X } from 'lucide-react'
import type { CheckSpec } from '@shared/heats'
import type { SpotFix } from '@shared/spotfix'
import { bridge } from '../../../lib/bridge'
import { Button, IconButton, cx } from '../../../components/ui'
import {
  canStopSpotFix,
  changedFilesAcrossRounds,
  checkCommandsOf,
  checkDefinitionConflicts,
  detectedChecksFor,
  runsChangedCode,
  unfinishedRounds
} from './checkFlow'

export interface SpotFixCardProps {
  fix: SpotFix
  /** Why main refused the last card action, or empty. */
  error?: string
  onKeep: () => void
  onUndo: () => void
  onRefine: (note: string) => void
  onStop: () => void
  onRemove: () => void
  onClose: () => void
}

export function SpotFixCard({ fix, error, onKeep, onUndo, onRefine, onStop, onRemove, onClose }: SpotFixCardProps): React.JSX.Element {
  const [before, setBefore] = useState<string | null>(null)
  const [after, setAfter] = useState<string | null>(null)
  const [confirmUndo, setConfirmUndo] = useState(false)
  const [refining, setRefining] = useState(false)
  const [refineNote, setRefineNote] = useState('')
  // Checks run only when the user asks: the button lists the exact commands first, and because the fix
  // changed files the checks will execute, the first click shows them and the second one runs (finding 2).
  const [specs, setSpecs] = useState<CheckSpec[] | null>(null)
  const [armed, setArmed] = useState(false)
  const [checkError, setCheckError] = useState('')

  // Read the screenshots back whenever the record says one exists.
  useEffect(() => {
    let live = true
    void (async () => {
      const url = fix.hasBefore ? await bridge.invoke('spotfix:image', fix.id, 'before') : null
      if (live) setBefore(url)
    })()
    return () => {
      live = false
    }
  }, [fix.id, fix.hasBefore])

  useEffect(() => {
    let live = true
    void (async () => {
      const url = fix.hasAfter ? await bridge.invoke('spotfix:image', fix.id, 'after') : null
      if (live) setAfter(url)
    })()
    return () => {
      live = false
    }
  }, [fix.id, fix.hasAfter])

  const agentRoundsCount = fix.rounds.filter((r) => r.kind !== 'checks').length

  // A new agent round reopens the question; the previous listing does not carry over.
  useEffect(() => {
    setSpecs(null)
    setArmed(false)
    setCheckError('')
  }, [agentRoundsCount])

  const busy = canStopSpotFix(fix.status)
  const files = changedFilesAcrossRounds(fix)
  const noStep = unfinishedRounds(fix)
  const checks = fix.rounds[fix.rounds.length - 1]?.checks ?? []
  const lastAgentRound = [...fix.rounds].reverse().find((r) => r.kind !== 'checks')
  const lastError = fix.rounds[fix.rounds.length - 1]?.error ?? lastAgentRound?.error
  const undoResults = fix.undo ?? []

  const askChecks = async (): Promise<void> => {
    // The definitions come from fix.cwd as the files are now, never from the current workspace root.
    try {
      const latest = await bridge.invoke('spotfix:list')
      setSpecs(detectedChecksFor(fix, latest))
      setArmed(false)
      setCheckError('')
    } catch {
      if (fix.detectedChecks) {
        setSpecs(detectedChecksFor(fix))
        setArmed(false)
        setCheckError('')
      } else {
        setCheckError('Could not read the project checks.')
      }
    }
  }

  const conflicts = specs ? checkDefinitionConflicts(specs, files.map((f) => f.path)) : []
  const needsSecondClick = runsChangedCode(fix) && !armed

  const startChecks = async (): Promise<void> => {
    if (needsSecondClick) {
      setArmed(true)
      return
    }
    try {
      await bridge.invoke('spotfix:runChecks', fix.id)
      setCheckError('')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setCheckError(`Could not run the checks: ${message}`)
    }
  }

  const submitRefine = (): void => {
    const text = refineNote.trim()
    if (!text) return
    setRefining(false)
    setRefineNote('')
    onRefine(text)
  }

  return (
    <aside
      data-testid="spotfix-card"
      className="absolute inset-y-0 right-0 z-30 flex w-[320px] flex-col border-l border-line-strong bg-raised shadow-[-24px_0_60px_-24px_rgba(0,0,0,0.7)] animate-slide-in"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <StatusText status={fix.status} />
        <div className="flex-1" />
        {!busy && (
          <IconButton onClick={onRemove} aria-label="Remove" title="Remove this record" data-testid="spotfix-remove">
            <Trash2 size={13} />
          </IconButton>
        )}
        <IconButton onClick={onClose} aria-label="Close" title="Close">
          <X size={14} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-2">
          <figure className="m-0">
            <div className="overflow-hidden rounded-md border border-line bg-term">
              {before ? (
                <img data-testid="spotfix-before" src={before} alt="Before" className="block h-[120px] w-full object-cover object-top" />
              ) : (
                <div data-testid="spotfix-before" className="flex h-[120px] items-center justify-center px-2 text-center text-[11px] text-faint">
                  No screenshot
                </div>
              )}
            </div>
            <figcaption className="mt-1 text-[11px] text-faint">Before</figcaption>
          </figure>
          <figure className="m-0">
            <div className="overflow-hidden rounded-md border border-line bg-term">
              {after ? (
                <img data-testid="spotfix-after" src={after} alt="After" className="block h-[120px] w-full object-cover object-top" />
              ) : (
                <div data-testid="spotfix-after" className="flex h-[120px] items-center justify-center px-2 text-center text-[11px] text-faint">
                  {busy ? 'working…' : 'No screenshot'}
                </div>
              )}
            </div>
            <figcaption className="mt-1 text-[11px] text-faint">After</figcaption>
          </figure>
        </div>

        {busy && fix.latest && (
          <p data-testid="spotfix-latest" className="mt-2 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted">
            <Loader2 size={12} className="shrink-0 animate-spin" />
            <span className="truncate">{fix.latest}</span>
          </p>
        )}

        {lastError && !busy && <p className="mt-2 rounded-md bg-st-failed/10 px-2 py-1.5 text-[11.5px] text-st-failed">{lastError}</p>}

        {error && (
          <p data-testid="spotfix-error" className="mt-2 rounded-md bg-st-failed/10 px-2 py-1.5 text-[11.5px] text-st-failed">
            {error}
          </p>
        )}

        {noStep.length > 0 && !busy && (
          <p data-testid="spotfix-no-step" className="mt-2 rounded-md bg-st-waiting/10 px-2 py-1.5 text-[11.5px] text-st-waiting">
            Cannot be undone: the round did not finish.
          </p>
        )}

        <SectionLabel>Changed files</SectionLabel>
        {files.length === 0 ? (
          <p className="text-[12px] text-faint">Nothing yet.</p>
        ) : (
          <ul data-testid="spotfix-files" className="mt-1 space-y-0.5">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 font-mono text-[11.5px]">
                <span className="min-w-0 flex-1 truncate text-fg" title={f.path}>
                  {f.path}
                </span>
                <span className="text-st-idle">+{f.added}</span>
                <span className="text-st-failed">-{f.removed}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Checks: nothing ran on its own. The user opens the list, reads it, and starts them here. */}
        {checks.length > 0 && (
          <>
            <SectionLabel>Checks</SectionLabel>
            <ul data-testid="spotfix-check-results" className="mt-1 space-y-0.5">
              {checks.map((c, i) => (
                <li key={`${c.name}-${i}`} className="flex items-center gap-1.5 text-[11.5px]">
                  {c.passed ? <Check size={12} className="text-st-idle" /> : <X size={12} className="text-st-failed" />}
                  <span className={c.passed ? 'text-muted' : 'text-st-failed'}>{c.name}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {!busy && fix.status !== 'undone' && (
          <div className="mt-3">
            {specs === null ? (
              <Button variant="subtle" size="sm" onClick={() => void askChecks()} data-testid="spotfix-run-checks">
                Run checks
              </Button>
            ) : (
              <div className="rounded-lg border border-line-strong bg-panel p-2.5">
                <SectionLabel>Checks to run</SectionLabel>
                {specs.length === 0 ? (
                  <p className="text-[12px] text-faint">No checks were found in this project.</p>
                ) : (
                  <ul data-testid="spotfix-check-commands" className="mt-1 space-y-0.5 font-mono text-[11px] text-muted">
                    {checkCommandsOf(specs).map((line) => (
                      <li key={line} className="truncate" title={line}>
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
                {files.length > 0 && (
                  <div
                    data-testid="spotfix-checks-note"
                    className="mt-2 rounded-md bg-st-waiting/10 px-2 py-1.5 text-[11.5px] text-st-waiting"
                  >
                    <p>Checks run code from your project, including files this Spot fix changed:</p>
                    <ul data-testid="spotfix-checks-changed" className="mt-1 max-h-24 overflow-y-auto font-mono text-[11px]">
                      {files.map((f) => (
                        <li key={f.path} className="truncate" title={f.path}>
                          {f.path}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {conflicts.length > 0 && (
                  <p data-testid="spotfix-checks-warning" className="mt-2 rounded-md bg-st-waiting/10 px-2 py-1.5 text-[11.5px] text-st-waiting">
                    The agent changed {conflicts.join(', ')}, which defines the checks above. Read it before running them.
                  </p>
                )}
                {checkError && (
                  <p data-testid="spotfix-checks-error" className="mt-2 rounded-md bg-st-failed/10 px-2 py-1.5 text-[11.5px] text-st-failed">
                    {checkError}
                  </p>
                )}
                {specs.length > 0 && (
                  <div className="mt-2 flex justify-end">
                    <Button
                      variant={needsSecondClick ? 'subtle' : 'accent'}
                      size="sm"
                      onClick={() => void startChecks()}
                      data-testid="spotfix-checks-run"
                    >
                      {needsSecondClick ? 'Run anyway' : 'Run'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {undoResults.length > 0 && (
          <>
            <SectionLabel>Undo</SectionLabel>
            {fix.undoNote && (
              <p data-testid="spotfix-undo-note" className="mt-1 rounded-md bg-st-waiting/10 px-2 py-1.5 text-[11.5px] text-st-waiting">
                {fix.undoNote}
              </p>
            )}
            <ul data-testid="spotfix-undo-result" className="mt-1 space-y-0.5">
              {undoResults.flatMap((r) =>
                r.files.map((f) => (
                  <li key={`${r.stepId}-${f.path}`} className="flex items-center gap-2 font-mono text-[11.5px]">
                    <span className="min-w-0 flex-1 truncate text-fg" title={f.path}>
                      {f.path}
                    </span>
                    {f.action === 'kept' ? (
                      <span data-testid="spotfix-kept-badge" className="rounded bg-st-waiting/15 px-1 text-[10.5px] text-st-waiting" title={f.note}>
                        kept: {f.note || 'you edited it since'}
                      </span>
                    ) : (
                      <span className="text-[10.5px] text-faint">{f.action}</span>
                    )}
                  </li>
                ))
              )}
            </ul>
            {undoResults.some((r) => r.refused) && (
              <p data-testid="spotfix-undo-refused" className="mt-1 text-[11.5px] text-st-failed">
                {undoResults.map((r) => r.refused).filter((x): x is string => Boolean(x)).join(' ')}
              </p>
            )}
          </>
        )}

        {confirmUndo && (
          <div className="mt-3 rounded-lg border border-line-strong bg-panel p-2.5">
            <p className="text-[12px] text-fg">Rewind these files to how they were before this spot fix?</p>
            <ul className="mt-1.5 max-h-24 overflow-y-auto font-mono text-[11px] text-muted">
              {files.map((f) => (
                <li key={f.path} className="truncate">
                  {f.path}
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmUndo(false)} data-testid="spotfix-undo-cancel">
                Keep them
              </Button>
              <Button
                variant="subtle"
                size="sm"
                onClick={() => {
                  setConfirmUndo(false)
                  onUndo()
                }}
                data-testid="spotfix-undo-confirm"
              >
                Undo
              </Button>
            </div>
          </div>
        )}

        {refining && fix.status === 'review' && (
          <div className="mt-3">
            <label className="block text-[11.5px] text-muted" htmlFor="spotfix-refine-note">
              What else should change?
            </label>
            <textarea
              id="spotfix-refine-note"
              data-testid="spotfix-refine-note"
              value={refineNote}
              onChange={(e) => setRefineNote(e.target.value)}
              rows={2}
              autoFocus
              className="mt-1 w-full resize-none rounded-md border border-line bg-term px-2 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/50"
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRefining(false)}>
                Cancel
              </Button>
              <Button variant="accent" size="sm" onClick={submitRefine} disabled={!refineNote.trim()} data-testid="spotfix-refine-send">
                Refine
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
        {busy ? (
          <>
            <Button variant="subtle" size="sm" onClick={onStop} data-testid="spotfix-stop">
              <X size={13} />
              Stop
            </Button>
            {fix.status === 'checking' && <span className="text-[12px] text-muted">Running the checks you asked for.</span>}
          </>
        ) : fix.status === 'review' ? (
          <>
            <Button variant="accent" size="sm" onClick={onKeep} data-testid="spotfix-keep">
              <Check size={13} />
              Keep
            </Button>
            <Button variant="subtle" size="sm" onClick={() => setConfirmUndo(true)} data-testid="spotfix-undo">
              <RotateCcw size={13} />
              Undo
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRefining((r) => !r)} data-testid="spotfix-refine">
              <Wand2 size={13} />
              Refine
            </Button>
          </>
        ) : fix.status === 'kept' ? (
          <span className="text-[12px] text-muted">Kept as it is.</span>
        ) : fix.status === 'undone' ? (
          <span className="text-[12px] text-muted">{fix.undoNote ? 'Undo stopped part way.' : 'Undone.'}</span>
        ) : (
          <>
            <Button variant="subtle" size="sm" onClick={() => setConfirmUndo(true)} data-testid="spotfix-undo">
              <RotateCcw size={13} />
              Undo
            </Button>
          </>
        )}
      </div>
    </aside>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mt-3 mb-0.5 text-[11px] font-medium text-faint">{children}</div>
}

const STATUS: Record<SpotFix['status'], { label: string; color: string }> = {
  running: { label: 'Working', color: 'text-accent' },
  checking: { label: 'Running checks', color: 'text-accent' },
  review: { label: 'Ready for review', color: 'text-fg' },
  kept: { label: 'Kept', color: 'text-st-idle' },
  undone: { label: 'Undone', color: 'text-muted' },
  stopped: { label: 'Stopped', color: 'text-st-waiting' },
  error: { label: 'Error', color: 'text-st-failed' }
}

function StatusText({ status }: { status: SpotFix['status'] }): React.JSX.Element {
  const s = STATUS[status]
  return (
    <span data-testid="spotfix-status" className={cx('inline-flex items-center gap-1.5 text-[12.5px] font-semibold', s.color)}>
      {status === 'running' || status === 'checking' ? <Loader2 size={13} className="animate-spin" /> : null}
      {s.label}
    </span>
  )
}
