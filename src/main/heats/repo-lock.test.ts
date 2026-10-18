// The repository lock, against real repositories.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { repoLockKey, withRepoLock } from './repo-lock'

const dirs: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
function sh(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function makeRepo(): string {
  const dir = temp('regatta-lock-repo-')
  sh(['init', '-b', 'main'], dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.txt'), 'a\n')
  sh(['add', '.'], dir)
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-m', 'first'], dir)
  return dir
}

describe('repoLockKey', () => {
  it('is one name for the root, a folder inside it, a symlink to it and a linked worktree', async () => {
    const repo = makeRepo()
    const link = join(temp('regatta-lock-link-'), 'link')
    symlinkSync(repo, link)
    const linked = join(temp('regatta-lock-wt-'), 'wt')
    sh(['worktree', 'add', '-b', 'other', linked], repo)
    const key = await repoLockKey(repo)
    expect(await repoLockKey(join(repo, 'src'))).toBe(key)
    expect(await repoLockKey(link)).toBe(key)
    expect(await repoLockKey(linked)).toBe(key)
    expect(await repoLockKey(makeRepo())).not.toBe(key)
  }, 30000)
})

describe('repository identity that cannot be read', () => {
  it('refuses instead of falling back to the folder, which would split the lock', async () => {
    const plain = temp('regatta-lock-plain-')
    await expect(repoLockKey(plain)).rejects.toThrow(/Could not tell which repository/)
    let ran = false
    await expect(
      withRepoLock(plain, async () => {
        ran = true
      })
    ).rejects.toThrow(/nothing was done/)
    expect(ran).toBe(false)

    // A repository whose git folder was damaged after the lock was first taken is refused the same way.
    const repo = makeRepo()
    await repoLockKey(repo)
    rmSync(join(repo, '.git', 'HEAD'))
    await expect(repoLockKey(repo)).rejects.toThrow(/Could not tell which repository/)
    await expect(withRepoLock(repo, async () => 'ran')).rejects.toThrow()
  }, 30000)
})

describe('repository identity on a case-insensitive volume', () => {
  const insensitive = (() => {
    const probe = temp('regatta-lock-probe-')
    writeFileSync(join(probe, 'Probe'), 'x')
    return existsSync(join(probe, 'pROBE'))
  })()

  it.skipIf(!insensitive)('is one key and one lock for a path spelled in another case', async () => {
    const holder = temp('regatta-lock-case-')
    const repo = join(holder, 'MixedCase-Repo')
    mkdirSync(repo)
    sh(['init', '-b', 'main'], repo)
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    sh(['add', '.'], repo)
    sh(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-m', 'first'], repo)
    const other = join(holder, 'mixedcase-repo')
    expect(await repoLockKey(other)).toBe(await repoLockKey(repo))
    const events: string[] = []
    const task = (name: string) => async (): Promise<void> => {
      events.push(`start ${name}`)
      await new Promise((resolve) => setTimeout(resolve, 80))
      events.push(`end ${name}`)
    }
    await Promise.all([withRepoLock(repo, task('a')), withRepoLock(other, task('b'))])
    // Each key comes from its own git call, so which holder gets in first depends on timing. What matters is
    // that they never overlap: whichever started first ended before the other started.
    expect(events).toHaveLength(4)
    expect(events[0]!.startsWith('start ')).toBe(true)
    expect(events[1]).toBe(`end ${events[0]!.slice('start '.length)}`)
    expect(events[2]!.startsWith('start ')).toBe(true)
    expect(events[3]).toBe(`end ${events[2]!.slice('start '.length)}`)
    expect(new Set([events[0], events[2]]).size).toBe(2)
  }, 30000)
})

describe('withRepoLock', () => {
  it('runs tasks for the same repository one after the other, whichever folder names it', async () => {
    const repo = makeRepo()
    const events: string[] = []
    const task = (name: string) => async (): Promise<string> => {
      events.push(`start ${name}`)
      await new Promise((resolve) => setTimeout(resolve, 80))
      events.push(`end ${name}`)
      return name
    }
    const results = await Promise.all([
      withRepoLock(repo, task('root')),
      withRepoLock(join(repo, 'src'), task('inside')),
      withRepoLock(repo, task('again'))
    ])
    expect(results).toEqual(['root', 'inside', 'again'])
    // Never two started before the first one ended.
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]!.startsWith('start')).toBe(true)
      expect(events[i + 1]!.startsWith('end')).toBe(true)
    }
  }, 30000)

  it('is not stopped by a task that failed', async () => {
    const repo = makeRepo()
    await expect(withRepoLock(repo, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await withRepoLock(repo, async () => 'fine')).toBe('fine')
  }, 30000)
})
