import { describe, expect, it } from 'vitest'
import type { VideoScene } from '@shared/video'
import {
  formatBytes,
  formatClock,
  formatClockPair,
  formatLoudness,
  formatMeta,
  fitRect,
  formatTick,
  isRunning,
  placeNote,
  rulerStep,
  rulerTicks,
  sceneAtTime
} from './common'

describe('formatClock', () => {
  it('reads whole tenths as minutes, seconds and a tenth', () => {
    expect(formatClock(0)).toBe('0:00.0')
    expect(formatClock(4.2)).toBe('0:04.2')
    expect(formatClock(12)).toBe('0:12.0')
    expect(formatClock(72)).toBe('1:12.0')
  })

  it('does not lose a tenth to floating point noise from stepping frames', () => {
    // Forty-five steps of a thirtieth of a second.
    let t = 0
    for (let i = 0; i < 45; i++) t += 1 / 30
    expect(t).not.toBe(1.5)
    expect(formatClock(t)).toBe('0:01.5')
    expect(formatClock(1.4999999999999998)).toBe('0:01.5')
  })

  it('never goes negative and survives a bad number', () => {
    expect(formatClock(-3)).toBe('0:00.0')
    expect(formatClock(Number.NaN)).toBe('0:00.0')
  })

  it('pairs the time with the length', () => {
    expect(formatClockPair(4.2, 12)).toBe('0:04.2 / 0:12.0')
  })
})

describe('formatMeta and friends', () => {
  it('writes the header line', () => {
    expect(formatMeta(12, 1280, 720, 30)).toBe('12.0 s · 1280×720 · 30 fps')
  })

  it('writes file sizes and loudness', () => {
    expect(formatBytes(620 * 1024)).toBe('620 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatLoudness(-14.04)).toBe('-14.0 LUFS')
    expect(formatLoudness(null)).toBeNull()
  })

  it('knows which statuses mean something is running', () => {
    expect(isRunning('planning')).toBe(true)
    expect(isRunning('building')).toBe(true)
    expect(isRunning('checking')).toBe(true)
    expect(isRunning('ready')).toBe(false)
    expect(isRunning('planned')).toBe(false)
  })
})

describe('sceneAtTime', () => {
  const scenes: VideoScene[] = [
    { id: 'a', title: 'A', start: 0, duration: 3 },
    { id: 'b', title: 'B', start: 3, duration: 3 },
    { id: 'c', title: 'C', start: 6, duration: 3 }
  ]

  it('finds the scene that contains the time, starts included', () => {
    expect(sceneAtTime(scenes, 0)?.id).toBe('a')
    expect(sceneAtTime(scenes, 2.99)?.id).toBe('a')
    expect(sceneAtTime(scenes, 3)?.id).toBe('b')
    expect(sceneAtTime(scenes, 8.5)?.id).toBe('c')
  })

  it('holds the last scene at and past the end, and finds none for no scenes', () => {
    expect(sceneAtTime(scenes, 9)?.id).toBe('c')
    expect(sceneAtTime(scenes, 99)?.id).toBe('c')
    expect(sceneAtTime([], 1)).toBeNull()
  })
})

describe('ruler', () => {
  it('labels every second when there is room', () => {
    expect(rulerStep(12, 560)).toBe(1)
  })

  it('thins the labels out as the video gets longer than the ruler is wide', () => {
    const step = rulerStep(120, 560)
    expect(step).toBeGreaterThanOrEqual(10)
    // Labels are never closer than the gap asked for.
    expect((step / 120) * 560).toBeGreaterThanOrEqual(34)
    expect(rulerStep(12, 80)).toBeGreaterThan(rulerStep(12, 560))
  })

  it('falls back to every second for an empty or unmeasured ruler', () => {
    expect(rulerStep(0, 560)).toBe(1)
    expect(rulerStep(12, 0)).toBe(1)
  })

  it('lists the ticks from 0 up to the length', () => {
    expect(rulerTicks(12, 1)).toHaveLength(13)
    expect(rulerTicks(12, 5)).toEqual([0, 5, 10])
    expect(rulerTicks(0, 1)).toEqual([])
  })

  it('writes ticks as seconds, then as minutes and seconds', () => {
    expect(formatTick(7)).toBe('7')
    expect(formatTick(60)).toBe('1:00')
    expect(formatTick(75)).toBe('1:15')
  })
})

describe('fitRect', () => {
  it('centers a 16:9 video in a taller area with bars above and below', () => {
    const r = fitRect({ width: 560, height: 605 }, { width: 1280, height: 720 })
    expect(r.width).toBeCloseTo(560, 5)
    expect(r.height).toBeCloseTo(315, 5)
    expect(r.left).toBeCloseTo(0, 5)
    expect(r.top).toBeCloseTo(145, 5)
  })

  it('puts the bars at the sides when the area is wider than the video', () => {
    const r = fitRect({ width: 860, height: 346 }, { width: 1280, height: 720 })
    expect(r.height).toBeCloseTo(346, 5)
    expect(r.width).toBeCloseTo(615.11, 1)
    expect(r.top).toBeCloseTo(0, 5)
    expect(r.left).toBeCloseTo((860 - r.width) / 2, 5)
  })

  it('keeps a tall video tall', () => {
    const r = fitRect({ width: 560, height: 605 }, { width: 720, height: 1280 })
    expect(r.height).toBeCloseTo(605, 5)
    expect(r.width / r.height).toBeCloseTo(720 / 1280, 5)
    expect(r.left).toBeCloseTo((560 - r.width) / 2, 5)
  })

  it('always has the same aspect ratio as the video and is centered', () => {
    for (const [w, h] of [[220, 505], [1000, 300], [333, 333], [1280, 720]] as const) {
      for (const v of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }, { width: 1080, height: 1080 }]) {
        const r = fitRect({ width: w, height: h }, v)
        expect(r.width / r.height).toBeCloseTo(v.width / v.height, 6)
        expect(r.left * 2 + r.width).toBeCloseTo(w, 6)
        expect(r.top * 2 + r.height).toBeCloseTo(h, 6)
        expect(r.width <= w + 1e-9 && r.height <= h + 1e-9).toBe(true)
      }
    }
  })

  it('fills the area when something has not been measured yet', () => {
    expect(fitRect({ width: 0, height: 0 }, { width: 1280, height: 720 })).toEqual({ left: 0, top: 0, width: 0, height: 0 })
    expect(fitRect({ width: 400, height: 300 }, { width: 0, height: 0 })).toEqual({ left: 0, top: 0, width: 400, height: 300 })
  })
})

