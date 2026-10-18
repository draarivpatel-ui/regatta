// Unit tests for gitview.ts against real git repositories in temp folders.

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { errorLine, gitCommit, gitEnv, gitDiff, gitLog, gitOverview, gitStage, gitUnstage, gitWorktrees, hooksFor, hooksFromPaths, setHooksSandbox } from './gitview'
import { createWorktree, worktreesDir } from './git'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
}

function makeRepo(): string {
  const dir = temp('regatta-repo-')
  sh(['init', '-b', 'main'], dir)
  configure(dir)
  writeFileSync(join(dir, 'README.md'), '# regatta\n')
  sh(['add', '.'], dir)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], dir)
  return dir
}

/** The repository's own identity, as the task card requires, so tests never depend on the machine's. */
function configure(dir: string): void {
  sh(['config', 'user.name', 'Regatta Test'], dir)
  sh(['config', 'user.email', 'test@regatta.local'], dir)
  sh(['config', 'commit.gpgsign', 'false'], dir)
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
  setHooksSandbox(join(temp('regatta-sandbox-'), 'empty-hooks'))
})

afterAll(() => {
  setHooksSandbox(null)
  if (previousWorktreesDir === undefined) delete process.env['REGATTA_WORKTREES_DIR']
  else process.env['REGATTA_WORKTREES_DIR'] = previousWorktreesDir
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('gitOverview', () => {
  const repo = makeRepo()

  it('returns null outside a git repository', async () => {
    const plain = temp('regatta-plain-')
    expect(await gitOverview(plain)).toBeNull()
  })

  it('reports branch, hasCommits, files with various statuses', async () => {
    writeFileSync(join(repo, 'modified.txt'), 'original')
    sh(['add', 'modified.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'add modified.txt'], repo)
    writeFileSync(join(repo, 'modified.txt'), 'changed')
    writeFileSync(join(repo, 'added.txt'), 'new')
    writeFileSync(join(repo, 'deleted.txt'), 'to delete')
    sh(['add', 'deleted.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'add deleted.txt'], repo)
    writeFileSync(join(repo, 'deleted.txt'), 'modified before delete')
    sh(['rm', '-f', 'deleted.txt'], repo)
    sh(['mv', 'README.md', 'renamed.md'], repo)

    const overview = await gitOverview(repo)
    expect(overview).not.toBeNull()
    expect(overview!.branch).toBe('main')
    expect(overview!.detached).toBe(false)
    expect(overview!.hasCommits).toBe(true)
    expect(overview!.busy).toBeNull()
    expect(overview!.files.length).toBeGreaterThanOrEqual(4)

    const paths = overview!.files.map((f) => f.path).sort()
    expect(paths).toContain('added.txt')
    expect(paths).toContain('modified.txt')
    expect(paths).toContain('renamed.md')
    expect(paths).toContain('deleted.txt')

    const added = overview!.files.find((f) => f.path === 'added.txt')!
    expect(added.staged).toBe('?')
    expect(added.unstaged).toBe('?')

    const modified = overview!.files.find((f) => f.path === 'modified.txt')!
    expect(modified.staged).toBe(' ')
    expect(modified.unstaged).toBe('M')

    const renamed = overview!.files.find((f) => f.path === 'renamed.md')!
    expect(renamed.from).toBe('README.md')
    expect(renamed.staged).toBe('R')
    expect(renamed.unstaged).toBe(' ')
  })

  it('handles a file with spaces and non-ASCII in the name', async () => {
    const name = 'file with spaces àéï.txt'
    writeFileSync(join(repo, name), 'content')
    const overview = await gitOverview(repo)
    expect(overview).not.toBeNull()
    const file = overview!.files.find((f) => f.path === name)
    expect(file).toBeDefined()
    expect(file!.path).toBe(name)
  })

  it('detects detached HEAD', async () => {
    const detachedRepo = temp('regatta-detached-')
    sh(['init', '-b', 'main'], detachedRepo)
    writeFileSync(join(detachedRepo, 'a.txt'), 'a')
    sh(['add', '.'], detachedRepo)
    sh([...IDENTITY, 'commit', '-m', 'c1'], detachedRepo)
    const hash = sh(['rev-parse', 'HEAD'], detachedRepo).trim()
    sh(['checkout', '--detach', hash], detachedRepo)
    const overview = await gitOverview(detachedRepo)
    expect(overview).not.toBeNull()
    expect(overview!.branch).toBeNull()
    expect(overview!.detached).toBe(true)
    expect(overview!.hasCommits).toBe(true)
  })

  it('detects busy states', async () => {
    const mergeRepo = temp('regatta-merge-')
    sh(['init', '-b', 'main'], mergeRepo)
    writeFileSync(join(mergeRepo, 'a.txt'), 'a')
    sh(['add', '.'], mergeRepo)
    sh([...IDENTITY, 'commit', '-m', 'c1'], mergeRepo)
    sh(['checkout', '-b', 'feature'], mergeRepo)
    writeFileSync(join(mergeRepo, 'b.txt'), 'b')
    sh(['add', '.'], mergeRepo)
    sh([...IDENTITY, 'commit', '-m', 'c2'], mergeRepo)
    sh(['checkout', 'main'], mergeRepo)
    writeFileSync(join(mergeRepo, 'a.txt'), 'conflict')
    sh(['add', '.'], mergeRepo)
    sh([...IDENTITY, 'commit', '-m', 'c3'], mergeRepo)
    try {
      sh(['merge', '--no-ff', 'feature'], mergeRepo)
    } catch {
      // merge conflict expected
    }
    // Create MERGE_HEAD manually to simulate a merge in progress
    const { execFileSync } = await import('node:child_process')
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: mergeRepo, encoding: 'utf8' }).trim()
    const resolvedGitDir = gitDir.startsWith('/') ? gitDir : join(mergeRepo, gitDir)
    writeFileSync(join(resolvedGitDir, 'MERGE_HEAD'), 'abc123\n')

    const overview = await gitOverview(mergeRepo)
    expect(overview).not.toBeNull()
    expect(overview!.busy).toBe('merge')
  })

  it('detects rebase state', async () => {
    const rebaseRepo = temp('regatta-rebase-')
    sh(['init', '-b', 'main'], rebaseRepo)
    writeFileSync(join(rebaseRepo, 'a.txt'), 'a')
    sh(['add', '.'], rebaseRepo)
    sh([...IDENTITY, 'commit', '-m', 'c1'], rebaseRepo)
    sh(['checkout', '-b', 'feature'], rebaseRepo)
    writeFileSync(join(rebaseRepo, 'b.txt'), 'b')
    sh(['add', '.'], rebaseRepo)
    sh([...IDENTITY, 'commit', '-m', 'c2'], rebaseRepo)
    sh(['checkout', 'main'], rebaseRepo)
    writeFileSync(join(rebaseRepo, 'a.txt'), 'main change')
    sh(['add', '.'], rebaseRepo)
    sh([...IDENTITY, 'commit', '-m', 'c3'], rebaseRepo)
    try {
      sh(['rebase', 'main'], rebaseRepo)
    } catch {
      // rebase conflict expected
    }
    // Create rebase-merge directory to simulate a rebase in progress
    const { execFileSync } = await import('node:child_process')
    const { mkdirSync } = await import('node:fs')
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: rebaseRepo, encoding: 'utf8' }).trim()
    const resolvedGitDir = gitDir.startsWith('/') ? gitDir : join(rebaseRepo, gitDir)
    mkdirSync(join(resolvedGitDir, 'rebase-merge'), { recursive: true })
    writeFileSync(join(resolvedGitDir, 'rebase-merge', 'head-name'), 'refs/heads/feature\n')

    const overview = await gitOverview(rebaseRepo)
    expect(overview).not.toBeNull()
    expect(overview!.busy).toBe('rebase')
  })
})

describe('gitDiff', () => {
  const repo = makeRepo()

  it('shows staged diff', async () => {
    writeFileSync(join(repo, 'README.md'), '# regatta\nedited\n')
    sh(['add', 'README.md'], repo)
    const diff = await gitDiff(repo, 'README.md', true)
    expect(diff.path).toBe('README.md')
    expect(diff.staged).toBe(true)
    expect(diff.text).toContain('+edited')
    expect(diff.text).toContain('# regatta')
    expect(diff.binary).toBe(false)
    expect(diff.tooLarge).toBe(false)
  })

  it('shows unstaged diff', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'README.md'), '# regatta\nedited\n')
    const diff = await gitDiff(repo, 'README.md', false)
    expect(diff.path).toBe('README.md')
    expect(diff.staged).toBe(false)
    expect(diff.text).toContain('+edited')
    expect(diff.text).toContain('# regatta')
    expect(diff.binary).toBe(false)
  })

  it('shows untracked file as all additions', async () => {
    writeFileSync(join(repo, 'new-file.txt'), 'line1\nline2\n')
    const diff = await gitDiff(repo, 'new-file.txt', false)
    expect(diff.path).toBe('new-file.txt')
    expect(diff.untracked).toBe(true)
    expect(diff.text).toContain('+line1')
    expect(diff.text).toContain('+line2')
  })

  it('marks binary files', async () => {
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
    writeFileSync(join(repo, 'binary.dat'), binaryContent)
    sh(['add', 'binary.dat'], repo)
    const diff = await gitDiff(repo, 'binary.dat', true)
    expect(diff.binary).toBe(true)
    expect(diff.text).toBe('')
  })

  it('marks too large diffs', async () => {
    const largeContent = 'x'.repeat(2_000_000)
    writeFileSync(join(repo, 'huge.txt'), largeContent)
    sh(['add', 'huge.txt'], repo)
    const diff = await gitDiff(repo, 'huge.txt', true)
    expect(diff.tooLarge).toBe(true)
    expect(diff.text).toBe('')
  })

  it('throws on invalid paths', async () => {
    await expect(gitDiff(repo, '', false)).rejects.toThrow('Invalid path')
    await expect(gitDiff(repo, '../outside.txt', false)).rejects.toThrow('Invalid path')
    await expect(gitDiff(repo, '/absolute.txt', false)).rejects.toThrow('Invalid path')
  })
})

