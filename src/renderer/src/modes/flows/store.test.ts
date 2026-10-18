// The Flows store against a fake engine that behaves like the real one where it matters: it validates a flow
// the way FlowEngine.save does, emits `flows:changed` the moment it saves, and answers a little later.
// Time is fake, so the 600 ms debounce and the answer delay are stepped by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Flow, FlowRun, StepRun } from '@shared/flows'
import { MAX_STEPS } from '@shared/flows'

type Listener = (payload: unknown) => void

const ANSWER_MS = 300
/** What Electron makes of an error thrown in a handler: the channel, then the error's class name, then its message. */
const WRAP = (channel: string, sentence: string, name = 'Error'): Error => new Error(`Error invoking remote method '${channel}': ${name}: ${sentence}`)

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** The checks FlowEngine.save makes, with its sentences. */
function problemWith(flow: Flow): string | null {
  if (flow.name.trim().length === 0) return 'A flow needs a name.'
  if (flow.steps.length > MAX_STEPS) return `A flow has at most ${MAX_STEPS} steps.`
  for (const step of flow.steps) {
    if (step.kind === 'agent' && (step.agent === null || step.prompt.trim().length === 0)) return 'Every agent step needs an agent and a prompt.'
    if (step.kind === 'check' && step.command.trim().length === 0) return 'Every check step needs a command.'
  }
  return null
}

function freshRun(flow: Flow, id = 'run1'): FlowRun {
  const steps: StepRun[] = flow.steps.map((s) => ({ stepId: s.id, status: 'pending', output: '', exitCode: null, startedAt: null, endedAt: null }))
  return {
    id,
    flowId: flow.id,
    flowName: flow.name,
    isolated: flow.isolate,
    status: 'running',
    worktree: flow.isolate ? `/w/flow-${id}` : null,
    branch: flow.isolate ? `regatta/flow-${id}` : null,
    steps,
    startedAt: Date.now(),
    endedAt: null,
    mergeSummary: null
  }
}

