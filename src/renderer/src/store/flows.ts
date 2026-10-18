// Flows store: the flows being edited, their runs, and everything that saves a flow or acts on a run.
//
// How saving works, and why it is built this way:
// - An edit shows at once in `flows` (the working copies the window draws).
// - Saving is debounced 600 ms per flow and always sends the NEWEST copy in this store, read when the
//   timer fires. (The first version sent the copy it had when the edit was made, so a late save of an old
//   copy came back and replaced newer steps: the step card vanished a moment after it was added.)
// - A save only marks the flow clean when no edit landed while it was in flight.
// - The engine's `flows:changed` list never replaces a flow that has unsaved edits (see reconcileFlows).
// - `flows:run` runs what the ENGINE has saved, so a run first flushes the pending save and refuses to
//   start when the engine would not take the flow, saying why.

import { create } from 'zustand'
import type { Flow, FlowRun, FlowStep, StepKind } from '@shared/flows'
import { MAX_STEPS, RECIPES } from '@shared/flows'
import type { AgentKind } from '@shared/types'
import { bridge } from '../lib/bridge'
import { generateId } from '../lib/ids'
import {
  DEFAULT_FLOW_NAME,
  DEFAULT_TITLES,
  mergeRuns,
  normalizeSelection,
  reconcileFlows,
  settleActing,
  stripIpcPrefix,
  titleAfterKindChange,
  upsertRun,
  type Acting
} from '../modes/flows/logic'

/** How long after the last edit a flow is saved. */
export const SAVE_DELAY_MS = 600

type SaveState = 'saving' | 'error'

interface FlowsState {
  /** The working copies, including edits that are not saved yet and new flows. */
  flows: Flow[]
  /** Newest first. */
  runs: FlowRun[]
  loaded: boolean
  selectedFlowId: string | null
  selectedStepId: string | null
  /** Per flow: absent when saved, 'saving' while an edit waits or is being saved, 'error' when the engine refused the save. */
  saveStates: Record<string, SaveState>
  /** The engine's sentence for a refused save, per flow. */
  saveErrors: Record<string, string>
  /** A sentence about the flow as a whole (a run that was refused), per flow. */
  notices: Record<string, string>
  /** A sentence about one run (an approve, stop, merge or discard that was refused), per run. */
  runErrors: Record<string, string>
  /** Runs with a merge or a discard under way. */
  busyRuns: Record<string, 'merge' | 'discard'>
  /** Flows whose run request is in flight, so a double click starts one run. */
  starting: Record<string, boolean>
  /** Approves and stops that were sent and have not shown in the run yet, so a double click does not approve the next step too. */
  acting: Record<string, Acting>
  /** Runs this window saw with a worktree or branch of their own (the run record loses that once it is released). */
  isolatedSeen: Record<string, true>

  load: () => Promise<void>
  selectFlow: (id: string | null) => void
  selectStep: (id: string | null) => void
  newFlow: () => string
  deleteFlow: (id: string) => Promise<void>
  renameFlow: (name: string) => void
  setBrief: (brief: string) => void
  setIsolate: (isolate: boolean) => void
  applyRecipe: (recipeId: string) => void
  /** Adds a step after the given one, or at the end when `afterStepId` is null, and selects it. */
  addStep: (afterStepId: string | null, kind: StepKind, agent: AgentKind) => void
  removeStep: (stepId: string) => void
  moveStep: (stepId: string, direction: 'left' | 'right') => void
  updateStep: (stepId: string, patch: Partial<Pick<FlowStep, 'title' | 'agent' | 'prompt' | 'command'>>) => void
  setStepKind: (stepId: string, kind: StepKind, agent: AgentKind) => void
  /** Saves now when there are unsaved edits. True when the engine has the newest copy. */
  flush: (flowId: string) => Promise<boolean>
  runFlow: (flowId: string) => Promise<void>
  stopRun: (runId: string) => Promise<void>
  approveRun: (runId: string) => Promise<void>
  mergeRun: (runId: string) => Promise<void>
  discardRun: (runId: string) => Promise<void>
  dismissNotice: (flowId: string) => void
  dismissRunError: (runId: string) => void
}

