// The ten Regatta themes, the contrast math behind a custom accent, and the rule that
// maps a preference to a theme. Pure data and pure functions, no DOM.

/** Every color variable in styles/theme.css, without the `--color-` prefix. */
export const TOKENS = [
  'bg',
  'chrome',
  'panel',
  'raised',
  'hover',
  'press',
  'line',
  'line-strong',
  'fg',
  'muted',
  'faint',
  'accent',
  'accent-strong',
  'accent-bright',
  'accent-ink',
  'term',
  'st-starting',
  'st-working',
  'st-waiting',
  'st-idle',
  'st-quiet',
  'st-done',
  'st-failed'
] as const

export type Token = (typeof TOKENS)[number]

/** Terminal colors. The ANSI keys match the ones xterm expects. */
export interface TerminalColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  /** Hex here, turned into rgba when it reaches xterm. */
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export type ThemeKind = 'dark' | 'light'

export interface ThemeDef {
  id: string
  name: string
  kind: ThemeKind
  colors: Record<Token, string>
  terminal: TerminalColors
}

/** The pref value that means "follow macOS light or dark". */
export const SYSTEM_THEME = 'system'

const harbor: ThemeDef = {
  id: 'harbor',
  name: 'Harbor',
  kind: 'dark',
  colors: {
    bg: '#0b0e13',
    chrome: '#0d1117',
    panel: '#10151c',
    raised: '#151b24',
    hover: '#1a212b',
    press: '#202834',
    line: '#1d242e',
    'line-strong': '#2a3340',
    fg: '#e7ebf0',
    muted: '#9aa4b2',
    faint: '#687282',
    accent: '#2dd4bf',
    'accent-strong': '#14b8a6',
    'accent-bright': '#5eead4',
    'accent-ink': '#042f2b',
    term: '#0b0f15',
    'st-starting': '#a5b4fc',
    'st-working': '#60a5fa',
    'st-waiting': '#fbbf24',
    'st-idle': '#34d399',
    'st-quiet': '#7d8796',
    'st-done': '#94a3b8',
    'st-failed': '#f87171'
  },
  terminal: {
    background: '#0b0f15',
    foreground: '#d7dee7',
    cursor: '#5eead4',
    cursorAccent: '#0b0f15',
    selectionBackground: '#2dd4bf',
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
}

const deep: ThemeDef = {
  id: 'deep',
  name: 'Deep',
  kind: 'dark',
  colors: {
    bg: '#06080c',
    chrome: '#090d13',
    panel: '#0c1119',
    raised: '#121924',
    hover: '#18212e',
    press: '#1f2a39',
    line: '#151d28',
    'line-strong': '#232f40',
    fg: '#e6ecf5',
    muted: '#98a5ba',
    faint: '#657490',
    accent: '#2bc6e0',
    'accent-strong': '#129cb8',
    'accent-bright': '#6ee2f2',
    'accent-ink': '#032028',
    term: '#080b11',
    'st-starting': '#a7b6f7',
    'st-working': '#58a0f5',
    'st-waiting': '#f6bd41',
    'st-idle': '#3ad49d',
    'st-quiet': '#78869a',
    'st-done': '#94a1b5',
    'st-failed': '#f47777'
  },
  terminal: {
    background: '#080b11',
    foreground: '#d9e2ee',
    cursor: '#6ee2f2',
    cursorAccent: '#080b11',
    selectionBackground: '#2bc6e0',
    black: '#18202b',
    red: '#f47777',
    green: '#3ad49d',
    yellow: '#f6bd41',
    blue: '#58a0f5',
    magenta: '#b794f6',
    cyan: '#2bc6e0',
    white: '#d9e2ee',
    brightBlack: '#57657a',
    brightRed: '#fca8a8',
    brightGreen: '#6fe9bd',
    brightYellow: '#fad268',
    brightBlue: '#8bc0fb',
    brightMagenta: '#cfb2f9',
    brightCyan: '#7de7f5',
    brightWhite: '#f6f9fc'
  }
}

const graphite: ThemeDef = {
  id: 'graphite',
  name: 'Graphite',
  kind: 'dark',
  colors: {
    bg: '#0c0c0e',
    chrome: '#111113',
    panel: '#151517',
    raised: '#1b1b1f',
    hover: '#222226',
    press: '#292930',
    line: '#1e1e23',
    'line-strong': '#2d2d35',
    fg: '#e9e9ed',
    muted: '#9c9ca6',
    faint: '#6b6b76',
    accent: '#5b8dfb',
    'accent-strong': '#3a6be0',
    'accent-bright': '#8db2fd',
    'accent-ink': '#04122e',
    term: '#0f0f12',
    'st-starting': '#aab3f0',
    'st-working': '#5f9dfb',
    'st-waiting': '#eab83e',
    'st-idle': '#38c78f',
    'st-quiet': '#82828c',
    'st-done': '#98989f',
    'st-failed': '#ef7070'
  },
  terminal: {
    background: '#0f0f12',
    foreground: '#dededf',
    cursor: '#8db2fd',
    cursorAccent: '#0f0f12',
    selectionBackground: '#5b8dfb',
    black: '#1c1c20',
    red: '#ef7070',
    green: '#38c78f',
    yellow: '#eab83e',
    blue: '#5f9dfb',
    magenta: '#b58cf0',
    cyan: '#63c3d6',
    white: '#dededf',
    brightBlack: '#5a5a63',
    brightRed: '#f7a3a3',
    brightGreen: '#63dcae',
    brightYellow: '#f2cc6a',
    brightBlue: '#8dbcfd',
    brightMagenta: '#cbaaf5',
    brightCyan: '#85d4e4',
    brightWhite: '#f6f6f7'
  }
}

const kelp: ThemeDef = {
  id: 'kelp',
  name: 'Kelp',
  kind: 'dark',
  colors: {
    bg: '#070d0a',
    chrome: '#0a120e',
    panel: '#0d1712',
    raised: '#13211a',
    hover: '#1a2a22',
    press: '#22342a',
    line: '#15241d',
    'line-strong': '#24362c',
    fg: '#e2efe7',
    muted: '#94a99f',
    faint: '#62766d',
    accent: '#9ade3f',
    'accent-strong': '#6fae24',
    'accent-bright': '#c2f47e',
    'accent-ink': '#152308',
    term: '#09110d',
    'st-starting': '#a8c0f4',
    'st-working': '#55a2e8',
    'st-waiting': '#e7ba3d',
    'st-idle': '#34cf8d',
    'st-quiet': '#778a80',
    'st-done': '#92a49a',
    'st-failed': '#ef7070'
  },
  terminal: {
    background: '#09110d',
    foreground: '#d7e7de',
    cursor: '#c2f47e',
    cursorAccent: '#09110d',
    selectionBackground: '#9ade3f',
    black: '#18241d',
    red: '#ef7070',
    green: '#34cf8d',
    yellow: '#e7ba3d',
    blue: '#55a2e8',
    magenta: '#b78ef2',
    cyan: '#5fcfae',
    white: '#d7e7de',
    brightBlack: '#56685e',
    brightRed: '#f7a3a3',
    brightGreen: '#66e2ab',
    brightYellow: '#f2cd6c',
    brightBlue: '#8bc3f6',
    brightMagenta: '#cfb2f5',
    brightCyan: '#86e0c4',
    brightWhite: '#f2f8f4'
  }
}

const ember: ThemeDef = {
  id: 'ember',
  name: 'Ember',
  kind: 'dark',
  colors: {
    bg: '#0e0b09',
    chrome: '#13100d',
    panel: '#18130f',
    raised: '#1f1914',
    hover: '#282019',
    press: '#312820',
    line: '#221b16',
    'line-strong': '#332921',
    fg: '#f1eae3',
    muted: '#b1a599',
    faint: '#7b6d62',
    accent: '#f2762a',
    'accent-strong': '#d1580e',
    'accent-bright': '#fb9a52',
    'accent-ink': '#2a1205',
    term: '#110d0a',
    'st-starting': '#b3bef7',
    'st-working': '#60a0f5',
    'st-waiting': '#f5b83e',
    'st-idle': '#3acc92',
    'st-quiet': '#8b7d72',
    'st-done': '#a19187',
    'st-failed': '#f4746e'
  },
  terminal: {
    background: '#110d0a',
    foreground: '#e6dcd2',
    cursor: '#fb9a52',
    cursorAccent: '#110d0a',
    selectionBackground: '#f2762a',
    black: '#231c16',
    red: '#f4746e',
    green: '#3acc92',
    yellow: '#f5b83e',
    blue: '#60a0f5',
    magenta: '#c494f2',
    cyan: '#e79a6a',
    white: '#e6dcd2',
    brightBlack: '#5d534a',
    brightRed: '#faa5a0',
    brightGreen: '#6ae1ae',
    brightYellow: '#fad176',
    brightBlue: '#93c4fa',
    brightMagenta: '#d8b8f6',
    brightCyan: '#f4b98f',
    brightWhite: '#faf5ef'
  }
}

const dusk: ThemeDef = {
  id: 'dusk',
  name: 'Dusk',
  kind: 'dark',
  colors: {
    bg: '#0b0911',
    chrome: '#100d17',
    panel: '#14111c',
    raised: '#1b1725',
    hover: '#231e30',
    press: '#2b2439',
    line: '#1d1927',
    'line-strong': '#2c2640',
    fg: '#ece8f5',
    muted: '#a49cb8',
    faint: '#6f6783',
    accent: '#a78bfa',
    'accent-strong': '#7c5cf0',
    'accent-bright': '#c4b0ff',
    'accent-ink': '#1c1136',
    term: '#0d0a15',
    'st-starting': '#b0aefc',
    'st-working': '#6aa6f7',
    'st-waiting': '#f8bf4a',
    'st-idle': '#3fd3a4',
    'st-quiet': '#827b95',
    'st-done': '#9a94ab',
    'st-failed': '#f57a7a'
  },
  terminal: {
    background: '#0d0a15',
    foreground: '#ded8ee',
    cursor: '#c4b0ff',
    cursorAccent: '#0d0a15',
    selectionBackground: '#a78bfa',
    black: '#1b1726',
    red: '#f57a7a',
    green: '#3fd3a4',
    yellow: '#f8bf4a',
    blue: '#6aa6f7',
    magenta: '#b794f6',
    cyan: '#6cd0dc',
    white: '#ded8ee',
    brightBlack: '#5b5273',
    brightRed: '#fba8a8',
    brightGreen: '#6fe4bd',
    brightYellow: '#fad478',
    brightBlue: '#98c7fb',
    brightMagenta: '#cfb2f9',
    brightCyan: '#8bdfe9',
    brightWhite: '#f7f4fd'
  }
}

const daylight: ThemeDef = {
  id: 'daylight',
  name: 'Daylight',
  kind: 'light',
  colors: {
    bg: '#f2f5f8',
    chrome: '#e9edf2',
    panel: '#ffffff',
    raised: '#f6f9fb',
    hover: '#e7ecf2',
    press: '#dae1e9',
    line: '#e1e7ee',
    'line-strong': '#c9d3de',
    fg: '#16202b',
    muted: '#586878',
    faint: '#8493a3',
    accent: '#0d9488',
    'accent-strong': '#0a7368',
    'accent-bright': '#0e9c8e',
    'accent-ink': '#031e1a',
    term: '#fbfcfd',
    'st-starting': '#4f5bd5',
    'st-working': '#1d6fd4',
    'st-waiting': '#a86c05',
    'st-idle': '#0d8a58',
    'st-quiet': '#6a7887',
    'st-done': '#55616f',
    'st-failed': '#c8342c'
  },
  terminal: {
    background: '#fbfcfd',
    foreground: '#1c2836',
    cursor: '#0d9488',
    cursorAccent: '#fbfcfd',
    selectionBackground: '#0d9488',
    black: '#24303e',
    red: '#c0392f',
    green: '#0f7a52',
    yellow: '#8a6100',
    blue: '#1f5fa8',
    magenta: '#8b3fa8',
    cyan: '#0e7480',
    white: '#eef2f6',
    brightBlack: '#5a6a7a',
    brightRed: '#d4453a',
    brightGreen: '#128a5c',
    brightYellow: '#a07400',
    brightBlue: '#2a6fc0',
    brightMagenta: '#9b4fba',
    brightCyan: '#128a97',
    brightWhite: '#ffffff'
  }
}

const paper: ThemeDef = {
  id: 'paper',
  name: 'Paper',
  kind: 'light',
  colors: {
    bg: '#f8f4ec',
    chrome: '#efe8db',
    panel: '#fffdf8',
    raised: '#f6f0e5',
    hover: '#ebe3d4',
    press: '#ded4c1',
    line: '#e4dac7',
    'line-strong': '#cdbfa6',
    fg: '#241c12',
    muted: '#6b5c47',
    faint: '#94836a',
    accent: '#9c5a12',
    'accent-strong': '#7a440c',
    'accent-bright': '#b5701f',
    'accent-ink': '#fffdf8',
    term: '#fbf7ef',
    'st-starting': '#544bc4',
    'st-working': '#1c6ba8',
    'st-waiting': '#966504',
    'st-idle': '#17794e',
    'st-quiet': '#6f6558',
    'st-done': '#574d40',
    'st-failed': '#b23a2c'
  },
  terminal: {
    background: '#fbf7ef',
    foreground: '#241c12',
    cursor: '#9c5a12',
    cursorAccent: '#fbf7ef',
    selectionBackground: '#9c5a12',
    black: '#2b2218',
    red: '#b0392b',
    green: '#166f4a',
    yellow: '#8a5c05',
    blue: '#1d639b',
    magenta: '#833c9c',
    cyan: '#0f6a72',
    white: '#f2ece0',
    brightBlack: '#6b5c47',
    brightRed: '#cc4a3c',
    brightGreen: '#1d8b5c',
    brightYellow: '#a57006',
    brightBlue: '#2a74b3',
    brightMagenta: '#9a4cb2',
    brightCyan: '#157e88',
    brightWhite: '#fffdf8'
  }
}

const sailcloth: ThemeDef = {
  id: 'sailcloth',
  name: 'Sailcloth',
  kind: 'light',
  colors: {
    bg: '#edf2f8',
    chrome: '#e2eaf4',
    panel: '#fbfdff',
    raised: '#f1f6fc',
    hover: '#e0e9f4',
    press: '#d1dded',
    line: '#dce5f0',
    'line-strong': '#bccbdf',
    fg: '#101a26',
    muted: '#4e5f75',
    faint: '#7b8ca3',
    accent: '#1f6fd4',
    'accent-strong': '#14539f',
    'accent-bright': '#4a8de3',
    'accent-ink': '#ffffff',
    term: '#f9fbfe',
    'st-starting': '#4b57c9',
    'st-working': '#1a68c9',
    'st-waiting': '#9d6806',
    'st-idle': '#0d8355',
    'st-quiet': '#68788e',
    'st-done': '#4e5a6b',
    'st-failed': '#c02f2a'
  },
  terminal: {
    background: '#f9fbfe',
    foreground: '#152030',
    cursor: '#1f6fd4',
    cursorAccent: '#f9fbfe',
    selectionBackground: '#1f6fd4',
    black: '#1f2a38',
    red: '#bc362c',
    green: '#0e7550',
    yellow: '#855d00',
    blue: '#1c5ba3',
    magenta: '#80389b',
    cyan: '#0c6573',
    white: '#eef3f9',
    brightBlack: '#57657a',
    brightRed: '#d04a3e',
    brightGreen: '#158a60',
    brightYellow: '#9d7000',
    brightBlue: '#2a6cb5',
    brightMagenta: '#974bb0',
    brightCyan: '#137d8c',
    brightWhite: '#ffffff'
  }
}

const chalk: ThemeDef = {
  id: 'chalk',
  name: 'Chalk',
  kind: 'light',
  colors: {
    bg: '#ffffff',
    chrome: '#f5f5f7',
    panel: '#ffffff',
    raised: '#f7f7f9',
    hover: '#eeeef2',
    press: '#e3e3e9',
    line: '#e6e6eb',
    'line-strong': '#cdcdd6',
    fg: '#111114',
    muted: '#595964',
    faint: '#83838f',
    accent: '#4f46e5',
    'accent-strong': '#3b32c9',
    'accent-bright': '#6d64f0',
    'accent-ink': '#ffffff',
    term: '#fbfbfc',
    'st-starting': '#4a45c7',
    'st-working': '#1d64cc',
    'st-waiting': '#94660a',
    'st-idle': '#0e7d53',
    'st-quiet': '#66666f',
    'st-done': '#4c4c55',
    'st-failed': '#bd2f28'
  },
  terminal: {
    background: '#fbfbfc',
    foreground: '#16161a',
    cursor: '#4f46e5',
    cursorAccent: '#fbfbfc',
    selectionBackground: '#4f46e5',
    black: '#1d1d21',
    red: '#b8342a',
    green: '#0d7049',
    yellow: '#7f5800',
    blue: '#1a5499',
    magenta: '#7a3392',
    cyan: '#0b5c68',
    white: '#ececf0',
    brightBlack: '#54545e',
    brightRed: '#cc473c',
    brightGreen: '#148459',
    brightYellow: '#966a06',
    brightBlue: '#2765ad',
    brightMagenta: '#9043a9',
    brightCyan: '#11737f',
    brightWhite: '#ffffff'
  }
}

/** Six dark themes, then four light ones. Harbor is first and is the default. */
export const THEMES: ThemeDef[] = [harbor, deep, graphite, kelp, ember, dusk, daylight, paper, sailcloth, chalk]

/** Looks a theme up by id. */
export function themeById(id: string): ThemeDef | null {
  return THEMES.find((t) => t.id === id) ?? null
}

/** Resolves the theme preference. "system" follows macOS, an unknown id gives Harbor. */
export function resolveTheme(pref: string, prefersDark: boolean): ThemeDef {
  if (pref === SYSTEM_THEME) return prefersDark ? harbor : daylight
  return themeById(pref) ?? harbor
}

// Color math.

function channel(c: number): number {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** Relative luminance of a hex color, per WCAG. */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

/** WCAG contrast ratio of two hex colors, from 1 to 21. Unreadable input gives 1. */
export function contrast(a: string, b: string): number {
  if (!hexToRgb(a) || !hexToRgb(b)) return 1
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Parses #rgb or #rrggbb (with or without the hash). Returns null for anything else. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const digits = m[1] as string
  if (digits.length === 3) {
    const short = [...digits].map((d) => d + d)
    return [parseInt(short[0] ?? '0', 16), parseInt(short[1] ?? '0', 16), parseInt(short[2] ?? '0', 16)]
  }
  return [
    parseInt(digits.slice(0, 2), 16),
    parseInt(digits.slice(2, 4), 16),
    parseInt(digits.slice(4, 6), 16)
  ]
}

/** Builds a hex color from 0 to 255 channels. */
export function rgbToHex(r: number, g: number, b: number): string {
  const part = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/** Turns a hex color into hue, saturation and lightness, each 0 to 1. */
export function hexToHsl(hex: string): [number, number, number] | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const r = rgb[0] / 255
  const g = rgb[1] / 255
  const b = rgb[2] / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

/** Builds a hex color from hue, saturation and lightness. */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 1) + 1) % 1
  const sat = Math.max(0, Math.min(1, s))
  const lum = Math.max(0, Math.min(1, l))
  if (sat === 0) {
    const v = lum * 255
    return rgbToHex(v, v, v)
  }
  const q = lum < 0.5 ? lum * (1 + sat) : lum + sat - lum * sat
  const p = 2 * lum - q
  const at = (t: number): number => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return rgbToHex(at(hue + 1 / 3) * 255, at(hue) * 255, at(hue - 1 / 3) * 255)
}