describe('gitStage and gitUnstage', () => {
  it('stage and unstage leave file bytes unchanged', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'tracked.txt'), 'original')
    sh(['add', 'tracked.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'add tracked'], repo)
    writeFileSync(join(repo, 'tracked.txt'), 'modified')
    const before = readFileSync(join(repo, 'tracked.txt'), 'utf8')

    await gitStage(repo, ['tracked.txt'])
    const afterStage = readFileSync(join(repo, 'tracked.txt'), 'utf8')
    expect(afterStage).toBe(before)

    await gitUnstage(repo, ['tracked.txt'])
    const afterUnstage = readFileSync(join(repo, 'tracked.txt'), 'utf8')
    expect(afterUnstage).toBe(before)
  })

  it('unstage in a repo with no commits uses rm --cached', async () => {
    const repo = temp('regatta-no-commits-')
    sh(['init', '-b', 'main'], repo)
    writeFileSync(join(repo, 'new.txt'), 'content')
    sh(['add', 'new.txt'], repo)
    await gitUnstage(repo, ['new.txt'])
    const status = sh(['status', '--porcelain'], repo).trim()
    expect(status).toContain('?? new.txt')
  })

  it('throws on absolute, .., and unknown paths', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'known.txt'), 'content')
    await expect(gitStage(repo, ['../outside.txt'])).rejects.toThrow('Invalid path')
    await expect(gitStage(repo, ['/absolute.txt'])).rejects.toThrow('Invalid path')
    await expect(gitStage(repo, ['unknown.txt'])).rejects.toThrow('Path not in current status')
    await expect(gitUnstage(repo, ['unknown.txt'])).rejects.toThrow('Path not in current status')
  })
})

describe('gitCommit', () => {
  it('refuses an empty message', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), 'a')
    sh(['add', 'a.txt'], repo)
    await expect(gitCommit(repo, '   ', ['a.txt'])).rejects.toThrow('Commit message cannot be empty')
  })

  it('refuses when nothing is staged', async () => {
    const repo = makeRepo()
    await expect(gitCommit(repo, 'msg', [])).rejects.toThrow('Nothing staged to commit')
  })

  it('refuses when expected differs from staged', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), 'a')
    sh(['add', 'a.txt'], repo)
    await expect(gitCommit(repo, 'msg', ['b.txt'])).rejects.toThrow('Path not in current status')
  })

  it('returns the new commit hash and subject', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'commit-me.txt'), 'content')
    sh(['add', 'commit-me.txt'], repo)
    const commit = await gitCommit(repo, 'my commit message', ['commit-me.txt'])
    expect(commit.hash).toMatch(/^[a-f0-9]{40}$/)
    expect(commit.subject).toBe('my commit message')
    expect(commit.author).toBe('Regatta Test')
    expect(commit.at).toBeGreaterThan(0)
  })
})

