// Worktree helpers against real git repositories in temp folders.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorktree, gitStatus, parsePorcelain, worktreesDir } from './git'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
}

/** A fresh repository with one commit and a README. */
function makeRepo(): string {
  const dir = temp('regatta-repo-')
  sh(['init', '-b', 'main'], dir)
  writeFileSync(join(dir, 'README.md'), '# regatta\n')
  sh(['add', '.'], dir)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], dir)
  return dir
}

const dirs: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

let previousWorktreesDir: string | undefined

beforeAll(() => {
  previousWorktreesDir = process.env['REGATTA_WORKTREES_DIR']
  process.env['REGATTA_WORKTREES_DIR'] = temp('regatta-worktrees-')
})

afterAll(() => {
  if (previousWorktreesDir === undefined) delete process.env['REGATTA_WORKTREES_DIR']
  else process.env['REGATTA_WORKTREES_DIR'] = previousWorktreesDir
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('createWorktree', () => {
  const repo = makeRepo()

  it('makes a folder with the code on its own branch', async () => {
    const info = await createWorktree(repo, 'Fix The Parser!')
    expect(info.branch).toBe('regatta/fix-the-parser')
    expect(info.path.startsWith(`${worktreesDir()}/`)).toBe(true)
    expect(info.path.endsWith('/fix-the-parser')).toBe(true)
    expect(readFileSync(join(info.path, 'README.md'), 'utf8')).toBe('# regatta\n')
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], info.path).trim()).toBe('regatta/fix-the-parser')
    expect(sh(['status', '--porcelain'], repo).trim()).toBe('')
  }, 30000)

  it('gives a name already taken the next branch and folder', async () => {
    const first = await createWorktree(repo, 'twin')
    const second = await createWorktree(repo, 'twin')
    expect(first.branch).toBe('regatta/twin')
    expect(second.branch).toBe('regatta/twin-2')
    expect(second.path).not.toBe(first.path)
    expect(second.path.endsWith('/twin-2')).toBe(true)
    expect(existsSync(second.path)).toBe(true)
  }, 30000)
})

describe('gitStatus', () => {
  const repo = makeRepo()

  it('reports the branch and the changed files', async () => {
    writeFileSync(join(repo, 'old-name.md'), '# move me\n')
    sh(['add', '.'], repo)
    sh([...IDENTITY, 'commit', '-m', 'add a file to move'], repo)
    expect(await gitStatus(repo)).toEqual({ branch: 'main', changes: [] })
    writeFileSync(join(repo, 'README.md'), '# regatta\nedited\n')
    writeFileSync(join(repo, 'fresh.md'), '# new file\n')
    sh(['mv', 'old-name.md', 'new-name.md'], repo)
    const status = await gitStatus(repo)
    expect(status?.branch).toBe('main')
    expect(status?.changes).toContainEqual({ path: 'README.md', status: ' M' })
    expect(status?.changes).toContainEqual({ path: 'fresh.md', status: '??' })
    // A rename is one change; its old path must not turn into a second entry.
    expect(status?.changes).toContainEqual({ path: 'new-name.md', status: 'R ' })
    expect(status?.changes).toHaveLength(3)
  }, 30000)
})

describe('outside a git repository', () => {
  const plain = temp('regatta-plain-')

  it('has no status', async () => {
    expect(await gitStatus(plain)).toBeNull()
  })

  it('cannot make a worktree', async () => {
    await expect(createWorktree(plain, 'nope')).rejects.toThrow('Worktrees need a git repository with at least one commit')
  })
})

describe('parsePorcelain', () => {
  it('reads codes and paths, including rename pairs', () => {
    const text = [' M src/a.ts', '?? notes.md', 'R  new.ts', 'old.ts', ''].join('\0')
    expect(parsePorcelain(text)).toEqual([
      { status: ' M', path: 'src/a.ts' },
      { status: '??', path: 'notes.md' },
      { status: 'R ', path: 'new.ts' }
    ])
  })
})
describe('gitStatus runs no user programs', () => {
  it('never runs an fsmonitor hook or a post-index-change hook, though plain git status does', () => {
    const repo = makeRepo()
    const marks = mkdtempSync(join(tmpdir(), 'regatta-git-marks-'))
    const fsmonitor = join(marks, 'fsmonitor.sh')
    writeFileSync(fsmonitor, `#!/bin/sh\ntouch "${join(marks, 'fsmonitor-ran')}"\nexit 1\n`, { mode: 0o755 })
    sh(['config', 'core.fsmonitor', fsmonitor], repo)
    writeFileSync(join(repo, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\ntouch "${join(marks, 'hook-ran')}"\n`, { mode: 0o755 })
    const touchReadme = (): void => writeFileSync(join(repo, 'README.md'), readFileSync(join(repo, 'README.md')))
    touchReadme()
    return gitStatus(repo).then((status) => {
      expect(status?.branch).toBe('main')
      expect(existsSync(join(marks, 'fsmonitor-ran'))).toBe(false)
      expect(existsSync(join(marks, 'hook-ran'))).toBe(false)
      // Positive control: plain git status runs both here.
      touchReadme()
      sh(['status', '--porcelain=v1'], repo)
      expect(existsSync(join(marks, 'fsmonitor-ran'))).toBe(true)
      expect(existsSync(join(marks, 'hook-ran'))).toBe(true)
      rmSync(marks, { recursive: true, force: true })
    })
  }, 30000)

  it('never runs a configured clean filter when a tracked file is stat-dirty', async () => {
    const repo = makeRepo()
    const marks = temp('regatta-git-filter-marks-')
    const marker = join(marks, 'clean-ran')
    const cleanScript = join(marks, 'clean.sh')
    writeFileSync(cleanScript, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 })
    writeFileSync(join(repo, '.gitattributes'), '*.md filter=lfs\n')
    sh(['add', '.gitattributes'], repo)
    sh([...IDENTITY, 'commit', '-m', 'add gitattributes'], repo)
    sh(['config', 'filter.lfs.clean', cleanScript], repo)

    const readme = join(repo, 'README.md')
    const future = new Date(Date.now() + 10_000)
    utimesSync(readme, future, future)

    const status = await gitStatus(repo)
    expect(status?.branch).toBe('main')
    expect(existsSync(marker)).toBe(false)

    // Positive control: plain git status runs the clean filter on the stat-dirty file.
    utimesSync(readme, new Date(Date.now() + 20_000), new Date(Date.now() + 20_000))
    sh(['status', '--porcelain=v1'], repo)
    expect(existsSync(marker)).toBe(true)
  }, 30000)
})
