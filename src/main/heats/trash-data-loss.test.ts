// Regression tests for the three ways Empty trash lost a user's work (audit 2026-10-26, finding w-regatta-01,
// and the 2026-10-25 trash-4 review, finding 1). Each test asserts only that the work survives, never the
// wording of the result, so the same file runs against older code and shows the loss there.
// Temp folders are made under the real path of the temp folder: behind a symlink (/var on macOS) git and
// Regatta spell the same folder two ways and the loss does not fire, which would make these tests pass for
// the wrong reason.

import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { addWorktree, commitAll, emptyTrash, setGitOpsHooksSandbox, trashOwnedWorktree, worktreeIdentity } from './git-ops'
import type { OwnedWorktree } from './git-ops'
import { withRepoLock } from './repo-lock'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']
const REAL_TMP = realpathSync(tmpdir())

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
}

/** Like sh, but a failing git command gives its message instead of throwing, so a test can assert on it. */
function trySh(args: string[], cwd: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: sh(args, cwd) }
  } catch (err) {
    return { ok: false, out: String((err as { stderr?: string }).stderr ?? err) }
  }
}

const dirs: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(REAL_TMP, prefix))
  dirs.push(dir)
  return dir
}

const sandbox = mkdtempSync(join(REAL_TMP, 'regatta-loss-hooks-'))
chmodSync(sandbox, 0o755)
dirs.push(sandbox)
setGitOpsHooksSandbox(sandbox)

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function commitIn(dir: string, file: string, text: string): string {
  writeFileSync(join(dir, file), text)
  sh(['add', file], dir)
  sh([...IDENTITY, 'commit', '-q', '-m', `add ${file}`], dir)
  return sh(['rev-parse', 'HEAD'], dir).trim()
}

function branchThere(repo: string, branch: string): boolean {
  return sh(['branch', '--list', branch], repo).includes(branch)
}

async function makeLane(name: string): Promise<{ repo: string; worktreesDir: string; path: string; branch: string; record: OwnedWorktree }> {
  const repo = temp('regatta-loss-repo-')
  sh(['init', '-q', '-b', 'main'], repo)
  writeFileSync(join(repo, 'README.md'), '# project\n')
  sh(['add', '.'], repo)
  sh([...IDENTITY, 'commit', '-q', '-m', 'initial commit'], repo)
  const worktreesDir = temp('regatta-loss-wts-')
  const path = join(worktreesDir, name)
  const branch = `regatta/${name}`
  await addWorktree(repo, path, branch, 'main')
  const identity = worktreeIdentity(path)
  expect(identity).not.toBeNull()
  return { repo, worktreesDir, path, branch, record: { root: repo, path, branch, identity, dir: worktreesDir, keepAs: name } }
}

/** The restored copy still works as a git worktree: its branch, its staged file and its draft are all there. */
function expectCopyStillWorks(copy: string, repo: string, branch: string): void {
  const head = trySh(['rev-parse', '--abbrev-ref', 'HEAD'], copy)
  expect(head.out.trim()).toBe(branch)
  expect(trySh(['diff', '--cached', '--name-only'], copy).out).toContain('staged-only.txt')
  expect(branchThere(repo, branch)).toBe(true)
}

describe('Empty trash never loses work (audit 2026-10-26 w-regatta-01, trash-4 review finding 1)', { timeout: 60000 }, () => {
  it('path 1: a commit an agent made inside a submodule initialised in the lane still exists after Empty trash', async () => {
    const base = temp('regatta-loss-sm-')
    const sub = join(base, 'sub')
    mkdirSync(sub)
    sh(['init', '-q', '-b', 'main'], sub)
    commitIn(sub, 'lib.txt', 'lib\n')
    const repo = join(base, 'main')
    mkdirSync(repo)
    sh(['init', '-q', '-b', 'main'], repo)
    writeFileSync(join(repo, 'README.md'), '# p\n')
    sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm'], repo)
    sh(['add', '-A'], repo)
    sh([...IDENTITY, 'commit', '-q', '-m', 'main with submodule'], repo)
    const worktreesDir = temp('regatta-loss-sm-wts-')
    const path = join(worktreesDir, 'sublane')
    const branch = 'regatta/sublane'
    await addWorktree(repo, path, branch, 'main')
    const record: OwnedWorktree = { root: repo, path, branch, identity: worktreeIdentity(path), dir: worktreesDir, keepAs: 'sublane' }
    const gitDir = record.identity!.split('|')[0]!
    sh(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'], path)
    // The agent commits inside the submodule; Regatta commits the lane, whose tree now points at that commit.
    const subCommit = commitIn(join(path, 'sm'), 'agent.txt', 'agent work in the submodule\n')
    await commitAll(path, 'lane work')
    const moduleGitDir = join(gitDir, 'modules', 'sm')
    // Read the submodule's repository with a work tree that is not the lane folder, which Empty trash deletes.
    const held = (): boolean => trySh(['--git-dir', moduleGitDir, '--work-tree', base, 'cat-file', '-e', `${subCommit}^{commit}`], repo).ok
    expect(held()).toBe(true)
    // The commit lives only in the lane's git folder: the submodule's source repository never had it.
    expect(trySh(['cat-file', '-e', `${subCommit}^{commit}`], sub).ok).toBe(false)

    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    await emptyTrash(worktreesDir, withRepoLock)

    expect(held()).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)
  })

  it('path 2: a lane copied back to its original path and repaired keeps its git folder, staged work and branch', async () => {
    const { repo, worktreesDir, path, branch, record } = await makeLane('copy-back')
    const gitDir = record.identity!.split('|')[0]!
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    // The user copies the lane out of the trash to where it was and re-attaches it, then keeps working.
    cpSync(res.trashPath!, path, { recursive: true })
    sh(['worktree', 'repair', path], repo)
    sh(['worktree', 'unlock', path], repo)
    writeFileSync(join(path, 'staged-only.txt'), 'precious staged work\n')
    sh(['add', 'staged-only.txt'], path)
    rmSync(join(path, 'staged-only.txt'))
    expectCopyStillWorks(path, repo, branch)

    // Then cleans up the old copy that is still in the trash.
    await emptyTrash(worktreesDir, withRepoLock)

    expect(existsSync(gitDir)).toBe(true)
    expectCopyStillWorks(path, repo, branch)
    expect(trySh(['show', ':staged-only.txt'], path).out).toBe('precious staged work\n')
  })

  it('path 3: a lane copied back to its original path, repaired, then renamed keeps its git folder, staged work and branch', async () => {
    const { repo, worktreesDir, path, branch, record } = await makeLane('copy-back-renamed')
    const gitDir = record.identity!.split('|')[0]!
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    cpSync(res.trashPath!, path, { recursive: true })
    sh(['worktree', 'repair', path], repo)
    writeFileSync(join(path, 'staged-only.txt'), 'precious staged work\n')
    sh(['add', 'staged-only.txt'], path)
    writeFileSync(join(path, 'staged-only.txt'), 'a later edit, not staged\n')
    // The user renames the copy (git keeps working in it), so nothing is at the original path while Empty trash runs.
    const away = `${path}-old`
    renameSync(path, away)

    await emptyTrash(worktreesDir, withRepoLock)
    renameSync(away, path)

    expect(existsSync(gitDir)).toBe(true)
    expectCopyStillWorks(path, repo, branch)
    expect(trySh(['show', ':staged-only.txt'], path).out).toBe('precious staged work\n')
  })
})