describe('gitLog', () => {
  const repo = makeRepo()

  it('returns commits with hash, subject, author, and timestamp', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a')
    sh(['add', 'a.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'second commit'], repo)
    writeFileSync(join(repo, 'b.txt'), 'b')
    sh(['add', 'b.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'third commit'], repo)

    const log = await gitLog(repo, 30)
    expect(log.length).toBe(3)
    expect(log[0]!.subject).toBe('third commit')
    expect(log[1]!.subject).toBe('second commit')
    expect(log[2]!.subject).toBe('first commit')
    for (const c of log) {
      expect(c.hash).toMatch(/^[a-f0-9]{40}$/)
      expect(c.author).toBe('Regatta Test')
      expect(c.at).toBeGreaterThan(0)
    }
  })

  it('clamps limit to 1..200', async () => {
    const log1 = await gitLog(repo, 0)
    expect(log1.length).toBeLessThanOrEqual(1)
    const log2 = await gitLog(repo, 500)
    expect(log2.length).toBeLessThanOrEqual(200)
  })
})

describe('gitWorktrees', () => {
  it('marks the main folder and an added worktree', async () => {
    const repo = makeRepo()
    const wt = await createWorktree(repo, 'feature')
    const { realpathSync } = await import('node:fs')
    const worktrees = await gitWorktrees(repo)
    expect(worktrees.length).toBe(2)
    expect(worktrees[0]!.main).toBe(true)
    expect(worktrees[0]!.regatta).toBe(false)
    expect(worktrees[1]!.main).toBe(false)
    expect(worktrees[1]!.regatta).toBe(true)
    expect(realpathSync(worktrees[1]!.path)).toBe(realpathSync(wt.path))
    expect(worktrees[1]!.branch).toBe('regatta/feature')
  })
})

// ---------------------------------------------------------------------------------------------
// Review findings. Each test below failed against the first implementation of the Git panel.

function head(dir: string): string {
  return sh(['rev-parse', 'HEAD'], dir).trim()
}

function stagedNames(dir: string): string[] {
  return sh(['diff', '--cached', '--name-only', '-z'], dir).split('\0').filter(Boolean).sort()
}

function installHook(dir: string, name: string, body: string): void {
  const hooks = join(dir, '.git', 'hooks')
  mkdirSync(hooks, { recursive: true })
  const file = join(hooks, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** A repository with a staged a.txt, a marker path outside the working tree, and nothing else. */
function stagedRepo(): { repo: string; marker: string } {
  const repo = makeRepo()
  writeFileSync(join(repo, 'a.txt'), 'a')
  sh(['add', 'a.txt'], repo)
  return { repo, marker: join(temp('regatta-marker-'), 'ran') }
}

describe('hooks: the panel refuses instead of running them', () => {
  const REFUSAL = /does not run hooks yet, so commit from a terminal/

  it('refuses a commit when a pre-commit hook exists, and the hook never runs', async () => {
    const { repo, marker } = stagedRepo()
    installHook(repo, 'pre-commit', `echo ran > "${marker}"`)
    const before = head(repo)
    const index = sh(['ls-files', '-s'], repo)
    await expect(gitCommit(repo, 'msg', ['a.txt'])).rejects.toThrow(/This repository has git hooks \(pre-commit\)\. The Git panel does not run hooks yet, so commit from a terminal\./)
    expect(head(repo)).toBe(before)
    expect(sh(['ls-files', '-s'], repo)).toBe(index)
    expect(existsSync(marker)).toBe(false)
  })

  it('commits when the hook file is not executable, because git ignores it', async () => {
    const { repo, marker } = stagedRepo()
    installHook(repo, 'pre-commit', `echo ran > "${marker}"`)
    chmodSync(join(repo, '.git', 'hooks', 'pre-commit'), 0o644)
    const commit = await gitCommit(repo, 'msg', ['a.txt'])
    expect(commit.subject).toBe('msg')
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses for a config based hook and names it', async () => {
    const { repo, marker } = stagedRepo()
    sh(['config', 'hook.lint.command', `echo ran > "${marker}"`], repo)
    sh(['config', 'hook.lint.event', 'commit-msg'], repo)
    await expect(gitCommit(repo, 'msg', ['a.txt'])).rejects.toThrow(/\(commit-msg \(lint\)\)/)
    expect(existsSync(marker)).toBe(false)
    expect((await gitOverview(repo))!.hooks).toEqual(['commit-msg (lint)'])
  })

  it('refuses for a relative core.hooksPath when the panel is opened at a subfolder', async () => {
    const repo = makeRepo()
    mkdirSync(join(repo, 'app'))
    writeFileSync(join(repo, 'app', 'a.txt'), 'a')
    sh(['add', 'app/a.txt'], repo)
    sh(['config', 'core.hooksPath', '.githooks'], repo)
    mkdirSync(join(repo, '.githooks'))
    const hook = join(repo, '.githooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    chmodSync(hook, 0o755)
    await expect(gitCommit(join(repo, 'app'), 'msg', ['a.txt'])).rejects.toThrow(REFUSAL)
    expect(sh(['log', '--format=%s'], repo).trim()).toBe('first commit')
  })

  it('refuses for a post-commit hook alone', async () => {
    const { repo } = stagedRepo()
    installHook(repo, 'post-commit', 'exit 0')
    await expect(gitCommit(repo, 'msg', ['a.txt'])).rejects.toThrow(/git hooks \(post-commit\)/)
  })

  it('refuses even when the only configured hook is disabled, and names it', async () => {
    const { repo, marker } = stagedRepo()
    sh(['config', 'hook.lint.command', `echo ran > "${marker}"`], repo)
    sh(['config', 'hook.lint.event', 'pre-commit'], repo)
    sh(['config', 'hook.lint.enabled', 'false'], repo)
    await expect(gitCommit(repo, 'msg', ['a.txt'])).rejects.toThrow(/git hooks \(pre-commit \(disabled lint\)\)/)
    expect(existsSync(marker)).toBe(false)
    expect((await gitOverview(repo))!.hooks).toEqual(['pre-commit (disabled lint)'])
  })

  it('refuses a hook whose name contains a tab and starts with "disabled"', async () => {
    const { repo, marker } = stagedRepo()
    // Git lists this as "disabled<TAB>writer", the same text as a disabled hook called "writer".
    const config = join(repo, '.git', 'config')
    writeFileSync(
      config,
      readFileSync(config, 'utf8') + `[hook "disabled\twriter"]\n\tcommand = echo ran > "${marker}"\n\tevent = pre-commit\n`
    )
    expect(sh(['hook', 'list', '-z', 'pre-commit'], repo)).toContain('disabled\twriter')
    await expect(gitCommit(repo, 'msg', ['a.txt'])).rejects.toThrow(/does not run hooks yet/)
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses stage and unstage when a post-index-change hook exists, and leaves the index alone', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), 'a')
    writeFileSync(join(repo, 'b.txt'), 'b')
    sh(['add', 'a.txt'], repo)
    const marker = join(temp('regatta-marker-'), 'ran')
    installHook(repo, 'post-index-change', `echo ran >> "${marker}"`)
    const index = sh(['ls-files', '-s'], repo)
    await expect(gitStage(repo, ['b.txt'])).rejects.toThrow('This repository has a post-index-change git hook. The Git panel does not run hooks yet, so stage from a terminal.')
    await expect(gitUnstage(repo, ['a.txt'])).rejects.toThrow('post-index-change')
    expect(sh(['ls-files', '-s'], repo)).toBe(index)
    expect(existsSync(marker)).toBe(false)
    expect((await gitOverview(repo))!.hooks).toEqual(['post-index-change'])
  })

  it('reads (overview, diff) never run a post-index-change hook', async () => {
    const repo = makeRepo()
    const marker = join(temp('regatta-marker-'), 'ran')
    installHook(repo, 'post-index-change', `echo ran >> "${marker}"`)
    // Precondition: a plain `git status` after a file was touched does run the hook in this git.
    writeFileSync(join(repo, 'README.md'), '# regatta\n')
    await sleep(1100)
    writeFileSync(join(repo, 'README.md'), '# regatta\n')
    sh(['status'], repo)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    await sleep(1100)
    writeFileSync(join(repo, 'README.md'), '# regatta\n')
    writeFileSync(join(repo, 'new.txt'), 'new')
    await gitOverview(repo)
    await gitDiff(repo, 'new.txt', false)
    await gitLog(repo, 5)
    expect(existsSync(marker)).toBe(false)
  })

  it('fails closed when git cannot be asked about hooks', async () => {
    const missing = join(temp('regatta-plain-'), 'does-not-exist')
    await expect(hooksFor(missing, ['pre-commit'])).rejects.toThrow("Could not check this repository's git hooks.")
  })

  it('names hook files for a git without `git hook list` (fallback)', async () => {
    const repo = makeRepo()
    mkdirSync(join(repo, 'app'))
    installHook(repo, 'pre-commit', 'exit 0')
    installHook(repo, 'commit-msg', 'exit 0')
    chmodSync(join(repo, '.git', 'hooks', 'commit-msg'), 0o644)
    installHook(repo, 'post-commit', 'exit 0')
    const events = ['pre-commit', 'commit-msg', 'post-commit', 'pre-auto-gc']
    expect(await hooksFromPaths(repo, events)).toEqual(['pre-commit', 'post-commit'])
    // From a subfolder, git prints the path relative to it; the answer is the same.
    expect(await hooksFromPaths(join(repo, 'app'), events)).toEqual(['pre-commit', 'post-commit'])
    // With a relative core.hooksPath.
    sh(['config', 'core.hooksPath', '.githooks'], repo)
    mkdirSync(join(repo, '.githooks'))
    writeFileSync(join(repo, '.githooks', 'commit-msg'), '#!/bin/sh\n')
    chmodSync(join(repo, '.githooks', 'commit-msg'), 0o755)
    expect(await hooksFromPaths(join(repo, 'app'), events)).toEqual(['commit-msg'])
    // And the primary path agrees.
    expect(await hooksFor(join(repo, 'app'), events)).toEqual(['commit-msg'])
  })
})

describe('the commit itself', () => {
  /** A fake gpg that takes a while and then fails, so a commit can be made slow without hooks. */
  function slowSigner(seconds: number): { repo: string } {
    const { repo } = stagedRepo()
    const script = join(temp('regatta-gpg-'), 'gpg')
    writeFileSync(script, `#!/bin/sh\nsleep ${seconds}\nexit 1\n`)
    chmodSync(script, 0o755)
    sh(['config', 'gpg.program', script], repo)
    sh(['config', 'commit.gpgsign', 'true'], repo)
    return { repo }
  }

  it('stops waiting after the timeout and says so', async () => {
    const { repo } = slowSigner(3)
    const before = head(repo)
    await expect(gitCommit(repo, 'slow', ['a.txt'], { timeoutMs: 400 })).rejects.toThrow(
      'The commit took longer than 1 seconds and was stopped. Check the history before trying again.'
    )
    expect(head(repo)).toBe(before)
  }, 20000)

  it('refuses a second commit while one is running', async () => {
    const { repo } = slowSigner(1)
    const first = gitCommit(repo, 'first', ['a.txt']).catch((err: Error) => err)
    await sleep(300)
    await expect(gitCommit(repo, 'second', ['a.txt'])).rejects.toThrow('already running')
    expect((await first) instanceof Error).toBe(true)
  }, 20000)

  it('refuses when more is staged than the panel showed', async () => {
    const { repo } = stagedRepo()
    writeFileSync(join(repo, 'other.txt'), 'other')
    sh(['add', 'other.txt'], repo)
    const before = head(repo)
    await expect(gitCommit(repo, 'msg', ['a.txt'])).rejects.toThrow('The staged files changed. Check them and try again.')
    expect(head(repo)).toBe(before)
  })

  it('leaves no temporary message folder behind', async () => {
    const { repo } = stagedRepo()
    // A private temp folder, so other test runs creating their own regatta-commit-* folders at the same
    // time cannot change the count (os.tmpdir() reads TMPDIR on every call).
    const own = mkdtempSync(join(tmpdir(), 'regatta-gitview-tmp-'))
    const saved = process.env['TMPDIR']
    process.env['TMPDIR'] = own
    try {
      await gitCommit(repo, 'msg', ['a.txt'])
      expect(readdirSync(own).filter((n) => n.startsWith('regatta-commit-'))).toEqual([])
    } finally {
      if (saved === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = saved
      rmSync(own, { recursive: true, force: true })
    }
  })
})

describe('literal file names (finding 3)', () => {
  it('stages a file called *.txt without staging private.txt', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, '*.txt'), 'star')
    writeFileSync(join(repo, 'private.txt'), 'private')
    await gitStage(repo, ['*.txt'])
    expect(stagedNames(repo)).toEqual(['*.txt'])
    await gitUnstage(repo, ['*.txt'])
    expect(stagedNames(repo)).toEqual([])
  })
})

describe('a repository subfolder as the project (finding 4)', () => {
  function subRepo(): { repo: string; app: string } {
    const repo = makeRepo()
    mkdirSync(join(repo, 'app'))
    mkdirSync(join(repo, 'other'))
    writeFileSync(join(repo, 'app', 'a.txt'), 'a\n')
    writeFileSync(join(repo, 'other', 'o.txt'), 'o\n')
    sh(['add', '.'], repo)
    sh(['commit', '-m', 'subfolders'], repo)
    return { repo, app: join(repo, 'app') }
  }

  it('reports paths relative to the folder and leaves out files elsewhere', async () => {
    const { repo, app } = subRepo()
    writeFileSync(join(app, 'a.txt'), 'a\nchanged\n')
    writeFileSync(join(repo, 'other', 'o.txt'), 'o\nchanged\n')
    writeFileSync(join(repo, 'top.txt'), 'top')
    const overview = await gitOverview(app)
    expect(overview!.files.map((f) => f.path)).toEqual(['a.txt'])
  })

  it('stages, diffs, unstages and commits the right file', async () => {
    const { repo, app } = subRepo()
    writeFileSync(join(app, 'a.txt'), 'a\nchanged\n')
    expect((await gitDiff(app, 'a.txt', false)).text).toContain('+changed')
    await gitStage(app, ['a.txt'])
    expect(stagedNames(repo)).toEqual(['app/a.txt'])
    await gitUnstage(app, ['a.txt'])
    expect(stagedNames(repo)).toEqual([])
    await gitStage(app, ['a.txt'])
    const commit = await gitCommit(app, 'from a subfolder', ['a.txt'])
    expect(commit.subject).toBe('from a subfolder')
    expect(sh(['show', '--name-only', '--format=', 'HEAD'], repo).trim()).toBe('app/a.txt')
  })

  it('refuses to commit when something outside the folder is staged', async () => {
    const { repo, app } = subRepo()
    writeFileSync(join(app, 'a.txt'), 'a\nchanged\n')
    writeFileSync(join(repo, 'other', 'o.txt'), 'o\nchanged\n')
    sh(['add', '.'], repo)
    const before = head(repo)
    await expect(gitCommit(app, 'msg', ['a.txt'])).rejects.toThrow(/outside this folder/)
    expect(head(repo)).toBe(before)
  })

  it('refuses to unstage a rename that came from outside the folder, and changes nothing', async () => {
    const { repo, app } = subRepo()
    sh(['mv', 'other/o.txt', 'app/moved.txt'], repo)
    const index = sh(['ls-files', '-s'], repo)
    await expect(gitUnstage(app, ['moved.txt'])).rejects.toThrow(
      'This rename comes from outside the open folder. Unstage it from the repository root or a terminal.'
    )
    expect(sh(['ls-files', '-s'], repo)).toBe(index)
    expect(sh(['status', '--porcelain'], repo)).toContain('R  other/o.txt -> app/moved.txt')
  })
})

describe('diffs only show what status lists, and never follow links (findings 6, 7, 12)', () => {
  it('shows an untracked symlink as its target path, not the target contents', async () => {
    const repo = makeRepo()
    const outside = temp('regatta-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET CONTENTS\n')
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'link'))
    const diff = await gitDiff(repo, 'link', false)
    expect(diff.untracked).toBe(true)
    expect(diff.text).toContain(`+${join(outside, 'secret.txt')}`)
    expect(diff.text).not.toContain('TOP SECRET')
  })

  it('refuses a path that is not in status, such as one under .git', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, '.git', 'review-private'), 'private')
    await expect(gitDiff(repo, '.git/review-private', false)).rejects.toThrow('Path not in current status')
  })

  it('refuses a named pipe instead of hanging on it', async () => {
    const repo = makeRepo()
    execFileSync('mkfifo', [join(repo, 'pipe')])
    // Git does not list named pipes as untracked, so status refuses it first; if a git ever did list
    // one, the regular-file check refuses it. Either way the read must never block.
    await expect(gitDiff(repo, 'pipe', false)).rejects.toThrow(/Path not in current status|Only regular files can be shown/)
  })

  it('marks an untracked file with a NUL byte near the start as binary', async () => {
    const repo = makeRepo()
    const bytes = Buffer.alloc(300, 0x61)
    bytes[100] = 0
    writeFileSync(join(repo, 'blob.bin'), bytes)
    const diff = await gitDiff(repo, 'blob.bin', false)
    expect(diff.binary).toBe(true)
    expect(diff.text).toBe('')
  })

  it('says too large for a big untracked file', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(3_000_000))
    const diff = await gitDiff(repo, 'big.txt', false)
    expect(diff.tooLarge).toBe(true)
    expect(diff.binary).toBe(false)
    expect(diff.text).toBe('')
  })

  it('returns tooLarge instead of throwing for a 9 MB tracked diff', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'huge.txt'), 'base\n')
    sh(['add', 'huge.txt'], repo)
    sh(['commit', '-m', 'huge'], repo)
    writeFileSync(join(repo, 'huge.txt'), 'line of text\n'.repeat(700_000))
    const diff = await gitDiff(repo, 'huge.txt', false)
    expect(diff.tooLarge).toBe(true)
    expect(diff.text).toBe('')
  })

  it('shows the diff of a staged deletion, not a binary untracked file', async () => {
    const repo = makeRepo()
    sh(['rm', '-q', 'README.md'], repo)
    const diff = await gitDiff(repo, 'README.md', true)
    expect(diff.untracked).toBe(false)
    expect(diff.binary).toBe(false)
    expect(diff.text).toContain('-# regatta')
  })

  it('shows a staged rename as one diff', async () => {
    const repo = makeRepo()
    sh(['mv', 'README.md', 'MOVED.md'], repo)
    const diff = await gitDiff(repo, 'MOVED.md', true)
    expect(diff.text).toContain('rename from README.md')
  })
})

