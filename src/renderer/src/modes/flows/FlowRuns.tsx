// Runs of the selected flow: the latest one open as its result card, earlier ones below as a short list.
// A result card shows what each step did and, for an isolated run, offers to merge or discard it, keeps the
// engine's sentences (what it kept and why, where a copy of the work was parked) and shows a refusal
// next to the buttons without taking them away.

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, CircleAlert, Copy, GitMerge, Loader2, Square, X } from 'lucide-react'
import type { Flow, FlowRun, StepKind, StepRun } from '@shared/flows'
import { Button, IconButton, cx } from '../../components/ui'
import { StatusDot } from '../../components/marks'
import { NoteText } from '../../overlays/night/NoteText'
import { STATE_COLOR } from '../../lib/format'
import { useNow } from '../../lib/useNow'
import {
  SCROLLBAR,
  formatDuration,
  formatWhen,
  noteCommand,
  outputLines,
  RUN_STATUS_LABEL,
  runHeadline,
  runTone,
  runView,
  STEP_STATUS_LABEL,
  stepTone,
  type Acting
} from './logic'

/** Earlier runs shown before "Show older runs". */
const EARLIER_SHOWN = 5

function RunPill({ status }: { status: FlowRun['status'] }): React.JSX.Element {
  const color = STATE_COLOR[runTone(status)]
  return (
    <span
      data-testid="flow-run-status"
      className="inline-flex h-[20px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium whitespace-nowrap"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 26%, transparent)`
      }}
    >
      <StatusDot state={runTone(status)} size={6} />
      {RUN_STATUS_LABEL[status]}
    </span>
  )
}

/** A git command someone may want to run by hand, copied without the sentence around it. */
function CopyCommand({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = (): void => {
    try {
      void navigator.clipboard
        ?.writeText(command)
        .then(() => {
          setCopied(true)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setCopied(false), 1500)
        })
        .catch(() => undefined)
    } catch {
      // No clipboard here; the command is on screen and can be selected.
    }
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      data-testid="flow-note-copy"
      data-command={command}
      title={command.includes('<name>') ? 'Copies the command. Replace <name> with the name you want for the restored branch.' : 'Copies the command'}
      onClick={copy}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy command'}
    </Button>
  )
}

/** The lines of a step's saved output the run card can show (the engine keeps the last 60). */
const OUTPUT_LINES = 40

/**
 * One step of a run. What the step delivered (its saved output) opens under it: a failed step, and the step
 * right before one that waits for you, start open, because those are what to read.
 */
function StepResult({ stepRun, title, kind, now, openByDefault }: { stepRun: StepRun; title: string; kind: StepKind | undefined; now: number; openByDefault: boolean }): React.JSX.Element {
  const lines = outputLines(stepRun.output, OUTPUT_LINES)
  const failed = stepRun.status === 'failed'
  const [shown, setShown] = useState<boolean | undefined>(undefined)
  const canOpen = lines.length > 0 && kind !== 'approval' && stepRun.status !== 'pending' && stepRun.status !== 'skipped'
  const open = canOpen && (shown ?? (failed || openByDefault))
  const took = stepRun.startedAt ? formatDuration((stepRun.endedAt ?? now) - stepRun.startedAt) : ''
  return (
    <li data-testid="flow-run-step" data-status={stepRun.status} className="flex items-start gap-2.5 text-[12px]">
      <span className="flex h-[18px] shrink-0 items-center">
        <StatusDot state={stepTone(stepRun.status)} size={6} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-fg">{title}</span>
          <span className="shrink-0 text-faint">{STEP_STATUS_LABEL[stepRun.status]}</span>
          {canOpen && (
            <button
              type="button"
              data-testid="flow-run-step-toggle"
              aria-expanded={open}
              onClick={() => setShown(!open)}
              className="shrink-0 rounded text-[11px] text-faint outline-none transition-colors duration-150 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              {open ? 'Hide output' : 'Show output'}
            </button>
          )}
          {took && stepRun.status !== 'pending' && stepRun.status !== 'skipped' && <span className="ml-auto shrink-0 tabular-nums text-faint">{took}</span>}
        </span>
        {open && (
          <pre
            data-testid="flow-run-step-detail"
            className={cx(
              'mt-1.5 max-h-40 overflow-auto rounded-md bg-term px-2.5 py-2 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap select-text',
              failed ? 'text-st-failed' : 'text-muted'
            )}
            style={SCROLLBAR}
          >
            {lines.join('\n')}
          </pre>
        )}
      </span>
    </li>
  )
}

export interface RunCardProps {
  run: FlowRun
  flow: Flow
  latest: boolean
  expanded: boolean
  seenIsolated: boolean
  error: string | undefined
  busy: 'merge' | 'discard' | undefined
  /** An Approve or Stop of this run that was sent and has not shown yet. */
  acting: Acting['kind'] | undefined
  onToggle: () => void
  onApprove: (runId: string) => void
  onStop: (runId: string) => void
  onMerge: (runId: string) => void
  onDiscard: (runId: string) => void
  onDismissError: (runId: string) => void
}

export function RunCard({ run, flow, latest, expanded, seenIsolated, error, busy, acting, onToggle, onApprove, onStop, onMerge, onDiscard, onDismissError }: RunCardProps): React.JSX.Element {
  const now = useNow()
  const view = runView(run, seenIsolated)
  const titleOf = (stepId: string): string => flow.steps.find((s) => s.id === stepId)?.title ?? 'a step that was removed'
  const headline = runHeadline(run, titleOf)
  const took = formatDuration((run.endedAt ?? now) - run.startedAt)
  const notes = run.notes ?? []
  const working = busy !== undefined
  // The latest run's waiting step has Approve and Stop on its own card, as long as that step is still in the flow.
  // Any other waiting run, and one whose step was removed or replaced meanwhile, gets them here.
  const waitingStep = run.steps.find((s) => s.status === 'waiting')
  const waitingOnCard = latest && waitingStep !== undefined && flow.steps.some((s) => s.id === waitingStep.stepId)

  return (
    <article
      data-testid="flow-run-card"
      data-run-id={run.id}
      data-status={run.status}
      data-latest={String(latest)}
      data-held={String(view.held)}
      data-merged={String(view.merged)}
      data-discarded={String(view.discarded)}
      className="animate-fade-up overflow-hidden rounded-[10px] border border-line bg-panel"
    >
      <div className="flex items-center gap-2 pr-3">
        <button
          type="button"
          data-testid="flow-run-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-150 hover:bg-hover"
        >
          <RunPill status={run.status} />
          <span className="min-w-0 flex-1">
            <span data-testid="flow-run-headline" className="block truncate text-[12.5px] font-medium text-fg">
              {headline}
            </span>
            <span className="block truncate text-[11.5px] text-faint">
              {formatWhen(run.startedAt, now)} · {took}
              {view.held && ' · own worktree'}
            </span>
          </span>
          {view.merged && <span className="shrink-0 text-[11.5px] font-medium text-st-idle">Merged</span>}
          {view.discarded && <span className="shrink-0 text-[11.5px] font-medium text-muted">Discarded</span>}
          {view.canMerge && <span className="shrink-0 text-[11.5px] font-medium text-st-waiting">Not merged yet</span>}
          {expanded ? <ChevronDown size={14} className="shrink-0 text-faint" /> : <ChevronRight size={14} className="shrink-0 text-faint" />}
        </button>
        {run.status === 'running' && (
          <Button variant="outline" size="sm" data-testid="flow-run-stop" disabled={acting !== undefined} onClick={() => onStop(run.id)}>
            <Square size={11} fill="currentColor" />
            {acting === 'stop' ? 'Stopping…' : 'Stop'}
          </Button>
        )}
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-line px-3.5 py-3">
          {run.status === 'waiting' && !waitingOnCard && (
            <div className="flex gap-2">
              <Button variant="accent" size="sm" data-testid="flow-run-approve" disabled={acting !== undefined} onClick={() => onApprove(run.id)}>
                <Check size={13} strokeWidth={2.4} />
                {acting === 'approve' ? 'Approving…' : 'Approve'}
              </Button>
              <Button variant="outline" size="sm" data-testid="flow-run-stop" disabled={acting !== undefined} onClick={() => onStop(run.id)}>
                <X size={13} />
                {acting === 'stop' ? 'Stopping…' : 'Stop'}
              </Button>
            </div>
          )}

          {view.merged && (
            <div data-testid="flow-merge-summary" className="flex items-start gap-2 rounded-lg border border-st-idle/30 bg-st-idle/[0.07] px-3 py-2.5 text-[12px] leading-relaxed text-fg select-text">
              <Check size={14} className="mt-0.5 shrink-0 text-st-idle" />
              <span>{run.mergeSummary}</span>
            </div>
          )}

          {view.discarded && (
            <p data-testid="flow-discarded" className="text-[12px] leading-relaxed text-muted">
              Discarded. Nothing from this run was merged into your project.
            </p>
          )}

          {(view.canMerge || view.canDiscard) && (
            <div data-testid="flow-merge-card" className="rounded-lg border border-line-strong bg-raised/60 p-3">
              <p className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
                <GitMerge size={14} className="text-accent" />
                {view.canMerge ? 'This run worked in its own worktree' : 'This run still has its own worktree'}
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
                {view.canMerge ? (
                  <>
                    Its changes are on the branch <code className="font-mono text-fg">{run.branch}</code>. Merging brings them into the branch you have open and removes the worktree.
                  </>
                ) : view.merged ? (
                  'Its changes are already merged. Discard clears what is left of the worktree.'
                ) : run.status === 'done' ? (
                  'Part of its worktree is already gone, so it cannot be merged. Discard clears what is left.'
                ) : (
                  'It did not finish, so its changes cannot be merged. Discard removes the worktree and keeps a copy of its commits in the repository.'
                )}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {view.canMerge && (
                  <Button variant="accent" size="sm" data-testid="flow-merge" disabled={working} onClick={() => onMerge(run.id)}>
                    {busy === 'merge' ? <Loader2 size={13} className="animate-spin" /> : <GitMerge size={13} />}
                    {busy === 'merge' ? 'Merging…' : "Merge the run's changes"}
                  </Button>
                )}
                {view.canDiscard && (
                  <Button variant="outline" size="sm" data-testid="flow-discard" disabled={working} onClick={() => onDiscard(run.id)}>
                    {busy === 'discard' && <Loader2 size={13} className="animate-spin" />}
                    {busy === 'discard' ? 'Discarding…' : 'Discard'}
                  </Button>
                )}
              </div>
            </div>
          )}

          {error && (
            <p data-testid="flow-run-error" role="alert" className="flex items-start gap-2 select-text text-[12px] leading-relaxed text-st-failed">
              <CircleAlert size={13} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
              <IconButton aria-label="Dismiss" title="Dismiss" className="-my-1 h-6 w-6" onClick={() => onDismissError(run.id)}>
                <X size={12} />
              </IconButton>
            </p>
          )}

          <ul data-testid="flow-run-steps" className="space-y-2">
            {run.steps.map((stepRun, i) => (
              <StepResult
                key={stepRun.stepId}
                stepRun={stepRun}
                title={titleOf(stepRun.stepId)}
                kind={flow.steps.find((s) => s.id === stepRun.stepId)?.kind}
                now={now}
                openByDefault={run.steps[i + 1]?.status === 'waiting'}
              />
            ))}
          </ul>

          {notes.length > 0 && (
            <div data-testid="flow-notes" className="rounded-lg border border-line bg-bg/50 px-3 py-2.5">
              <p className="text-[12px] font-medium text-fg">Notes</p>
              <ul className="mt-2 space-y-2">
                {notes.map((note, i) => {
                  const command = noteCommand(note)
                  return (
                    <li key={`${i}-${note}`} data-testid="flow-note" className="flex items-start gap-3 text-[11.5px] leading-relaxed text-muted">
                      {/* Every command in the note carries its own copy button; the line keeps one for the first. */}
                      <NoteText note={note} />
                      {command && <CopyCommand command={command} />}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

interface FlowRunsProps {
  flow: Flow
  /** This flow's runs, newest first. */
  runs: FlowRun[]
  isolatedSeen: Record<string, true>
  runErrors: Record<string, string>
  busyRuns: Record<string, 'merge' | 'discard'>
  acting: Record<string, Acting>
  onApprove: (runId: string) => void
  onStop: (runId: string) => void
  onMerge: (runId: string) => void
  onDiscard: (runId: string) => void
  onDismissError: (runId: string) => void
}

export function FlowRuns({ flow, runs, isolatedSeen, runErrors, busyRuns, acting, onApprove, onStop, onMerge, onDiscard, onDismissError }: FlowRunsProps): React.JSX.Element {
  // What the user opened or closed by hand; a card nobody touched is open when it is the latest run.
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = useState(false)
  const latest = runs[0]
  const earlier = runs.slice(1)
  const shownEarlier = showAll ? earlier : earlier.slice(0, EARLIER_SHOWN)

  const card = (run: FlowRun, isLatest: boolean): React.JSX.Element => (
    <RunCard
      key={run.id}
      run={run}
      flow={flow}
      latest={isLatest}
      expanded={opened[run.id] ?? isLatest}
      seenIsolated={isolatedSeen[run.id] === true}
      error={runErrors[run.id]}
      busy={busyRuns[run.id]}
      acting={acting[run.id]?.kind}
      onToggle={() => setOpened((prev) => ({ ...prev, [run.id]: !(prev[run.id] ?? isLatest) }))}
      onApprove={onApprove}
      onStop={onStop}
      onMerge={onMerge}
      onDiscard={onDiscard}
      onDismissError={onDismissError}
    />
  )

  return (
    <section data-testid="flow-runs" className="px-6 pb-8 pt-6">
      <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-fg">Runs</h2>
      {!latest ? (
        <p data-testid="flow-runs-empty" className="mt-2 text-[12.5px] leading-relaxed text-muted">
          No runs yet. Run the flow and each step's result shows up here.
        </p>
      ) : (
        <div className="mt-3 space-y-2.5">
          {card(latest, true)}
          {earlier.length > 0 && <p className="pt-2 text-[12px] font-medium text-faint">Earlier runs</p>}
          {shownEarlier.map((run) => card(run, false))}
          {earlier.length > EARLIER_SHOWN && (
            <Button variant="ghost" size="sm" data-testid="flow-runs-more" onClick={() => setShowAll((all) => !all)}>
              {showAll ? 'Show fewer runs' : `Show ${earlier.length - EARLIER_SHOWN} older run${earlier.length - EARLIER_SHOWN === 1 ? '' : 's'}`}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