async function world() {
  vi.resetModules()
  const engine = new Map<string, Flow>()
  const calls: string[] = []
  const listeners = new Map<string, Listener[]>()
  const runs: FlowRun[] = []
  const failures: Record<string, string> = {}
  const failureNames: Record<string, string> = {}
  const later: { run: Partial<FlowRun> | null } = { run: null }
  // How long the engine's answer to a delete, and its list after any save or delete, take to reach the window.
  const latency = { delete: 0, event: 0 }
  const emit = (channel: string, payload: unknown): void => {
    for (const listener of listeners.get(channel) ?? []) listener(clone(payload))
  }
  /** The engine's list of flows: the window hears it a moment after the engine acted, not at the same instant. */
  const emitList = (): void => {
    const list = [...engine.values()]
    if (latency.event > 0) setTimeout(() => emit('flows:changed', list), latency.event)
    else emit('flows:changed', list)
  }
  const answerLater = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ANSWER_MS))

  const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    calls.push(channel)
    const failure = failures[channel]
    if (failure) throw WRAP(channel, failure, failureNames[channel])
    switch (channel) {
      case 'flows:list':
        return [...engine.values()].map(clone)
      case 'flows:runs':
        return runs.map(clone)
      case 'flows:save': {
        const flow = clone(args[0] as Flow)
        const problem = problemWith(flow)
        if (problem) {
          // The refusal travels back like an answer does.
          await answerLater(undefined)
          throw WRAP(channel, problem)
        }
        const next: Flow = { ...flow, updatedAt: Date.now() }
        engine.set(next.id, next)
        // Like the engine: the list goes out when it saves, the answer to the caller comes a little later.
        emitList()
        return answerLater(clone(next))
      }
      case 'flows:delete':
        engine.delete(args[0] as string)
        emitList()
        if (latency.delete > 0) await new Promise((resolve) => setTimeout(resolve, latency.delete))
        return undefined
      case 'flows:run': {
        const flow = engine.get(args[0] as string)
        if (!flow) throw WRAP(channel, 'That flow is no longer here.')
        const run = freshRun(flow, `run${runs.length + 1}`)
        runs.unshift(run)
        emit('flows:run-update', run)
        // A newer state can reach the window before the answer to the call, which describes the first.
        if (later.run) emit('flows:run-update', { ...run, ...later.run })
        return clone(run)
      }
      case 'flows:merge':
        return { merged: true, summary: 'Fast-forwarded main by 1 commit (+1 -0 in 1 file). Removed 1 worktree and 1 branch.' }
      default:
        return undefined
    }
  })

  const bridge = {
    invoke,
    send: vi.fn(),
    on: (channel: string, listener: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
      return () => undefined
    },
    platform: 'darwin'
  }
  vi.stubGlobal('window', { regatta: bridge })
  const { useFlows } = await import('../../store/flows')
  return { useFlows, engine, calls, runs, failures, failureNames, listeners, later, latency, emit }
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('saving', () => {
  it('keeps a newer edit when the save of an older copy answers late (the vanishing step card)', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(0) // the new flow's own save goes out and takes 300 ms to answer
    store.getState().setBrief('write a file')
    store.getState().addStep(null, 'agent', 'claude')
    const stepId = store.getState().selectedStepId!
    store.getState().updateStep(stepId, { prompt: 'do it' })

    await tick(ANSWER_MS + 50) // the first answer comes back now, describing the flow as it was: no step
    const mid = store.getState().flows.find((f) => f.id === id)!
    expect(mid.steps).toHaveLength(1)
    expect(mid.brief).toBe('write a file')
    expect(store.getState().selectedStepId).toBe(stepId)

    await tick(1000) // the debounce fires and the newest copy is saved
    const saved = w.engine.get(id)!
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]?.prompt).toBe('do it')
    expect(saved.brief).toBe('write a file')
    expect(store.getState().saveStates[id]).toBeUndefined()
  })

  it('saves 600 ms after the last edit, once, with the newest copy', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(0)
    await tick(ANSWER_MS + 10)
    const savesBefore = w.calls.filter((c) => c === 'flows:save').length

    store.getState().setBrief('a')
    await tick(400)
    store.getState().setBrief('ab')
    await tick(400) // 800 ms after the first edit, 400 after the last: nothing yet
    expect(w.calls.filter((c) => c === 'flows:save')).toHaveLength(savesBefore)
    expect(store.getState().saveStates[id]).toBe('saving')

    await tick(250)
    expect(w.calls.filter((c) => c === 'flows:save')).toHaveLength(savesBefore + 1)
    expect(w.engine.get(id)?.brief).toBe('ab')
    await tick(ANSWER_MS + 10)
    expect(store.getState().saveStates[id]).toBeUndefined()
  })

  it('saves a new flow at once, so it is there after a restart', async () => {
    const w = await world()
    await w.useFlows.getState().load()
    const id = w.useFlows.getState().newFlow()
    await tick(0)
    expect(w.engine.get(id)?.name).toBe('Untitled flow')
  })

  it('keeps an edit the engine refused, and says why instead of Saved', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    store.getState().addStep(null, 'agent', 'claude') // an agent step with no prompt yet
    await tick(600 + ANSWER_MS + 50)
    expect(store.getState().saveStates[id]).toBe('error')
    expect(store.getState().saveErrors[id]).toBe('Every agent step needs an agent and a prompt.')
    expect(store.getState().flows.find((f) => f.id === id)?.steps).toHaveLength(1)

    store.getState().updateStep(store.getState().selectedStepId!, { prompt: 'now it has one' })
    await tick(700 + ANSWER_MS)
    expect(store.getState().saveStates[id]).toBeUndefined()
    expect(store.getState().saveErrors[id]).toBeUndefined()
    expect(w.engine.get(id)?.steps[0]?.prompt).toBe('now it has one')
  })

  it('does not let an engine list overwrite a flow with unsaved edits, but takes it once the flow is clean', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    const stale = clone(w.engine.get(id)!)

    store.getState().setBrief('typed')
    w.emit('flows:changed', [stale])
    expect(store.getState().flows.find((f) => f.id === id)?.brief).toBe('typed')

    await tick(700 + ANSWER_MS)
    w.emit('flows:changed', [{ ...clone(w.engine.get(id)!), name: 'Renamed elsewhere' }])
    expect(store.getState().flows.find((f) => f.id === id)?.name).toBe('Renamed elsewhere')
  })

  it('drops a flow the engine deleted, keeps one that never reached it, and picks another selection', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const first = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    const second = store.getState().newFlow() // not saved yet: nothing has been awaited
    w.emit('flows:changed', [clone(w.engine.get(first)!)])
    expect(store.getState().flows.map((f) => f.id).sort()).toEqual([first, second].sort())

    await tick(ANSWER_MS + 10)
    w.engine.delete(first)
    w.emit('flows:changed', [clone(w.engine.get(second)!)])
    expect(store.getState().flows.map((f) => f.id)).toEqual([second])
  })
})

