// Video (Labs): an agent writes a short video as code; Regatta previews it frame by frame and renders
// an MP4. See docs/design/video.md.

export type VideoAspect = '16:9' | '9:16' | '1:1'

export const VIDEO_SIZES: Record<VideoAspect, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 1080, height: 1080 }
}

export type VideoAgent = 'claude' | 'codex' | 'fake'

export interface VideoScene {
  id: string
  title: string
  start: number
  duration: number
}

export interface VideoTurn {
  id: string
  kind: 'plan' | 'build' | 'revise' | 'change' | 'fix'
  status: 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number
  endedAt: number | null
  /** What was asked, in a line, for example "Change at 4.2 s: make the title bigger". */
  note: string
  tokens: number | null
  /** The last lines of the agent's activity. */
  latest: string
}

export interface VideoCheck {
  name: 'loads' | 'stable' | 'captions'
  passed: boolean
  /** For example "28 of 28 frames rendered the same twice". */
  detail: string
}

export interface VideoRender {
  id: string
  /** The MP4 file, inside the video's renders folder. */
  path: string
  status: 'rendering' | 'done' | 'failed' | 'stopped'
  /** 0 to 1. */
  progress: number
  startedAt: number
  endedAt: number | null
  sizeBytes: number | null
  /** Integrated loudness after mastering, in LUFS. */
  loudness: number | null
  note: string
}

export type VideoStatus = 'new' | 'planning' | 'planned' | 'building' | 'checking' | 'ready' | 'failed'

export interface VideoProject {
  id: string
  title: string
  brief: string
  aspect: VideoAspect
  width: number
  height: number
  fps: number
  agent: VideoAgent
  /** The project the video is about (read only for the agent). */
  projectRoot: string
  status: VideoStatus
  /** From the composition, once it loads. */
  duration: number | null
  scenes: VideoScene[]
  turns: VideoTurn[]
  checks: VideoCheck[]
  renders: VideoRender[]
  /** Scene id to a thumbnail path relative to the video folder, for the scene strip. */
  thumbnails: Record<string, string>
  /** A snapshot exists to undo the last agent turn. */
  canUndo: boolean
  createdAt: number
  updatedAt: number
}

export interface NewVideo {
  title: string
  brief: string
  aspect: VideoAspect
  agent: VideoAgent
}

/** A spot on a frame the user pointed at, with what should change there. */
export interface PointNote {
  time: number
  scene: string | null
  selector: string | null
  text: string
  /** Stage coordinates. */
  x: number
  y: number
  note: string
}

/** The custom protocol the preview loads videos from: regatta-video://<id>/index.html */
export const VIDEO_SCHEME = 'regatta-video'
