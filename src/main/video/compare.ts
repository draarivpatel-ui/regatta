// Comparing two captures of the same frame, for the pixel stability check.

/**
 * Two renders of a frame match when no color channel of any pixel differs by more than this many
 * levels. Gradients dither by one level between seeks, while a composition that uses randomness or
 * the clock differs by far more.
 */
export const MATCH_TOLERANCE = 2

export interface FrameDiff {
  /** The largest difference in any channel of any pixel, 0 to 255. */
  max: number
  /** How many pixels differ by at least one level in at least one channel. */
  pixels: number
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))
}

/**
 * How far apart two bitmaps of the same size are. Both hold four bytes a pixel (BGRA), but the
 * channels are treated alike: the result is the largest absolute difference over every byte.
 * Bitmaps of different sizes are as far apart as they can be.
 */
export function frameDiff(a: Uint8Array, b: Uint8Array): FrameDiff {
  if (a.length !== b.length) return { max: 255, pixels: Math.ceil(Math.max(a.length, b.length) / 4) }
  if (same(a, b)) return { max: 0, pixels: 0 }
  let max = 0
  let pixels = 0
  for (let p = 0; p < a.length; p += 4) {
    let differs = false
    const end = Math.min(p + 4, a.length)
    for (let i = p; i < end; i++) {
      const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0))
      if (d > 0) {
        differs = true
        if (d > max) max = d
      }
    }
    if (differs) pixels++
  }
  return { max, pixels }
}

/** True when a largest difference (as frameDiff reports it) still counts as the same picture. */
export function withinTolerance(maxDiff: number): boolean {
  return maxDiff <= MATCH_TOLERANCE
}
