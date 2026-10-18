// Checkpoints for one pane: roll back an agent step, then redo.

import { useCallback, useEffect, useState } from 'react'
import { RotateCcw, Undo2 } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import type { CheckpointStep, RollbackFile, RollbackResult } from '@shared/checkpoints'
import { bridge } from '../lib/bridge'
import { basename } from '../lib/format'
import { useSessions } from '../store/sessions'
import { useUi } from '../store/ui'
import { SlideOver } from '../components/overlay'
import { AgentBadge } from '../components/marks'
import { Button, cx } from '../components/ui'
import { fileLabel, viewResult, viewStep } from './checkpoints/state'

/** "3 files +21 -25" for a step or a result's file list. */
function totals(files: { added: number; removed: number }[]): string {
  const added = files.reduce((sum, f) => sum + f.added, 0)
  const removed = files.reduce((sum, f) => sum + f.removed, 0)
  const count = files.length === 1 ? '1 file' : `${files.length} files`
  return `${count} +${added} -${removed}`
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function ActionBadge({ file }: { file: RollbackFile }): React.JSX.Element {
  const tone =
    file.action === 'kept'
      ? file.error
        ? 'border-st-failed/40 text-st-failed'
        : 'border-st-waiting/40 text-st-waiting'
      : file.action === 'restored'
        ? 'border-st-idle/40 text-st-idle'
        : 'border-line-strong text-muted'
  return (
    <span className={cx('shrink-0 rounded-full border px-1.5 py-px text-[10.5px] font-medium', tone)}>
      {fileLabel(file)}
    </span>
  )
}

function FileRow({ file }: { file: RollbackFile | { path: string; added: number; removed: number } }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[12px]">
      <span className="min-w-0 flex-1 truncate font-mono text-fg" title={file.path}>
        {file.path}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-st-idle">+{file.added}</span>
      <span className="shrink-0 font-mono text-[11px] text-st-failed">-{file.removed}</span>
      {'action' in file && <ActionBadge file={file} />}
    </div>
  )
}

