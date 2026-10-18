// Video store: the list of video projects and the actions on each `video:*` channel.
// Engine: src/main/video/.

import { create } from 'zustand'
import type { NewVideo, PointNote, VideoProject } from '@shared/video'
import { bridge } from '../lib/bridge'

/** The three tabs of the right column. */
export type VideoTab = 'plan' | 'activity' | 'render'

interface VideoState {
  /** Projects by id. Select this raw record and build any list in the component. */
  videos: Record<string, VideoProject>
  /** The video the screen shows, or null when none is picked. */
  selectedId: string | null
  /** Which tab of the right column is open. The user picks it; a finished build never moves it. */
  tab: VideoTab
  /** PLAN.md as last read from the file or saved to it, by video id. The Plan tab shows it at once when it opens again. */
  plans: Record<string, string>
  /** Plan text typed and not saved yet, by video id, so a look at another tab or another video does not lose it. */
  drafts: Record<string, string>
  /** The last error from main, shown inline where the action happened. */
  error: string | null
  loaded: boolean
  /** ffmpeg's path, or null when it is not installed. Filled by loadFFmpeg. */
  ffmpeg: string | null | undefined
  load: () => Promise<void>
  select: (id: string | null) => void
  setTab: (tab: VideoTab) => void
  /** Keeps (or with null, drops) the unsaved plan text for a video. */
  setDraft: (id: string, text: string | null) => void
  clearError: () => void
  setError: (message: string) => void
  loadFFmpeg: () => Promise<void>
  create: (opts: NewVideo) => Promise<VideoProject | null>
  plan: (id: string) => Promise<void>
  build: (id: string) => Promise<void>
  readPlan: (id: string) => Promise<string>
  /** True when the plan was saved. A failure lands in `error`. */
  savePlan: (id: string, text: string, tell: boolean) => Promise<boolean>
  changeAt: (id: string, note: PointNote) => Promise<void>
  undo: (id: string) => Promise<void>
  stop: (id: string) => Promise<void>
  render: (id: string) => Promise<void>
  reveal: (id: string, renderId: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

let subscribed = false

/** The bridge wraps main's throws in a long prefix; show the plain sentence. */
function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function upsert(state: VideoState, video: VideoProject): Record<string, VideoProject> {
  return { ...state.videos, [video.id]: video }
}

/** video:changed and video:removed arrive from main for every save; subscribe once, ever. */
function ensureSubscribed(set: (partial: Partial<VideoState>) => void, get: () => VideoState): void {
  if (subscribed) return
  subscribed = true
  bridge.on('video:changed', (video) => {
    set({ videos: upsert(get(), video) })
  })
  bridge.on('video:removed', ({ id }) => {
    const state = get()
    if (!(id in state.videos)) return
    const videos = { ...state.videos }
    delete videos[id]
    const drafts = { ...state.drafts }
    delete drafts[id]
    const plans = { ...state.plans }
    delete plans[id]
    set({ videos, drafts, plans, selectedId: state.selectedId === id ? null : state.selectedId })
  })
}

export const useVideo = create<VideoState>((set, get) => ({
  videos: {},
  selectedId: null,
  tab: 'plan',
  plans: {},
  drafts: {},
  error: null,
  loaded: false,
  ffmpeg: undefined,

  load: async () => {
    ensureSubscribed(set, get)
    try {
      const list = await bridge.invoke('video:list')
      set({ videos: Object.fromEntries(list.map((video) => [video.id, video])), loaded: true, error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  select: (id) => set({ selectedId: id, error: null }),

  setTab: (tab) => set({ tab, error: null }),

  setDraft: (id, text) =>
    set((state) => {
      if (text === null) {
        if (!(id in state.drafts)) return state
        const drafts = { ...state.drafts }
        delete drafts[id]
        return { drafts }
      }
      return { drafts: { ...state.drafts, [id]: text } }
    }),

  clearError: () => set({ error: null }),

  setError: (msg) => set({ error: msg }),

  loadFFmpeg: async () => {
    try {
      set({ ffmpeg: await bridge.invoke('video:ffmpeg') })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  create: async (opts) => {
    try {
      const video = await bridge.invoke('video:create', opts)
      set((state) => ({ videos: upsert(state, video), selectedId: video.id, error: null }))
      return video
    } catch (err) {
      set({ error: message(err) })
      return null
    }
  },

  plan: async (id) => {
    try {
      const video = await bridge.invoke('video:plan', id)
      set((state) => ({ videos: upsert(state, video) }))
    } catch (err) {
      set({ error: message(err) })
    }
  },

  build: async (id) => {
    try {
      const video = await bridge.invoke('video:build', id)
      set((state) => ({ videos: upsert(state, video) }))
    } catch (err) {
      set({ error: message(err) })
    }
  },

  readPlan: async (id) => {
    try {
      const body = await bridge.invoke('video:readPlan', id)
      set((state) => ({ plans: { ...state.plans, [id]: body } }))
      return body
    } catch (err) {
      set({ error: message(err) })
      return ''
    }
  },

  savePlan: async (id, text, tell) => {
    // The file is written before any agent turn starts, so for the turn's whole length it holds this text. A save that
    // fails leaves the file as it was; the caller reads it again, which puts the truth back here.
    set((state) => ({ plans: { ...state.plans, [id]: text } }))
    try {
      const video = await bridge.invoke('video:savePlan', id, text, tell)
      set((state) => ({ videos: upsert(state, video) }))
      return true
    } catch (err) {
      set({ error: message(err) })
      return false
    }
  },

  changeAt: async (id, note) => {
    try {
      const video = await bridge.invoke('video:changeAt', id, note)
      set((state) => ({ videos: upsert(state, video) }))
    } catch (err) {
      set({ error: message(err) })
    }
  },

  undo: async (id) => {
    try {
      const video = await bridge.invoke('video:undo', id)
      set((state) => ({ videos: upsert(state, video) }))
    } catch (err) {
      set({ error: message(err) })
    }
  },

  stop: async (id) => {
    try {
      await bridge.invoke('video:stop', id)
    } catch (err) {
      set({ error: message(err) })
    }
  },

  render: async (id) => {
    try {
      const video = await bridge.invoke('video:render', id)
      set((state) => ({ videos: upsert(state, video) }))
    } catch (err) {
      set({ error: message(err) })
    }
  },

  reveal: async (id, renderId) => {
    try {
      await bridge.invoke('video:reveal', id, renderId)
    } catch (err) {
      set({ error: message(err) })
    }
  },

  remove: async (id) => {
    try {
      await bridge.invoke('video:remove', id)
    } catch (err) {
      set({ error: message(err) })
    }
  }
}))
