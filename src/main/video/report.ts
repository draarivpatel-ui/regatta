// The report a render process writes when a check or render job finishes, and the pure rules that
// turn it into the checks the user sees.

import type { VideoCheck, VideoScene } from '../../shared/video'
import { withinTolerance } from './compare'

/** A caption from the page's regatta-captions JSON. */
export interface Caption {
  start: number
  end: number
  text: string
}

/** A video shorter or longer than this fails the "loads" check. */
export const MIN_DURATION = 3
export const MAX_DURATION = 120
/** One frame in this many is sampled twice for the pixel stability check. */
export const SAMPLE_EVERY = 15
/** Captions may be this far past the end of the video before they count as outside it. */
const EDGE = 1e-6

/** One sampled frame, drawn twice. */
export interface SampleResult {
  /** Seconds into the video. */
  time: number
  /** The scene showing at that time, or null. */
  scene: string | null
  /** The largest difference in any color channel between the two draws, 0 to 255. */
  maxDiff: number
  /** How many pixels differed at all. */
  pixels: number
}

/** The page's size as the render window showed it. */
export interface Viewport {
  width: number
  height: number
  ratio: number
}

export interface RenderReport {
  kind: 'render' | 'check'
  ok: boolean
  /** Why the job failed, when it did. */
  error?: string
  /**
   * Who is at fault when the job failed: the page (the agent can fix it) or the machine (it cannot,
   * so the agent is not sent a fix turn for it).
   */
  failure?: 'page' | 'system'
  /** Script errors the runtime saw, and anything the page asked for from the network. */
  errors: string[]
  duration: number
  fps: number
  scenes: VideoScene[]
  /** Scene ids whose middle frame was saved under thumbs/. */
  thumbnails: string[]
  loads: VideoCheck
  stable: VideoCheck
  captions: VideoCheck
  /** The sampled frames of a check, each drawn twice, with how far apart the two draws were. */
  samples: SampleResult[]
  /** The largest difference in any color channel between two draws of the same frame, 0 to 255. */
  maxDiff: number
  /** The page's size in the render window; it must be exactly the video's size at ratio 1. */
  viewport: Viewport | null
  /** Frames the job drew (each sample twice for a check, one per output frame for a render). */
  frames: number
  framesDone: number
  sizeBytes: number | null
  /** Integrated loudness after mastering, in LUFS, or null without audio. */
  loudness: number | null
  /** Something the user should know about a job that went through, for example unmastered music. */
  note?: string
  out: string
}

