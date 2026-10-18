// The prompt every agent turn starts from: where the files are, what the video is, then what this
// one turn should do. Pure, so the exact words can be tested.

import { join } from 'node:path'
import type { PointNote, VideoCheck } from '../../shared/video'

export type TurnKind = 'plan' | 'build' | 'revise' | 'change' | 'fix'

export interface PromptRequest {
  videoFolder: string
  projectRoot: string
  /** Regatta's own video resources: the guide and the working example. */
  resourcesDir: string
  title: string
  brief: string
  width: number
  height: number
  fps: number
  kind: TurnKind
  /** For a change turn: the spot the user pointed at. */
  note?: PointNote
  /** For a fix turn: the checks that failed. */
  failing?: VideoCheck[]
}

function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/**
 * The change request for a spot the user pointed at, in the words the card gives:
 * At <time> s, in scene <scene>, the element <selector> showing "<text>" (at x, y on the stage): <note>. Change only that.
 * The scene and the element are left out when they are not known.
 */
export function changeLine(note: PointNote): string {
  const when = note.scene ? `At ${oneDecimal(note.time)} s, in scene ${note.scene}` : `At ${oneDecimal(note.time)} s`
  const what = `${note.selector ? `the element ${note.selector} ` : ''}showing "${note.text}"`
  const spot = `(at ${Math.round(note.x)}, ${Math.round(note.y)} on the stage)`
  const wish = note.note.trim()
  // The note ends in a full stop either way, so a note that already ends in one is not doubled.
  return `${when}, ${what} ${spot}: ${/[.!?]$/.test(wish) ? wish : `${wish}.`} Change only that.`
}

/** One turn's own instruction, without the paths and the brief in front of it. */
export function turnRequest(kind: TurnKind, note?: PointNote, failing?: VideoCheck[]): string {
  switch (kind) {
    case 'plan':
      return 'Write PLAN.md for this video. Do not write index.html yet.'
    case 'build':
      return 'Build index.html to match PLAN.md.'
    case 'revise':
      return 'PLAN.md changed. Update index.html to match it.'
    case 'change':
      return note ? changeLine(note) : 'Change the video to match the request.'
    case 'fix': {
      const lines = ['The checks below failed.']
      for (const check of failing ?? []) lines.push(`- ${check.name}: ${check.detail}`)
      lines.push('Fix the cause.')
      return lines.join('\n')
    }
  }
}

/** The full prompt for one turn. */
export function buildTurnPrompt(request: PromptRequest): string {
  const head = [
    'You are working on a Regatta video: a short clip written as code, shown frame by frame and',
    'rendered to MP4 on this computer.',
    '',
    `Video folder, write here: ${request.videoFolder}`,
    `Project folder, read only, do not change it: ${request.projectRoot}`,
    `Guide to read first: ${join(request.resourcesDir, 'AGENT_GUIDE.md')}`,
    `Working example to read: ${join(request.resourcesDir, 'example', 'index.html')}`,
    'regatta-video.js and regatta-video.css are already in the video folder and are refreshed on',
    'every turn. Never edit them, and never write outside the video folder.',
    '',
    `Title: ${request.title}`,
    `Brief: ${request.brief}`,
    `Stage: ${request.width} by ${request.height} pixels, ${request.fps} fps.`,
    ''
  ]
  return `${head.join('\n')}${turnRequest(request.kind, request.note, request.failing)}\n`
}

/** The one line shown against a turn in the Activity list. */
export function turnNote(kind: TurnKind, note?: PointNote): string {
  switch (kind) {
    case 'plan':
      return 'Write the plan'
    case 'build':
      return 'Build the video'
    case 'revise':
      return 'Match the edited plan'
    case 'change':
      return note ? `Change at ${oneDecimal(note.time)} s: ${note.note}` : 'Change the video'
    case 'fix':
      return 'Fix a failed check'
  }
}
