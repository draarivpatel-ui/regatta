// App-wide keyboard shortcuts and application menu commands. Both run through runAppCommand.
// Key presses are handled in the capture phase so a focused terminal does not swallow them.

import { useEffect, useRef } from 'react'
import type { AppCommand } from '@shared/ipc'
import { useUi, type Mode } from '../store/ui'
import { useSessions } from '../store/sessions'
import { bridge } from '../lib/bridge'
import { toggleDictation } from '../dictation/controller'

const MODES: Mode[] = ['agents', 'code', 'chat', 'flows', 'video']

/** Runs one app command. Returns false when the command does not apply right now. */
export function runAppCommand(command: AppCommand, confirmClose = false): boolean {
  const ui = useUi.getState()
  switch (command) {
    case 'settings':
      ui.openOverlay('settings')
      return true
    case 'quick':
      ui.openOverlay(ui.overlay === 'quick' ? null : 'quick')
      return true
    case 'inbox':
      ui.openOverlay('inbox')
      return true
    case 'broadcast':
      ui.openOverlay('broadcast')
      return true
    case 'crew':
      ui.setMode('code')
      ui.openOverlay('launchset')
      return true
    case 'new-pane':
      if (ui.mode !== 'code') ui.setMode('code')
      window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-testid=new-pane-button]')?.click(), 0)
      return true
    case 'find':
      if (ui.sidePanel !== 'find') ui.toggleSidePanel('find')
      return true
    case 'maximize': {
      // Inside a dialog Cmd+Enter belongs to the dialog (for example Broadcast's send).
      if (ui.overlay) return false
      const id = useSessions.getState().focusedId
      if (!id) return false
      ui.toggleMaximize(id)
      return true
    }
    case 'next-pane':
    case 'previous-pane':
      // Leave these to an open dialog.
      if (ui.overlay) return false
      focusNeighbourPane(command === 'next-pane')
      return true
    case 'close-pane':
      if (ui.overlay) return false
      closeFocusedPane(confirmClose)
      return true
    case 'dictate':
      return toggleDictation()
  }
}

export function useShortcuts(): void {
  const confirmClose = useRef(false)

  // The confirm-close pref lives in main, so read it once and track changes.
  useEffect(() => {
    void bridge
      .invoke('prefs:get')
      .then((prefs) => {
        confirmClose.current = prefs.confirmClosePane
      })
      .catch(() => undefined)
    const offPrefs = bridge.on('prefs:changed', (prefs) => {
      confirmClose.current = prefs.confirmClosePane
    })
    const offMenu = bridge.on('app:command', ({ command }) => {
      runAppCommand(command, confirmClose.current)
    })
    return () => {
      offPrefs()
      offMenu()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      const n = Number(e.key)
      let handled: boolean
      if (n >= 1 && n <= 5) {
        useUi.getState().setMode(MODES[n - 1]!)
        handled = true
      } else {
        const command = commandForKey(key, e.shiftKey)
        handled = command ? runAppCommand(command, confirmClose.current) : false
      }
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

function commandForKey(key: string, shift: boolean): AppCommand | null {
  if (shift) return key === 'f' ? 'find' : key === ' ' ? 'dictate' : null
  switch (key) {
    case 'k':
      return 'quick'
    case 'b':
      return 'broadcast'
    case 'i':
      return 'inbox'
    case ',':
      return 'settings'
    case 't':
      return 'new-pane'
    case 'enter':
      return 'maximize'
    case ']':
      return 'next-pane'
    case '[':
      return 'previous-pane'
    case 'w':
      return 'close-pane'
    default:
      return null
  }
}

/** Focuses the pane after (or before) the focused one, wrapping around at the ends. */
function focusNeighbourPane(forward: boolean): void {
  const { order, focusedId, focus } = useSessions.getState()
  if (order.length === 0) return
  const at = focusedId ? order.indexOf(focusedId) : -1
  const next = (at + (forward ? 1 : -1) + order.length) % order.length
  focus(order[next]!)
}

/** Closes the focused pane, asking first when the user turned that preference on. */
function closeFocusedPane(confirm: boolean): void {
  const { focusedId, removeSession } = useSessions.getState()
  if (!focusedId) return
  if (confirm && !window.confirm('Close this pane? The agent stops running.')) return
  void removeSession(focusedId)
}