function seconds(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded} s`
}

/** The file name (without .png) of a scene's thumbnail: the id, made safe to use as a name. */
export function thumbName(sceneId: string): string {
  return sceneId.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'scene'
}

/** Where a scene's middle falls, in seconds. */
export function sceneMiddle(scene: VideoScene): number {
  return scene.start + scene.duration / 2
}

/**
 * When to sample frames for the stability check: every scene's middle plus every 15th frame,
 * sorted ascending. The same time can appear twice (a scene middle that lands on a frame); each
 * sample is drawn twice anyway, so the count stays honest.
 */
export function sampleTimes(duration: number, fps: number, scenes: VideoScene[]): number[] {
  const frames = Math.max(0, Math.round(duration * fps))
  const times: number[] = []
  for (let i = 0; i < frames; i += SAMPLE_EVERY) times.push(i / fps)
  for (const scene of scenes) times.push(sceneMiddle(scene))
  return times.filter((t) => t >= 0 && t < duration).sort((a, b) => a - b)
}

/** True when there is something to draw: scenes, and a length the checks will sample. */
export function hasPicture(duration: number, sceneCount: number): boolean {
  return sceneCount > 0 && duration > 0 && duration <= MAX_DURATION
}

/** A check that could not run, so it counts as not passed. */
export function notChecked(name: VideoCheck['name'], why: string): VideoCheck {
  return { name, passed: false, detail: `Not checked: ${why}` }
}

export function loadsCheck(duration: number, sceneCount: number, errors: string[], mismatch: string | null = null): VideoCheck {
  const first = errors[0]
  if (first !== undefined) return { name: 'loads', passed: false, detail: `Script error: ${first}` }
  if (sceneCount === 0) {
    return { name: 'loads', passed: false, detail: 'The page has no scenes. Add section data-scene elements.' }
  }
  if (mismatch) return { name: 'loads', passed: false, detail: mismatch }
  if (!(duration >= MIN_DURATION) || duration > MAX_DURATION) {
    return {
      name: 'loads',
      passed: false,
      detail: `The video runs ${seconds(duration)}; it must run ${MIN_DURATION} to ${MAX_DURATION} s.`
    }
  }
  return { name: 'loads', passed: true, detail: `Loaded with ${sceneCount} scenes, ${seconds(duration)} long.` }
}

/**
 * The page's own size and frame rate (its regatta-video meta tag) against the video's. A page that
 * asks for another size would render cropped or padded, so it fails to load instead.
 */
export function sizeMismatch(
  declared: { width: number; height: number; fps: number },
  wanted: { width: number; height: number; fps: number }
): string | null {
  if (declared.width === wanted.width && declared.height === wanted.height && declared.fps === wanted.fps) return null
  return (
    `The regatta-video meta tag says ${declared.width}x${declared.height} at ${declared.fps} fps, but this video is ` +
    `${wanted.width}x${wanted.height} at ${wanted.fps} fps. Put the meta tag back the way Regatta wrote it.`
  )
}

/**
 * Every sampled frame must come out the same twice, within the tolerance of compare.ts in every color
 * channel. When all do, the detail is just the count; when some do not, it also names the largest
 * difference and where it first showed, which is what the agent needs to find the cause.
 */
export function stableCheck(samples: SampleResult[]): VideoCheck {
  const total = samples.length
  if (total === 0) return notChecked('stable', 'there is nothing to draw yet.')
  const bad = samples.filter((sample) => !withinTolerance(sample.maxDiff))
  const matched = total - bad.length
  const count = `${matched} of ${total} frames rendered the same twice`
  if (bad.length === 0) return { name: 'stable', passed: true, detail: count }
  const first = bad[0]
  const largest = bad.reduce((a, b) => (b.maxDiff > a.maxDiff ? b : a))
  const where = first ? `, first at ${seconds(first.time)}${first.scene ? ` in scene ${first.scene}` : ''}` : ''
  return {
    name: 'stable',
    passed: false,
    detail: `${count}. The largest difference was ${largest.maxDiff} of 255 levels${where}.`
  }
}

/** The largest difference between two draws of any sampled frame. */
export function largestDiff(samples: SampleResult[]): number {
  return samples.reduce((max, sample) => Math.max(max, sample.maxDiff), 0)
}

export function captionsCheck(duration: number, captions: Caption[]): VideoCheck {
  const usable = captions.filter((c) => Number(c.end) > Number(c.start))
  const outside = usable.find((c) => Number(c.start) < 0 || Number(c.end) > duration + EDGE)
  if (outside) {
    const past = Number(outside.end) > duration + EDGE
    return {
      name: 'captions',
      passed: false,
      detail: past
        ? `A caption ends at ${seconds(outside.end)}, past the ${seconds(duration)} video.`
        : 'A caption starts before the video does.'
    }
  }
  const ordered = [...usable].sort((a, b) => Number(a.start) - Number(b.start))
  for (let i = 1; i < ordered.length; i++) {
    const current = ordered[i]
    const previous = ordered[i - 1]
    if (!current || !previous) continue
    if (Number(current.start) < Number(previous.end)) {
      return {
        name: 'captions',
        passed: false,
        detail: `Caption ${i + 1} starts at ${seconds(current.start)} while caption ${i} is still showing.`
      }
    }
  }
  if (usable.length === 0) return { name: 'captions', passed: true, detail: 'No captions.' }
  return { name: 'captions', passed: true, detail: `${usable.length} captions, all inside the video.` }
}

/**
 * The checks the user reads, in order. A page that could not be loaded at all has only the one
 * check that says why.
 */
export function checksOf(report: RenderReport): VideoCheck[] {
  if (!report.ok) return [{ ...report.loads }]
  return [report.loads, report.stable, report.captions].map((c) => ({ ...c }))
}

/** The integrated loudness (LUFS) in the summary ffmpeg's ebur128 filter prints at the end. */
export function integratedLoudness(log: string): number | null {
  // The filter also logs a running value on every line; the first of those is always -70.0. Only the
  // summary at the end is the measurement.
  const at = log.lastIndexOf('Summary:')
  if (at < 0) return null
  const match = log.slice(at).match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/)
  return match && match[1] !== undefined ? Number(match[1]) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCheckOf(value: unknown, name: VideoCheck['name']): VideoCheck {
  if (isRecord(value) && typeof value['passed'] === 'boolean') {
    return { name, passed: value['passed'], detail: typeof value['detail'] === 'string' ? value['detail'] : '' }
  }
  return notChecked(name, 'the report had no result.')
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * A report read back from the render process's file, or null when it is not one. The file is
 * written by the process that ran the page, so every field is checked rather than trusted.
 */
export function parseReport(raw: unknown): RenderReport | null {
  if (!isRecord(raw) || typeof raw['ok'] !== 'boolean') return null
  const kind = raw['kind'] === 'render' ? 'render' : raw['kind'] === 'check' ? 'check' : null
  if (!kind) return null
  const scenes: VideoScene[] = []
  if (Array.isArray(raw['scenes'])) {
    for (const item of raw['scenes']) {
      if (!isRecord(item) || typeof item['id'] !== 'string') continue
      scenes.push({
        id: item['id'],
        title: typeof item['title'] === 'string' ? item['title'] : item['id'],
        start: numberOr(item['start'], 0),
        duration: numberOr(item['duration'], 0)
      })
    }
  }
  const samples: SampleResult[] = []
  if (Array.isArray(raw['samples'])) {
    for (const item of raw['samples']) {
      if (!isRecord(item)) continue
      samples.push({
        time: numberOr(item['time'], 0),
        scene: typeof item['scene'] === 'string' ? item['scene'] : null,
        maxDiff: numberOr(item['maxDiff'], 0),
        pixels: numberOr(item['pixels'], 0)
      })
    }
  }
  const viewport = raw['viewport']
  const failure = raw['failure'] === 'page' || raw['failure'] === 'system' ? raw['failure'] : undefined
  const loudness = raw['loudness']
  const sizeBytes = raw['sizeBytes']
  const text = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
  return {
    kind,
    ok: raw['ok'],
    ...(typeof raw['error'] === 'string' ? { error: raw['error'] } : {}),
    ...(failure ? { failure } : {}),
    errors: text(raw['errors']),
    duration: numberOr(raw['duration'], 0),
    fps: numberOr(raw['fps'], 30),
    scenes,
    thumbnails: text(raw['thumbnails']),
    loads: readCheckOf(raw['loads'], 'loads'),
    stable: readCheckOf(raw['stable'], 'stable'),
    captions: readCheckOf(raw['captions'], 'captions'),
    samples,
    maxDiff: numberOr(raw['maxDiff'], 0),
    viewport:
      isRecord(viewport) && typeof viewport['width'] === 'number' && typeof viewport['height'] === 'number' && typeof viewport['ratio'] === 'number'
        ? { width: viewport['width'], height: viewport['height'], ratio: viewport['ratio'] }
        : null,
    frames: numberOr(raw['frames'], 0),
    framesDone: numberOr(raw['framesDone'], 0),
    sizeBytes: typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) ? sizeBytes : null,
    loudness: typeof loudness === 'number' && Number.isFinite(loudness) ? loudness : null,
    ...(typeof raw['note'] === 'string' ? { note: raw['note'] } : {}),
    out: typeof raw['out'] === 'string' ? raw['out'] : ''
  }
}
