// Git helpers for heats, against real repositories in temp folders.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  abortMerge,
  addDetachedWorktree,
  addWorktree,
  branchExists,
  branchName,
  branchTip,
  branchesWithPrefix,
  commitAll,
  commitCount,
  countTestsAt,
  currentBranch,
  diffBetween,
  diffFrom,
  dirtyTracked,
  git,
  hasChanges,
  headSha,
  ignoredCollisions,
  isAncestor,
  isCaseInsensitive,
  isRepoWithCommit,
  mergeHeadExists,
  operationInProgress,
  parseShortstat,
  tryGit
} from './git-ops'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']
const CART = "it('adds', () => { expect(1).toBe(1) })\nit('subtracts', () => { expect(2).toBe(2) })\n"

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
}

const dirs: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A repository with one commit, a test file and a guard file. */
function makeRepo(): string {
  const dir = temp('regatta-heat-repo-')
  sh(['init', '-b', 'main'], dir)
  mkdirSync(join(dir, 'test'), { recursive: true })
  writeFileSync(join(dir, 'test', 'cart.test.js'), CART)
  writeFileSync(join(dir, 'GUARD.txt'), 'guard\n')
  writeFileSync(join(dir, 'README.md'), '# regatta\n')
  sh(['add', '.'], dir)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('parseShortstat', () => {
  it('reads files, insertions and deletions', () => {
    expect(parseShortstat(' 3 files changed, 10 insertions(+), 1 deletion(-)')).toEqual({ files: 3, added: 10, removed: 1 })
    expect(parseShortstat(' 1 file changed, 2 insertions(+)')).toEqual({ files: 1, added: 2, removed: 0 })
    expect(parseShortstat(' 1 file changed, 4 deletions(-)')).toEqual({ files: 1, added: 0, removed: 4 })
    expect(parseShortstat('')).toEqual({ files: 0, added: 0, removed: 0 })
  })
})

describe('isRepoWithCommit', () => {
  it('is true for a repository with a commit', async () => {
    expect(await isRepoWithCommit(makeRepo())).toBe(true)
  })

  it('is false for a plain folder and for a repository with no commit', async () => {
    expect(await isRepoWithCommit(temp('regatta-heat-plain-'))).toBe(false)
    const empty = temp('regatta-heat-empty-')
    sh(['init', '-b', 'main'], empty)
    expect(await isRepoWithCommit(empty)).toBe(false)
  }, 30000)

  it('is false for a folder that is not there', async () => {
    expect(await isRepoWithCommit(join(tmpdir(), 'regatta-heat-missing-folder'))).toBe(false)
  })
})

describe('git', () => {
  it('carries git own words in the error and tryGit answers null instead', async () => {
    const repo = makeRepo()
    await expect(git(['cat-file', '-p', 'no-such-object'], repo)).rejects.toThrow()
    expect(await tryGit(['cat-file', '-p', 'no-such-object'], repo)).toBeNull()
    expect((await tryGit(['rev-parse', 'HEAD'], repo))?.trim()).toHaveLength(40)
  }, 30000)
})

describe('git errors', () => {
  it('report the fatal line, not the progress line that comes before it', async () => {
    const repo = makeRepo()
    const dir = temp('regatta-heat-err-')
    const base = await headSha(repo)
    await addWorktree(repo, join(dir, 'one'), 'regatta/heat-abcd-claude', base)
    await expect(addWorktree(repo, join(dir, 'two'), 'regatta/heat-abcd-claude', base)).rejects.toThrow(/already exists/)
  }, 30000)
})

describe('worktrees', () => {
  it('adds a worktree on its own branch', async () => {
    const repo = makeRepo()
    const dir = temp('regatta-heat-wt-')
    const base = await headSha(repo)
    const path = join(dir, 'lane')
    await addWorktree(repo, path, 'regatta/heat-abcd-claude', base)
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], path).trim()).toBe('regatta/heat-abcd-claude')
    expect(readFileSync(join(path, 'GUARD.txt'), 'utf8')).toBe('guard\n')

    sh(['worktree', 'remove', '--force', path], repo)
    expect(existsSync(path)).toBe(false)
    expect(sh(['rev-parse', '--abbrev-ref', 'regatta/heat-abcd-claude'], repo).trim()).toBe('regatta/heat-abcd-claude')
  }, 30000)

  it('adds a detached worktree at a commit for the baseline', async () => {
    const repo = makeRepo()
    const dir = temp('regatta-heat-base-')
    const path = join(dir, 'baseline')
    const base = await headSha(repo)
    await addDetachedWorktree(repo, path, base)
    expect(sh(['rev-parse', 'HEAD'], path).trim()).toBe(base)
    expect(await branchName(path)).toBe(base.slice(0, 7))
    await sh(['worktree', 'remove', '--force', path], repo)
  }, 30000)
})

