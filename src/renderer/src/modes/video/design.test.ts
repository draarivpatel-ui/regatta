// The parts of docs/DESIGN.md that a scan of the source can hold the video screens to: secondary text is never
// smaller than 11 px, colors come from the tokens and never from a hex value, there are no small all-caps
// labels, and the player's controls are lucide icons and not text glyphs.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const videoDir = __dirname
const settingsDir = join(videoDir, '..', '..', 'overlays', 'settings')
const root = join(videoDir, '..', '..', '..', '..', '..')

const files = [
  ...readdirSync(videoDir)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => join(videoDir, name)),
  join(settingsDir, 'LabsSection.tsx'),
  join(settingsDir, 'labs', 'LabsSwitch.tsx')
]

/** Every line of every file that matches, as "path:line", so a failure says where. */
function offenders(pattern: RegExp, keep: (match: RegExpMatchArray) => boolean = () => true): string[] {
  const found: string[] = []
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const match of line.matchAll(pattern)) {
          if (keep(match)) found.push(`${relative(root, file)}:${i + 1}`)
        }
      })
  }
  return found
}

describe('the video screens against docs/DESIGN.md', () => {
  it('finds the files it is meant to scan', () => {
    expect(files.length).toBeGreaterThan(8)
    expect(files.some((file) => file.endsWith('PlayerPanel.tsx'))).toBe(true)
    expect(files.some((file) => file.endsWith('LabsSwitch.tsx'))).toBe(true)
  })

  it('sets no text smaller than 11 px', () => {
    expect(offenders(/text-\[(\d+(?:\.\d+)?)px\]/g, (m) => Number(m[1]) < 11)).toEqual([])
  })

  it('takes colors from the tokens, never from a hex value', () => {
    expect(offenders(/(^|[^\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g)).toEqual([])
  })

  it('has no small all-caps labels', () => {
    expect(offenders(/\buppercase\b|tracking-(?:wide|wider|widest)\b/g)).toEqual([])
  })

  it('draws the controls with lucide icons and not text glyphs', () => {
    // Skip back, previous, play, pause, speaker off and speaker on, as they were once typed in.
    const glyphs = new RegExp('[' + String.fromCharCode(0x23ee, 0x25c0, 0x25b6, 0x275a) + '\\u{1F507}\\u{1F50A}]', 'u')
    expect(offenders(new RegExp(glyphs.source, 'gu'))).toEqual([])
  })
})
