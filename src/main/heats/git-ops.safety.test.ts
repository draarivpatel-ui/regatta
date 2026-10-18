// The shared safety mechanisms (docs/design/safety.md) against real repositories and real processes:
// merging into the user's branch, removing a worktree, deleting a branch.

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  addDetachedWorktree,
  addWorktree,
  captureTarget,
  commitAll,
  deleteOwnedBranch,
  diffFrom,
  dirtyTracked,
  git,
  hasChanges,
  headSha,
  mergeIntoCurrentBranch,
  MergeRefused,
  operationInProgress,
  isMarkedCopy,
  keepCommits,
  safeRefName,
  provideModules,
  readModulesClone,
  readSetupLink,
  removeOwnedWorktree,
  sameWorktree,
  setGitOpsHooksSandbox,
  worktreeIdentity
} from './git-ops'
import { processesInside } from './procgroup'
import type { CapturedTarget, OwnedWorktree } from './git-ops'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']

function sh(args: string[], cwd: string, input?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, ...(input !== undefined ? { input } : {}) })
}

const dirs: string[] = []
const children: ChildProcess[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const child of children) {
    try {
      process.kill(child.pid!, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A repository with one commit on main and the user's identity configured. */
function makeRepo(): string {
  const dir = temp('regatta-safety-repo-')
  sh(['init', '-b', 'main'], dir)
  sh(['config', 'user.name', 'Regatta Test'], dir)
  sh(['config', 'user.email', 'test@regatta.local'], dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.js'), 'export const app = 1\n')
  writeFileSync(join(dir, 'README.md'), '# project\n')
  sh(['add', '.'], dir)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], dir)
  return dir
}

/** Writes files (null deletes) and commits them on the branch that is checked out. Returns the commit. */
function commit(repo: string, files: Record<string, string | null>, message = 'work'): string {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      sh(['rm', '-rf', path], repo)
      continue
    }
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  sh(['add', '-A'], repo)
  sh([...IDENTITY, 'commit', '-m', message], repo)
  return sh(['rev-parse', 'HEAD'], repo).trim()
}

/** A commit on a new branch made from main, the way a lane makes one; the folder goes back to main. */
function lane(repo: string, files: Record<string, string | null>, name = 'topic'): string {
  sh(['checkout', '-q', '-b', name, 'main'], repo)
  const tip = commit(repo, files, name)
  sh(['checkout', '-q', 'main'], repo)
  return tip
}

async function refusal(run: Promise<unknown>): Promise<MergeRefused> {
  try {
    await run
  } catch (err) {
    expect(err).toBeInstanceOf(MergeRefused)
    return err as MergeRefused
  }
  throw new Error('the merge was expected to be refused')
}

function worktreeCount(repo: string): number {
  return sh(['worktree', 'list', '--porcelain'], repo)
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length
}

function caseInsensitiveTemp(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-safety-probe-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'Probe'), 'x')
  return existsSync(join(dir, 'pROBE'))
}

describe('mergeIntoCurrentBranch', () => {
  it('fast-forwards when the branch is still where the tested commit started', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'DONE.txt': 'done\n' })
    const captured = await captureTarget(repo)
    const scratch = temp('regatta-safety-scratch-')
    const outcome = await mergeIntoCurrentBranch(repo, tip, 'Merge test', captured, { scratchDir: scratch })
    expect(outcome).toEqual({ fastForward: true, head: tip, alreadyMerged: false })
    expect(await headSha(repo)).toBe(tip)
    expect(readFileSync(join(repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(readdirSync(scratch)).toEqual([])
    expect(worktreeCount(repo)).toBe(1)
  }, 30000)

  it('builds a merge commit away from the folder when the branch moved ahead, then fast-forwards to it', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'DONE.txt': 'done\n' })
    const ahead = commit(repo, { 'LATER.txt': 'later\n' })
    const captured = await captureTarget(repo)
    const scratch = temp('regatta-safety-scratch-')
    const outcome = await mergeIntoCurrentBranch(repo, tip, 'Merge heat abc (claude)', captured, { scratchDir: scratch })
    expect(outcome.fastForward).toBe(false)
    expect(outcome.head).toBe(await headSha(repo))
    const parents = sh(['rev-list', '--parents', '-n', '1', 'HEAD'], repo).trim().split(' ')
    expect(parents.slice(1)).toEqual([ahead, tip])
    expect(sh(['log', '-1', '--format=%s'], repo).trim()).toBe('Merge heat abc (claude)')
    expect(sh(['log', '-1', '--format=%an'], repo).trim()).toBe('Regatta Test')
    expect(readFileSync(join(repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(readFileSync(join(repo, 'LATER.txt'), 'utf8')).toBe('later\n')
    expect(sh(['status', '--porcelain'], repo).trim()).toBe('')
    expect(readdirSync(scratch)).toEqual([])
    expect(worktreeCount(repo)).toBe(1)
  }, 30000)

  it('works without a git identity of the user', async () => {
    const repo = makeRepo()
    sh(['config', '--unset', 'user.name'], repo)
    sh(['config', '--unset', 'user.email'], repo)
    const tip = lane(repo, { 'DONE.txt': 'done\n' })
    commit(repo, { 'LATER.txt': 'later\n' })
    const captured = await captureTarget(repo)
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: temp('regatta-safety-home-') }
    // The helper runs git with the process environment, so give the test process the empty configuration.
    const saved = { ...process.env }
    Object.assign(process.env, env)
    try {
      await mergeIntoCurrentBranch(repo, tip, 'Merge', captured)
    } finally {
      for (const key of Object.keys(env)) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
    expect(sh(['log', '-1', '--format=%an'], repo).trim()).toBe('Regatta')
  }, 30000)

  it('refuses a conflict in the scratch worktree: the folder is untouched and nothing is left behind', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'src/app.js': 'export const app = 2\n' })
    commit(repo, { 'src/app.js': 'export const app = 3\n' })
    const before = await headSha(repo)
    const captured = await captureTarget(repo)
    const scratch = temp('regatta-safety-scratch-')
    const refused = await refusal(mergeIntoCurrentBranch(repo, tip, 'Merge', captured, { scratchDir: scratch }))
    expect(refused.reason).toBe('conflict')
    expect(refused.message).toContain('conflicts with work in main')
    expect(refused.message).not.toMatch(/heat|lane/i)
    expect(await headSha(repo)).toBe(before)
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(sh(['status', '--porcelain'], repo).trim()).toBe('')
    expect(readFileSync(join(repo, 'src', 'app.js'), 'utf8')).toBe('export const app = 3\n')
    expect(readdirSync(scratch)).toEqual([])
    expect(worktreeCount(repo)).toBe(1)
  }, 30000)

  it('does nothing when the branch already has the tested commit', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'DONE.txt': 'done\n' })
    sh(['merge', '--ff-only', tip], repo)
    const captured = await captureTarget(repo)
    const outcome = await mergeIntoCurrentBranch(repo, tip, 'Merge', captured)
    expect(outcome).toMatchObject({ alreadyMerged: true })
    expect(await headSha(repo)).toBe(tip)
  }, 30000)

  // The four cases git 2.54 was verified on (2026-10-14): without --no-overwrite-ignore all four are overwritten.
  const overwrites: { name: string; skip?: boolean; incoming: Record<string, string>; ignore: string; mine: Record<string, string>; hit: string }[] = [
    { name: 'an ignored file at the same path', incoming: { 'secret.env': 'theirs\n' }, ignore: 'secret.env\n', mine: { 'secret.env': 'mine\n' }, hit: 'secret.env' },
    {
      name: 'an ignored file where a folder is needed (a collapsed untracked folder hides it)',
      incoming: { 'out/nested/leaf.txt': 'theirs\n' },
      ignore: 'out/\n',
      mine: { 'out/nested': 'mine\n' },
      hit: 'out/nested'
    },
    {
      name: 'an ignored file inside an ignored folder',
      incoming: { 'out/a.txt': 'theirs\n' },
      ignore: 'out/\n',
      mine: { 'out/a.txt': 'mine\n', 'out/keep.txt': 'mine\n' },
      hit: 'out/a.txt'
    },
    {
      name: 'a case alias on a case-insensitive volume',
      skip: !caseInsensitiveTemp(),
      incoming: { 'Secret.txt': 'theirs\n' },
      ignore: 'secret.txt\n',
      mine: { 'secret.txt': 'mine\n' },
      hit: 'secret.txt'
    }
  ]
  for (const mode of ['fast-forward', 'merge commit'] as const) {
    for (const scenario of overwrites) {
      it.skipIf(scenario.skip === true)(`refuses to overwrite ${scenario.name} (${mode})`, async () => {
        const repo = makeRepo()
        const tip = lane(repo, scenario.incoming)
        if (mode === 'merge commit') commit(repo, { 'LATER.txt': 'later\n' })
        writeFileSync(join(repo, '.gitignore'), scenario.ignore)
        for (const [path, content] of Object.entries(scenario.mine)) {
          mkdirSync(join(repo, path, '..'), { recursive: true })
          writeFileSync(join(repo, path), content)
        }
        const before = await headSha(repo)
        const captured = await captureTarget(repo)
        const refused = await refusal(mergeIntoCurrentBranch(repo, tip, 'Merge', captured))
        expect(refused.reason).toBe('overwrite')
        expect(await headSha(repo)).toBe(before)
        for (const [path, content] of Object.entries(scenario.mine)) expect(readFileSync(join(repo, path), 'utf8')).toBe(content)
        expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
        expect(worktreeCount(repo)).toBe(1)
      }, 30000)
    }
  }

  /** main has old/a.txt; a lane adds old/new.txt from there; the user then renames the whole folder old to renamed. */
  function renamed(): { repo: string; tip: string } {
    const repo = makeRepo()
    // With the setting on, git carries a new file along with the renamed folder (its default only reports a conflict).
    sh(['config', 'merge.directoryRenames', 'true'], repo)
    commit(repo, { 'old/a.txt': 'alpha\n', 'old/b.txt': 'beta\n' }, 'add old')
    const tip = lane(repo, { 'old/new.txt': 'theirs\n' })
    sh(['mv', 'old', 'renamed'], repo)
    sh([...IDENTITY, 'commit', '-am', 'rename the folder'], repo)
    return { repo, tip }
  }

  it('finds the file a directory rename moves the incoming file onto, which a path scan misses', async () => {
    const { repo, tip } = renamed()
    writeFileSync(join(repo, '.gitignore'), 'renamed/new.txt\n')
    writeFileSync(join(repo, 'renamed', 'new.txt'), 'mine\n')
    const before = await headSha(repo)
    const refused = await refusal(mergeIntoCurrentBranch(repo, tip, 'Merge', await captureTarget(repo)))
    expect(refused.reason).toBe('overwrite')
    expect(readFileSync(join(repo, 'renamed', 'new.txt'), 'utf8')).toBe('mine\n')
    expect(await headSha(repo)).toBe(before)
  }, 30000)

  it('does not refuse for an ignored file at the old name of a renamed folder', async () => {
    const { repo, tip } = renamed()
    mkdirSync(join(repo, 'old'), { recursive: true })
    writeFileSync(join(repo, '.gitignore'), 'old/\n')
    writeFileSync(join(repo, 'old', 'new.txt'), 'mine\n')
    const outcome = await mergeIntoCurrentBranch(repo, tip, 'Merge', await captureTarget(repo))
    expect(outcome.fastForward).toBe(false)
    expect(readFileSync(join(repo, 'old', 'new.txt'), 'utf8')).toBe('mine\n')
    expect(readFileSync(join(repo, 'renamed', 'new.txt'), 'utf8')).toBe('theirs\n')
  }, 30000)

  it('refuses an ignored file created after everything was checked, right before the write', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'DONE.txt': 'done\n' })
    commit(repo, { 'LATER.txt': 'later\n' })
    const before = await headSha(repo)
    const captured = await captureTarget(repo)
    const refused = await refusal(
      mergeIntoCurrentBranch(repo, tip, 'Merge', captured, {
        beforeWrite: () => {
          writeFileSync(join(repo, '.gitignore'), 'DONE.txt\n')
          writeFileSync(join(repo, 'DONE.txt'), 'precious\n')
        }
      })
    )
    expect(refused.reason).toBe('overwrite')
    expect(readFileSync(join(repo, 'DONE.txt'), 'utf8')).toBe('precious\n')
    expect(await headSha(repo)).toBe(before)
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
  }, 30000)

  it('names what it would overwrite when it can', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'DONE.txt': 'done\n' })
    writeFileSync(join(repo, '.gitignore'), 'DONE.txt\n')
    writeFileSync(join(repo, 'DONE.txt'), 'precious\n')
    const refused = await refusal(mergeIntoCurrentBranch(repo, tip, 'Merge', await captureTarget(repo)))
    expect(refused.message).toMatch(/DONE\.txt/)
  }, 30000)

  it('lets beforeLaunch stop the write after the last await, so nothing is merged', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'DONE.txt': 'done\n' })
    const before = await headSha(repo)
    let quit = false
    setTimeout(() => {
      quit = true
    }, 100)
    const refused = await (async () => {
      try {
        await mergeIntoCurrentBranch(repo, tip, 'Merge', await captureTarget(repo), {
          // The quit comes during the slow part that follows this hook, which a check made here cannot see.
          beforeWrite: async () => {
            await new Promise((resolve) => setTimeout(resolve, 300))
          },
          beforeLaunch: () => {
            if (quit) throw new Error('quitting')
          }
        })
      } catch (err) {
        return err as Error
      }
      return null
    })()
    expect(refused?.message).toBe('quitting')
    expect(await headSha(repo)).toBe(before)
    expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
  }, 30000)

  it('refuses when the branch is switched after the merge was requested', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'DONE.txt': 'done\n' })
    const captured = await captureTarget(repo)
    sh(['checkout', '-q', '-b', 'elsewhere'], repo)
    const refused = await refusal(mergeIntoCurrentBranch(repo, tip, 'Merge', captured))
    expect(refused.reason).toBe('moved')
    expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
  }, 30000)

  it('refuses when the branch or its commit changes between the preflight and the write', async () => {
    for (const change of ['switch', 'commit'] as const) {
      const repo = makeRepo()
      const tip = lane(repo, { 'DONE.txt': 'done\n' })
      commit(repo, { 'LATER.txt': 'later\n' })
      const captured = await captureTarget(repo)
      const refused = await refusal(
        mergeIntoCurrentBranch(repo, tip, 'Merge', captured, {
          beforeWrite: () => {
            if (change === 'switch') sh(['checkout', '-q', '-b', 'elsewhere'], repo)
            else commit(repo, { 'USERS.txt': 'users\n' })
          }
        })
      )
      expect(refused.reason).toBe('moved')
      expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
      expect(worktreeCount(repo)).toBe(1)
    }
  }, 60000)

  it('refuses a merge the user started after the preflight and leaves it alone', async () => {
    const repo = makeRepo()
    commit(repo, { 'NOTES.txt': 'base\n' })
    const tip = lane(repo, { 'DONE.txt': 'done\n' })
    sh(['checkout', '-q', '-b', 'topic2', 'main'], repo)
    commit(repo, { 'NOTES.txt': 'topic\n' })
    sh(['checkout', '-q', 'main'], repo)
    commit(repo, { 'NOTES.txt': 'main\n' })
    const captured = await captureTarget(repo)
    const refused = await refusal(
      mergeIntoCurrentBranch(repo, tip, 'Merge', captured, {
        beforeWrite: () => {
          try {
            sh([...IDENTITY, 'merge', 'topic2'], repo)
          } catch {
            // It conflicts: MERGE_HEAD is now the user's.
          }
        }
      })
    )
    expect(refused.reason).toBe('busy')
    expect(readFileSync(join(repo, '.git', 'MERGE_HEAD'), 'utf8').trim()).toBe(sh(['rev-parse', 'topic2'], repo).trim())
    expect(sh(['status', '--porcelain'], repo)).toContain('UU NOTES.txt')
  }, 30000)

  it('refuses a detached HEAD, uncommitted tracked changes, a merge underway, and a folder it cannot read', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'DONE.txt': 'done\n' })
    const captured = await captureTarget(repo)

    writeFileSync(join(repo, 'README.md'), '# edited\n')
    expect((await refusal(mergeIntoCurrentBranch(repo, tip, 'Merge', captured))).reason).toBe('dirty')
    sh(['checkout', '--', 'README.md'], repo)

    sh(['checkout', '-q', '--detach'], repo)
    expect((await refusal(mergeIntoCurrentBranch(repo, tip, 'Merge', captured))).reason).toBe('detached')
    await expect(captureTarget(repo)).rejects.toThrow('Check out a branch before merging.')
    sh(['checkout', '-q', 'main'], repo)

    writeFileSync(join(repo, '.git', 'index'), 'this is not an index')
    expect((await refusal(mergeIntoCurrentBranch(repo, tip, 'Merge', captured))).reason).toBe('unknown')
    expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
  }, 30000)

  it('merges the real tested commit even when a replace ref redirects its contents', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'f.txt': 'real\n' })
    sh(['checkout', '-q', '-b', 'fake', 'main'], repo)
    const fake = commit(repo, { 'f.txt': 'fake\n' })
    sh(['checkout', '-q', 'main'], repo)
    sh(['replace', tip, fake], repo)
    // The setup works: plain git is redirected, the engine's git is not.
    expect(sh(['show', `${tip}:f.txt`], repo)).toBe('fake\n')
    expect(await git(['show', `${tip}:f.txt`], repo)).toBe('real\n')

    commit(repo, { 'LATER.txt': 'later\n' })
    const captured = await captureTarget(repo)
    await mergeIntoCurrentBranch(repo, tip, 'Merge', captured)
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('real\n')
  }, 30000)
})

