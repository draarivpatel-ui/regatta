// Tonight: add tasks to the queue, then schedule the night or start it now.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Play, Plus, Trash2, X } from 'lucide-react'
import type { CheckSpec } from '@shared/heats'
import { bridge } from '../../lib/bridge'
import { useNow } from '../../lib/useNow'
import { AgentBadge } from '../../components/marks'
import { Button, IconButton, cx } from '../../components/ui'
import { useNight } from '../../store/night'
import { useSessions } from '../../store/sessions'
import { activeNight, agentName, customCheck, formatClock, formatUntil, HEADLESS_AGENTS, nextStart, plural } from './helpers'

const CARD = 'rounded-[10px] border border-line bg-panel p-4'
const FIELD =
  'w-full rounded-lg border border-line bg-raised px-3 text-[12.5px] text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/50 focus:ring-2 focus:ring-accent/30'

export function NightForm(): React.JSX.Element {
  const now = useNow()
  const allAgents = useSessions((s) => s.agents)
  const state = useNight((s) => s.state)
  const error = useNight((s) => s.error)
  const addTask = useNight((s) => s.addTask)
  const removeTask = useNight((s) => s.removeTask)
  const schedule = useNight((s) => s.schedule)
  const cancel = useNight((s) => s.cancel)
  const select = useNight((s) => s.select)
  const dismissError = useNight((s) => s.dismissError)

  const queue = state?.queue ?? []
  const active = activeNight(state)

  // What is typed lives in the store, so a look at another night does not lose it.
  const { prompt, agent, custom, time } = useNight((s) => s.draft)
  const offNames = useNight((s) => s.draft.off)
  const setDraft = useNight((s) => s.setDraft)
  /** What the project's own checks are; null until main has looked. */
  const [found, setFound] = useState<CheckSpec[] | null>(null)
  const [busy, setBusy] = useState(false)
  const top = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    bridge
      .invoke('heats:detectChecks')
      .then((checks) => alive && setFound(checks))
      .catch(() => alive && setFound([]))
    return () => {
      alive = false
    }
  }, [])

  // A refusal from main shows at the top of the pane; bring it into view.
  useEffect(() => {
    if (error) top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [error])

  const agents = allAgents.filter((a) => a.installed && HEADLESS_AGENTS.includes(a.kind))
  const detected = useMemo(() => found ?? [], [found])
  const chosen = useMemo<CheckSpec[]>(() => {
    const kept = detected.filter((c) => !offNames.includes(c.name))
    return custom.trim() ? [...kept, customCheck(custom, detected.map((c) => c.name))] : kept
  }, [detected, offNames, custom])

  const missing = [prompt.trim() === '' && 'a prompt', agent === null && 'an agent', chosen.length === 0 && 'a check'].filter(
    (m): m is string => m !== false
  )
  const canAdd = missing.length === 0 && !busy

  const add = async (): Promise<void> => {
    if (!canAdd || agent === null) return
    setBusy(true)
    try {
      // The prompt and the custom check are cleared once main took the task; a refusal keeps what was typed.
      if (await addTask({ prompt: prompt.trim(), agent, checks: chosen })) setDraft({ prompt: '', custom: '' })
    } finally {
      setBusy(false)
    }
  }

  const start = nextStart(time, now)
  const go = async (when: number | 'now'): Promise<void> => {
    setBusy(true)
    try {
      await schedule(when)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="night-form" className="min-h-0 flex-1 overflow-y-auto">
      <div ref={top} />
      <div className="mx-auto w-full max-w-[680px] px-6 py-6">
        <h2 className="text-[16px] font-semibold tracking-[-0.01em]">Tonight</h2>
        <p className="mt-1 text-[12.5px] text-muted">
          Tasks run one after another, each in its own copy of your project. Nothing is merged until you say so.
        </p>

        {error && (
          <div
            role="alert"
            data-testid="night-error"
            className="mt-4 flex items-start gap-2 rounded-lg border border-st-failed/30 bg-st-failed/[0.07] px-3 py-2 text-[12.5px] text-st-failed"
          >
            <span className="min-w-0 flex-1 leading-relaxed">{error}</span>
            <button type="button" onClick={dismissError} aria-label="Dismiss" className="mt-0.5 shrink-0 text-muted transition-colors hover:text-fg">
              <X size={13} />
            </button>
          </div>
        )}

        <div className="mt-5 space-y-4">
          <section className={CARD}>
            <h3 className="text-[12.5px] font-medium">Add a task</h3>
            <label className="mt-3 block">
              <span className="sr-only">Prompt</span>
              <textarea
                data-testid="night-prompt"
                value={prompt}
                onChange={(e) => setDraft({ prompt: e.target.value })}
                placeholder="What should the agent do tonight?"
                rows={3}
                className={cx(FIELD, 'resize-none py-2 leading-relaxed')}
              />
            </label>

            <div className="mt-4">
              <p className="text-[12px] font-medium text-muted">Agent</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Agent">
                {agents.map((a) => (
                  <button
                    key={a.kind}
                    type="button"
                    data-testid="night-agent"
                    data-agent={a.kind}
                    aria-pressed={agent === a.kind}
                    onClick={() => setDraft({ agent: a.kind })}
                    className={cx(
                      'flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[12.5px] outline-none transition-colors duration-150',
                      'focus-visible:ring-2 focus-visible:ring-accent/50',
                      agent === a.kind ? 'border-accent/50 bg-accent/[0.08] text-fg' : 'border-line bg-raised text-muted hover:border-line-strong hover:text-fg'
                    )}
                  >
                    <AgentBadge kind={a.kind} size={16} />
                    {agentName(a.kind)}
                  </button>
                ))}
              </div>
              {agents.length === 0 && (
                <p className="mt-1.5 text-[12px] text-muted">No agent that can run on its own is installed. Install one of its command line tools first.</p>
              )}
            </div>

            <div className="mt-4">
              <p className="text-[12px] font-medium text-muted">Checks</p>
              <p className="mt-0.5 text-[11.5px] text-faint">A task is ready only when every required check passes.</p>
              {detected.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {detected.map((c) => (
                    <label key={c.name} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-raised px-3 py-1.5 text-[12px]">
                      <input
                        type="checkbox"
                        data-testid="night-check"
                        data-name={c.name}
                        checked={!offNames.includes(c.name)}
                        onChange={() => setDraft({ off: offNames.includes(c.name) ? offNames.filter((n) => n !== c.name) : [...offNames, c.name] })}
                        className="h-3.5 w-3.5 shrink-0 accent-accent"
                      />
                      <span className="font-medium">{c.name}</span>
                      <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint">{c.command}</code>
                      <span className="shrink-0 text-[11px] text-faint">{c.kind}</span>
                    </label>
                  ))}
                </div>
              )}
              {found !== null && detected.length === 0 && (
                <p className="mt-2 text-[12px] text-muted">No checks found in this project. Type one below.</p>
              )}
              <input
                data-testid="night-check-custom"
                value={custom}
                onChange={(e) => setDraft({ custom: e.target.value })}
                placeholder="Another check to run, for example npm run lint"
                aria-label="Another check"
                className={cx(FIELD, 'mt-2 h-8 font-mono placeholder:font-sans')}
              />
            </div>

            <div className="mt-4 flex items-center justify-end gap-3">
              {missing.length > 0 && <span className="text-[11.5px] text-faint">Still needed: {missing.join(', ')}</span>}
              <Button variant="accent" data-testid="night-add" disabled={!canAdd} onClick={() => void add()}>
                <Plus size={13} />
                Add to tonight
              </Button>
            </div>
          </section>

          {queue.length > 0 && (
            <section className={CARD} data-testid="night-queue">
              <div className="flex items-center justify-between">
                <h3 className="text-[12.5px] font-medium">Queue</h3>
                <span className="text-[11.5px] text-muted">{plural(queue.length, 'task', 'tasks')}</span>
              </div>
              <ul className="mt-3 space-y-2">
                {queue.map((task) => (
                  <li
                    key={task.id}
                    data-testid={`night-task-${task.id}`}
                    data-agent={task.agent}
                    className="flex items-start gap-3 rounded-lg border border-line bg-raised p-3"
                  >
                    <AgentBadge kind={task.agent} size={20} />
                    <div className="min-w-0 flex-1">
                      <p data-testid="night-queue-prompt" className="line-clamp-2 text-[12.5px] leading-snug">{task.prompt}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {task.checks.map((c) => (
                          <span
                            key={c.name}
                            data-testid="night-tag"
                            title={`${c.command} (${c.kind})`}
                            className="inline-flex max-w-full items-center rounded-full border border-line bg-panel px-2 py-0.5 text-[10.5px] text-muted"
                          >
                            <span className="truncate">{c.name}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                    <IconButton
                      data-testid={`night-remove-${task.id}`}
                      aria-label="Remove task"
                      title="Remove task"
                      className="hover:text-st-failed"
                      onClick={() => void removeTask(task.id)}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={CARD} data-testid="night-start">
            <h3 className="text-[12.5px] font-medium">Start</h3>
            {active?.status === 'scheduled' ? (
              <div className="mt-3 flex items-center gap-3">
                <Clock size={16} className="shrink-0 text-st-starting" />
                <div className="min-w-0 flex-1">
                  <p data-testid="night-scheduled" className="text-[12.5px]">
                    Starts at {formatClock(active.startAt)}, in {formatUntil(active.startAt - now)}
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-faint">{plural(active.runs.length, 'task', 'tasks')} will run one after another.</p>
                </div>
                <Button variant="subtle" size="sm" data-testid="night-see-report" onClick={() => select(active.id)}>
                  See the night
                </Button>
                <Button variant="outline" size="sm" data-testid="night-cancel" onClick={() => void cancel()}>
                  <X size={13} />
                  Cancel
                </Button>
              </div>
            ) : active?.status === 'running' ? (
              <div className="mt-3 flex items-center gap-3">
                <span className="relative inline-flex h-2 w-2 shrink-0">
                  <span className="absolute inset-0 rounded-full bg-st-working opacity-60 animate-ping" />
                  <span className="relative inline-block h-2 w-2 rounded-full bg-st-working animate-breathe" />
                </span>
                <p className="min-w-0 flex-1 text-[12.5px]">A night is running now. Tasks you add wait for the next one.</p>
                <Button variant="subtle" size="sm" data-testid="night-see-report" onClick={() => select(active.id)}>
                  See the report
                </Button>
              </div>
            ) : (
              <>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <label className="flex items-center gap-2 text-[12.5px]">
                    <span className="font-medium">Start at</span>
                    <input
                      type="time"
                      data-testid="night-start-at"
                      value={time}
                      onChange={(e) => setDraft({ time: e.target.value })}
                      className="h-8 rounded-lg border border-line bg-raised px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
                    />
                  </label>
                  {start && (
                    <span className="text-[11.5px] text-faint">
                      {start.tomorrow ? 'Tomorrow' : 'Today'}, in {formatUntil(start.at - now)}
                    </span>
                  )}
                  <div className="ml-auto flex gap-2">
                    <Button
                      variant="accent"
                      size="sm"
                      data-testid="night-schedule"
                      disabled={queue.length === 0 || start === null || busy}
                      onClick={() => start && void go(start.at)}
                    >
                      <Clock size={13} />
                      Schedule
                    </Button>
                    <Button variant="outline" size="sm" data-testid="night-start-now" disabled={queue.length === 0 || busy} onClick={() => void go('now')}>
                      <Play size={13} />
                      Start now
                    </Button>
                  </div>
                </div>
                {queue.length === 0 && <p className="mt-2 text-[11.5px] text-faint">Add a task to start a night.</p>}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
