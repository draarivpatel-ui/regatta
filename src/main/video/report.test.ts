// The checks a video has to pass, and the frame sampling behind them.

import { describe, expect, it } from 'vitest'
import type { VideoScene } from '../../shared/video'
import {
  captionsCheck,
  checksOf,
  hasPicture,
  integratedLoudness,
  largestDiff,
  loadsCheck,
  sampleTimes,
  sizeMismatch,
  stableCheck,
  thumbName,
  type RenderReport,
  type SampleResult
} from './report'

const example: VideoScene[] = [
  { id: 'panes', title: 'Side by side', start: 0, duration: 3 },
  { id: 'status', title: 'Who needs you', start: 3, duration: 3 },
  { id: 'checks', title: 'Checks decide', start: 6, duration: 3 },
  { id: 'name', title: 'Regatta', start: 9, duration: 3 }
]

function samples(diffs: number[]): SampleResult[] {
  return diffs.map((maxDiff, i) => ({ time: i * 0.5, scene: i < 6 ? 'panes' : 'status', maxDiff, pixels: maxDiff > 0 ? 100 : 0 }))
}

describe('sampleTimes', () => {
  it('samples every 15th frame plus every scene middle, ascending', () => {
    const times = sampleTimes(12, 30, example)
    // 24 frame samples (0 to 345 by 15) plus 4 scene middles.
    expect(times).toHaveLength(28)
    expect(times[0]).toBe(0)
    expect(times[times.length - 1]).toBe(11.5)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('includes every scene middle', () => {
    const times = sampleTimes(12, 30, example)
    for (const middle of [1.5, 4.5, 7.5, 10.5]) expect(times).toContain(middle)
  })

  it('samples nothing for a video with no frames', () => {
    expect(sampleTimes(0, 30, [])).toEqual([])
  })

  it('keeps samples inside the video', () => {
    for (const t of sampleTimes(12, 30, example)) {
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThan(12)
    }
  })

  it('adds a scene middle that falls between the frame samples', () => {
    const times = sampleTimes(4, 30, [{ id: 'a', title: 'A', start: 0, duration: 1.8 }])
    expect(times).toContain(0.9)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })
})

describe('hasPicture', () => {
  it('needs scenes and a length the checks will sample', () => {
    expect(hasPicture(12, 4)).toBe(true)
    expect(hasPicture(12, 0)).toBe(false)
    expect(hasPicture(0, 4)).toBe(false)
    expect(hasPicture(500, 4)).toBe(false)
  })
})

describe('loadsCheck', () => {
  it('passes a video with scenes and a sane length', () => {
    expect(loadsCheck(12, 4, [])).toEqual({ name: 'loads', passed: true, detail: 'Loaded with 4 scenes, 12 s long.' })
  })

  it('fails on a script error', () => {
    const check = loadsCheck(12, 4, ['Captions are not valid JSON'])
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('Captions are not valid JSON')
  })

  it('fails without scenes', () => {
    expect(loadsCheck(12, 0, []).passed).toBe(false)
  })

  it('fails a video that is too short or too long', () => {
    expect(loadsCheck(2, 2, []).passed).toBe(false)
    expect(loadsCheck(200, 2, []).passed).toBe(false)
    expect(loadsCheck(3, 2, []).passed).toBe(true)
    expect(loadsCheck(120, 2, []).passed).toBe(true)
  })

  it('fails a page that declares another size, and says what to do', () => {
    const check = loadsCheck(12, 4, [], 'The regatta-video meta tag says 1920x1080')
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('1920x1080')
  })
})

describe('sizeMismatch', () => {
  const wanted = { width: 1280, height: 720, fps: 30 }

  it('is quiet when the page declares what the video is', () => {
    expect(sizeMismatch(wanted, wanted)).toBeNull()
  })

  it('names both sizes when the page asks for another', () => {
    const text = sizeMismatch({ width: 1920, height: 1080, fps: 60 }, wanted)
    expect(text).toContain('1920x1080 at 60 fps')
    expect(text).toContain('1280x720 at 30 fps')
  })

  it('notices a changed frame rate alone', () => {
    expect(sizeMismatch({ ...wanted, fps: 24 }, wanted)).not.toBeNull()
  })
})

describe('stableCheck', () => {
  it('passes when every frame matched, and reads the way the card says', () => {
    expect(stableCheck(samples(new Array<number>(28).fill(0)))).toEqual({
      name: 'stable',
      passed: true,
      detail: '28 of 28 frames rendered the same twice'
    })
  })

  it('passes frames that differ by dither, up to two levels', () => {
    const check = stableCheck(samples([0, 1, 1, 2, 2, 0]))
    expect(check.passed).toBe(true)
    expect(check.detail).toBe('6 of 6 frames rendered the same twice')
  })

  it('fails when one frame is three levels off, and names it', () => {
    const check = stableCheck(samples([0, 1, 3, 0]))
    expect(check.passed).toBe(false)
    expect(check.detail).toBe('3 of 4 frames rendered the same twice. The largest difference was 3 of 255 levels, first at 1 s in scene panes.')
  })

  it('names the largest difference and the first bad frame', () => {
    const check = stableCheck(samples([0, 0, 40, 200, 0, 9]))
    expect(check.passed).toBe(false)
    expect(check.detail.startsWith('3 of 6 frames rendered the same twice.')).toBe(true)
    expect(check.detail).toContain('200 of 255')
    expect(check.detail).toContain('first at 1 s')
  })

  it('does not pass when nothing was sampled', () => {
    const check = stableCheck([])
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('Not checked')
  })
})

describe('largestDiff', () => {
  it('is the biggest difference of any sampled frame, passing or not', () => {
    expect(largestDiff(samples([0, 1, 2, 1]))).toBe(2)
    expect(largestDiff(samples([0, 90, 2]))).toBe(90)
    expect(largestDiff([])).toBe(0)
  })
})

describe('captionsCheck', () => {
  const captions = [
    { start: 0.4, end: 2.8, text: 'one' },
    { start: 3.3, end: 5.8, text: 'two' },
    { start: 9.4, end: 11.8, text: 'three' }
  ]

  it('passes captions inside the video that do not overlap', () => {
    const check = captionsCheck(12, captions)
    expect(check.passed).toBe(true)
    expect(check.detail).toBe('3 captions, all inside the video.')
  })

  it('fails a caption that runs past the end', () => {
    const check = captionsCheck(12, [...captions, { start: 11, end: 13, text: 'late' }])
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('13 s')
  })

  it('lets a caption end exactly where the video does', () => {
    expect(captionsCheck(12, [{ start: 10, end: 12, text: 'last' }]).passed).toBe(true)
    expect(captionsCheck(12, [{ start: 10, end: 12.5, text: 'last' }]).passed).toBe(false)
  })

  it('fails a caption that starts before the video', () => {
    const check = captionsCheck(12, [{ start: -1, end: 2, text: 'early' }])
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('before')
  })

  it('fails captions that overlap', () => {
    const check = captionsCheck(12, [{ start: 1, end: 4, text: 'a' }, { start: 3, end: 6, text: 'b' }])
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('Caption 2')
  })

  it('lets one caption start where the last ended', () => {
    expect(captionsCheck(12, [{ start: 1, end: 4, text: 'a' }, { start: 4, end: 6, text: 'b' }]).passed).toBe(true)
  })

  it('passes with no captions at all', () => {
    expect(captionsCheck(12, []).detail).toBe('No captions.')
  })
})

describe('thumbName', () => {
  it('keeps an ordinary scene id', () => {
    expect(thumbName('hook')).toBe('hook')
    expect(thumbName('scene-2_b')).toBe('scene-2_b')
  })

  it('never lets an id leave the thumbs folder', () => {
    expect(thumbName('../../escape')).not.toContain('/')
    expect(thumbName('../../escape')).not.toContain('..')
    expect(thumbName('a/b\\c')).not.toMatch(/[\\/]/)
  })

  it('falls back to a name for an empty id', () => {
    expect(thumbName('')).toBe('scene')
    expect(thumbName('...')).toBe('_')
  })
})

describe('checksOf', () => {
  const base: RenderReport = {
    kind: 'check',
    ok: true,
    errors: [],
    duration: 12,
    fps: 30,
    scenes: example,
    thumbnails: [],
    loads: { name: 'loads', passed: true, detail: 'ok' },
    stable: { name: 'stable', passed: true, detail: '28 of 28 frames rendered the same twice' },
    captions: { name: 'captions', passed: true, detail: 'No captions.' },
    samples: [],
    maxDiff: 0,
    viewport: null,
    frames: 0,
    framesDone: 0,
    sizeBytes: null,
    loudness: null,
    out: ''
  }

  it('lists the three checks in the order the user reads them', () => {
    expect(checksOf(base).map((check) => check.name)).toEqual(['loads', 'stable', 'captions'])
  })

  it('keeps only the one check that says why when the page could not be loaded', () => {
    const failed: RenderReport = { ...base, ok: false, loads: { name: 'loads', passed: false, detail: 'index.html could not be loaded' } }
    expect(checksOf(failed)).toEqual([{ name: 'loads', passed: false, detail: 'index.html could not be loaded' }])
  })
})

describe('integratedLoudness', () => {
  const log = [
    '[Parsed_ebur128_0 @ 0x1] t: 0.0999896  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU',
    '[Parsed_ebur128_0 @ 0x1] t: 0.39999    TARGET:-23 LUFS    M:  -6.4 S:-120.7     I:  -6.5 LUFS       LRA:   0.0 LU',
    '[Parsed_ebur128_0 @ 0x1] Summary:',
    '',
    '  Integrated loudness:',
    '    I:         -14.4 LUFS',
    '    Threshold: -24.4 LUFS',
    '',
    '  Loudness range:',
    '    LRA:         0.4 LU'
  ].join('\n')

  it('reads the summary, not the first running value', () => {
    expect(integratedLoudness(log)).toBe(-14.4)
  })

  it('is null when there is no summary', () => {
    expect(integratedLoudness('I: -70.0 LUFS')).toBeNull()
    expect(integratedLoudness('')).toBeNull()
  })
})