describe('deleteOwnedBranch', () => {
  it('deletes a branch that is exactly at the recorded commit', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'a.txt': 'a\n' }, 'regatta/heat-x-claude')
    expect(await deleteOwnedBranch(repo, 'regatta/heat-x-claude', tip)).toEqual({
      deleted: true,
      reason: null,
      parked: 'refs/regatta/discarded/heat-x-claude'
    })
    expect(sh(['branch', '--list', 'regatta/*'], repo).trim()).toBe('')
    // Gone already: not an error and nothing to say.
    expect(await deleteOwnedBranch(repo, 'regatta/heat-x-claude', tip)).toEqual({ deleted: false, reason: null })
  }, 30000)

  it('keeps a branch that moved on, and a branch checked out somewhere', async () => {
    const repo = makeRepo()
    const start = await headSha(repo)
    sh(['branch', 'regatta/heat-x-claude', start], repo)
    sh(['checkout', '-q', 'regatta/heat-x-claude'], repo)
    const users = commit(repo, { 'users.txt': 'mine\n' }, "user's own later commit")
    sh(['checkout', '-q', 'main'], repo)
    const moved = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', start)
    expect(moved.deleted).toBe(false)
    expect(moved.reason).toContain('regatta/heat-x-claude')
    expect(sh(['rev-parse', 'regatta/heat-x-claude'], repo).trim()).toBe(users)

    const dir = temp('regatta-safety-wt-')
    sh(['worktree', 'add', join(dir, 'there'), 'regatta/heat-x-claude'], repo)
    const used = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', users)
    expect(used.deleted).toBe(false)
    expect(used.reason).toContain('checked out')
  }, 30000)

  it('never follows a symbolic ref to the branch it names', async () => {
    const repo = makeRepo()
    const main = await headSha(repo)
    sh(['symbolic-ref', 'refs/heads/regatta/heat-x-claude', 'refs/heads/main'], repo)
    const result = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', main)
    expect(result.deleted).toBe(false)
    expect(result.reason).toContain('symbolic')
    expect(sh(['rev-parse', 'main'], repo).trim()).toBe(main)
    expect(sh(['rev-parse', 'main'], repo).trim()).toBe(main)
    expect(sh(['symbolic-ref', 'refs/heads/regatta/heat-x-claude'], repo).trim()).toBe('refs/heads/main')
  }, 30000)

  it('keeps a branch when no commit was recorded for it', async () => {
    const repo = makeRepo()
    sh(['branch', 'regatta/heat-x-claude'], repo)
    expect((await deleteOwnedBranch(repo, 'regatta/heat-x-claude', '')).deleted).toBe(false)
    expect(sh(['branch', '--list', 'regatta/*'], repo).trim()).not.toBe('')
  }, 30000)
})

describe('deleteOwnedBranch keeps everything, unconditionally', () => {
  const keepRef = 'refs/regatta/discarded/heat-x-claude'
  function gcAll(repo: string): void {
    sh(['reflog', 'expire', '--expire=now', '--all'], repo)
    sh(['gc', '--prune=now', '-q'], repo)
  }

  it('keeps a user commit at the tip reachable from the keep ref after the branch is gone', async () => {
    const repo = makeRepo()
    sh(['checkout', '-q', '-b', 'regatta/heat-x-claude', 'main'], repo)
    const mine = commit(repo, { 'users.txt': "the user's own commit\n" }, 'user commit in the lane')
    sh(['checkout', '-q', 'main'], repo)
    const result = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', mine)
    expect(result).toEqual({ deleted: true, reason: null, parked: keepRef })
    expect(sh(['branch', '--list', 'regatta/*'], repo).trim()).toBe('')
    // One keep commit with an empty tree; the tip is its first parent.
    expect(sh(['rev-parse', `${keepRef}^1`], repo).trim()).toBe(mine)
    expect(sh(['rev-parse', `${keepRef}^{tree}`], repo).trim()).toBe(sh(['hash-object', '-t', 'tree', '/dev/null'], repo).trim())
    expect(sh(['log', '-1', '--format=%an <%ae>', keepRef], repo).trim()).toBe('Regatta <regatta@localhost>')
    expect(sh(['log', '-1', '--format=%s', keepRef], repo)).toContain('regatta/heat-x-claude')
    gcAll(repo)
    sh(['branch', 'restored', `${keepRef}^1`], repo)
    expect(sh(['show', 'restored:users.txt'], repo)).toBe("the user's own commit\n")
  }, 30000)

  it('keeps the commit even when a stash reaches it and is popped afterwards', async () => {
    const repo = makeRepo()
    const dir = temp('regatta-safety-wt-')
    const path = join(dir, 'lane')
    await addWorktree(repo, path, 'regatta/heat-x-claude', await headSha(repo))
    writeFileSync(join(path, 'left-behind.txt'), 'the user left this here\n')
    sh(['add', '-A'], path)
    sh([...IDENTITY, 'commit', '-m', 'Heat x: claude'], path)
    const tip = sh(['rev-parse', 'HEAD'], path).trim()
    writeFileSync(join(path, 'work.txt'), 'edit\n')
    sh(['add', '-A'], path)
    sh([...IDENTITY, 'stash'], path)
    sh(['worktree', 'remove', path], repo)

    const result = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', tip)
    expect(result.deleted).toBe(true)
    sh([...IDENTITY, 'stash', 'pop'], repo)
    expect(sh(['for-each-ref', 'refs/stash'], repo).trim()).toBe('')
    gcAll(repo)
    expect(sh(['show', `${keepRef}^1:left-behind.txt`], repo)).toBe('the user left this here\n')
  }, 60000)

  it('keeps a commit that only an old value of the branch reflog remembers (after a partial expiry), which %H does not list', async () => {
    const repo = makeRepo()
    const base = await headSha(repo)
    const unique = sh([...IDENTITY, 'commit-tree', 'HEAD^{tree}', '-p', base, '-m', 'unique, only in an old value'], repo).trim()
    const tip = lane(repo, { 'a.txt': 'a\n' }, 'regatta/heat-x-claude')
    // The reflog as a partial expiry leaves it: the oldest retained entry went from `unique` to the tip.
    const log = join(repo, '.git', 'logs', 'refs', 'heads', 'regatta')
    mkdirSync(log, { recursive: true })
    writeFileSync(join(log, 'heat-x-claude'), `${unique} ${tip} Regatta <regatta@localhost> 1760000000 +0000\treset: moving to the tip\n`)
    expect(sh(['reflog', 'show', '--format=%H', 'refs/heads/regatta/heat-x-claude'], repo).trim()).toBe(tip)
    expect(sh(['rev-list', '--all', '--reflog'], repo)).toContain(unique)

    const result = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', tip)
    expect(result.deleted).toBe(true)
    sh(['reflog', 'expire', '--expire=now', '--all'], repo)
    expect(sh(['rev-list', '--all'], repo)).toContain(unique)
    gcAll(repo)
    expect(sh(['cat-file', '-t', unique], repo).trim()).toBe('commit')
    expect(sh(['rev-parse', `${keepRef}^2`], repo).trim()).toBe(unique)
  }, 60000)

  it('keeps the commit when the branch that also held it is deleted at the same time', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'a.txt': 'a\n' }, 'regatta/heat-x-claude')
    sh(['branch', 'holder', tip], repo)
    // No question is asked about holders, so deleting the holder meanwhile cannot lose the commit.
    const deleting = deleteOwnedBranch(repo, 'regatta/heat-x-claude', tip)
    sh(['branch', '-D', 'holder'], repo)
    expect((await deleting).deleted).toBe(true)
    gcAll(repo)
    expect(sh(['cat-file', '-t', tip], repo).trim()).toBe('commit')
    expect(sh(['rev-parse', `${keepRef}^1`], repo).trim()).toBe(tip)
  }, 60000)

  it('keeps a commit that was reset to the same base and is held by nothing else', async () => {
    const repo = makeRepo()
    const base = await headSha(repo)
    sh(['checkout', '-q', '-b', 'regatta/heat-x-claude', 'main'], repo)
    const first = commit(repo, { 'u.txt': 'unique\n' }, 'unique commit')
    sh(['reset', '-q', '--hard', base], repo)
    sh(['checkout', '-q', 'main'], repo)
    expect((await deleteOwnedBranch(repo, 'regatta/heat-x-claude', base)).deleted).toBe(true)
    gcAll(repo)
    expect(sh(['cat-file', '-t', first], repo).trim()).toBe('commit')
  }, 60000)

  it('makes a valid ref name out of a folder or branch name that git would refuse as a ref', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'a.txt': 'a\n' }, 'regatta/heat-x-claude')
    const odd = 'tab\tname/back\\slash/new\nline/caf\u00e9~1/a..b/x.lock/.hidden/trailing.'
    const result = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', tip, { parkAs: odd })
    expect(result.deleted).toBe(true)
    expect(result.parked).toBe('refs/regatta/discarded/tab_name/back_slash/new_line/caf__1/a_b/x_lock/_hidden/trailing_')
    expect(sh(['rev-parse', `${result.parked}^1`], repo).trim()).toBe(tip)
    expect(safeRefName('')).toBe('kept')
  }, 30000)

  it('numbers the name when it is taken, and takes a name from the caller', async () => {
    const repo = makeRepo()
    const first = lane(repo, { 'a.txt': 'a\n' }, 'regatta/heat-x-claude')
    const second = lane(repo, { 'b.txt': 'b\n' }, 'regatta/heat-y-claude')
    expect((await deleteOwnedBranch(repo, 'regatta/heat-x-claude', first, { parkAs: 'shared' })).parked).toBe('refs/regatta/discarded/shared')
    expect((await deleteOwnedBranch(repo, 'regatta/heat-y-claude', second, { parkAs: 'shared' })).parked).toBe('refs/regatta/discarded/shared-2')
    expect(sh(['rev-parse', 'refs/regatta/discarded/shared^1'], repo).trim()).toBe(first)
    expect(sh(['rev-parse', 'refs/regatta/discarded/shared-2^1'], repo).trim()).toBe(second)
  }, 30000)

  it('keeps a merged branch too, since nothing is asked about who else holds it', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'a.txt': 'a\n' }, 'regatta/heat-x-claude')
    sh(['merge', '--ff-only', tip], repo)
    const result = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', tip)
    expect(result).toEqual({ deleted: true, reason: null, parked: keepRef })
  }, 30000)

  it('chains the keep commits when there are more commits than one holds', async () => {
    const repo = makeRepo()
    const tree = sh(['hash-object', '-w', '-t', 'tree', '/dev/null'], repo).trim()
    const ids = Array.from({ length: 7 }, (_, i) => sh([...IDENTITY, 'commit-tree', tree, '-m', `c${i}`], repo).trim())
    const ref = await keepCommits(repo, ids, 'chained', 'a long one', 3)
    // The first id is the work to restore: it is the first parent however many keep commits there are. The other
    // six go three at a time: two keep commits, the second with the first as another parent.
    expect(sh(['rev-parse', `${ref}^1`], repo).trim()).toBe(ids[0])
    expect(sh(['rev-list', '--count', ref], repo).trim()).toBe(String(7 + 2))
    expect(sh(['rev-list', '--parents', '-n', '1', ref], repo).trim().split(' ').slice(1, 3)).toEqual([ids[0], sh(['rev-parse', `${ref}^2`], repo).trim()])
    gcAll(repo)
    for (const id of ids) expect(sh(['cat-file', '-t', id], repo).trim()).toBe('commit')
    // Things that are not commits, and zero ids, are dropped.
    const blob = sh(['hash-object', '-w', '--stdin'], repo, 'not a commit').trim()
    const dropped = await keepCommits(repo, ['0'.repeat(40), blob, ids[0]!], 'dropped', 'filtered')
    expect(sh(['rev-list', '--count', dropped], repo).trim()).toBe('2')
  }, 60000)

  it('keeps the branch when no copy can be made', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'a.txt': 'a\n' }, 'regatta/heat-x-claude')
    // A ref named refs/regatta blocks every ref below it.
    sh(['update-ref', 'refs/regatta', await headSha(repo)], repo)
    const result = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', tip)
    expect(result.deleted).toBe(false)
    expect(result.reason).toContain('copy of its commits could not be made')
    expect(sh(['rev-parse', 'regatta/heat-x-claude'], repo).trim()).toBe(tip)
  }, 30000)
})

