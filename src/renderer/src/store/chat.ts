// Conversations and crew members, shared by Chat mode and Agents mode.

import { create } from 'zustand'
import type { Access, Conversation, NewConversation, Teammate } from '@shared/chat'
import { bridge } from '../lib/bridge'

interface ChatState {
  conversations: Record<string, Conversation>
  teammates: Teammate[]
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  create: (opts: NewConversation) => Promise<Conversation | null>
  send: (id: string, text: string, access?: Access) => Promise<void>
  stop: (id: string) => Promise<void>
  approve: (id: string, requestId: string) => Promise<void>
  deny: (id: string, requestId: string) => Promise<void>
  remove: (id: string) => Promise<void>
  update: (id: string, patch: { title?: string; model?: string; agent?: Conversation['agent']; access?: Access }) => Promise<void>
  saveTeammate: (t: Omit<Teammate, 'id' | 'createdAt'> & { id?: string }) => Promise<Teammate | null>
  deleteTeammate: (id: string) => Promise<void>
  clearError: () => void
}

let subscribed = false

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export const useChat = create<ChatState>((set, get) => {
  const guard = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn()
    } catch (err) {
      set({ error: message(err) })
      return null
    }
  }
  return {
    conversations: {},
    teammates: [],
    loaded: false,
    error: null,

    load: async () => {
      if (!subscribed) {
        subscribed = true
        bridge.on('chat:changed', (c) => set((s) => ({ conversations: { ...s.conversations, [c.id]: c } })))
        bridge.on('chat:removed', ({ id }) =>
          set((s) => {
            const next = { ...s.conversations }
            delete next[id]
            return { conversations: next }
          })
        )
        bridge.on('teammates:changed', (teammates) => set({ teammates }))
      }
      const [list, teammates] = await Promise.all([bridge.invoke('chat:list'), bridge.invoke('teammates:list')])
      set({ conversations: Object.fromEntries(list.map((c) => [c.id, c])), teammates, loaded: true })
    },

    create: async (opts) => {
      const c = await guard(() => bridge.invoke('chat:create', opts))
      if (c) set((s) => ({ conversations: { ...s.conversations, [c.id]: c } }))
      return c
    },
    send: async (id, text, access) => {
      await guard(() => bridge.invoke('chat:send', id, text, access))
    },
    stop: async (id) => {
      await guard(() => bridge.invoke('chat:stop', id))
    },
    approve: async (id, requestId) => {
      await guard(() => bridge.invoke('chat:approve', id, requestId))
    },
    deny: async (id, requestId) => {
      await guard(() => bridge.invoke('chat:deny', id, requestId))
    },
    remove: async (id) => {
      await guard(() => bridge.invoke('chat:delete', id))
    },
    update: async (id, patch) => {
      const c = await guard(() => bridge.invoke('chat:update', id, patch))
      if (c) set((s) => ({ conversations: { ...s.conversations, [c.id]: c } }))
    },
    saveTeammate: async (t) => {
      const saved = await guard(() => bridge.invoke('teammates:save', t))
      if (saved) set({ teammates: [...get().teammates.filter((x) => x.id !== saved.id), saved] })
      return saved
    },
    deleteTeammate: async (id) => {
      await guard(() => bridge.invoke('teammates:delete', id))
      set({ teammates: get().teammates.filter((t) => t.id !== id) })
    },
    clearError: () => set({ error: null })
  }
})
