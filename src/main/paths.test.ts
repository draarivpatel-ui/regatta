// Unit tests for the shared folder question: same, inside, or holding (round 2 finding 4). Temp folders
// by mkdtemp; one symlinked folder proves the comparison is canonical, not string equality.

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { canonical, related } from './paths'

const cleanupDirs: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanupDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true })
})

describe('related', () => {
  it('says yes for the same folder, a child, and a parent', () => {
    const root = temp('rg-paths-')
    const child = join(root, 'packages', 'web')
    expect(related(root, root)).toBe(true)
    expect(related(root, child)).toBe(true)
    expect(related(child, root)).toBe(true)
  })

  it('says no for two folders in different projects', () => {
    const a = temp('rg-paths-a-')
    const b = temp('rg-paths-b-')
    expect(related(a, b)).toBe(false)
    expect(related(join(a, 'src'), join(b, 'src'))).toBe(false)
  })

  it('does not treat a name prefix as containment', () => {
    const root = temp('rg-paths-')
    // /tmp/x/repo and /tmp/x/repo-web share a string prefix but are different folders.
    expect(related(join(root, 'repo'), join(root, 'repo-web'))).toBe(false)
  })

  it('matches a symlinked folder with the real folder it points at', () => {
    const root = temp('rg-paths-')
    const real = join(root, 'real')
    mkdirSync(real)
    const link = join(root, 'link')
    symlinkSync(real, link)
    expect(related(link, join(real, 'sub'))).toBe(true)
    expect(related(link, real)).toBe(true)
  })

  it('canonicalizes through symlinks and keeps a missing tail', () => {
    const root = temp('rg-paths-')
    expect(canonical(root)).toBe(realpathSync(root))
    // A folder that does not exist yet keeps its shape, with its existing ancestors resolved.
    expect(canonical(join(root, 'not', 'there'))).toBe(join(realpathSync(root), 'not', 'there'))
    // Through a symlinked ancestor the tail segments survive intact (they are not sliced off the raw path).
    const real = join(root, 'real2')
    mkdirSync(real)
    const link2 = join(root, 'link2')
    symlinkSync(real, link2)
    expect(canonical(join(link2, 'deep', 'folder'))).toBe(join(realpathSync(real), 'deep', 'folder'))
  })
})
