// Contrast math, the ten palettes, and the custom accent rules.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  THEMES,
  TOKENS,
  accentSet,
  contrast,
  hexToRgb,
  resolveTheme,
  themeById,
  withAlpha,
  type ThemeDef
} from './themes'

const ROOT = join(__dirname, '..', '..')

function theme(id: string): ThemeDef {
  const found = themeById(id)
  if (!found) throw new Error(`no theme ${id}`)
  return found
}

/** The colors theme.css ships today, read from the file itself. */
function cssTokens(): Record<string, string> {
  const css = readFileSync(join(ROOT, 'src/renderer/src/styles/theme.css'), 'utf8')
  const found: Record<string, string> = {}
  const re = /--color-([a-z-]+):\s*([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    const name = m[1]
    const value = (m[2] ?? '').trim()
    if (name !== undefined && value !== undefined) found[name] = value
  }
  return found
}

/** The terminal colors the registry ships today, read from the file itself. */
function registryTermTheme(): Record<string, string> {
  const src = readFileSync(join(ROOT, 'src/renderer/src/terminal/registry.ts'), 'utf8')
  const block = /export const TERM_THEME: ITheme = \{([\s\S]*?)\n\}/.exec(src)
  if (!block) throw new Error('TERM_THEME not found in the registry')
  const found: Record<string, string> = {}
  const re = /(\w+):\s*'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block[1] as string)) !== null) {
    const key = m[1]
    const value = m[2]
    if (key !== undefined && value !== undefined) found[key] = value
  }
  return found
}

describe('contrast', () => {
  it('reads known pairs', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    expect(contrast('#000000', '#000000')).toBeCloseTo(1, 5)
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 1)
    expect(contrast('#2dd4bf', '#0b0e13')).toBeGreaterThan(3)
  })

  it('counts a bad color as no contrast', () => {
    expect(contrast('nope', '#ffffff')).toBe(1)
  })
})