/** A hex color at a given alpha, for the terminal selection. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

const INK_DARK = '#000000'
const INK_LIGHT = '#ffffff'

/** The four accent tokens a custom accent produces, plus whether it had to move. */
export interface AccentSet {
  accent: string
  strong: string
  bright: string
  ink: string
  /** True when the accent was too close to the background and its lightness was stepped. */
  adjusted: boolean
}

/**
 * Turns a custom accent into the accent tokens, keeping it readable on the theme.
 * Lighter on dark themes, darker on light ones. Bad hex gives null.
 */
export function accentSet(hex: string, theme: ThemeDef): AccentSet | null {
  const hsl = hexToHsl(hex)
  const rgb = hexToRgb(hex)
  if (!hsl || !rgb) return null
  const [h, s] = hsl
  let l = hsl[2]
  let accent = rgbToHex(rgb[0], rgb[1], rgb[2])
  const dark = theme.kind === 'dark'
  let adjusted = false
  const step = dark ? 0.04 : -0.04
  for (let i = 0; i < 30 && contrast(accent, theme.colors.bg) < 3; i++) {
    l = Math.max(0, Math.min(1, l + step))
    accent = hslToHex(h, s, l)
    adjusted = true
  }
  const strong = hslToHex(h, s, Math.max(0, Math.min(1, l - (dark ? 0.07 : 0.09))))
  const bright = hslToHex(h, s, Math.min(1, l + (dark ? 0.08 : 0.09)))
  const ink = contrast(INK_DARK, accent) >= contrast(INK_LIGHT, accent) ? INK_DARK : INK_LIGHT
  return { accent, strong, bright, ink, adjusted }
}