describe('saving, harder cases', () => {
  it('does not show a newer copy as refused because an older copy was', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    store.getState().addStep(null, 'agent', 'claude') // no prompt yet
    await tick(600) // the save of that copy is on its way and will be refused
    store.getState().updateStep(store.getState().selectedStepId!, { prompt: 'now it has one' })

    await tick(ANSWER_MS + 10) // the refusal of the older copy arrives
    expect(store.getState().saveStates[id]).toBe('saving')
    expect(store.getState().saveErrors[id]).toBeUndefined()
    await tick(1000)
    expect(store.getState().saveStates[id]).toBeUndefined()
    expect(w.engine.get(id)?.steps[0]?.prompt).toBe('now it has one')
  })

  it('flush saves again when an edit lands while it is saving, and settles true once the newest copy is there', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    const savesBefore = w.calls.filter((c) => c === 'flows:save').length

    store.getState().setBrief('a')
    let heldWhenSettled = ''
    const flushed = store.getState().flush(id).then((ok) => {
      heldWhenSettled = w.engine.get(id)?.brief ?? ''
      return ok
    })
    await tick(100)
    store.getState().setBrief('ab') // lands while the first save is on its way
    await tick(ANSWER_MS * 3)
    expect(await flushed).toBe(true)
    // A flush that settled after the first save would let a run start on 'a' while the screen says 'ab'.
    expect(heldWhenSettled).toBe('ab')
    expect(w.engine.get(id)?.brief).toBe('ab')
    expect(store.getState().saveStates[id]).toBeUndefined()
    // One save for 'a', one for 'ab': the timer of the second edit found nothing left to save.
    await tick(1000)
    expect(w.calls.filter((c) => c === 'flows:save')).toHaveLength(savesBefore + 2)
  })

  it('keeps the flow, and saves what was waiting, when the engine refuses to delete it', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    store.getState().setBrief('keep me') // not saved yet
    w.failures['flows:delete'] = 'The disk is full.'

    await store.getState().deleteFlow(id)
    expect(store.getState().flows.map((f) => f.id)).toEqual([id])
    expect(store.getState().notices[id]).toBe('The disk is full.')
    delete w.failures['flows:delete']
    await tick(700 + ANSWER_MS)
    expect(w.engine.get(id)?.brief).toBe('keep me')
    expect(store.getState().saveStates[id]).toBeUndefined()
  })

  it('does not let a save that was already on its way bring a deleted flow back', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    store.getState().setBrief('x')
    await tick(600) // that save is now on its way

    const deleting = store.getState().deleteFlow(id)
    await tick(ANSWER_MS + 50) // its answer comes back after the delete went out
    await deleting
    expect(w.engine.has(id)).toBe(false)
    expect(store.getState().flows).toHaveLength(0)
    expect(w.calls.lastIndexOf('flows:save')).toBeLessThan(w.calls.indexOf('flows:delete'))
    await tick(2000)
    expect(w.engine.has(id)).toBe(false)
  })

  it('does not save a flow again while its delete is on its way', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    w.latency.delete = 1000 // the engine has deleted it, the answer is slow
    w.latency.event = 50 // and its list reaches the window a moment after the delete went out

    const deleting = store.getState().deleteFlow(id)
    store.getState().setBrief('typed while it is being deleted') // its 600 ms are up before the answer comes
    await tick(1100)
    await deleting
    expect(w.engine.has(id)).toBe(false)
    expect(store.getState().flows).toHaveLength(0)
    await tick(2000)
    expect(w.engine.has(id)).toBe(false) // no save recreated it
  })

  it('still saves an edit made while a delete is on its way and then refused', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    w.failures['flows:delete'] = 'The disk is full.'

    const deleting = store.getState().deleteFlow(id)
    store.getState().setBrief('typed before the refusal arrived')
    await deleting
    expect(store.getState().flows.map((f) => f.id)).toEqual([id])
    expect(store.getState().flows[0]?.brief).toBe('typed before the refusal arrived')
    delete w.failures['flows:delete']
    await tick(700 + ANSWER_MS)
    expect(w.engine.get(id)?.brief).toBe('typed before the refusal arrived')
    expect(store.getState().saveStates[id]).toBeUndefined()
  })
})

