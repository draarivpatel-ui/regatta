// One schedule card with its runs.

import { Check, Pencil, Play, Trash2, X } from 'lucide-react'
import type { Flow } from '@shared/flows'
import type { Conversation, Teammate } from '@shared/chat'
import type { Schedule } from '@shared/schedules'
import { useUi } from '../../../../store/ui'
import { Button, cx } from '../../../../components/ui'
import { PixelAvatar } from '../../PixelAvatar'
import { everyText, nextText, whenText } from './format'

interface ScheduleCardProps {
  schedule: Schedule
  teammates: Teammate[]
  flows: Flow[]
  conversations: Record<string, Conversation>
  now: number
  running: boolean
  onToggle: () => void
  onRunNow: () => void
  onEdit: () => void
  onDelete: () => void
}

export function ScheduleCard({ schedule, teammates, flows, conversations, now, running, onToggle, onRunNow, onEdit, onDelete }: ScheduleCardProps): React.JSX.Element {
  const target = schedule.target
  const teammate = target.kind === 'crew' ? teammates.find((t) => t.id === target.teammateId) ?? null : null
  const flow = target.kind === 'flow' ? flows.find((f) => f.id === target.flowId) ?? null : null
  const prompt = target.kind === 'crew' ? target.prompt : null

  const openRun = (conversationId: string | null, flowRunId: string | null): void => {
    if (flowRunId || (!conversationId && target.kind === 'flow')) {
      useUi.getState().setMode('flows')
      return
    }
    const conversation = conversationId ? conversations[conversationId] : undefined
    const memberId = conversation?.teammateId ?? (target.kind === 'crew' ? target.teammateId : null)
    const member = teammates.find((t) => t.id === memberId) ?? null
    if (!member) return
    // AgentsMode keeps its selection locally, so open the matching crew entry in the list.
    // The member's newest conversation becomes active on its own, which is the run.
    const cards = [...document.querySelectorAll<HTMLElement>('[data-testid="crew-card"]')]
    const match = cards.find((card) => (card.textContent ?? '').includes(member.name))
    match?.click()
  }

  return (
    <article
      data-testid={`schedules-row-${schedule.id}`}
      className="rounded-xl border border-line bg-panel p-4 animate-fade-up"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13.5px] font-semibold text-fg tracking-[-0.01em]">{schedule.name}</h3>
          <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted">
            {teammate ? (
              <>
                <PixelAvatar name={teammate.name} size={16} />
                <span className="truncate">
                  {teammate.name}: {prompt}
                </span>
              </>
            ) : target.kind === 'crew' ? (
              <span className="truncate">A crew member that no longer exists{prompt ? `: ${prompt}` : ''}</span>
            ) : (
              <span className="truncate">Flow: {flow ? flow.name : target.flowId}</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-faint">
            <span>{everyText(schedule.every)}</span>
            <span aria-hidden="true">·</span>
            <span className={schedule.enabled && schedule.nextRunAt != null ? 'text-muted' : ''}>{nextText(schedule, now)}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            role="switch"
            aria-checked={schedule.enabled}
            aria-label={schedule.enabled ? `Turn ${schedule.name} off` : `Turn ${schedule.name} on`}
            data-testid={`schedules-toggle-${schedule.id}`}
            onClick={onToggle}
            className={cx(
              'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150',
              schedule.enabled ? 'bg-accent' : 'bg-press'
            )}
          >
            <span
              className={cx(
                'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all duration-150',
                schedule.enabled ? 'left-[18px]' : 'left-0.5'
              )}
            />
          </button>
          <Button variant="subtle" size="sm" data-testid={`schedules-run-${schedule.id}`} onClick={onRunNow} disabled={running} title="Run now">
            <Play size={13} />
            Run now
          </Button>
          <Button variant="ghost" size="sm" data-testid={`schedules-edit-${schedule.id}`} onClick={onEdit} title="Edit" aria-label={`Edit ${schedule.name}`}>
            <Pencil size={13} />
          </Button>
          <Button variant="ghost" size="sm" data-testid={`schedules-delete-${schedule.id}`} onClick={onDelete} title="Delete" aria-label={`Delete ${schedule.name}`}>
            <Trash2 size={13} />
          </Button>
        </div>
      </div>

      {schedule.runs.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line pt-2.5">
          {schedule.runs.slice(0, 3).map((run, i) => (
            <li key={`${run.at}-${i}`} className="flex items-center gap-2 text-[11.5px]">
              <span className={run.ok ? 'text-st-idle' : 'text-st-failed'} aria-label={run.ok ? 'Succeeded' : 'Failed'}>
                {run.ok ? <Check size={13} /> : <X size={13} />}
              </span>
              <span className="shrink-0 text-faint">{whenText(run.at, now)}</span>
              {run.conversationId || run.flowRunId ? (
                <button
                  type="button"
                  onClick={() => openRun(run.conversationId, run.flowRunId)}
                  className="truncate text-left text-muted underline decoration-line-strong underline-offset-2 hover:text-fg"
                  title={run.conversationId ? 'Open the conversation' : 'Open Flows mode'}
                >
                  {run.note}
                </button>
              ) : (
                <span className="truncate text-muted">{run.note}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
