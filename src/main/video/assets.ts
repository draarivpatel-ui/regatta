// Brand assets copied out of the project into a video folder, so the agent can use the project's
// own look and never link outside the video.

import { copyFileSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** How many image files to copy, at most. */
export const ASSET_LIMIT = 12
/** How big one of them may be, at most. */
export const ASSET_MAX_BYTES = 2 * 1024 * 1024
/** How many folders below the project to look. */
export const ASSET_MAX_DEPTH = 4
/** Folders that never hold anything worth copying. Anything hidden (.git, .next, ...) is skipped too. */
export const ASSET_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target'])
/** A project root that is a whole home folder could hold a very large tree; the search gives up after this many folders. */
export const ASSET_MAX_FOLDERS = 2000

const ASSET_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
const ASSET_NAMES = /logo|icon|brand|banner|hero|screenshot|og|favicon/i

export interface BrandAsset {
  /** The file name it is copied to inside assets/. */
  name: string
  /** Where it came from, as an absolute path. */
  from: string
}

function looksLikeBrandAsset(name: string): boolean {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return false
  return ASSET_EXTENSIONS.has(lower.slice(dot)) && ASSET_NAMES.test(lower)
}

function realOf(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** True when `path` is `root` or something under it. Both sides are resolved, symlinks included. */
function inside(root: string, path: string): boolean {
  const realRoot = realOf(root) ?? resolve(root)
  const realPath = realOf(path) ?? resolve(path)
  return realPath === realRoot || realPath.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
}

/**
 * The project's brand images, up to ASSET_LIMIT of them, searched at most ASSET_MAX_DEPTH folders
 * deep. Hidden files and folders and the folders in ASSET_SKIP_DIRS are skipped, and so is every
 * symlink, so the search can never leave the project. Folders are searched level by level and in
 * name order, so the same project always gives the same files, and shallow ones (the logo in the
 * root) come before deep ones.
 */
export function findBrandAssets(root: string, limit = ASSET_LIMIT): BrandAsset[] {
  const base = resolve(root)
  const found: BrandAsset[] = []
  let level = [base]
  let visited = 0
  for (let depth = 0; depth <= ASSET_MAX_DEPTH && level.length > 0 && found.length < limit; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (found.length >= limit || visited >= ASSET_MAX_FOLDERS) break
      visited++
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of entries) {
        if (found.length >= limit) break
        const name = entry.name
        const path = join(dir, name)
        // A symlink could point anywhere, including outside the project, so it is never followed.
        if (entry.isSymbolicLink() || name.startsWith('.')) continue
        if (entry.isDirectory()) {
          if (!ASSET_SKIP_DIRS.has(name) && inside(base, path)) next.push(path)
          continue
        }
        if (!entry.isFile() || !looksLikeBrandAsset(name)) continue
        let size = 0
        try {
          size = statSync(path).size
        } catch {
          continue
        }
        if (size === 0 || size > ASSET_MAX_BYTES) continue
        found.push({ name, from: path })
      }
    }
    level = next
  }
  return found
}

function uniqueName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let n = 2
  while (taken.has(`${stem}-${n}${ext}`)) n++
  return `${stem}-${n}${ext}`
}

/** The list the agent reads, so it knows what came from where. */
export function assetsIndex(assets: BrandAsset[]): string {
  const lines = [
    '# Assets',
    '',
    'Images copied out of the project, with the path each one came from. Use them in the video; copy',
    'more from the project if you need them, and never link outside this folder.',
    ''
  ]
  for (const asset of assets) lines.push(`- ${asset.name}: ${asset.from}`)
  lines.push('')
  return lines.join('\n')
}

/** Copies the project's brand assets into <folder>/assets/ and writes assets/INDEX.md. */
export function copyBrandAssets(projectRoot: string, folder: string): BrandAsset[] {
  const found = findBrandAssets(projectRoot)
  const dir = join(folder, 'assets')
  mkdirSync(dir, { recursive: true })
  const taken = new Set<string>()
  const copied: BrandAsset[] = []
  for (const asset of found) {
    const name = uniqueName(taken, asset.name)
    const dest = join(dir, name)
    try {
      copyFileSync(asset.from, dest)
      if (!inside(dir, dest)) continue
    } catch {
      continue
    }
    taken.add(name)
    copied.push({ ...asset, name })
  }
  writeFileSync(join(dir, 'INDEX.md'), assetsIndex(copied), 'utf8')
  return copied
}
