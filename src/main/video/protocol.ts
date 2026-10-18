// The regatta-video:// protocol the Video preview loads from: regatta-video://<id>/<path> serves
// files from that video's folder, and the runtime files from Regatta's own resources.

import { protocol, session } from 'electron'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { VIDEO_SCHEME } from '../../shared/video'

/** The webview partition the Video preview runs in. A session only answers a scheme it was given a handler for. */
export const VIDEO_PARTITION = 'regatta-video'

/** Must run before the app is ready. */
export function registerVideoScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: VIDEO_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

const RUNTIME_FILES = new Set(['regatta-video.js', 'regatta-video.css'])

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
}

export function contentTypeOf(path: string): string | null {
  const dot = path.lastIndexOf('.')
  if (dot <= 0) return null
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? null
}

/** What a request for one path inside a video folder resolves to. */
export type VideoFileResult = { ok: true; file: string; type: string } | { ok: false; error: string }

function realOf(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function withSlash(path: string): string {
  return path.endsWith(sep) ? path : path + sep
}

/**
 * Where regatta-video://<id>/<path> reads from, or why it answers 404.
 *
 * The runtime files come from Regatta's resources; everything else comes from the video's own
 * folder. The path is decoded, no segment may be hidden or walk upwards, and nothing may resolve
 * (after realpath) outside the folder it came from.
 */
export function resolveVideoFile(videoFolder: string, resourcesDir: string, requestPath: string): VideoFileResult {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return { ok: false, error: 'The path is not valid' }
  }
  if (decoded.includes('\0')) return { ok: false, error: 'The path is not valid' }
  let path = decoded.replace(/\\/g, '/')
  if (path.startsWith('/')) path = path.slice(1)
  if (!path) path = 'index.html'
  if (isAbsolute(path)) return { ok: false, error: 'The path is absolute' }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    return { ok: false, error: 'The path walks out of the video folder' }
  }
  if (segments.some((segment) => segment.startsWith('.'))) return { ok: false, error: 'The path is hidden' }
  const base = RUNTIME_FILES.has(path) ? resourcesDir : videoFolder
  const target = resolve(join(base, path))
  const realBase = realOf(base)
  if (!realBase) return { ok: false, error: 'The video folder is gone' }
  const realTarget = realOf(target)
  if (!realTarget) return { ok: false, error: 'No such file' }
  if (realTarget !== realBase && !realTarget.startsWith(withSlash(realBase))) {
    return { ok: false, error: 'The path leaves the video folder' }
  }
  try {
    if (statSync(target).isDirectory()) return { ok: false, error: 'That is a folder' }
  } catch {
    return { ok: false, error: 'No such file' }
  }
  const type = contentTypeOf(target)
  if (!type) return { ok: false, error: 'That file type is not served' }
  return { ok: true, file: target, type }
}

/** An answer to one request: what the protocol hands back, before it becomes a Response. */
export interface VideoAnswer {
  status: number
  headers: Record<string, string>
  body: Uint8Array<ArrayBuffer> | string
}

function refusal(message: string): VideoAnswer {
  return {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    body: message
  }
}

/** Answers one regatta-video://<id>/<path> request. Pure apart from reading the file. */
export function serveVideoRequest(folderOf: (id: string) => string | null, resourcesDir: string, requestUrl: string): VideoAnswer {
  let url: URL
  let id: string
  try {
    url = new URL(requestUrl)
    id = decodeURIComponent(url.hostname)
  } catch {
    return refusal('That address is not valid')
  }
  const folder = folderOf(id)
  if (!folder) return refusal('No such video')
  const found = resolveVideoFile(folder, resourcesDir, url.pathname)
  if (!found.ok) return refusal(found.error)
  let body: Buffer
  try {
    body = readFileSync(found.file)
  } catch {
    return refusal('No such file')
  }
  return {
    status: 200,
    headers: {
      'content-type': found.type,
      'cache-control': 'no-store',
      'content-length': String(body.byteLength),
      'x-content-type-options': 'nosniff'
    },
    body: new Uint8Array(body)
  }
}

/**
 * Serves video folders. `folderOf` maps a video id to its folder (null when unknown). The handler
 * goes on the default session and on the preview's own partition.
 */
export function handleVideoProtocol(folderOf: (id: string) => string | null, resourcesDir: string): void {
  const answer = (request: Request): Response => {
    const served = serveVideoRequest(folderOf, resourcesDir, request.url)
    return new Response(served.body, { status: served.status, headers: served.headers })
  }
  for (const target of [protocol, session.fromPartition(VIDEO_PARTITION).protocol]) {
    if (!target.isProtocolHandled(VIDEO_SCHEME)) target.handle(VIDEO_SCHEME, answer)
  }
}
