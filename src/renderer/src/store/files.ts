// Lets any feature ask the Files panel to open a file at a line (Find uses this).

import { create } from 'zustand'
import { useUi } from './ui'

interface OpenRequest {
  path: string
  line: number
  /** Changes on every request so the same file can be asked for twice. */
  nonce: number
}

interface FilesState {
  openRequest: OpenRequest | null
  /** Shows the Files panel and asks it to open `path` at `line` (1-based). */
  requestOpen: (path: string, line?: number) => void
}

export const useFiles = create<FilesState>((set) => ({
  openRequest: null,
  requestOpen: (path, line = 1) => {
    const ui = useUi.getState()
    if (ui.sidePanel !== 'files') ui.toggleSidePanel('files')
    set({ openRequest: { path, line, nonce: Date.now() + Math.random() } })
  }
}))