function StepRow({
  step,
  confirming,
  busy,
  onRollback,
  onConfirm,
  onCancel,
  onRedo,
  onRetry
}: {
  step: CheckpointStep
  confirming: boolean
  busy: boolean
  onRollback: () => void
  onConfirm: () => void
  onCancel: () => void
  onRedo: () => void
  onRetry: () => void
}): React.JSX.Element {
  const view = viewStep(step)
  return (
    <div data-testid="checkpoint-step" className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-fg" title={step.label}>
            {step.label}
          </p>
          <p className="mt-0.5 text-[11px] text-faint">
            {clockTime(step.endedAt)} · {totals(step.files)}
          </p>
        </div>
        {step.rolledBack && (
          <span className="mt-0.5 shrink-0 rounded-full border border-st-waiting/40 px-1.5 py-px text-[10.5px] font-medium text-st-waiting">
            {step.partial ? 'partly rolled back' : 'rolled back'}
          </span>
        )}
      </div>

      {view.blocked && (
        <p data-testid="checkpoint-blocked" className="mt-2 rounded-md border border-st-waiting/40 bg-st-waiting/[0.06] px-2 py-1.5 text-[11.5px] leading-relaxed text-st-waiting">
          <span className="font-medium">{view.blocked.heading}: </span>
          {view.blocked.text}
        </p>
      )}
      {view.partialNote && (
        <p data-testid="checkpoint-partial" className="mt-2 text-[11.5px] leading-relaxed text-st-waiting">
          {view.partialNote}
        </p>
      )}

      {step.files.length > 0 && (
        <div className="mt-2 border-t border-line pt-1.5">
          {step.files.map((f) => (
            <FileRow key={f.path} file={f} />
          ))}
        </div>
      )}

      {(view.canRollback || view.canRedo || view.canRetry) && (
        <div className="mt-1.5 flex items-center gap-2">
          {view.canRollback && (
            <Button variant="outline" size="sm" data-testid="checkpoint-rollback" disabled={busy} onClick={onRollback}>
              <RotateCcw size={13} />
              Roll back
            </Button>
          )}
          {view.canRetry && (
            <Button variant="outline" size="sm" data-testid="checkpoint-retry" disabled={busy} onClick={onRetry}>
              <RotateCcw size={13} />
              Retry
            </Button>
          )}
          {view.canRedo && (
            <Button variant="subtle" size="sm" data-testid="checkpoint-redo" disabled={busy} onClick={onRedo}>
              <Undo2 size={13} />
              Redo
            </Button>
          )}
        </div>
      )}

      {confirming && view.canRollback && (
        <div className="mt-2 rounded-lg border border-line-strong bg-panel/60 p-2.5">
          <p className="text-[12px] leading-relaxed text-muted">
            Roll back this step? The files it changed go back to how they were before it. Files you
            edited since are kept.
          </p>
          <div className="mt-2 border-t border-line pt-1.5">
            {step.files.map((f) => (
              <FileRow key={f.path} file={f} />
            ))}
          </div>
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" data-testid="checkpoint-cancel" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="accent" size="sm" data-testid="checkpoint-confirm" disabled={busy} onClick={onConfirm}>
              Roll back
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ResultCard({ result, busy, onRedo, onRetry }: { result: RollbackResult; busy: boolean; onRedo: () => void; onRetry: () => void }): React.JSX.Element {
  const view = viewResult(result)
  if (view.refusal) {
    return (
      <div data-testid="checkpoint-refused" className="mb-1 rounded-lg border border-st-waiting/40 bg-st-waiting/[0.06] px-3 py-2.5">
        <p className="text-[12.5px] font-medium text-fg">Nothing was changed</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-st-waiting">{view.refusal}</p>
      </div>
    )
  }
  return (
    <div data-testid="checkpoint-result" className="mb-1 rounded-lg border border-accent/30 bg-accent/[0.06] px-3 py-2.5">
      <p className="text-[12.5px] font-medium text-fg">{result.summary}</p>
      {result.verified && <p className="mt-0.5 text-[11px] text-st-idle">Every rewound file was read back and matched.</p>}
      <div className="mt-2 border-t border-line pt-1.5">
        {result.files.map((f) => (
          <FileRow key={f.path} file={f} />
        ))}
      </div>
      <p className="mt-2 text-[11px] text-faint">Your HEAD, index and branches were not touched.</p>
      {(view.canRedo || view.retry) && (
        <div className="mt-2.5 flex items-center justify-end gap-2">
          {view.retry && (
            <Button variant="outline" size="sm" data-testid="checkpoint-retry" disabled={busy} onClick={onRetry}>
              <RotateCcw size={13} />
              Retry
            </Button>
          )}
          {view.canRedo && (
            <Button variant="subtle" size="sm" data-testid="checkpoint-redo" disabled={busy} onClick={onRedo}>
              <Undo2 size={13} />
              Redo
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** A request that threw (for example the step is gone) is shown as a refusal, never as a silent nothing. */
function failedResult(stepId: string, err: unknown): RollbackResult {
  const reason = err instanceof Error ? err.message : String(err)
  return { stepId, files: [], verified: false, summary: reason, refused: reason }
}

export function CheckpointsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const sessionId = useUi((s) => s.checkpointsFor)
  const session = useSessions((s) => (sessionId ? s.sessions[sessionId] : undefined))

  const [steps, setSteps] = useState<CheckpointStep[]>([])
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [result, setResult] = useState<RollbackResult | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!sessionId) return
    try {
      setSteps(await bridge.invoke('checkpoints:list', sessionId))
    } catch {
      // main is not answering yet; the next change event will retry
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    if (!sessionId) return
    const off = bridge.on('checkpoints:changed', (payload) => {
      if (payload.sessionId === sessionId) void refresh()
    })
    return off
  }, [sessionId, refresh])

  const doRollback = async (step: CheckpointStep): Promise<void> => {
    setBusy(true)
    try {
      const res = await bridge.invoke('checkpoints:rollback', step.id)
      setResult(res)
      setConfirmingId(null)
      await refresh()
    } catch (err) {
      setResult(failedResult(step.id, err))
      setConfirmingId(null)
    } finally {
      setBusy(false)
    }
  }

  const doRedo = async (stepId: string): Promise<void> => {
    setBusy(true)
    try {
      const res = await bridge.invoke('checkpoints:redo', stepId)
      setResult(res)
      await refresh()
    } catch (err) {
      setResult(failedResult(stepId, err))
    } finally {
      setBusy(false)
    }
  }

  const subtitle = session ? `${AGENTS[session.agent].name} in ${basename(session.cwd)}` : undefined

  return (
    <SlideOver title="Checkpoints" subtitle={subtitle} onClose={onClose} testId="checkpoints-panel">
      {session && (
        <div className="flex items-center gap-2 px-4 pt-3 text-[11.5px] text-faint">
          <AgentBadge kind={session.agent} size={18} />
          <span className="truncate font-mono" title={session.cwd}>
            {session.cwd}
          </span>
        </div>
      )}
      <div className="px-3 py-3">
        {result && <ResultCard
            result={result}
            busy={busy}
            onRedo={() => void doRedo(result.stepId)}
            onRetry={() => {
              if (result.direction === 'redo') void doRedo(result.stepId)
              else {
                const target = steps.find((x) => x.id === result.stepId)
                if (target) void doRollback(target)
              }
            }}
          />}

        {steps.length === 0 ? (
          !result ? (
            <p className="px-2 py-8 text-center text-[12.5px] text-muted">
              No steps yet. A step is recorded each time this agent works and changes files.
            </p>
          ) : null
        ) : (
          <div className="space-y-1.5">
            {steps.map((step) => (
              <StepRow
                key={step.id}
                step={step}
                busy={busy}
                confirming={confirmingId === step.id}
                onRollback={() => setConfirmingId(step.id)}
                onCancel={() => setConfirmingId(null)}
                onConfirm={() => void doRollback(step)}
                onRedo={() => void doRedo(step.id)}
                onRetry={() => void (viewStep(step).retryDirection === 'redo' ? doRedo(step.id) : doRollback(step))}
              />
            ))}
          </div>
        )}
      </div>
    </SlideOver>
  )
}
