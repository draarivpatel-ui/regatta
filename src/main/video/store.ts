// The folder layout of a video project and the files in it. Everything below the videos folder
// lives on disk, so it is pure file work with no Electron in it.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { VideoAspect, VideoCheck, VideoProject, VideoRender, VideoScene, VideoTurn } from '../../shared/video'
import { VIDEO_SIZES } from '../../shared/video'

export const PROJECT_FILE = 'video.json'
export const PLAN_FILE = 'PLAN.md'
export const INDEX_FILE = 'index.html'
export const ASSETS_DIR = 'assets'
export const RENDERS_DIR = 'renders'
export const THUMBS_DIR = 'thumbs'
export const HISTORY_DIR = '.history'
export const SNAPSHOT_KEEP = 10

/** Videos live in <dataDir>/videos/<id>/. */
export function videosDir(dataDir: string): string {
  return join(dataDir, 'videos')
}

export function videoFolder(dataDir: string, id: string): string {
  return join(videosDir(dataDir), id)
}

function withSlash(path: string): string {
  return path.endsWith(sep) ? path : path + sep
}

/** True when `path` is a folder inside the videos folder (never the videos folder itself). */
export function isVideoFolder(dataDir: string, path: string): boolean {
  const folder = resolve(path)
  const parent = resolve(videosDir(dataDir))
  return folder.startsWith(withSlash(parent)) && folder !== parent
}

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export function newVideoId(): string {
  let id = ''
  for (let i = 0; i < 8; i++) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  return id
}

/** A file name from a title: lowercase, dashes, no spaces or punctuation. */
export function slugTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'video'
}

function stamp(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/** renders/<slug>-<yyyymmdd-hhmm>.mp4, relative to the video folder. */
export function renderFileName(title: string, at: number): string {
  return `${RENDERS_DIR}/${slugTitle(title)}-${stamp(at)}.mp4`
}

/**
 * A render's path that no earlier render of this video has used and no file has taken: the name
 * above, with -2, -3 and so on when two renders start in the same minute.
 */
export function uniqueRenderPath(folder: string, title: string, at: number, taken: readonly string[]): string {
  const base = renderFileName(title, at)
  const stem = base.slice(0, -'.mp4'.length)
  let candidate = base
  for (let n = 2; taken.includes(candidate) || existsSync(join(folder, candidate)); n++) candidate = `${stem}-${n}.mp4`
  return candidate
}

export function sizeOf(aspect: VideoAspect): { width: number; height: number } {
  // Own keys only: 'constructor' and 'toString' are not shapes.
  if (typeof aspect !== 'string' || !Object.hasOwn(VIDEO_SIZES, aspect)) throw new Error('Pick one of these shapes: 16:9, 9:16 or 1:1.')
  return VIDEO_SIZES[aspect]
}

/** The starter page: the right size, the two runtime includes, an empty stage. */
export function starterHtml(title: string, width: number, height: number, fps: number): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="regatta-video" content="width=${width},height=${height},fps=${fps}" />
    <title>${title.replace(/[<>&]/g, '')}</title>
    <link rel="stylesheet" href="regatta-video.css" />
    <script src="regatta-video.js"></script>
  </head>
  <body>
    <main id="stage"></main>
  </body>
</html>
`
}

/** Copies the runtime files in, overwriting whatever the agent left there. */
export function copyRuntimeFiles(resourcesDir: string, folder: string): void {
  for (const name of ['regatta-video.js', 'regatta-video.css']) {
    const from = join(resourcesDir, name)
    // A video without its runtime fails in ways that are hard to read, so say it here.
    if (!existsSync(from)) throw new Error(`Regatta's video runtime file ${name} is missing from ${resourcesDir}. Reinstall Regatta.`)
    copyFileSync(from, join(folder, name))
  }
}

function writeFileAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, data)
  renameSync(temp, path)
}

export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function planPath(folder: string): string {
  return join(folder, PLAN_FILE)
}

export function indexPath(folder: string): string {
  return join(folder, INDEX_FILE)
}

export function readPlan(folder: string): string {
  try {
    return readFileSync(planPath(folder), 'utf8')
  } catch {
    return ''
  }
}

export function writePlan(folder: string, text: string): void {
  writeFileAtomic(planPath(folder), text)
}

export function planIsFilled(folder: string): boolean {
  return readPlan(folder).trim().length > 0
}

