// Heats store: the list of heats and which one is selected.

import { create } from 'zustand'
import type { HeatState } from '@shared/heats'
import { bridge } from '../lib/bridge'

interface HeatsState {
  heats: HeatState[]
  selectedId: string | null
  merged: Record<string, string>
  loaded: boolean
  select: (id: string | null) => void
  setMerged: (id: string, summary: string) => void
  upsert: (heat: HeatState) => void
  load: () => Promise<void>
}

let subscribed = false

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  bridge.on('heats:update', (heat) => {
    useHeats.getState().upsert(heat)
  })
}

export const useHeats = create<HeatsState>((set) => ({
  heats: [],
  selectedId: null,
  merged: {},
  loaded: false,

  select: (id) => set({ selectedId: id }),

  setMerged: (id, summary) =>
    set((s) => ({
      merged: { ...s.merged, [id]: summary }
    })),

  upsert: (heat) =>
    set((s) => {
      const at = s.heats.findIndex((h) => h.id === heat.id)
      if (at === -1) return { heats: [heat, ...s.heats] }
      const heats = s.heats.slice()
      heats[at] = heat
      return { heats }
    }),

  load: async () => {
    ensureSubscribed()
    const heats = await bridge.invoke('heats:list')
    set({ heats, loaded: true })
  }
}))