describe('busy detection (finding 8)', () => {
  it('stays busy through a multi commit cherry-pick after the first conflict was committed', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'f.txt'), 'base\n')
    sh(['add', 'f.txt'], repo)
    sh(['commit', '-m', 'base file'], repo)
    sh(['checkout', '-q', '-b', 'topic'], repo)
    writeFileSync(join(repo, 'f.txt'), 'topic one\n')
    sh(['commit', '-qam', 'topic one'], repo)
    writeFileSync(join(repo, 'g.txt'), 'second\n')
    sh(['add', 'g.txt'], repo)
    sh(['commit', '-qm', 'topic two'], repo)
    sh(['checkout', '-q', 'main'], repo)
    writeFileSync(join(repo, 'f.txt'), 'main change\n')
    sh(['commit', '-qam', 'main change'], repo)
    expect(() => sh(['cherry-pick', 'topic~1', 'topic'], repo)).toThrow()
    expect((await gitOverview(repo))!.busy).toBe('cherry-pick')
    // The user resolves the conflict and commits; the second pick is still waiting in the sequencer.
    writeFileSync(join(repo, 'f.txt'), 'resolved\n')
    sh(['add', 'f.txt'], repo)
    sh(['commit', '-q', '--no-edit'], repo)
    expect(existsSync(join(repo, '.git', 'CHERRY_PICK_HEAD'))).toBe(false)
    expect(existsSync(join(repo, '.git', 'sequencer', 'todo'))).toBe(true)
    expect((await gitOverview(repo))!.busy).toBe('cherry-pick')
    writeFileSync(join(repo, 'x.txt'), 'x')
    sh(['add', 'x.txt'], repo)
    await expect(gitCommit(repo, 'msg', ['x.txt'])).rejects.toThrow('A cherry-pick is in progress')
  })

  it('treats REVERT_HEAD as a revert', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, '.git', 'REVERT_HEAD'), `${head(repo)}\n`)
    expect((await gitOverview(repo))!.busy).toBe('revert')
  })

  it('fails closed when the state cannot be read', async () => {
    const repo = makeRepo()
    // A link that points at itself: stat fails with ELOOP, which is not "absent".
    symlinkSync('MERGE_HEAD', join(repo, '.git', 'MERGE_HEAD'))
    expect((await gitOverview(repo))!.busy).toBe('unknown')
    writeFileSync(join(repo, 'x.txt'), 'x')
    sh(['add', 'x.txt'], repo)
    await expect(gitCommit(repo, 'msg', ['x.txt'])).rejects.toThrow('could not read the repository state')
  })
})

describe('unstaging a rename (finding 9)', () => {
  it('unstages the old path as well as the new one', async () => {
    const repo = makeRepo()
    sh(['mv', 'README.md', 'renamed.md'], repo)
    await gitUnstage(repo, ['renamed.md'])
    expect(stagedNames(repo)).toEqual([])
    // The old path is back in the index (so it shows as deleted on disk, not as a staged deletion).
    expect(sh(['status', '--porcelain'], repo).split('\n').filter(Boolean).sort()).toEqual([' D README.md', '?? renamed.md'])
  })
})

describe('untracked files and the first commit (findings 11, 13)', () => {
  it('lists an untracked file, which can be staged', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'fresh.txt'), 'fresh')
    const overview = await gitOverview(repo)
    expect(overview!.files.find((f) => f.path === 'fresh.txt')).toMatchObject({ staged: '?', unstaged: '?' })
    await gitStage(repo, ['fresh.txt'])
    expect(stagedNames(repo)).toEqual(['fresh.txt'])
  })

  it('allows the first commit in a fresh repository, and history is empty before it', async () => {
    const repo = temp('regatta-fresh-')
    sh(['init', '-b', 'main'], repo)
    configure(repo)
    expect(await gitLog(repo, 30)).toEqual([])
    expect((await gitOverview(repo))!.hasCommits).toBe(false)
    writeFileSync(join(repo, 'a.txt'), 'a')
    await gitStage(repo, ['a.txt'])
    const commit = await gitCommit(repo, 'first ever', ['a.txt'])
    expect(commit.subject).toBe('first ever')
    expect((await gitLog(repo, 30)).map((c) => c.subject)).toEqual(['first ever'])
  })
})

describe('worktrees when folders are missing (finding 14)', () => {
  it('lists worktrees when Regatta has no worktrees folder yet', async () => {
    const repo = makeRepo()
    const elsewhere = join(temp('regatta-elsewhere-'), 'linked')
    sh(['worktree', 'add', '-q', '-b', 'side', elsewhere], repo)
    const saved = process.env['REGATTA_WORKTREES_DIR']
    process.env['REGATTA_WORKTREES_DIR'] = join(temp('regatta-missing-'), 'not', 'made', 'yet')
    try {
      const list = await gitWorktrees(repo)
      expect(list).toHaveLength(2)
      expect(list.map((w) => w.regatta)).toEqual([false, false])
    } finally {
      process.env['REGATTA_WORKTREES_DIR'] = saved
    }
  })

  it('lists a worktree whose folder was deleted', async () => {
    const repo = makeRepo()
    const gone = join(temp('regatta-gone-'), 'linked')
    sh(['worktree', 'add', '-q', '-b', 'gone', gone], repo)
    rmSync(gone, { recursive: true, force: true })
    const list = await gitWorktrees(repo)
    expect(list).toHaveLength(2)
    expect(list[1]!.branch).toBe('gone')
    expect(list[1]!.regatta).toBe(false)
  })
})

describe('copies are not renames', () => {
  function copyRepo(): string {
    const repo = makeRepo()
    sh(['config', 'status.renames', 'copies'], repo)
    sh(['config', 'diff.renames', 'copies'], repo)
    writeFileSync(join(repo, 'src.txt'), Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n')
    sh(['add', 'src.txt'], repo)
    sh(['commit', '-m', 'add src'], repo)
    // src.txt changes and a copy of its old text appears, both staged.
    const original = readFileSync(join(repo, 'src.txt'), 'utf8')
    writeFileSync(join(repo, 'copy.txt'), original)
    writeFileSync(join(repo, 'src.txt'), original + 'an independent change\n')
    sh(['add', 'src.txt', 'copy.txt'], repo)
    return repo
  }

  it('is seen as a copy by git here', async () => {
    const repo = copyRepo()
    const copy = (await gitOverview(repo))!.files.find((f) => f.path === 'copy.txt')!
    expect(copy.staged).toBe('C')
    expect(copy.from).toBe('src.txt')
  })

  it('unstaging the copy leaves its modified source staged', async () => {
    const repo = copyRepo()
    await gitUnstage(repo, ['copy.txt'])
    expect(sh(['status', '--porcelain'], repo).split('\n').filter(Boolean).sort()).toEqual(['?? copy.txt', 'M  src.txt'])
  })

  it('the staged diff of the copy does not include the source change', async () => {
    const repo = copyRepo()
    const diff = await gitDiff(repo, 'copy.txt', true)
    expect(diff.text).not.toContain('an independent change')
  })
})

describe('the diff size limit is exact', () => {
  it('a diff of exactly 1,000,000 bytes is shown and one byte more is too large', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'big.txt'), 'a\n')
    sh(['add', 'big.txt'], repo)
    sh(['commit', '-m', 'big'], repo)
    const sizeFor = (k: number): number => {
      writeFileSync(join(repo, 'big.txt'), 'x'.repeat(k) + '\n')
      return Buffer.byteLength(sh(['diff', '--no-color', '--no-ext-diff', '--', 'big.txt'], repo))
    }
    const fixed = sizeFor(10) - 10
    const exact = 1_000_000 - fixed
    expect(sizeFor(exact)).toBe(1_000_000)
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(exact) + '\n')
    const atLimit = await gitDiff(repo, 'big.txt', false)
    expect(atLimit.tooLarge).toBe(false)
    expect(atLimit.text.length).toBe(1_000_000)
    expect(sizeFor(exact + 1)).toBe(1_000_001)
    const over = await gitDiff(repo, 'big.txt', false)
    expect(over.tooLarge).toBe(true)
    expect(over.text).toBe('')
  })
})


