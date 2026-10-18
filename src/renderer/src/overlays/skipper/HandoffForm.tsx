// Lead and backup use the same checks and dependency-copy setup as races.
import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import { HANDOFF_RANKING, suggestOrder } from '@shared/heats'
import type { CheckSpec, HandoffHistory, HandoffPreference } from '@shared/heats'
import type { AgentKind } from '@shared/types'
import { AgentBadge } from '../../components/marks'
import { Button } from '../../components/ui'
import { bridge } from '../../lib/bridge'
import { useHeats } from '../../store/heats'
import { useSessions } from '../../store/sessions'
import { Toggle } from '../settings/Toggle'

const INPUT = 'h-8 min-w-0 rounded-md border border-line bg-panel px-2.5 text-[12.5px] text-fg outline-none focus:border-accent/50'
const PRESETS = { Build: 'npm run build', Test: 'npm test', Typecheck: 'npm run typecheck', Lint: 'npm run lint' }
const blank = (): CheckSpec => ({ name: '', command: '', kind: 'required' })

export function HandoffForm(): React.JSX.Element {
  const agents = useSessions((s) => s.agents)
  const workspace = useSessions((s) => s.workspace)
  const heats = useHeats((s) => s.heats)
  const [goal, setGoal] = useState('')
  const [preference, setPreference] = useState<HandoffPreference>('balanced')
  const [pickedOnly, setPickedOnly] = useState(false)
  const [picked, setPicked] = useState<AgentKind[]>([])
  const [customOrder, setCustomOrder] = useState<AgentKind[] | null>(null)
  const [attempts, setAttempts] = useState(2)
  const [checks, setChecks] = useState<CheckSpec[]>([])
  const [loaded, setLoaded] = useState(false)
  const [setup, setSetup] = useState('')
  const [attemptLimit, setAttemptLimit] = useState(15)
  const [overall, setOverall] = useState<number | null>(null)
  const [ask, setAsk] = useState(false)
  const [allowCommands, setAllowCommands] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void bridge.invoke('heats:detectChecks').then((found) => {
      if (alive) { setChecks(found.length ? found : [blank()]); setLoaded(true) }
    }).catch(() => { if (alive) { setChecks([blank()]); setLoaded(true) } })
    return () => { alive = false }
  }, [])

  const installed = HANDOFF_RANKING.balanced.filter((kind) => agents.some((agent) => agent.kind === kind && agent.installed))
  const permitted = installed.filter((kind) => !pickedOnly || picked.includes(kind))
  const history = heats.filter((heat) => heat.root === workspace?.root).reduce<HandoffHistory>((best, heat) => {
    const total = (history: HandoffHistory): number => Object.values(history).reduce((sum, entry) => sum + entry.wins + entry.fails, 0)
    return heat.handoffHistory && total(heat.handoffHistory) > total(best) ? heat.handoffHistory : best
  }, {})
  const suggestion = suggestOrder(preference, permitted, history)
  const order = (customOrder ?? suggestion).filter((kind) => permitted.includes(kind))
  const chosen = order.slice(0, attempts)
  const valid = loaded && goal.trim() && chosen.length > 0 && checks.length > 0 && checks.every((check) => check.name.trim() && check.command.trim())
  const patchCheck = (index: number, patch: Partial<CheckSpec>): void => setChecks((prev) => prev.map((check, i) => i === index ? { ...check, ...patch } : check))
  const move = (index: number, offset: number): void => {
    const next = [...order]
    const target = index + offset
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    setCustomOrder(next)
  }
  const start = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const heat = await bridge.invoke('heats:start', {
        mode: 'handoff', task: goal.trim(), agents: chosen, order: chosen,
        checks: checks.map((check) => ({ ...check, name: check.name.trim(), command: check.command.trim() })),
        setup, timeLimitMin: attemptLimit, attemptLimitMin: attemptLimit, overallLimitMin: overall,
        askBeforeNext: ask, allowCommands
      })
      useHeats.getState().upsert(heat)
      useHeats.getState().select(heat.id)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  return (
    <div data-testid="handoff-form" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[700px] space-y-5 px-6 py-6">
        <div><h2 className="text-[16px] font-semibold tracking-[-0.01em]">Hand off a goal</h2>
          <p className="mt-1 text-[12.5px] text-muted">One agent leads. A backup continues the same work when checks fail.</p></div>
        <label className="block text-[12.5px] font-medium">Goal
          <textarea data-testid="handoff-goal" value={goal} onChange={(e) => setGoal(e.target.value)} rows={3}
            placeholder="What should the agents finish?" className={`${INPUT} mt-1.5 h-auto w-full resize-none py-2 font-normal`} />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className="block text-[12.5px] font-medium">Who leads
            <select data-testid="handoff-preference" value={preference} onChange={(e) => { setPreference(e.target.value as HandoffPreference); setCustomOrder(null) }} className={`${INPUT} mt-1.5 w-full`}>
              <option value="balanced">Balanced</option><option value="quality">Quality</option><option value="speed">Speed</option>
            </select>
          </label>
          <label className="block text-[12.5px] font-medium">Attempts
            <select data-testid="handoff-attempts" value={attempts} onChange={(e) => setAttempts(Number(e.target.value))} className={`${INPUT} mt-1.5 w-full`}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}{n === 1 ? ' (solo)' : ''}</option>)}
            </select>
          </label>
        </div>
        <fieldset><legend className="text-[12.5px] font-medium">Agents Skipper may use</legend>
          <select data-testid="handoff-agent-scope" aria-label="Agents Skipper may use" value={pickedOnly ? 'picked' : 'all'} onChange={(e) => { setPickedOnly(e.target.value === 'picked'); setCustomOrder(null) }} className={`${INPUT} mt-1.5 w-full`}>
            <option value="all">All installed headless agents</option><option value="picked">Only the agents I pick</option>
          </select>
          {pickedOnly && <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{installed.map((kind) => (
            <label key={kind} className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" data-testid="handoff-agent" data-agent={kind} checked={picked.includes(kind)} onChange={() => {
                setPicked((prev) => prev.includes(kind) ? prev.filter((agent) => agent !== kind) : [...prev, kind]); setCustomOrder(null)
              }} className="accent-accent" />{AGENTS[kind].name}
            </label>
          ))}</div>}
        </fieldset>
        <div><p className="text-[12.5px] font-medium">Suggested order</p>
          <p className="mt-1 text-[11.5px] text-muted">Preference rules and completed hand-offs in this project guide the order. Move agents to choose your lead.</p>
          <ol data-testid="handoff-order" className="mt-2 divide-y divide-line rounded-lg border border-line bg-panel">
            {order.map((kind, index) => <li key={`${kind}-${index}`} data-testid="handoff-order-item" data-agent={kind} className="flex items-center gap-2 px-3 py-2 text-[12px]">
              <span className="w-4 text-faint">{index + 1}</span><AgentBadge kind={kind} size={18} /><span className="flex-1">{AGENTS[kind].name}</span>
              <span className="text-[11px] text-faint">{index === 0 ? 'Lead' : index < attempts ? 'Backup' : 'Not scheduled'}</span>
              <button type="button" data-testid="handoff-order-up" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${AGENTS[kind].name} up`} className="rounded p-1 text-muted hover:bg-hover disabled:opacity-30"><ArrowUp size={13} /></button>
              <button type="button" data-testid="handoff-order-down" disabled={index === order.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${AGENTS[kind].name} down`} className="rounded p-1 text-muted hover:bg-hover disabled:opacity-30"><ArrowDown size={13} /></button>
              <button type="button" data-testid="handoff-agent-plus" data-agent={kind} disabled={order.length >= 4} onClick={() => { setCustomOrder([...order, kind]); setAttempts(Math.min(4, Math.max(attempts, order.length + 1))) }} aria-label={`Add another ${AGENTS[kind].name} attempt`} className="rounded p-1 text-muted hover:bg-hover disabled:opacity-30">+1</button>
            </li>)}
          </ol>
          {chosen.length === 0 && <p className="mt-2 text-[12px] text-muted">Pick an installed agent to lead.</p>}
          {chosen.length > 0 && <p className="mt-1 text-[11.5px] text-faint">{chosen.length} {chosen.length === 1 ? 'attempt' : 'attempts'} scheduled</p>}
        </div>
        <fieldset><legend className="text-[12.5px] font-medium">Checks</legend>
          <div className="mt-2 flex flex-wrap gap-1.5">{Object.entries(PRESETS).map(([name, command]) => (
            <Button key={name} size="sm" variant="subtle" data-testid="handoff-check-preset" onClick={() => setChecks((prev) => [...prev.filter((check) => check.name || check.command), { name: name.toLowerCase(), command, kind: 'required' }])}>{name}</Button>
          ))}<Button size="sm" variant="subtle" data-testid="handoff-check-add" onClick={() => setChecks((prev) => [...prev, blank()])}><Plus size={13} />Command</Button></div>
          <div className="mt-2 space-y-2">{checks.map((check, index) => <div key={index} data-testid="handoff-check-row" className="flex gap-2">
            <input data-testid="handoff-check-name" value={check.name} onChange={(e) => patchCheck(index, { name: e.target.value })} aria-label={`Check ${index + 1} name`} placeholder="name" className={`${INPUT} w-28`} />
            <input data-testid="handoff-check-command" value={check.command} onChange={(e) => patchCheck(index, { command: e.target.value })} aria-label={`Check ${index + 1} command`} placeholder="command" className={`${INPUT} flex-1 font-mono text-[12px]`} />
            <select data-testid="handoff-check-kind" value={check.kind} onChange={(e) => patchCheck(index, { kind: e.target.value as CheckSpec['kind'] })} aria-label={`Check ${index + 1} kind`} className={INPUT}><option value="required">Required</option><option value="guard">Guard</option></select>
            <button type="button" data-testid="handoff-check-remove" onClick={() => setChecks((prev) => prev.filter((_, i) => i !== index))} aria-label={`Remove check ${index + 1}`} className="rounded p-1 text-muted hover:bg-hover"><Trash2 size={13} /></button>
          </div>)}</div>
        </fieldset>
        <div className="grid grid-cols-2 gap-4">
          <label className="text-[12.5px] font-medium">Time per attempt
            <select data-testid="handoff-attempt-limit" value={attemptLimit} onChange={(e) => setAttemptLimit(Number(e.target.value))} className={`${INPUT} mt-1.5 w-full`}>{[5, 10, 15, 30].map((n) => <option key={n} value={n}>{n} minutes</option>)}</select>
          </label>
          <label className="text-[12.5px] font-medium">Overall time limit
            <select data-testid="handoff-overall-limit" value={overall ?? ''} onChange={(e) => setOverall(e.target.value ? Number(e.target.value) : null)} className={`${INPUT} mt-1.5 w-full`}><option value="">None</option>{[30, 60, 120].map((n) => <option key={n} value={n}>{n} minutes</option>)}</select>
          </label>
        </div>
        <label className="block text-[12.5px] font-medium">Setup
          <input data-testid="handoff-setup" value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="Leave empty to copy node_modules" className={`${INPUT} mt-1.5 w-full font-mono text-[12px]`} />
        </label>
        <div className="flex items-center justify-between gap-3"><span className="text-[12.5px]">Ask me before each new attempt</span><Toggle testId="handoff-ask" label="Ask me before each new attempt" checked={ask} onChange={setAsk} /></div>
        <div className="flex items-center justify-between gap-3"><span className="text-[12.5px]">Let agents run commands without asking</span><Toggle testId="handoff-allow-commands" label="Let agents run commands without asking" checked={allowCommands} onChange={setAllowCommands} /></div>
        {error && <p role="alert" data-testid="handoff-error" className="text-[12.5px] text-st-failed">{error}</p>}
        <div className="flex justify-end"><Button variant="accent" data-testid="handoff-start" disabled={!valid || busy} onClick={() => void start()}>{busy ? 'Starting...' : `Start hand-off (${chosen.length} ${chosen.length === 1 ? 'attempt' : 'attempts'})`}</Button></div>
      </div>
    </div>
  )
}
