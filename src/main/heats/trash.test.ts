// Unit tests for moving lane worktrees to Regatta's trash and emptying trash in Settings > Storage.
// Package: trash .

import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// Hooks on rmSync and openSync, so a test can make something happen at the exact moment Empty trash deletes a
// path or writes a file, and on renameSync and rmdirSync (`other`) so a crash sweep can stop at any step. They pass
// every call through untouched unless a test sets `rmHook.fire`, `rmHook.open` or `rmHook.other`.
const rmHook = vi.hoisted(() => ({
  fire: null as null | ((path: string) => void),
  open: null as null | ((path: string, flags: unknown) => void),
  other: null as null | ((op: 'rename' | 'rmdir', path: string) => void)
}))
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      rmHook.other?.('rename', String(from))
      return actual.renameSync(from, to)
    },
    rmdirSync: (path: Parameters<typeof actual.rmdirSync>[0], opts?: Parameters<typeof actual.rmdirSync>[1]) => {
      rmHook.other?.('rmdir', String(path))
      return actual.rmdirSync(path, opts)
    },
    openSync: (path: Parameters<typeof actual.openSync>[0], flags?: Parameters<typeof actual.openSync>[1], mode?: Parameters<typeof actual.openSync>[2]) => {
      rmHook.open?.(String(path), flags)
      return actual.openSync(path, flags ?? 'r', mode)
    },
    rmSync: (path: string, opts?: Parameters<typeof actual.rmSync>[1]) => {
      rmHook.fire?.(String(path))
      return actual.rmSync(path, opts)
    }
  }
})
import {
  addDetachedWorktree,
  addWorktree,
  commitAll,
  emptyTrash,
  listTrash,
  LOST_ENTRY_RECORD,
  provideModules,
  repairTrashedWorktree,
  setGitOpsHooksSandbox,
  TRASH_DIR_NAME,
  TRASH_LOCK_REASON,
  trashOwnedWorktree,
  worktreeIdentity
} from './git-ops'
import type { OwnedWorktree, TrashEntryMeta } from './git-ops'
import { withRepoLock } from './repo-lock'
import { emptyStorageTrash, removeWorktrees } from '../storage'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
}

