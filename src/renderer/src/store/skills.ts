// Settings > Skills, shared by the Settings section and the crew member picker.
// Select raw state (arrays, functions) in components: a selector that builds a new
// array makes Zustand 5 render forever.

import { create } from 'zustand'
import type { ImportableSkill, Skill } from '@shared/chat'
import { bridge } from '../lib/bridge'

interface SkillsState {
  skills: Skill[]
  importable: ImportableSkill[]
  error: string | null
  load: () => Promise<void>
  save: (skill: Pick<Skill, 'name' | 'description' | 'instructions'> & { id?: string }) => Promise<Skill[] | null>
  remove: (id: string) => Promise<void>
  loadImportable: () => Promise<void>
  importFrom: (path: string) => Promise<Skill[] | null>
  clearError: () => void
}

let subscribed = false

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export const useSkills = create<SkillsState>((set) => {
  const guard = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn()
    } catch (err) {
      set({ error: message(err) })
      return null
    }
  }
  return {
    skills: [],
    importable: [],
    error: null,

    load: async () => {
      if (!subscribed) {
        subscribed = true
        bridge.on('skills:changed', (skills) => set({ skills }))
      }
      const list = await guard(() => bridge.invoke('skills:list'))
      if (list) set({ skills: list })
    },

    save: async (skill) => guard(() => bridge.invoke('skills:save', skill)),
    remove: async (id) => {
      await guard(() => bridge.invoke('skills:remove', id))
    },
    loadImportable: async () => {
      const list = await guard(() => bridge.invoke('skills:importable'))
      if (list) set({ importable: list })
    },
    importFrom: async (path) => guard(() => bridge.invoke('skills:import', path)),
    clearError: () => set({ error: null })
  }
})
