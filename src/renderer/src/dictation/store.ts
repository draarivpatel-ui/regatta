// The floating pill's state. The controller in ./controller writes, DictationPill reads.

import { create } from 'zustand'

export type DictationPhase = 'idle' | 'listening' | 'transcribing' | 'added' | 'cancelled' | 'error'

interface DictationUi {
  phase: DictationPhase
  startedAt: number
  /** Live microphone level, 0 to 1. */
  level: number
  /** What the pill says: the added note, "Cancelled", or an error to dismiss. */
  message: string
  /** Dictated text kept when no composer or pane had focus, with a Copy button. */
  keptText: string | null
  /** True when the error offers a Retry, because the microphone never opened. */
  retry: boolean
  set: (patch: Partial<Pick<DictationUi, 'phase' | 'startedAt' | 'level' | 'message' | 'keptText' | 'retry'>>) => void
  reset: () => void
}

export const useDictation = create<DictationUi>((set) => ({
  phase: 'idle',
  startedAt: 0,
  level: 0,
  message: '',
  keptText: null,
  retry: false,
  set: (patch) => set(patch),
  reset: () => set({ phase: 'idle', level: 0, message: '', keptText: null, retry: false })
}))
