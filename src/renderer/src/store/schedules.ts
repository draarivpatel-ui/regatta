// Schedules store: the list of timer schedules under Agents mode > Automate.

import { create } from 'zustand'
import type { NewSchedule, Schedule } from '@shared/schedules'
import { bridge } from '../lib/bridge'

interface SchedulesState {
  schedules: Schedule[]
  error: string | null
  loaded: boolean
  load: () => Promise<void>
  save: (schedule: NewSchedule) => Promise<Schedule[] | null>
  remove: (id: string) => Promise<void>
  runNow: (id: string) => Promise<void>
  clearError: () => void
}

let subscribed = false

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  bridge.on('schedules:changed', (schedules) => {
    useSchedules.setState({ schedules })
  })
}

export const useSchedules = create<SchedulesState>((set) => ({
  schedules: [],
  error: null,
  loaded: false,

  load: async () => {
    ensureSubscribed()
    try {
      const schedules = await bridge.invoke('schedules:list')
      set({ schedules, loaded: true, error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  save: async (schedule) => {
    try {
      const schedules = await bridge.invoke('schedules:save', schedule)
      set({ schedules, error: null })
      return schedules
    } catch (err) {
      set({ error: message(err) })
      return null
    }
  },

  remove: async (id) => {
    try {
      const schedules = await bridge.invoke('schedules:remove', id)
      set({ schedules, error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  runNow: async (id) => {
    try {
      const schedules = await bridge.invoke('schedules:runNow', id)
      set({ schedules, error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  clearError: () => set({ error: null })
}))