describe('placeNote', () => {
  const region = { width: 560, height: 600 }
  const box = { width: 248, height: 160 }
  const overlaps = (spot: { left: number; top: number }, at: { x: number; y: number }): boolean =>
    at.x >= spot.left && at.x <= spot.left + box.width && at.y >= spot.top && at.y <= spot.top + box.height

  it('sits a little off the click when there is room', () => {
    expect(placeNote({ x: 100, y: 100 }, region, box)).toEqual({ left: 108, top: 108 })
  })

  it('goes to the other side of the click near the right and bottom edges, never covering it', () => {
    const at = { x: 550, y: 590 }
    const spot = placeNote(at, region, box)
    expect(spot.left + box.width).toBeLessThanOrEqual(region.width - 8)
    expect(spot.top + box.height).toBeLessThanOrEqual(region.height - 8)
    expect(overlaps(spot, at)).toBe(false)
  })

  it('flips only the side that has no room', () => {
    const right = placeNote({ x: 540, y: 100 }, region, box)
    expect(right.top).toBe(108)
    expect(right.left + box.width).toBeLessThanOrEqual(540 - 8)
    const bottom = placeNote({ x: 100, y: 580 }, region, box)
    expect(bottom.left).toBe(108)
    expect(bottom.top + box.height).toBeLessThanOrEqual(580 - 8)
  })

  it('keeps a margin from the top and left edges', () => {
    expect(placeNote({ x: -20, y: -20 }, region, box)).toEqual({ left: 8, top: 8 })
  })

  it('still answers when the region is smaller than the box', () => {
    expect(placeNote({ x: 50, y: 50 }, { width: 100, height: 100 }, box)).toEqual({ left: 8, top: 8 })
  })
})
