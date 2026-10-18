// The New schedule and Edit schedule dialog.

import { useState } from 'react'
import type { Flow } from '@shared/flows'
import type { Teammate } from '@shared/chat'
import type { NewSchedule, Schedule, ScheduleEvery } from '@shared/schedules'
import { Modal } from '../../../../components/overlay'
import { Button, cx } from '../../../../components/ui'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export type TargetDraft =
  | { kind: 'crew'; teammateId: string; prompt: string }
  | { kind: 'flow'; flowId: string }

export interface ScheduleDraft {
  name: string
  target: TargetDraft
  every: ScheduleEvery
  enabled: boolean
}

function draftFrom(schedule: Schedule | null, teammates: Teammate[], flows: Flow[]): ScheduleDraft {
  if (schedule) {
    return {
      name: schedule.name,
      target:
        schedule.target.kind === 'crew'
          ? { kind: 'crew', teammateId: schedule.target.teammateId, prompt: schedule.target.prompt }
          : { kind: 'flow', flowId: schedule.target.flowId },
      every: { ...schedule.every } as ScheduleEvery,
      enabled: schedule.enabled
    }
  }
  return {
    name: '',
    target:
      teammates.length > 0
        ? { kind: 'crew', teammateId: teammates[0]!.id, prompt: '' }
        : flows.length > 0
          ? { kind: 'flow', flowId: flows[0]!.id }
          : { kind: 'crew', teammateId: '', prompt: '' },
    every: { kind: 'daily', time: '09:30' },
    enabled: true
  }
}

interface ScheduleEditorProps {
  schedule: Schedule | null
  teammates: Teammate[]
  flows: Flow[]
  saving: boolean
  serverError: string | null
  onSave: (schedule: NewSchedule) => Promise<boolean>
  onClose: () => void
}

