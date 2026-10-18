// Schedules: run a crew member's prompt or a flow every few hours, daily or weekly while Regatta is
// open.

import { useEffect, useState } from 'react'
import type { Flow } from '@shared/flows'
import type { NewSchedule, Schedule } from '@shared/schedules'
import { CalendarClock, Plus } from 'lucide-react'
import { useChat } from '../../../store/chat'
import { useSchedules } from '../../../store/schedules'
import { bridge } from '../../../lib/bridge'
import { Button } from '../../../components/ui'
import { Modal } from '../../../components/overlay'
import { ScheduleCard } from './schedules/ScheduleCard'
import { ScheduleEditor } from './schedules/ScheduleEditor'

export function SchedulesView(): React.JSX.Element {
  const schedules = useSchedules((s) => s.schedules)
  const storeError = useSchedules((s) => s.error)
  const load = useSchedules((s) => s.load)
  const save = useSchedules((s) => s.save)
  const remove = useSchedules((s) => s.remove)
  const runNow = useSchedules((s) => s.runNow)
  const clearError = useSchedules((s) => s.clearError)

  const teammates = useChat((s) => s.teammates)
  const conversations = useChat((s) => s.conversations)
  const loadChat = useChat((s) => s.load)

  const [flows, setFlows] = useState<Flow[]>([])
  const [editor, setEditor] = useState<{ schedule: Schedule | null } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Schedule | null>(null)
  const [saving, setSaving] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void load()
    void loadChat()
    void bridge
      .invoke('flows:list')
      .then((list) => setFlows(list))
      .catch(() => setFlows([]))
  }, [load, loadChat])

  // "Next: today 18:30" stays fresh while the view is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const handleSave = async (draft: NewSchedule): Promise<boolean> => {
    setSaving(true)
    try {
      const result = await save(draft)
      return result !== null
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (schedule: Schedule): Promise<void> => {
    setSaving(true)
    try {
      await save({ id: schedule.id, name: schedule.name, target: schedule.target, every: schedule.every, enabled: !schedule.enabled })
    } finally {
      setSaving(false)
    }
  }

  const handleRunNow = async (id: string): Promise<void> => {
    setRunningId(id)
    try {
      await runNow(id)
    } finally {
      setRunningId((current) => (current === id ? null : current))
    }
  }

  return (
    <div data-testid="schedules-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-chrome/60 px-6 py-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-fg tracking-[-0.01em]">Schedules</h2>
          <p className="mt-0.5 text-[11.5px] text-faint">Schedules run while Regatta is open.</p>
        </div>
        <Button variant="subtle" size="sm" data-testid="schedules-new" onClick={() => { clearError(); setEditor({ schedule: null }) }}>
          <Plus size={13} strokeWidth={2.4} />
          New schedule
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {storeError && (
          <p role="alert" className="mb-3 rounded-lg border border-st-failed/40 bg-st-failed/10 px-3 py-2 text-[12px] text-st-failed">
            {storeError}
          </p>
        )}

        {schedules.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-panel text-accent">
              <CalendarClock size={20} />
            </div>
            <p className="max-w-[380px] text-[12.5px] leading-relaxed text-muted">
              Nothing scheduled yet. Run a crew member&apos;s prompt or a flow on a timer.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {schedules.map((schedule) => (
              <ScheduleCard
                key={schedule.id}
                schedule={schedule}
                teammates={teammates}
                flows={flows}
                conversations={conversations}
                now={now}
                running={runningId === schedule.id}
                onToggle={() => void handleToggle(schedule)}
                onRunNow={() => void handleRunNow(schedule.id)}
                onEdit={() => { clearError(); setEditor({ schedule }) }}
                onDelete={() => setConfirmDelete(schedule)}
              />
            ))}
          </div>
        )}
      </div>

      {editor && (
        <ScheduleEditor
          schedule={editor.schedule}
          teammates={teammates}
          flows={flows}
          saving={saving}
          serverError={storeError}
          onSave={handleSave}
          onClose={() => setEditor(null)}
        />
      )}

      {confirmDelete && (
        <Modal
          title={`Delete ${confirmDelete.name}?`}
          subtitle="This schedule stops running. Its past runs go away with it."
          onClose={() => setConfirmDelete(null)}
          testId="schedules-delete-confirm"
          width={440}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                Keep it
              </Button>
              <Button
                variant="subtle"
                size="sm"
                data-testid="schedules-confirm-delete"
                onClick={() => { void remove(confirmDelete.id).then(() => setConfirmDelete(null)) }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p className="pt-1 text-[12.5px] leading-relaxed text-muted">
            {confirmDelete.name} will not run again.
          </p>
        </Modal>
      )}
    </div>
  )
}
