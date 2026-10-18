import { create } from 'zustand'
import type { LayoutId } from '@shared/layouts'

export type Mode = 'agents' | 'code' | 'chat' | 'flows' | 'video' | 'board'
export type SidePanel = 'files' | 'find' | 'git' | 'browser' | 'thread' | 'flows' | 'simulator'
export type Overlay = 'inbox' | 'broadcast' | 'quick' | 'settings' | 'launchset' | 'skipper' | 'checkpoints' | 'night' | 'welcome' | null
export type Density = 'auto' | 'comfortable' | 'compact' | 'dense'

export const DENSITY_FONT: Record<Exclude<Density, 'auto'>, number> = {
  comfortable: 13.5,
  compact: 12.5,
  dense: 11.5
}

interface UiState {
  mode: Mode
  layoutId: LayoutId
  /** True once the user picks a layout; until then it grows with the number of panes. */
  layoutPinned: boolean
  maximizedId: string | null
  sidebarOpen: boolean
  sidebarTab: 'preview' | 'fleet'
  sidePanel: SidePanel | null
  overlay: Overlay
  density: Density
  /** Session whose checkpoints are shown. */
  checkpointsFor: string | null
  openCheckpoints: (sessionId: string) => void
  setMode: (mode: Mode) => void
  setLayout: (id: LayoutId, pinned?: boolean) => void
  toggleMaximize: (id: string) => void
  setSidebarOpen: (open: boolean) => void
  setSidebarTab: (tab: 'preview' | 'fleet') => void
  toggleSidePanel: (panel: SidePanel) => void
  openOverlay: (overlay: Overlay) => void
  setDensity: (density: Density) => void
}

export const useUi = create<UiState>((set) => ({
  mode: 'code',
  layoutId: 'four',
  layoutPinned: false,
  maximizedId: null,
  sidebarOpen: true,
  sidebarTab: 'fleet',
  sidePanel: null,
  overlay: null,
  density: 'auto',
  checkpointsFor: null,
  openCheckpoints: (sessionId) => set({ checkpointsFor: sessionId, overlay: 'checkpoints' }),
  setMode: (mode) => set({ mode }),
  setLayout: (layoutId, pinned = true) => set({ layoutId, layoutPinned: pinned, maximizedId: null }),
  toggleMaximize: (id) => set((s) => ({ maximizedId: s.maximizedId === id ? null : id })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSidebarTab: (sidebarTab) => set({ sidebarTab, sidebarOpen: true }),
  toggleSidePanel: (panel) => set((s) => ({ sidePanel: s.sidePanel === panel ? null : panel })),
  openOverlay: (overlay) => set({ overlay }),
  setDensity: (density) => set({ density })
}))