describe('commits that leave the node_modules link out', () => {
  it('does not commit or count a node_modules link that a node_modules/ ignore line fails to match', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    sh(['add', '.gitignore'], repo)
    sh([...IDENTITY, 'commit', '-m', 'ignore'], repo)
    const dir = temp('regatta-safety-wt-')
    const path = join(dir, 'lane')
    const base = await headSha(repo)
    await addWorktree(repo, path, 'regatta/heat-x-claude', base)
    symlinkSync(temp('regatta-safety-modules-'), join(path, 'node_modules'), 'dir')
    // The pattern ends in a slash, which does not match a symlink: git sees it as untracked.
    expect(sh(['status', '--porcelain'], path).trim()).toBe('?? node_modules')
    // Only the link: nothing to commit, and no empty commit is made. No caller has to ask for this.
    expect(await commitAll(path, 'nothing')).toBe(false)
    expect(await diffFrom(path, base)).toEqual({ files: 0, added: 0, removed: 0 })
    writeFileSync(join(path, 'work.txt'), 'work\n')
    expect(await diffFrom(path, base)).toMatchObject({ files: 1 })
    expect(await commitAll(path, 'work')).toBe(true)
    expect(sh(['ls-tree', '-r', '--name-only', 'HEAD'], path).split('\n')).not.toContain('node_modules')
    expect(sh(['status', '--porcelain'], path).trim()).toBe('?? node_modules')
  }, 30000)
})

describe('a node_modules the project tracks itself', () => {
  it('is committed like any other file, only an untracked link is left out', async () => {
    const repo = makeRepo()
    const dir = temp('regatta-safety-wt-')
    const path = join(dir, 'lane')
    await addWorktree(repo, path, 'regatta/heat-x-claude', await headSha(repo))
    symlinkSync('src', join(path, 'node_modules'), 'dir')
    // Tracked once, a change to it is the project's business.
    sh(['add', 'node_modules'], path)
    sh([...IDENTITY, 'commit', '-m', 'track the link'], path)
    unlinkSync(join(path, 'node_modules'))
    symlinkSync('README.md', join(path, 'node_modules'), 'file')
    expect(await commitAll(path, 'retarget')).toBe(true)
    expect(sh(['show', 'HEAD:node_modules'], path)).toBe('README.md')
  }, 30000)
})

async function kept(record: OwnedWorktree, reasonPart: string): Promise<void> {
  const result = await removeOwnedWorktree(record)
  expect(result.status).toBe('kept')
  expect(result.reason).toContain(reasonPart)
  expect(existsSync(record.path)).toBe(true)
}

/** A fingerprint of a whole folder: names, file contents and link targets. */
function treeHash(root: string): string {
  const hash = createHash('sha1')
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === root && name === '.regatta-copy') continue // the marker Regatta writes into its own copy
      const path = join(dir, name)
      const stat = lstatSync(path)
      hash.update(`${path.slice(root.length)}|${stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? `l:${readlinkSync(path)}` : `f:${stat.size}`}\n`)
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) hash.update(readFileSync(path))
    }
  }
  walk(root)
  return hash.digest('hex')
}

