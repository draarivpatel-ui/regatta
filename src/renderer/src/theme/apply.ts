// Applies the chosen theme and accent to the app and its terminals.

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Prefs } from '@shared/types'
import type { ITheme } from '@xterm/xterm'
import { bridge } from '../lib/bridge'
import { setTerminalTheme } from '../terminal/registry'
import { TOKENS, SYSTEM_THEME, accentSet, resolveTheme, withAlpha, type ThemeDef } from '@shared/themes'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** True when macOS (or the renderer) asks for a dark interface. */
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
}

/** The theme a preference resolves to right now. */
export function currentTheme(prefs: Prefs | null): ThemeDef {
  return resolveTheme(prefs?.theme ?? SYSTEM_THEME, systemPrefersDark())
}

/** Writes the theme's colors onto the root element and hands them to xterm. */
export function applyTheme(theme: ThemeDef, accent: string | null): void {
  const root = document.documentElement
  const style = root.style
  for (const token of TOKENS) {
    const value = theme.colors[token]
    if (value) style.setProperty(`--color-${token}`, value)
  }
  // Electron paints the window background onto the body itself, so set it here too,
  // otherwise a light theme keeps the dark chrome behind the panes.
  document.body.style.background = theme.colors.bg
  const set = accent ? accentSet(accent, theme) : null
  if (set) {
    style.setProperty('--color-accent', set.accent)
    style.setProperty('--color-accent-strong', set.strong)
    style.setProperty('--color-accent-bright', set.bright)
    style.setProperty('--color-accent-ink', set.ink)
  }
  style.colorScheme = theme.kind
  const accentColor = set?.accent ?? theme.colors.accent
  setTerminalTheme({
    background: theme.terminal.background,
    foreground: theme.terminal.foreground,
    cursor: set?.accent ?? theme.terminal.cursor,
    cursorAccent: theme.terminal.cursorAccent,
    selectionBackground: withAlpha(accentColor, 0.28),
    black: theme.terminal.black,
    red: theme.terminal.red,
    green: theme.terminal.green,
    yellow: theme.terminal.yellow,
    blue: theme.terminal.blue,
    magenta: theme.terminal.magenta,
    cyan: theme.terminal.cyan,
    white: theme.terminal.white,
    brightBlack: theme.terminal.brightBlack,
    brightRed: theme.terminal.brightRed,
    brightGreen: theme.terminal.brightGreen,
    brightYellow: theme.terminal.brightYellow,
    brightBlue: theme.terminal.brightBlue,
    brightMagenta: theme.terminal.brightMagenta,
    brightCyan: theme.terminal.brightCyan,
    brightWhite: theme.terminal.brightWhite
  } satisfies ITheme)
}

/**
 * Reads the theme preferences and keeps the colors in sync.
 * Called once from App.tsx. Applies before the first paint, then follows every change.
 */
export function useAppTheme(): void {
  const prefs = useRef<Prefs | null>(null)
  const media = useRef<MediaQueryList | null>(null)
  const followsSystem = useRef(true)

  const paint = (): void => {
    const next = prefs.current
    applyTheme(resolveTheme(next?.theme ?? SYSTEM_THEME, media.current?.matches ?? systemPrefersDark()), next?.accent ?? null)
  }

  // Before paint on the first run, so the window never shows the wrong colors.
  useLayoutEffect(() => {
    let onChange: (() => void) | null = null
    if (typeof window.matchMedia === 'function') {
      const list = window.matchMedia(DARK_QUERY)
      media.current = list
      onChange = (): void => {
        if (followsSystem.current) paint()
      }
      list.addEventListener('change', onChange)
    }
    paint()
    return () => {
      if (onChange) media.current?.removeEventListener('change', onChange)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const store = (next: Prefs): void => {
      if (!alive) return
      prefs.current = next
      followsSystem.current = next.theme === SYSTEM_THEME
      paint()
    }
    const off = bridge.on('prefs:changed', store)
    void bridge
      .invoke('prefs:get')
      .then(store)
      .catch(() => undefined)
    return () => {
      alive = false
      off()
    }
  }, [])
}