describe('loading', () => {
  it('brings the flows, the runs and what was isolated, and listens once however often it is called', async () => {
    const w = await world()
    const flow: Flow = { id: 'f1', name: 'From before', brief: '', trigger: 'manual', isolate: true, steps: [], createdAt: 1, updatedAt: 1 }
    w.engine.set('f1', flow)
    const isolated = { ...freshRun(flow, 'old1'), status: 'done' as const, endedAt: 5 }
    w.runs.push(isolated)
    const store = w.useFlows
    await store.getState().load()
    await store.getState().load()
    expect(store.getState().loaded).toBe(true)
    expect(store.getState().flows.map((f) => f.id)).toEqual(['f1'])
    expect(store.getState().selectedFlowId).toBe('f1')
    expect(store.getState().runs.map((r) => r.id)).toEqual(['old1'])
    expect(store.getState().isolatedSeen['old1']).toBe(true)
    expect(w.listeners.get('flows:changed')).toHaveLength(1)
    expect(w.listeners.get('flows:run-update')).toHaveLength(1)
  })
})

describe('running', () => {
  it('saves the newest edits first, then asks the engine to run', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    store.getState().addStep(null, 'agent', 'claude')
    store.getState().updateStep(store.getState().selectedStepId!, { prompt: 'go' })

    const running = store.getState().runFlow(id)
    await tick(ANSWER_MS + 10)
    await running
    expect(w.calls.lastIndexOf('flows:save')).toBeLessThan(w.calls.indexOf('flows:run'))
    expect(w.engine.get(id)?.steps).toHaveLength(1)
    expect(store.getState().runs).toHaveLength(1)
    expect(store.getState().starting[id]).toBeUndefined()
  })

  it('does not start a run the engine would not take, and says why', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    store.getState().addStep(null, 'agent', 'claude')

    const running = store.getState().runFlow(id)
    await tick(ANSWER_MS + 10)
    await running
    expect(w.calls).not.toContain('flows:run')
    expect(store.getState().notices[id]).toBe('This flow cannot run yet. Every agent step needs an agent and a prompt.')
  })

  it('shows the engine\'s sentence when a run is refused', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    w.failures['flows:run'] = 'Regatta is quitting, so nothing new was started.'
    w.failureNames['flows:run'] = 'Quitting'

    await store.getState().runFlow(id)
    expect(store.getState().notices[id]).toBe('Regatta is quitting, so nothing new was started.')
    expect(store.getState().starting[id]).toBeUndefined()
    store.getState().dismissNotice(id)
    expect(store.getState().notices[id]).toBeUndefined()
  })

  it('starts one run for a double click', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    const first = store.getState().runFlow(id)
    const second = store.getState().runFlow(id)
    await tick(ANSWER_MS + 10)
    await Promise.all([first, second])
    expect(w.calls.filter((c) => c === 'flows:run')).toHaveLength(1)
  })

  it('keeps a newer state of the run that reached the window before the answer to the run', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    w.later.run = { status: 'waiting' }
    await store.getState().runFlow(id)
    expect(store.getState().runs).toHaveLength(1)
    expect(store.getState().runs[0]?.status).toBe('waiting')
  })

  it('adds a run once when its update event and the answer to the run both arrive', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    await store.getState().runFlow(id)
    expect(store.getState().runs.map((r) => r.id)).toEqual(['run1'])
  })

  it('remembers a run that had a worktree after the engine releases it', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    store.getState().setIsolate(true)
    await tick(700 + ANSWER_MS)
    await store.getState().runFlow(id)
    const run = clone(store.getState().runs[0]!)
    expect(store.getState().isolatedSeen[run.id]).toBe(true)
    w.emit('flows:run-update', { ...run, status: 'done', worktree: null, branch: null, mergeSummary: 'Merged.' })
    expect(store.getState().runs[0]?.worktree).toBeNull()
    expect(store.getState().isolatedSeen[run.id]).toBe(true)
  })
})