describe('provideModules gives a worktree its own copy of node_modules', () => {
  function project(): string {
    const repo = makeRepo()
    mkdirSync(join(repo, 'node_modules', 'pkg', 'lib'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    writeFileSync(join(repo, 'node_modules', 'pkg', 'lib', 'big.bin'), Buffer.alloc(40 * 1024 * 1024, 7))
    mkdirSync(join(repo, 'node_modules', '.bin'))
    symlinkSync('../pkg/index.js', join(repo, 'node_modules', '.bin', 'pkg'))
    return repo
  }

  it.skipIf(process.platform !== 'darwin')('clones it (no extra disk), and nothing done in the copy reaches the original', async () => {
    const repo = project()
    const dir = temp('regatta-safety-wt-')
    const path = join(dir, 'lane')
    await addWorktree(repo, path, 'regatta/heat-x-claude', await headSha(repo))
    const original = treeHash(join(repo, 'node_modules'))
    const freeBefore = Number(execFileSync('df', ['-k', dir], { encoding: 'utf8' }).trim().split('\n')[1]!.split(/\s+/)[3])
    const provided = await provideModules(repo, path)
    const freeAfter = Number(execFileSync('df', ['-k', dir], { encoding: 'utf8' }).trim().split('\n')[1]!.split(/\s+/)[3])
    expect(provided.note).toBeNull()
    expect(provided.clone).toEqual(readModulesClone(path))
    expect(lstatSync(join(path, 'node_modules')).isSymbolicLink()).toBe(false)
    expect(treeHash(join(path, 'node_modules'))).toBe(original)
    // 40 MB of data, and the disk gave up far less than that (other programs write too, so the bound is generous).
    expect(freeBefore - freeAfter).toBeLessThan(20 * 1024)

    // What `npm ci` and `rm -rf node_modules` do, done in the copy.
    writeFileSync(join(path, 'node_modules', 'pkg', 'index.js'), 'changed in the copy\n')
    writeFileSync(join(path, 'node_modules', 'pkg', 'lib', 'big.bin'), 'tiny')
    rmSync(join(path, 'node_modules', '.bin'), { recursive: true })
    expect(treeHash(join(repo, 'node_modules'))).toBe(original)
    rmSync(join(path, 'node_modules'), { recursive: true })
    expect(treeHash(join(repo, 'node_modules'))).toBe(original)
    expect(readFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
  }, 60000)

  it('gives nothing and a note when it cannot clone, leaving no half copy', async () => {
    const repo = project()
    const missing = join(temp('regatta-safety-wt-'), 'not', 'there')
    const provided = await provideModules(repo, missing)
    expect(provided.clone).toBeNull()
    expect(provided.note).toBe('Dependencies were not copied into the worktree; run your install command there.')
    expect(existsSync(join(missing, 'node_modules'))).toBe(false)
  }, 30000)

  it('does nothing without a node_modules, with one the worktree has, and says so for a link in the project', async () => {
    const plain = makeRepo()
    const dir = temp('regatta-safety-wt-')
    const path = join(dir, 'lane')
    await addWorktree(plain, path, 'regatta/heat-x-claude', await headSha(plain))
    expect(await provideModules(plain, path)).toEqual({ clone: null, note: null })
    const linked = makeRepo()
    symlinkSync(temp('regatta-safety-real-modules-'), join(linked, 'node_modules'), 'dir')
    const second = join(dir, 'lane2')
    await addWorktree(linked, second, 'regatta/heat-x-claude', await headSha(linked))
    const result = await provideModules(linked, second)
    expect(result.clone).toBeNull()
    expect(result.note).toContain('run your install command')
    expect(existsSync(join(second, 'node_modules'))).toBe(false)
  }, 30000)

  it.skipIf(process.platform !== 'darwin')('moves the lane and its node_modules copy to trash without touching the project', async () => {
    const repo = project()
    const dir = temp('regatta-safety-wt-')
    const second = join(dir, 'lane2')
    await addWorktree(repo, second, 'regatta/heat-x-codex', await headSha(repo))
    const provided = await provideModules(repo, second)
    const original = treeHash(join(repo, 'node_modules'))
    const result = await removeOwnedWorktree({ root: repo, path: second, identity: worktreeIdentity(second), dir, modulesClone: provided.clone })
    expect(result.reason).toBeNull()
    expect(result.status).toBe('trashed')
    expect(existsSync(second)).toBe(false)
    expect(existsSync(result.trashPath!)).toBe(true)
    expect(readdirSync(dir).filter((name) => name.includes('modules'))).toEqual([])
    expect(treeHash(join(repo, 'node_modules'))).toBe(original)
  }, 60000)
})

/** A lane worktree on its own branch with a commit, and the record the engine would keep for it. */
async function lanePair(): Promise<{ repo: string; dir: string; path: string; record: OwnedWorktree }> {
  const repo = makeRepo()
  const dir = temp('regatta-safety-wt-')
  const path = join(dir, 'lane')
  const start = await headSha(repo)
  await addWorktree(repo, path, 'regatta/heat-x-claude', start)
  writeFileSync(join(path, 'work.txt'), 'the lane work\n')
  sh(['add', '-A'], path)
  sh([...IDENTITY, 'commit', '-m', 'lane work'], path)
  return { repo, dir, path, record: { root: repo, path, identity: worktreeIdentity(path), dir } }
}

describe('provideModules (round 9)', () => {
  function projectWith(links: Record<string, string>): string {
    const repo = makeRepo()
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    mkdirSync(join(repo, 'node_modules', '.bin'))
    for (const [name, target] of Object.entries(links)) {
      mkdirSync(join(repo, 'node_modules', name, '..'), { recursive: true })
      symlinkSync(target, join(repo, 'node_modules', name))
    }
    return repo
  }
  async function lane(repo: string, branch = 'regatta/heat-x-claude'): Promise<{ dir: string; path: string }> {
    const dir = temp('regatta-safety-wt-')
    const path = join(dir, 'lane')
    await addWorktree(repo, path, branch, await headSha(repo))
    return { dir, path }
  }

  it.skipIf(process.platform !== 'darwin')('marks its copy with the folder inode and creation time, and the marker does not survive a copy of the folder', async () => {
    const repo = projectWith({ '.bin/pkg': '../pkg/index.js' })
    const { dir, path } = await lane(repo)
    const { clone } = await provideModules(repo, path)
    expect(clone).not.toBeNull()
    const now = readModulesClone(path)!
    expect(readFileSync(join(path, 'node_modules', '.regatta-copy'), 'utf8').trim()).toBe(`${now.ino}:${now.birthtimeMs}`)
    expect(isMarkedCopy(path)).toBe(true)
    // A copy of the folder (marker included) is another folder: it is not marked.
    execFileSync('cp', ['-c', '-R', join(path, 'node_modules'), join(dir, 'elsewhere')])
    mkdirSync(join(dir, 'other-lane'))
    execFileSync('mv', [join(dir, 'elsewhere'), join(dir, 'other-lane', 'node_modules')])
    expect(isMarkedCopy(join(dir, 'other-lane'))).toBe(false)
    unlinkSync(join(path, 'node_modules', '.regatta-copy'))
    expect(isMarkedCopy(path)).toBe(false)
  }, 60000)

  it.skipIf(process.platform !== 'darwin')('refuses a copy with a link that leaves the worktree, and keeps the ones that stay inside', async () => {
    const repo = projectWith({})
    const { path } = await lane(repo)
    // npm link: an absolute link back into the project, and a relative one that climbs out.
    mkdirSync(join(repo, 'packages', 'live'), { recursive: true })
    symlinkSync(join(repo, 'packages', 'live'), join(repo, 'node_modules', 'live'))
    const refused = await provideModules(repo, path)
    expect(refused.clone).toBeNull()
    expect(refused.note).toContain('links outside the worktree')
    expect(existsSync(join(path, 'node_modules'))).toBe(false)
    expect(readdirSync(join(path, '..')).filter((name) => name.startsWith('.regatta-tmp'))).toEqual([])
    // The project's own folder and link are untouched.
    expect(readlinkSync(join(repo, 'node_modules', 'live'))).toBe(join(repo, 'packages', 'live'))

    unlinkSync(join(repo, 'node_modules', 'live')) // a link to a folder: unlink, not rm
    symlinkSync('../../../../elsewhere', join(repo, 'node_modules', 'climbs'))
    const climbs = await provideModules(repo, path)
    expect(climbs.clone).toBeNull()
    expect(climbs.note).toContain('links outside the worktree')
    unlinkSync(join(repo, 'node_modules', 'climbs'))

    // Links that stay inside the worktree are fine: .bin, and a workspace package under the worktree.
    mkdirSync(join(repo, 'packages', 'ws'), { recursive: true })
    writeFileSync(join(repo, 'packages', 'ws', 'index.js'), 'x\n')
    sh(['add', 'packages'], repo)
    sh([...IDENTITY, 'commit', '-m', 'a workspace package'], repo)
    mkdirSync(join(repo, 'node_modules', '@scope'), { recursive: true })
    symlinkSync('../../packages/ws', join(repo, 'node_modules', '@scope', 'ws'))
    symlinkSync('../pkg/index.js', join(repo, 'node_modules', '.bin', 'pkg'))
    const good = await lane(repo, 'regatta/heat-fine')
    const fine = await provideModules(repo, good.path)
    expect(fine.note).toBeNull()
    expect(fine.clone).not.toBeNull()
    expect(readlinkSync(join(good.path, 'node_modules', '@scope', 'ws'))).toBe('../../packages/ws')
  }, 60000)

  it.skipIf(process.platform !== 'darwin')('follows whole chains: a link to a tracked link that points outside the worktree is refused', async () => {
    const repo = projectWith({})
    const outside = temp('regatta-safety-outside-')
    writeFileSync(join(outside, 'precious.txt'), 'outside the worktree\n')
    // packages/live is itself a symlink tracked in the repository, and it leaves the worktree.
    mkdirSync(join(repo, 'packages'))
    symlinkSync(outside, join(repo, 'packages', 'live'))
    sh(['add', 'packages'], repo)
    sh([...IDENTITY, 'commit', '-m', 'a tracked link out'], repo)
    symlinkSync('../packages/live', join(repo, 'node_modules', 'live'))
    const { path } = await lane(repo)
    const refused = await provideModules(repo, path)
    expect(refused.clone).toBeNull()
    expect(refused.note).toContain('links outside the worktree')
    expect(existsSync(join(path, 'node_modules'))).toBe(false)
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('outside the worktree\n')
  }, 60000)

  it.skipIf(process.platform !== 'darwin')('lets the system resolve each link: a chain inside the copy, and .. after a link (the bridge case)', async () => {
    const repo = projectWith({})
    // a -> b -> pkg inside the copy: fine.
    symlinkSync('b', join(repo, 'node_modules', 'a'))
    symlinkSync('pkg', join(repo, 'node_modules', 'b'))
    const ok = await lane(repo, 'regatta/heat-ok')
    const fine = await provideModules(repo, ok.path)
    expect(fine.note).toBeNull()
    expect(fine.clone).not.toBeNull()

    // A tracked link `bridge -> .` and a dependency link `escape -> ../bridge/../victim.txt`: a hand-made resolver
    // drops `bridge/..`, the file system follows `bridge` first, and the write lands next to the worktree.
    symlinkSync('.', join(repo, 'bridge'))
    sh(['add', 'bridge'], repo)
    sh([...IDENTITY, 'commit', '-m', 'a link to the folder itself'], repo)
    symlinkSync('../bridge/../victim.txt', join(repo, 'node_modules', 'escape'))
    const bridge = await lane(repo, 'regatta/heat-bridge')
    writeFileSync(join(bridge.dir, 'victim.txt'), 'outside the worktree\n')
    const refused = await provideModules(repo, bridge.path)
    expect(refused.clone).toBeNull()
    expect(refused.note).toContain('links outside the worktree')
    expect(existsSync(join(bridge.path, 'node_modules'))).toBe(false)
    expect(readFileSync(join(bridge.dir, 'victim.txt'), 'utf8')).toBe('outside the worktree\n')
    expect(readdirSync(bridge.dir).filter((name) => name.startsWith('.regatta-tmp'))).toEqual([])
    unlinkSync(join(repo, 'node_modules', 'escape'))

    // A loop cannot be resolved, a dangling link has nowhere to go: both are refused.
    unlinkSync(join(repo, 'node_modules', 'b'))
    symlinkSync('a', join(repo, 'node_modules', 'b'))
    const loop = await lane(repo, 'regatta/heat-loop')
    expect((await provideModules(repo, loop.path)).clone).toBeNull()
    expect(existsSync(join(loop.path, 'node_modules'))).toBe(false)
    unlinkSync(join(repo, 'node_modules', 'b'))
    unlinkSync(join(repo, 'node_modules', 'a'))
    symlinkSync('../not-there-yet.js', join(repo, 'node_modules', '.bin', 'missing'))
    const dangling = await lane(repo, 'regatta/heat-dangling')
    expect((await provideModules(repo, dangling.path)).clone).toBeNull()
    expect(existsSync(join(dangling.path, 'node_modules'))).toBe(false)
  }, 120000)

  it.skipIf(process.platform !== 'darwin')('refuses a copy that already holds a .regatta-copy entry, and writes the marker without following anything', async () => {
    const repo = projectWith({})
    const { path } = await lane(repo)
    // The entry in the project's own node_modules is a link to notes that only the worktree has.
    const notes = join(path, 'my-notes.txt')
    writeFileSync(notes, 'unsaved notes of the user\n')
    symlinkSync(notes, join(repo, 'node_modules', '.regatta-copy'))
    const refused = await provideModules(repo, path)
    expect(refused.clone).toBeNull()
    expect(refused.note).toContain('.regatta-copy')
    expect(readFileSync(notes, 'utf8')).toBe('unsaved notes of the user\n')
    expect(existsSync(join(path, 'node_modules'))).toBe(false)
    // A plain file with that name is refused the same way.
    unlinkSync(join(repo, 'node_modules', '.regatta-copy'))
    writeFileSync(join(repo, 'node_modules', '.regatta-copy'), 'not ours\n')
    const plain = await provideModules(repo, path)
    expect(plain.clone).toBeNull()
    expect(plain.note).toContain('.regatta-copy')
  }, 60000)

  // A cp that takes its time (and can be made to fail), first on the PATH.
  function slowCp(seconds: number, fail: boolean): string {
    const bin = temp('regatta-safety-cp-')
    writeFileSync(join(bin, 'cp'), `#!/bin/sh\nsleep ${seconds}\n${fail ? 'exit 1' : 'exec /bin/cp "$@"'}\n`, { mode: 0o755 })
    return bin
  }

  for (const failing of [false, true]) {
    it.skipIf(process.platform !== 'darwin')(`never touches what the user made in the worktree while the copy ran (${failing ? 'copy fails' : 'copy succeeds'})`, async () => {
      const repo = projectWith({})
      const { path } = await lane(repo)
      const bin = slowCp(1, failing)
      const saved = process.env['PATH']
      process.env['PATH'] = `${bin}:${saved}`
      try {
        const running = provideModules(repo, path)
        // The user creates the folder in the visible worktree while the copy is being made.
        await new Promise((resolve) => setTimeout(resolve, 300))
        mkdirSync(join(path, 'node_modules'))
        writeFileSync(join(path, 'node_modules', 'mine.txt'), 'mine\n')
        const result = await running
        expect(result.clone).toBeNull()
      } finally {
        process.env['PATH'] = saved
      }
      expect(readFileSync(join(path, 'node_modules', 'mine.txt'), 'utf8')).toBe('mine\n')
      expect(readdirSync(join(path, 'node_modules'))).toEqual(['mine.txt'])
      expect(readdirSync(join(path, '..')).filter((name) => name.startsWith('.regatta-tmp'))).toEqual([])
    }, 60000)
  }
})

describe('retiring a lane keeps everything it could be the last holder of', () => {
  const ref = 'refs/regatta/discarded/lane'
  function gcAll(repo: string): void {
    sh(['reflog', 'expire', '--expire=now', '--all'], repo)
    sh(['gc', '--prune=now', '-q'], repo)
  }
  async function reachable(repo: string, id: string): Promise<boolean> {
    return sh(['rev-list', ref], repo).split('\n').includes(id)
  }

  it('keeps a detached commit that only the HEAD reflog remembers (the branch was checked out again)', async () => {
    const { repo, path, record } = await lanePair()
    sh(['checkout', '-q', '--detach'], path)
    writeFileSync(join(path, 'detached.txt'), 'made on a detached HEAD\n')
    sh(['add', '-A'], path)
    sh([...IDENTITY, 'commit', '-m', 'detached work'], path)
    const lost = sh(['rev-parse', 'HEAD'], path).trim()
    sh(['checkout', '-q', 'regatta/heat-x-claude'], path)
    expect(sh(['status', '--porcelain'], path).trim()).toBe('')
    expect((await removeOwnedWorktree(record)).status).toBe('trashed')
    expect(await reachable(repo, lost)).toBe(true)
    gcAll(repo)
    expect(sh(['show', `${lost}:detached.txt`], repo)).toBe('made on a detached HEAD\n')
  }, 60000)

  it('keeps the commit of a detached HEAD when no reflog is written at all', async () => {
    const repo = makeRepo()
    sh(['config', 'core.logAllRefUpdates', 'false'], repo)
    const dir = temp('regatta-safety-wt-')
    const path = join(dir, 'lane')
    await addWorktree(repo, path, 'regatta/heat-x-claude', await headSha(repo))
    const record: OwnedWorktree = { root: repo, path, identity: worktreeIdentity(path), dir }
    sh(['checkout', '-q', '--detach'], path)
    writeFileSync(join(path, 'detached.txt'), 'only here\n')
    sh(['add', '-A'], path)
    sh([...IDENTITY, 'commit', '-m', 'only copy'], path)
    const lost = sh(['rev-parse', 'HEAD'], path).trim()
    expect(sh(['reflog', 'show', 'HEAD'], path).trim()).toBe('')
    expect((await removeOwnedWorktree(record)).status).toBe('trashed')
    gcAll(repo)
    expect(await reachable(repo, lost)).toBe(true)
  }, 60000)

  it('keeps commits that only the worktree\'s own refs hold, including one made with commit-tree', async () => {
    for (const name of ['refs/worktree/x', 'refs/bisect/bad', 'refs/rewritten/onto']) {
      const { repo, path, record } = await lanePair()
      const lone = sh([...IDENTITY, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', `held only by ${name}`], path).trim()
      sh(['update-ref', name, lone], path)
      expect(sh(['status', '--porcelain'], path).trim()).toBe('')
      expect((await removeOwnedWorktree(record)).status, name).toBe('trashed')
      gcAll(repo)
      expect(await reachable(repo, lone), name).toBe(true)
    }
  }, 120000)

  it('keeps a detached commit that a stash reached, even after the stash is popped and gc runs', async () => {
    const { repo, path, record } = await lanePair()
    sh(['checkout', '-q', '--detach'], path)
    writeFileSync(join(path, 'unique.txt'), 'only on this detached commit\n')
    sh(['add', '-A'], path)
    sh([...IDENTITY, 'commit', '-m', 'unique detached commit'], path)
    const lost = sh(['rev-parse', 'HEAD'], path).trim()
    writeFileSync(join(path, 'work.txt'), 'a separate edit\n')
    sh(['add', '-A'], path)
    sh([...IDENTITY, 'stash'], path)
    sh(['checkout', '-q', 'regatta/heat-x-claude'], path)
    expect(sh(['for-each-ref', '--contains', lost, '--format=%(refname)', 'refs/stash'], repo).trim()).toBe('refs/stash')
    expect((await removeOwnedWorktree(record)).status).toBe('trashed')
    // Popped or dropped, the stash ref is gone either way.
    sh(['stash', 'drop'], repo)
    expect(sh(['for-each-ref', 'refs/stash'], repo).trim()).toBe('')
    gcAll(repo)
    expect(sh(['show', `${lost}:unique.txt`], repo)).toBe('only on this detached commit\n')
  }, 60000)

  it('keeps a commit that was made, then left only as an old value of the HEAD reflog', async () => {
    const { repo, path, record } = await lanePair()
    const unique = sh([...IDENTITY, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'old value only'], path).trim()
    const head = sh(['rev-parse', 'HEAD'], path).trim()
    const gitDir = sh(['rev-parse', '--absolute-git-dir'], path).trim()
    writeFileSync(join(gitDir, 'logs', 'HEAD'), `${unique} ${head} Regatta <regatta@localhost> 1760000000 +0000\tmoving\n`)
    expect(sh(['reflog', 'show', '--format=%H', 'HEAD'], path).trim()).toBe(head)
    expect((await removeOwnedWorktree(record)).status).toBe('trashed')
    gcAll(repo)
    expect(await reachable(repo, unique)).toBe(true)
  }, 60000)

  it('keeps the worktree when the keep commit cannot be made', async () => {
    const { repo, path, record } = await lanePair()
    sh(['update-ref', 'refs/regatta', await headSha(repo)], repo)
    const result = await removeOwnedWorktree(record)
    expect(result.status).toBe('kept')
    expect(result.reason).toContain('copy of its commits could not be made')
    expect(existsSync(path)).toBe(true)
  }, 30000)
})

/** A git that takes its time making keep commits, and says when it has started (so a test can act in that window). */
function slowKeepShim(seconds: number): { bin: string; started: string } {
  const bin = temp('regatta-safety-slowkeep-')
  const started = join(bin, 'started')
  const real = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$*" in *" commit-tree "*) : > ${started}; sleep ${seconds};; esac\nexec ${real} "$@"\n`, { mode: 0o755 })
  return { bin, started }
}

async function untilExists(path: string): Promise<void> {
  for (let i = 0; i < 400 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  if (!existsSync(path)) throw new Error(`${path} never appeared`)
}

describe('keeping takes time, and the user can act meanwhile (round 11)', () => {
  it('keeps the commits that only the reflog of one of the worktree\'s own refs remembers', async () => {
    const { repo, path, record } = await lanePair()
    const a = sh([...IDENTITY, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'A, only in the reflog of a ref of its own'], path).trim()
    const b = sh([...IDENTITY, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'B'], path).trim()
    sh(['update-ref', '--create-reflog', 'refs/worktree/user-saved', a], path)
    sh(['update-ref', 'refs/worktree/user-saved', b], path)
    // Nothing but that ref's own reflog knows A: not HEAD's reflog, not any ref the repository's main folder sees.
    expect(sh(['rev-list', '--all'], repo)).not.toContain(a)
    expect(sh(['rev-parse', 'refs/worktree/user-saved'], path).trim()).toBe(b)
    expect((await removeOwnedWorktree(record)).status).toBe('trashed')
    sh(['reflog', 'expire', '--expire=now', '--all'], repo)
    sh(['gc', '--prune=now', '-q'], repo)
    const keep = sh(['rev-list', 'refs/regatta/discarded/lane'], repo).split('\n')
    expect(keep).toContain(a)
    expect(keep).toContain(b)
  }, 60000)

  it.skipIf(process.platform !== 'darwin')('keeps the branch when its reflog grew while its commits were being kept', async () => {
    const repo = makeRepo()
    const tip = lane(repo, { 'a.txt': 'a\n' }, 'regatta/heat-x-claude')
    const shim = slowKeepShim(1.5)
    const saved = process.env['PATH']
    process.env['PATH'] = `${shim.bin}:${saved}`
    let unique = ''
    try {
      const deleting = deleteOwnedBranch(repo, 'regatta/heat-x-claude', tip)
      await untilExists(shim.started)
      // The user checks the branch out in a worktree of their own, commits, resets it back to the tip, and takes the worktree away.
      const theirs = join(temp('regatta-safety-theirs-'), 'wt')
      sh(['worktree', 'add', theirs, 'regatta/heat-x-claude'], repo)
      writeFileSync(join(theirs, 'unique.txt'), 'made while the keep commit was being made\n')
      sh(['add', '-A'], theirs)
      sh([...IDENTITY, 'commit', '-m', 'unique commit during the keep'], theirs)
      unique = sh(['rev-parse', 'HEAD'], theirs).trim()
      sh(['reset', '-q', '--hard', tip], theirs)
      sh(['checkout', '-q', '--detach'], theirs)
      sh(['worktree', 'remove', theirs], repo)
      const result = await deleting
      expect(result.deleted).toBe(false)
      expect(result.reason).toContain('changed while its commits were being kept')
    } finally {
      process.env['PATH'] = saved
    }
    expect(sh(['rev-parse', 'regatta/heat-x-claude'], repo).trim()).toBe(tip)
    // The next attempt sees the longer reflog, keeps its commits too, and then deletes.
    const again = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', tip)
    expect(again.deleted).toBe(true)
    sh(['reflog', 'expire', '--expire=now', '--all'], repo)
    sh(['gc', '--prune=now', '-q'], repo)
    expect(sh(['rev-list', again.parked!], repo).split('\n')).toContain(unique)
  }, 60000)
})

describe('commitAll', () => {
  it('commits a path the user staged at one version and changed again, so the staged version stays reachable', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), 'version A\n')
    sh(['add', 'a.txt'], repo)
    const blobA = sh(['rev-parse', ':a.txt'], repo).trim()
    writeFileSync(join(repo, 'a.txt'), 'version B\n')
    expect(await commitAll(repo, 'Regatta commit')).toBe(true)
    const reachable = sh(['rev-list', '--objects', 'HEAD'], repo)
    expect(reachable).toContain(blobA)
    expect(sh(['show', 'HEAD:a.txt'], repo)).toBe('version B\n')
    expect(sh(['show', 'HEAD~1:a.txt'], repo)).toBe('version A\n')
    expect(sh(['status', '--porcelain'], repo).trim()).toBe('')
  }, 30000)

  it('does not split a commit when nothing was staged twice', async () => {
    const repo = makeRepo()
    const before = await headSha(repo)
    writeFileSync(join(repo, 'b.txt'), 'new\n')
    expect(await commitAll(repo, 'one commit')).toBe(true)
    expect(sh(['rev-list', '--count', `${before}..HEAD`], repo).trim()).toBe('1')
    expect(await commitAll(repo, 'nothing new')).toBe(false)
  }, 30000)

  it('refuses to finish a merge or a cherry-pick someone left half done', async () => {
    const repo = makeRepo()
    sh(['checkout', '-q', '-b', 'topic', 'main'], repo)
    commit(repo, { 'README.md': '# topic\n' }, 'topic')
    sh(['checkout', '-q', 'main'], repo)
    commit(repo, { 'README.md': '# main\n' }, 'main')
    expect(() => sh([...IDENTITY, 'merge', 'topic'], repo)).toThrow()
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('<<<<<<<')
    const before = await headSha(repo)
    await expect(commitAll(repo, 'Regatta commit')).rejects.toThrow(/merge is in progress in this folder, so nothing was committed/)
    expect(await headSha(repo)).toBe(before)
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('<<<<<<<')
    sh(['merge', '--abort'], repo)

    expect(() => sh([...IDENTITY, 'cherry-pick', 'topic'], repo)).toThrow()
    expect(await operationInProgress(repo)).toBe('cherry-pick')
    await expect(commitAll(repo, 'Regatta commit')).rejects.toThrow(/cherry-pick is in progress/)
    expect(await headSha(repo)).toBe(before)
    sh(['cherry-pick', '--abort'], repo)
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    expect(await commitAll(repo, 'fine now')).toBe(true)
  }, 30000)
})

describe('operations that leave no MERGE_HEAD', () => {
  it('sees a squash merge with an autostash after the conflict was cleared', async () => {
    const { repo, path, record } = await lanePairForOps()
    sh(['checkout', '-q', '-b', 'topic', 'main'], repo)
    commit(repo, { 'README.md': '# topic\n' }, 'topic')
    sh(['checkout', '-q', 'main'], repo)
    // In the lane: README.md changed on its own, and an uncommitted edit of another file.
    writeFileSync(join(path, 'README.md'), '# lane\n')
    sh(['add', '-A'], path)
    sh([...IDENTITY, 'commit', '-m', 'lane readme'], path)
    writeFileSync(join(path, 'work.txt'), 'the edit the autostash keeps\n')
    expect(() => sh([...IDENTITY, 'merge', '--squash', '--autostash', 'topic'], path)).toThrow()
    const gitDir = sh(['rev-parse', '--absolute-git-dir'], path).trim()
    expect(existsSync(join(gitDir, 'MERGE_HEAD'))).toBe(false)
    expect(existsSync(join(gitDir, 'MERGE_AUTOSTASH'))).toBe(true)
    // The conflict is cleared by taking the lane's file: status is empty, the edit sits only in the stash.
    sh(['checkout', 'HEAD', '--', 'README.md'], path)
    expect(sh(['status', '--porcelain'], path).trim()).toBe('')
    expect(await operationInProgress(path)).toContain('autostash')
    const result = await removeOwnedWorktree(record)
    expect(result.status).toBe('trashed')
    expect(existsSync(result.trashPath!)).toBe(true)
  }, 30000)

  it('calls git am by its name', async () => {
    const { repo, path } = await lanePairForOps()
    sh(['checkout', '-q', '-b', 'patch-source', 'main'], repo)
    commit(repo, { 'README.md': '# one\n' }, 'one')
    const patch = join(temp('regatta-safety-patch-'), 'one.patch')
    writeFileSync(patch, sh(['format-patch', '-1', '--stdout'], repo))
    sh(['checkout', '-q', 'main'], repo)
    writeFileSync(join(path, 'README.md'), '# different\n')
    sh(['add', '-A'], path)
    sh([...IDENTITY, 'commit', '-m', 'different'], path)
    expect(() => sh([...IDENTITY, 'am', patch], path)).toThrow()
    expect(await operationInProgress(path)).toBe('am')
    sh(['am', '--abort'], path)
    expect(await operationInProgress(path)).toBeNull()
  }, 30000)
})

/** A plain lane worktree, for the tests that make git leave something half done in it. */
async function lanePairForOps(): Promise<{ repo: string; path: string; record: OwnedWorktree }> {
  const repo = makeRepo()
  writeFileSync(join(repo, 'work.txt'), 'work\n')
  sh(['add', '-A'], repo)
  sh([...IDENTITY, 'commit', '-m', 'add work'], repo)
  const dir = temp('regatta-safety-wt-')
  const path = join(dir, 'lane')
  await addWorktree(repo, path, 'regatta/heat-x-claude', await headSha(repo))
  return { repo, path, record: { root: repo, path, identity: worktreeIdentity(path), dir } }
}

describe('worktree identity across a reboot', () => {
  it('has no device number, and still accepts a record made with one when the rest matches exactly', async () => {
    const repo = makeRepo()
    const dir = temp('regatta-safety-wt-')
    const path = join(dir, 'lane')
    await addWorktree(repo, path, 'regatta/heat-x-claude', await headSha(repo))
    const identity = worktreeIdentity(path)!
    const parts = identity.match(/^(.*)\|i(\d+)\|([\d.e+-]+)$/)
    expect(parts).not.toBeNull()
    const [, gitDir, ino, born] = parts!
    expect(sameWorktree(path, identity)).toBe(true)
    // Records from before: dir|dev:ino|birth, with the device number the volume had then.
    const legacy = `${gitDir}|16777232:${ino}|${born}`
    expect(sameWorktree(path, legacy)).toBe(true)
    expect(sameWorktree(path, `${gitDir}|16777999:${ino}|${born}`)).toBe(true)
    // Anything else that differs is another folder.
    expect(sameWorktree(path, `${gitDir}|16777232:${Number(ino) + 1}|${born}`)).toBe(false)
    expect(sameWorktree(path, `${gitDir}|16777232:${ino}|${Number(born) + 1}`)).toBe(false)
    expect(sameWorktree(path, `${gitDir}-other|16777232:${ino}|${born}`)).toBe(false)
    expect(sameWorktree(path, null)).toBe(false)
    // So a record with another device number still lets the retirement through.
    expect((await removeOwnedWorktree({ root: repo, path, identity: legacy, dir })).status).toBe('trashed')
  }, 30000)
})

describe('worktree identity with relative paths', () => {
  it('reads a gitdir written relative to the worktree', async () => {
    const repo = makeRepo()
    sh(['config', 'worktree.useRelativePaths', 'true'], repo)
    const dir = temp('regatta-safety-wt-')
    const path = join(dir, 'lane')
    await addWorktree(repo, path, 'regatta/heat-x-claude', await headSha(repo))
    expect(readFileSync(join(path, '.git'), 'utf8')).toMatch(/^gitdir: \.\./)
    const identity = worktreeIdentity(path)
    expect(identity).not.toBeNull()
    expect(identity!.startsWith('/')).toBe(true)
    expect((await removeOwnedWorktree({ root: repo, path, identity, dir })).status).toBe('trashed')
  }, 30000)
})

describe('removeOwnedWorktree', () => {
  /** A program that stays in `cwd`, in its own session so a process group kill would not reach it. */
  function sleeper(cwd: string, command = 'exec sleep 120'): ChildProcess {
    const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: 'ignore' })
    child.unref()
    children.push(child)
    return child
  }

  async function stop(child: ChildProcess): Promise<void> {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    process.kill(child.pid!, 'SIGKILL')
    await exited
  }

  it('moves a lane worktree to trash and leaves its branch checked out there', async () => {
    const { repo, path, record } = await lanePair()
    const removed = await removeOwnedWorktree(record)
    expect(removed.status).toBe('trashed')
    expect(removed.reason).toBeNull()
    expect(removed.keepRef).toBe('refs/regatta/discarded/lane')
    expect(removed.trashPath).toBeTruthy()
    // Even a plain lane leaves a keep commit: its HEAD is the first parent.
    expect(sh(['rev-parse', 'refs/regatta/discarded/lane^1'], repo).trim()).toBe(sh(['rev-parse', 'regatta/heat-x-claude'], repo).trim())
    expect(existsSync(path)).toBe(false)
    expect(existsSync(removed.trashPath!)).toBe(true)
    expect(sh(['branch', '--list', 'regatta/heat-x-claude'], repo).trim()).not.toBe('')
    expect(worktreeCount(repo)).toBe(2)
  }, 30000)

  it.skipIf(process.platform !== 'darwin')('finds programs in folders whose names lsof writes with escapes (tab, backslash, newline, control characters)', async () => {
    const parent = temp('regatta-safety-escapes-')
    const names = ['tab\there', 'back\\slash', 'x\\x41y', 'new\nline', 'ctl\u0001x', 'caret^Ax', 'cr\rx', 'plain']
    const mine: { folder: string; child: ChildProcess }[] = []
    for (const name of names) {
      const folder = join(parent, name)
      mkdirSync(folder)
      // The deeper folder shows the escapes inside a longer path, too.
      mkdirSync(join(folder, 'deep'))
      mine.push({ folder, child: sleeper(join(folder, 'deep')) })
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    try {
      for (const { folder, child } of mine) {
        const found = await processesInside(folder)
        expect(found.map((p) => p.pid), folder).toEqual([child.pid])
        // A real control character and a literal caret look alike in lsof's output, so those are reported as written.
        if (!/[\u0001^]/.test(folder)) expect(found[0]!.path).toBe(join(realpathSync(folder), 'deep'))
      }
    } finally {
      for (const { child } of mine) await stop(child)
    }
  }, 60000)

  it.skipIf(process.platform !== 'darwin')('counts a name with a backslash sequence it cannot read as busy when it could be inside', async () => {
    const parent = temp('regatta-safety-escapes-')
    const folder = join(parent, 'lane')
    mkdirSync(folder)
    const bin = temp('regatta-safety-lsof-')
    const there = join(realpathSync(folder), 'a\\q-unknown')
    const elsewhere = join(realpathSync(parent), 'other', 'a\\q-unknown')
    writeFileSync(join(bin, 'lsof'), `#!/bin/sh\nprintf 'p11\\nf3\\n'\nprintf 'n%s\\n' '${there}'\nprintf 'p12\\nf3\\n'\nprintf 'n%s\\n' '${elsewhere}'\n`, { mode: 0o755 })
    const saved = process.env['PATH']
    process.env['PATH'] = `${bin}:${saved}`
    try {
      expect((await processesInside(folder)).map((p) => p.pid)).toEqual([11])
    } finally {
      process.env['PATH'] = saved
    }
  }, 30000)

  it('runs git with the file system monitor off: no daemon holds the worktree, and no hook runs', async () => {
    const { repo, path, record } = await lanePair()
    const hook = join(temp('regatta-safety-hook-'), 'hook.sh')
    const marker = `${hook}.ran`
    writeFileSync(hook, `#!/bin/sh\n: > ${marker}\nprintf '/\\0'\n`, { mode: 0o755 })
    try {
      // A hook path first: the user's script must not run under an engine.
      sh(['config', 'core.fsmonitor', hook], repo)
      await headSha(path)
      expect(existsSync(marker)).toBe(false)
      // Then the built-in daemon, which a plain `git status` would start in the worktree.
      sh(['config', 'core.fsmonitor', 'true'], repo)
      const result = await removeOwnedWorktree(record)
      expect(result.reason).toBeNull()
      expect(result.status).toBe('trashed')
    } finally {
      try {
        execFileSync('git', ['-c', 'core.fsmonitor=true', 'fsmonitor--daemon', 'stop'], { cwd: repo, stdio: 'ignore' })
      } catch {
        // None was running, which is the point.
      }
    }
  }, 60000)

  // A fake lsof, first on the PATH, that answers badly in the ways a real one can.
  const badLsof: Record<string, string> = {
    'exits with an error after partial output': "printf 'p1\\nfcwd\\nn/\\n'; exit 1",
    'is killed by a signal': "printf 'p1\\nfcwd\\nn/\\n'; kill -9 $$",
    'is cut off in the middle of a line': "printf 'p1\\nfcwd\\nn/tm'",
    'lists nothing': 'exit 0'
  }
  for (const [what, script] of Object.entries(badLsof)) {
    it.skipIf(process.platform !== 'darwin')(`rejects processesInside when lsof ${what}`, async () => {
      const { path } = await lanePair()
      const bin = temp('regatta-safety-lsof-')
      writeFileSync(join(bin, 'lsof'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
      const saved = process.env['PATH']
      process.env['PATH'] = `${bin}:${saved}`
      try {
        await expect(processesInside(path)).rejects.toThrow()
      } finally {
        process.env['PATH'] = saved
      }
    }, 30000)
  }

  it.skipIf(process.platform !== 'darwin')('treats an lsof that times out or fills its buffer as unknown', async () => {
    const { path } = await lanePair()
    const bin = temp('regatta-safety-lsof-')
    const saved = process.env['PATH']
    try {
      process.env['PATH'] = `${bin}:${saved}`
      writeFileSync(join(bin, 'lsof'), '#!/bin/sh\nprintf "p1\\nfcwd\\nn/\\n"\nexec sleep 5\n', { mode: 0o755 })
      await expect(processesInside(path, false, { timeoutMs: 300 })).rejects.toThrow(/did not finish cleanly/)
      writeFileSync(join(bin, 'lsof'), '#!/bin/sh\nyes "p1" | head -c 100000\n', { mode: 0o755 })
      await expect(processesInside(path, false, { maxBytes: 1000 })).rejects.toThrow(/did not finish cleanly/)
    } finally {
      process.env['PATH'] = saved
    }
  }, 30000)

  it.skipIf(process.platform !== 'darwin')('finds a program in a folder with non-ASCII letters when the process has no UTF-8 locale', async () => {
    const parent = temp('regatta-safety-utf8-')
    const folder = join(parent, 'lan\u00e9')
    mkdirSync(folder)
    const saved = { LC_ALL: process.env['LC_ALL'], LANG: process.env['LANG'], LC_CTYPE: process.env['LC_CTYPE'] }
    process.env['LC_ALL'] = 'C'
    delete process.env['LANG']
    delete process.env['LC_CTYPE']
    const child = sleeper(folder)
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect((await processesInside(folder)).map((p) => p.pid)).toContain(child.pid)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await stop(child)
    }
  }, 30000)

  it.skipIf(process.platform !== 'darwin')('reads the \\x escapes lsof uses for bytes it will not print', async () => {
    const parent = temp('regatta-safety-utf8-')
    const folder = join(parent, 'lan\u00e9')
    mkdirSync(folder)
    const bin = temp('regatta-safety-lsof-')
    const escaped = join(realpathSync(parent), 'lan\\xc3\\xa9', 'deep.txt')
    writeFileSync(join(bin, 'lsof'), `#!/bin/sh\nprintf 'p4242\\nf3\\n'\nprintf 'n%s\\n' '${escaped}'\n`, { mode: 0o755 })
    const saved = process.env['PATH']
    process.env['PATH'] = `${bin}:${saved}`
    try {
      expect(await processesInside(folder)).toEqual([{ pid: 4242, path: join(realpathSync(folder), 'deep.txt'), kind: 'file' }])
    } finally {
      process.env['PATH'] = saved
    }
  }, 30000)

  it('never prunes the repository: an unrelated, renamed worktree keeps its registration and reflog', async () => {
    const { repo, dir, path, record } = await lanePair()
    const users = join(dir, 'users')
    sh(['worktree', 'add', '-b', 'users-branch', users, 'main'], repo)
    const renamed = join(dir, 'users-renamed')
    execFileSync('/bin/mv', [users, renamed])
    const registration = join(repo, '.git', 'worktrees', 'users')
    expect(existsSync(join(registration, 'logs', 'HEAD'))).toBe(true)

    expect((await removeOwnedWorktree(record)).status).toBe('trashed')
    expect(existsSync(registration)).toBe(true)
    expect(existsSync(join(registration, 'logs', 'HEAD'))).toBe(true)

    // A lane folder that vanished is reported gone, and nothing is pruned for it either.
    const second = join(dir, 'lane2')
    await addWorktree(repo, second, 'regatta/heat-x-codex', await headSha(repo))
    const secondRecord: OwnedWorktree = { root: repo, path: second, identity: worktreeIdentity(second), dir }
    rmSync(second, { recursive: true, force: true })
    expect((await removeOwnedWorktree(secondRecord)).status).toBe('gone')
    expect(existsSync(registration)).toBe(true)
    expect(existsSync(path)).toBe(false)
  }, 30000)

  it('leaves alone a different worktree that now sits at the path', async () => {
    const { repo, path, record } = await lanePair()
    sh(['worktree', 'remove', '--force', path], repo)
    sh(['worktree', 'add', '-b', 'users-branch', path, 'main'], repo)
    writeFileSync(join(path, 'MINE.txt'), 'mine\n')
    expect((await removeOwnedWorktree(record)).status).toBe('foreign')
    expect(readFileSync(join(path, 'MINE.txt'), 'utf8')).toBe('mine\n')
  }, 30000)

  it('keeps what it cannot prove is its own, or that is outside its folder', async () => {
    const { path, record } = await lanePair()
    expect((await removeOwnedWorktree({ ...record, identity: null })).status).toBe('kept')
    expect((await removeOwnedWorktree({ ...record, dir: temp('regatta-safety-elsewhere-') })).status).toBe('kept')
    expect((await removeOwnedWorktree({ ...record, dir: path })).status).toBe('kept')
    expect(existsSync(path)).toBe(true)
  }, 30000)

  it('forces a temporary worktree away, but only once it is confirmed to be the one made', async () => {
    const repo = makeRepo()
    const dir = temp('regatta-safety-wt-')
    const path = join(dir, 'check')
    await addDetachedWorktree(repo, path, await headSha(repo))
    const record: OwnedWorktree = { root: repo, path, identity: worktreeIdentity(path), dir, disposable: true }
    writeFileSync(join(path, 'output.txt'), 'whatever a check wrote\n')
    expect((await removeOwnedWorktree({ ...record, identity: null })).status).toBe('kept')
    expect((await removeOwnedWorktree(record)).status).toBe('removed')
    expect(existsSync(path)).toBe(false)
  }, 30000)
})

describe('captureTarget', () => {
  it('records the branch and commit', async () => {
    const repo = makeRepo()
    const target: CapturedTarget = await captureTarget(repo)
    expect(target).toEqual({ branch: 'main', head: await headSha(repo) })
  })
})

describe('per-worktree pseudo refs and annotated tags (V4 findings 1 and 3)', () => {
  function gcAll(repo: string): void {
    sh(['reflog', 'expire', '--expire=now', '--all'], repo)
    sh(['gc', '--prune=now', '-q'], repo)
  }
  function kept(repo: string, ref: string): string[] {
    return sh(['rev-list', ref], repo).split('\n')
  }

  it('keeps a commit that only the lane\'s ORIG_HEAD remembers, and the restore hint reaches it', async () => {
    const { repo, path, record } = await lanePair()
    sh(['checkout', '-q', '--detach'], path)
    writeFileSync(join(path, 'detached.txt'), 'only ORIG_HEAD knows this\n')
    sh(['add', '-A'], path)
    sh([...IDENTITY, 'commit', '-m', 'detached work'], path)
    const lost = sh(['rev-parse', 'HEAD'], path).trim()
    sh(['reset', '-q', '--hard', 'HEAD~1'], path)
    sh(['reflog', 'expire', '--expire=now', '--all'], path)
    const gitDir = sh(['rev-parse', '--absolute-git-dir'], path).trim()
    expect(readFileSync(join(gitDir, 'ORIG_HEAD'), 'utf8').trim()).toBe(lost)
    expect(sh(['status', '--porcelain'], path).trim()).toBe('')
    const result = await removeOwnedWorktree(record)
    expect(result.status).toBe('trashed')
    expect(result.keepRef).toBeTruthy()
    gcAll(repo)
    expect(kept(repo, result.keepRef!)).toContain(lost)
    expect(sh(['show', `${lost}:detached.txt`], repo)).toBe('only ORIG_HEAD knows this\n')
  }, 60000)

  it('keeps a commit that only the lane\'s FETCH_HEAD holds after a plain fetch', async () => {
    const { repo, path, record } = await lanePair()
    const other = makeRepo()
    const fetched = commit(other, { 'other.txt': 'from another repository\n' }, 'only in another repository')
    sh(['fetch', '-q', other, 'main'], path)
    const gitDir = sh(['rev-parse', '--absolute-git-dir'], path).trim()
    expect(readFileSync(join(gitDir, 'FETCH_HEAD'), 'utf8')).toContain(fetched)
    expect(sh(['rev-list', '--all'], repo)).not.toContain(fetched)
    expect(sh(['status', '--porcelain'], path).trim()).toBe('')
    const result = await removeOwnedWorktree(record)
    expect(result.status).toBe('trashed')
    gcAll(repo)
    expect(kept(repo, result.keepRef!)).toContain(fetched)
    expect(sh(['show', `${fetched}:other.txt`], repo)).toBe('from another repository\n')
  }, 60000)

  it('keeps every entry of a FETCH_HEAD with several lines', async () => {
    const { repo, path, record } = await lanePair()
    const other = makeRepo()
    const first = commit(other, { 'one.txt': '1\n' }, 'one')
    sh(['branch', 'side', first], other)
    const second = commit(other, { 'two.txt': '2\n' }, 'two')
    sh(['fetch', '-q', other, 'main', 'side'], path)
    const result = await removeOwnedWorktree(record)
    expect(result.status).toBe('trashed')
    gcAll(repo)
    expect(kept(repo, result.keepRef!)).toEqual(expect.arrayContaining([first, second]))
  }, 60000)

  it('keeps the worktree when a pseudo ref cannot be read', async () => {
    const { path, record } = await lanePair()
    const gitDir = sh(['rev-parse', '--absolute-git-dir'], path).trim()
    const file = join(gitDir, 'ORIG_HEAD')
    writeFileSync(file, `${sh(['rev-parse', 'HEAD'], path).trim()}\n`)
    chmodSync(file, 0o000)
    try {
      if (process.getuid?.() === 0) return
      const result = await removeOwnedWorktree(record)
      expect(result.status).toBe('kept')
      expect(existsSync(path)).toBe(true)
    } finally {
      chmodSync(file, 0o644)
    }
  }, 60000)

  it('keeps a commit that only an annotated tag held, when a private ref pointed at that tag', async () => {
    const { repo, path, record } = await lanePair()
    const lone = sh([...IDENTITY, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'only an annotated tag reaches this'], path).trim()
    sh([...IDENTITY, 'tag', '-a', '-m', 'snapshot', 'public-snapshot', lone], repo)
    const tagObject = sh(['rev-parse', 'public-snapshot'], repo).trim()
    expect(tagObject).not.toBe(lone)
    sh(['update-ref', 'refs/worktree/saved', tagObject], path)
    sh(['tag', '-d', 'public-snapshot'], repo)
    sh(['reflog', 'expire', '--expire=now', '--all'], repo)
    expect(sh(['rev-list', '--all'], repo)).not.toContain(lone)
    expect(sh(['status', '--porcelain'], path).trim()).toBe('')
    const result = await removeOwnedWorktree(record)
    expect(result.status).toBe('trashed')
    gcAll(repo)
    expect(kept(repo, result.keepRef!)).toContain(lone)
    expect(sh(['cat-file', '-t', lone], repo).trim()).toBe('commit')
  }, 60000)

  it('keepCommits peels tags of tags to their commit and drops tags of trees, trees and blobs', async () => {
    const repo = makeRepo()
    const tip = await headSha(repo)
    const other = commit(repo, { 'x.txt': 'x\n' }, 'second')
    sh(['reset', '-q', '--hard', tip], repo)
    sh([...IDENTITY, 'tag', '-a', '-m', 'one', 'inner', other], repo)
    sh([...IDENTITY, '-c', 'advice.nestedTag=false', 'tag', '-a', '-m', 'two', 'outer', 'inner'], repo)
    sh([...IDENTITY, 'tag', '-a', '-m', 'tree', 'treetag', `${tip}^{tree}`], repo)
    const outer = sh(['rev-parse', 'outer'], repo).trim()
    const treeTag = sh(['rev-parse', 'treetag'], repo).trim()
    const tree = sh(['rev-parse', `${tip}^{tree}`], repo).trim()
    const blob = sh(['rev-parse', `${tip}:README.md`], repo).trim()
    const ref = await keepCommits(repo, [tip, outer, treeTag, tree, blob, '0'.repeat(39) + '1'], 'peeled', 'peel test')
    expect(sh(['rev-list', '--parents', '-n', '1', ref], repo).trim().split(' ').slice(1)).toEqual([tip, other])
  }, 60000)
})

describe('git routing variables in the app environment (V4 finding 2)', () => {
  const NAMES = ['GIT_WORK_TREE', 'GIT_DIR', 'GIT_INDEX_FILE']
  async function laneWithIgnoredNotes(): Promise<{ repo: string; path: string; record: OwnedWorktree }> {
    const repo = makeRepo()
    commit(repo, { '.gitignore': 'local/\n' }, 'ignore local')
    const dir = temp('regatta-safety-wt-')
    const path = join(dir, 'lane')
    await addWorktree(repo, path, 'regatta/heat-x-claude', await headSha(repo))
    mkdirSync(join(path, 'local'))
    writeFileSync(join(path, 'local', 'notes.txt'), 'uncommitted notes\n')
    return { repo, path, record: { root: repo, path, identity: worktreeIdentity(path), dir } }
  }
  function value(name: string, repo: string): string {
    return name === 'GIT_WORK_TREE' ? repo : name === 'GIT_DIR' ? join(repo, '.git') : join(repo, '.git', 'index')
  }

  for (const name of NAMES) {
    it(`trashes a lane and preserves its ignored notes file when ${name} points at the project`, async () => {
      const { repo, record } = await laneWithIgnoredNotes()
      const saved = process.env[name]
      process.env[name] = value(name, repo)
      let trashPath = ''
      try {
        const result = await removeOwnedWorktree(record)
        expect(result.status).toBe('trashed')
        trashPath = result.trashPath!
      } finally {
        if (saved === undefined) delete process.env[name]
        else process.env[name] = saved
      }
      expect(readFileSync(join(trashPath, 'local', 'notes.txt'), 'utf8')).toBe('uncommitted notes\n')
    }, 60000)
  }
})

describe('preservation and removal never run user hooks, while merge and worktree creation still do (V6 finding 1)', () => {
  function withIsolatedGitConfig<T>(gitconfigPath: string, fn: () => Promise<T>): Promise<T> {
    const savedGlobal = process.env['GIT_CONFIG_GLOBAL']
    const savedNoSystem = process.env['GIT_CONFIG_NOSYSTEM']
    process.env['GIT_CONFIG_GLOBAL'] = gitconfigPath
    process.env['GIT_CONFIG_NOSYSTEM'] = '1'
    return fn().finally(() => {
      if (savedGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL']
      else process.env['GIT_CONFIG_GLOBAL'] = savedGlobal
      if (savedNoSystem === undefined) delete process.env['GIT_CONFIG_NOSYSTEM']
      else process.env['GIT_CONFIG_NOSYSTEM'] = savedNoSystem
    })
  }

  function installBlockingHooks(hooksDir: string, markerDir: string): {
    postIndexMarker: string
    refTxMarker: string
    release: string
  } {
    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(markerDir, { recursive: true })
    const postIndexMarker = join(markerDir, 'post-index-change-ran')
    const refTxMarker = join(markerDir, 'reference-transaction-ran')
    const release = join(markerDir, 'hook-release')
    const body = (marker: string): string =>
      `#!/bin/sh\n: > '${marker}'\ni=0\nwhile [ ! -e '${release}' ] && [ $i -lt 30 ]; do sleep 0.05; i=$((i+1)); done\nexit 0\n`
    writeFileSync(join(hooksDir, 'post-index-change'), body(postIndexMarker), { mode: 0o755 })
    writeFileSync(join(hooksDir, 'reference-transaction'), body(refTxMarker), { mode: 0o755 })
    return { postIndexMarker, refTxMarker, release }
  }

  it('never runs post-index-change or reference-transaction hooks during removeOwnedWorktree or deleteOwnedBranch', async () => {
    for (const scope of ['local', 'global'] as const) {
      const { repo, path, record } = await lanePair()
      const box = temp(`regatta-safety-v6-hooks-${scope}-`)
      const globalHooks = join(box, 'global-hooks')
      const gitconfig = join(box, 'gitconfig')
      writeFileSync(
        gitconfig,
        scope === 'global'
          ? `[user]\n\tname = Regatta Test\n\temail = test@regatta.local\n[core]\n\thooksPath = ${globalHooks}\n`
          : `[user]\n\tname = Regatta Test\n\temail = test@regatta.local\n`
      )

      const markers = installBlockingHooks(
        scope === 'global' ? globalHooks : join(repo, '.git', 'hooks'),
        join(box, 'markers')
      )

      // Make a tracked file stat-dirty (same content, newer mtime).
      const future = new Date(Date.now() + 10_000)
      utimesSync(join(path, 'work.txt'), future, future)

      const branchTipSha = await headSha(path)
      const sandbox = join(box, 'regatta-empty-hooks')
      setGitOpsHooksSandbox(sandbox)
      try {
        await withIsolatedGitConfig(gitconfig, async () => {
          const removed = await removeOwnedWorktree(record)
          expect(removed.status, scope).toBe('trashed')
          expect(removed.keepRef, scope).toBe('refs/regatta/discarded/lane')
          expect(existsSync(path), scope).toBe(false)

          // Remove the trashed worktree registration before testing deleteOwnedBranch. Trashed worktrees are
          // locked so git's own prune keeps them (safety.md mechanism 2): unlock first, as Empty trash's own deletion would.
          sh(['-c', `core.hooksPath=${sandbox}`, 'worktree', 'unlock', removed.trashPath!], repo)
          rmSync(removed.trashPath!, { recursive: true, force: true })
          sh(['-c', `core.hooksPath=${sandbox}`, 'worktree', 'prune'], repo)

          const deleted = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', branchTipSha)
          expect(deleted.deleted, scope).toBe(true)
          expect(deleted.parked, scope).toBeTruthy()

          // Neither hook ever ran or wrote its marker, and removal finished before `release` was written.
          expect(existsSync(markers.postIndexMarker), scope).toBe(false)
          expect(existsSync(markers.refTxMarker), scope).toBe(false)
        })
      } finally {
        writeFileSync(markers.release, '')
        setGitOpsHooksSandbox(temp('regatta-safety-default-hooks-'))
      }
    }
  }, 60000)

  it('refuses removeOwnedWorktree and deleteOwnedBranch if the hooks sandbox folder is not empty', async () => {
    const { repo, path, record } = await lanePair()
    const tip = await headSha(path)
    const polluted = temp('regatta-safety-polluted-hooks-')
    writeFileSync(join(polluted, 'post-index-change'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    setGitOpsHooksSandbox(polluted)
    try {
      const removal = await removeOwnedWorktree(record)
      expect(removal.status).toBe('kept')
      expect(removal.reason).toContain('hooks folder is not empty')
      expect(existsSync(path)).toBe(true)

      const branchResult = await deleteOwnedBranch(repo, 'regatta/heat-x-claude', tip)
      expect(branchResult.deleted).toBe(false)
      expect(branchResult.reason).toContain('hooks folder is not empty')
    } finally {
      setGitOpsHooksSandbox(temp('regatta-safety-clean-hooks-'))
    }
  }, 30000)

  it('still runs post-checkout on addWorktree and addDetachedWorktree, and post-merge on mergeIntoCurrentBranch', async () => {
    const repo = makeRepo()
    const box = temp('regatta-safety-v6-allowed-')
    const gitconfig = join(box, 'gitconfig')
    writeFileSync(gitconfig, '[user]\n\tname = Regatta Test\n\temail = test@regatta.local\n')

    const checkoutMarker = join(box, 'post-checkout-ran')
    const mergeMarker = join(box, 'post-merge-ran')
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    writeFileSync(
      join(repo, '.git', 'hooks', 'post-checkout'),
      `#!/bin/sh\necho "$1 $2 $3" >> '${checkoutMarker}'\n`,
      { mode: 0o755 }
    )
    writeFileSync(
      join(repo, '.git', 'hooks', 'post-merge'),
      `#!/bin/sh\necho "$1" >> '${mergeMarker}'\n`,
      { mode: 0o755 }
    )

    await withIsolatedGitConfig(gitconfig, async () => {
      const base = await headSha(repo)
      const wtDir = temp('regatta-safety-wt-')
      const branchWt = join(wtDir, 'branch-wt')
      const detachedWt = join(wtDir, 'detached-wt')

      await addWorktree(repo, branchWt, 'regatta/heat-hook-check', base)
      expect(existsSync(checkoutMarker)).toBe(true)
      const countAfterBranch = readFileSync(checkoutMarker, 'utf8').trim().split('\n').length
      expect(countAfterBranch).toBe(1)

      await addDetachedWorktree(repo, detachedWt, base)
      const countAfterDetached = readFileSync(checkoutMarker, 'utf8').trim().split('\n').length
      expect(countAfterDetached).toBe(2)

      // Clean up those two worktrees before testing mergeIntoCurrentBranch.
      expect((await removeOwnedWorktree({ root: repo, path: branchWt, identity: worktreeIdentity(branchWt), dir: wtDir })).status).toBe('trashed')
      expect((await removeOwnedWorktree({ root: repo, path: detachedWt, identity: worktreeIdentity(detachedWt), dir: wtDir, disposable: true })).status).toBe('removed')

      const tip = lane(repo, { 'MERGED.txt': 'merged\n' }, 'regatta/merge-hook-branch')
      const captured = await captureTarget(repo)
      const outcome = await mergeIntoCurrentBranch(repo, tip, 'Merge with hook', captured)
      expect(outcome.head).toBe(tip)
      expect(existsSync(mergeMarker)).toBe(true)
    })
  }, 60000)

  it('never runs clean or process filters during diffFrom, commitAll, or removeOwnedWorktree', async () => {
    for (const kind of ['clean', 'process'] as const) {
      const { repo, path, record } = await lanePair()
      const box = temp(`regatta-safety-v7-filter-${kind}-`)
      const cleanMarker = join(box, 'clean-ran')
      const procMarker = join(box, 'process-ran')
      const extDiffMarker = join(box, 'ext-diff-ran')
      const hookCmdMarker = join(box, 'hook-cmd-ran')
      const release = join(box, 'release')
      const cleanScript = join(box, 'clean.sh')
      const procScript = join(box, 'process.sh')
      const extDiffScript = join(box, 'extdiff.sh')
      const hookCmdScript = join(box, 'hookcmd.sh')

      writeFileSync(
        cleanScript,
        `#!/bin/sh\n: > '${cleanMarker}'\ni=0\nwhile [ ! -e '${release}' ] && [ $i -lt 30 ]; do sleep 0.05; i=$((i+1)); done\ncat\n`,
        { mode: 0o755 }
      )
      writeFileSync(
        procScript,
        `#!/bin/sh\n: > '${procMarker}'\ni=0\nwhile [ ! -e '${release}' ] && [ $i -lt 30 ]; do sleep 0.05; i=$((i+1)); done\nexit 1\n`,
        { mode: 0o755 }
      )
      writeFileSync(extDiffScript, `#!/bin/sh\n: > '${extDiffMarker}'\nexit 0\n`, { mode: 0o755 })
      writeFileSync(hookCmdScript, `#!/bin/sh\n: > '${hookCmdMarker}'\nexit 0\n`, { mode: 0o755 })

      // Commit .gitattributes so tracked files use the filter driver; in the LFS case, the index holds a pointer while disk holds smudged content.
      writeFileSync(join(path, '.gitattributes'), `work.txt filter=lfs diff=ext\n`)
      writeFileSync(join(path, 'work.txt'), 'version https://git-lfs.github.com/spec/v1\nsize 14\n')
      sh(['add', '.gitattributes', 'work.txt'], path)
      sh([...IDENTITY, 'commit', '-m', 'add filter attributes'], path)
      // On disk the working tree holds the smudged file content, with its stat cache matching the index.
      writeFileSync(join(path, 'work.txt'), 'the lane work\n')
      const future = new Date(Date.now() + 10_000)
      utimesSync(join(path, 'work.txt'), future, future)

      const gitconfig = join(box, 'gitconfig')
      writeFileSync(
        gitconfig,
        `[user]\n\tname = Regatta Test\n\temail = test@regatta.local\n` +
          `[filter "lfs"]\n` +
          (kind === 'clean'
            ? `\tclean = ${cleanScript}\n\tsmudge = ${cleanScript}\n\trequired = true\n`
            : `\tprocess = ${procScript}\n\trequired = true\n`) +
          `[diff]\n\texternal = ${extDiffScript}\n` +
          `[diff "ext"]\n\tcommand = ${extDiffScript}\n\ttextconv = ${extDiffScript}\n` +
          `[hook "spy"]\n\tcommand = ${hookCmdScript}\n\tevent = post-index-change\n\tevent = pre-commit\n\tevent = reference-transaction\n`
      )

      try {
        await withIsolatedGitConfig(gitconfig, async () => {
          const base = await headSha(repo)
          await diffFrom(path, base)

          // In a clean-filter repository commitAll refuses (it would commit content the filter would have changed),
          // and finding that out runs no filter, external diff or config hook (safety.md mechanism 8).
          writeFileSync(join(path, 'extra.txt'), 'saved without filters\n')
          await expect(commitAll(path, 'preserve lane'), kind).rejects.toThrow(/clean|process|filter/i)

          const removed = await removeOwnedWorktree(record)
          expect(removed.status, kind).toBe('trashed')
          expect(existsSync(removed.trashPath!), kind).toBe(true)

          expect(existsSync(cleanMarker), kind).toBe(false)
          expect(existsSync(procMarker), kind).toBe(false)
          expect(existsSync(extDiffMarker), kind).toBe(false)
          expect(existsSync(hookCmdMarker), kind).toBe(false)
        })
      } finally {
        writeFileSync(release, '')
      }
    }
  }, 60000)

  it('never runs a post-index-change hook during commitAll or diffFrom, and leaves ignored drafts and .git/index intact on diffFrom', async () => {
    for (const scope of ['local', 'global'] as const) {
      const { repo, path } = await lanePair()
      const box = temp(`regatta-safety-v8-index-hook-${scope}-`)
      const globalHooks = join(box, 'global-hooks')
      const gitconfig = join(box, 'gitconfig')
      writeFileSync(
        gitconfig,
        scope === 'global'
          ? `[user]\n\tname = Regatta Test\n\temail = test@regatta.local\n[core]\n\thooksPath = ${globalHooks}\n`
          : `[user]\n\tname = Regatta Test\n\temail = test@regatta.local\n`
      )

      const hooksDir = scope === 'global' ? globalHooks : join(repo, '.git', 'hooks')
      mkdirSync(hooksDir, { recursive: true })
      const marker = join(box, 'post-index-change-ran')
      const draftPath = join(path, 'draft.ignored')
      writeFileSync(join(path, '.gitignore'), '*.ignored\n')
      writeFileSync(draftPath, 'precious ignored draft\n')
      writeFileSync(
        join(hooksDir, 'post-index-change'),
        `#!/bin/sh\n: > '${marker}'\nrm -f '${draftPath}'\nexit 0\n`,
        { mode: 0o755 }
      )

      await withIsolatedGitConfig(gitconfig, async () => {
        const base = await headSha(repo)
        writeFileSync(join(path, 'new-lane-file.txt'), 'line 1\nline 2\n')

        // diffFrom measures untracked files using a scratch index without touching the worktree's own index or firing post-index-change.
        const stat = await diffFrom(path, base)
        expect(stat.files, scope).toBeGreaterThanOrEqual(2)
        expect(existsSync(marker), scope).toBe(false)
        expect(readFileSync(draftPath, 'utf8'), scope).toBe('precious ignored draft\n')
        // The untracked file was NOT added as intent-to-add in the worktree's real index.
        expect(sh(['ls-files', '--', 'new-lane-file.txt'], path).trim(), scope).toBe('')

        // commitAll stages and commits with the empty hooksPath so post-index-change never runs there either.
        expect(await commitAll(path, 'save lane work'), scope).toBe(true)
        expect(existsSync(marker), scope).toBe(false)
        expect(readFileSync(draftPath, 'utf8'), scope).toBe('precious ignored draft\n')
      })
    }
  }, 60000)

  it('detects and preserves a worktree after a same-size edit with restored mtime even when core.trustctime=false and core.checkStat=minimal', async () => {
    for (const scope of ['local', 'global'] as const) {
      const { repo, path } = await lanePair()
      const box = temp(`regatta-safety-v8-stat-${scope}-`)
      const gitconfig = join(box, 'gitconfig')
      writeFileSync(
        gitconfig,
        scope === 'global'
          ? `[user]\n\tname = Regatta Test\n\temail = test@regatta.local\n[core]\n\ttrustctime = false\n\tcheckStat = minimal\n`
          : `[user]\n\tname = Regatta Test\n\temail = test@regatta.local\n`
      )
      if (scope === 'local') {
        sh(['config', 'core.trustctime', 'false'], repo)
        sh(['config', 'core.checkStat', 'minimal'], repo)
      }

      // Set work.txt mtime in the past and refresh the index so the entry is not racy in git's normal stat cache.
      const file = join(path, 'work.txt')
      const past = new Date(Date.now() - 60_000)
      utimesSync(file, past, past)
      sh(['update-index', '--refresh'], path)
      const before = lstatSync(file)

      // Edit work.txt to a same-size string ('the lane work\n' -> 'NEW LANE WORK\n', 14 bytes) and restore mtime.
      writeFileSync(file, 'NEW LANE WORK\n')
      utimesSync(file, before.atime, before.mtime)

      await withIsolatedGitConfig(gitconfig, async () => {
        // Plain git under this config reports nothing changed, proving the test exercises the weakened stat cache.
        expect(sh(['status', '--porcelain'], path), scope).toBe('')

        expect(await dirtyTracked(path), scope).toBe(true)
        expect(await hasChanges(path), scope).toBe(true)

        // Preservation (commitAll) also refreshes against content and commits the same-size edit.
        expect(await commitAll(path, 'preserve same-size edit'), scope).toBe(true)
        expect(sh(['show', 'HEAD:work.txt'], path), scope).toBe('NEW LANE WORK\n')
      })
    }
  }, 60000)
})