describe('fsmonitor programs are hooks too (finding 12)', () => {
  function fsmonitorScript(): { script: string; marker: string } {
    const dir = temp('regatta-fsm-')
    const marker = join(dir, 'ran')
    const script = join(dir, 'fsmonitor.sh')
    // Version 2 hooks print a token and a list; exiting 1 makes git carry on without fsmonitor.
    writeFileSync(script, `#!/bin/sh\necho "$PWD" >> "${marker}"\nexit 1\n`)
    chmodSync(script, 0o755)
    return { script, marker }
  }

  it('is run by a plain git status here (precondition), but never by the panel', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'README.md'), 'changed\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    writeFileSync(join(repo, 'u.txt'), 'u\n')
    sh(['add', 'u.txt'], repo)
    const { script, marker } = fsmonitorScript()
    sh(['config', 'core.fsmonitor', script], repo)
    sh(['status'], repo)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)

    await gitOverview(repo)
    await gitDiff(repo, 'README.md', false)
    await gitDiff(repo, 'new.txt', false)
    await gitDiff(repo, 'u.txt', true)
    await gitStage(repo, ['new.txt'])
    await gitUnstage(repo, ['new.txt'])
    await gitLog(repo, 5)
    await gitStage(repo, ['u.txt', 'README.md'])
    await gitCommit(repo, 'with fsmonitor configured', ['README.md', 'u.txt'])
    expect(existsSync(marker)).toBe(false)
  })

  it('is not run in a submodule whose own config sets it', async () => {
    const source = temp('regatta-subsrc-')
    sh(['init', '-b', 'main'], source)
    configure(source)
    writeFileSync(join(source, 's.txt'), 's\n')
    sh(['add', '.'], source)
    sh(['commit', '-m', 'sub'], source)
    const repo = makeRepo()
    sh(['clone', '-q', source, 'sub'], repo)
    sh(['add', 'sub'], repo)
    sh(['commit', '-m', 'add sub'], repo)
    const { script, marker } = fsmonitorScript()
    sh(['config', 'core.fsmonitor', script], join(repo, 'sub'))
    writeFileSync(join(repo, 'sub', 's.txt'), 'dirty\n')
    sh(['status'], repo)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)

    const overview = await gitOverview(repo)
    expect(overview!.files.map((f) => f.path)).toContain('sub')
    await gitDiff(repo, 'sub', false)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('hooks are checked last (finding 14)', () => {
  /** A repository whose status takes about two seconds: a clean filter on a modified tracked file. */
  function slowStatusRepo(): { repo: string; counter: string; marker: string } {
    const repo = makeRepo()
    writeFileSync(join(repo, '.gitattributes'), 'slow.txt filter=slow\n')
    writeFileSync(join(repo, 'slow.txt'), 'one\n')
    sh(['add', '.'], repo)
    sh(['commit', '-m', 'slow'], repo)
    const dir = temp('regatta-slow-')
    const counter = join(dir, 'count')
    sh(['config', 'filter.slow.clean', `echo x >> "${counter}"; sleep 2; cat`], repo)
    // Same size as before, so git has to run the clean filter to find out whether it changed.
    writeFileSync(join(repo, 'slow.txt'), 'two\n')
    return { repo, counter, marker: join(dir, 'ran') }
  }

  const runs = (counter: string): number => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0)

  /** Installs the hook once the filter has started `more` times since the call (its own git commands count). */
  async function installWhen(counter: string, base: number, more: number, repo: string, name: string, marker: string): Promise<void> {
    while (runs(counter) < base + more) await sleep(40)
    installHook(repo, name, `echo ran >> "${marker}"`)
  }

  it('a pre-commit hook installed while the commit checks read status is seen', async () => {
    const { repo, counter, marker } = slowStatusRepo()
    writeFileSync(join(repo, 'a.txt'), 'a')
    sh(['add', 'a.txt'], repo)
    const before = head(repo)
    const base = runs(counter)
    const commit = gitCommit(repo, 'msg', ['a.txt']).catch((err: Error) => err)
    // The second read is the one right before the commit.
    await installWhen(counter, base, 2, repo, 'pre-commit', marker)
    const result = await commit
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/does not run hooks yet, so commit from a terminal/)
    expect(head(repo)).toBe(before)
    expect(existsSync(marker)).toBe(false)
  }, 40000)

  it('a post-index-change hook installed while stage reads status is seen', async () => {
    const { repo, counter, marker } = slowStatusRepo()
    writeFileSync(join(repo, 'b.txt'), 'b')
    const index = sh(['ls-files', '-s'], repo)
    const base = runs(counter)
    const staging = gitStage(repo, ['b.txt']).catch((err: Error) => err)
    await installWhen(counter, base, 1, repo, 'post-index-change', marker)
    const result = await staging
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/post-index-change git hook/)
    expect(sh(['ls-files', '-s'], repo)).toBe(index)
    expect(existsSync(marker)).toBe(false)
  }, 40000)

  it('a post-index-change hook installed while unstage reads status is seen', async () => {
    const { repo, counter, marker } = slowStatusRepo()
    writeFileSync(join(repo, 'b.txt'), 'b')
    sh(['add', 'b.txt'], repo)
    const index = sh(['ls-files', '-s'], repo)
    const base = runs(counter)
    const unstaging = gitUnstage(repo, ['b.txt']).catch((err: Error) => err)
    await installWhen(counter, base, 1, repo, 'post-index-change', marker)
    const result = await unstaging
    expect(result).toBeInstanceOf(Error)
    expect(sh(['ls-files', '-s'], repo)).toBe(index)
    expect(existsSync(marker)).toBe(false)
  }, 40000)
})

describe('an empty untracked file', () => {
  it('is shown as a new file with nothing in it, not as no changes', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'empty.txt'), '')
    const diff = await gitDiff(repo, 'empty.txt', false)
    expect(diff.untracked).toBe(true)
    expect(diff.binary).toBe(false)
    expect(diff.text).toBe('new file mode 100644\n')
  })
})

// ---------------------------------------------------------------------------------------------
// Programs git would run that the panel did not check for (round 5)

/**
 * A repository whose clean filter (on slow.txt, and on *.slow) behaves differently depending on which
 * git command runs it: `rules` maps a git verb ("commit", "add", "reset", "diff", "status") to shell
 * code that runs inside that command's own pass. This puts a hook file, or a leftover process,
 * exactly where git is in the middle of its own work.
 */
function filterRepo(rules: Record<string, string>): { repo: string; marker: string } {
  const repo = makeRepo()
  writeFileSync(join(repo, '.gitattributes'), 'slow.txt filter=slow\n*.slow filter=slow\n')
  writeFileSync(join(repo, 'slow.txt'), 'one\n')
  sh(['add', '.'], repo)
  sh(['commit', '-m', 'slow'], repo)
  const dir = temp('regatta-slow-')
  const marker = join(dir, 'ran')
  const cases = Object.entries(rules)
    .map(([verb, body]) => `  *" ${verb} "*) ${body} ;;`)
    .join('\n')
  const script = join(dir, 'filter.sh')
  writeFileSync(script, `#!/bin/sh\ncmd=$(ps -o command= -p $PPID)\ncase "$cmd" in\n${cases}\nesac\ncat\n`)
  chmodSync(script, 0o755)
  sh(['config', 'filter.slow.clean', script], repo)
  return { repo, marker }
}

describe('git never runs a hook file that appears while its own command runs', () => {
  /** Shell code that writes every hook the panel does not check at that moment. */
  const writeHooks = (repo: string, marker: string): string =>
    ['pre-commit', 'post-commit', 'post-index-change', 'reference-transaction', 'post-checkout']
      .map((name) => {
        const file = join(repo, '.git', 'hooks', name)
        return `mkdir -p "${join(repo, '.git', 'hooks')}"; printf '#!/bin/sh\\necho ${name} >> "${marker}"\\n' > "${file}"; chmod +x "${file}"`
      })
      .join('; ')

  it('commit', async () => {
    const dir = temp('regatta-m-')
    const marker = join(dir, 'ran')
    const { repo } = filterRepo({})
    // The filter is rewritten now that the repository path is known.
    const script = join(dir, 'filter.sh')
    writeFileSync(script, `#!/bin/sh\ncmd=$(ps -o command= -p $PPID)\ncase "$cmd" in\n  *" commit "*) ${writeHooks(repo, marker)} ;;\nesac\ncat\n`)
    chmodSync(script, 0o755)
    sh(['config', 'filter.slow.clean', script], repo)
    writeFileSync(join(repo, 'slow.txt'), 'two\n')
    writeFileSync(join(repo, 'a.txt'), 'a')
    sh(['add', 'a.txt'], repo)
    const commit = await gitCommit(repo, 'msg', ['a.txt'])
    expect(commit.subject).toBe('msg')
    // The filter ran inside git commit, so the hooks were written there: they did not run.
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(true)
    expect(existsSync(marker)).toBe(false)
    // Control: the same hooks do run for plain git.
    sh(['commit', '--allow-empty', '-m', 'control'], repo)
    expect(existsSync(marker)).toBe(true)
  }, 60000)

  it('stage', async () => {
    const dir = temp('regatta-m-')
    const marker = join(dir, 'ran')
    const { repo } = filterRepo({})
    const script = join(dir, 'filter.sh')
    writeFileSync(script, `#!/bin/sh\ncmd=$(ps -o command= -p $PPID)\ncase "$cmd" in\n  *" add "*) ${writeHooks(repo, marker)} ;;\nesac\ncat\n`)
    chmodSync(script, 0o755)
    sh(['config', 'filter.slow.clean', script], repo)
    writeFileSync(join(repo, 'b.slow'), 'b\n')
    await gitStage(repo, ['b.slow'])
    expect(sh(['diff', '--cached', '--name-only'], repo).trim()).toBe('b.slow')
    expect(existsSync(join(repo, '.git', 'hooks', 'post-index-change'))).toBe(true)
    expect(existsSync(marker)).toBe(false)
    writeFileSync(join(repo, 'c.txt'), 'c')
    sh(['add', 'c.txt'], repo)
    expect(existsSync(marker)).toBe(true)
  }, 60000)

  it('unstage', async () => {
    const dir = temp('regatta-m-')
    const marker = join(dir, 'ran')
    const { repo } = filterRepo({})
    const script = join(dir, 'filter.sh')
    writeFileSync(script, `#!/bin/sh\ncmd=$(ps -o command= -p $PPID)\ncase "$cmd" in\n  *" reset "*|*" restore "*) ${writeHooks(repo, marker)} ;;\nesac\ncat\n`)
    chmodSync(script, 0o755)
    sh(['config', 'filter.slow.clean', script], repo)
    writeFileSync(join(repo, 'slow.txt'), 'two\n')
    writeFileSync(join(repo, 'a.txt'), 'a')
    sh(['add', 'a.txt'], repo)
    await gitUnstage(repo, ['a.txt'])
    expect(stagedNames(repo)).toEqual([])
    expect(existsSync(join(repo, '.git', 'hooks', 'post-index-change'))).toBe(true)
    expect(existsSync(marker)).toBe(false)
    sh(['add', 'a.txt'], repo)
    expect(existsSync(marker)).toBe(true)
  }, 60000)

  it('refuses to run when the private folder has something in it', async () => {
    const repo = makeRepo()
    const folder = join(temp('regatta-sandbox-'), 'empty-hooks')
    setHooksSandbox(folder)
    try {
      await gitLog(repo, 1)
      writeFileSync(join(folder, 'pre-commit'), '#!/bin/sh\n')
      await expect(gitLog(repo, 1)).rejects.toThrow(/not empty/)
      await expect(gitOverview(repo)).rejects.toThrow(/not empty/)
      await expect(gitStage(repo, ['README.md'])).rejects.toThrow(/not empty/)
    } finally {
      setHooksSandbox(join(temp('regatta-sandbox-'), 'empty-hooks'))
    }
  })
})