// What a video.json may hold. Anything outside these lists is dropped when it is read, so a file
// that was edited by hand, or written by another version, can never crash the app.
const ASPECTS = new Set<string>(Object.keys(VIDEO_SIZES))
const AGENT_KINDS = new Set(['claude', 'codex', 'fake'])
const STATUSES = new Set(['new', 'planning', 'planned', 'building', 'checking', 'ready', 'failed'])
const TURN_KINDS = new Set(['plan', 'build', 'revise', 'change', 'fix'])
const TURN_STATUSES = new Set(['running', 'done', 'failed', 'stopped'])
const RENDER_STATUSES = new Set(['rendering', 'done', 'failed', 'stopped'])
const CHECK_NAMES = new Set(['loads', 'stable', 'captions'])
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const RENDER_PATH = /^renders\/[^/\\]+\.mp4$/
const THUMB_PATH = /^thumbs\/[^/\\]+\.png$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function maybeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function listOf<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const item of value) {
    const entry = read(item)
    if (entry !== null) out.push(entry)
  }
  return out
}

function readScene(item: unknown): VideoScene | null {
  if (!isRecord(item) || typeof item['id'] !== 'string') return null
  return { id: item['id'], title: text(item['title']), start: count(item['start'], 0), duration: count(item['duration'], 0) }
}

function readTurn(item: unknown): VideoTurn | null {
  if (!isRecord(item) || typeof item['id'] !== 'string') return null
  const kind = text(item['kind'])
  const status = text(item['status'])
  if (!TURN_KINDS.has(kind) || !TURN_STATUSES.has(status)) return null
  return {
    id: item['id'],
    kind: kind as VideoTurn['kind'],
    status: status as VideoTurn['status'],
    startedAt: count(item['startedAt'], 0),
    endedAt: maybeCount(item['endedAt']),
    note: text(item['note']),
    tokens: maybeCount(item['tokens']),
    latest: text(item['latest'])
  }
}

function readCheck(item: unknown): VideoCheck | null {
  if (!isRecord(item) || !CHECK_NAMES.has(text(item['name']))) return null
  return { name: item['name'] as VideoCheck['name'], passed: item['passed'] === true, detail: text(item['detail']) }
}

function readRender(item: unknown): VideoRender | null {
  if (!isRecord(item) || typeof item['id'] !== 'string') return null
  const path = text(item['path'])
  const status = text(item['status'])
  // A render's file is always one inside renders/; anything else could point anywhere.
  if (!RENDER_PATH.test(path) || !RENDER_STATUSES.has(status)) return null
  return {
    id: item['id'],
    path,
    status: status as VideoRender['status'],
    progress: Math.max(0, Math.min(1, count(item['progress'], 0))),
    startedAt: count(item['startedAt'], 0),
    endedAt: maybeCount(item['endedAt']),
    sizeBytes: maybeCount(item['sizeBytes']),
    loudness: maybeCount(item['loudness']),
    note: text(item['note'])
  }
}

/**
 * A project read from video.json, or null when the file cannot be trusted as one: not an object,
 * an id that is not the folder's name, a shape or agent that is not known. Lists drop their bad
 * entries; derived fields (canUndo) are reset, to be worked out from the folder.
 */
export function normalizeProject(raw: unknown, folderName: string): VideoProject | null {
  if (!isRecord(raw)) return null
  const id = text(raw['id'])
  if (!ID_PATTERN.test(id) || id !== folderName) return null
  const aspect = text(raw['aspect'])
  if (!ASPECTS.has(aspect)) return null
  const agent = text(raw['agent'])
  if (!AGENT_KINDS.has(agent)) return null
  const title = text(raw['title']).trim()
  if (title.length === 0) return null
  const size = VIDEO_SIZES[aspect as VideoAspect]
  const fps = count(raw['fps'], 30)
  const status = text(raw['status'])
  const thumbnails: Record<string, string> = {}
  if (isRecord(raw['thumbnails'])) {
    for (const [scene, path] of Object.entries(raw['thumbnails'])) {
      if (typeof path === 'string' && THUMB_PATH.test(path)) thumbnails[scene] = path
    }
  }
  return {
    id,
    title,
    brief: text(raw['brief']),
    aspect: aspect as VideoAspect,
    width: size.width,
    height: size.height,
    fps: fps >= 1 && fps <= 120 ? fps : 30,
    agent: agent as VideoProject['agent'],
    projectRoot: text(raw['projectRoot']),
    status: STATUSES.has(status) ? (status as VideoProject['status']) : 'failed',
    duration: maybeCount(raw['duration']),
    scenes: listOf(raw['scenes'], readScene),
    turns: listOf(raw['turns'], readTurn),
    checks: listOf(raw['checks'], readCheck),
    renders: listOf(raw['renders'], readRender),
    thumbnails,
    canUndo: false,
    createdAt: count(raw['createdAt'], 0),
    updatedAt: count(raw['updatedAt'], 0)
  }
}

