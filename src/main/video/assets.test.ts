// The project images copied into a video folder: only brand looking ones, never past a node_modules
// or a hidden folder, and never out of the project.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ASSET_LIMIT, ASSET_MAX_BYTES, ASSET_MAX_FOLDERS, copyBrandAssets, findBrandAssets } from './assets'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function write(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

/** A project with a logo at the root, brand files deeper down and things that must be skipped. */
function makeProject(): string {
  const root = tempDir('rg-video-asset-')
  write(join(root, 'logo.svg'), '<svg></svg>')
  write(join(root, 'public', 'banner.png'), 'banner')
  write(join(root, 'src', 'styles.css'), 'css')
  write(join(root, 'screenshots', 'hero-image.webp'), 'hero')
  write(join(root, 'node_modules', 'x', 'logo.png'), 'too deep in modules')
  write(join(root, '.git', 'icon.png'), 'hidden')
  write(join(root, 'dist', 'brand.svg'), 'built')
  write(join(root, 'a', 'b', 'c', 'd', 'e', 'favicon.ico'), 'six deep')
  write(join(root, 'a', 'b', 'c', 'd', 'screenshot.png'), 'four deep')
  write(join(root, 'notes.txt'), 'not an image')
  write(join(root, 'photo.png'), 'no brand word in the name')
  write(join(root, '.hidden-logo.png'), 'a hidden file')
  write(join(root, 'public', '.secret-banner.png'), 'a hidden file in a folder that is not hidden')
  return root
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('findBrandAssets', () => {
  it('finds brand images up to four folders deep', () => {
    const found = findBrandAssets(makeProject()).map((asset) => asset.from)
    const names = found.map((path) => path.split('/').pop())
    expect(names).toContain('logo.svg')
    expect(names).toContain('banner.png')
    expect(names).toContain('hero-image.webp')
    expect(names).toContain('screenshot.png')
  })

  it('skips node_modules, hidden folders, build output and anything deeper than four folders', () => {
    const names = findBrandAssets(makeProject()).map((asset) => asset.name)
    expect(names).not.toContain('favicon.ico')
    for (const skipped of ['brand.svg', 'icon.png', 'photo.png']) expect(names).not.toContain(skipped)
    for (const path of findBrandAssets(makeProject()).map((asset) => asset.from)) {
      expect(path).not.toContain('node_modules')
    }
  })

  it('skips hidden files as well as hidden folders', () => {
    const names = findBrandAssets(makeProject()).map((asset) => asset.name)
    expect(names).not.toContain('.hidden-logo.png')
    expect(names).not.toContain('.secret-banner.png')
  })

  it('does not copy a symlink to a file, even one that points inside the project', () => {
    const root = makeProject()
    symlinkSync(join(root, 'logo.svg'), join(root, 'logo-link.svg'))
    expect(findBrandAssets(root).map((asset) => asset.name)).not.toContain('logo-link.svg')
  })

  it('never follows a symlink out of the project', () => {
    const root = makeProject()
    const outside = tempDir('rg-video-outside-')
    write(join(outside, 'secret-logo.svg'), '<svg></svg>')
    symlinkSync(outside, join(root, 'linked'))
    const found = findBrandAssets(root).map((asset) => asset.from)
    expect(found.join(' ')).not.toContain('secret-logo')
  })

  it('prefers files near the top of the project, and always picks the same ones', () => {
    const root = tempDir('rg-video-order-')
    // More candidates than the limit, the shallow ones named so they sort last.
    for (let i = 0; i < ASSET_LIMIT; i++) write(join(root, 'deep', 'a', 'b', `logo-${String(i).padStart(2, '0')}.png`), 'x')
    write(join(root, 'zlogo.svg'), 'top')
    write(join(root, 'src', 'zicon.png'), 'one down')
    const first = findBrandAssets(root).map((asset) => asset.from)
    expect(first).toHaveLength(ASSET_LIMIT)
    expect(first[0]).toBe(join(root, 'zlogo.svg'))
    expect(first[1]).toBe(join(root, 'src', 'zicon.png'))
    expect(findBrandAssets(root).map((asset) => asset.from)).toEqual(first)
    // The deep ones fill what is left, in name order.
    expect(first[2]).toBe(join(root, 'deep', 'a', 'b', 'logo-00.png'))
  })

  it('gives up on a project with a huge number of folders, but still finds what is near the top', () => {
    const root = tempDir('rg-video-huge-')
    write(join(root, 'logo.svg'), 'top')
    for (let i = 0; i < ASSET_MAX_FOLDERS + 50; i++) mkdirSync(join(root, `d${String(i).padStart(5, '0')}`))
    write(join(root, 'zzz', 'logo.png'), 'last folder in name order')
    const names = findBrandAssets(root).map((asset) => asset.name)
    expect(names).toContain('logo.svg')
    expect(names).not.toContain('logo.png')
  })

  it('stops at the limit and skips files that are too big', () => {
    const root = tempDir('rg-video-many-')
    for (let i = 0; i < ASSET_LIMIT + 5; i++) write(join(root, `logo-${i}.png`), 'x'.repeat(10))
    write(join(root, 'huge-logo.png'), 'x'.repeat(ASSET_MAX_BYTES + 1))
    const found = findBrandAssets(root)
    expect(found).toHaveLength(ASSET_LIMIT)
    expect(found.map((asset) => asset.name)).not.toContain('huge-logo.png')
  })

  it('returns nothing for a folder that is not there', () => {
    expect(findBrandAssets(join(tempDir('rg-video-empty-'), 'nope'))).toEqual([])
  })
})

describe('copyBrandAssets', () => {
  it('copies the files in and lists where they came from', () => {
    const root = makeProject()
    const folder = tempDir('rg-video-folder-')
    const copied = copyBrandAssets(root, folder)
    expect(copied.map((asset) => asset.name)).toContain('logo.svg')
    expect(existsSync(join(folder, 'assets', 'logo.svg'))).toBe(true)
    const index = readFileSync(join(folder, 'assets', 'INDEX.md'), 'utf8')
    expect(index).toContain(`logo.svg: ${join(root, 'logo.svg')}`)
    expect(index).toContain(`banner.png: ${join(root, 'public', 'banner.png')}`)
    expect(index).not.toContain('node_modules')
    expect(index).not.toContain('hidden')
  })

  it('gives two files of the same name two names', () => {
    const root = tempDir('rg-video-dupes-')
    write(join(root, 'logo.png'), 'one')
    write(join(root, 'sub', 'logo.png'), 'two')
    const folder = tempDir('rg-video-folder-')
    const copied = copyBrandAssets(root, folder)
    expect(copied.map((asset) => asset.name)).toEqual(['logo.png', 'logo-2.png'])
    expect(readFileSync(join(folder, 'assets', 'logo.png'), 'utf8')).toBe('one')
    expect(readFileSync(join(folder, 'assets', 'logo-2.png'), 'utf8')).toBe('two')
  })

  it('writes an index even when the project has nothing to copy', () => {
    const root = tempDir('rg-video-plain-')
    const folder = tempDir('rg-video-folder-')
    copyBrandAssets(root, folder)
    expect(readFileSync(join(folder, 'assets', 'INDEX.md'), 'utf8')).toContain('# Assets')
  })
})