// Not part of the rendered state: nothing draws from these, so changing them re-renders nothing.
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** Flows with edits the engine has not confirmed. */
const dirty = new Set<string>()
/** Counts the edits of each flow, so a save can tell whether something changed while it was in flight. */
const editCount = new Map<string, number>()
/** The save under way for a flow, if any. */
const inflight = new Map<string, Promise<boolean>>()
/** Flows the engine has told us about at some point. A local flow missing from a later engine list was deleted. */
const known = new Set<string>()
/** Flows whose delete is on its way: nothing saves them meanwhile, so nothing brings them back. */
const deleting = new Set<string>()
let subscribed = false

const now = (): number => Date.now()

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function busyIds(): Set<string> {
  return new Set([...dirty, ...inflight.keys()])
}

function cancelTimer(flowId: string): void {
  const timer = timers.get(flowId)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(flowId)
}

export const useFlows = create<FlowsState>((set, get) => {
  /** Applies a change to the flow with this id (and anything else to set with it) and schedules its save. */
  function edit(flowId: string, change: (flow: Flow) => Flow, also: Partial<FlowsState> = {}): void {
    const flow = get().flows.find((f) => f.id === flowId)
    if (!flow) return
    const next: Flow = { ...change(flow), updatedAt: now() }
    set((s) => ({
      flows: s.flows.map((f) => (f.id === flowId ? next : f)),
      saveStates: { ...s.saveStates, [flowId]: 'saving' },
      ...also
    }))
    touch(flowId, SAVE_DELAY_MS)
  }

  /** Marks the flow as having an unsaved edit and starts (or restarts) the countdown to save it. */
  function touch(flowId: string, delay: number): void {
    dirty.add(flowId)
    editCount.set(flowId, (editCount.get(flowId) ?? 0) + 1)
    cancelTimer(flowId)
    timers.set(
      flowId,
      setTimeout(() => {
        timers.delete(flowId)
        void flush(flowId)
      }, delay)
    )
  }

  /** One trip to the engine with the newest copy. Settles true when the engine took it. */
  function save(flowId: string): Promise<boolean> {
    const flow = get().flows.find((f) => f.id === flowId)
    if (!flow) {
      dirty.delete(flowId)
      return Promise.resolve(true)
    }
    const seen = editCount.get(flowId) ?? 0
    const trip = (async (): Promise<boolean> => {
      try {
        const saved = await bridge.invoke('flows:save', flow)
        known.add(flowId)
        // Only a copy nobody edited since is confirmed. A newer edit has its own timer and its own trip.
        if ((editCount.get(flowId) ?? 0) === seen) {
          dirty.delete(flowId)
          set((s) => ({
            flows: s.flows.map((f) => (f.id === flowId ? { ...f, createdAt: saved.createdAt, updatedAt: saved.updatedAt } : f)),
            saveStates: without(s.saveStates, flowId),
            saveErrors: without(s.saveErrors, flowId)
          }))
        }
        return true
      } catch (err) {
        // A refusal of an older copy says nothing about a newer one: that copy is still waiting for its own answer.
        if ((editCount.get(flowId) ?? 0) === seen) {
          set((s) => ({
            saveStates: { ...s.saveStates, [flowId]: 'error' },
            saveErrors: { ...s.saveErrors, [flowId]: stripIpcPrefix(err) }
          }))
        }
        return false
      }
    })()
    inflight.set(flowId, trip)
    void trip.finally(() => {
      if (inflight.get(flowId) === trip) inflight.delete(flowId)
    })
    return trip
  }

  async function flush(flowId: string): Promise<boolean> {
    cancelTimer(flowId)
    for (;;) {
      if (deleting.has(flowId)) return true
      const running = inflight.get(flowId)
      if (running) {
        await running
        continue
      }
      if (!dirty.has(flowId)) return get().saveErrors[flowId] === undefined
      if (!(await save(flowId))) return false
    }
  }

  /**
   * Runs an action on a run, keeping the sentence of a refusal on that run and the buttons where they are.
   * Settles true when the engine took it.
   */
  async function actOnRun(runId: string, act: () => Promise<unknown>, busy?: 'merge' | 'discard'): Promise<boolean> {
    set((s) => ({
      runErrors: without(s.runErrors, runId),
      busyRuns: busy ? { ...s.busyRuns, [runId]: busy } : s.busyRuns
    }))
    try {
      await act()
      return true
    } catch (err) {
      set((s) => ({ runErrors: { ...s.runErrors, [runId]: stripIpcPrefix(err) } }))
      return false
    } finally {
      if (busy) set((s) => ({ busyRuns: without(s.busyRuns, runId) }))
    }
  }

  function rememberIsolated(run: FlowRun, seen: Record<string, true>): Record<string, true> {
    return run.worktree !== null || run.branch !== null ? (seen[run.id] ? seen : { ...seen, [run.id]: true }) : seen
  }

  /** What a new state of a run changes in the store: the run itself, what the window remembers of it, a pending approve or stop. */
  function applyRun(s: FlowsState, run: FlowRun): Partial<FlowsState> {
    return { runs: upsertRun(s.runs, run), isolatedSeen: rememberIsolated(run, s.isolatedSeen), acting: settleActing(s.acting, run) }
  }

  /** Asks the engine for one run's state again (after an action on it), in case its update event was missed. */
  async function refreshRun(runId: string): Promise<void> {
    try {
      const run = (await bridge.invoke('flows:runs')).find((r) => r.id === runId)
      if (run) set((s) => applyRun(s, run))
    } catch {
      // The update event is the main way the window learns; this is only a second look.
    }
  }

  /** Sends an approve or a stop once: a second click while the first is on its way does nothing. */
  async function signalRun(runId: string, kind: Acting['kind'], send: () => Promise<unknown>): Promise<void> {
    if (get().acting[runId]) return
    const waitingAt = get().runs.find((r) => r.id === runId)?.steps.find((step) => step.status === 'waiting')?.stepId ?? null
    set((s) => ({ acting: { ...s.acting, [runId]: { kind, stepId: kind === 'approve' ? waitingAt : null } } }))
    if (await actOnRun(runId, send)) await refreshRun(runId)
    else set((s) => ({ acting: without(s.acting, runId) }))
  }

  return {
    flows: [],
    runs: [],
    loaded: false,
    selectedFlowId: null,
    selectedStepId: null,
    saveStates: {},
    saveErrors: {},
    notices: {},
    runErrors: {},
    busyRuns: {},
    starting: {},
    acting: {},
    isolatedSeen: {},

    load: async () => {
      if (!subscribed) {
        subscribed = true
        bridge.on('flows:changed', (list) => {
          for (const flow of list) known.add(flow.id)
          set((s) => {
            const flows = reconcileFlows(s.flows, list, busyIds(), known)
            return { flows, ...normalizeSelection(flows, s.selectedFlowId, s.selectedStepId) }
          })
        })
        bridge.on('flows:run-update', (run) => {
          set((s) => applyRun(s, run))
        })
      }
      const [list, listed] = await Promise.all([bridge.invoke('flows:list'), bridge.invoke('flows:runs')])
      for (const flow of list) known.add(flow.id)
      set((s) => {
        const flows = reconcileFlows(s.flows, list, busyIds(), known)
        let seen = s.isolatedSeen
        for (const run of listed) seen = rememberIsolated(run, seen)
        return {
          flows,
          runs: mergeRuns(s.runs, listed),
          isolatedSeen: seen,
          loaded: true,
          ...normalizeSelection(flows, s.selectedFlowId, s.selectedStepId)
        }
      })
    },

    selectFlow: (id) => {
      const flow = get().flows.find((f) => f.id === id)
      set({ selectedFlowId: flow ? flow.id : null, selectedStepId: flow?.steps[0]?.id ?? null })
    },

    selectStep: (id) => set({ selectedStepId: id }),

    newFlow: () => {
      const id = `flow-${generateId()}`
      const flow: Flow = {
        id,
        name: DEFAULT_FLOW_NAME,
        brief: '',
        trigger: 'manual',
        isolate: false,
        steps: [],
        createdAt: now(),
        updatedAt: now()
      }
      set((s) => ({ flows: [...s.flows, flow], selectedFlowId: id, selectedStepId: null, saveStates: { ...s.saveStates, [id]: 'saving' } }))
      // A new flow is valid as it is (a name and no steps), so it is saved at once and is there after a restart.
      touch(id, 0)
      return id
    },

    deleteFlow: async (id) => {
      // From here no save of this flow goes out (the engine takes messages in order, so a save already sent still lands
      // before the delete). What was unsaved stays marked, in case the delete is refused.
      deleting.add(id)
      cancelTimer(id)
      try {
        await bridge.invoke('flows:delete', id)
      } catch (err) {
        deleting.delete(id)
        set((s) => ({ notices: { ...s.notices, [id]: stripIpcPrefix(err) } }))
        // The flow is still here, so what was waiting to be saved is saved after all.
        if (dirty.has(id)) touch(id, SAVE_DELAY_MS)
        return
      }
      deleting.delete(id)
      dirty.delete(id)
      known.delete(id)
      set((s) => {
        const flows = s.flows.filter((f) => f.id !== id)
        return {
          flows,
          saveStates: without(s.saveStates, id),
          saveErrors: without(s.saveErrors, id),
          notices: without(s.notices, id),
          ...normalizeSelection(flows, s.selectedFlowId === id ? null : s.selectedFlowId, s.selectedFlowId === id ? null : s.selectedStepId)
        }
      })
    },

    renameFlow: (name) => {
      const id = get().selectedFlowId
      if (id) edit(id, (flow) => ({ ...flow, name }))
    },

    setBrief: (brief) => {
      const id = get().selectedFlowId
      if (id) edit(id, (flow) => ({ ...flow, brief }))
    },

    setIsolate: (isolate) => {
      const id = get().selectedFlowId
      if (id) edit(id, (flow) => ({ ...flow, isolate }))
    },

    applyRecipe: (recipeId) => {
      const id = get().selectedFlowId
      const recipe = RECIPES.find((r) => r.id === recipeId)
      if (!id || !recipe) return
      const steps: FlowStep[] = recipe.steps.map((step) => ({ ...step, id: `step-${generateId()}` }))
      edit(id, (flow) => ({ ...flow, steps }), { selectedStepId: steps[0]?.id ?? null })
    },

    addStep: (afterStepId, kind, agent) => {
      const id = get().selectedFlowId
      if (!id) return
      const flow = get().flows.find((f) => f.id === id)
      if (!flow || flow.steps.length >= MAX_STEPS) return
      const step: FlowStep = {
        id: `step-${generateId()}`,
        kind,
        title: DEFAULT_TITLES[kind],
        agent: kind === 'agent' ? agent : null,
        prompt: '',
        command: ''
      }
      const after = afterStepId === null ? -1 : flow.steps.findIndex((s) => s.id === afterStepId)
      const at = afterStepId === null || after < 0 ? flow.steps.length : after + 1
      edit(id, (f) => ({ ...f, steps: [...f.steps.slice(0, at), step, ...f.steps.slice(at)] }), { selectedStepId: step.id })
    },

    removeStep: (stepId) => {
      const id = get().selectedFlowId
      const flow = get().flows.find((f) => f.id === id)
      if (!id || !flow) return
      const at = flow.steps.findIndex((s) => s.id === stepId)
      if (at < 0) return
      const steps = flow.steps.filter((s) => s.id !== stepId)
      // The neighbour takes over the inspector, so removing steps in a row needs no extra click.
      const next = steps[Math.min(at, steps.length - 1)]?.id ?? null
      edit(id, (f) => ({ ...f, steps }), { selectedStepId: get().selectedStepId === stepId ? next : get().selectedStepId })
    },

    moveStep: (stepId, direction) => {
      const id = get().selectedFlowId
      const flow = get().flows.find((f) => f.id === id)
      if (!id || !flow) return
      const at = flow.steps.findIndex((s) => s.id === stepId)
      const to = direction === 'left' ? at - 1 : at + 1
      if (at < 0 || to < 0 || to >= flow.steps.length) return
      const steps = [...flow.steps]
      const [moved] = steps.splice(at, 1)
      if (moved) steps.splice(to, 0, moved)
      edit(id, (f) => ({ ...f, steps }))
    },

    updateStep: (stepId, patch) => {
      const id = get().selectedFlowId
      if (id) edit(id, (flow) => ({ ...flow, steps: flow.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) }))
    },

    setStepKind: (stepId, kind, agent) => {
      const id = get().selectedFlowId
      const current = get().flows.find((f) => f.id === id)?.steps.find((s) => s.id === stepId)
      // Clicking the kind a step already has changes nothing, so it saves nothing.
      if (!id || !current || current.kind === kind) return
      edit(id, (flow) => ({
        ...flow,
        steps: flow.steps.map((s) =>
          s.id === stepId && s.kind !== kind
            ? { ...s, kind, title: titleAfterKindChange(s.title, s.kind, kind), agent: kind === 'agent' ? (s.agent ?? agent) : null }
            : s
        )
      }))
    },

    flush: (flowId) => flush(flowId),

    runFlow: async (flowId) => {
      if (get().starting[flowId]) return
      set((s) => ({ starting: { ...s.starting, [flowId]: true }, notices: without(s.notices, flowId) }))
      try {
        // The engine runs what it has saved, so the newest edits go first, and a flow it refuses does not start.
        if (!(await flush(flowId))) {
          const why = get().saveErrors[flowId] ?? 'The engine did not take the latest edits.'
          set((s) => ({ notices: { ...s.notices, [flowId]: `This flow cannot run yet. ${why}` } }))
          return
        }
        const run = await bridge.invoke('flows:run', flowId)
        // The run's own update may have come first and be newer than this first state, so a run already here stays as it is.
        set((s) => (s.runs.some((r) => r.id === run.id) ? {} : applyRun(s, run)))
      } catch (err) {
        set((s) => ({ notices: { ...s.notices, [flowId]: stripIpcPrefix(err) } }))
      } finally {
        set((s) => ({ starting: without(s.starting, flowId) }))
      }
    },

    stopRun: (runId) => signalRun(runId, 'stop', () => bridge.invoke('flows:stop', runId)),

    approveRun: (runId) => signalRun(runId, 'approve', () => bridge.invoke('flows:approve', runId)),

    mergeRun: async (runId) => {
      await actOnRun(
        runId,
        async () => {
          const result = await bridge.invoke('flows:merge', runId)
          if (!result.merged) throw new Error(result.summary || 'Nothing was merged.')
        },
        'merge'
      )
      await refreshRun(runId)
    },

    discardRun: async (runId) => {
      await actOnRun(runId, () => bridge.invoke('flows:discard', runId), 'discard')
      await refreshRun(runId)
    },

    dismissNotice: (flowId) => set((s) => ({ notices: without(s.notices, flowId) })),

    dismissRunError: (runId) => set((s) => ({ runErrors: without(s.runErrors, runId) }))
  }
})

// A window that is closing sends what is still waiting for its 600 ms, so the last edits are not lost with it.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', () => {
    for (const id of [...dirty]) void useFlows.getState().flush(id)
  })
}
