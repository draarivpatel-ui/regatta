// New heat form: task, agents, checks, setup, limits.

import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { CheckSpec } from '@shared/heats'
import type { AgentKind } from '@shared/types'
import { AGENTS } from '@shared/agents'
import { bridge } from '../../lib/bridge'
import { useSessions } from '../../store/sessions'
import { useHeats } from '../../store/heats'
import { AgentBadge } from '../../components/marks'
import { Button, cx } from '../../components/ui'
import { Toggle } from '../settings/Toggle'
import { HandoffForm } from './HandoffForm'

const RACEABLE: AgentKind[] = ['claude', 'codex', 'grok', 'opencode', 'gemini', 'fake']
const LIMITS = [5, 10, 15, 30]

function emptyCheck(): CheckSpec {
  return { name: '', command: '', kind: 'required' }
}

function RaceForm(): React.JSX.Element {
  const allAgents = useSessions((s) => s.agents)
  const [task, setTask] = useState('')
  const [picked, setPicked] = useState<AgentKind[]>([])
  const [checks, setChecks] = useState<CheckSpec[]>([])
  const [checksLoaded, setChecksLoaded] = useState(false)
  const [setup, setSetup] = useState('')
  const [timeLimitMin, setTimeLimitMin] = useState(10)
  const [allowCommands, setAllowCommands] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void bridge
      .invoke('heats:detectChecks')
      .then((found) => {
        if (!alive) return
        setChecks(found.length > 0 ? found.map((c) => ({ ...c })) : [emptyCheck()])
        setChecksLoaded(true)
      })
      .catch(() => {
        if (!alive) return
        setChecks([emptyCheck()])
        setChecksLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const raceable = RACEABLE.filter((kind) => allAgents.some((a) => a.kind === kind && a.installed)).map(
    (kind) => allAgents.find((a) => a.kind === kind)!
  )

  const countOf = (kind: AgentKind): number => picked.filter((k) => k === kind).length

  const toggleAgent = (kind: AgentKind): void => {
    setPicked((prev) => {
      if (prev.includes(kind)) return prev.filter((k) => k !== kind)
      if (prev.length >= 4) return prev
      return [...prev, kind]
    })
  }

  const addAgain = (kind: AgentKind): void => {
    setPicked((prev) => (prev.length >= 4 ? prev : [...prev, kind]))
  }

  const patchCheck = (index: number, patch: Partial<CheckSpec>): void => {
    setChecks((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  const removeCheck = (index: number): void => {
    setChecks((prev) => prev.filter((_, i) => i !== index))
  }

  const validChecks =
    checks.length > 0 && checks.every((c) => c.name.trim().length > 0 && c.command.trim().length > 0)
  const canStart =
    task.trim().length > 0 && picked.length >= 2 && picked.length <= 4 && validChecks && !starting

  const start = async (): Promise<void> => {
    if (!canStart) return
    setStarting(true)
    setError(null)
    try {
      const heat = await bridge.invoke('heats:start', {
        task: task.trim(),
        agents: [...picked],
        checks: checks.map((c) => ({ name: c.name.trim(), command: c.command.trim(), kind: c.kind })),
        setup,
        timeLimitMin,
        allowCommands
      })
      useHeats.getState().upsert(heat)
      useHeats.getState().select(heat.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div data-testid="heat-form" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[640px] px-6 py-6">
      <h2 className="text-[16px] font-semibold tracking-[-0.01em]">New heat</h2>
      <p className="mt-1 text-[12.5px] text-muted">The same task goes to every lane. Checks pick the winner.</p>

      <label className="mt-5 block">
        <span className="text-[12.5px] font-medium">Task</span>
        <textarea
          data-testid="heat-task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="What should every agent do?"
          rows={3}
          className="mt-1.5 w-full resize-none rounded-lg border border-line bg-panel px-3 py-2 text-[13px] leading-relaxed text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/50 focus:ring-2 focus:ring-accent/40"
        />
      </label>

      <div className="mt-5">
        <p className="text-[12.5px] font-medium">Agents</p>
        <p className="mt-0.5 text-[11.5px] text-faint">Pick two to four lanes. Use plus one to race the same agent twice.</p>
        <div className="mt-2 space-y-1.5">
          {raceable.length === 0 && (
            <p className="rounded-lg border border-line bg-panel px-3 py-3 text-[12px] text-muted">
              No racing agents found. Install an agent CLI to start a heat.
            </p>
          )}
          {raceable.map((a) => {
            const count = countOf(a.kind)
            const on = count > 0
            return (
              <div
                key={a.kind}
                className={cx(
                  'flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors duration-150',
                  on ? 'border-accent/40 bg-accent/[0.06]' : 'border-line bg-panel'
                )}
              >
                <input
                  type="checkbox"
                  data-testid="heat-agent"
                  data-agent={a.kind}
                  checked={on}
                  onChange={() => toggleAgent(a.kind)}
                  aria-label={AGENTS[a.kind]?.name ?? a.kind}
                  className="h-3.5 w-3.5 shrink-0 accent-accent"
                />
                <AgentBadge kind={a.kind} size={18} />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{AGENTS[a.kind]?.name ?? a.name}</span>
                {count > 1 && <span className="text-[11.5px] text-muted">x{count}</span>}
                <button
                  type="button"
                  data-testid="heat-agent-plus"
                  data-agent={a.kind}
                  onClick={() => addAgain(a.kind)}
                  disabled={picked.length >= 4}
                  title={`Add another ${AGENTS[a.kind]?.name ?? a.kind} lane`}
                  aria-label={`Add another ${AGENTS[a.kind]?.name ?? a.kind} lane`}
                  className="flex h-6 min-w-[28px] items-center justify-center rounded-md border border-line bg-raised px-1.5 text-[12px] text-muted transition-colors duration-150 hover:border-line-strong hover:text-fg disabled:opacity-40"
                >
                  +1
                </button>
              </div>
            )
          })}
        </div>
        <p className="mt-1.5 text-[11.5px] text-faint">{picked.length} of 4 lanes picked</p>
      </div>

      <div className="mt-5">
        <div className="flex items-center gap-2">
          <p className="text-[12.5px] font-medium">Checks</p>
          {checksLoaded && checks.length === 0 && <span className="text-[11.5px] text-faint">No checks yet</span>}
        </div>
        <div className="mt-2 space-y-1.5">
          {checks.map((c, i) => (
            <div
              key={i}
              data-testid="heat-check-row"
              className="flex items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-2"
            >
              <div className="grid min-w-0 flex-1 grid-cols-[130px_1fr] gap-2">
                <input
                  data-testid="heat-check-name"
                  value={c.name}
                  onChange={(e) => patchCheck(i, { name: e.target.value })}
                  placeholder="name"
                  aria-label={`Check ${i + 1} name`}
                  className="h-7 min-w-0 rounded-md border border-line bg-raised px-2 text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent/50"
                />
                <input
                  data-testid="heat-check-command"
                  value={c.command}
                  onChange={(e) => patchCheck(i, { command: e.target.value })}
                  placeholder="command"
                  aria-label={`Check ${i + 1} command`}
                  className="h-7 min-w-0 rounded-md border border-line bg-raised px-2 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent/50"
                />
              </div>
              <button
                type="button"
                data-testid="heat-check-kind"
                data-kind={c.kind}
                onClick={() => patchCheck(i, { kind: c.kind === 'required' ? 'guard' : 'required' })}
                title={c.kind === 'required' ? 'Required: must pass in a lane' : 'Guard: must not regress'}
                className={cx(
                  'h-6 shrink-0 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap transition-colors duration-150',
                  c.kind === 'required'
                    ? 'border-accent/40 text-accent-bright'
                    : 'border-line-strong text-muted hover:text-fg'
                )}
              >
                {c.kind}
              </button>
              <button
                type="button"
                data-testid="heat-check-remove"
                onClick={() => removeCheck(i)}
                aria-label={`Remove check ${i + 1}`}
                title="Remove check"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors duration-150 hover:bg-hover hover:text-fg"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2">
          <Button
            variant="subtle"
            size="sm"
            data-testid="heat-check-add"
            onClick={() => setChecks((prev) => [...prev, emptyCheck()])}
          >
            <Plus size={13} />
            Add check
          </Button>
        </div>
      </div>

      <div className="mt-5">
        <p className="text-[12.5px] font-medium">Setup</p>
        <input
          data-testid="heat-setup"
          value={setup}
          onChange={(e) => setSetup(e.target.value)}
          placeholder="Leave empty to copy node_modules"
          className="mt-1.5 h-8 w-full rounded-md border border-line bg-panel px-2.5 font-mono text-[12px] text-fg outline-none placeholder:font-sans placeholder:text-faint focus:border-accent/50"
        />
      </div>

      <div className="mt-5">
        <p className="text-[12.5px] font-medium">Time limit</p>
        <div className="mt-1.5 flex gap-1.5" role="group" aria-label="Time limit in minutes">
          {LIMITS.map((m) => (
            <button
              key={m}
              type="button"
              data-testid="heat-limit"
              data-minutes={m}
              onClick={() => setTimeLimitMin(m)}
              aria-pressed={timeLimitMin === m}
              className={cx(
                'h-7 rounded-md border px-3 text-[12px] transition-colors duration-150',
                timeLimitMin === m
                  ? 'border-accent/50 bg-accent/[0.12] text-accent-bright'
                  : 'border-line bg-panel text-muted hover:text-fg'
              )}
            >
              {m} min
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium">Let agents run commands without asking</p>
          <p className="mt-0.5 text-[11.5px] text-faint">Lanes stay inside their own worktree.</p>
        </div>
        <Toggle
          checked={allowCommands}
          onChange={setAllowCommands}
          testId="heat-allow-commands"
          label="Let agents run commands without asking"
        />
      </div>

      {error && (
        <p role="alert" data-testid="heat-error" className="mt-4 text-[12.5px] text-st-failed">
          {error}
        </p>
      )}

      <div className="mt-5 flex justify-end">
        <Button variant="accent" data-testid="heat-start" disabled={!canStart} onClick={() => void start()}>
          {starting ? 'Starting...' : `Start heat (${picked.length} lanes)`}
        </Button>
      </div>
      {!canStart && (
        <p className="mt-2 text-right text-[11.5px] text-faint">Add a task, two to four lanes and one check to start.</p>
      )}
      </div>
    </div>
  )
}


export function HeatForm(): React.JSX.Element {
  const [tab, setTab] = useState<'race' | 'handoff'>('race')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Skipper run mode" className="flex shrink-0 gap-2 border-b border-line px-6 py-2">
        {(['race', 'handoff'] as const).map((mode) => (
          <button key={mode} type="button" role="tab" aria-selected={tab === mode}
            data-testid={`skipper-tab-${mode}`} onClick={() => setTab(mode)}
            className={cx('rounded-md px-3 py-1.5 text-[12.5px] transition-colors', tab === mode ? 'bg-press text-accent-bright' : 'text-muted hover:bg-hover')}>
            {mode === 'race' ? 'Race' : 'Hand off'}
          </button>
        ))}
      </div>
      {tab === 'race' ? <RaceForm /> : <HandoffForm />}
    </div>
  )
}
