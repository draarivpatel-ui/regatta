// Unit tests for moving lane worktrees to Regatta's trash and emptying trash in Settings > Storage.

import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  chmodSync,
  closeSync,
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
import { afterAll, describe, expect, it } from 'vitest'
import {
  addDetachedWorktree,
  addWorktree,
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

    // Point B's gitdir file at another path, and C's gitdir file at the folder without /.git.
    const otherTarget = join(temp('regatta-trash-other-gitdir-'), '.git')
    writeFileSync(join(gitDirB, 'gitdir'), `${otherTarget}\n`)
    writeFileSync(join(gitDirC, 'gitdir'), `${realpathSync(trashedC.trashPath!)}\n`)

    const { outcomes } = await emptyTrash(worktreesDir)
    expect(outcomes.every((o) => o.status === 'deleted')).toBe(true)

    // Repaired entry A's git folder is deleted; B and C keep their git folders because gitdir did not match <folder>/.git.
    expect(existsSync(gitDirA)).toBe(false)
    expect(existsSync(gitDirB)).toBe(true)
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

