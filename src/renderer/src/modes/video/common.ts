// Small pure helpers for Video mode: the words the card asks for, the number formats, the dot, and
// the timeline ruler.

import type { SessionState } from '@shared/types'
import type { VideoScene, VideoStatus, VideoTurn } from '@shared/video'

/** The status shown in the header and the list, in the words the design gives. */
export const STATUS_WORDS: Record<VideoStatus, string> = {
  new: 'New',
  planning: 'Writing the plan',
  planned: 'Plan ready',
  building: 'Building',
  checking: 'Checking',
  ready: 'Ready',
  failed: 'Needs attention'
}

/** What a turn's kind is called in the Activity list. */
export const TURN_KIND_WORDS: Record<VideoTurn['kind'], string> = {
  plan: 'Wrote the plan',
  build: 'Built the video',
  revise: 'Matched the plan',
  change: 'Changed a spot',
  fix: 'Fixed a check'
}

export const TURN_STATUS_WORDS: Record<VideoTurn['status'], string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped'
}

export const CHECK_WORDS: Record<string, string> = {
  loads: 'Loads',
  stable: 'Pixel stability',
  captions: 'Captions'
}

/** True while an agent turn or a check is running, so the screen can show busy affordances. */
export function isRunning(status: VideoStatus): boolean {
  return status === 'planning' || status === 'building' || status === 'checking'
}

/** The state whose dot color fits this video status. */
export function videoDotState(status: VideoStatus): SessionState {
  switch (status) {
    case 'planning':
    case 'building':
      return 'working'
    case 'checking':
      return 'starting'
    case 'planned':
    case 'ready':
      return 'idle'
    case 'failed':
      return 'failed'
    case 'new':
      return 'quiet'
  }
}

/**
 * "0:04.2" and "1:12.0", the clock format the controls use. Whole tenths, counted from the number of
 * tenths with a hair of slack: forty-five frame steps of 1/30 s add up to 1.4999999999999998, and that
 * must read 0:01.5, not 0:01.4.
 */
export function formatClock(seconds: number): string {
  const value = Number.isFinite(seconds) ? seconds : 0
  const tenths = Math.max(0, Math.floor(value * 10 + 1e-6))
  const m = Math.floor(tenths / 600)
  const s = Math.floor((tenths % 600) / 10)
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`
}

/** The "0:04.2 / 0:12.0" the time label shows. */
export function formatClockPair(time: number, duration: number): string {
  return `${formatClock(time)} / ${formatClock(duration)}`
}

/** "12.0 s". */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`
}

/** "12.0 s · 1280×720 · 30 fps". */
export function formatMeta(duration: number, width: number, height: number, fps: number): string {
  return `${formatSeconds(duration)} · ${width}×${height} · ${fps} fps`
}

/** "1.4 MB" for a finished render. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** "-14.0 LUFS", or null when the render carries no loudness (no music). */
export function formatLoudness(loudness: number | null): string | null {
  return loudness === null ? null : `${loudness.toFixed(1)} LUFS`
}

/** "7:12 pm" style clock time for a turn, from its start. */
export function formatTimeOfDay(at: number): string {
  const d = new Date(at)
  let h = d.getHours()
  const suffix = h >= 12 ? 'pm' : 'am'
  h = h % 12
  if (h === 0) h = 12
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m} ${suffix}`
}

/** The scene on screen at time t: the one that contains it, or the last one at and past the end. */
export function sceneAtTime(scenes: VideoScene[], t: number): VideoScene | null {
  let last: VideoScene | null = null
  for (const scene of scenes) {
    if (t >= scene.start) last = scene
    if (t < scene.start + scene.duration) return scene
  }
  return last
}

/** Seconds between two ruler labels, so labels stay at least `minGap` pixels apart on a ruler `width` wide. */
export function rulerStep(total: number, width: number, minGap = 34): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  if (!(total > 0) || !(width > 0)) return 1
  for (const step of steps) {
    if ((step / total) * width >= minGap) return step
  }
  return steps[steps.length - 1]!
}

/** The ruler's labels: every `step` seconds from 0 up to the video's length. */
export function rulerTicks(total: number, step: number): number[] {
  const ticks: number[] = []
  if (!(total > 0) || !(step > 0)) return ticks
  for (let s = 0; s <= total + 1e-6; s += step) ticks.push(s)
  return ticks
}

/** "7" for seconds under a minute, "1:05" from there on. */
export function formatTick(seconds: number): string {
  if (seconds < 60) return String(seconds)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export interface Box {
  width: number
  height: number
}

/**
 * Where a video of size `video` is drawn inside an area: as big as fits, centered. This is what the
 * page itself does with its stage (resources/video/regatta-video.js), so the bars are what is left over.
 */
export function fitRect(area: Box, video: Box): { left: number; top: number; width: number; height: number } {
  if (!(area.width > 0) || !(area.height > 0) || !(video.width > 0) || !(video.height > 0)) {
    return { left: 0, top: 0, width: Math.max(0, area.width), height: Math.max(0, area.height) }
  }
  const scale = Math.min(area.width / video.width, area.height / video.height)
  const width = video.width * scale
  const height = video.height * scale
  return { left: (area.width - width) / 2, top: (area.height - height) / 2, width, height }
}

/**
 * Where a note box goes for a click at `at` inside a region: a little to the right of and below the click, or
 * on the other side of it when there is no room, so the box never covers the spot it is about. Always
 * inside the region (with `gap` pixels to spare) when the region is big enough for it.
 */
export function placeNote(at: { x: number; y: number }, region: Box, box: Box, gap = 8): { left: number; top: number } {
  const maxLeft = Math.max(gap, region.width - box.width - gap)
  const maxTop = Math.max(gap, region.height - box.height - gap)
  const left = at.x + gap + box.width <= region.width - gap ? at.x + gap : at.x - gap - box.width
  const top = at.y + gap + box.height <= region.height - gap ? at.y + gap : at.y - gap - box.height
  return {
    left: Math.min(Math.max(gap, left), maxLeft),
    top: Math.min(Math.max(gap, top), maxTop)
  }
}
