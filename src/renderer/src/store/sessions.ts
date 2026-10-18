import { create } from 'zustand'
import type { AgentKind, DetectedAgent, SessionInfo, WorkspaceInfo } from '@shared/types'
import { bridge } from '../lib/bridge'
import { useUi } from './ui'
import { disposeTerminal, ensureTerminal, terminalSize, writeToTerminal } from '../terminal/registry'

interface SessionsState {
  sessions: Record<string, SessionInfo>
  order: string[]
  focusedId: string | null
  agents: DetectedAgent[]
  workspace: WorkspaceInfo | null
  error: string | null
  ready: boolean
  init: () => Promise<void>
  createSession: (agent: AgentKind, cwd?: string) => Promise<SessionInfo | null>
  removeSession: (id: string) => Promise<void>
  restartSession: (id: string) => Promise<void>
  focus: (id: string | null) => void
  pickWorkspace: () => Promise<void>
  setWorkspace: (root: string) => Promise<void>
  dismissError: () => void
}

let subscribed = false

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: {},
  order: [],
  focusedId: null,
  agents: [],
  workspace: null,
  error: null,
  ready: false,

  init: async () => {
    if (!subscribed) {
      subscribed = true
      bridge.on('session:created', (info) => {
        ensureTerminal(info.id)
        set((s) => ({
          sessions: { ...s.sessions, [info.id]: info },
          order: s.order.includes(info.id) ? s.order : [...s.order, info.id],
          focusedId: info.id
        }))
      })
      bridge.on('session:status', ({ id, status }) =>
        set((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: { ...s.sessions[id]!, status } } } : s))
      )
      bridge.on('session:exit', ({ id, exitCode }) =>
        set((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: { ...s.sessions[id]!, exitCode } } } : s))
      )
      bridge.on('session:removed', ({ id }) => {
        disposeTerminal(id)
        set((s) => {
          const sessions = { ...s.sessions }
          delete sessions[id]
          const order = s.order.filter((o) => o !== id)
          return { sessions, order, focusedId: s.focusedId === id ? (order[order.length - 1] ?? null) : s.focusedId }
        })
      })
      bridge.on('workspace:changed', (workspace) => set({ workspace }))
      bridge.on('session:limit', ({ id, limit }) =>
        set((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: { ...s.sessions[id]!, limit } } } : s))
      )
      // A clicked notification asks us to show that pane.
      bridge.on('session:focus', ({ id }) => {
        useUi.getState().setMode('code')
        set({ focusedId: id })
      })
    }
    const [agents, workspace, existing] = await Promise.all([
      bridge.invoke('agents:list'),
      bridge.invoke('workspace:get'),
      bridge.invoke('session:list')
    ])
    // After a window reload, replay what each live session already printed.
    for (const info of existing) {
      ensureTerminal(info.id)
      writeToTerminal(info.id, await bridge.invoke('session:snapshot', info.id))
    }
    set({
      agents,
      workspace,
      sessions: Object.fromEntries(existing.map((i) => [i.id, i])),
      order: existing.map((i) => i.id),
      focusedId: existing[existing.length - 1]?.id ?? null,
      ready: true
    })
  },

  createSession: async (agent, cwd) => {
    const { cols, rows } = terminalSize(get().focusedId ?? '')
    try {
      return await bridge.invoke('session:create', { agent, cols, rows, cwd })
    } catch (err) {
      set({ error: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err) })
      return null
    }
  },

  removeSession: async (id) => {
    await bridge.invoke('session:remove', id)
  },

  restartSession: async (id) => {
    disposeTerminal(id)
    await bridge.invoke('session:restart', id)
  },

  focus: (id) => set({ focusedId: id }),

  pickWorkspace: async () => {
    const ws = await bridge.invoke('workspace:pick')
    if (ws) set({ workspace: ws })
  },

  setWorkspace: async (root) => {
    set({ workspace: await bridge.invoke('workspace:set', root) })
  },

  dismissError: () => set({ error: null })
}))
