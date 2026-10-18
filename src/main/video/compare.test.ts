// How two captures of one frame are compared: the dither tolerance, and the evidence it reports.

import { describe, expect, it } from 'vitest'
import { MATCH_TOLERANCE, frameDiff, withinTolerance } from './compare'

/** A bitmap of `pixels` pixels (BGRA), every byte set to `level`. */
function bitmap(pixels: number, level: number): Buffer {
  return Buffer.alloc(pixels * 4, level)
}

describe('frameDiff', () => {
  it('reports no difference for identical bitmaps', () => {
    expect(frameDiff(bitmap(100, 40), bitmap(100, 40))).toEqual({ max: 0, pixels: 0 })
  })

  it('finds a single byte that differs, and which pixel it is in', () => {
    const a = bitmap(50, 10)
    const b = bitmap(50, 10)
    b[4 * 49 + 3] = 17 // the alpha byte of the last pixel
    expect(frameDiff(a, b)).toEqual({ max: 7, pixels: 1 })
    const c = bitmap(50, 10)
    c[0] = 0 // the blue byte of the first pixel
    expect(frameDiff(a, c)).toEqual({ max: 10, pixels: 1 })
  })

  it('counts a pixel once however many of its channels differ, and takes the largest channel', () => {
    const a = bitmap(10, 100)
    const b = bitmap(10, 100)
    b[8] = 101
    b[9] = 98
    b[10] = 100
    b[11] = 103
    expect(frameDiff(a, b)).toEqual({ max: 3, pixels: 1 })
  })

  it('sees dither: one level apart over a large area', () => {
    const a = bitmap(1000, 80)
    const b = bitmap(1000, 81)
    expect(frameDiff(a, b)).toEqual({ max: 1, pixels: 1000 })
  })

  it('treats the bitmaps as unequal when their sizes differ', () => {
    expect(frameDiff(bitmap(10, 0), bitmap(11, 0)).max).toBe(255)
  })

  it('works on views into a larger buffer', () => {
    const backing = Buffer.alloc(80, 5)
    const a = backing.subarray(0, 40)
    const b = backing.subarray(40, 80)
    expect(frameDiff(a, b)).toEqual({ max: 0, pixels: 0 })
    backing[41] = 9
    expect(frameDiff(a, b)).toEqual({ max: 4, pixels: 1 })
  })
})

describe('withinTolerance', () => {
  it('uses a tolerance of two levels', () => {
    expect(MATCH_TOLERANCE).toBe(2)
  })

  it('accepts differences up to two levels in any channel', () => {
    expect(withinTolerance(frameDiff(bitmap(64, 80), bitmap(64, 81)).max)).toBe(true)
    expect(withinTolerance(frameDiff(bitmap(64, 80), bitmap(64, 82)).max)).toBe(true)
  })

  it('refuses a difference of three levels, even in one channel of one pixel', () => {
    expect(withinTolerance(frameDiff(bitmap(64, 80), bitmap(64, 83)).max)).toBe(false)
    const a = bitmap(64, 80)
    const b = bitmap(64, 80)
    b[100] = 83
    expect(withinTolerance(frameDiff(a, b).max)).toBe(false)
  })

  it('refuses random noise, the way a composition that uses Math.random draws', () => {
    const a = bitmap(500, 0)
    const b = bitmap(500, 0)
    let seed = 12345
    for (let i = 0; i < b.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      b[i] = seed & 0xff
    }
    const diff = frameDiff(a, b)
    expect(diff.max).toBeGreaterThan(100)
    expect(withinTolerance(diff.max)).toBe(false)
  })
})