export function ScheduleEditor({ schedule, teammates, flows, saving, serverError, onSave, onClose }: ScheduleEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFrom(schedule, teammates, flows))
  const [localError, setLocalError] = useState<string | null>(null)

  const set = (patch: Partial<ScheduleDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }))
    setLocalError(null)
  }

  const handleSave = async (): Promise<void> => {
    if (!draft.name.trim()) {
      setLocalError('Give the schedule a name.')
      return
    }
    if (draft.target.kind === 'crew' && !draft.target.prompt.trim()) {
      setLocalError('Write a prompt for the crew member.')
      return
    }
    const ok = await onSave({
      ...(schedule ? { id: schedule.id } : {}),
      name: draft.name.trim(),
      target: draft.target,
      every: draft.every,
      enabled: draft.enabled
    })
    if (ok) onClose()
  }

  const error = localError ?? serverError
  const showCrewEmpty = teammates.length === 0 && flows.length === 0

  return (
    <Modal
      title={schedule ? `Edit ${schedule.name}` : 'New schedule'}
      subtitle="Run a crew member prompt or a flow on a timer while Regatta is open."
      onClose={onClose}
      testId="schedules-editor"
      width={520}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="accent" size="sm" data-testid="schedules-save" disabled={saving} onClick={() => void handleSave()}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 pt-1">
        <div>
          <label htmlFor="schedules-name" className="block text-[12px] font-medium text-fg">
            Name
          </label>
          <input
            id="schedules-name"
            data-testid="schedules-name"
            type="text"
            autoFocus
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Daily check"
            maxLength={60}
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
          />
        </div>

        <div>
          <span className="block text-[12px] font-medium text-fg">What it runs</span>
          <div className="mt-1.5 flex gap-1.5">
            {(
              [
                { kind: 'crew', label: 'A crew member' },
                { kind: 'flow', label: 'A flow' }
              ] as const
            ).map((opt) => (
              <button
                key={opt.kind}
                type="button"
                data-testid={`schedules-target-${opt.kind}`}
                onClick={() => {
                  if (opt.kind === 'crew') {
                    set({ target: { kind: 'crew', teammateId: teammates[0]?.id ?? '', prompt: draft.target.kind === 'crew' ? draft.target.prompt : '' } })
                  } else {
                    set({ target: { kind: 'flow', flowId: flows[0]?.id ?? '' } })
                  }
                }}
                aria-pressed={draft.target.kind === opt.kind}
                className={cx(
                  'rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors duration-150',
                  draft.target.kind === opt.kind
                    ? 'border-accent/50 bg-accent/[0.12] text-fg'
                    : 'border-line-strong bg-panel text-muted hover:text-fg'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {draft.target.kind === 'crew' ? (
            <div className="mt-2.5 space-y-2.5">
              <select
                data-testid="schedules-teammate"
                aria-label="Crew member"
                value={draft.target.teammateId}
                onChange={(e) => set({ target: { kind: 'crew', teammateId: e.target.value, prompt: draft.target.kind === 'crew' ? draft.target.prompt : '' } })}
                className="w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
              >
                {teammates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <textarea
                data-testid="schedules-prompt"
                aria-label="Prompt"
                rows={3}
                value={draft.target.prompt}
                onChange={(e) => set({ target: { kind: 'crew', teammateId: draft.target.kind === 'crew' ? draft.target.teammateId : '', prompt: e.target.value } })}
                placeholder="What should the crew member do each time?"
                maxLength={4000}
                className="w-full resize-none rounded-lg border border-line-strong bg-panel px-3 py-2 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
              />
            </div>
          ) : (
            <select
              data-testid="schedules-flow"
              aria-label="Flow"
              value={draft.target.flowId}
              onChange={(e) => set({ target: { kind: 'flow', flowId: e.target.value } })}
              className="mt-2.5 w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
            >
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}

          {showCrewEmpty && (
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              There are no crew members or flows yet. Create a crew member in Agents mode, or save a flow in Flows mode, then schedule it here.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="schedules-every" className="block text-[12px] font-medium text-fg">
            How often
          </label>
          <select
            id="schedules-every"
            data-testid="schedules-every"
            value={draft.every.kind}
            onChange={(e) => {
              const kind = e.target.value as ScheduleEvery['kind']
              if (kind === 'hours') set({ every: { kind: 'hours', hours: 3 } })
              else if (kind === 'daily') set({ every: { kind: 'daily', time: '09:30' } })
              else set({ every: { kind: 'weekly', day: 1, time: '08:00' } })
            }}
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
          >
            <option value="hours">Every few hours</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
          </select>

          {draft.every.kind === 'hours' && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[12.5px] text-muted">Every</span>
              <input
                data-testid="schedules-hours"
                type="number"
                min={1}
                max={24}
                value={draft.every.hours}
                onChange={(e) => set({ every: { kind: 'hours', hours: Number(e.target.value) } })}
                className="w-20 rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
              />
              <span className="text-[12.5px] text-muted">hours</span>
            </div>
          )}
          {draft.every.kind === 'daily' && (
            <input
              data-testid="schedules-time"
              type="time"
              aria-label="Time"
              value={draft.every.time}
              onChange={(e) => set({ every: { kind: 'daily', time: e.target.value } })}
              className="mt-2 rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
            />
          )}
          {draft.every.kind === 'weekly' && (
            <div className="mt-2 flex items-center gap-2">
              <select
                data-testid="schedules-day"
                aria-label="Day"
                value={draft.every.day}
                onChange={(e) => set({ every: { kind: 'weekly', day: Number(e.target.value), time: draft.every.kind === 'weekly' ? draft.every.time : '08:00' } })}
                className="rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
              >
                {DAYS.map((day, i) => (
                  <option key={day} value={i}>
                    {day}
                  </option>
                ))}
              </select>
              <input
                data-testid="schedules-time"
                type="time"
                aria-label="Time"
                value={draft.every.time}
                onChange={(e) => set({ every: { kind: 'weekly', day: draft.every.kind === 'weekly' ? draft.every.day : 1, time: e.target.value } })}
                className="rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
              />
            </div>
          )}
        </div>

        <label className="flex cursor-pointer items-center gap-2.5 text-[12.5px] text-fg">
          <button
            type="button"
            role="switch"
            aria-checked={draft.enabled}
            aria-label="Schedule on or off"
            data-testid="schedules-enabled"
            onClick={() => set({ enabled: !draft.enabled })}
            className={cx(
              'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150',
              draft.enabled ? 'bg-accent' : 'bg-press'
            )}
          >
            <span
              className={cx(
                'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all duration-150',
                draft.enabled ? 'left-[18px]' : 'left-0.5'
              )}
            />
          </button>
          {draft.enabled ? 'On' : 'Off'}
        </label>

        {error && (
          <p role="alert" className="text-[12px] text-st-failed">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
