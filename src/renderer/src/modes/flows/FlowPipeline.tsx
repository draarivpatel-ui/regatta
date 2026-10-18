// The pipeline: a Start node, then one card per step joined by arrows, scrolling sideways when long.
// The latest run of the flow paints the cards.

import { Fragment, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Play, Plus, UserCheck, X } from 'lucide-react'
import { MAX_STEPS } from '@shared/flows'
import type { Flow, FlowRun, FlowStep, StepRun, StepStatus } from '@shared/flows'
import type { DetectedAgent } from '@shared/types'
import { Button, cx } from '../../components/ui'
import { AgentBadge } from '../../components/marks'
import { STATE_COLOR } from '../../lib/format'
import { outputLines, SCROLLBAR, STEP_STATUS_LABEL, stepHint, stepRole, stepTone, type Acting } from './logic'

interface StepCardProps {
  step: FlowStep
  index: number
  /** What the latest run did with this step, if it has one. */
  stepRun: StepRun | undefined
  /** The latest run, for Approve and Stop. */
  run: FlowRun | null
  /** An Approve or Stop of this run that was sent and has not shown yet: the buttons wait for it. */
  acting: Acting['kind'] | undefined
  selected: boolean
  detected: DetectedAgent[]
  onSelect: () => void
  onApprove: (runId: string) => void
  onStop: (runId: string) => void
}