describe('approving and stopping', () => {
  const stepRunAt = (stepId: string, status: StepRun['status']): StepRun => ({ stepId, status, output: '', exitCode: null, startedAt: 1, endedAt: null })
  const waitingAt = (waiting: 'a' | 'b'): FlowRun => ({
    id: 'r1',
    flowId: 'f1',
    flowName: 'Flow',
    isolated: false,
    status: 'waiting',
    worktree: null,
    branch: null,
    steps: [stepRunAt('a', waiting === 'a' ? 'waiting' : 'done'), stepRunAt('b', waiting === 'b' ? 'waiting' : 'pending')],
    startedAt: 1,
    endedAt: null,
    mergeSummary: null
  })
  const sent = (w: Awaited<ReturnType<typeof world>>, channel: string): number => w.calls.filter((c) => c === channel).length

  it('sends one approve for a double click, and the next approval step needs its own click', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    w.emit('flows:run-update', waitingAt('a'))

    await store.getState().approveRun('r1')
    expect(store.getState().acting['r1']).toEqual({ kind: 'approve', stepId: 'a' })
    await store.getState().approveRun('r1') // the second click of a double click
    expect(sent(w, 'flows:approve')).toBe(1)

    w.emit('flows:run-update', waitingAt('b')) // the engine moved on to the next approval
    expect(store.getState().acting['r1']).toBeUndefined()
    await store.getState().approveRun('r1')
    expect(sent(w, 'flows:approve')).toBe(2)
  })

  it('clears the pending mark and shows the sentence when the engine refuses', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    w.emit('flows:run-update', waitingAt('a'))
    w.failures['flows:approve'] = 'That run is no longer here.'
    await store.getState().approveRun('r1')
    expect(store.getState().acting['r1']).toBeUndefined()
    expect(store.getState().runErrors['r1']).toBe('That run is no longer here.')
  })

  it('keeps a stop pending until the run is over', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    w.emit('flows:run-update', { ...waitingAt('a'), status: 'running' })
    await store.getState().stopRun('r1')
    expect(store.getState().acting['r1']).toEqual({ kind: 'stop', stepId: null })
    await store.getState().stopRun('r1')
    expect(sent(w, 'flows:stop')).toBe(1)
    w.emit('flows:run-update', { ...waitingAt('a'), status: 'stopped' })
    expect(store.getState().acting['r1']).toBeUndefined()
  })
})

describe('acting on a run', () => {
  it('keeps the sentence of a refused merge on the run and clears the busy mark', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    w.failures['flows:merge'] = 'Commit or stash your changes first. Merging needs a clean folder.'
    w.failureNames['flows:merge'] = 'MergeRefused'
    await store.getState().mergeRun('run9')
    expect(store.getState().runErrors['run9']).toBe('Commit or stash your changes first. Merging needs a clean folder.')
    expect(store.getState().busyRuns['run9']).toBeUndefined()
    store.getState().dismissRunError('run9')
    expect(store.getState().runErrors['run9']).toBeUndefined()
  })

  it('clears an old refusal when the next try goes through', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    w.failures['flows:merge'] = 'The run is busy.'
    await store.getState().mergeRun('run9')
    expect(store.getState().runErrors['run9']).toBe('The run is busy.')
    delete w.failures['flows:merge']
    await store.getState().mergeRun('run9')
    expect(store.getState().runErrors['run9']).toBeUndefined()
  })

  it('shows a refused discard and a refused approve the same way', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    w.failures['flows:discard'] = 'The run is still stopping. Try discarding again in a moment.'
    await store.getState().discardRun('run2')
    expect(store.getState().runErrors['run2']).toBe('The run is still stopping. Try discarding again in a moment.')
    w.failures['flows:approve'] = 'That run is no longer here.'
    await store.getState().approveRun('run3')
    expect(store.getState().runErrors['run3']).toBe('That run is no longer here.')
  })

  it('looks at the run again after a merge, in case its update event was missed', async () => {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    await store.getState().runFlow(id)
    const live = w.runs[0]!
    // The engine finished the merge, but the update event never reached the window.
    w.runs[0] = { ...live, status: 'done', worktree: null, branch: null, mergeSummary: 'Merged into main.' }
    await store.getState().mergeRun(live.id)
    expect(store.getState().runs[0]?.mergeSummary).toBe('Merged into main.')
  })
})