describe('themes', () => {
  it('ships six dark and four light, Harbor first', () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      'harbor',
      'deep',
      'graphite',
      'kelp',
      'ember',
      'dusk',
      'daylight',
      'paper',
      'sailcloth',
      'chalk'
    ])
    expect(THEMES.filter((t) => t.kind === 'dark')).toHaveLength(6)
    expect(THEMES.filter((t) => t.kind === 'light')).toHaveLength(4)
    expect(THEMES[0]?.id).toBe('harbor')
  })

  it('gives every theme a name and every token', () => {
    for (const t of THEMES) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(Object.keys(t.colors).sort()).toEqual([...TOKENS].sort())
      for (const token of TOKENS) {
        expect(t.colors[token], `${t.id} ${token}`).toMatch(/^#[0-9a-f]{6}$/)
      }
      for (const value of Object.values(t.terminal)) {
        expect(value, `${t.id} terminal`).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  it('covers every color variable theme.css defines', () => {
    expect(Object.keys(cssTokens()).sort()).toEqual([...TOKENS].sort())
  })

  it.each(THEMES.map((t) => [t.name, t] as const))('%s keeps text readable', (_name, t) => {
    const c = t.colors
    const panel = c.panel
    expect(contrast(c.fg, c.bg), 'fg on bg').toBeGreaterThanOrEqual(7)
    expect(contrast(c.fg, panel), 'fg on panel').toBeGreaterThanOrEqual(7)
    expect(contrast(c.muted, panel), 'muted on panel').toBeGreaterThanOrEqual(4.5)
    expect(contrast(c.faint, panel), 'faint on panel').toBeGreaterThanOrEqual(3)
    expect(contrast(c.accent, c.bg), 'accent on bg').toBeGreaterThanOrEqual(3)
    expect(contrast(c['accent-ink'], c.accent), 'accent ink on accent').toBeGreaterThanOrEqual(4.5)
    for (const token of ['st-starting', 'st-working', 'st-waiting', 'st-idle', 'st-quiet', 'st-done', 'st-failed'] as const) {
      expect(contrast(c[token], panel), `${token} on panel`).toBeGreaterThanOrEqual(3)
    }
    expect(contrast(c['accent-strong'], c.bg), 'accent strong on bg').toBeGreaterThanOrEqual(2)
    expect(contrast(c['accent-bright'], c.bg), 'accent bright on bg').toBeGreaterThanOrEqual(3)
  })

  it.each(THEMES.map((t) => [t.name, t] as const))('%s keeps the terminal readable', (_name, t) => {
    const term = t.terminal
    expect(contrast(term.foreground, term.background), 'terminal fg on bg').toBeGreaterThanOrEqual(7)
    for (const key of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) {
      expect(contrast(term[key], term.background), `terminal ${key}`).toBeGreaterThanOrEqual(3)
    }
    for (const key of ['brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan'] as const) {
      expect(contrast(term[key], term.background), `terminal ${key}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps working blue, waiting amber, ready green and failed red', () => {
    for (const t of THEMES) {
      const c = t.colors
      const hue = (hex: string): number => {
        const [rawR, rawG, rawB] = hexToRgb(hex) as [number, number, number]
        const r = rawR / 255
        const g = rawG / 255
        const b = rawB / 255
        const max = Math.max(r, g, b)
        const d = max - Math.min(r, g, b)
        if (d === 0) return 0
        let h: number
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
        else if (max === g) h = ((b - r) / d + 2) * 60
        else h = ((r - g) / d + 4) * 60
        return h
      }
      expect(Math.abs(hue(c['st-working']) - 215), `${t.id} working is blue`).toBeLessThan(35)
      expect(Math.abs(hue(c['st-waiting']) - 42), `${t.id} waiting is amber`).toBeLessThan(20)
      expect(Math.abs(hue(c['st-idle']) - 155), `${t.id} ready is green`).toBeLessThan(40)
      expect(Math.abs(hue(c['st-failed']) - 0), `${t.id} failed is red`).toBeLessThan(25)
    }
  })

  it('gives dark themes dark backgrounds and light themes light ones', () => {
    for (const t of THEMES) {
      expect(contrast(t.colors.fg, t.colors.bg), t.id).toBeGreaterThan(10)
      expect(t.colors.bg, t.id).toMatch(/^#/)
    }
    for (const t of THEMES.filter((x) => x.kind === 'dark')) expect(luma(t.colors.bg)).toBeLessThan(0.1)
    for (const t of THEMES.filter((x) => x.kind === 'light')) expect(luma(t.colors.bg)).toBeGreaterThan(0.8)
  })

  it('matches the colors theme.css and the registry ship today', () => {
    const css = cssTokens()
    const harborColors = theme('harbor').colors
    for (const token of TOKENS) {
      expect(harborColors[token], `Harbor ${token}`).toBe(css[token])
    }
    const term = registryTermTheme()
    const harborTerm = theme('harbor').terminal
    for (const key of Object.keys(harborTerm) as (keyof typeof harborTerm)[]) {
      const shipped = term[key]
      if (key === 'selectionBackground') {
        expect(withAlpha(harborTerm[key], 0.28), 'Harbor selection').toBe(shipped)
        continue
      }
      expect(harborTerm[key], `Harbor terminal ${key}`).toBe(shipped)
    }
  })
})

function luma(hex: string): number {
  const [rawR, rawG, rawB] = hexToRgb(hex) as [number, number, number]
  return (0.2126 * rawR + 0.7152 * rawG + 0.0722 * rawB) / 255
}

describe('accentSet', () => {
  const harbor = theme('harbor')
  const paper = theme('paper')

  it('keeps an accent that already reads well', () => {
    const set = accentSet('#2dd4bf', harbor)
    expect(set).not.toBeNull()
    expect(set?.accent).toBe('#2dd4bf')
    expect(set?.adjusted).toBe(false)
    expect(contrast(set?.accent ?? '', harbor.colors.bg)).toBeGreaterThanOrEqual(3)
  })

  it('makes a too dark accent lighter on a dark theme', () => {
    const set = accentSet('#0b3b33', harbor)
    expect(set?.adjusted).toBe(true)
    expect(contrast(set?.accent ?? '', harbor.colors.bg)).toBeGreaterThanOrEqual(3)
    const [r1, g1, b1] = hexToRgb('#0b3b33') as [number, number, number]
    const [r2, g2, b2] = hexToRgb(set?.accent ?? '') as [number, number, number]
    expect(r2 + g2 + b2).toBeGreaterThan(r1 + g1 + b1)
  })

  it('makes a too light accent darker on a light theme', () => {
    const set = accentSet('#fff3c4', paper)
    expect(set?.adjusted).toBe(true)
    expect(contrast(set?.accent ?? '', paper.colors.bg)).toBeGreaterThanOrEqual(3)
    const after = hexToRgb(set?.accent ?? '') as [number, number, number]
    expect(after[0]).toBeLessThan(255)
  })

  it('picks black ink on a light accent and white ink on a dark one', () => {
    expect(accentSet('#f5d90a', harbor)?.ink).toBe('#000000')
    expect(accentSet('#123a80', harbor)?.ink).toBe('#ffffff')
  })

  it('keeps the ink readable on every theme', () => {
    for (const t of THEMES) {
      for (const hex of ['#ff00aa', '#00d4ff', '#7c3aed', '#facc15', '#14532d']) {
        const set = accentSet(hex, t)
        expect(set, `${t.id} ${hex}`).not.toBeNull()
        expect(contrast(set?.ink ?? '', set?.accent ?? ''), `${t.id} ${hex} ink`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(set?.accent ?? '', t.colors.bg), `${t.id} ${hex} on bg`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('gives strong a little deeper and bright a little lighter', () => {
    const set = accentSet('#ff00aa', harbor)
    const sum = (hex: string): number => {
      const [r, g, b] = hexToRgb(hex) as [number, number, number]
      return r + g + b
    }
    expect(sum(set?.strong ?? '')).toBeLessThan(sum(set?.accent ?? ''))
    expect(sum(set?.bright ?? '')).toBeGreaterThan(sum(set?.accent ?? ''))
  })

  it('rejects bad hex', () => {
    expect(accentSet('nope', harbor)).toBeNull()
    expect(accentSet('#ff00a', harbor)).toBeNull()
    expect(accentSet('', harbor)).toBeNull()
  })
})

describe('resolveTheme', () => {
  it('follows the system', () => {
    expect(resolveTheme('system', true).id).toBe('harbor')
    expect(resolveTheme('system', false).id).toBe('daylight')
  })

  it('returns the theme the user picked', () => {
    expect(resolveTheme('paper', true).id).toBe('paper')
    expect(resolveTheme('ember', false).id).toBe('ember')
  })

  it('falls back to Harbor for an unknown id', () => {
    expect(resolveTheme('nope', true).id).toBe('harbor')
    expect(resolveTheme('nope', false).id).toBe('harbor')
    expect(resolveTheme('', true).id).toBe('harbor')
  })
})