describe('unstage does not run post-checkout', () => {
  it('uses reset, so a post-checkout hook (git-lfs installs one) stays quiet', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), 'a')
    await gitStage(repo, ['a.txt'])
    const marker = join(temp('regatta-marker-'), 'ran')
    installHook(repo, 'post-checkout', `echo ran >> "${marker}"`)
    // Control: restore --staged runs it.
    sh(['restore', '--staged', 'a.txt'], repo)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    sh(['add', 'a.txt'], repo)
    await gitUnstage(repo, ['a.txt'])
    expect(stagedNames(repo)).toEqual([])
    expect(existsSync(marker)).toBe(false)
  })
})

describe('an unnamed config hook still counts', () => {
  it('lists a lone NUL and exits 0, and the panel refuses', async () => {
    const { repo, marker } = stagedRepo()
    const config = join(repo, '.git', 'config')
    writeFileSync(config, readFileSync(config, 'utf8') + `[hook ""]\n\tcommand = echo ran > "${marker}"\n\tevent = pre-commit\n`)
    expect(sh(['hook', 'list', '-z', 'pre-commit'], repo)).toBe('\0')
    expect(await hooksFor(repo, ['pre-commit'])).toEqual(['pre-commit (unnamed)'])
    await expect(gitCommit(repo, 'msg', ['a.txt'])).rejects.toThrow(/\(pre-commit \(unnamed\)\)/)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('diffs do not write the index or run programs', () => {
  it('a stale file list does not make the diff write the index or run post-index-change', async () => {
    const { repo } = filterRepo({})
    const dir = temp('regatta-m-')
    const marker = join(dir, 'ran')
    // Status sees slow.txt as changed (its filter says so); git diff sees it unchanged, which is what a
    // list that went stale looks like: its stat data is out of date, so a diff would refresh the index.
    const script = join(dir, 'filter.sh')
    writeFileSync(script, `#!/bin/sh\ncmd=$(ps -o command= -p $PPID)\ncase "$cmd" in\n  *" status "*) cat > /dev/null; echo two; exit 0 ;;\nesac\ncat\n`)
    chmodSync(script, 0o755)
    sh(['config', 'filter.slow.clean', script], repo)
    installHook(repo, 'post-index-change', `echo ran >> "${marker}"`)
    await sleep(1100)
    writeFileSync(join(repo, 'slow.txt'), 'one\n') // same content, new mtime
    // Control: plain git diff refreshes the index and runs the hook.
    sh(['diff', '--', 'slow.txt'], repo)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    await sleep(1100)
    writeFileSync(join(repo, 'slow.txt'), 'one\n')
    const diff = await gitDiff(repo, 'slow.txt', false)
    expect(diff.text).toBe('')
    expect(existsSync(marker)).toBe(false)
  })

  it('does not write textconv cache notes or run reference-transaction', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, '.gitattributes'), '*.md diff=up\n')
    sh(['config', 'diff.up.textconv', 'tr a-z A-Z <'], repo)
    sh(['config', 'diff.up.cachetextconv', 'true'], repo)
    writeFileSync(join(repo, 'README.md'), '# regatta\nchanged\n')
    // Control: plain git converts the text and caches it in a notes ref.
    expect(sh(['diff', '--', 'README.md'], repo)).toContain('CHANGED')
    expect(sh(['for-each-ref', 'refs/notes/textconv'], repo).trim()).not.toBe('')
    sh(['update-ref', '-d', 'refs/notes/textconv/up'], repo)
    const marker = join(temp('regatta-marker-'), 'ran')
    installHook(repo, 'reference-transaction', `echo ran >> "${marker}"`)
    const diff = await gitDiff(repo, 'README.md', false)
    expect(diff.text).toContain('+changed')
    expect(diff.text).not.toContain('CHANGED')
    expect(sh(['for-each-ref', 'refs/notes/textconv'], repo).trim()).toBe('')
    expect(existsSync(marker)).toBe(false)
  })

  it('a submodule diff runs neither the submodule hook nor diff.external', async () => {
    const source = temp('regatta-subsrc-')
    sh(['init', '-b', 'main'], source)
    configure(source)
    writeFileSync(join(source, 's.txt'), 's\n')
    sh(['add', '.'], source)
    sh(['commit', '-m', 'sub'], source)
    const repo = makeRepo()
    sh(['clone', '-q', source, 'sub'], repo)
    sh(['add', 'sub'], repo)
    sh(['commit', '-m', 'add sub'], repo)
    const marker = join(temp('regatta-marker-'), 'ran')
    installHook(join(repo, 'sub'), 'post-index-change', `echo sub-hook >> "${marker}"`)
    const external = join(temp('regatta-ext-'), 'ext.sh')
    writeFileSync(external, `#!/bin/sh\necho external >> "${marker}"\n`)
    chmodSync(external, 0o755)
    sh(['config', 'diff.external', external], repo)
    // A commit made inside the submodule moves the recorded commit; a changed file keeps it busy too.
    writeFileSync(join(repo, 'sub', 's2.txt'), 'new\n')
    sh(['add', 's2.txt'], join(repo, 'sub'))
    sh(['commit', '-m', 'inside'], join(repo, 'sub'))
    writeFileSync(join(repo, 'sub', 's.txt'), 'dirty\n')
    await sleep(1100)
    writeFileSync(join(repo, 'sub', 's.txt'), 'dirty\n')
    // Control: plain git diff in the parent looks inside the submodule and runs its hook.
    sh(['diff', '--', 'sub'], repo)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    await sleep(1100)
    writeFileSync(join(repo, 'sub', 's.txt'), 'dirty\n')
    const diff = await gitDiff(repo, 'sub', false)
    expect(diff.text).toContain('Subproject commit')
    expect(existsSync(marker)).toBe(false)
  })
})

describe('log does not run the signature program', () => {
  it('log.showSignature stays quiet and the list still parses', async () => {
    const repo = makeRepo()
    const marker = join(temp('regatta-marker-'), 'ran')
    const gpg = join(temp('regatta-gpg-'), 'gpg')
    writeFileSync(gpg, `#!/bin/sh\necho gpg >> "${marker}"\nexit 1\n`)
    chmodSync(gpg, 0o755)
    // A commit object that carries a (fake) signature header.
    const tree = sh(['rev-parse', 'HEAD^{tree}'], repo).trim()
    const parent = head(repo)
    const object =
      `tree ${tree}\nparent ${parent}\nauthor A <a@a> 1700000000 +0000\ncommitter A <a@a> 1700000000 +0000\n` +
      'gpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned one\n'
    const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, input: object, encoding: 'utf8' }).trim()
    sh(['update-ref', 'refs/heads/main', sha], repo)
    sh(['config', 'gpg.program', gpg], repo)
    sh(['config', 'log.showSignature', 'true'], repo)
    // Control: plain git log verifies the signature with the program.
    sh(['log', '-1'], repo)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    const log = await gitLog(repo, 10)
    expect(log.map((c) => c.subject)).toEqual(['signed one', 'first commit'])
    expect(existsSync(marker)).toBe(false)
    writeFileSync(join(repo, 'x.txt'), 'x')
    await gitStage(repo, ['x.txt'])
    await gitCommit(repo, 'after', ['x.txt'])
    expect(existsSync(marker)).toBe(false)
  })
})