describe('editing steps', () => {
  async function started(count: number) {
    const w = await world()
    const store = w.useFlows
    await store.getState().load()
    const id = store.getState().newFlow()
    for (let i = 0; i < count; i++) store.getState().addStep(null, 'agent', 'claude')
    return { w, store, id }
  }

  const steps = (store: Awaited<ReturnType<typeof started>>['store'], id: string) => store.getState().flows.find((f) => f.id === id)!.steps

  it('adds at the end, after a given step, selects the new step and stops at 16', async () => {
    const { store, id } = await started(2)
    const [a, b] = steps(store, id)
    store.getState().addStep(a!.id, 'check', 'claude')
    const middle = steps(store, id)[1]!
    expect(steps(store, id).map((s) => s.id)).toEqual([a!.id, middle.id, b!.id])
    expect(middle.kind).toBe('check')
    expect(middle.agent).toBeNull()
    expect(store.getState().selectedStepId).toBe(middle.id)
    for (let i = 0; i < 20; i++) store.getState().addStep(null, 'approval', 'claude')
    expect(steps(store, id)).toHaveLength(MAX_STEPS)
  })

  it('removes a step and hands the inspector to its neighbour', async () => {
    const { store, id } = await started(3)
    const [a, b, c] = steps(store, id)
    store.getState().selectStep(b!.id)
    store.getState().removeStep(b!.id)
    expect(steps(store, id).map((s) => s.id)).toEqual([a!.id, c!.id])
    expect(store.getState().selectedStepId).toBe(c!.id)
    store.getState().removeStep(c!.id)
    expect(store.getState().selectedStepId).toBe(a!.id)
    store.getState().removeStep(a!.id)
    expect(store.getState().selectedStepId).toBeNull()
  })

  it('moves a step one place and not past either end', async () => {
    const { store, id } = await started(3)
    const [a, b, c] = steps(store, id)
    store.getState().moveStep(a!.id, 'left')
    expect(steps(store, id).map((s) => s.id)).toEqual([a!.id, b!.id, c!.id])
    store.getState().moveStep(a!.id, 'right')
    expect(steps(store, id).map((s) => s.id)).toEqual([b!.id, a!.id, c!.id])
    store.getState().moveStep(c!.id, 'right')
    expect(steps(store, id).map((s) => s.id)).toEqual([b!.id, a!.id, c!.id])
  })

  it('changes a step\'s kind with its title, and gives an agent back to it when needed', async () => {
    const { store, id } = await started(1)
    const stepId = steps(store, id)[0]!.id
    store.getState().updateStep(stepId, { prompt: 'keep me' })
    store.getState().setStepKind(stepId, 'check', 'codex')
    expect(steps(store, id)[0]).toMatchObject({ kind: 'check', title: 'Check step', agent: null, prompt: 'keep me' })
    store.getState().setStepKind(stepId, 'agent', 'codex')
    expect(steps(store, id)[0]).toMatchObject({ kind: 'agent', title: 'Agent step', agent: 'codex', prompt: 'keep me' })
    store.getState().updateStep(stepId, { title: 'Plan it' })
    store.getState().setStepKind(stepId, 'approval', 'codex')
    expect(steps(store, id)[0]?.title).toBe('Plan it')
  })

  it('saves nothing when the kind picked is the kind the step already has', async () => {
    const { w, store, id } = await started(1)
    const stepId = steps(store, id)[0]!.id
    store.getState().updateStep(stepId, { prompt: 'go' })
    await tick(700 + ANSWER_MS)
    expect(store.getState().saveStates[id]).toBeUndefined()
    const saves = w.calls.filter((c) => c === 'flows:save').length

    store.getState().setStepKind(stepId, 'agent', 'claude')
    expect(store.getState().saveStates[id]).toBeUndefined()
    await tick(1500)
    expect(w.calls.filter((c) => c === 'flows:save')).toHaveLength(saves)
  })

  it('replaces the steps with a recipe\'s, with fresh ids, and selects the first', async () => {
    const { store, id } = await started(1)
    const before = steps(store, id)[0]!.id
    store.getState().applyRecipe('bug')
    const after = steps(store, id)
    expect(after).toHaveLength(3)
    expect(after.map((s) => s.kind)).toEqual(['agent', 'agent', 'check'])
    expect(after.some((s) => s.id === before)).toBe(false)
    expect(new Set(after.map((s) => s.id)).size).toBe(3)
    expect(store.getState().selectedStepId).toBe(after[0]!.id)
  })

  it('selects the first step of a flow when it is picked', async () => {
    const { store, id } = await started(2)
    const other = store.getState().newFlow()
    expect(store.getState().selectedStepId).toBeNull()
    store.getState().selectFlow(id)
    expect(store.getState().selectedStepId).toBe(steps(store, id)[0]!.id)
    store.getState().selectFlow(other)
    expect(store.getState().selectedStepId).toBeNull()
  })

  it('deletes a flow and moves on to another one', async () => {
    const { w, store, id } = await started(0)
    await tick(ANSWER_MS + 10)
    const other = store.getState().newFlow()
    await tick(ANSWER_MS + 10)
    await store.getState().deleteFlow(other)
    expect(w.engine.has(other)).toBe(false)
    expect(store.getState().flows.map((f) => f.id)).toEqual([id])
    expect(store.getState().selectedFlowId).toBe(id)
  })
})