describe('working in a lane worktree', () => {
  it('counts untracked files in the diff and commits everything as Regatta', async () => {
    const repo = makeRepo()
    const dir = temp('regatta-heat-lane-')
    const path = join(dir, 'lane')
    const base = await headSha(repo)
    await addWorktree(repo, path, 'regatta/heat-abcd-gemini', base)

    expect(await diffFrom(path, base)).toEqual({ files: 0, added: 0, removed: 0 })
    writeFileSync(join(path, 'DONE.txt'), 'done\n')
    // diffFrom marks the new file on a scratch copy of the index; the real one stays as the user left it.
    expect(sh(['status', '--porcelain'], path).trim()).toBe('?? DONE.txt')
    expect(await diffFrom(path, base)).toEqual({ files: 1, added: 1, removed: 0 })

    expect(await commitAll(path, 'Heat abcd: gemini')).toBe(true)
    expect(await commitAll(path, 'Heat abcd: gemini')).toBe(false)
    expect(sh(['log', '-1', '--format=%an <%ae>|%s'], path).trim()).toBe('Regatta <regatta@localhost>|Heat abcd: gemini')
    expect(await diffFrom(path, base)).toEqual({ files: 1, added: 1, removed: 0 })
    expect(await commitCount(repo, base, 'regatta/heat-abcd-gemini')).toBe(1)
    expect(await diffBetween(repo, base, 'regatta/heat-abcd-gemini')).toEqual({ files: 1, added: 1, removed: 0 })
    expect(sh(['status', '--porcelain'], repo).trim()).toBe('')
    await sh(['worktree', 'remove', '--force', path], repo)
  }, 30000)

  it('sees a deleted tracked file in the diff', async () => {
    const repo = makeRepo()
    const dir = temp('regatta-heat-del-')
    const path = join(dir, 'lane')
    const base = await headSha(repo)
    await addWorktree(repo, path, 'regatta/heat-abcd-grok', base)
    unlinkSync(join(path, 'GUARD.txt'))
    expect(await diffFrom(path, base)).toEqual({ files: 1, added: 0, removed: 1 })
    await sh(['worktree', 'remove', '--force', path], repo)
  }, 30000)

  it('counts test cases and assertions at a commit', async () => {
    const repo = makeRepo()
    expect(await countTestsAt(repo, 'HEAD')).toEqual({ 'test/cart.test.js': { cases: 2, assertions: 2 } })
    await expect(countTestsAt(repo, 'no-such-rev')).rejects.toThrow()
  }, 30000)

  it('keeps unusual test file names exactly and counts from a subfolder too', async () => {
    const repo = makeRepo()
    mkdirSync(join(repo, 'test', 'sub dir'), { recursive: true })
    writeFileSync(join(repo, 'test', '\u00e9.test.js'), "it('accents', () => { expect(1).toBe(1) })\n")
    writeFileSync(join(repo, 'test', 'sub dir', 'a "quoted".test.js'), "it('a', () => {})\nit('b', () => {})\n")
    sh(['add', '.'], repo)
    sh([...IDENTITY, 'commit', '-m', 'unusual names'], repo)
    const expected = {
      'test/cart.test.js': { cases: 2, assertions: 2 },
      'test/\u00e9.test.js': { cases: 1, assertions: 1 },
      'test/sub dir/a "quoted".test.js': { cases: 2, assertions: 0 }
    }
    expect(await countTestsAt(repo, 'HEAD')).toEqual(expected)
    // The paths are relative to the top of the repository, wherever the call is made from.
    expect(await countTestsAt(join(repo, 'test'), 'HEAD')).toEqual(expected)
  }, 30000)

  it('lets a read failure through instead of dropping the file', async () => {
    const repo = makeRepo()
    // The tree names a test path whose content git cannot show (a submodule entry with no object).
    sh(['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},test/gone.test.js`], repo)
    sh([...IDENTITY, 'commit', '-m', 'unreadable entry'], repo)
    await expect(countTestsAt(repo, 'HEAD')).rejects.toThrow()
  }, 30000)
})

describe('dirtyTracked', () => {
  it('is about tracked files only', async () => {
    const repo = makeRepo()
    expect(await dirtyTracked(repo)).toBe(false)
    writeFileSync(join(repo, 'extra.txt'), 'new\n')
    expect(await dirtyTracked(repo)).toBe(false)
    expect(await hasChanges(repo)).toBe(true)
    writeFileSync(join(repo, 'README.md'), '# regatta\nedited\n')
    expect(await dirtyTracked(repo)).toBe(true)
    writeFileSync(join(repo, 'README.md'), '# regatta\n')
    expect(await dirtyTracked(repo)).toBe(false)
  }, 30000)
})

describe('dirtyTracked failing', () => {
  it('throws when git cannot say, instead of calling the folder clean', async () => {
    await expect(dirtyTracked(temp('regatta-heat-notrepo-'))).rejects.toThrow()
    await expect(dirtyTracked(join(tmpdir(), 'regatta-heat-missing-folder'))).rejects.toThrow()
  }, 30000)
})

describe('branches and history', () => {
  it('names the branch, and says null on a detached HEAD', async () => {
    const repo = makeRepo()
    expect(await currentBranch(repo)).toBe('main')
    sh(['checkout', '--detach'], repo)
    expect(await currentBranch(repo)).toBeNull()
  }, 30000)

  it('knows branches, their tips and what is reachable', async () => {
    const repo = makeRepo()
    const first = await headSha(repo)
    sh(['branch', 'regatta/heat-zzzz-claude'], repo)
    sh(['branch', 'regatta/heat-zzzz-codex'], repo)
    sh(['branch', 'regatta/heat-zzzzzz-codex'], repo)
    expect(await branchExists(repo, 'regatta/heat-zzzz-claude')).toBe(true)
    expect(await branchExists(repo, 'regatta/heat-nope')).toBe(false)
    expect((await branchesWithPrefix(repo, 'regatta/heat-zzzz-')).sort()).toEqual(['regatta/heat-zzzz-claude', 'regatta/heat-zzzz-codex'])
    expect(await branchTip(repo, 'regatta/heat-zzzz-claude')).toBe(first)
    await expect(branchTip(repo, 'regatta/heat-nope')).rejects.toThrow()
    writeFileSync(join(repo, 'next.txt'), 'next\n')
    sh(['add', '.'], repo)
    sh([...IDENTITY, 'commit', '-m', 'second'], repo)
    expect(await isAncestor(repo, first, 'refs/heads/main')).toBe(true)
    expect(await isAncestor(repo, await headSha(repo), 'refs/heads/regatta/heat-zzzz-claude')).toBe(false)
  }, 30000)
})

describe('operations in progress', () => {
  /** A repository where merging `topic` into main conflicts on README.md. */
  function conflicting(): string {
    const repo = makeRepo()
    sh(['checkout', '-b', 'topic'], repo)
    writeFileSync(join(repo, 'README.md'), '# topic\n')
    sh([...IDENTITY, 'commit', '-am', 'topic'], repo)
    sh(['checkout', 'main'], repo)
    writeFileSync(join(repo, 'README.md'), '# main\n')
    sh([...IDENTITY, 'commit', '-am', 'main'], repo)
    return repo
  }

  it('sees nothing in progress in a quiet repository and leaves it alone on abort', async () => {
    const repo = makeRepo()
    expect(await operationInProgress(repo)).toBeNull()
    expect(await mergeHeadExists(repo)).toBe(false)
    expect(await abortMerge(repo)).toBe(false)
  }, 30000)

  it('sees a merge, aborts it, and sees nothing afterwards', async () => {
    const repo = conflicting()
    expect(() => sh([...IDENTITY, 'merge', 'topic'], repo)).toThrow()
    expect(await operationInProgress(repo)).toBe('merge')
    expect(await mergeHeadExists(repo)).toBe(true)
    expect(await abortMerge(repo)).toBe(true)
    expect(await operationInProgress(repo)).toBeNull()
    expect(sh(['status', '--porcelain'], repo).trim()).toBe('')
  }, 30000)

  it('sees a cherry-pick, a revert and a rebase underway', async () => {
    const pick = conflicting()
    expect(() => sh([...IDENTITY, 'cherry-pick', 'topic'], pick)).toThrow()
    expect(await operationInProgress(pick)).toBe('cherry-pick')

    const revert = makeRepo()
    writeFileSync(join(revert, 'README.md'), '# one\n')
    sh([...IDENTITY, 'commit', '-am', 'one'], revert)
    const one = (await headSha(revert)).trim()
    writeFileSync(join(revert, 'README.md'), '# two\n')
    sh([...IDENTITY, 'commit', '-am', 'two'], revert)
    expect(() => sh([...IDENTITY, 'revert', '--no-edit', one], revert)).toThrow()
    expect(await operationInProgress(revert)).toBe('revert')

    const rebase = conflicting()
    expect(() => sh([...IDENTITY, 'rebase', 'topic'], rebase)).toThrow()
    expect(await operationInProgress(rebase)).toBe('rebase')
  }, 30000)

  it('reads the private git folder of a linked worktree', async () => {
    const repo = makeRepo()
    const dir = temp('regatta-heat-linked-')
    const path = join(dir, 'lane')
    await addWorktree(repo, path, 'regatta/heat-abcd-linked', await headSha(repo))
    expect(await operationInProgress(path)).toBeNull()
    await sh(['worktree', 'remove', '--force', path], repo)
  }, 30000)
})

/** Probes the temp volume directly, without the helper under test. */
function tmpIsCaseInsensitive(): boolean {
  const dir = temp('regatta-heat-probe-')
  writeFileSync(join(dir, 'Probe'), 'x')
  return existsSync(join(dir, 'pROBE'))
}

describe('ignoredCollisions', () => {
  const ignore = (repo: string, text: string): void => writeFileSync(join(repo, '.gitignore'), text)
  /** Commits `files` (path to content, null deletes) on a branch `topic` made from main, then returns to main. */
  function topic(repo: string, files: Record<string, string | null>): string {
    sh(['checkout', '-b', 'topic'], repo)
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        sh(['rm', '-rf', path], repo)
        continue
      }
      mkdirSync(join(repo, path, '..'), { recursive: true })
      writeFileSync(join(repo, path), content)
    }
    sh(['add', '-A'], repo)
    sh([...IDENTITY, 'commit', '-m', 'topic'], repo)
    const tip = sh(['rev-parse', 'HEAD'], repo).trim()
    sh(['checkout', 'main'], repo)
    return tip
  }

  it('finds ignored files a merge would write over, and nothing else', async () => {
    const repo = makeRepo()
    const tip = topic(repo, { 'out/a.txt': 'theirs\n', 'secret.env': 'theirs\n', 'plain.txt': 'theirs\n' })
    expect(await ignoredCollisions(repo, tip)).toEqual([])

    // The user's own ignored files, in a .gitignore that was never committed.
    ignore(repo, 'secret.env\nout/\n')
    writeFileSync(join(repo, 'secret.env'), 'mine\n')
    mkdirSync(join(repo, 'out'), { recursive: true })
    writeFileSync(join(repo, 'out', 'a.txt'), 'mine\n')
    writeFileSync(join(repo, 'out', 'keep.txt'), 'mine\n')
    expect((await ignoredCollisions(repo, tip)).sort()).toEqual(['out/a.txt', 'secret.env'])
    // Ignored files the branch does not touch are not a collision, even in the same folder.
    unlinkSync(join(repo, 'secret.env'))
    unlinkSync(join(repo, 'out', 'a.txt'))
    expect(await ignoredCollisions(repo, tip)).toEqual([])
  }, 30000)

  it('sees a tracked folder that the branch turns into a file when ignored files sit beneath it', async () => {
    const repo = makeRepo()
    mkdirSync(join(repo, 'out'), { recursive: true })
    writeFileSync(join(repo, 'out', 'x.txt'), 'x\n')
    sh(['add', '.'], repo)
    sh([...IDENTITY, 'commit', '-m', 'tracked folder'], repo)
    const tip = topic(repo, { 'out/x.txt': null, out: 'now a file\n' })
    // Nothing of the user's beneath: the merge is safe.
    expect(await ignoredCollisions(repo, tip)).toEqual([])
    ignore(repo, 'out/nested/\n')
    mkdirSync(join(repo, 'out', 'nested'), { recursive: true })
    writeFileSync(join(repo, 'out', 'nested', 'keep.txt'), 'mine\n')
    expect(await ignoredCollisions(repo, tip)).toEqual(['out'])
  }, 30000)

  it('works when the folder given is inside the repository', async () => {
    const repo = makeRepo()
    const tip = topic(repo, { 'src/cache.json': '{"theirs":true}\n', 'cache.json': '{}\n' })
    mkdirSync(join(repo, 'src'), { recursive: true })
    ignore(repo, 'src/cache.json\n')
    writeFileSync(join(repo, 'src', 'cache.json'), '{"mine":true}\n')
    // The top level cache.json is not ignored and does not exist here; only src/cache.json collides.
    expect(await ignoredCollisions(join(repo, 'src'), tip)).toEqual(['src/cache.json'])
    expect(await ignoredCollisions(repo, tip)).toEqual(['src/cache.json'])
  }, 30000)

  it('sees an untracked file where the branch needs a folder', async () => {
    const repo = makeRepo()
    const tip = topic(repo, { 'lib/mod.js': 'x\n' })
    writeFileSync(join(repo, 'lib'), 'a file of mine\n')
    expect(await ignoredCollisions(repo, tip)).toEqual(['lib/mod.js'])
  }, 30000)

  // On a case-insensitive volume (the macOS default) Secret.txt would land on secret.txt.
  it.skipIf(!tmpIsCaseInsensitive())('treats names that differ only in case as the same file on a case-insensitive volume', async () => {
    const repo = makeRepo()
    expect(isCaseInsensitive(repo)).toBe(true)
    const tip = topic(repo, { 'Secret.txt': 'theirs\n' })
    ignore(repo, 'secret.txt\n')
    writeFileSync(join(repo, 'secret.txt'), 'mine\n')
    expect(await ignoredCollisions(repo, tip)).toEqual(['Secret.txt'])
  }, 30000)

  it('reports a case-sensitive repository as such', async () => {
    const dir = temp('regatta-heat-case-')
    mkdirSync(join(dir, '.git'))
    // Whatever the volume says, a folder without the marker is never called case-insensitive.
    expect(isCaseInsensitive(join(dir, 'nowhere'))).toBe(false)
  })
})

function readFile(path: string): string {
  return execFileSync('/bin/cat', [path], { encoding: 'utf8' })
}