describe('a timeout bounds the call even when git leaves a process behind', () => {
  it('a commit with a 1.5 second timeout reports it well before the leftover process ends', async () => {
    const dir = temp('regatta-m-')
    const { repo } = filterRepo({})
    const script = join(dir, 'filter.sh')
    // Inside git commit only: a sleeper keeps git's error pipe open, and the filter itself is slow.
    writeFileSync(script, `#!/bin/sh\ncmd=$(ps -o command= -p $PPID)\ncase "$cmd" in\n  *" commit "*) (sleep 9 >/dev/null &); sleep 6 ;;\nesac\ncat\n`)
    chmodSync(script, 0o755)
    sh(['config', 'filter.slow.clean', script], repo)
    writeFileSync(join(repo, 'slow.txt'), 'two\n')
    writeFileSync(join(repo, 'b.txt'), 'b')
    sh(['add', 'b.txt'], repo)
    const started = Date.now()
    await expect(gitCommit(repo, 'msg', ['b.txt'], { timeoutMs: 1500 })).rejects.toThrow(/took longer than/)
    // Waiting for the leftover sleeper would take about 9 seconds.
    expect(Date.now() - started).toBeLessThan(5000)
  }, 40000)
})

// ---------------------------------------------------------------------------------------------
// Round 6: automatic maintenance, lazy fetches, process groups, small robustness

/** Many loose objects, so that `gc --auto` finds something to do once gc.auto is low. */
function manyLooseObjects(repo: string): void {
  const dir = temp('regatta-loose-')
  const paths: string[] = []
  for (let i = 0; i < 3000; i++) {
    const file = join(dir, `f${i}`)
    writeFileSync(file, `loose object ${i} ${Math.random()}\n`)
    paths.push(file)
  }
  execFileSync('git', ['hash-object', '-w', '--stdin-paths'], { cwd: repo, input: paths.join('\n') + '\n', encoding: 'utf8' })
}

describe('a commit does not start maintenance that could run a hook added meanwhile', () => {
  const configureGc = (repo: string, marker: string): string[][] => [
    ['config', 'maintenance.strategy', 'gc'],
    ['config', 'gc.auto', '1'],
    ['config', 'hook.late.command', `echo pre-auto-gc >> "${marker}"`],
    ['config', 'hook.late.event', 'pre-auto-gc']
  ].map((args) => ['-C', repo, ...args])

  it('control: plain git commit runs the pre-auto-gc config hook after the commit', async () => {
    const { repo } = stagedRepo()
    const marker = join(temp('regatta-marker-'), 'ran')
    manyLooseObjects(repo)
    for (const args of configureGc(repo, marker)) sh(args, repo)
    sh(['commit', '-q', '-m', 'plain'], repo)
    for (let i = 0; i < 100 && !existsSync(marker); i++) await sleep(100)
    expect(existsSync(marker)).toBe(true)
  }, 30000)

  it('the panel commit leaves maintenance alone, even when the hook appears during the commit', async () => {
    const { repo } = filterRepo({})
    const marker = join(temp('regatta-marker-'), 'ran')
    manyLooseObjects(repo)
    const dir = temp('regatta-m-')
    const script = join(dir, 'filter.sh')
    const injected = configureGc(repo, marker)
      .map((args) => `git ${args.map((a) => `'${a}'`).join(' ')}`)
      .join('; ')
    writeFileSync(script, `#!/bin/sh\ncmd=$(ps -o command= -p $PPID)\ncase "$cmd" in\n  *" commit "*) ${injected} ;;\nesac\ncat\n`)
    chmodSync(script, 0o755)
    sh(['config', 'filter.slow.clean', script], repo)
    writeFileSync(join(repo, 'slow.txt'), 'two\n')
    writeFileSync(join(repo, 'a.txt'), 'a')
    sh(['add', 'a.txt'], repo)
    const commit = await gitCommit(repo, 'msg', ['a.txt'])
    expect(commit.subject).toBe('msg')
    // The filter ran inside git commit and added the hook and the strategy there.
    expect(sh(['config', 'hook.late.event'], repo).trim()).toBe('pre-auto-gc')
    await sleep(4000)
    expect(existsSync(marker)).toBe(false)
  }, 60000)
})

