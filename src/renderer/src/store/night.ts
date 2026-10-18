// Night watch store: the queue and the nights as main reports them, and which night and run are on screen.
//
// The state is main's own: every action stores the state main hands back, and the `night:update` event
// (sent as a night runs, and after every change) replaces it, so nothing here keeps a second copy of a run.

import { create } from 'zustand'
import type { NightState, NightTask } from '@shared/nightwatch'
import type { AgentKind } from '@shared/types'
import { cleanError } from '../overlays/night/helpers'
import { bridge } from '../lib/bridge'

/** A question waiting for an answer in the run card: merge or discard a run, or stop the running night. */
export interface Ask {
  kind: 'merge' | 'discard' | 'stop'
  /** The run id (merge, discard) or the night id (stop). */
  id: string
}

/** What is typed on Tonight and not yet queued. It lives here so that looking at a night and coming back keeps it. */
export interface Draft {
  prompt: string
  agent: AgentKind | null
  /** Names of the project's own checks the user turned off. Every one of them starts on. */
  off: string[]
  /** A check typed as a command. */
  custom: string
  /** The time field of the Start card, as a time field gives it. */
  time: string
}

export const EMPTY_DRAFT: Draft = { prompt: '', agent: null, off: [], custom: '', time: '01:00' }

interface NightStore {
  /** Null until main has answered the first time. */
  state: NightState | null
  /** 'tonight' or a night id. */
  selected: string
  selectedRun: string | null
  /** The last failure, in the words main used. Cleared by the next action and when the selection changes. */
  error: string | null
  /** What each merge made in this window said, by run id (the run's own note keeps it after a restart). */
  merged: Record<string, string>
  ask: Ask | null
  draft: Draft
  load: () => Promise<void>
  addTask: (task: Omit<NightTask, 'id' | 'createdAt'>) => Promise<boolean>
  removeTask: (id: string) => Promise<boolean>
  schedule: (startAt: number | 'now') => Promise<boolean>
  cancel: () => Promise<boolean>
  merge: (runId: string) => Promise<boolean>
  discard: (runId: string) => Promise<boolean>
  select: (id: string) => void
  selectRun: (id: string | null) => void
  setAsk: (ask: Ask | null) => void
  setDraft: (patch: Partial<Draft>) => void
  dismissError: () => void
}

let subscribed = false

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  bridge.on('night:update', (state) => useNight.setState({ state }))
}

export const useNight = create<NightStore>((set, get) => {
  /** Runs one request to main: its state is stored, a refusal becomes the error. True when main did it. */
  async function request(run: () => Promise<NightState>): Promise<boolean> {
    set({ error: null })
    try {
      set({ state: await run() })
      return true
    } catch (err) {
      set({ error: cleanError(err) })
      return false
    }
  }

  /** What main knows now, after a merge or discard (and after a refusal, which changes the run's note). */
  async function refresh(): Promise<void> {
    try {
      set({ state: await bridge.invoke('night:state') })
    } catch {
      // The next night:update brings it.
    }
  }

  return {
    state: null,
    selected: 'tonight',
    selectedRun: null,
    error: null,
    merged: {},
    ask: null,
    draft: EMPTY_DRAFT,

    load: async () => {
      subscribe()
      try {
        set({ state: await bridge.invoke('night:state') })
      } catch (err) {
        set({ error: cleanError(err) })
      }
    },

    addTask: (task) => request(() => bridge.invoke('night:addTask', task)),

    removeTask: (id) => request(() => bridge.invoke('night:removeTask', id)),

    schedule: async (startAt) => {
      const known = new Set(get().state?.nights.map((n) => n.id))
      const ok = await request(() => bridge.invoke('night:schedule', startAt))
      // "Start now" goes straight to the night that began, so its progress is on screen.
      const fresh = get().state?.nights.find((n) => !known.has(n.id))
      if (ok && startAt === 'now' && fresh) set({ selected: fresh.id, selectedRun: null })
      return ok
    },

    // A night that had not started gives its tasks back to the queue itself, in the same save that cancels it.
    cancel: () => request(() => bridge.invoke('night:cancel')),

    merge: async (runId) => {
      set({ error: null, ask: null })
      try {
        const result = await bridge.invoke('night:merge', runId)
        set((s) => ({ merged: { ...s.merged, [runId]: result.summary } }))
        await refresh()
        return true
      } catch (err) {
        set({ error: cleanError(err) })
        await refresh()
        return false
      }
    },

    discard: async (runId) => {
      set({ ask: null })
      const ok = await request(() => bridge.invoke('night:discard', runId))
      if (!ok) await refresh()
      return ok
    },

    select: (id) => set({ selected: id, selectedRun: null, error: null, ask: null }),

    selectRun: (id) => set({ selectedRun: id, error: null, ask: null }),

    setAsk: (ask) => set({ ask }),

    setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),

    dismissError: () => set({ error: null })
  }
})
