// Backend for the Files panel.
// Every path is relative to the workspace root and must stay inside it.

import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { FileContent, FileEntry } from '../shared/types'

/** Never listed: version control data, installed packages and Finder droppings. */
const SKIP = new Set(['.git', 'node_modules', '.DS_Store'])

/** Files bigger than this are not opened in the editor. */
const MAX_BYTES = 2 * 1024 * 1024

/** How much of a file we look at when deciding whether it is binary. */
const SNIFF_BYTES = 8000

function outsideProject(): Error {
  return new Error('That path is outside the project')
}

/** Relative paths travel over IPC with forward slashes; "." and extra slashes mean the same folder. */
function normalize(rel: string): string {
  return rel
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/')
}

/** The panel only ever sends relative paths, so anything absolute is refused rather than guessed at. */
function looksAbsolute(rel: string): boolean {
  return /^[/\\]/.test(rel) || /^[A-Za-z]:[\\/]/.test(rel)
}

/** True when `abs` is the root itself or sits inside it. */
function inside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep)
}

async function realRoot(root: string): Promise<string> {
  return fs.realpath(resolve(root))
}

async function realOrNull(abs: string): Promise<string | null> {
  try {
    return await fs.realpath(abs)
  } catch {
    return null
  }
}

/**
 * Resolves a relative path to a real location inside the root.
 * Symlinks are followed, so one that points outside the project is rejected too.
 */
async function resolveInside(root: string, rel: string): Promise<string> {
  const base = await realRoot(root)
  if (looksAbsolute(rel)) throw outsideProject()
  const clean = normalize(rel)
  if (!clean) return base
  const target = resolve(base, clean)
  if (!inside(base, target)) throw outsideProject()
  const real = await fs.realpath(target)
  if (!inside(base, real)) throw outsideProject()
  return real
}

/**
 * Resolves a relative path for writing. The file itself may be new, but its folder has to exist,
 * and an existing symlink is only followed while it stays inside the project.
 */
async function resolveForWrite(root: string, rel: string): Promise<string> {
  const base = await realRoot(root)
  if (looksAbsolute(rel)) throw outsideProject()
  const clean = normalize(rel)
  if (!clean) throw outsideProject()
  const target = resolve(base, clean)
  if (!inside(base, target)) throw outsideProject()
  const parent = await fs.realpath(dirname(target))
  if (!inside(base, parent)) throw outsideProject()
  const existing = await realOrNull(target)
  if (existing === null) return join(parent, basename(target))
  if (!inside(base, existing)) throw outsideProject()
  return existing
}

function childPath(dir: string, name: string): string {
  const clean = normalize(dir)
  return clean ? `${clean}/${name}` : name
}

/** Folders first, then files, each group by name without regard to case. */
function byKindThenName(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  if (x !== y) return x < y ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Lists one folder. `dir` is relative to `root` ("" for the root itself). */
export async function listDir(root: string, dir: string): Promise<FileEntry[]> {
  const abs = await resolveInside(root, dir)
  const found = await fs.readdir(abs, { withFileTypes: true })
  const entries: FileEntry[] = []
  for (const entry of found) {
    if (SKIP.has(entry.name)) continue
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, path: childPath(dir, entry.name), kind: 'dir', size: null })
      continue
    }
    // A symlink is whatever it points at; one that is broken is not worth listing.
    const stat = await fs.stat(join(abs, entry.name)).catch(() => null)
    if (!stat) continue
    entries.push({
      name: entry.name,
      path: childPath(dir, entry.name),
      kind: stat.isDirectory() ? 'dir' : 'file',
      size: stat.isDirectory() ? null : stat.size
    })
  }
  return entries.sort(byKindThenName)
}

/** Reads a text file for viewing or editing. */
export async function readFile(root: string, path: string): Promise<FileContent> {
  const abs = await resolveInside(root, path)
  const rel = normalize(path)
  const from = resolve(root)
  const stat = await fs.stat(abs)
  if (stat.size > MAX_BYTES) {
    return { path: rel, root: from, content: '', size: stat.size, binary: false, tooLarge: true }
  }
  const bytes = await fs.readFile(abs)
  const head = bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES))
  if (head.includes(0)) {
    return { path: rel, root: from, content: '', size: stat.size, binary: true, tooLarge: false }
  }
  return { path: rel, root: from, content: bytes.toString('utf8'), size: stat.size, binary: false, tooLarge: false }
}

/**
 * Saves a text file. `openedIn` is the `root` the file was read from: after a switch to another
 * project the same relative path is a different file, so the save is refused.
 */
export async function writeFile(root: string, path: string, content: string, openedIn: string): Promise<void> {
  if (resolve(openedIn) !== resolve(root)) {
    throw new Error('Not saved: another project is open now. Copy your edits, then open the file again in this project.')
  }
  await fs.writeFile(await resolveForWrite(root, path), content, 'utf8')
}