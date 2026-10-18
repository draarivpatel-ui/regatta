// Tasks store: the tracked outcomes under Agents mode > Automate > Tasks.

import { create } from 'zustand'
import type { NewTask, Task, TaskPatch } from '@shared/tasks'
import { bridge } from '../../../../lib/bridge'

interface TasksState {
  tasks: Task[]
  error: string | null
  loaded: boolean
  load: () => Promise<void>
  /** Returns the saved list, or null when the main process refused. */
  create: (task: NewTask) => Promise<Task[] | null>
  update: (id: string, patch: TaskPatch) => Promise<Task[] | null>
  remove: (id: string) => Promise<void>
  run: (id: string) => Promise<void>
  markDone: (id: string) => Promise<void>
  addToTonight: (id: string) => Promise<void>
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
  // A task moves when its heat moves, and the main process pushes the new list.
  bridge.on('tasks:changed', (tasks) => {
    useTasks.setState({ tasks })
  })
}

export const useTasks = create<TasksState>((set) => ({
  tasks: [],
  error: null,
  loaded: false,

  load: async () => {
    ensureSubscribed()
    try {
      const tasks = await bridge.invoke('tasks:list')
      set({ tasks, loaded: true, error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  create: async (task) => {
    try {
      const tasks = await bridge.invoke('tasks:create', task)
      set({ tasks, error: null })
      return tasks
    } catch (err) {
      set({ error: message(err) })
      return null
    }
  },

  update: async (id, patch) => {
    try {
      const tasks = await bridge.invoke('tasks:update', id, patch)
      set({ tasks, error: null })
      return tasks
    } catch (err) {
      set({ error: message(err) })
      return null
    }
  },

  remove: async (id) => {
    try {
      set({ tasks: await bridge.invoke('tasks:remove', id), error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  run: async (id) => {
    try {
      set({ tasks: await bridge.invoke('tasks:run', id), error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  markDone: async (id) => {
    try {
      set({ tasks: await bridge.invoke('tasks:done', id), error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  addToTonight: async (id) => {
    try {
      set({ tasks: await bridge.invoke('tasks:tonight', id), error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  clearError: () => set({ error: null })
}))
