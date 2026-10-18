// Tasks: outcomes handed to an agent or a crew member that come back for review.
// Columns by status, Run starts a hand-off, only a person marks a task done.
// See docs/design/heats.md "Tasks".

import { useEffect, useMemo, useRef, useState } from 'react'
import { ListChecks, Plus } from 'lucide-react'
import type { NewTask, Task } from '@shared/tasks'
import { Button } from '../../../components/ui'
import { Modal } from '../../../components/overlay'
import { useChat } from '../../../store/chat'
import { useHeats } from '../../../store/heats'
import { useSessions } from '../../../store/sessions'
import { useUi } from '../../../store/ui'
import { useTasks } from './tasks/store'
import { TaskCard } from './tasks/TaskCard'
import { TaskEditor } from './tasks/TaskEditor'
import { TASK_COLUMNS, columnOf } from './tasks/format'

/** Five columns of 220px with 16px gaps only read once the Tasks area is this wide; below it the same groups become a list. */
const COLUMNS_MIN_WIDTH_PX = 5 * 220 + 4 * 16
/** The narrowest a card in the list grid gets. */
const LIST_CARD_MIN_WIDTH_PX = 280

export function TasksView(): React.JSX.Element {
  const tasks = useTasks((s) => s.tasks)
  const loaded = useTasks((s) => s.loaded)
  const storeError = useTasks((s) => s.error)
  const loadTasks = useTasks((s) => s.load)
  const create = useTasks((s) => s.create)
  const update = useTasks((s) => s.update)
  const remove = useTasks((s) => s.remove)
  const runTask = useTasks((s) => s.run)
  const markDone = useTasks((s) => s.markDone)
  const addToTonight = useTasks((s) => s.addToTonight)
  const clearError = useTasks((s) => s.clearError)

  const teammates = useChat((s) => s.teammates)
  const loadChat = useChat((s) => s.load)
  const agents = useSessions((s) => s.agents)
  const heats = useHeats((s) => s.heats)
  const loadHeats = useHeats((s) => s.load)

  const [editor, setEditor] = useState<{ task: Task | null } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<Task | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const [tonight, setTonight] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void loadTasks()
    void loadChat()
    void loadHeats()
  }, [loadTasks, loadChat, loadHeats])

  // Ages and "4 m old" keep reading true while the view is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const byStatus = useMemo(() => {
    const groups = new Map<string, Task[]>()
    for (const column of TASK_COLUMNS) groups.set(column.id, [])
    for (const task of tasks) {
      const column = columnOf(task, now)
      if (column) groups.get(column.id)!.push(task)
    }
    return groups
  }, [tasks, now])
  const hiddenDone = tasks.filter((task) => task.status === 'done' && columnOf(task, now) === null).length

  // Columns only when the Tasks area itself is wide enough for five of them; a ResizeObserver on the area
  // (not the window) is what decides, because the sidebars take width away from it.
  const boardRef = useRef<HTMLDivElement>(null)
  const [wideEnough, setWideEnough] = useState(false)
  useEffect(() => {
    const el = boardRef.current
    if (!el) return undefined
    const measure = (width: number) => setWideEnough(width >= COLUMNS_MIN_WIDTH_PX)
    measure(el.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) measure(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleSave = async (draft: NewTask): Promise<boolean> => {
    setSaving(true)
    try {
      const saved = editor?.task ? await update(editor.task.id, draft) : await create(draft)
      return saved !== null
    } finally {
      setSaving(false)
    }
  }

  const withBusy = async (id: string, fn: () => Promise<void>): Promise<void> => {
    setBusyIds((current) => {
      const next = new Set(current)
      next.add(id)
      return next
    })
    try {
      await fn()
    } finally {
      setBusyIds((current) => {
        if (!current.has(id)) return current
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  const runOne = async (task: Task): Promise<void> => {
    await withBusy(task.id, () => runTask(task.id))
  }

  const openHeat = (task: Task): void => {
    if (!task.heatId) return
    useHeats.getState().select(task.heatId)
    useUi.getState().openOverlay('skipper')
  }

  const tonightOnce = async (task: Task): Promise<void> => {
    await withBusy(task.id, async () => {
      await addToTonight(task.id)
      setTonight(task.title)
    })
  }

  const renderCard = (task: Task): React.JSX.Element => (
    <TaskCard
      key={task.id}
      task={task}
      heat={heats.find((heat) => heat.id === task.heatId)}
      teammates={teammates}
      now={now}
      busy={busyIds.has(task.id)}
      onRun={() => void runOne(task)}
      onOpen={() => openHeat(task)}
      onDone={() => void withBusy(task.id, () => markDone(task.id))}
      onTonight={() => void tonightOnce(task)}
      onEdit={() => {
        clearError()
        setEditor({ task })
      }}
      onRemove={() => setConfirmRemove(task)}
    />
  )

  return (
    <div data-testid="tasks-view" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [contain:inline-size]">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-chrome/60 px-6 py-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-fg tracking-[-0.01em]">Tasks</h2>
          <p className="mt-0.5 text-[11.5px] text-faint">Run hands the task to an agent, and it comes back for you to review.</p>
        </div>
        <Button
          variant="subtle"
          size="sm"
          data-testid="tasks-new"
          onClick={() => {
            clearError()
            setEditor({ task: null })
          }}
        >
          <Plus size={13} strokeWidth={2.4} />
          New task
        </Button>
      </header>

      {storeError && (
        <p role="alert" data-testid="tasks-error" className="mx-6 mt-3 rounded-lg border border-st-failed/40 bg-st-failed/10 px-3 py-2 text-[12px] text-st-failed">
          {storeError}
        </p>
      )}
      {tonight && (
        <p data-testid="tonight-note" className="mx-6 mt-3 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-[12px] text-muted">
          <span className="min-w-0 flex-1 truncate">
            {tonight} is in tonight&apos;s night watch.
          </span>
          <Button size="sm" variant="ghost" data-testid="tasks-open-night" onClick={() => useUi.getState().openOverlay('night')}>
            Open Night watch
          </Button>
          <button type="button" aria-label="Dismiss" onClick={() => setTonight(null)} className="text-faint hover:text-fg">
            &times;
          </button>
        </p>
      )}

      <div ref={boardRef} data-testid="tasks-area" className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4">
        {!loaded && <p className="text-[12px] text-faint">Loading tasks...</p>}
        {loaded && tasks.length === 0 && (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-panel text-accent">
              <ListChecks size={20} />
            </div>
            <p className="max-w-[400px] text-[12.5px] leading-relaxed text-muted">
              No tasks yet. A task is handed to an agent or a crew member, runs as a hand-off, and waits here for you to
              review it.
            </p>
          </div>
        )}

        {loaded && tasks.length > 0 &&
          (wideEnough ? (
            <div className="flex min-h-0 items-stretch gap-4">
              {TASK_COLUMNS.map((column) => {
                const rows = byStatus.get(column.id) ?? []
                return (
                  <section
                    key={column.id}
                    data-testid={`tasks-column-${column.id}`}
                    className="flex min-w-0 flex-1 basis-0 flex-col rounded-xl border border-line bg-chrome/40"
                  >
                    <h3 data-testid={`tasks-group-${column.id}`} className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] font-semibold text-muted">
                      <span className="truncate">{column.label}</span>
                      <span className="shrink-0 text-faint">{rows.length}</span>
                    </h3>
                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                      {rows.length === 0 && <p className="px-1 py-2 text-[11.5px] text-faint">Nothing here.</p>}
                      {rows.map(renderCard)}
                      {column.id === 'done' && hiddenDone > 0 && (
                        <p className="px-1 py-2 text-[11px] text-faint">
                          {hiddenDone} older {hiddenDone === 1 ? 'task' : 'tasks'} hidden.
                        </p>
                      )}
                    </div>
                  </section>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {TASK_COLUMNS.map((column) => {
                const rows = byStatus.get(column.id) ?? []
                return (
                  <section key={column.id} data-testid={`tasks-column-${column.id}`} className="min-w-0">
                    <h3 data-testid={`tasks-group-${column.id}`} className="flex items-center gap-2 py-1 text-[12px] font-semibold text-muted">
                      <span className="truncate">{column.label}</span>
                      <span className="shrink-0 text-faint">{rows.length}</span>
                    </h3>
                    {rows.length === 0 ? (
                      <p className="px-1 py-1 text-[11.5px] text-faint">Nothing here.</p>
                    ) : (
                      <div
                        className="grid gap-2"
                        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${LIST_CARD_MIN_WIDTH_PX}px, 1fr))` }}
                      >
                        {rows.map(renderCard)}
                      </div>
                    )}
                    {column.id === 'done' && hiddenDone > 0 && (
                      <p className="px-1 py-1 text-[11px] text-faint">
                        {hiddenDone} older {hiddenDone === 1 ? 'task' : 'tasks'} hidden.
                      </p>
                    )}
                  </section>
                )
              })}
            </div>
          ))}
      </div>

      {editor && (
        <TaskEditor
          task={editor.task}
          agents={agents}
          teammates={teammates}
          saving={saving}
          serverError={storeError}
          onSave={handleSave}
          onClose={() => setEditor(null)}
        />
      )}

      {confirmRemove && (
        <Modal
          title={`Remove ${confirmRemove.title}?`}
          subtitle="The task leaves this list. Its heat and any change it made stay where they are."
          onClose={() => setConfirmRemove(null)}
          testId="tasks-remove-confirm"
          width={440}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>
                Keep it
              </Button>
              <Button
                variant="subtle"
                size="sm"
                data-testid="tasks-confirm-remove"
                onClick={() => {
                  void remove(confirmRemove.id).then(() => setConfirmRemove(null))
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          <p className="pt-1 text-[12.5px] leading-relaxed text-muted">
            {confirmRemove.status === 'review'
              ? 'Merge it or mark it done first.'
              : 'This cannot be undone from here.'}
          </p>
        </Modal>
      )}
    </div>
  )
}