const dirs: string[] = []
const children: ChildProcess[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const sandbox = mkdtempSync(join(tmpdir(), 'regatta-trash-hooks-'))
chmodSync(sandbox, 0o755)
dirs.push(sandbox)
setGitOpsHooksSandbox(sandbox)

afterAll(() => {
  for (const child of children) {
    try {
      process.kill(child.pid!, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // Best effort before cleanup.
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeRepo(): string {
  const dir = temp('regatta-trash-repo-')
  sh(['init', '-b', 'main'], dir)
  sh(['config', 'user.name', 'Regatta Test'], dir)
  sh(['config', 'user.email', 'test@regatta.local'], dir)
  mkdirSync(join(dir, 'tracked-dir'), { recursive: true })
  writeFileSync(join(dir, 'tracked-dir', 'item.txt'), 'tracked item\n')
  writeFileSync(join(dir, '.gitignore'), 'ignored.log\n')
  writeFileSync(join(dir, 'README.md'), '# project\n')
  sh(['add', '.'], dir)
  sh([...IDENTITY, 'commit', '-m', 'initial commit'], dir)
  return dir
}

async function makeLane(name = 'lane-a'): Promise<{
  repo: string
  worktreesDir: string
  path: string
  branch: string
  record: OwnedWorktree
}> {
  const repo = makeRepo()
  const worktreesDir = temp('regatta-trash-wts-')
  const path = join(worktreesDir, name)
  const branch = `regatta/${name}`
  await addWorktree(repo, path, branch, 'main')
  const identity = worktreeIdentity(path)
  expect(identity).not.toBeNull()
  return {
    repo,
    worktreesDir,
    path,
    branch,
    record: {
      root: repo,
      path,
      branch,
      identity,
      dir: worktreesDir,
      keepAs: name
    }
  }
}

function trySetXattr(target: string, attr: string, value: string): boolean {
  try {
    if (process.platform === 'darwin') {
      execFileSync('xattr', ['-w', attr, value, target], { stdio: 'ignore' })
      return true
    }
    execFileSync('setfattr', ['-n', attr, '-v', value, target], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function readXattr(target: string, attr: string): string {
  if (process.platform === 'darwin') {
    return execFileSync('xattr', ['-p', attr, target], { encoding: 'utf8' }).trim()
  }
  return execFileSync('getfattr', ['--only-values', '-n', attr, target], { encoding: 'utf8' }).trim()
}

/**
 * Empty trash deletes one file at a time (never entering another volume): the worktree folder after renaming it to
 * `<entry>/.regatta-deleting`, then the entry's own `entry.json`. True when `p` is `dir` or inside it.
 */
function inside(p: string, dir: string): boolean {
  return p === dir || p.startsWith(`${dir}/`)
}

describe('trashOwnedWorktree, listTrash and emptyTrash', { timeout: 20000 }, () => {
  it('preserves untracked files, ignored files, permissions, xattrs, nested repositories, and inodes across the move', async () => {
    const { path, record } = await makeLane('survive-lane')

    const untracked = join(path, 'untracked.txt')
    writeFileSync(untracked, 'untracked work\n')

    const ignored = join(path, 'ignored.log')
    writeFileSync(ignored, 'ignored output\n')

    const trackedDir = join(path, 'tracked-dir')
    chmodSync(trackedDir, 0o700)

    const emptyDir = join(path, 'empty-notes')
    mkdirSync(emptyDir)
    const dirHasXattr = trySetXattr(emptyDir, 'user.note', 'folder-xattr-value')

    const secretFile = join(path, 'secret.txt')
    writeFileSync(secretFile, 'mode 0600 content\n')
    chmodSync(secretFile, 0o600)
    const fileHasXattr = trySetXattr(secretFile, 'user.note', 'file-xattr-value')

    const nestedRepo = join(path, 'vendor', 'nested')
    mkdirSync(nestedRepo, { recursive: true })
    sh(['init', '-b', 'main'], nestedRepo)
    writeFileSync(join(nestedRepo, 'inner.txt'), 'nested repo file\n')
    sh(['add', 'inner.txt'], nestedRepo)
    sh([...IDENTITY, 'commit', '-m', 'nested commit'], nestedRepo)
    const nestedHead = sh(['rev-parse', 'HEAD'], nestedRepo).trim()

    const inodesBefore = {
      root: lstatSync(path).ino,
      untracked: lstatSync(untracked).ino,
      ignored: lstatSync(ignored).ino,
      trackedDir: lstatSync(trackedDir).ino,
      emptyDir: lstatSync(emptyDir).ino,
      secretFile: lstatSync(secretFile).ino,
      nestedRepo: lstatSync(nestedRepo).ino
    }

    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    expect(res.trashPath).toBeTruthy()
    expect(res.keepRef).toBe('refs/regatta/discarded/survive-lane')
    expect(existsSync(path)).toBe(false)

    const trashed = res.trashPath!
    expect(existsSync(trashed)).toBe(true)
    expect(readFileSync(join(trashed, 'untracked.txt'), 'utf8')).toBe('untracked work\n')
    expect(readFileSync(join(trashed, 'ignored.log'), 'utf8')).toBe('ignored output\n')
    expect(lstatSync(join(trashed, 'tracked-dir')).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(trashed, 'empty-notes')).isDirectory()).toBe(true)
    expect(readFileSync(join(trashed, 'secret.txt'), 'utf8')).toBe('mode 0600 content\n')
    expect(lstatSync(join(trashed, 'secret.txt')).mode & 0o777).toBe(0o600)
    if (dirHasXattr) {
      expect(readXattr(join(trashed, 'empty-notes'), 'user.note')).toBe('folder-xattr-value')
    }
    if (fileHasXattr) {
      expect(readXattr(join(trashed, 'secret.txt'), 'user.note')).toBe('file-xattr-value')
    }
    expect(sh(['rev-parse', 'HEAD'], join(trashed, 'vendor', 'nested')).trim()).toBe(nestedHead)

    expect(lstatSync(trashed).ino).toBe(inodesBefore.root)
    expect(lstatSync(join(trashed, 'untracked.txt')).ino).toBe(inodesBefore.untracked)
    expect(lstatSync(join(trashed, 'ignored.log')).ino).toBe(inodesBefore.ignored)
    expect(lstatSync(join(trashed, 'tracked-dir')).ino).toBe(inodesBefore.trackedDir)
    expect(lstatSync(join(trashed, 'empty-notes')).ino).toBe(inodesBefore.emptyDir)
    expect(lstatSync(join(trashed, 'secret.txt')).ino).toBe(inodesBefore.secretFile)
    expect(lstatSync(join(trashed, 'vendor', 'nested')).ino).toBe(inodesBefore.nestedRepo)
  })

  it('keeps open append descriptors and running child processes attached to the trashed folder', async () => {
    const { path, record } = await makeLane('live-fd-lane')
    const logPath = join(path, 'append.log')
    writeFileSync(logPath, 'before-move\n')
    const fd = openSync(logPath, 'a')

    const readyFile = join(path, 'child-ready')
    const goFile = join(path, 'child-go')
    const childScript = [
      'const fs = require("node:fs");',
      'fs.writeFileSync("child-ready", "ready");',
      'const timer = setInterval(() => {',
      '  if (fs.existsSync("child-go")) {',
      '    fs.writeFileSync("created-after-trash.txt", "from-child\\n");',
      '    clearInterval(timer);',
      '    process.exit(0);',
      '  }',
      '}, 20);'
    ].join(' ')

    const child = spawn(process.execPath, ['-e', childScript], { cwd: path, stdio: 'ignore' })
    children.push(child)

    while (!existsSync(readyFile)) {
      await new Promise((r) => setTimeout(r, 15))
    }

    let res: Awaited<ReturnType<typeof trashOwnedWorktree>>
    try {
      res = await trashOwnedWorktree(record)
      expect(res.status).toBe('trashed')
      const trashed = res.trashPath!

      writeSync(fd, 'after-move\n')
      fsyncSync(fd)

      const trashedLog = join(trashed, 'append.log')
      expect(readFileSync(trashedLog, 'utf8')).toBe('before-move\nafter-move\n')
      expect(lstatSync(trashedLog).nlink).toBe(1)

      // Signal the child inside the moved folder and wait for it to write relative to its cwd.
      writeFileSync(join(trashed, 'child-go'), 'go')
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('child did not exit in time')), 5000)
        child.once('exit', (code) => {
          clearTimeout(timeout)
          expect(code).toBe(0)
          resolve()
        })
      })

      expect(readFileSync(join(trashed, 'created-after-trash.txt'), 'utf8')).toBe('from-child\n')
    } finally {
      try {
        closeSync(fd)
      } catch {
        // Already closed.
      }
    }
  })

  it('repairs git pointers so git worktree list shows trashPath and locked, branch -D refuses, and git status works inside trashPath', async () => {
    const { repo, path, branch, record } = await makeLane('repaired-lane')
    writeFileSync(join(path, 'dirty.txt'), 'uncommitted\n')

    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const trashed = res.trashPath!

    const listed = sh(['worktree', 'list', '--porcelain'], repo)
    expect(listed).toContain(`worktree ${realpathSync(trashed)}`)
    expect(listed).toContain(`locked ${TRASH_LOCK_REASON}`)

    expect(() => sh(['branch', '-D', branch], repo)).toThrow()

    const statusOut = sh(['status', '--porcelain'], trashed)
    expect(statusOut).toContain('?? dirty.txt')
  })

  it('keeps the worktree in place with no entry left behind and leaves the worktree unlocked when .regatta-trash is a symlink or renameSync fails', async () => {
    const { repo, worktreesDir, path, record } = await makeLane('symlink-trash-lane')
    const gitDir = record.identity!.split('|')[0]!
    const outside = temp('regatta-trash-outside-')
    const trashLink = join(worktreesDir, TRASH_DIR_NAME)
    symlinkSync(outside, trashLink)

    const symlinkRes = await trashOwnedWorktree(record)
    expect(symlinkRes.status).toBe('kept')
    expect(symlinkRes.reason).toContain('is not a folder')
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(outside)).toEqual([])

    unlinkSync(trashLink)

    // Make the parent worktreesDir read-only after creating .regatta-trash so renameSync(target, trashPath) fails with EACCES.
    const realWts = realpathSync(worktreesDir)
    const trashDir = join(realWts, TRASH_DIR_NAME)
    mkdirSync(trashDir, { mode: 0o700 })
    chmodSync(realWts, 0o500)
    try {
      const renameFailRes = await trashOwnedWorktree(record)
      expect(renameFailRes.status).toBe('kept')
      expect(existsSync(path)).toBe(true)
      expect(readdirSync(trashDir)).toEqual([])
      expect(existsSync(join(gitDir, 'locked'))).toBe(false)
      expect(sh(['worktree', 'list', '--porcelain'], repo)).not.toContain('locked')
    } finally {
      chmodSync(realWts, 0o700)
    }
  })

  it('keeps an unrepaired entry git folder across git worktree prune --expire=now and git gc --prune=now because of the pre-move lock', async () => {
    const { repo, worktreesDir, path, branch, record } = await makeLane('unrepaired-prune-lane')
    const gitDir = record.identity!.split('|')[0]!

    // Stage work in the worktree so its git folder index has staged content.
    writeFileSync(join(path, 'staged.txt'), 'staged content\n')
    sh(['add', 'staged.txt'], path)

    // Simulate locking before rename, then renaming without running repair (crash right after rename).
    sh(['worktree', 'lock', '--reason', TRASH_LOCK_REASON, path], repo)
    const realWts = realpathSync(worktreesDir)
    const trashDir = join(realWts, TRASH_DIR_NAME)
    mkdirSync(trashDir, { mode: 0o700 })
    const entryDir = mkdtempSync(join(trashDir, 'unrepaired-prune-lane-'))
    const trashPath = join(entryDir, basename(path))
    const meta: TrashEntryMeta = {
      version: 1,
      originalPath: realpathSync(path),
      root: realpathSync(repo),
      branch,
      identity: record.identity!,
      keepRef: 'refs/regatta/discarded/unrepaired-prune-lane',
      movedAt: new Date().toISOString(),
      repaired: false
    }
    writeFileSync(join(entryDir, 'entry.json'), JSON.stringify(meta, null, 2), { mode: 0o600 })
    renameSync(realpathSync(path), trashPath)

    // With the entry left unrepaired at its new path, prune --expire=now and gc --prune=now must keep its git folder.
    sh(['worktree', 'prune', '--expire=now'], repo)
    sh(['gc', '--prune=now', '-q'], repo)
    expect(existsSync(gitDir)).toBe(true)
    expect(existsSync(join(gitDir, 'index'))).toBe(true)
    expect(existsSync(join(gitDir, 'HEAD'))).toBe(true)
    expect(existsSync(join(gitDir, 'logs', 'HEAD'))).toBe(true)

    // And listTrash subsequently repairs it so git status sees the staged work intact.
    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.repaired).toBe(true)
    expect(sh(['status', '--porcelain'], trashPath)).toContain('A  staged.txt')
  })

  it('treats a worktree already locked with "In Regatta\'s trash" as locked, and keeps a worktree locked for any other reason', async () => {
    const { repo, path, record } = await makeLane('lock-reason-lane')

    // Locked with another reason -> kept in place with the reason, and stays locked.
    sh(['worktree', 'lock', '--reason', 'pinned on external drive', path], repo)
    const keptRes = await trashOwnedWorktree(record)
    expect(keptRes.status).toBe('kept')
    expect(keptRes.reason).toContain('pinned on external drive')
    expect(existsSync(path)).toBe(true)
    expect(sh(['worktree', 'list', '--porcelain'], repo)).toContain('locked pinned on external drive')

    // Unlock and lock with exactly "In Regatta's trash" -> counts as locked and moves to trash.
    sh(['worktree', 'unlock', path], repo)
    sh(['worktree', 'lock', '--reason', TRASH_LOCK_REASON, path], repo)
    const trashedRes = await trashOwnedWorktree(record)
    expect(trashedRes.status).toBe('trashed')
    expect(existsSync(path)).toBe(false)
    expect(existsSync(trashedRes.trashPath!)).toBe(true)
    expect(sh(['worktree', 'list', '--porcelain'], repo)).toContain(`locked ${TRASH_LOCK_REASON}`)
  })

  it('trashes, repairs and empties a worktree made with git worktree add --relative-paths', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-trash-relpaths-wts-')
    const path = join(worktreesDir, 'rel-lane')
    const branch = 'regatta/rel-lane'
    sh(['worktree', 'add', '--relative-paths', '-b', branch, path, 'main'], repo)

    const dotGitBefore = readFileSync(join(path, '.git'), 'utf8').trim()
    expect(dotGitBefore).toMatch(/^gitdir:\s*\.\.\//)

    const identity = worktreeIdentity(path)
    expect(identity).not.toBeNull()
    const gitDir = identity!.split('|')[0]!

    const res = await trashOwnedWorktree({
      root: repo,
      path,
      branch,
      identity,
      dir: worktreesDir,
      keepAs: 'rel-lane'
    })
    expect(res.status).toBe('trashed')
    expect(existsSync(path)).toBe(false)
    expect(existsSync(res.trashPath!)).toBe(true)

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.repaired).toBe(true)
    expect(sh(['worktree', 'list', '--porcelain'], repo)).toContain(`worktree ${realpathSync(res.trashPath!)}`)

    const { outcomes } = await emptyTrash(worktreesDir)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('deleted')
    expect(outcomes[0]!.branchDeleted).toBe(true)
    expect(existsSync(res.trashPath!)).toBe(false)
    expect(existsSync(gitDir)).toBe(false)
    expect(sh(['branch', '--list', branch], repo).trim()).toBe('')
  })

  it('deletes the git folder of a repaired entry at Empty trash and keeps one whose gitdir names somewhere else', async () => {
    const { repo, worktreesDir, record: recordA } = await makeLane('gitdir-match-a')
    const pathB = join(worktreesDir, 'gitdir-mismatch-b')
    const branchB = 'regatta/gitdir-mismatch-b'
    await addWorktree(repo, pathB, branchB, 'main')
    const recordB: OwnedWorktree = {
      root: repo,
      path: pathB,
      branch: branchB,
      identity: worktreeIdentity(pathB),
      dir: worktreesDir,
      keepAs: 'gitdir-mismatch-b'
    }

    const pathC = join(worktreesDir, 'gitdir-folder-only-c')
    const branchC = 'regatta/gitdir-folder-only-c'
    await addWorktree(repo, pathC, branchC, 'main')
    const recordC: OwnedWorktree = {
      root: repo,
      path: pathC,
      branch: branchC,
      identity: worktreeIdentity(pathC),
      dir: worktreesDir,
      keepAs: 'gitdir-folder-only-c'
    }

    const gitDirA = recordA.identity!.split('|')[0]!
    const gitDirB = recordB.identity!.split('|')[0]!
    const gitDirC = recordC.identity!.split('|')[0]!

    const trashedA = await trashOwnedWorktree(recordA)
    const trashedB = await trashOwnedWorktree(recordB)
    const trashedC = await trashOwnedWorktree(recordC)
    expect(trashedA.status).toBe('trashed')
    expect(trashedB.status).toBe('trashed')
    expect(trashedC.status).toBe('trashed')

    // Point B's gitdir file at a path outside the entry where nothing exists right now (a copy the user re-attached
    // there, renamed away or on an unmounted volume: left alone entirely, fix round 1 F3), and C's gitdir file at the
    // folder inside the entry without /.git.
    const otherTarget = join(temp('regatta-trash-other-gitdir-'), 'gone', '.git')
    writeFileSync(join(gitDirB, 'gitdir'), `${otherTarget}\n`)
    writeFileSync(join(gitDirC, 'gitdir'), `${realpathSync(trashedC.trashPath!)}\n`)

    const { outcomes } = await emptyTrash(worktreesDir)
    const byBranch = new Map(outcomes.map((o) => [o.branch, o]))
    expect(byBranch.get(recordA.branch!)?.status).toBe('deleted')
    expect(byBranch.get(branchB)?.status).toBe('skipped')
    expect(byBranch.get(branchB)?.reason ?? '').toContain('re-attached elsewhere, left alone')
    expect(byBranch.get(branchC)?.status).toBe('deleted')

    // Repaired entry A's git folder is deleted; B is left alone, folder and all; C keeps its git folder because
    // gitdir did not match <folder>/.git.
    expect(existsSync(gitDirA)).toBe(false)
    expect(existsSync(gitDirB)).toBe(true)
    expect(existsSync(trashedB.trashPath!)).toBe(true)
    expect(readFileSync(join(gitDirB, 'gitdir'), 'utf8')).toBe(`${otherTarget}\n`)
    expect(existsSync(gitDirC)).toBe(true)
  })

  it('lists and empties an entry with a corrupt or missing entry.json using repository and branch from git', async () => {
    const { repo, worktreesDir, path, branch, record } = await makeLane('corrupt-meta-lane')
    writeFileSync(join(path, 'work.txt'), 'saved before corrupting entry.json\n')
    sh(['add', 'work.txt'], path)
    sh([...IDENTITY, 'commit', '-m', 'commit in corrupt-meta-lane'], path)
    const laneCommit = sh(['rev-parse', 'HEAD'], path).trim()
    const gitDir = record.identity!.split('|')[0]!

    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const entryDir = dirname(res.trashPath!)

    // Corrupt entry.json on disk.
    writeFileSync(join(entryDir, 'entry.json'), '{not valid json', { mode: 0o600 })

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.repairError).toBe(LOST_ENTRY_RECORD)
    expect(listed[0]!.note).toBe(LOST_ENTRY_RECORD)
    expect(listed[0]!.root).toBe(realpathSync(repo))
    expect(listed[0]!.branch).toBe(branch)

    const { outcomes } = await emptyTrash(worktreesDir)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('deleted')
    expect(outcomes[0]!.branchDeleted).toBe(true)
    expect(existsSync(res.trashPath!)).toBe(false)
    expect(existsSync(entryDir)).toBe(false)
    expect(existsSync(gitDir)).toBe(false)
    expect(sh(['branch', '--list', branch], repo).trim()).toBe('')
    expect(sh(['rev-list', 'refs/regatta/discarded/corrupt-meta-lane'], repo)).toContain(laneCommit)
  })

  it.skipIf(process.platform !== 'darwin')('skips the provided node_modules copy when checking changedSinceMoved', async () => {
    const { repo, worktreesDir, path, record } = await makeLane('modules-skip-lane')
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')

    const provided = await provideModules(repo, path)
    expect(provided.clone).not.toBeNull()

    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const trashed = res.trashPath!

    // Touching a file inside the provided node_modules copy after trashing does not count as changedSinceMoved.
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(join(trashed, 'node_modules', 'pkg', 'index.js'), 'module.exports = 2\n')

    const listedAfterModulesEdit = await listTrash(worktreesDir)
    expect(listedAfterModulesEdit).toHaveLength(1)
    expect(listedAfterModulesEdit[0]!.changedSinceMoved).toBe('no')

    // Touching a user file outside node_modules flags changedSinceMoved === 'yes'.
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(join(trashed, 'user-note.txt'), 'edited in trash\n')

    const listedAfterUserEdit = await listTrash(worktreesDir)
    expect(listedAfterUserEdit).toHaveLength(1)
    expect(listedAfterUserEdit[0]!.changedSinceMoved).toBe('yes')
  })

  it('handles .git that does not name the identity, repairs un-repaired entries in listTrash, and cleans up entry.json-only folders', async () => {
    const { repo, worktreesDir, path, branch, record } = await makeLane('repair-recovery-lane')
    const realWts = realpathSync(worktreesDir)
    const trashDir = join(realWts, TRASH_DIR_NAME)
    mkdirSync(trashDir, { mode: 0o700 })

    // 1. Entry with only entry.json (simulated crash before renameSync) is removed by listTrash.
    const orphanEntry = mkdtempSync(join(trashDir, 'orphan-'))
    writeFileSync(
      join(orphanEntry, 'entry.json'),
      JSON.stringify({
        version: 1,
        originalPath: join(realWts, 'orphan'),
        root: repo,
        branch: 'regatta/orphan',
        identity: record.identity,
        keepRef: 'refs/regatta/discarded/orphan',
        movedAt: new Date().toISOString(),
        repaired: false
      }),
      { mode: 0o600 }
    )
    expect(await listTrash(worktreesDir)).toEqual([])
    expect(existsSync(orphanEntry)).toBe(false)

    // 2. Simulate a moved worktree where .git is not a regular file naming its identity -> repaired: false.
    const entryDir = mkdtempSync(join(trashDir, 'repair-recovery-lane-'))
    const trashPath = join(entryDir, basename(path))
    const realOriginal = realpathSync(path)
    const meta: TrashEntryMeta = {
      version: 1,
      originalPath: realOriginal,
      root: realpathSync(repo),
      branch,
      identity: record.identity!,
      keepRef: 'refs/regatta/discarded/repair-recovery-lane',
      movedAt: new Date().toISOString(),
      repaired: false
    }
    writeFileSync(join(entryDir, 'entry.json'), JSON.stringify(meta, null, 2), { mode: 0o600 })
    renameSync(realOriginal, trashPath)

    const dotGitPath = join(trashPath, '.git')
    const savedDotGit = readFileSync(dotGitPath, 'utf8')
    writeFileSync(dotGitPath, 'gitdir: /nonexistent/other/worktree\n')

    const badRepair = await repairTrashedWorktree(entryDir, meta)
    expect(badRepair.repaired).toBe(false)
    expect(badRepair.repairError).toBeTruthy()
    expect(existsSync(trashPath)).toBe(true)

    const listedUnrepaired = await listTrash(worktreesDir)
    expect(listedUnrepaired).toHaveLength(1)
    expect(listedUnrepaired[0]!.repaired).toBe(false)

    // 3. Restore the valid .git file (simulating a crash right after rename before repair completed) -> listTrash repairs it.
    writeFileSync(dotGitPath, savedDotGit)
    const listedRepaired = await listTrash(worktreesDir)
    expect(listedRepaired).toHaveLength(1)
    expect(listedRepaired[0]!.repaired).toBe(true)
    expect(sh(['worktree', 'list', '--porcelain'], repo)).toContain(`worktree ${realpathSync(trashPath)}`)

    // 4. End-to-end trashOwnedWorktree when .git is a symlink (not a regular file): moved, repaired: false.
    const { worktreesDir: wts2, path: path2, record: record2 } = await makeLane('symlink-dotgit-lane')
    const pointerTarget = join(temp('regatta-trash-dotgit-target-'), 'gitdir-file')
    writeFileSync(pointerTarget, readFileSync(join(path2, '.git'), 'utf8'))
    unlinkSync(join(path2, '.git'))
    symlinkSync(pointerTarget, join(path2, '.git'))

    const symDotGitRes = await trashOwnedWorktree(record2)
    expect(symDotGitRes.status).toBe('trashed')
    expect(existsSync(path2)).toBe(false)
    expect(existsSync(symDotGitRes.trashPath!)).toBe(true)
    const listedSym = await listTrash(wts2)
    expect(listedSym).toHaveLength(1)
    expect(listedSym[0]!.repaired).toBe(false)
  })

  it('still removes temporary (disposable: true) worktrees with git worktree remove --force', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-trash-disposable-')
    const tempPath = join(worktreesDir, 'check-temp')
    await addDetachedWorktree(repo, tempPath, 'main')
    writeFileSync(join(tempPath, 'scratch.txt'), 'disposable work\n')
    const identity = worktreeIdentity(tempPath)

    const res = await trashOwnedWorktree({
      root: repo,
      path: tempPath,
      identity,
      dir: worktreesDir,
      disposable: true
    })
    expect(res.status).toBe('removed')
    expect(existsSync(tempPath)).toBe(false)
    expect(existsSync(join(worktreesDir, TRASH_DIR_NAME))).toBe(false)
  })

  it('empties trashed worktrees, parks post-move commits, skips entries in use, and preserves unrelated missing worktrees', async () => {
    const { repo, worktreesDir, path: pathA, branch: branchA, record: recordA } = await makeLane('empty-lane-a')

    // Second lane in the same repo and worktreesDir that will have a child process inside when emptying.
    const pathB = join(worktreesDir, 'empty-lane-b')
    const branchB = 'regatta/empty-lane-b'
    await addWorktree(repo, pathB, branchB, 'main')
    const recordB: OwnedWorktree = {
      root: repo,
      path: pathB,
      branch: branchB,
      identity: worktreeIdentity(pathB),
      dir: worktreesDir,
      keepAs: 'empty-lane-b'
    }

    // Unrelated worktree whose working folder is missing on disk; its git admin folder must survive emptyTrash.
    const unrelatedDir = temp('regatta-trash-unrelated-')
    const pathUnrelated = join(unrelatedDir, 'unrelated-wt')
    await addWorktree(repo, pathUnrelated, 'regatta/unrelated-wt', 'main')
    const unrelatedIdentity = worktreeIdentity(pathUnrelated)!
    const unrelatedGitDir = unrelatedIdentity.split('|')[0]!
    rmSync(pathUnrelated, { recursive: true, force: true })
    expect(existsSync(unrelatedGitDir)).toBe(true)

    // Commit in lane A before trashing.
    writeFileSync(join(pathA, 'before-trash.txt'), 'commit before trash\n')
    sh(['add', 'before-trash.txt'], pathA)
    sh([...IDENTITY, 'commit', '-m', 'lane-a commit before trash'], pathA)

    const gitDirA = recordA.identity!.split('|')[0]!
    const trashedA = await trashOwnedWorktree(recordA)
    expect(trashedA.status).toBe('trashed')

    // Make a new commit inside lane A's trashed folder AFTER it was moved to trash.
    writeFileSync(join(trashedA.trashPath!, 'after-trash.txt'), 'commit after trash\n')
    sh(['add', 'after-trash.txt'], trashedA.trashPath!)
    sh([...IDENTITY, 'commit', '-m', 'lane-a commit after trash'], trashedA.trashPath!)
    const postTrashSha = sh(['rev-parse', 'HEAD'], trashedA.trashPath!).trim()

    // Trash lane B and start a child process with cwd inside its trashed folder.
    const trashedB = await trashOwnedWorktree(recordB)
    expect(trashedB.status).toBe('trashed')
    const readyB = join(trashedB.trashPath!, 'busy-ready')
    const busyChild = spawn(
      process.execPath,
      ['-e', 'require("node:fs").writeFileSync("busy-ready", "1"); setInterval(() => {}, 1000)'],
      { cwd: trashedB.trashPath!, stdio: 'ignore' }
    )
    children.push(busyChild)
    while (!existsSync(readyB)) {
      await new Promise((r) => setTimeout(r, 15))
    }

    try {
      const { outcomes } = await emptyTrash(worktreesDir)
      const outcomeA = outcomes.find((o) => o.branch === branchA)
      const outcomeB = outcomes.find((o) => o.branch === branchB)

      expect(outcomeA?.status).toBe('deleted')
      expect(existsSync(trashedA.trashPath!)).toBe(false)
      expect(existsSync(dirname(trashedA.trashPath!))).toBe(false)
      expect(existsSync(gitDirA)).toBe(false)
      expect(sh(['branch', '--list', branchA], repo).trim()).toBe('')

      // Keep ref has both the pre-trash commit and the post-trash commit made inside trashPath.
      const logOut = sh(['log', '--format=%H %s', 'refs/regatta/discarded/empty-lane-a'], repo)
      expect(logOut).toContain(postTrashSha)
      expect(logOut).toContain('lane-a commit after trash')
      expect(logOut).toContain('lane-a commit before trash')

      // Lane B was skipped because busyChild was inside it.
      expect(outcomeB?.status).toBe('skipped')
      expect(outcomeB?.reason).toContain('in use')
      expect(existsSync(trashedB.trashPath!)).toBe(true)
      expect(sh(['branch', '--list', branchB], repo)).toContain(branchB)

      // The unrelated missing worktree still has its git admin directory.
      expect(existsSync(unrelatedGitDir)).toBe(true)
    } finally {
      try {
        process.kill(busyChild.pid!, 'SIGKILL')
      } catch {
        // Already exited.
      }
    }
  })

  it('refuses to trash a symlink that replaced the worktree path and redirects to a live sibling worktree', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-trash-symlink-victim-')

    const pathA = join(worktreesDir, 'lane-victim')
    const branchA = 'regatta/lane-victim'
    await addWorktree(repo, pathA, branchA, 'main')
    const identityA = worktreeIdentity(pathA)!

    const pathB = join(worktreesDir, 'lane-live')
    const branchB = 'regatta/lane-live'
    await addWorktree(repo, pathB, branchB, 'main')
    writeFileSync(join(pathB, 'live-work.txt'), 'live sibling work\n')

    rmSync(pathA, { recursive: true, force: true })
    symlinkSync(pathB, pathA)

    const res = await trashOwnedWorktree({
      root: repo,
      path: pathA,
      branch: branchA,
      identity: identityA,
      dir: worktreesDir,
      keepAs: 'lane-victim'
    })

    expect(res.status).toBe('kept')
    expect(lstatSync(pathA).isSymbolicLink()).toBe(true)
    expect(existsSync(pathB)).toBe(true)
    expect(readFileSync(join(pathB, 'live-work.txt'), 'utf8')).toBe('live sibling work\n')
    const wtList = sh(['worktree', 'list', '--porcelain'], repo)
    expect(wtList).toContain(`worktree ${realpathSync(pathB)}`)
  })

  it('never ascends to trashDir when entry.json has originalPath ".." and refuses a symlink inside an entry folder', async () => {
    const { repo, worktreesDir, path: path1, record: record1 } = await makeLane('victim-lane')
    const path2 = join(worktreesDir, 'poisoned-lane')
    const branch2 = 'regatta/poisoned-lane'
    await addWorktree(repo, path2, branch2, 'main')
    const record2: OwnedWorktree = {
      root: repo,
      path: path2,
      branch: branch2,
      identity: worktreeIdentity(path2),
      dir: worktreesDir,
      keepAs: 'poisoned-lane'
    }

    const activePath = join(worktreesDir, 'active-lane')
    const activeBranch = 'regatta/active-lane'
    await addWorktree(repo, activePath, activeBranch, 'main')
    const activeReal = realpathSync(activePath)

    const t1 = await trashOwnedWorktree(record1)
    const t2 = await trashOwnedWorktree(record2)
    expect(t1.status).toBe('trashed')
    expect(t2.status).toBe('trashed')

    // Poison entry 2's entry.json with originalPath: ".."
    const entryDir2 = dirname(t2.trashPath!)
    const meta2Path = join(entryDir2, 'entry.json')
    const meta2 = JSON.parse(readFileSync(meta2Path, 'utf8'))
    meta2.originalPath = '..'
    writeFileSync(meta2Path, JSON.stringify(meta2))

    // Replace entry 1's worktree folder with a symlink to activePath
    const entryDir1 = dirname(t1.trashPath!)
    rmSync(t1.trashPath!, { recursive: true, force: true })
    symlinkSync(activePath, join(entryDir1, basename(path1)))

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(2)
    for (const item of listed) {
      expect(item.repaired).toBe(false)
      expect(item.note).toBe('altered, left alone')
    }
    // Active worktree was not hijacked by worktree repair
    expect(sh(['worktree', 'list', '--porcelain'], repo)).toContain(`worktree ${activeReal}`)

    const { outcomes } = await emptyTrash(worktreesDir)
    expect(outcomes).toHaveLength(2)
    for (const o of outcomes) {
      expect(o.status).toBe('skipped')
      expect(o.reason).toBe('altered, left alone')
    }
    expect(existsSync(entryDir1)).toBe(true)
    expect(existsSync(entryDir2)).toBe(true)
    expect(existsSync(activePath)).toBe(true)
  })

  it('derives the repository and git folder from the recorded identity rather than running git inside trashPath', async () => {
    const { repo, worktreesDir, branch, record } = await makeLane('tampered-dotgit-lane')
    const gitDir = record.identity!.split('|')[0]!
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')

    // Replace trashPath/.git file with an unrelated standalone git repository directory
    const dotGit = join(res.trashPath!, '.git')
    unlinkSync(dotGit)
    sh(['init', '-b', 'main'], res.trashPath!)
    sh(['config', 'user.name', 'Regatta Test'], res.trashPath!)
    sh(['config', 'user.email', 'test@regatta.local'], res.trashPath!)
    writeFileSync(join(res.trashPath!, 'fake.txt'), 'fake repo\n')
    sh(['add', 'fake.txt'], res.trashPath!)
    sh([...IDENTITY, 'commit', '-m', 'fake commit'], res.trashPath!)

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.root).toBe(realpathSync(repo))

    const { outcomes } = await emptyTrash(worktreesDir)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('skipped')
    expect(existsSync(res.trashPath!)).toBe(true)
    expect(existsSync(gitDir)).toBe(true)
    expect(sh(['branch', '--list', branch], repo)).toContain(branch)
  })

  it('recovers and empties a trashed worktree whose entry.json was lost before worktree repair (absolute and relative paths)', async () => {
    // 1. Absolute path worktree moved before repairTrashedWorktree ran, with entry.json lost
    const { repo, worktreesDir, path: absPath, branch: absBranch, record: absRecord } = await makeLane('unrepaired-lost-abs')
    writeFileSync(join(absPath, 'abs.txt'), 'abs work\n')
    sh(['add', 'abs.txt'], absPath)
    sh([...IDENTITY, 'commit', '-m', 'abs commit'], absPath)
    const absCommit = sh(['rev-parse', 'HEAD'], absPath).trim()
    const absGitDir = absRecord.identity!.split('|')[0]!

    sh(['worktree', 'lock', '--reason', TRASH_LOCK_REASON, absPath], repo)
    const trashDir = join(realpathSync(worktreesDir), TRASH_DIR_NAME)
    mkdirSync(trashDir, { recursive: true, mode: 0o700 })
    const absEntryDir = mkdtempSync(join(trashDir, 'unrepaired-lost-abs-'))
    const absTrashPath = join(absEntryDir, basename(absPath))
    renameSync(realpathSync(absPath), absTrashPath)

    // 2. Relative-paths worktree moved before repairTrashedWorktree ran, with entry.json lost
    const relPath = join(worktreesDir, 'unrepaired-lost-rel')
    const relBranch = 'regatta/unrepaired-lost-rel'
    sh(['worktree', 'add', '--relative-paths', '-b', relBranch, relPath, 'main'], repo)
    writeFileSync(join(relPath, 'rel.txt'), 'rel work\n')
    sh(['add', 'rel.txt'], relPath)
    sh([...IDENTITY, 'commit', '-m', 'rel commit'], relPath)
    const relCommit = sh(['rev-parse', 'HEAD'], relPath).trim()
    const relGitDir = worktreeIdentity(relPath)!.split('|')[0]!

    sh(['worktree', 'lock', '--reason', TRASH_LOCK_REASON, relPath], repo)
    const relEntryDir = mkdtempSync(join(trashDir, 'unrepaired-lost-rel-'))
    const relTrashPath = join(relEntryDir, basename(relPath))
    renameSync(realpathSync(relPath), relTrashPath)

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(2)
    for (const item of listed) {
      expect(item.note).toBe(LOST_ENTRY_RECORD)
      expect(item.root).toBe(realpathSync(repo))
    }

    const { outcomes } = await emptyTrash(worktreesDir)
    expect(outcomes).toHaveLength(2)
    for (const o of outcomes) {
      expect(o.status).toBe('deleted')
      expect(o.branchDeleted).toBe(true)
    }
    expect(existsSync(absTrashPath)).toBe(false)
    expect(existsSync(absGitDir)).toBe(false)
    expect(existsSync(relTrashPath)).toBe(false)
    expect(existsSync(relGitDir)).toBe(false)
    expect(sh(['rev-list', 'refs/regatta/discarded/unrepaired-lost-abs'], repo)).toContain(absCommit)
    expect(sh(['rev-list', 'refs/regatta/discarded/unrepaired-lost-rel'], repo)).toContain(relCommit)
  })

  it('does not delete a non-regatta branch when entry.json is lost or when retired through storage removeWorktrees', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-trash-user-branch-')
    const wtPath = join(worktreesDir, 'user-feature-wt')
    const userBranch = 'feature/user-work'
    await addWorktree(repo, wtPath, userBranch, 'main')
    writeFileSync(join(wtPath, 'feature.txt'), 'important feature work\n')
    sh(['add', 'feature.txt'], wtPath)
    sh([...IDENTITY, 'commit', '-m', 'feature commit'], wtPath)

    const res = await trashOwnedWorktree({
      root: repo,
      path: wtPath,
      branch: null,
      identity: worktreeIdentity(wtPath),
      dir: worktreesDir,
      keepAs: 'user-feature-wt'
    })
    expect(res.status).toBe('trashed')

    // Simulate lost entry.json so branch is recovered from <gitDir>/HEAD (refs/heads/feature/user-work)
    unlinkSync(join(dirname(res.trashPath!), 'entry.json'))

    const { outcomes } = await emptyTrash(worktreesDir)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('deleted')
    expect(outcomes[0]!.branchDeleted).toBe(false)
    expect(sh(['branch', '--list', userBranch], repo)).toContain(userBranch)

    // Also verify removeWorktrees + emptyStorageTrash on a leftover worktree checked out on a non-regatta branch
    const wtPath2 = join(worktreesDir, 'user-feature-wt-2')
    const userBranch2 = 'feature/storage-user-work'
    await addWorktree(repo, wtPath2, userBranch2, 'main')
    const storageDeps = {
      dataDir: temp('regatta-trash-data-'),
      worktreesDir,
      checkpointsDir: temp('regatta-trash-cp-'),
      accountsDir: temp('regatta-trash-acc-'),
      inUse: () => []
    }
    const afterRemove = await removeWorktrees(storageDeps, [wtPath2])
    expect(afterRemove.trash).toHaveLength(1)
    expect(afterRemove.trash[0]!.branch).toBeNull()

    const emptied = await emptyStorageTrash(storageDeps)
    expect(emptied.outcomes).toHaveLength(1)
    expect(emptied.outcomes[0]!.status).toBe('deleted')
    expect(sh(['branch', '--list', userBranch2], repo)).toContain(userBranch2)
  })

  it('empties a trashed worktree cleanly when trashPath/.git was deleted in trash or by an interrupted emptyTrash', async () => {
    const { repo, worktreesDir, path, branch, record } = await makeLane('missing-dotgit-lane')
    writeFileSync(join(path, 'work.txt'), 'work before missing dotgit\n')
    sh(['add', 'work.txt'], path)
    sh([...IDENTITY, 'commit', '-m', 'commit before missing dotgit'], path)
    const sha = sh(['rev-parse', 'HEAD'], path).trim()
    const gitDir = record.identity!.split('|')[0]!

    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')

    // Make a post-move commit, then delete trashPath/.git (simulating user deleting .git or partial rmSync)
    writeFileSync(join(res.trashPath!, 'post.txt'), 'post move work\n')
    sh(['add', 'post.txt'], res.trashPath!)
    sh([...IDENTITY, 'commit', '-m', 'post move commit'], res.trashPath!)
    const postSha = sh(['rev-parse', 'HEAD'], res.trashPath!).trim()

    unlinkSync(join(res.trashPath!, '.git'))

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.root).toBe(realpathSync(repo))
    expect(listed[0]!.branch).toBe(branch)

    const { outcomes } = await emptyTrash(worktreesDir)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('deleted')
    expect(outcomes[0]!.branchDeleted).toBe(true)
    expect(existsSync(res.trashPath!)).toBe(false)
    expect(existsSync(gitDir)).toBe(false)
    const logOut = sh(['log', '--format=%H', 'refs/regatta/discarded/missing-dotgit-lane'], repo)
    expect(logOut).toContain(sha)
    expect(logOut).toContain(postSha)
  })

  it('preserves both first-parent tips when two trashed lanes share the same folder basename and ignores .DS_Store inside an entry with a lost record', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-trash-reuse-')
    const lanePath = join(worktreesDir, 'reuse-lane')

    // First lane at reuse-lane (default keepAs = basename(lanePath))
    await addWorktree(repo, lanePath, 'regatta/reuse-1', 'main')
    writeFileSync(join(lanePath, 'first.txt'), 'lane 1 unique work\n')
    sh(['add', 'first.txt'], lanePath)
    sh([...IDENTITY, 'commit', '-m', 'lane 1 unique work'], lanePath)
    const sha1 = sh(['rev-parse', 'HEAD'], lanePath).trim()

    const t1 = await trashOwnedWorktree({
      root: repo,
      path: lanePath,
      branch: 'regatta/reuse-1',
      identity: worktreeIdentity(lanePath),
      dir: worktreesDir
    })
    expect(t1.status).toBe('trashed')

    // Second lane at the exact same path (reuse-lane), also default keepAs
    await addWorktree(repo, lanePath, 'regatta/reuse-2', 'main')
    writeFileSync(join(lanePath, 'second.txt'), 'lane 2 unique work\n')
    sh(['add', 'second.txt'], lanePath)
    sh([...IDENTITY, 'commit', '-m', 'lane 2 unique work'], lanePath)
    const sha2 = sh(['rev-parse', 'HEAD'], lanePath).trim()

    const t2 = await trashOwnedWorktree({
      root: repo,
      path: lanePath,
      branch: 'regatta/reuse-2',
      identity: worktreeIdentity(lanePath),
      dir: worktreesDir
    })
    expect(t2.status).toBe('trashed')

    // Finder drops .DS_Store inside entry 2 alongside a corrupted entry.json
    const entryDir2 = dirname(t2.trashPath!)
    writeFileSync(join(entryDir2, '.DS_Store'), 'finder metadata')
    writeFileSync(join(entryDir2, 'entry.json'), '{"version":1,')

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(2)
    for (const item of listed) {
      expect(item.note).not.toBe('altered, left alone')
      expect(item.root).toBe(realpathSync(repo))
    }

    const { outcomes } = await emptyTrash(worktreesDir)
    expect(outcomes).toHaveLength(2)
    expect(outcomes.every((o) => o.status === 'deleted')).toBe(true)

    // Entry 1's keepRef must still have sha1 as its first parent (^1), not overwritten by entry 2
    expect(sh(['rev-parse', `${t1.keepRef!}^1`], repo).trim()).toBe(sha1)
    expect(sh(['rev-parse', `${t2.keepRef!}^1`], repo).trim()).toBe(sha2)
  })

  it('continues emptying other trash entries when one entry points to a deleted repository', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    const worktreesDir = temp('regatta-trash-deadrepo-')

    const pathA = join(worktreesDir, 'aaa-dead-repo-lane')
    await addWorktree(repoA, pathA, 'regatta/aaa-dead-repo-lane', 'main')
    const tA = await trashOwnedWorktree({
      root: repoA,
      path: pathA,
      branch: 'regatta/aaa-dead-repo-lane',
      identity: worktreeIdentity(pathA),
      dir: worktreesDir,
      keepAs: 'aaa-dead-repo-lane'
    })
    expect(tA.status).toBe('trashed')

    const pathB = join(worktreesDir, 'zzz-healthy-repo-lane')
    await addWorktree(repoB, pathB, 'regatta/zzz-healthy-repo-lane', 'main')
    const tB = await trashOwnedWorktree({
      root: repoB,
      path: pathB,
      branch: 'regatta/zzz-healthy-repo-lane',
      identity: worktreeIdentity(pathB),
      dir: worktreesDir,
      keepAs: 'zzz-healthy-repo-lane'
    })
    expect(tB.status).toBe('trashed')

    // Delete repoA completely before emptying trash with withRepoLock
    rmSync(repoA, { recursive: true, force: true })

    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(2)
    const outA = outcomes.find((o) => o.branch === 'regatta/aaa-dead-repo-lane')
    const outB = outcomes.find((o) => o.branch === 'regatta/zzz-healthy-repo-lane')
    expect(outB?.status).toBe('deleted')
    expect(existsSync(tB.trashPath!)).toBe(false)
    expect(outA?.status).not.toBe('deleted')
  })

  it('reports a worktree that the user moved out of its trash entry folder and leaves it and its git records alone on emptyTrash', async () => {
    const { repo, worktreesDir, branch, record } = await makeLane('moved-out-lane')
    const gitDir = record.identity!.split('|')[0]!
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')

    const entryDir = dirname(res.trashPath!)
    const rescuedOutside = join(temp('regatta-rescued-outside-'), 'moved-out-lane')
    renameSync(res.trashPath!, rescuedOutside)

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.note).toBe('moved out of the trash; Regatta leaves it and its git records alone')

    const { outcomes } = await emptyTrash(worktreesDir)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('skipped')
    expect(outcomes[0]!.reason).toBe('moved out of the trash; Regatta leaves it and its git records alone')
    expect(existsSync(entryDir)).toBe(true)
    expect(existsSync(gitDir)).toBe(true)
    expect(sh(['branch', '--list', branch], repo)).toContain(branch)
  })

  it('never loses a commit written to the worktree git folder during emptyTrash', async () => {
    const { repo, worktreesDir, path: wtPath, branch, record } = await makeLane('race-head-lane')
    writeFileSync(join(wtPath, 'initial-lane.txt'), 'initial lane content\n')
    sh(['add', 'initial-lane.txt'], wtPath)
    sh([...IDENTITY, 'commit', '-m', 'initial lane commit'], wtPath)

    const gitDir = record.identity!.split('|')[0]!
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')

    // Pre-create a valid commit object in the repo object store that is not yet referenced by any ref.
    const treeSha = sh(['rev-parse', 'HEAD^{tree}'], repo).trim()
    const headBefore = sh(['rev-parse', 'HEAD'], res.trashPath!).trim()
    const lateCommitSha = sh(
      [...IDENTITY, 'commit-tree', treeSha, '-p', headBefore, '-m', 'late commit during emptyTrash'],
      repo
    ).trim()

    // Watch for emptyTrash's keepWorktreeHistory to create a second discarded ref in repo, then
    // immediately write lateCommitSha into <gitDir>/HEAD before rmSync runs.
    const discardedRefsDir = join(repo, '.git', 'refs', 'regatta', 'discarded')
    const headFile = join(gitDir, 'HEAD')
    let injectedLateCommit = false
    let keepWatching = true
    const watcher = (async () => {
      while (keepWatching && existsSync(gitDir)) {
        try {
          const refs = readdirSync(discardedRefsDir)
          if (refs.length >= 2 && !injectedLateCommit) {
            writeFileSync(headFile, `${lateCommitSha}\n`)
            injectedLateCommit = true
            break
          }
        } catch {
          break
        }
        await new Promise((r) => setTimeout(r, 1))
      }
    })()

    const { outcomes } = await emptyTrash(worktreesDir)
    keepWatching = false
    await watcher

    expect(outcomes).toHaveLength(1)
    const outcome = outcomes[0]!
    if (injectedLateCommit) {
      if (outcome.status === 'deleted') {
        const reachable = sh(['rev-list', '--all'], repo)
        expect(reachable).toContain(lateCommitSha)
      } else {
        expect(outcome.status).toBe('skipped')
        expect(existsSync(gitDir)).toBe(true)
        expect(sh(['branch', '--list', branch], repo)).toContain(branch)
      }
    }
  })
})