/** The project in a video's folder, or null when there is none or it cannot be trusted. */
export function readProject(folder: string): VideoProject | null {
  return normalizeProject(readJson<unknown>(join(folder, PROJECT_FILE)), basename(folder))
}

/** Writes video.json. `canUndo` is not stored: it comes from the snapshots in the folder. */
export function writeProject(folder: string, project: VideoProject): void {
  const { canUndo: _derived, ...stored } = project
  void _derived
  writeJson(join(folder, PROJECT_FILE), stored)
}

/**
 * A video that quit mid turn or mid render loads with that turn or render stopped: a turn that
 * never ended leaves the video failed, a render that never ended leaves it as it was (ready).
 */
export function settleAfterRestart(project: VideoProject, now: number): VideoProject {
  const turns: VideoTurn[] = project.turns.map((turn) =>
    turn.status === 'running' ? { ...turn, status: 'stopped', endedAt: turn.endedAt ?? now } : turn
  )
  const renders: VideoRender[] = project.renders.map((render) =>
    render.status === 'rendering'
      ? { ...render, status: 'stopped', endedAt: render.endedAt ?? now, note: render.note || 'Stopped when the app closed.' }
      : render
  )
  const midTurn = project.status === 'planning' || project.status === 'building' || project.status === 'checking'
  return {
    ...project,
    turns,
    renders,
    status: midTurn ? 'failed' : project.status
  }
}

export function snapshotsDir(folder: string): string {
  return join(folder, HISTORY_DIR)
}

/** Snapshot names, newest last, as ["1", "2", "3"]. */
export function listSnapshots(folder: string): string[] {
  const dir = snapshotsDir(folder)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((name) => /^\d+$/.test(name) && statSync(join(dir, name)).isDirectory())
    .sort((a, b) => Number(a) - Number(b))
}

/** The next snapshot name: one past the highest there is. */
export function nextSnapshotName(folder: string): string {
  const names = listSnapshots(folder)
  const highest = names.length > 0 ? Number(names[names.length - 1]) : 0
  return String(highest + 1)
}

/** Copies a folder tree, leaving out any folder in `skip`. */
export function copyTree(from: string, to: string, skip: ReadonlySet<string> = new Set()): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const src = join(from, entry.name)
    const dest = join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dest, skip)
    else if (entry.isFile()) {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
    }
  }
}

/**
 * The folder as it is now, at .history/<name>/, without the renders, the other snapshots and
 * video.json. The project file is the app's record of the turns and renders, not part of the video,
 * and an undo must never roll that back.
 */
export function snapshotFolder(folder: string, name: string): string {
  const target = join(snapshotsDir(folder), name)
  rmSync(target, { recursive: true, force: true })
  copyTree(folder, target, new Set([RENDERS_DIR, HISTORY_DIR, PROJECT_FILE]))
  return target
}

/** Keeps only the newest `keep` snapshots. */
export function trimSnapshots(folder: string, keep = SNAPSHOT_KEEP): void {
  const names = listSnapshots(folder)
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    rmSync(join(snapshotsDir(folder), name), { recursive: true, force: true })
  }
}

/**
 * Puts the newest snapshot back over the folder. Renders, the other snapshots and video.json stay:
 * the user keeps the files they made, and thumbnails go with the check that runs next.
 */
export function restoreSnapshot(folder: string, name: string): void {
  const source = join(snapshotsDir(folder), name)
  if (!existsSync(source)) throw new Error('Nothing to undo.')
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === RENDERS_DIR || entry.name === HISTORY_DIR || entry.name === PROJECT_FILE) continue
    rmSync(join(folder, entry.name), { recursive: true, force: true })
  }
  copyTree(source, folder, new Set())
  rmSync(source, { recursive: true, force: true })
}

/** Deletes a video's folder. Only ever a folder inside the videos folder. */
export function removeVideoFolder(dataDir: string, id: string): boolean {
  const folder = videoFolder(dataDir, id)
  if (!isVideoFolder(dataDir, folder)) return false
  if (!existsSync(folder)) return false
  // A render or an agent that was just stopped may still be closing files in there.
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  return true
}

/** Every video folder under <dataDir>/videos/, oldest id first. */
export function listVideoFolders(dataDir: string): string[] {
  const dir = videosDir(dataDir)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
    .sort()
}

/** A scratch folder in the system temp folder, for job and report files. */
export function makeJobDir(): string {
  return mkdtempSync(join(tmpdir(), 'regatta-video-'))
}

/** The size of a file, or null when it is not there. */
export function fileSize(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}