function StepPill({ status }: { status: StepStatus }): React.JSX.Element {
  const color = STATE_COLOR[stepTone(status)]
  return (
    <span
      data-testid="flow-step-status"
      className="inline-flex h-[20px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium whitespace-nowrap"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 26%, transparent)`
      }}
    >
      <span className={cx('inline-block h-[6px] w-[6px] rounded-full', status === 'running' && 'animate-breathe')} style={{ background: color }} />
      {STEP_STATUS_LABEL[status]}
    </span>
  )
}

function StepIcon({ step }: { step: FlowStep }): React.JSX.Element {
  if (step.kind === 'agent' && step.agent) return <AgentBadge kind={step.agent} size={28} />
  const Icon = step.kind === 'check' ? Check : UserCheck
  const tone = step.kind === 'check' ? 'bg-st-idle/15 text-st-idle' : 'bg-st-waiting/15 text-st-waiting'
  return (
    <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', tone)}>
      <Icon size={15} />
    </span>
  )
}

export function StepCard({ step, index, stepRun, run, acting, selected, detected, onSelect, onApprove, onStop }: StepCardProps): React.JSX.Element {
  const status: StepStatus = stepRun?.status ?? 'pending'
  const role = stepRole(step, detected)
  const hint = status === 'pending' ? stepHint(step) : null
  const output = stepRun?.output ?? ''
  const peek = status === 'running' || status === 'waiting' ? outputLines(output, 2) : []
  const failure = status === 'failed' ? outputLines(output, 2) : []
  const waiting = run !== null && run.status === 'waiting' && status === 'waiting'

  const border =
    status === 'waiting'
      ? 'border-st-waiting/40'
      : status === 'failed'
        ? 'border-st-failed/40'
        : status === 'running'
          ? 'border-st-working/40'
          : 'border-line hover:border-line-strong'

  return (
    <div
      data-testid="flow-step"
      data-step-id={step.id}
      data-kind={step.kind}
      data-status={status}
      data-selected={String(selected)}
      // The whole card selects the step; the button inside is what the keyboard and screen readers get.
      onClick={onSelect}
      className={cx(
        'flex w-[232px] shrink-0 cursor-pointer flex-col rounded-[10px] border p-3 transition-colors duration-150',
        'has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-accent/50',
        selected ? 'border-accent/50 bg-raised ring-1 ring-accent/20' : `bg-panel ${border}`
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        className="block w-full text-left outline-none"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-faint">Step {String(index + 1).padStart(2, '0')}</span>
          <StepPill status={status} />
        </span>
        <span className="mt-2.5 flex items-start gap-2.5">
          <StepIcon step={step} />
          <span className="block min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-fg" title={step.title}>
              {step.title || 'Untitled step'}
            </span>
            <span className={cx('mt-0.5 block truncate text-[11.5px]', role.warn ? 'text-st-waiting' : 'text-muted')} title={role.text}>
              {role.text}
            </span>
          </span>
        </span>
      </button>
      {hint && (
        <p data-testid="flow-step-hint" className="mt-2 text-[11.5px] text-st-waiting">
          {hint}
        </p>
      )}
      {peek.length > 0 && (
        <div data-testid="flow-step-peek" className="mt-2.5 rounded-md bg-term px-2 py-1.5 font-mono text-[11px] leading-snug text-muted">
          {peek.map((line, i) => (
            <span key={i} className="block truncate" title={line}>
              {line}
            </span>
          ))}
        </div>
      )}
      {failure.length > 0 && (
        <p data-testid="flow-step-detail" className="mt-2.5 line-clamp-4 text-[11.5px] leading-snug break-words text-st-failed">
          {failure.join(' ')}
        </p>
      )}
      {waiting && run && (
        <div className="mt-3 flex gap-2">
          <Button
            variant="accent"
            size="sm"
            className="flex-1 justify-center"
            data-testid="flow-approve"
            disabled={acting !== undefined}
            onClick={(e) => {
              e.stopPropagation()
              onApprove(run.id)
            }}
          >
            <Check size={13} strokeWidth={2.4} />
            {acting === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 justify-center"
            data-testid="flow-stop"
            disabled={acting !== undefined}
            onClick={(e) => {
              e.stopPropagation()
              onStop(run.id)
            }}
          >
            <X size={13} />
            {acting === 'stop' ? 'Stopping…' : 'Stop'}
          </Button>
        </div>
      )}
    </div>
  )
}

/** The arrow between two nodes. With `afterId` it carries a plus that inserts a step after that card. */
function Connector({ afterId, lit, onInsert, disabled }: { afterId?: string; lit: boolean; onInsert?: () => void; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="relative flex w-[44px] shrink-0 items-center justify-center self-stretch" data-testid="flow-connector">
      <span className={cx('absolute inset-x-0 top-1/2 h-px', lit ? 'bg-accent/50' : 'bg-line-strong')} />
      <ArrowRight size={11} className={cx('absolute right-0 top-1/2 -translate-y-1/2', lit ? 'text-accent' : 'text-faint')} />
      {onInsert && (
        <button
          type="button"
          data-testid="flow-insert-step"
          data-after={afterId}
          disabled={disabled}
          onClick={onInsert}
          aria-label="Add a step here"
          title="Add a step here"
          className="relative z-10 flex h-[22px] w-[22px] items-center justify-center rounded-full border border-line-strong bg-panel text-muted outline-none transition-colors duration-150 hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-40"
        >
          <Plus size={12} strokeWidth={2.4} />
        </button>
      )}
    </div>
  )
}

/**
 * Scrolls the pipeline sideways, and only sideways, so the step's card is in view without moving the page. The first
 * card brings the Start node with it: a card that near the left edge is shown with nothing hidden before it.
 */
function revealStep(scroller: HTMLElement | null, stepId: string | null | undefined): void {
  if (!scroller || !stepId) return
  const card = scroller.querySelector<HTMLElement>(`[data-step-id="${stepId}"]`)
  if (!card) return
  const margin = 32
  const left = card.offsetLeft
  const right = left + card.offsetWidth
  if (left < scroller.scrollLeft + margin) scroller.scrollLeft = left - margin < 160 ? 0 : left - margin
  else if (right > scroller.scrollLeft + scroller.clientWidth - margin) scroller.scrollLeft = right - scroller.clientWidth + margin
}

interface FlowPipelineProps {
  flow: Flow
  /** The latest run of this flow. */
  run: FlowRun | null
  selectedStepId: string | null
  /** Approves and stops that were sent and have not shown yet, by run id. */
  acting: Record<string, Acting>
  detected: DetectedAgent[]
  onSelectStep: (id: string) => void
  /** Null adds at the end. */
  onAddStep: (afterStepId: string | null) => void
  onApprove: (runId: string) => void
  onStop: (runId: string) => void
}

export function FlowPipeline({ flow, run, selectedStepId, acting, detected, onSelectStep, onAddStep, onApprove, onStop }: FlowPipelineProps): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const full = flow.steps.length >= MAX_STEPS
  const waitingStepId = run?.status === 'waiting' ? run.steps.find((s) => s.status === 'waiting')?.stepId : undefined

  // Soft edges show where more cards are hiding.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 })
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [flow.id, flow.steps.length])

  // A card that was picked or added comes into view, and so does the card of the step that waits for you.
  useEffect(() => revealStep(scroller.current, selectedStepId), [selectedStepId, flow.id])
  useEffect(() => revealStep(scroller.current, waitingStepId), [waitingStepId, flow.id])

  return (
    <section data-testid="flow-pipeline" className="relative border-y border-line">
      <div ref={scroller} className="flex items-stretch overflow-x-auto px-6 py-4" style={SCROLLBAR}>
        <div data-testid="flow-start" className="flex w-[56px] shrink-0 flex-col items-center justify-center gap-1.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-line-strong bg-panel text-accent">
            <Play size={13} fill="currentColor" />
          </span>
          <span className="text-[11.5px] font-medium text-muted">Start</span>
        </div>
        {flow.steps.map((step, index) => {
          const before = flow.steps[index - 1]
          const beforeRun = before ? run?.steps.find((s) => s.stepId === before.id) : undefined
          return (
            <Fragment key={step.id}>
              <Connector
                lit={index === 0 ? run !== null : beforeRun?.status === 'done'}
                afterId={before?.id}
                onInsert={before ? () => onAddStep(before.id) : undefined}
                disabled={full}
              />
              <StepCard
                step={step}
                index={index}
                stepRun={run?.steps.find((s) => s.stepId === step.id)}
                run={run}
                acting={run ? acting[run.id]?.kind : undefined}
                selected={step.id === selectedStepId}
                detected={detected}
                onSelect={() => onSelectStep(step.id)}
                onApprove={onApprove}
                onStop={onStop}
              />
            </Fragment>
          )
        })}
        <Connector lit={false} />
        <button
          type="button"
          data-testid="flow-add-step"
          disabled={full}
          onClick={() => onAddStep(null)}
          className="flex min-h-[92px] w-[108px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-line-strong text-muted outline-none transition-colors duration-150 hover:border-accent/50 hover:bg-accent/[0.05] hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-40"
        >
          <Plus size={18} />
          <span className="text-[11.5px]">{full ? 'Step limit reached' : 'Add step'}</span>
        </button>
      </div>
      <div
        aria-hidden="true"
        className={cx('pointer-events-none absolute inset-y-0 left-0 w-10 bg-linear-to-r from-bg to-transparent transition-opacity duration-150', edges.left ? 'opacity-100' : 'opacity-0')}
      />
      <div
        aria-hidden="true"
        className={cx('pointer-events-none absolute inset-y-0 right-0 w-10 bg-linear-to-l from-bg to-transparent transition-opacity duration-150', edges.right ? 'opacity-100' : 'opacity-0')}
      />
    </section>
  )
}