describe('trash-4: the git folder, re-attached worktrees, the last check, keep ref order, unfinished entries', { timeout: 30000 }, () => {
  const REATTACHED = 're-attached elsewhere, left alone'
  const UNFINISHED = 'unfinished; Empty trash finishes it'

  /** A commit written straight into a worktree's git folder by a git process running elsewhere. */
  function lateCommit(repo: string, gitDir: string, message = 'late commit'): string {
    const tree = sh(['hash-object', '-w', '-t', 'tree', '/dev/null'], repo).trim()
    const head = sh(['--git-dir', gitDir, 'rev-parse', 'HEAD'], repo).trim()
    const sha = sh([...IDENTITY, '--git-dir', gitDir, 'commit-tree', tree, '-p', head, '-m', message], repo).trim()
    sh(['--git-dir', gitDir, 'update-ref', '--create-reflog', '-m', `commit: ${message}`, 'HEAD', sha], repo)
    return sha
  }

  function commitIn(dir: string, file: string, text: string): string {
    writeFileSync(join(dir, file), text)
    sh(['add', file], dir)
    sh([...IDENTITY, 'commit', '-q', '-m', `add ${file}`], dir)
    return sh(['rev-parse', 'HEAD'], dir).trim()
  }

  function branchThere(repo: string, branch: string): boolean {
    return sh(['branch', '--list', branch], repo).includes(branch)
  }

  it('keeps the git folder, its lock and the lane branch when a submodule initialised in the lane holds a commit (Sonnet P1-1)', async () => {
    const base = temp('regatta-trash-sm-')
    const sub = join(base, 'sub')
    mkdirSync(sub)
    sh(['init', '-b', 'main'], sub)
    commitIn(sub, 'lib.txt', 'lib\n')
    const repo = join(base, 'main')
    mkdirSync(repo)
    sh(['init', '-b', 'main'], repo)
    writeFileSync(join(repo, 'README.md'), '# p\n')
    sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm'], repo)
    sh(['add', '-A'], repo)
    sh([...IDENTITY, 'commit', '-q', '-m', 'main with submodule'], repo)
    const worktreesDir = temp('regatta-trash-sm-wts-')
    const path = join(worktreesDir, 'sublane')
    const branch = 'regatta/sublane'
    await addWorktree(repo, path, branch, 'main')
    const record: OwnedWorktree = { root: repo, path, branch, identity: worktreeIdentity(path), dir: worktreesDir, keepAs: 'sublane' }
    const gitDir = record.identity!.split('|')[0]!
    sh(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'], path)
    expect(readFileSync(join(path, 'sm', '.git'), 'utf8')).toContain('/worktrees/sublane/modules/sm')
    // The agent commits inside the submodule; Regatta commits the lane.
    const subCommit = commitIn(join(path, 'sm'), 'agent.txt', 'agent work in the submodule\n')
    await commitAll(path, 'lane work')
    const moduleGitDir = join(gitDir, 'modules', 'sm')
    // The submodule's own work tree setting names the lane folder, which Empty trash deletes: point git elsewhere to read it.
    const subCommits = (): string => sh(['--git-dir', moduleGitDir, '--work-tree', base, 'rev-list', '--all'], repo)
    expect(subCommits()).toContain(subCommit)

    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    const outcome = outcomes[0]!
    // The worktree folder may go; the git folder, its lock and the branch stay, and the result names the folder and what is unknown.
    expect(existsSync(res.trashPath!)).toBe(false)
    expect(existsSync(gitDir)).toBe(true)
    expect(existsSync(join(gitDir, 'locked'))).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)
    expect(outcome.branchDeleted).not.toBe(true)
    expect(outcome.reason ?? '').toContain(realpathSync(gitDir))
    expect(outcome.reason ?? '').toContain('modules')
    expect(subCommits()).toContain(subCommit)
  })

  it('keeps the git folder while a rebase --autostash is in progress (Sonnet P3-3)', async () => {
    const { repo, worktreesDir, path, branch, record } = await makeLane('autostash-lane')
    const gitDir = record.identity!.split('|')[0]!
    commitIn(path, 'README.md', 'lane version\n')
    commitIn(repo, 'README.md', 'main version\n')
    writeFileSync(join(path, 'tracked-dir', 'item.txt'), 'UNCOMMITTED EDIT in the lane\n')
    try {
      sh([...IDENTITY, 'rebase', '--autostash', 'main'], path)
    } catch {
      // The conflict is the point: the rebase stops with the autostash held in the git folder.
    }
    const autostash = join(gitDir, 'rebase-merge', 'autostash')
    const stashId = readFileSync(autostash, 'utf8').trim()
    expect(stashId).toMatch(/^[0-9a-f]{40,64}$/)

    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    expect(readFileSync(autostash, 'utf8').trim()).toBe(stashId)
    expect(existsSync(join(gitDir, 'locked'))).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)
    expect(outcomes[0]!.reason ?? '').toContain('rebase-merge')
    expect(sh(['cat-file', '-t', stashId], repo).trim()).toBe('commit')
    // The autostash commit is also kept by a ref, not only by the file name in the kept folder (fix round 1 V4-1).
    expect(() => sh(['merge-base', '--is-ancestor', stashId, res.keepRef!], repo)).not.toThrow()
  })

  it('keeps the git folder for any entry not on the known list: rebase-apply, sequencer, BISECT_LOG, an unknown file', async () => {
    const unknowns: Array<{ name: string; make: (gitDir: string) => void }> = [
      { name: 'rebase-apply', make: (g) => (mkdirSync(join(g, 'rebase-apply')), writeFileSync(join(g, 'rebase-apply', 'patch'), 'p\n')) },
      { name: 'sequencer', make: (g) => (mkdirSync(join(g, 'sequencer')), writeFileSync(join(g, 'sequencer', 'todo'), 'pick x\n')) },
      { name: 'BISECT_LOG', make: (g) => writeFileSync(join(g, 'BISECT_LOG'), 'git bisect start\n') },
      { name: 'mystery.txt', make: (g) => writeFileSync(join(g, 'mystery.txt'), 'who knows\n') },
      { name: 'refs/heads', make: (g) => (mkdirSync(join(g, 'refs', 'heads'), { recursive: true }), writeFileSync(join(g, 'refs', 'heads', 'x'), 'y\n')) }
    ]
    for (const unknown of unknowns) {
      const { repo, worktreesDir, branch, record } = await makeLane(`unknown-${unknown.name.replace(/[^a-z]/gi, '')}`)
      const gitDir = record.identity!.split('|')[0]!
      const res = await trashOwnedWorktree(record)
      expect(res.status, unknown.name).toBe('trashed')
      unknown.make(gitDir)
      const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
      expect(outcomes, unknown.name).toHaveLength(1)
      expect(existsSync(join(gitDir, unknown.name)), unknown.name).toBe(true)
      expect(existsSync(join(gitDir, 'locked')), unknown.name).toBe(true)
      expect(branchThere(repo, branch), unknown.name).toBe(true)
      expect(outcomes[0]!.reason ?? '', unknown.name).toContain(unknown.name.split('/')[0]!)
    }
  }, 60000)

  it('never loses a commit made at the moment the entry folder is deleted (Sonnet P3-1)', async () => {
    const { repo, worktreesDir, record } = await makeLane('window-lane')
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const trashPath = res.trashPath!
    const entryPath = dirname(trashPath)
    sh(['switch', '-q', '--detach'], trashPath)
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    let landed = ''
    rmHook.fire = (p) => {
      if (landed || p !== join(entryPath, 'entry.json')) return
      landed = lateCommit(repo, gitDir)
    }
    let outcomes
    try {
      outcomes = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
    } finally {
      rmHook.fire = null
    }
    expect(landed).toMatch(/^[0-9a-f]{40,64}$/)
    expect(outcomes).toHaveLength(1)
    // The git folder is kept (its logs hold the new commit) and the result says so.
    expect(existsSync(gitDir)).toBe(true)
    expect(readFileSync(join(gitDir, 'logs', 'HEAD'), 'utf8')).toContain(landed)
    expect(outcomes[0]!.reason ?? '').toContain(gitDir)
    expect(sh(['rev-list', '--all', '--reflog'], repo)).toContain(landed)
  })

  it('leaves alone a trashed worktree the user copied back to its original path and re-attached (Argon P1-1 case A)', async () => {
    const { repo, worktreesDir, path, branch, record } = await makeLane('case-a-lane')
    const gitDir = record.identity!.split('|')[0]!
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    cpSync(res.trashPath!, path, { recursive: true })
    sh(['worktree', 'repair', path], repo)
    sh(['worktree', 'unlock', path], repo)
    writeFileSync(join(path, 'staged-only.txt'), 'precious staged work\n')
    sh(['add', 'staged-only.txt'], path)
    rmSync(join(path, 'staged-only.txt'))
    writeFileSync(join(path, 'draft.txt'), 'draft in the restored copy\n')
    const gitdirBefore = readFileSync(join(gitDir, 'gitdir'), 'utf8')
    const indexBefore = readFileSync(join(gitDir, 'index'))
    const headBefore = readFileSync(join(gitDir, 'HEAD'), 'utf8')
    const refsBefore = sh(['for-each-ref'], repo)

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.note).toBe(REATTACHED)
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('skipped')
    expect(outcomes[0]!.reason ?? '').toContain(REATTACHED)

    expect(readFileSync(join(gitDir, 'gitdir'), 'utf8')).toBe(gitdirBefore)
    expect(readFileSync(join(gitDir, 'index')).equals(indexBefore)).toBe(true)
    expect(readFileSync(join(gitDir, 'HEAD'), 'utf8')).toBe(headBefore)
    expect(sh(['for-each-ref'], repo)).toBe(refsBefore)
    expect(branchThere(repo, branch)).toBe(true)
    expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('draft in the restored copy\n')
    expect(sh(['status', '--short'], path)).toContain('staged-only.txt')
    expect(existsSync(res.trashPath!)).toBe(true)
  })

  for (const variant of ['repair-failed', 'lost-record'] as const) {
    it(`leaves alone a trashed worktree the user copied to another path and re-attached, ${variant} (Argon P1-1 case B)`, async () => {
      const { repo, worktreesDir, branch, record } = await makeLane(`case-b-${variant}`)
      const gitDir = record.identity!.split('|')[0]!
      const res = await trashOwnedWorktree(record)
      expect(res.status).toBe('trashed')
      const entryDir = dirname(res.trashPath!)
      if (variant === 'repair-failed') {
        const meta = JSON.parse(readFileSync(join(entryDir, 'entry.json'), 'utf8')) as TrashEntryMeta
        writeFileSync(join(entryDir, 'entry.json'), JSON.stringify({ ...meta, repaired: false, repairError: 'simulated failed repair' }))
      } else {
        unlinkSync(join(entryDir, 'entry.json'))
      }
      const elsewhere = join(temp('regatta-trash-rescued-'), 'rescued')
      cpSync(res.trashPath!, elsewhere, { recursive: true })
      sh(['worktree', 'repair', elsewhere], repo)
      writeFileSync(join(elsewhere, 'staged-only.txt'), 'precious staged work\n')
      sh(['add', 'staged-only.txt'], elsewhere)
      rmSync(join(elsewhere, 'staged-only.txt'))
      writeFileSync(join(elsewhere, 'draft.txt'), 'draft elsewhere\n')
      const gitdirBefore = readFileSync(join(gitDir, 'gitdir'), 'utf8')
      expect(gitdirBefore.trim()).toBe(join(realpathSync(elsewhere), '.git'))
      const indexBefore = readFileSync(join(gitDir, 'index'))
      const refsBefore = sh(['for-each-ref'], repo)

      const listed = await listTrash(worktreesDir)
      expect(listed).toHaveLength(1)
      expect(listed[0]!.note).toBe(REATTACHED)
      expect(readFileSync(join(gitDir, 'gitdir'), 'utf8')).toBe(gitdirBefore)
      const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.status).toBe('skipped')
      expect(outcomes[0]!.reason ?? '').toContain(REATTACHED)

      expect(readFileSync(join(gitDir, 'gitdir'), 'utf8')).toBe(gitdirBefore)
      expect(readFileSync(join(gitDir, 'index')).equals(indexBefore)).toBe(true)
      expect(sh(['for-each-ref'], repo)).toBe(refsBefore)
      expect(branchThere(repo, branch)).toBe(true)
      expect(readFileSync(join(elsewhere, 'draft.txt'), 'utf8')).toBe('draft elsewhere\n')
      expect(sh(['status', '--short'], elsewhere)).toContain('staged-only.txt')
    })
  }

  it('makes the worktree HEAD the first parent of the keep ref after a detach and a commit in the trash (Argon P3-2)', async () => {
    const { repo, worktreesDir, path, record } = await makeLane('first-parent-lane')
    commitIn(path, 'work.txt', 'lane work\n')
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    sh(['switch', '-q', '--detach'], res.trashPath!)
    const late = commitIn(res.trashPath!, 'late.txt', 'made in the trash\n')
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('deleted')
    expect(outcomes[0]!.branchDeleted).toBe(true)
    expect(outcomes[0]!.keepRef).toBe(res.keepRef)
    expect(sh(['rev-parse', `${res.keepRef!}^1`], repo).trim()).toBe(late)
  })

  it('finishes an entry left holding only entry.json by an interrupted Empty trash (Sonnet P3-4)', async () => {
    const { repo, worktreesDir, branch, record } = await makeLane('unfinished-json-lane')
    const gitDir = record.identity!.split('|')[0]!
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const entryDir = dirname(res.trashPath!)
    sh(['switch', '-q', '--detach'], res.trashPath!)
    const late = commitIn(res.trashPath!, 'late.txt', 'made in the trash\n')
    // Stop Empty trash right after it deleted the worktree folder, as a crash there would. The mark that it did is
    // already on disk then (a real crash never reaches the error handler that writes entry.json again).
    let markSeen: TrashEntryMeta | null = null
    rmHook.fire = (p) => {
      if (p !== join(entryDir, 'entry.json')) return
      markSeen = JSON.parse(readFileSync(p, 'utf8')) as TrashEntryMeta
      throw new Error('simulated crash')
    }
    try {
      await emptyTrash(worktreesDir, withRepoLock)
    } finally {
      rmHook.fire = null
    }
    expect(existsSync(res.trashPath!)).toBe(false)
    expect(readdirSync(entryDir)).toEqual(['entry.json'])
    expect(existsSync(gitDir)).toBe(true)
    expect(markSeen).not.toBeNull()
    expect(markSeen!.emptying).toBeTruthy()
    expect(markSeen!.folderDeleted).toBeTruthy()

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.note).toBe(UNFINISHED)
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('deleted')
    expect(existsSync(entryDir)).toBe(false)
    expect(existsSync(gitDir)).toBe(false)
    expect(branchThere(repo, branch)).toBe(false)
    expect(sh(['rev-list', res.keepRef!], repo)).toContain(late)
  })

  it('finishes an entry left as an empty folder without .git by an interrupted Empty trash, also with entry.json lost (Argon P3-3)', async () => {
    const { repo, worktreesDir, branch, record } = await makeLane('unfinished-empty-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const trashPath = res.trashPath!
    const entryDir = dirname(trashPath)
    sh(['switch', '-q', '--detach'], trashPath)
    const branchTipBefore = sh(['rev-parse', branch], repo).trim()
    unlinkSync(join(entryDir, 'entry.json'))
    // A commit lands while the worktree folder is being deleted: Empty trash stops and leaves the entry unfinished.
    let landed = ''
    rmHook.fire = (p) => {
      if (landed || !inside(p, join(entryDir, '.regatta-deleting'))) return
      landed = lateCommit(repo, gitDir)
    }
    let first
    try {
      first = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
    } finally {
      rmHook.fire = null
    }
    expect(landed).toMatch(/^[0-9a-f]{40,64}$/)
    expect(first).toHaveLength(1)
    expect(first[0]!.status).toBe('skipped')
    expect(existsSync(gitDir)).toBe(true)
    expect(existsSync(join(trashPath, '.git'))).toBe(false)
    expect(readdirSync(entryDir)).toEqual(['entry.json'])
    // An older build left the worktree folder itself behind, empty and without .git: that finishes the same way.
    mkdirSync(trashPath)

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.note).toBe(UNFINISHED)
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('deleted')
    expect(existsSync(entryDir)).toBe(false)
    expect(existsSync(gitDir)).toBe(false)
    // With entry.json lost and HEAD detached, nothing names the lane branch, so it is kept as it was.
    expect(sh(['rev-parse', branch], repo).trim()).toBe(branchTipBefore)
    expect(sh(['rev-list', '--all'], repo)).toContain(landed)
  })

  // Fix round 1 (2026-10-17 verifiers): the probes in /tmp/rv-trash4-fresh, as asserting tests.
  const MOVED_OUT = 'moved out of the trash; Regatta leaves it and its git records alone'

  for (const failure of ['simulated', 'locked'] as const) {
    it.skipIf(failure === 'locked' && process.platform !== 'darwin')(
      `keeps the git folder, index and branch of a worktree moved out after Empty trash failed to delete it, ${failure} (fix round 1 F1)`,
      async () => {
        const { repo, worktreesDir, branch, record } = await makeLane(`moved-after-fail-${failure}`)
        const gitDir = realpathSync(record.identity!.split('|')[0]!)
        const res = await trashOwnedWorktree(record)
        expect(res.status).toBe('trashed')
        const trashPath = res.trashPath!
        const entryDir = dirname(trashPath)
        // Finder's Locked box (or any failure) stops the delete before anything in the folder goes.
        if (failure === 'locked') {
          execFileSync('chflags', ['uchg', trashPath])
        } else {
          rmHook.fire = (p) => {
            if (inside(p, join(entryDir, '.regatta-deleting'))) throw new Error('simulated failure deleting the folder')
          }
        }
        let first
        try {
          first = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
        } finally {
          rmHook.fire = null
          if (failure === 'locked') execFileSync('chflags', ['nouchg', trashPath])
        }
        expect(first).toHaveLength(1)
        expect(first[0]!.status).toBe('error')
        expect(existsSync(join(trashPath, '.git'))).toBe(true)

        // The user moves the worktree out of the trash and keeps working in it.
        const restored = join(temp('regatta-trash-restored-'), 'restored')
        renameSync(trashPath, restored)
        const work = commitIn(restored, 'after.txt', 'work after the restore\n')
        writeFileSync(join(restored, 'staged-only.txt'), 'staged only\n')
        sh(['add', 'staged-only.txt'], restored)
        rmSync(join(restored, 'staged-only.txt'))
        expect(readdirSync(entryDir)).toEqual(['entry.json'])
        const indexBefore = readFileSync(join(gitDir, 'index'))

        const listed = await listTrash(worktreesDir)
        expect(listed).toHaveLength(1)
        expect(listed[0]!.note).toBe(MOVED_OUT)
        const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
        expect(outcomes).toHaveLength(1)
        expect(outcomes[0]!.status).toBe('skipped')
        expect(existsSync(gitDir)).toBe(true)
        expect(readFileSync(join(gitDir, 'index')).equals(indexBefore)).toBe(true)
        expect(branchThere(repo, branch)).toBe(true)
        expect(sh(['status', '--short', '--branch'], restored)).toContain(`## ${branch}`)
        expect(sh(['status', '--short'], restored)).toContain('staged-only.txt')
        expect(sh(['rev-parse', 'HEAD'], restored).trim()).toBe(work)
      }
    )
  }

  for (const variant of ['recorded', 'lost-record'] as const) {
    it(`leaves alone a copy put back at the original path without git worktree repair, which git uses, ${variant} (fix round 1 F2)`, async () => {
      const { repo, worktreesDir, path, branch, record } = await makeLane(`plain-copy-${variant}`)
      const gitDir = realpathSync(record.identity!.split('|')[0]!)
      const res = await trashOwnedWorktree(record)
      expect(res.status).toBe('trashed')
      if (variant === 'lost-record') unlinkSync(join(dirname(res.trashPath!), 'entry.json'))
      // A plain copy back: its .git file names the same git folder, so git works in it although gitdir names the trash.
      cpSync(res.trashPath!, path, { recursive: true })
      const work = commitIn(path, 'copy-work.txt', 'work in the copy\n')
      writeFileSync(join(path, 'staged-only.txt'), 'staged only\n')
      sh(['add', 'staged-only.txt'], path)
      rmSync(join(path, 'staged-only.txt'))
      const gitdirBefore = readFileSync(join(gitDir, 'gitdir'), 'utf8')
      expect(gitdirBefore.trim()).toBe(join(realpathSync(res.trashPath!), '.git'))
      const indexBefore = readFileSync(join(gitDir, 'index'))
      const refsBefore = sh(['for-each-ref'], repo)

      const listed = await listTrash(worktreesDir)
      expect(listed).toHaveLength(1)
      expect(listed[0]!.note).toBe(REATTACHED)
      const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.status).toBe('skipped')
      expect(outcomes[0]!.reason ?? '').toContain(REATTACHED)

      expect(readFileSync(join(gitDir, 'gitdir'), 'utf8')).toBe(gitdirBefore)
      expect(readFileSync(join(gitDir, 'index')).equals(indexBefore)).toBe(true)
      expect(sh(['for-each-ref'], repo)).toBe(refsBefore)
      expect(branchThere(repo, branch)).toBe(true)
      expect(sh(['status', '--short', '--branch'], path)).toContain(`## ${branch}`)
      expect(sh(['status', '--short'], path)).toContain('staged-only.txt')
      expect(sh(['rev-parse', 'HEAD'], path).trim()).toBe(work)
      expect(existsSync(res.trashPath!)).toBe(true)
    })
  }

  it('leaves alone a re-attached copy that is not at its path for a moment while the trash is listed and emptied (fix round 1 F3)', async () => {
    const { repo, worktreesDir, branch, record } = await makeLane('brief-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const entryDir = dirname(res.trashPath!)
    const meta = JSON.parse(readFileSync(join(entryDir, 'entry.json'), 'utf8')) as TrashEntryMeta
    writeFileSync(join(entryDir, 'entry.json'), JSON.stringify({ ...meta, repaired: false, repairError: 'simulated failed repair' }))
    const elsewhere = join(temp('regatta-trash-brief-'), 'rescued')
    cpSync(res.trashPath!, elsewhere, { recursive: true })
    sh(['worktree', 'repair', elsewhere], repo)
    writeFileSync(join(elsewhere, 'staged-only.txt'), 'staged only\n')
    sh(['add', 'staged-only.txt'], elsewhere)
    rmSync(join(elsewhere, 'staged-only.txt'))
    const gitdirBefore = readFileSync(join(gitDir, 'gitdir'), 'utf8')
    expect(gitdirBefore.trim()).toBe(join(realpathSync(elsewhere), '.git'))
    const indexBefore = readFileSync(join(gitDir, 'index'))

    // The copy is renamed away (or its volume unmounted) exactly while Regatta looks.
    const away = `${elsewhere}.away`
    const whileAway = async <T>(fn: () => Promise<T>): Promise<T> => {
      renameSync(elsewhere, away)
      try {
        return await fn()
      } finally {
        renameSync(away, elsewhere)
      }
    }
    const listed = await whileAway(() => listTrash(worktreesDir))
    expect(listed).toHaveLength(1)
    expect(listed[0]!.note).toBe(REATTACHED)
    expect(readFileSync(join(gitDir, 'gitdir'), 'utf8')).toBe(gitdirBefore)
    const { outcomes } = await whileAway(() => emptyTrash(worktreesDir, withRepoLock))
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('skipped')
    expect(outcomes[0]!.reason ?? '').toContain(REATTACHED)

    expect(readFileSync(join(gitDir, 'gitdir'), 'utf8')).toBe(gitdirBefore)
    expect(readFileSync(join(gitDir, 'index')).equals(indexBefore)).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)
    expect(sh(['status', '--short'], elsewhere)).toContain('staged-only.txt')
    expect(existsSync(res.trashPath!)).toBe(true)
  })

  it('never deletes or writes through a link that replaced the entry folder while Empty trash runs (fix round 1 F4)', async () => {
    const { repo, worktreesDir, branch, record } = await makeLane('swap-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const entryPath = join(realpathSync(worktreesDir), TRASH_DIR_NAME, basename(dirname(res.trashPath!)))
    const victim = temp('regatta-trash-victim-')
    mkdirSync(join(victim, 'swap-lane'))
    writeFileSync(join(victim, 'swap-lane', 'precious.txt'), 'not in the trash\n')
    // Right after Empty trash marks entry.json (it syncs the entry folder), the entry folder is swapped for a link.
    let swapped = false
    rmHook.open = (p, flags) => {
      if (swapped || p !== entryPath || flags !== 'r') return
      swapped = true
      renameSync(entryPath, `${entryPath}-moved`)
      symlinkSync(victim, entryPath)
    }
    let outcomes
    try {
      outcomes = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
    } finally {
      rmHook.open = null
    }
    expect(swapped).toBe(true)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('skipped')
    expect(readFileSync(join(victim, 'swap-lane', 'precious.txt'), 'utf8')).toBe('not in the trash\n')
    // Nothing was written into the folder the link leads to either.
    expect(readdirSync(victim)).toEqual(['swap-lane'])
    expect(readdirSync(join(victim, 'swap-lane'))).toEqual(['precious.txt'])
    expect(existsSync(join(`${entryPath}-moved`, 'swap-lane', 'README.md'))).toBe(true)
    expect(existsSync(gitDir)).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)
  })

  it('leaves alone a copy re-attached at the original path with relative paths (fix round 1 TS-1)', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-trash-rel-a-')
    const path = join(worktreesDir, 'rel-a-lane')
    const branch = 'regatta/rel-a-lane'
    sh(['worktree', 'add', '--relative-paths', '-b', branch, path, 'main'], repo)
    const record: OwnedWorktree = { root: repo, path, branch, identity: worktreeIdentity(path), dir: worktreesDir, keepAs: 'rel-a-lane' }
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    cpSync(res.trashPath!, path, { recursive: true })
    sh(['worktree', 'repair', '--relative-paths', path], repo)
    const gitdirBefore = readFileSync(join(gitDir, 'gitdir'), 'utf8')
    expect(gitdirBefore.trim()).toMatch(/^\.\.\//)
    writeFileSync(join(path, 'staged-only.txt'), 'staged only\n')
    sh(['add', 'staged-only.txt'], path)
    rmSync(join(path, 'staged-only.txt'))
    const indexBefore = readFileSync(join(gitDir, 'index'))

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.note).toBe(REATTACHED)
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('skipped')
    expect(outcomes[0]!.reason ?? '').toContain(REATTACHED)
    expect(readFileSync(join(gitDir, 'gitdir'), 'utf8')).toBe(gitdirBefore)
    expect(readFileSync(join(gitDir, 'index')).equals(indexBefore)).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)
    expect(sh(['status', '--short'], path)).toContain('staged-only.txt')
    expect(existsSync(res.trashPath!)).toBe(true)
  })

  it('finishes an unfinished entry of a repository with worktree.useRelativePaths (fix round 1 TS-1)', async () => {
    const repo = makeRepo()
    sh(['config', 'worktree.useRelativePaths', 'true'], repo)
    const worktreesDir = temp('regatta-trash-rel-unfinished-')
    const path = join(worktreesDir, 'rel-unfinished-lane')
    const branch = 'regatta/rel-unfinished-lane'
    await addWorktree(repo, path, branch, 'main')
    const record: OwnedWorktree = { root: repo, path, branch, identity: worktreeIdentity(path), dir: worktreesDir, keepAs: 'rel-unfinished-lane' }
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    // Regatta's own repair kept the relative form: gitdir is resolved against the git folder, as git does.
    expect(readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()).toMatch(/^\.\.\//)
    const entryDir = dirname(res.trashPath!)
    rmHook.fire = (p) => {
      if (p === join(entryDir, 'entry.json')) throw new Error('simulated crash')
    }
    try {
      await emptyTrash(worktreesDir, withRepoLock)
    } finally {
      rmHook.fire = null
    }
    expect(readdirSync(entryDir)).toEqual(['entry.json'])
    expect(existsSync(gitDir)).toBe(true)

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.note).toBe(UNFINISHED)
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('deleted')
    expect(existsSync(entryDir)).toBe(false)
    expect(existsSync(gitDir)).toBe(false)
    expect(branchThere(repo, branch)).toBe(false)
  })

  for (const variant of ['late commit', 're-attached copy'] as const) {
    it(`stops before deleting the worktree folder when, after the keep, there is a ${variant} (fix round 1 TS-3)`, async () => {
      const { repo, worktreesDir, branch, record } = await makeLane(`step-four-${variant.replace(/[^a-z]/g, '')}`)
      const gitDir = realpathSync(record.identity!.split('|')[0]!)
      const res = await trashOwnedWorktree(record)
      expect(res.status).toBe('trashed')
      const trashPath = res.trashPath!
      const metaFile = join(realpathSync(dirname(trashPath)), 'entry.json')
      const elsewhere = join(temp('regatta-trash-step-four-'), 'rescued')
      // The first entry.json write of Empty trash is its mark: after the snapshot and the keep, before the last check.
      let fired = ''
      rmHook.open = (p, flags) => {
        if (fired || p !== metaFile || flags !== 'w') return
        if (variant === 'late commit') {
          fired = lateCommit(repo, gitDir)
        } else {
          cpSync(trashPath, elsewhere, { recursive: true })
          sh(['worktree', 'repair', elsewhere], repo)
          fired = elsewhere
        }
      }
      let outcomes
      try {
        outcomes = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
      } finally {
        rmHook.open = null
      }
      expect(fired).not.toBe('')
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.status).toBe('skipped')
      if (variant === 'late commit') {
        expect(outcomes[0]!.reason ?? '').toContain('git state changed while emptying')
        expect(outcomes[0]!.reason ?? '').not.toContain('after its folder was deleted')
        expect(readFileSync(join(gitDir, 'logs', 'HEAD'), 'utf8')).toContain(fired)
      } else {
        expect(outcomes[0]!.reason ?? '').toContain(REATTACHED)
        expect(readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()).toBe(join(realpathSync(elsewhere), '.git'))
      }
      // The worktree folder itself was never touched.
      expect(readdirSync(trashPath).length).toBeGreaterThan(0)
      expect(existsSync(join(trashPath, 'README.md'))).toBe(true)
      expect(existsSync(gitDir)).toBe(true)
      expect(branchThere(repo, branch)).toBe(true)
    })
  }

  it('keeps the git folder when a known name has the wrong kind or a link sits in logs/ or refs/worktree/ (fix round 1 TS-4)', async () => {
    const rows: Array<{ label: string; named: string; make: (gitDir: string) => void }> = [
      { label: 'a link in logs', named: 'logs/', make: (g) => symlinkSync(temp('regatta-trash-linked-logs-'), join(g, 'logs', 'linked')) },
      {
        label: 'a link in refs/worktree',
        named: 'refs/worktree',
        make: (g) => {
          mkdirSync(join(g, 'refs', 'worktree'), { recursive: true })
          symlinkSync(temp('regatta-trash-linked-ref-'), join(g, 'refs', 'worktree', 'linked'))
        }
      },
      {
        label: 'refs/worktree as a link',
        named: 'refs/worktree',
        make: (g) => {
          mkdirSync(join(g, 'refs'), { recursive: true })
          symlinkSync(temp('regatta-trash-linked-refs-'), join(g, 'refs', 'worktree'))
        }
      },
      { label: 'index as a folder', named: 'index', make: (g) => (rmSync(join(g, 'index')), mkdirSync(join(g, 'index'))) },
      { label: 'index.lock', named: 'index.lock', make: (g) => writeFileSync(join(g, 'index.lock'), '') }
    ]
    for (const row of rows) {
      const { repo, worktreesDir, branch, record } = await makeLane(`shape-${row.label.replace(/[^a-z]/g, '')}`)
      const gitDir = realpathSync(record.identity!.split('|')[0]!)
      const res = await trashOwnedWorktree(record)
      expect(res.status, row.label).toBe('trashed')
      row.make(gitDir)
      const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
      expect(outcomes, row.label).toHaveLength(1)
      expect(existsSync(gitDir), row.label).toBe(true)
      expect(existsSync(join(gitDir, 'locked')), row.label).toBe(true)
      expect(branchThere(repo, branch), row.label).toBe(true)
      expect(outcomes[0]!.reason ?? '', row.label).toContain(row.named)
    }
  }, 60000)

  it('keeps the worktree HEAD first in the keep ref when no branch is deleted (fix round 1 TS-5)', async () => {
    const { repo, worktreesDir, branch, record } = await makeLane('no-branch-lane')
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const entryDir = dirname(res.trashPath!)
    const meta = JSON.parse(readFileSync(join(entryDir, 'entry.json'), 'utf8')) as TrashEntryMeta
    writeFileSync(join(entryDir, 'entry.json'), JSON.stringify({ ...meta, branch: null }))
    sh(['switch', '-q', '--detach'], res.trashPath!)
    const late = commitIn(res.trashPath!, 'late.txt', 'made in the trash\n')
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('deleted')
    expect(outcomes[0]!.branchDeleted).toBe(false)
    expect(outcomes[0]!.branchParked).toBeUndefined()
    expect(outcomes[0]!.keepRef).toBe(res.keepRef)
    expect(sh(['rev-parse', `${res.keepRef!}^1`], repo).trim()).toBe(late)
    expect(branchThere(repo, branch)).toBe(true)
  })

  it('repairTrashedWorktree on its own never takes back a git folder a copy elsewhere was re-attached to (fix round 1 TS-6)', async () => {
    const { repo, record } = await makeLane('direct-repair-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const entryDir = dirname(res.trashPath!)
    const meta = JSON.parse(readFileSync(join(entryDir, 'entry.json'), 'utf8')) as TrashEntryMeta
    writeFileSync(join(entryDir, 'entry.json'), JSON.stringify({ ...meta, repaired: false, repairError: 'simulated failed repair' }))
    const elsewhere = join(temp('regatta-trash-direct-'), 'rescued')
    cpSync(res.trashPath!, elsewhere, { recursive: true })
    sh(['worktree', 'repair', elsewhere], repo)
    const gitdirBefore = readFileSync(join(gitDir, 'gitdir'), 'utf8')
    const updated = await repairTrashedWorktree(entryDir)
    expect(updated.repaired).toBe(false)
    expect(updated.repairError).toBe(REATTACHED)
    expect(readFileSync(join(gitDir, 'gitdir'), 'utf8')).toBe(gitdirBefore)
    expect(readFileSync(join(elsewhere, '.git'), 'utf8')).toContain(gitDir)
  })

  // Fix round 2 (2026-10-17 verifiers): the probes in /tmp/ts-tools/zz-gap.test.ts.txt and /tmp/fa-trash4, as
  // asserting tests.
  function danglingCommit(repo: string, message: string): string {
    const tree = sh(['hash-object', '-w', '-t', 'tree', '/dev/null'], repo).trim()
    const head = sh(['rev-parse', 'HEAD'], repo).trim()
    return sh([...IDENTITY, 'commit-tree', tree, '-p', head, '-m', message], repo).trim()
  }

  it('keeps the git folder when a plain copy appears at the original path while the entry folder is deleted (fix round 2 TS-A)', async () => {
    const { repo, worktreesDir, path, branch, record } = await makeLane('late-copy-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const trashPath = res.trashPath!
    const entryPath = dirname(trashPath)
    const backup = join(temp('regatta-trash-backup-'), 'backup')
    cpSync(trashPath, backup, { recursive: true })
    // After the worktree folder is gone and before the git folder is, the user puts a plain copy back and stages a
    // file there. Only the last re-attached check before the git folder is deleted can see it.
    let fired = false
    rmHook.fire = (p) => {
      if (fired || p !== join(entryPath, 'entry.json')) return
      fired = true
      cpSync(backup, path, { recursive: true })
      writeFileSync(join(path, 'staged-only.txt'), 'staged\n')
      sh(['add', 'staged-only.txt'], path)
    }
    let outcomes
    try {
      outcomes = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
    } finally {
      rmHook.fire = null
    }
    expect(fired).toBe(true)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.reason ?? '').toContain(`a worktree at ${path} uses it now`)
    expect(existsSync(gitDir)).toBe(true)
    expect(existsSync(join(gitDir, 'locked'))).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)
    expect(sh(['status', '--short', '--branch'], path)).toContain(`## ${branch}`)
    expect(sh(['status', '--short'], path)).toContain('A  staged-only.txt')
  })

  for (const variant of ['ref', 'pseudo'] as const) {
    it(`stops Empty trash when a write no reflog records lands after the keep, a changed ${variant} (fix round 2 ${variant === 'ref' ? 'TS-B' : 'TS-C'})`, async () => {
      const { repo, worktreesDir, branch, record } = await makeLane(`late-${variant}-lane`)
      const gitDir = realpathSync(record.identity!.split('|')[0]!)
      const res = await trashOwnedWorktree(record)
      expect(res.status).toBe('trashed')
      const trashPath = res.trashPath!
      const metaFile = join(realpathSync(dirname(trashPath)), 'entry.json')
      const head = sh(['rev-parse', 'HEAD'], repo).trim()
      // FETCH_HEAD already exists before Empty trash, so only its content changes (the same file name).
      if (variant === 'pseudo') writeFileSync(join(gitDir, 'FETCH_HEAD'), `${head}\t\tbranch 'main' of /x\n`)
      const late = danglingCommit(repo, `late ${variant}`)
      let fired = false
      rmHook.open = (p, flags) => {
        if (fired || p !== metaFile || flags !== 'w') return
        fired = true
        if (variant === 'ref') {
          // refs/worktree/* is not reflogged by default: only the refs/ part of the snapshot sees it.
          sh(['--git-dir', gitDir, 'update-ref', 'refs/worktree/late', late], repo)
        } else {
          writeFileSync(join(gitDir, 'FETCH_HEAD'), `${late}\t\tbranch 'main' of /x\n`)
        }
      }
      let outcomes
      try {
        outcomes = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
      } finally {
        rmHook.open = null
      }
      expect(fired).toBe(true)
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.status).toBe('skipped')
      expect(outcomes[0]!.reason ?? '').toContain('git state changed while emptying')
      expect(existsSync(join(trashPath, 'README.md'))).toBe(true)
      expect(existsSync(gitDir)).toBe(true)
      expect(branchThere(repo, branch)).toBe(true)
      // The next Empty trash keeps the late commit and empties the entry.
      const again = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
      expect(again[0]!.status).toBe('deleted')
      expect(sh(['rev-list', '--all'], repo)).toContain(late)
    })
  }

  it('never deletes through a link that replaced the trash folder itself while Empty trash runs (fix round 2 TS-D)', async () => {
    const { repo, worktreesDir, branch, record } = await makeLane('parent-swap-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const trashDir = join(realpathSync(worktreesDir), TRASH_DIR_NAME)
    const entryName = basename(dirname(res.trashPath!))
    const entryPath = join(trashDir, entryName)
    const victim = temp('regatta-trash-parent-victim-')
    mkdirSync(join(victim, entryName, 'parent-swap-lane'), { recursive: true })
    writeFileSync(join(victim, entryName, 'parent-swap-lane', 'precious.txt'), 'not in the trash\n')
    writeFileSync(join(victim, entryName, 'entry.json'), 'victim file\n')
    // Right after Empty trash marks entry.json (it syncs the entry folder), the whole trash folder becomes a link.
    let swapped = false
    rmHook.open = (p, flags) => {
      if (swapped || p !== entryPath || flags !== 'r') return
      swapped = true
      renameSync(trashDir, `${trashDir}-moved`)
      symlinkSync(victim, trashDir)
    }
    let outcomes
    try {
      outcomes = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
    } finally {
      rmHook.open = null
    }
    expect(swapped).toBe(true)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('skipped')
    expect(readFileSync(join(victim, entryName, 'parent-swap-lane', 'precious.txt'), 'utf8')).toBe('not in the trash\n')
    expect(readFileSync(join(victim, entryName, 'entry.json'), 'utf8')).toBe('victim file\n')
    expect(readdirSync(join(victim, entryName)).sort()).toEqual(['entry.json', 'parent-swap-lane'])
    expect(existsSync(join(`${trashDir}-moved`, entryName, 'parent-swap-lane', 'README.md'))).toBe(true)
    expect(existsSync(gitDir)).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)
  })

  it('drops the emptying mark again when an entry is skipped before anything was deleted (fix round 2 TS-F)', async () => {
    const { repo, worktreesDir, record } = await makeLane('unmark-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const entryDir = dirname(res.trashPath!)
    const metaFile = join(realpathSync(entryDir), 'entry.json')
    let fired = ''
    rmHook.open = (p, flags) => {
      if (fired || p !== metaFile || flags !== 'w') return
      fired = lateCommit(repo, gitDir)
    }
    let outcomes
    try {
      outcomes = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
    } finally {
      rmHook.open = null
    }
    expect(fired).not.toBe('')
    expect(outcomes![0]!.status).toBe('skipped')
    expect((JSON.parse(readFileSync(metaFile, 'utf8')) as TrashEntryMeta).emptying).toBeUndefined()
    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.note).toBeUndefined()
    expect(listed[0]!.repaired).toBe(true)
  })

  it('never trashes a lane of a reftable repository, whose logs Regatta cannot read (fix round 2 TS-G)', async () => {
    const repo = temp('regatta-trash-reftable-')
    sh(['init', '-q', '-b', 'main', '--ref-format=reftable'], repo)
    sh(['config', 'user.name', 'Regatta Test'], repo)
    sh(['config', 'user.email', 'test@regatta.local'], repo)
    writeFileSync(join(repo, 'README.md'), '# p\n')
    sh(['add', '.'], repo)
    sh([...IDENTITY, 'commit', '-q', '-m', 'initial'], repo)
    const worktreesDir = temp('regatta-trash-reftable-wts-')
    const path = join(worktreesDir, 'rt-lane')
    await addWorktree(repo, path, 'regatta/rt-lane', 'main')
    const record: OwnedWorktree = { root: repo, path, branch: 'regatta/rt-lane', identity: worktreeIdentity(path), dir: worktreesDir, keepAs: 'rt-lane' }
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('kept')
    expect(res.reason ?? '').toContain('reftable')
    expect(existsSync(join(path, 'README.md'))).toBe(true)
    expect(existsSync(join(realpathSync(worktreesDir), TRASH_DIR_NAME)) && readdirSync(join(realpathSync(worktreesDir), TRASH_DIR_NAME)).length).toBeFalsy()
  })

  it('leaves alone an entry whose git folder names the original path while a folder is there, even without a .git file (fix round 2 TS-G)', async () => {
    const { repo, worktreesDir, path, branch, record } = await makeLane('orig-folder-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    // git still names the original path (as before a repair), and the user has made a folder there.
    writeFileSync(join(gitDir, 'gitdir'), `${join(path, '.git')}\n`)
    mkdirSync(path)
    writeFileSync(join(path, 'notes.txt'), 'mine\n')
    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.note).toBe(REATTACHED)
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('skipped')
    expect(outcomes[0]!.reason ?? '').toContain(REATTACHED)
    expect(readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()).toBe(join(path, '.git'))
    expect(existsSync(join(res.trashPath!, 'README.md'))).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)
    expect(readFileSync(join(path, 'notes.txt'), 'utf8')).toBe('mine\n')

    // Regatta repaired this entry when it trashed it, so a git folder naming the original path was pointed there by
    // someone else: it stays the user's even once nothing is at that path (a copy renamed away for a moment looks
    // the same; trash-4 review 2026-10-25 finding 1). The reason gives the one command that hands it back.
    rmSync(path, { recursive: true })
    const again = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
    expect(again).toHaveLength(1)
    expect(again[0]!.status).toBe('skipped')
    const reason = again[0]!.reason ?? ''
    expect(reason).toContain('which does not exist now')
    expect(existsSync(gitDir)).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)
    const command = reason.match(/run (git -C .*) to give it back to the trash/)?.[1]
    expect(command).toBeTruthy()
    execFileSync('/bin/sh', ['-c', command!], { stdio: 'ignore' })
    const last = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
    expect(last).toHaveLength(1)
    expect(last[0]!.status).toBe('deleted')
    expect(existsSync(gitDir)).toBe(false)
  })

  it('says how to give back an entry whose re-attached copy was deleted, and that command works (fix round 2 R1, N3)', async () => {
    const { repo, worktreesDir, branch, record } = await makeLane('gone-copy-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const rescued = join(temp('regatta-trash-gone-copy-'), 'rescued')
    cpSync(res.trashPath!, rescued, { recursive: true })
    sh(['worktree', 'repair', rescued], repo)
    rmSync(rescued, { recursive: true })
    // git's own prune does not help: the trash lock keeps the record.
    sh(['worktree', 'prune'], repo)
    expect(existsSync(gitDir)).toBe(true)

    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.note).toBe(REATTACHED)
    expect(listed[0]!.emptyError ?? '').toContain(`git now uses ${realpathSync(dirname(rescued))}/rescued, which does not exist now`)
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('skipped')
    const reason = outcomes[0]!.reason ?? ''
    expect(reason).toContain('which does not exist now')
    expect(existsSync(gitDir)).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)

    // Run exactly the command the reason gives, then Empty trash finishes the entry.
    const command = reason.match(/run (git -C .*) to give it back to the trash/)?.[1]
    expect(command).toBeTruthy()
    execFileSync('/bin/sh', ['-c', command!], { stdio: 'ignore' })
    const again = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
    expect(again).toHaveLength(1)
    expect(again[0]!.status).toBe('deleted')
    expect(existsSync(gitDir)).toBe(false)
    expect(branchThere(repo, branch)).toBe(false)
  })

  it('tells the user what to do with a duplicated entry whose git folder is gone (fix round 2 N3)', async () => {
    const { repo, worktreesDir, record } = await makeLane('dup-lane')
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const entry = dirname(res.trashPath!)
    const dup = join(dirname(entry), `${basename(entry)} copy`)
    cpSync(entry, dup, { recursive: true })
    const late = commitIn(res.trashPath!, 'late.txt', 'late\n')
    const first = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
    expect(first.find((o) => o.entryPath === entry)?.status).toBe('deleted')
    expect(sh(['rev-list', '--all'], repo)).toContain(late)
    const again = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
    const dupOutcome = again.find((o) => o.entryPath === dup)
    expect(dupOutcome?.reason ?? '').toContain('git keeps nothing of it here')
    expect(dupOutcome?.reason ?? '').toContain('delete it in Finder')
    expect(existsSync(join(dup, basename(res.trashPath!), 'README.md'))).toBe(true)
  })

  it('a crash at any step of Empty trash never leaves an entry listed as moved out, and the next one finishes it (fix round 2 N2)', async () => {
    const MOVED_OUT_NOTE = 'moved out of the trash; Regatta leaves it and its git records alone'
    let entryJsonDeletedAt = Number.POSITIVE_INFINITY
    for (let k = 1; ; k++) {
      const { repo, worktreesDir, record } = await makeLane(`crash-${k}`)
      const gitDir = realpathSync(record.identity!.split('|')[0]!)
      const res = await trashOwnedWorktree(record)
      expect(res.status).toBe('trashed')
      const entryDir = dirname(res.trashPath!)
      const work = commitIn(res.trashPath!, 'w.txt', `work ${k}\n`)
      // After the k-th delete, rename or write, every later one fails too: the disk is left as a crash leaves it.
      let n = 0
      let dead = false
      let where = ''
      const step = (what: string): void => {
        if (dead) throw new Error('stopped')
        n += 1
        if (what === `rm ${join(entryDir, 'entry.json')}`) entryJsonDeletedAt = Math.min(entryJsonDeletedAt, n)
        if (n === k) {
          dead = true
          where = what
          throw new Error('simulated crash')
        }
      }
      rmHook.fire = (p) => step(`rm ${p}`)
      rmHook.other = (op, p) => step(`${op} ${p}`)
      rmHook.open = (p, flags) => {
        if (flags === 'w') step(`write ${p}`)
      }
      try {
        await emptyTrash(worktreesDir, withRepoLock)
      } finally {
        rmHook.fire = null
        rmHook.other = null
        rmHook.open = null
      }
      if (!dead) break
      const listed = await listTrash(worktreesDir)
      for (const entry of listed) expect(entry.note ?? null, `crash ${k} at ${where}`).not.toBe(MOVED_OUT_NOTE)
      await emptyTrash(worktreesDir, withRepoLock)
      await emptyTrash(worktreesDir, withRepoLock)
      expect(sh(['rev-list', '--all'], repo), `crash ${k} at ${where}`).toContain(work)
      if (k <= entryJsonDeletedAt) {
        // Up to the delete of entry.json, Empty trash finishes the entry: nothing is left over.
        expect(readdirSync(join(realpathSync(worktreesDir), TRASH_DIR_NAME)), `crash ${k} at ${where}`).toEqual([])
        expect(existsSync(gitDir), `crash ${k} at ${where}`).toBe(false)
      }
    }
    expect(entryJsonDeletedAt).toBeLessThan(Number.POSITIVE_INFINITY)
  }, 240000)

  it('lists a stopped delete as unfinished, and as moved out once the user takes its folder out (fix round 2 N2)', async () => {
    const { repo, worktreesDir, branch, record } = await makeLane('stopped-delete-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const entryDir = dirname(res.trashPath!)
    const deleting = join(entryDir, '.regatta-deleting')
    // Regatta stops for good as it deletes the first file of the renamed folder (nothing renames it back).
    let dead = false
    rmHook.fire = (p) => {
      if (dead || inside(p, deleting)) {
        dead = true
        throw new Error('simulated crash')
      }
    }
    rmHook.other = (op) => {
      if (dead && op === 'rename') throw new Error('stopped')
    }
    try {
      await emptyTrash(worktreesDir, withRepoLock)
    } finally {
      rmHook.fire = null
      rmHook.other = null
    }
    expect(dead).toBe(true)
    expect(readdirSync(entryDir).sort()).toEqual(['.regatta-deleting', 'entry.json'])
    const listed = await listTrash(worktreesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.note).toBe(UNFINISHED)

    // The user takes the folder out and works in it: the entry is theirs to leave alone now.
    const taken = join(temp('regatta-trash-taken-'), 'taken')
    renameSync(deleting, taken)
    const after = await listTrash(worktreesDir)
    expect(after).toHaveLength(1)
    expect(after[0]!.note).toBe('moved out of the trash; Regatta leaves it and its git records alone')
    const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.status).toBe('skipped')
    expect(existsSync(gitDir)).toBe(true)
    expect(branchThere(repo, branch)).toBe(true)
    expect(sh(['status', '--short', '--branch'], taken)).toContain(`## ${branch}`)
  })

  // A disk image mounted inside a lane (no sudo needed): the volume is not part of the worktree.
  function makeImage(): string | null {
    const img = join(temp('regatta-trash-img-'), 'vol.dmg')
    try {
      execFileSync('hdiutil', ['create', '-size', '2m', '-fs', 'HFS+', '-volname', 'regatta-test', img, '-quiet'], { stdio: 'ignore' })
      return img
    } catch {
      return null
    }
  }
  function attachImage(img: string, mountpoint: string): string {
    const out = execFileSync('hdiutil', ['attach', img, '-mountpoint', mountpoint, '-nobrowse'], { encoding: 'utf8' })
    const disk = out.match(/\/dev\/disk\d+/)?.[0]
    if (!disk) throw new Error(`hdiutil attach named no disk: ${out}`)
    return disk
  }
  function detachImage(disk: string): void {
    // The mount point moves with the folder that holds it: unmount it where it is now, then detach the disk.
    const line = execFileSync('mount', [], { encoding: 'utf8' })
      .split('\n')
      .find((l) => l.startsWith(`${disk}s`) || l.startsWith(`${disk} `))
    const where = line?.match(/ on (.*) \(/)?.[1]
    if (where) {
      try {
        execFileSync('umount', [where], { stdio: 'ignore' })
      } catch {
        // hdiutil detach -force below.
      }
    }
    try {
      execFileSync('hdiutil', ['detach', disk, '-force', '-quiet'], { stdio: 'ignore' })
    } catch {
      // Already detached.
    }
  }
  function imageHolds(img: string, file: string): string | null {
    const check = temp('regatta-trash-img-check-')
    const disk = attachImage(img, check)
    try {
      return existsSync(join(check, file)) ? readFileSync(join(check, file), 'utf8') : null
    } finally {
      detachImage(disk)
    }
  }

  it.skipIf(process.platform !== 'darwin')('never deletes files on a volume mounted inside a trashed lane (fix round 2 N1)', async (ctx) => {
    const img = makeImage()
    if (!img) ctx.skip()
    const { repo, worktreesDir, path, branch, record } = await makeLane('mnt-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    const mp = join(path, 'mnt')
    mkdirSync(mp)
    let disk: string | null = attachImage(img!, mp)
    try {
      writeFileSync(join(mp, 'precious.txt'), 'on another volume\n')
      const res = await trashOwnedWorktree(record)
      expect(res.status).toBe('trashed')
      const trashPath = res.trashPath!
      const mpNow = join(trashPath, 'mnt')
      // The mount moved with the folder that holds it.
      expect(lstatSync(mpNow).dev).not.toBe(lstatSync(trashPath).dev)

      const listed = await listTrash(worktreesDir)
      expect(listed).toHaveLength(1)
      expect(listed[0]!.inUse.join(' ')).toContain(`a volume mounted at ${mpNow} (eject it first)`)
      const { outcomes } = await emptyTrash(worktreesDir, withRepoLock)
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.status).toBe('skipped')
      expect(outcomes[0]!.reason ?? '').toContain(`a volume is mounted at ${mpNow} inside it; eject it first`)
      expect(readFileSync(join(mpNow, 'precious.txt'), 'utf8')).toBe('on another volume\n')
      expect(existsSync(join(trashPath, '.git'))).toBe(true)
      expect(existsSync(join(trashPath, 'README.md'))).toBe(true)
      expect(existsSync(gitDir)).toBe(true)
      expect(branchThere(repo, branch)).toBe(true)
      expect((JSON.parse(readFileSync(join(dirname(trashPath), 'entry.json'), 'utf8')) as TrashEntryMeta).emptying).toBeUndefined()

      // Ejected, the entry empties, and the volume still holds its file.
      detachImage(disk)
      disk = null
      const again = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
      expect(again[0]!.status).toBe('deleted')
      expect(imageHolds(img!, 'precious.txt')).toBe('on another volume\n')
    } finally {
      if (disk) detachImage(disk)
    }
  }, 60000)

  it.skipIf(process.platform !== 'darwin')('stops before entering a volume mounted inside a lane while Empty trash deletes it (fix round 2 N1)', async (ctx) => {
    const img = makeImage()
    if (!img) ctx.skip()
    // Put the file on the volume first.
    const prep = temp('regatta-trash-img-prep-')
    const prepDisk = attachImage(img!, prep)
    try {
      writeFileSync(join(prep, 'precious.txt'), 'on another volume\n')
    } finally {
      detachImage(prepDisk)
    }
    const { repo, worktreesDir, path, branch, record } = await makeLane('late-mnt-lane')
    const gitDir = realpathSync(record.identity!.split('|')[0]!)
    mkdirSync(join(path, 'zz-mnt'))
    const res = await trashOwnedWorktree(record)
    expect(res.status).toBe('trashed')
    const trashPath = res.trashPath!
    const deleting = join(dirname(trashPath), '.regatta-deleting')
    // The volume is mounted after the last check, as the delete starts (the first file it deletes is .git).
    let disk: string | null = null
    rmHook.fire = (p) => {
      if (disk || !inside(p, deleting)) return
      disk = attachImage(img!, join(deleting, 'zz-mnt'))
    }
    try {
      let outcomes
      try {
        outcomes = (await emptyTrash(worktreesDir, withRepoLock)).outcomes
      } finally {
        rmHook.fire = null
      }
      expect(disk).not.toBeNull()
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.status).toBe('error')
      expect(outcomes[0]!.reason ?? '').toContain('a volume is mounted at')
      // What is left is back under its own name, the volume and its file untouched.
      expect(readFileSync(join(trashPath, 'zz-mnt', 'precious.txt'), 'utf8')).toBe('on another volume\n')
      expect(existsSync(deleting)).toBe(false)
      expect(existsSync(gitDir)).toBe(true)
      expect(branchThere(repo, branch)).toBe(true)
    } finally {
      if (disk) detachImage(disk)
    }
    expect(imageHolds(img!, 'precious.txt')).toBe('on another volume\n')
  }, 60000)
})