describe('a partial clone is never fetched into', () => {
  /** A blobless clone whose upload-pack wrapper leaves a marker when the remote is contacted. */
  function bloblessClone(kind: 'rename' | 'modify'): { clone: string; marker: string } {
    const source = temp('regatta-pc-src-')
    sh(['init', '-b', 'main'], source)
    configure(source)
    sh(['config', 'uploadpack.allowFilter', 'true'], source)
    sh(['config', 'uploadpack.allowAnySHA1InWant', 'true'], source)
    if (kind === 'rename') {
      writeFileSync(join(source, 'a.txt'), Array.from({ length: 40 }, (_, i) => `${i}`).join('\n') + '\n')
      sh(['add', '.'], source)
      sh(['commit', '-m', 'c1'], source)
      sh(['mv', 'a.txt', 'b.txt'], source)
      writeFileSync(join(source, 'b.txt'), readFileSync(join(source, 'b.txt'), 'utf8') + 'extra\n')
    } else {
      writeFileSync(join(source, 'f.txt'), 'one\n')
      sh(['add', '.'], source)
      sh(['commit', '-m', 'c1'], source)
      writeFileSync(join(source, 'f.txt'), 'two\n')
    }
    sh(['add', '.'], source)
    sh(['commit', '-m', 'c2'], source)
    writeFileSync(kind === 'rename' ? join(source, 'c.txt') : join(source, 'f.txt'), 'three\n')
    sh(['add', '.'], source)
    sh(['commit', '-m', 'c3'], source)
    const clone = join(temp('regatta-pc-dst-'), 'clone')
    execFileSync('git', ['clone', '-q', '--filter=blob:none', `file://${source}`, clone], { encoding: 'utf8', timeout: 30000 })
    configure(clone)
    const marker = join(temp('regatta-marker-'), 'ran')
    const wrapper = join(temp('regatta-up-'), 'up.sh')
    writeFileSync(wrapper, `#!/bin/sh\necho contacted >> "${marker}"\nexec git upload-pack "$@"\n`)
    chmodSync(wrapper, 0o755)
    sh(['config', 'remote.origin.uploadpack', wrapper], clone)
    // HEAD goes back past the commit whose files were never downloaded; the index keeps the newer ones.
    sh(['reset', '-q', '--soft', kind === 'rename' ? 'HEAD~2' : 'HEAD~1'], clone)
    expect(existsSync(marker)).toBe(false)
    return { clone, marker }
  }

  it('the git environment denies every transport and also switches off lazy fetching', () => {
    const env = gitEnv()
    expect(env['GIT_NO_LAZY_FETCH']).toBe('1')
    // Set, and empty: git reads that as "no protocol is allowed".
    expect('GIT_ALLOW_PROTOCOL' in env).toBe(true)
    expect(env['GIT_ALLOW_PROTOCOL']).toBe('')
  })

  it('older git ignores GIT_NO_LAZY_FETCH, so the transport denial alone keeps the clone offline', () => {
    const { clone, marker } = bloblessClone('rename')
    const env = gitEnv()
    delete env['GIT_NO_LAZY_FETCH'] // what git 2.45 behaves like for its bulk fetch
    const result = spawnSync('git', ['status', '--short'], { cwd: clone, env, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/fatal|error/)
    expect(existsSync(marker)).toBe(false)
    // Control: with neither variable the wrapper runs.
    const plain = { ...process.env }
    delete plain['GIT_ALLOW_PROTOCOL']
    delete plain['GIT_NO_LAZY_FETCH']
    spawnSync('git', ['status', '--short'], { cwd: clone, env: plain, encoding: 'utf8' })
    expect(existsSync(marker)).toBe(true)
  })

  it('control: plain git status downloads the missing file from the remote', () => {
    const { clone, marker } = bloblessClone('rename')
    sh(['status', '--short'], clone)
    expect(existsSync(marker)).toBe(true)
  })

  it('the overview fails with a clear message instead of fetching', async () => {
    const { clone, marker } = bloblessClone('rename')
    await expect(gitOverview(clone)).rejects.toThrow(/partial clone are not downloaded yet.*does not contact a remote/)
    expect(existsSync(marker)).toBe(false)
  })

  it('status, diff and commit never contact the remote, and the commit is reported as made', async () => {
    const { clone, marker } = bloblessClone('modify')
    const overview = await gitOverview(clone)
    expect(overview!.files.map((f) => f.path)).toEqual(['f.txt'])
    // The staged diff needs the older file, which is not here: a message, not a download.
    await expect(gitDiff(clone, 'f.txt', true)).rejects.toThrow(/partial clone/)
    const before = head(clone)
    const commit = await gitCommit(clone, 'from a partial clone', ['f.txt'])
    expect(commit.subject).toBe('from a partial clone')
    expect(head(clone)).not.toBe(before)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('a timeout stops what git started', () => {
  it('a slow clean filter does not outlive "took longer than"', async () => {
    const { repo } = filterRepo({})
    const dir = temp('regatta-m-')
    const flag = join(dir, 'finished')
    const script = join(dir, 'filter.sh')
    writeFileSync(script, `#!/bin/sh\ncmd=$(ps -o command= -p $PPID)\ncase "$cmd" in\n  *" commit "*) sleep 3; echo done > "${flag}" ;;\nesac\ncat\n`)
    chmodSync(script, 0o755)
    sh(['config', 'filter.slow.clean', script], repo)
    writeFileSync(join(repo, 'slow.txt'), 'two\n')
    writeFileSync(join(repo, 'b.txt'), 'b')
    sh(['add', 'b.txt'], repo)
    await expect(gitCommit(repo, 'msg', ['b.txt'], { timeoutMs: 1000 })).rejects.toThrow(/took longer than/)
    await sleep(3500)
    expect(existsSync(flag)).toBe(false)
  }, 30000)
})

describe('a timeout is not over until everything git started is gone', () => {
  it('a clean filter that ignores SIGTERM is killed, and the call waits for that', async () => {
    const { repo } = filterRepo({})
    const dir = temp('regatta-m-')
    const flag = join(dir, 'finished')
    const script = join(dir, 'filter.sh')
    writeFileSync(script, `#!/bin/sh\ncmd=$(ps -o command= -p $PPID)\ncase "$cmd" in\n  *" commit "*) trap '' TERM; sleep 4; echo done > "${flag}" ;;\nesac\ncat\n`)
    chmodSync(script, 0o755)
    sh(['config', 'filter.slow.clean', script], repo)
    writeFileSync(join(repo, 'slow.txt'), 'two\n')
    writeFileSync(join(repo, 'b.txt'), 'b')
    sh(['add', 'b.txt'], repo)
    const started = Date.now()
    await expect(gitCommit(repo, 'msg', ['b.txt'], { timeoutMs: 600 })).rejects.toThrow(/took longer than 1 seconds and was stopped\./)
    const elapsed = Date.now() - started
    // Not back before the grace period passed and the kill happened (git exits at once on SIGTERM).
    expect(elapsed).toBeGreaterThan(1900)
    expect(elapsed).toBeLessThan(6000)
    await sleep(4500)
    expect(existsSync(flag)).toBe(false)
  }, 40000)
})

describe('small robustness', () => {
  it('ignores a .DS_Store in the empty hooks folder, but not anything else', async () => {
    const repo = makeRepo()
    const folder = join(temp('regatta-sandbox-'), 'empty-hooks')
    setHooksSandbox(folder)
    try {
      await gitLog(repo, 1)
      writeFileSync(join(folder, '.DS_Store'), 'finder')
      expect((await gitLog(repo, 1)).length).toBe(1)
      writeFileSync(join(folder, '.DS_Store2'), 'other')
      await expect(gitLog(repo, 1)).rejects.toThrow(/not empty/)
    } finally {
      setHooksSandbox(join(temp('regatta-sandbox-'), 'empty-hooks'))
    }
  })

  it('asks about hooks in English, and only there', async () => {
    const repo = makeRepo()
    const bin = temp('regatta-bin-')
    const log = join(bin, 'calls')
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const wrapper = join(bin, 'git')
    writeFileSync(wrapper, `#!/bin/sh\necho "LC_ALL=$LC_ALL $*" >> "${log}"\nexec "${real}" "$@"\n`)
    chmodSync(wrapper, 0o755)
    const savedPath = process.env['PATH']
    const savedLc = process.env['LC_ALL']
    process.env['PATH'] = `${bin}:${savedPath}`
    process.env['LC_ALL'] = 'fr_FR.UTF-8'
    try {
      await hooksFor(repo, ['pre-commit'])
      await gitLog(repo, 1)
    } finally {
      process.env['PATH'] = savedPath
      if (savedLc === undefined) delete process.env['LC_ALL']
      else process.env['LC_ALL'] = savedLc
    }
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    expect(calls.filter((c) => c.includes(' hook list'))).toEqual([expect.stringMatching(/^LC_ALL=C /)])
    expect(calls.filter((c) => c.includes(' log ')).every((c) => c.startsWith('LC_ALL=fr_FR.UTF-8 '))).toBe(true)
  })

  it('shows the fatal line rather than an earlier warning', () => {
    expect(errorLine('warning: something odd\nhint: try this\nfatal: bad revision\n')).toBe('fatal: bad revision')
    expect(errorLine('warning: something odd\nerror: could not do it\n')).toBe('error: could not do it')
    expect(errorLine('warning: only a warning\n')).toBe('warning: only a warning')
    expect(errorLine('')).toBeUndefined()
  })
})

describe('overflow with a process group that cannot be stopped (P2-a)', () => {
  it('surfaces stuck instead of hiding it behind tooLarge or truncation for diff and every other caller of run()', async () => {
    const diffRepo = makeRepo()
    writeFileSync(join(diffRepo, 'huge.txt'), 'base\n')
    sh(['add', 'huge.txt'], diffRepo)
    sh([...IDENTITY, 'commit', '-m', 'huge'], diffRepo)
    writeFileSync(join(diffRepo, 'huge.txt'), 'line of text\n'.repeat(100_000))

    const repo = makeRepo()
    const headRepo = makeRepo()
    const commitRepo = makeRepo()
    writeFileSync(join(commitRepo, 'a.txt'), 'staged\n')
    sh(['add', 'a.txt'], commitRepo)

    const bin = temp('regatta-overflow-bin-')
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const node = process.execPath
    const wrapper = join(bin, 'git')
    const flood = `exec "${node}" -e "process.stdout.write(Buffer.alloc(33 * 1024 * 1024, 65)); setInterval(() => {}, 1000)"`
    writeFileSync(
      wrapper,
      `#!/bin/sh
case " $* " in
  *" log "*|*" commit -q -F "*)
    ${flood}
    ;;
  *" hook list "*)
    case "$PWD" in *"${repo.split("/").pop()}")
      ${flood}
      ;;
    esac
    ;;
  *" --git-path "*)
    case "$PWD" in *"${repo.split("/").pop()}")
      ${flood}
      ;;
    esac
    ;;
  *" --verify -q HEAD "*)
    case "$PWD" in *"${headRepo.split("/").pop()}")
      ${flood}
      ;;
    esac
    ;;
esac
exec "${real}" "$@"
`
    )
    chmodSync(wrapper, 0o755)

    const savedPath = process.env['PATH']
    const realKill = process.kill.bind(process)
    const groups = new Set<number>()
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0) {
        groups.add(pid)
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      }
      return realKill(pid, signal as NodeJS.Signals)
    }) as typeof process.kill)
    process.env['PATH'] = `${bin}:${savedPath}`
    try {
      await Promise.all([
        expect(gitDiff(diffRepo, 'huge.txt', false)).rejects.toThrow(
          /git diff took too long and was stopped, but a process it started could not be stopped/
        ),
        expect(gitLog(repo, 5)).rejects.toThrow(
          /git log took too long and was stopped, but a process it started could not be stopped/
        ),
        expect(hooksFor(repo, ['pre-commit'])).rejects.toThrow(/could not be stopped/),
        expect(hooksFromPaths(repo, ['pre-commit'])).rejects.toThrow(/could not be stopped/),
        expect(gitOverview(headRepo)).rejects.toThrow(/could not be stopped/),
        expect(gitCommit(commitRepo, 'msg', ['a.txt'])).rejects.toThrow(
          /The commit took longer than 60 seconds and was stopped, but a process it started could not be stopped/
        )
      ])
    } finally {
      process.env['PATH'] = savedPath
      spy.mockRestore()
      for (const pgid of groups) {
        try {
          realKill(pgid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
  }, 40000)
})

describe('a git that was stopped is never a negative answer (V5 finding 2)', () => {
  it('tryGit rethrows a stuck group: detection, branch, upstream and ahead/behind reads reject instead of answering null', async () => {
    const detect = makeRepo()
    const branch = makeRepo()
    const upstream = makeRepo()
    const ahead = makeRepo()
    for (const dir of [upstream, ahead]) {
      // A real upstream, so those optional reads are asked at all: git only tracks a remote branch it
      // has a configured remote for.
      sh(['config', 'remote.origin.url', dir], dir)
      sh(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], dir)
      sh(['update-ref', 'refs/remotes/origin/main', sh(['rev-parse', 'HEAD'], dir).trim()], dir)
      sh(['branch', '--set-upstream-to', 'origin/main'], dir)
    }
    const bin = temp('regatta-stuck-try-')
    const real = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
    const node = process.execPath
    const flood = `exec "${node}" -e "process.stdout.write(Buffer.alloc(33 * 1024 * 1024, 65)); setInterval(() => {}, 1000)"`
    const here = (dir: string): string => dir.split('/').pop()!
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh
case " $* " in
  *" --is-inside-work-tree "*) case "$PWD" in *"${here(detect)}") ${flood} ;; esac ;;
  *" symbolic-ref "*) case "$PWD" in *"${here(branch)}") ${flood} ;; esac ;;
  *" --symbolic-full-name "*) case "$PWD" in *"${here(upstream)}") ${flood} ;; esac ;;
  *" --left-right "*) case "$PWD" in *"${here(ahead)}") ${flood} ;; esac ;;
esac
exec "${real}" "$@"
`,
      { mode: 0o755 }
    )

    // A kill that never reaches the group: the stopped git stays alive, and stuck is the only honest answer.
    const savedPath = process.env['PATH']
    const realKill = process.kill.bind(process)
    const groups = new Set<number>()
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0) {
        groups.add(pid)
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      }
      return realKill(pid, signal as NodeJS.Signals)
    }) as typeof process.kill)
    process.env['PATH'] = `${bin}:${savedPath}`
    try {
      await Promise.all([
        // Repository detection: not "not a repository" while a process group of git's lives on.
        expect(gitOverview(detect)).rejects.toThrow(/git rev-parse took too long and was stopped, but a process it started could not be stopped/),
        // The optional branch read: not "detached" or "no branch".
        expect(gitOverview(branch)).rejects.toThrow(/git symbolic-ref took too long and was stopped, but a process it started could not be stopped/),
        // The optional upstream read: not "no upstream".
        expect(gitOverview(upstream)).rejects.toThrow(/git rev-parse took too long and was stopped, but a process it started could not be stopped/),
        // And the ahead/behind count that only runs when there is an upstream.
        expect(gitOverview(ahead)).rejects.toThrow(/git rev-list took too long and was stopped, but a process it started could not be stopped/)
      ])
    } finally {
      process.env['PATH'] = savedPath
      spy.mockRestore()
      for (const pgid of groups) {
        try {
          realKill(pgid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }

    // Control: the same questions, answered by git that finished. A non-zero exit is still a plain "no",
    // not an error: outside a repository the overview is null, and inside these ones it reads clean.
    expect(await gitOverview(temp('regatta-plain-'))).toBeNull()
    expect((await gitOverview(detect))?.branch).toBe('main')
    expect((await gitOverview(upstream))?.upstream).toBe('origin/main')
    expect((await gitOverview(ahead))?.upstream).toBe('origin/main')
  }, 60000)
})
