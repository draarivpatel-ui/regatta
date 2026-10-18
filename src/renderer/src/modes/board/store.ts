// Board store (renderer): the two things the board keeps of its own (archived ids and send-back
// notes), loaded from main and updated from the state each action hands back. Everything else on the
// board comes from the engines' own stores.

import { create } from 'zustand'
import type { BoardData } from '@shared/board'
import { bridge } from '../../lib/bridge'

interface BoardState {
  data: BoardData
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  archive: (id: string) => Promise<void>
  unarchive: (id: string) => Promise<void>
  sendBack: (id: string, note: string) => Promise<boolean>
  clearError: () => void
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const EMPTY: BoardData = { archived: [], notes: {} }

export const useBoard = create<BoardState>((set) => ({
  data: EMPTY,
  loaded: false,
  error: null,

  load: async () => {
    try {
      set({ data: await bridge.invoke('board:state'), loaded: true, error: null })
    } catch (err) {
      set({ error: message(err), loaded: true })
    }
  },

  archive: async (id) => {
    try {
      set({ data: await bridge.invoke('board:archive', id), error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  unarchive: async (id) => {
    try {
      set({ data: await bridge.invoke('board:unarchive', id), error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  sendBack: async (id, note) => {
    try {
      set({ data: await bridge.invoke('board:sendBack', id, note), error: null })
      return true
    } catch (err) {
      set({ error: message(err) })
      return false
    }
  },

  clearError: () => set({ error: null })
}))
