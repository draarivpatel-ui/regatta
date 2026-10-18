// One xterm instance per session, kept outside React so terminals survive layout and mode changes.
// Panes attach a terminal's host element to their body and detach it when they unmount.

import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { bridge } from '../lib/bridge'

export const TERM_THEME: ITheme = {
  background: '#0b0f15',
  foreground: '#d7dee7',
  cursor: '#5eead4',
  cursorAccent: '#0b0f15',
  selectionBackground: 'rgba(45, 212, 191, 0.28)',
  black: '#1b222c',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#2dd4bf',
  white: '#d7dee7',
  brightBlack: '#5b6573',
  brightRed: '#fca5a5',
  brightGreen: '#6ee7b7',
  brightYellow: '#fcd34d',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#5eead4',
  brightWhite: '#f8fafc'
}

interface Entry {
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  opened: boolean
  cols: number
  rows: number
}

const entries = new Map<string, Entry>()
let fontSize = 12.5
let theme: ITheme = TERM_THEME

function create(id: string): Entry {
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Monaco, monospace",
    fontSize,
    lineHeight: 1.2,
    theme,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    macOptionIsMeta: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const host = document.createElement('div')
  host.className = 'term-host'
  host.dataset['session'] = id
  term.onData((data) => bridge.send('session:write', id, data))
  const entry: Entry = { term, fit, host, opened: false, cols: 0, rows: 0 }
  entries.set(id, entry)
  return entry
}

export function ensureTerminal(id: string): Entry {
  return entries.get(id) ?? create(id)
}

export function writeToTerminal(id: string, data: string): void {
  ensureTerminal(id).term.write(data)
}

export function attachTerminal(id: string, container: HTMLElement): void {
  const e = ensureTerminal(id)
  if (e.host.parentElement !== container) container.appendChild(e.host)
  if (!e.opened) {
    e.term.open(e.host)
    e.opened = true
  }
  fitTerminal(id)
}

export function detachTerminal(id: string, container: HTMLElement): void {
  const e = entries.get(id)
  if (e && e.host.parentElement === container) container.removeChild(e.host)
}

export function fitTerminal(id: string): void {
  const e = entries.get(id)
  if (!e || !e.opened || !e.host.isConnected || e.host.clientWidth < 20) return
  try {
    e.fit.fit()
  } catch {
    return
  }
  if (e.term.cols !== e.cols || e.term.rows !== e.rows) {
    e.cols = e.term.cols
    e.rows = e.term.rows
    bridge.send('session:resize', id, e.cols, e.rows)
  }
}

export function focusTerminal(id: string): void {
  entries.get(id)?.term.focus()
}

export function terminalSize(id: string): { cols: number; rows: number } {
  const e = entries.get(id)
  return e && e.cols > 0 ? { cols: e.cols, rows: e.rows } : { cols: 100, rows: 30 }
}

export function terminalText(id: string): string {
  const e = entries.get(id)
  if (!e) return ''
  const buf = e.term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  return lines.join('\n').replace(/\n+$/, '')
}

export function clearTerminal(id: string): void {
  entries.get(id)?.term.clear()
}

export function disposeTerminal(id: string): void {
  const e = entries.get(id)
  if (!e) return
  e.term.dispose()
  e.host.remove()
  entries.delete(id)
}

/** Recolors every terminal now and the ones opened later (themes package). */
export function setTerminalTheme(next: ITheme): void {
  theme = next
  for (const e of entries.values()) e.term.options.theme = next
}

export function setTerminalFontSize(size: number): void {
  fontSize = size
  for (const [id, e] of entries) {
    e.term.options.fontSize = size
    fitTerminal(id)
  }
}

// All pty output flows straight into the matching terminal, without touching React.
bridge.on('session:data', ({ id, data }) => writeToTerminal(id, data))

// Lets e2e tests read what a pane shows.
;(window as unknown as { __regattaText: typeof terminalText }).__regattaText = terminalText
