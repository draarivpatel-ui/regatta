// Storage scan, leftover removal and license notices, against real git repositories, real processes
// and temp folders. Package: storage .

import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { LeftoverWorktree, StorageReport } from '../shared/types'
import { COPY_MARKER, provideModules, setGitOpsHooksSandbox } from './heats/git-ops'
import { emptyStorageTrash, licenseNotices, removeWorktrees, scanStorage, type StorageDeps } from './storage'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']
const REPOSITORY_GONE = 'Its repository is gone, so git cannot check it. Delete it in Finder if you are sure.'

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
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

/** A fresh repository with one commit: a README, and a .gitignore that hides `*.log` (and more when asked). */
function makeRepo(ignore = '*.log\n'): string {
  const dir = temp('regatta-storage-repo-')
  sh(['init', '-b', 'main'], dir)
  writeFileSync(join(dir, 'README.md'), '# regatta\n')
  writeFileSync(join(dir, '.gitignore'), ignore)
  sh(['add', '.'], dir)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], dir)
  return dir
}

/** Adds a worktree of `repo` at <worktreesDir>/<repoFolder>/<name>, on its own branch. */
function addWorktree(repo: string, worktreesDir: string, repoFolder: string, name: string, branch = `regatta/${name}`): string {
  const parent = join(worktreesDir, repoFolder)
  mkdirSync(parent, { recursive: true })
  const path = join(parent, name)
  sh(['worktree', 'add', '-b', branch, path, 'HEAD'], repo)
  return path
}

function deps(partial: Partial<StorageDeps> & Pick<StorageDeps, 'worktreesDir'>): StorageDeps {
  return {
    dataDir: partial.dataDir ?? temp('regatta-storage-data-'),
    worktreesDir: partial.worktreesDir,
    checkpointsDir: partial.checkpointsDir ?? temp('regatta-storage-cp-'),
    accountsDir: partial.accountsDir ?? temp('regatta-storage-accounts-'),
    inUse: partial.inUse ?? (() => [])
  }
}

function fileWithBytes(path: string, bytes: number): void {
  writeFileSync(path, 'x'.repeat(bytes))
}

function names(report: StorageReport): string[] {
  return report.leftovers.map((l) => basename(l.path))
}

function rowOf(report: StorageReport, name: string): LeftoverWorktree {
  const row = report.leftovers.find((l) => basename(l.path) === name)
  if (!row) throw new Error(`no leftover named ${name}; the scan lists: ${names(report).join(', ') || 'nothing'}`)
  return row
}

/** True when the repository still lists the folder (by real path) as one of its worktrees. */
function registered(repo: string, real: string): boolean {
  return sh(['worktree', 'list', '--porcelain'], repo).includes(`worktree ${real}`)
}

function branchExists(repo: string, branch: string): boolean {
  return sh(['branch', '--list', branch], repo).trim() !== ''
}

/** A program that stays in `cwd`, in its own session. */
function sleeper(cwd: string): ChildProcess {
  const child = spawn('sleep', ['120'], { cwd, detached: true, stdio: 'ignore' })
  child.unref()
  children.push(child)
  return child
}

function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
}

async function stop(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  process.kill(child.pid!, 'SIGKILL')
  await exited
}

const REAL_GIT = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()

/** Puts a `git` first on the PATH that writes down every call (arguments only) and then runs the real one. */
function logGit(): { calls: () => string[][]; stop: () => void } {
  const bin = temp('regatta-storage-gitlog-')
  const log = join(bin, 'calls.log')
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nline=$(printf '%s\\037' "$@")\nprintf '%s\\n' "$line" >> '${log}'\nexec '${REAL_GIT}' "$@"\n`,
    { mode: 0o755 }
  )
  const saved = process.env['PATH']
  process.env['PATH'] = `${bin}:${saved}`
  return {
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => withoutConfigPairs(line.split('\x1f').slice(0, -1)))
        : [],
    stop: () => {
      process.env['PATH'] = saved
    }
  }
}

/** A git call's arguments without the leading `-c key=value` pairs and `--no-optional-locks` flag the helpers add. */
function withoutConfigPairs(args: string[]): string[] {
  let i = 0
  while (args[i] === '-c' || args[i] === '--no-optional-locks') {
    i += args[i] === '-c' ? 2 : 1
  }
  return args.slice(i)
}

/**
 * Puts a `git` first on the PATH that runs `prelude` (shell) before the real one, and says when to take it
 * away. In the prelude, `$sub` and `$sub2` are the subcommand and its first argument, after any leading
 * `-c key=value` pairs and `--no-optional-locks`.
 */
function wrapGit(prelude: string): { stop: () => void } {
  const bin = temp('regatta-storage-wrap-')
  const words = `sub=''; sub2=''; skip=0\nfor a in "$@"; do\n  if [ $skip = 1 ]; then skip=0; continue; fi\n  if [ -z "$sub" ] && [ "$a" = "-c" ]; then skip=1; continue; fi\n  if [ -z "$sub" ] && [ "$a" = "--no-optional-locks" ]; then continue; fi\n  if [ -z "$sub" ]; then sub=$a; elif [ -z "$sub2" ]; then sub2=$a; fi\ndone\n`
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${words}${prelude}\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 })
  const saved = process.env['PATH']
  process.env['PATH'] = `${bin}:${saved}`
  return {
    stop: () => {
      process.env['PATH'] = saved
    }
  }
}

/** Writes into `folder` the marker provideModules leaves in a copy of node_modules: the folder's own inode and creation time. */
function markFolder(folder: string, content?: string): string {
  const stat = lstatSync(folder)
  const text = content ?? `${stat.ino}:${stat.birthtimeMs}\n`
  writeFileSync(join(folder, COPY_MARKER), text)
  return text
}

/** Runs `fn` with an environment variable set, then puts it back. */
async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

describe('scanStorage items', () => {
  it('measures each folder and reads a missing one as empty', async () => {
    const dataDir = temp('regatta-storage-items-data-')
    mkdirSync(join(dataDir, 'chats'), { recursive: true })
    fileWithBytes(join(dataDir, 'chats', 'a.txt'), 500)
    fileWithBytes(join(dataDir, 'nightwatch.json'), 100)
    // videos and models are not created, so those items read as an empty folder (0 bytes).

    const worktreesDir = temp('regatta-storage-items-wt-')
    fileWithBytes(join(worktreesDir, 'lorem.txt'), 1000)

    const checkpointsDir = temp('regatta-storage-items-cp-')
    fileWithBytes(join(checkpointsDir, 'snap'), 300)

    const report = await scanStorage(deps({ dataDir, worktreesDir, checkpointsDir }))
    const byId = new Map(report.items.map((i) => [i.id, i]))

    expect(byId.get('worktrees')?.bytes).toBe(1000)
    expect(byId.get('checkpoints')?.bytes).toBe(300)
    expect(byId.get('conversations')?.bytes).toBe(500)
    expect(byId.get('nights')?.bytes).toBe(100)
    expect(byId.get('videos')?.bytes).toBe(0)
    expect(byId.get('models')?.bytes).toBe(0)
    // Labels and the item order match the task card.
    expect(report.items.map((i) => i.label)).toEqual([
      'Worktrees',
      'Checkpoints',
      'Conversations',
      'Night reports',
      'Videos',
      'Dictation models',
      'Sign-ins'
    ])
    expect(report.items.find((i) => i.id === 'conversations')?.path).toBe(join(dataDir, 'chats'))
    expect(report.leftovers).toEqual([])
  }, 30000)

  it('tells a missing folder apart from one it cannot read', async () => {
    const dataDir = temp('regatta-storage-missing-vs-unreadable-')
    // Videos is never created: missing, so it measures 0 (an empty folder).
    const worktreesDir = temp('regatta-storage-missing-vs-unreadable-wt-')
    const checkpointsDir = temp('regatta-storage-unreadable-cp-')
    fileWithBytes(join(checkpointsDir, 'snap'), 300)
    chmodSync(checkpointsDir, 0o000) // exists, but cannot be listed: null, not 0.

    const report = await scanStorage(deps({ dataDir, worktreesDir, checkpointsDir }))
    const byId = new Map(report.items.map((i) => [i.id, i]))
    try {
      expect(byId.get('videos')?.bytes).toBe(0)
      if (process.getuid?.() !== 0) expect(byId.get('checkpoints')?.bytes).toBeNull()
    } finally {
      chmodSync(checkpointsDir, 0o755)
    }
  }, 30000)

  it('does not follow links when it adds up a folder', async () => {
    const outside = temp('regatta-storage-items-outside-')
    fileWithBytes(join(outside, 'big.bin'), 50_000)
    const worktreesDir = temp('regatta-storage-items-link-')
    fileWithBytes(join(worktreesDir, 'small.txt'), 10)
    symlinkSync(outside, join(worktreesDir, 'escape'))
    const report = await scanStorage(deps({ worktreesDir }))
    expect(report.items.find((i) => i.id === 'worktrees')?.bytes).toBe(10)
  }, 30000)
})

describe('scanStorage leftovers', () => {
  it('lists an unused worktree as removable and leaves out one that is in use', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-left-wt-')
    const keep = addWorktree(repo, worktreesDir, 'proj', 'keep')
    addWorktree(repo, worktreesDir, 'proj', 'gone')

    const report = await scanStorage(deps({ worktreesDir, inUse: () => [keep] }))
    expect(names(report)).toEqual(['gone'])

    const leftover = rowOf(report, 'gone')
    expect(leftover.branch).toBe('regatta/gone')
    expect(leftover.repo).toBe(realpathSync(repo))
    expect(leftover.removable).toBe(true)
    expect(leftover.reason).toBeNull()
    expect(leftover.bytes).toBeGreaterThan(0)
    expect(leftover.changedAt).toBeTypeOf('number')
  }, 30000)

  it('counts a folder inside a worktree that is in use as the worktree being in use', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-left-sub-')
    const used = addWorktree(repo, worktreesDir, 'proj', 'used')
    mkdirSync(join(used, 'deep'))
    addWorktree(repo, worktreesDir, 'proj', 'free')
    const report = await scanStorage(deps({ worktreesDir, inUse: () => [join(used, 'deep')] }))
    expect(names(report)).toEqual(['free'])
  }, 30000)

  it('lists worktrees at the two depths Regatta uses and nothing deeper, and never follows a link', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-left-shape-')
    // The panes' shape: <repo folder>/<name>.
    addWorktree(repo, worktreesDir, 'proj', 'real')
    // The shape heats, night watch and flows make: directly in the folder, on a branch or detached.
    const lane = join(worktreesDir, 'heat-7-claude')
    sh(['worktree', 'add', '-b', 'regatta/heat-7-claude', lane, 'HEAD'], repo)
    sh(['worktree', 'add', '--detach', join(worktreesDir, 'flow-9'), 'HEAD'], repo)
    // Not worktrees: a plain folder, and a worktree one level too deep.
    mkdirSync(join(worktreesDir, 'proj', 'plain'))
    writeFileSync(join(worktreesDir, 'proj', 'plain', 'file.txt'), 'not a worktree\n')
    addWorktree(repo, join(worktreesDir, 'proj'), 'group', 'deep')
    // A worktree is never entered: one made inside another is not listed, at either depth.
    sh(['worktree', 'add', '-b', 'regatta/inside-lane', join(lane, 'inner'), 'HEAD'], repo)
    sh(['worktree', 'add', '-b', 'regatta/inside-pane', join(worktreesDir, 'proj', 'real', 'inner'), 'HEAD'], repo)
    // A repository of someone's own is not a folder of worktrees, whatever is inside it.
    sh(['init', '-q', '-b', 'main', join(worktreesDir, 'a-repository')], worktreesDir)
    sh(['worktree', 'add', '-b', 'regatta/inside-repository', join(worktreesDir, 'a-repository', 'inner'), 'HEAD'], repo)
    // Worktrees that live elsewhere, reached through links at both depths and through a linked folder.
    const elsewhere = temp('regatta-storage-left-elsewhere-')
    const outside = addWorktree(repo, elsewhere, 'outside', 'away')
    symlinkSync(outside, join(worktreesDir, 'proj', 'linked'))
    symlinkSync(outside, join(worktreesDir, 'linked-lane'))
    symlinkSync(join(elsewhere, 'outside'), join(worktreesDir, 'linked-repo-folder'))
    // And aliases of worktrees that are in the folder: listed once, under their own name.
    symlinkSync(lane, join(worktreesDir, 'alias-of-lane'))
    symlinkSync(join(worktreesDir, 'proj', 'real'), join(worktreesDir, 'proj', 'alias-of-real'))

    const report = await scanStorage(deps({ worktreesDir }))
    expect(names(report)).toEqual(['flow-9', 'heat-7-claude', 'real'])
    expect(rowOf(report, 'heat-7-claude')).toMatchObject({ branch: 'regatta/heat-7-claude', repo: realpathSync(repo), removable: true, reason: null })
    expect(rowOf(report, 'flow-9')).toMatchObject({ branch: null, repo: realpathSync(repo) })
  }, 60000)

  it('keeps the rows in a stable order', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-left-order-')
    addWorktree(repo, worktreesDir, 'proj', 'charlie')
    addWorktree(repo, worktreesDir, 'proj', 'alpha')
    addWorktree(repo, worktreesDir, 'other', 'zulu')
    addWorktree(repo, worktreesDir, 'proj', 'bravo')
    // A folder 'a' with a worktree 'z' in it, and a worktree 'a-b' next to it: '-' sorts before '/'.
    addWorktree(repo, worktreesDir, 'a', 'z')
    sh(['worktree', 'add', '-b', 'regatta/a-b', join(worktreesDir, 'a-b'), 'HEAD'], repo)
    const report = await scanStorage(deps({ worktreesDir }))
    expect(report.leftovers.map((l) => l.path)).toEqual([...report.leftovers.map((l) => l.path)].sort())
    expect(names(report).sort()).toEqual(['a-b', 'alpha', 'bravo', 'charlie', 'z', 'zulu'])
  }, 60000)

  it('never follows a symlink inside a worktree when measuring', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-sym-wt-')
    const outside = temp('regatta-storage-sym-outside-')
    fileWithBytes(join(outside, 'big.bin'), 50_000)
    const path = addWorktree(repo, worktreesDir, 'proj', 'linky')
    // A link to a folder that lives far outside the worktree.
    symlinkSync(outside, join(path, 'escape'))

    const report = await scanStorage(deps({ worktreesDir }))
    // The two committed files only; the 50 KB behind the symlink is not counted.
    expect(rowOf(report, 'linky').bytes).toBeLessThan(10_000)
  }, 30000)
})

/** Leftover worktrees with uncommitted, untracked, ignored, skip-worktree or node_modules files move to Regatta's trash intact. */
const MOVED_TO_TRASH: { name: string; files: Record<string, string>; mutate: (path: string, repo: string) => void }[] = [
  {
    name: 'an edited file',
    files: { 'README.md': '# edited by hand\n' },
    mutate: (path) => writeFileSync(join(path, 'README.md'), '# edited by hand\n')
  },
  {
    name: 'an untracked file',
    files: { 'notes.txt': 'only copy\n' },
    mutate: (path) => writeFileSync(join(path, 'notes.txt'), 'only copy\n')
  },
  {
    name: 'an ignored file',
    files: { 'debug.log': 'git ignores this\n' },
    mutate: (path) => {
      writeFileSync(join(path, 'debug.log'), 'git ignores this\n')
      expect(sh(['status', '--porcelain'], path).trim()).toBe('')
    }
  },
  {
    name: 'a skip-worktree entry',
    files: { 'README.md': 'edited and hidden from git\n' },
    mutate: (path) => {
      sh(['update-index', '--skip-worktree', 'README.md'], path)
      writeFileSync(join(path, 'README.md'), 'edited and hidden from git\n')
      expect(sh(['status', '--porcelain'], path).trim()).toBe('')
    }
  },
  {
    name: 'a real node_modules folder',
    files: { 'node_modules/pkg.js': 'module.exports = 1\n' },
    mutate: (path) => {
      mkdirSync(join(path, 'node_modules'))
      writeFileSync(join(path, 'node_modules', 'pkg.js'), 'module.exports = 1\n')
    }
  }
]

describe('leftovers that are moved to trash vs kept', () => {
  for (const scenario of MOVED_TO_TRASH) {
    it(`moves a worktree with ${scenario.name} to Regatta's trash with every file intact`, async () => {
      const repo = makeRepo()
      const worktreesDir = temp('regatta-storage-trashed-')
      const path = addWorktree(repo, worktreesDir, 'proj', 'one')
      scenario.mutate(path, repo)
      const d = deps({ worktreesDir })

      const scanned = rowOf(await scanStorage(d), 'one')
      expect(scanned.removable).toBe(true)
      expect(scanned.reason).toBeNull()

      const after = await removeWorktrees(d, [path])
      expect(existsSync(path)).toBe(false)
      expect(names(after)).toEqual([])
      expect(after.trash).toHaveLength(1)
      const trashed = after.trash[0]!
      expect(basename(trashed.trashPath)).toBe('one')
      expect(registered(repo, realpathSync(trashed.trashPath))).toBe(true)
      for (const [file, content] of Object.entries(scenario.files)) {
        expect(readFileSync(join(trashed.trashPath, file), 'utf8')).toBe(content)
      }
      expect(branchExists(repo, 'regatta/one')).toBe(true)
    }, 60000)
  }

  it('keeps a worktree with a lock git put on it, in the scan and in a removal', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-kept-locked-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'one')
    const real = realpathSync(path)
    sh(['worktree', 'lock', '--reason', 'on a drive that is not always there', path], repo)
    const d = deps({ worktreesDir })

    const scanned = rowOf(await scanStorage(d), 'one')
    expect(scanned.removable).toBe(false)
    expect(scanned.reason).toContain('locked')

    const after = await removeWorktrees(d, [path])
    expect(existsSync(path)).toBe(true)
    expect(registered(repo, real)).toBe(true)
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# regatta\n')
    const row = rowOf(after, 'one')
    expect(row.removable).toBe(false)
    expect(row.reason).toContain('locked')
    expect(branchExists(repo, 'regatta/one')).toBe(true)
  }, 60000)

  it('moves a worktree whose detached HEAD holds a commit nothing else has to trash, after keeping that commit under refs/regatta/discarded', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-detached-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'one')
    sh(['checkout', '-q', '--detach'], path)
    writeFileSync(join(path, 'detached.txt'), 'made on a detached HEAD\n')
    sh(['add', '-A'], path)
    sh([...IDENTITY, 'commit', '-m', 'detached work'], path)
    const lost = sh(['rev-parse', 'HEAD'], path).trim()
    sh(['checkout', '-q', 'regatta/one'], path)
    expect(sh(['status', '--porcelain'], path).trim()).toBe('')
    const d = deps({ worktreesDir })

    expect(rowOf(await scanStorage(d), 'one').removable).toBe(true)
    const after = await removeWorktrees(d, [path])
    expect(existsSync(path)).toBe(false)
    expect(names(after)).toEqual([])
    expect(after.trash).toHaveLength(1)
    // The commit only the worktree's own history knew is held by a keep commit, through expiry and collection.
    const keeps = sh(['for-each-ref', '--format=%(refname)', 'refs/regatta/discarded/'], repo).trim().split('\n').filter(Boolean)
    expect(keeps).toHaveLength(1)
    sh(['reflog', 'expire', '--expire=now', '--all'], repo)
    sh(['gc', '--prune=now', '-q'], repo)
    expect(sh(['rev-list', keeps[0]!], repo).split('\n')).toContain(lost)
    expect(sh(['show', `${lost}:detached.txt`], repo)).toBe('made on a detached HEAD\n')
    // Its branch is not Storage's to delete.
    expect(branchExists(repo, 'regatta/one')).toBe(true)
  }, 60000)

  it('moves a worktree to trash while a program runs inside it, skips it when emptying trash until the program stops, and then deletes it', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-busy-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'one')
    mkdirSync(join(path, 'deep'))
    const program = sleeper(join(path, 'deep'))
    await started(program)
    const d = deps({ worktreesDir })

    const scanned = rowOf(await scanStorage(d), 'one')
    expect(scanned.removable).toBe(true)

    const moved = await removeWorktrees(d, [path])
    expect(existsSync(path)).toBe(false)
    expect(names(moved)).toEqual([])
    expect(moved.trash).toHaveLength(1)
    expect(moved.trash[0]!.inUse.join(' ')).toContain(String(program.pid))

    const whileBusy = await emptyStorageTrash(d)
    expect(whileBusy.outcomes.filter((o) => o.status === 'deleted')).toHaveLength(0)
    const skipped = whileBusy.outcomes.filter((o) => o.status === 'skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.reason).toContain('in use by')
    expect(skipped[0]!.reason).toContain(String(program.pid))
    expect(whileBusy.report.trash).toHaveLength(1)

    await stop(program)
    const done = await emptyStorageTrash(d)
    expect(done.outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(done.outcomes.filter((o) => o.status !== 'deleted')).toEqual([])
    expect(done.report.trash).toEqual([])
  }, 60000)

  it('keeps a worktree whose repository folder was deleted, with the reason from the card, and leaves the folder alone', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-gone-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'orphan')
    writeFileSync(join(path, 'precious.txt'), 'the only copy\n')
    rmSync(repo, { recursive: true, force: true })
    const d = deps({ worktreesDir })

    const scanned = rowOf(await scanStorage(d), 'orphan')
    expect(scanned.repo).toBeNull()
    expect(scanned.removable).toBe(false)
    expect(scanned.reason).toBe(REPOSITORY_GONE)

    const after = await removeWorktrees(d, [path])
    expect(readFileSync(join(path, 'precious.txt'), 'utf8')).toBe('the only copy\n')
    expect(existsSync(join(path, '.git'))).toBe(true)
    expect(rowOf(after, 'orphan').reason).toBe(REPOSITORY_GONE)
  }, 60000)

  it('keeps a worktree its repository no longer lists, such as one that was moved', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-moved-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'before')
    const moved = join(worktreesDir, 'proj', 'after')
    renameSync(path, moved)
    writeFileSync(join(moved, 'notes.txt'), 'made after the move\n')
    const d = deps({ worktreesDir })

    const scanned = rowOf(await scanStorage(d), 'after')
    expect(scanned.removable).toBe(false)
    expect(scanned.reason).toContain('does not list it')
    expect(scanned.reason).toContain('Delete it in Finder if you are sure.')
    expect(scanned.repo).toBe(realpathSync(repo))

    await removeWorktrees(d, [moved])
    expect(readFileSync(join(moved, 'notes.txt'), 'utf8')).toBe('made after the move\n')
  }, 60000)

  it('does not call a repository gone when git simply does not answer, and says so when only its registration is gone', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-unanswered-')
    addWorktree(repo, worktreesDir, 'proj', 'asked')
    const forgotten = addWorktree(repo, worktreesDir, 'proj', 'forgotten')
    rmSync(join(repo, '.git', 'worktrees', 'forgotten'), { recursive: true, force: true })
    const d = deps({ worktreesDir })

    const wrapped = wrapGit('if [ "$sub" = rev-parse ] && [ "$sub2" = --git-common-dir ]; then echo "fatal: simulated trouble" >&2; exit 128; fi')
    let report: StorageReport
    try {
      report = await scanStorage(d)
    } finally {
      wrapped.stop()
    }
    const asked = rowOf(report, 'asked')
    expect(asked.removable).toBe(false)
    expect(asked.reason).toBe('Regatta could not ask git about it (fatal: simulated trouble), so it was kept.')
    expect(asked.reason).not.toContain('gone')

    // The repository is there, it just does not know this worktree any more: not a gone repository either.
    const second = rowOf(await scanStorage(d), 'forgotten')
    expect(second.removable).toBe(false)
    expect(second.reason).toContain('does not list it')
    expect(second.reason).not.toContain('is gone')
    expect(second.repo).toBe(realpathSync(repo))
    expect(existsSync(forgotten)).toBe(true)
  }, 60000)

  it('sees programs in, and empties trashed worktrees from, folders whose names lsof writes as escapes, whatever the locale', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-escapes-')
    // A tab, a newline, a backslash, an accent, and an accent with a backslash.
    const odd = ['tab\tname', 'new\nline', 'back\\slash', 'caf\u00e9', 'caf\u00e9\\slash']
    const paths = odd.map((name, i) => addWorktree(repo, worktreesDir, 'proj', name, `regatta/odd-${i}`))
    const d = deps({ worktreesDir })

    await withEnv('LC_ALL', 'C', async () => {
      const moved = await removeWorktrees(d, paths)
      expect(names(moved)).toEqual([])
      expect(moved.trash).toHaveLength(odd.length)
      for (let index = 0; index < odd.length; index++) expect(branchExists(repo, `regatta/odd-${index}`)).toBe(true)

      const programs = moved.trash.map((entry) => sleeper(entry.trashPath))
      await Promise.all(programs.map((program) => started(program)))
      const busy = await scanStorage(d)
      for (const [index, entry] of busy.trash.entries()) {
        expect(entry.inUse.join(' '), JSON.stringify(basename(entry.trashPath))).toContain(String(programs[index]!.pid))
      }

      const whileBusy = await emptyStorageTrash(d)
      expect(whileBusy.outcomes.filter((o) => o.status === 'deleted')).toHaveLength(0)
      expect(whileBusy.outcomes.filter((o) => o.status === 'skipped')).toHaveLength(odd.length)
      for (const program of programs) await stop(program)

      const emptied = await emptyStorageTrash(d)
      expect(emptied.outcomes.filter((o) => o.status === 'deleted')).toHaveLength(odd.length)
      expect(emptied.report.trash).toEqual([])
    })
    for (let index = 0; index < odd.length; index++) expect(branchExists(repo, `regatta/odd-${index}`)).toBe(false)
  }, 120000)
})

describe('removeWorktrees', () => {
  function setup(): { repo: string; worktreesDir: string; clean: string; dirty: string; deps: StorageDeps } {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-rm-wt-')
    const clean = addWorktree(repo, worktreesDir, 'proj', 'clean')
    const dirty = addWorktree(repo, worktreesDir, 'proj', 'dirt')
    writeFileSync(join(dirty, 'loose.txt'), 'scratch\n')
    return { repo, worktreesDir, clean, dirty, deps: deps({ worktreesDir }) }
  }

  it('ignores input that is not a list of paths', async () => {
    const { deps: d, clean, dirty } = setup()
    const report = await removeWorktrees(d, [42, null, '', undefined, {}] as unknown as string[])
    await removeWorktrees(d, 'not a list' as unknown as string[])
    expect(existsSync(clean)).toBe(true)
    expect(existsSync(dirty)).toBe(true)
    expect(names(report).sort()).toEqual(['clean', 'dirt'])
  }, 60000)

  it('refuses a path outside the worktrees folder, even a real worktree that is clean', async () => {
    const { deps: d, repo, clean } = setup()
    const elsewhere = temp('regatta-storage-rm-outside-')
    const plain = join(elsewhere, 'notmine')
    mkdirSync(plain)
    writeFileSync(join(plain, 'file.txt'), 'not yours\n')
    const away = join(elsewhere, 'away')
    sh(['worktree', 'add', '-b', 'regatta/away', away, 'HEAD'], repo)
    const awayReal = realpathSync(away)

    const report = await removeWorktrees(d, [plain, away, join(elsewhere, 'missing')])
    expect(readFileSync(join(plain, 'file.txt'), 'utf8')).toBe('not yours\n')
    expect(existsSync(away)).toBe(true)
    expect(registered(repo, awayReal)).toBe(true)
    expect(names(report)).toContain(basename(clean))
  }, 60000)

  it('refuses the worktrees folder itself', async () => {
    const { deps: d, worktreesDir, clean, dirty } = setup()
    await removeWorktrees(d, [worktreesDir, join(worktreesDir, 'proj'), join(worktreesDir, '.')])
    expect(existsSync(worktreesDir)).toBe(true)
    expect(existsSync(clean)).toBe(true)
    expect(existsSync(dirty)).toBe(true)
  }, 60000)

  it('refuses a folder that is not in the scan', async () => {
    const { deps: d, repo, worktreesDir } = setup()
    const stray = join(worktreesDir, 'proj', 'plain')
    mkdirSync(stray)
    writeFileSync(join(stray, 'file.txt'), 'not a worktree\n')
    // A worktree one level too deep, and a link to a worktree outside the folder.
    const deep = addWorktree(repo, join(worktreesDir, 'proj'), 'group', 'deep')
    const away = addWorktree(repo, temp('regatta-storage-rm-away-'), 'other', 'away')
    const link = join(worktreesDir, 'proj', 'link')
    symlinkSync(away, link)

    const report = await removeWorktrees(d, [stray, deep, link])
    expect(readFileSync(join(stray, 'file.txt'), 'utf8')).toBe('not a worktree\n')
    expect(existsSync(deep)).toBe(true)
    expect(existsSync(away)).toBe(true)
    expect(registered(repo, realpathSync(away))).toBe(true)
    expect(names(report)).not.toContain('plain')
    expect(names(report)).not.toContain('deep')
  }, 60000)

  it('refuses a worktree that is in use', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-rm-used-')
    const used = addWorktree(repo, worktreesDir, 'proj', 'used')
    const d = deps({ worktreesDir, inUse: () => [used] })

    const report = await removeWorktrees(d, [used])
    expect(existsSync(used)).toBe(true)
    expect(names(report)).not.toContain('used')
  }, 30000)

  it('looks at what is in use again right before it removes, not only at the start', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-rm-late-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'late')
    let calls = 0
    // A pane takes the worktree over while the removal is under way.
    const d = deps({ worktreesDir, inUse: () => (++calls >= 2 ? [path] : []) })

    await removeWorktrees(d, [path])
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(existsSync(path)).toBe(true)
    expect(registered(repo, realpathSync(path))).toBe(true)
  }, 30000)

  it('keeps everything when it cannot tell what is in use', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-rm-unknown-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'one')
    const d = deps({
      worktreesDir,
      inUse: () => {
        throw new Error('the pane list is not available')
      }
    })
    const scanned = rowOf(await scanStorage(d), 'one')
    expect(scanned.removable).toBe(false)
    await removeWorktrees(d, [path])
    expect(existsSync(path)).toBe(true)
  }, 30000)

  it('moves a clean worktree to trash, keeps its branch while in trash, stops listing it as a leftover, and deletes its regatta/* branch when emptying trash', async () => {
    const { deps: d, clean, repo } = setup()
    const real = realpathSync(clean)
    const report = await removeWorktrees(d, [clean])

    expect(existsSync(clean)).toBe(false)
    expect(branchExists(repo, 'regatta/clean')).toBe(true)
    expect(registered(repo, real)).toBe(false)
    expect(report.trash).toHaveLength(1)
    expect(registered(repo, realpathSync(report.trash[0]!.trashPath))).toBe(true)
    expect(names(report)).not.toContain('clean')
    expect(names(report)).toContain('dirt')

    const emptied = await emptyStorageTrash(d)
    expect(emptied.outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(emptied.report.trash).toEqual([])
    expect(branchExists(repo, 'regatta/clean')).toBe(false)
  }, 30000)

  it.skipIf(process.platform !== 'darwin')('moves a worktree with Regatta\'s copied node_modules and user files to trash, and unlinks the copy safely when emptying trash', async () => {
    const repo = makeRepo()
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    const worktreesDir = temp('regatta-storage-copy-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'one')
    const provided = await provideModules(repo, path)
    expect(provided.clone).not.toBeNull()
    writeFileSync(join(path, 'node_modules', 'pkg', 'index.js'), 'changed inside the copy\n')
    mkdirSync(join(path, 'node_modules', 'newpkg'))
    writeFileSync(join(path, 'MINE.txt'), 'mine\n')
    const d = deps({ worktreesDir })
    expect(rowOf(await scanStorage(d), 'one')).toMatchObject({ removable: true, reason: null })

    const report = await removeWorktrees(d, [path])
    expect(existsSync(path)).toBe(false)
    expect(names(report)).toEqual([])
    expect(report.trash).toHaveLength(1)
    expect(readFileSync(join(report.trash[0]!.trashPath, 'MINE.txt'), 'utf8')).toBe('mine\n')
    expect(branchExists(repo, 'regatta/one')).toBe(true)

    const emptied = await emptyStorageTrash(d)
    expect(emptied.outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(emptied.report.trash).toEqual([])
    expect(readFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(readdirSync(join(worktreesDir, 'proj')).filter((name) => name.includes('modules') || name.startsWith('.regatta'))).toEqual([])
    expect(branchExists(repo, 'regatta/one')).toBe(false)
  }, 60000)

  it.skipIf(process.getuid?.() === 0)('says why when the parent folder is read-only and the worktree cannot be moved to trash, and loses nothing', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-rm-readonly-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'locked-folder')
    const parent = join(worktreesDir, 'proj')
    const d = deps({ worktreesDir })
    expect(rowOf(await scanStorage(d), 'locked-folder').removable).toBe(true)
    chmodSync(parent, 0o555)
    try {
      const report = await removeWorktrees(d, [path])
      expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# regatta\n')
      expect(branchExists(repo, 'regatta/locked-folder')).toBe(true)
      const row = rowOf(report, 'locked-folder')
      expect(row.removable).toBe(false)
      expect(row.reason).toMatch(/permission denied/i)
    } finally {
      chmodSync(parent, 0o755)
    }
  }, 60000)

  it('preserves a file that appeared between the scan and the removal inside the trashed worktree', async () => {
    const { deps: d, clean } = setup()
    expect(rowOf(await scanStorage(d), 'clean').removable).toBe(true)
    writeFileSync(join(clean, 'late.txt'), 'made after the scan\n')

    const report = await removeWorktrees(d, [clean])
    expect(existsSync(clean)).toBe(false)
    expect(report.trash).toHaveLength(1)
    expect(readFileSync(join(report.trash[0]!.trashPath, 'late.txt'), 'utf8')).toBe('made after the scan\n')
  }, 60000)

  it('moves unlocked worktrees (clean or dirty) to trash and keeps locked ones in one call', async () => {
    const { deps: d, repo, clean, dirty, worktreesDir } = setup()
    const locked = addWorktree(repo, worktreesDir, 'proj', 'locked')
    sh(['worktree', 'lock', '--reason', 'pinned', locked], repo)
    const report = await removeWorktrees(d, [dirty, clean, clean, locked])
    expect(existsSync(clean)).toBe(false)
    expect(existsSync(dirty)).toBe(false)
    expect(existsSync(locked)).toBe(true)
    expect(names(report)).toEqual(['locked'])
    expect(report.trash.map((t) => basename(t.trashPath)).sort()).toEqual(['clean', 'dirt'])
    const dirtTrash = report.trash.find((t) => basename(t.trashPath) === 'dirt')!
    expect(readFileSync(join(dirtTrash.trashPath, 'loose.txt'), 'utf8')).toBe('scratch\n')
    const row = rowOf(report, 'locked')
    expect(row.removable).toBe(false)
    expect(row.reason).toContain('locked')
    expect(branchExists(repo, 'regatta/clean')).toBe(true)
    expect(branchExists(repo, 'regatta/dirt')).toBe(true)
    expect(branchExists(repo, 'regatta/locked')).toBe(true)
  }, 60000)

  it('works when the repository folder is not the parent of a .git folder: a bare repository and a separate git dir', async () => {
    const source = makeRepo()
    const home = temp('regatta-storage-rm-shapes-')
    const worktreesDir = join(home, 'wts')
    const bare = join(home, 'bare.git')
    sh(['clone', '-q', '--bare', source, bare], home)
    const fromBare = addWorktree(bare, worktreesDir, 'proj', 'from-bare')
    const separate = join(home, 'separate.git')
    const work = join(home, 'work')
    sh(['init', '-q', '-b', 'main', '--separate-git-dir', separate, work], home)
    writeFileSync(join(work, 'README.md'), '# regatta\n')
    sh(['add', '.'], work)
    sh([...IDENTITY, 'commit', '-m', 'first commit'], work)
    const fromSeparate = addWorktree(work, worktreesDir, 'proj', 'from-separate')
    const d = deps({ worktreesDir })

    const scanned = await scanStorage(d)
    expect(rowOf(scanned, 'from-bare')).toMatchObject({ repo: realpathSync(bare), removable: true, reason: null })
    expect(rowOf(scanned, 'from-separate')).toMatchObject({ repo: realpathSync(separate), removable: true, reason: null })
    writeFileSync(join(fromSeparate, 'notes.txt'), 'mine\n')

    const report = await removeWorktrees(d, [fromBare, fromSeparate])
    expect(existsSync(fromBare)).toBe(false)
    expect(existsSync(fromSeparate)).toBe(false)
    expect(branchExists(bare, 'regatta/from-bare')).toBe(true)
    expect(names(report)).toEqual([])
    expect(report.trash.map((t) => basename(t.trashPath)).sort()).toEqual(['from-bare', 'from-separate'])
    const sepTrash = report.trash.find((t) => basename(t.trashPath) === 'from-separate')!
    expect(readFileSync(join(sepTrash.trashPath, 'notes.txt'), 'utf8')).toBe('mine\n')
  }, 60000)

  it('moves a worktree whose node_modules link is committed to the repository to trash without unlinking it first, and empties it safely', async () => {
    const repo = makeRepo()
    const modules = temp('regatta-storage-rm-tracked-modules-')
    writeFileSync(join(modules, 'pkg.js'), 'module.exports = 1\n')
    symlinkSync(modules, join(repo, 'node_modules'), 'dir')
    sh(['add', '-f', 'node_modules'], repo)
    sh([...IDENTITY, 'commit', '-m', 'commit the link'], repo)
    const worktreesDir = temp('regatta-storage-rm-tracked-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'one')
    const d = deps({ worktreesDir })
    expect(rowOf(await scanStorage(d), 'one').removable).toBe(true)

    const report = await removeWorktrees(d, [path])
    expect(existsSync(path)).toBe(false)
    expect(names(report)).toEqual([])
    expect(report.trash).toHaveLength(1)
    expect(branchExists(repo, 'regatta/one')).toBe(true)
    await emptyStorageTrash(d)
    expect(readFileSync(join(modules, 'pkg.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(branchExists(repo, 'regatta/one')).toBe(false)
  }, 60000)

  it('never looks inside a worktree: one made inside a heat lane is not offered, and moving the lane to trash moves the inner folder intact', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-rm-nested-')
    const lane = join(worktreesDir, 'heat-1-claude')
    sh(['worktree', 'add', '-b', 'regatta/heat-1-claude', lane, 'HEAD'], repo)
    const inner = join(lane, 'inner')
    sh(['worktree', 'add', '-b', 'regatta/inner', inner, 'HEAD'], repo)
    writeFileSync(join(inner, 'work.txt'), 'in the inner worktree\n')

    // In use, the lane is not listed at all, and nothing inside it is either.
    const open = deps({ worktreesDir, inUse: () => [lane] })
    expect(names(await scanStorage(open))).toEqual([])
    await removeWorktrees(open, [lane, inner])
    expect(existsSync(lane)).toBe(true)
    expect(existsSync(inner)).toBe(true)

    // Not in use, only the lane is listed as a leftover; inner is never removable on its own.
    const idle = deps({ worktreesDir })
    const row = rowOf(await scanStorage(idle), 'heat-1-claude')
    expect(names(await scanStorage(idle))).toEqual(['heat-1-claude'])
    expect(row.removable).toBe(true)
    await removeWorktrees(idle, [inner])
    expect(existsSync(inner)).toBe(true)
    const after = await removeWorktrees(idle, [lane])
    expect(existsSync(lane)).toBe(false)
    expect(after.trash).toHaveLength(1)
    expect(readFileSync(join(after.trash[0]!.trashPath, 'inner', 'work.txt'), 'utf8')).toBe('in the inner worktree\n')
  }, 60000)

  it('moves worktrees at both depths in one call to trash: a pane worktree, a heat lane, a detached temporary one, and one with uncommitted files', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-rm-depths-')
    const pane = addWorktree(repo, worktreesDir, 'proj', 'one')
    const lane = join(worktreesDir, 'heat-3-codex')
    sh(['worktree', 'add', '-b', 'regatta/heat-3-codex', lane, 'HEAD'], repo)
    const temporary = join(worktreesDir, 'flow-5-check-1')
    sh(['worktree', 'add', '--detach', temporary, 'HEAD'], repo)
    const dirtyLane = join(worktreesDir, 'heat-3-claude')
    sh(['worktree', 'add', '-b', 'regatta/heat-3-claude', dirtyLane, 'HEAD'], repo)
    writeFileSync(join(dirtyLane, 'half-done.txt'), 'not committed\n')
    const reals = [pane, lane, temporary, dirtyLane].map((path) => realpathSync(path))
    const d = deps({ worktreesDir })

    const scanned = await scanStorage(d)
    expect(names(scanned)).toEqual(['flow-5-check-1', 'heat-3-claude', 'heat-3-codex', 'one'])
    expect(scanned.leftovers.filter((l) => l.removable).map((l) => basename(l.path))).toEqual(['flow-5-check-1', 'heat-3-claude', 'heat-3-codex', 'one'])

    const report = await removeWorktrees(d, [pane, lane, temporary, dirtyLane])
    for (const path of [pane, lane, temporary, dirtyLane]) expect(existsSync(path)).toBe(false)
    for (const real of reals) expect(registered(repo, real)).toBe(false)
    expect(names(report)).toEqual([])
    expect(report.trash.map((t) => basename(t.trashPath)).sort()).toEqual(['flow-5-check-1', 'heat-3-claude', 'heat-3-codex', 'one'])
    const trashedDirty = report.trash.find((t) => basename(t.trashPath) === 'heat-3-claude')!
    expect(readFileSync(join(trashedDirty.trashPath, 'half-done.txt'), 'utf8')).toBe('not committed\n')
    for (const branch of ['regatta/one', 'regatta/heat-3-codex', 'regatta/heat-3-claude']) expect(branchExists(repo, branch)).toBe(true)
  }, 60000)

  it('never prunes the repository: an unrelated, renamed worktree keeps its registration and reflog', async () => {
    const { deps: d, repo, clean } = setup()
    const users = join(temp('regatta-storage-rm-users-'), 'users')
    sh(['worktree', 'add', '-b', 'users-branch', users, 'main'], repo)
    const renamed = `${users}-renamed`
    renameSync(users, renamed)
    const registration = join(repo, '.git', 'worktrees', 'users')
    expect(existsSync(join(registration, 'logs', 'HEAD'))).toBe(true)

    await removeWorktrees(d, [clean])
    expect(existsSync(clean)).toBe(false)
    expect(existsSync(registration)).toBe(true)
    expect(existsSync(join(registration, 'logs', 'HEAD'))).toBe(true)
    expect(existsSync(renamed)).toBe(true)
  }, 60000)

  it('repairs git registration into trash and never calls worktree remove, --force, prune or branch deletion during removeWorktrees', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-shim-wt-')
    const clean = addWorktree(repo, worktreesDir, 'proj', 'clean')
    const others = ['untracked', 'edited', 'locked', 'busy'].map((name) => addWorktree(repo, worktreesDir, 'proj', name))
    writeFileSync(join(others[0]!, 'notes.txt'), 'mine\n')
    writeFileSync(join(others[1]!, 'README.md'), '# edited\n')
    sh(['worktree', 'lock', others[2]!], repo)
    const program = sleeper(others[3]!)
    await started(program)
    const d = deps({ worktreesDir })

    const shim = logGit()
    let report: StorageReport
    try {
      await scanStorage(d)
      report = await removeWorktrees(d, [clean, ...others])
    } finally {
      shim.stop()
    }
    await stop(program)

    expect(existsSync(clean)).toBe(false)
    expect(existsSync(others[0]!)).toBe(false)
    expect(existsSync(others[1]!)).toBe(false)
    expect(existsSync(others[2]!)).toBe(true)
    expect(existsSync(others[3]!)).toBe(false)
    expect(names(report)).toEqual(['locked'])
    expect(report.trash.map((t) => basename(t.trashPath)).sort()).toEqual(['busy', 'clean', 'edited', 'untracked'])

    const calls = shim.calls()
    expect(calls.length).toBeGreaterThan(0)
    const removals = calls.filter((c) => c[0] === 'worktree' && c[1] === 'remove')
    expect(removals).toEqual([])
    const repairs = calls.filter((c) => c[0] === 'worktree' && c[1] === 'repair')
    expect(repairs).toHaveLength(4)
    for (const call of calls) {
      expect(call, call.join(' ')).not.toContain('prune')
      expect(call, call.join(' ')).not.toContain('--force')
      expect(call, call.join(' ')).not.toContain('-f')
      expect(call, call.join(' ')).not.toContain('-ff')
      expect(['branch', 'gc', 'clean', 'reset', 'checkout', 'restore', 'switch', 'rm', 'stash', 'push']).not.toContain(call[0])
      if (call[0] === 'update-ref') {
        expect(call.slice(1, 2)[0], call.join(' ')).toMatch(/^refs\/regatta\/discarded\//)
        expect(call, call.join(' ')).not.toContain('-d')
        expect(call, call.join(' ')).not.toContain('--no-deref')
      }
      if (call[0] === 'reflog') expect(['expire', 'delete']).not.toContain(call[1])
    }
    expect(calls.some((c) => c.includes('--no-deref') || c.includes('-d') || c.includes('-D'))).toBe(false)
    expect(calls.filter((c) => c[0] === 'update-ref')).toHaveLength(4)
    for (const name of ['clean', 'untracked', 'edited', 'locked', 'busy']) expect(branchExists(repo, `regatta/${name}`)).toBe(true)
  }, 90000)

  it('delegates trash operations to git-ops and never calls rm, unlink, --force, prune or branch deletion directly in storage.ts', () => {
    const source = readFileSync(new URL('./storage.ts', import.meta.url), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
    expect(code).toContain('trashOwnedWorktree')
    expect(code).toContain('listTrash')
    expect(code).toContain('emptyTrash')
    for (const forbidden of [/\brm(Sync)?\(/, /\brmdir/i, /\bunlink/i, /rimraf/i, /--force/, /['"]-f{1,2}['"]/, /prune/i, /['"]branch['"]/, /update-ref/, /deleteOwnedBranch/]) {
      expect(code, String(forbidden)).not.toMatch(forbidden)
    }
  })
})

describe('removal with git routing variables in the app environment, and per-worktree pseudo refs (V4 findings 1 and 2)', () => {
  for (const name of ['GIT_WORK_TREE', 'GIT_DIR', 'GIT_INDEX_FILE']) {
    it(`moves a worktree holding an ignored file with content to trash intact when ${name} points at the project`, async () => {
      const repo = makeRepo()
      const worktreesDir = temp('regatta-storage-routing-')
      const path = addWorktree(repo, worktreesDir, 'proj', 'one')
      writeFileSync(join(path, 'notes.log'), 'uncommitted notes\n')
      const d = deps({ worktreesDir })
      const saved = process.env[name]
      process.env[name] = name === 'GIT_WORK_TREE' ? repo : name === 'GIT_DIR' ? join(repo, '.git') : join(repo, '.git', 'index')
      let after: StorageReport
      try {
        const scanned = rowOf(await scanStorage(d), 'one')
        expect(scanned.removable).toBe(true)
        after = await removeWorktrees(d, [path])
      } finally {
        if (saved === undefined) delete process.env[name]
        else process.env[name] = saved
      }
      expect(existsSync(path)).toBe(false)
      expect(after.trash).toHaveLength(1)
      expect(readFileSync(join(after.trash[0]!.trashPath, 'notes.log'), 'utf8')).toBe('uncommitted notes\n')
    }, 60000)
  }

  it('keeps commits that only ORIG_HEAD or FETCH_HEAD of the removed worktree hold', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-pseudo-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'one')
    sh(['checkout', '-q', '--detach'], path)
    writeFileSync(join(path, 'detached.txt'), 'only ORIG_HEAD knows this\n')
    sh(['add', '-A'], path)
    sh([...IDENTITY, 'commit', '-m', 'detached work'], path)
    const viaOrigHead = sh(['rev-parse', 'HEAD'], path).trim()
    sh(['reset', '-q', '--hard', 'HEAD~1'], path)
    const other = makeRepo()
    writeFileSync(join(other, 'other.txt'), 'from another repository\n')
    sh(['add', '-A'], other)
    sh([...IDENTITY, 'commit', '-m', 'only in another repository'], other)
    const viaFetchHead = sh(['rev-parse', 'HEAD'], other).trim()
    sh(['fetch', '-q', other, 'main'], path)
    sh(['reflog', 'expire', '--expire=now', '--all'], path)
    const d = deps({ worktreesDir })

    await removeWorktrees(d, [path])
    expect(existsSync(path)).toBe(false)
    await emptyStorageTrash(d)
    sh(['reflog', 'expire', '--expire=now', '--all'], repo)
    sh(['gc', '--prune=now', '-q'], repo)
    const keeps = sh(['for-each-ref', '--format=%(refname)', 'refs/regatta/discarded/'], repo).trim().split('\n').filter(Boolean)
    expect(keeps.length).toBeGreaterThanOrEqual(1)
    const reachable = sh(['rev-list', ...keeps], repo).split('\n')
    expect(reachable).toContain(viaOrigHead)
    expect(reachable).toContain(viaFetchHead)
  }, 60000)
})

describe('licenseNotices', () => {
  it('lists the runtime dependencies plus Electron, ignoring dev dependencies', async () => {
    const appPath = temp('regatta-storage-app-')
    writeFileSync(
      join(appPath, 'package.json'),
      JSON.stringify({
        name: 'demo',
        dependencies: { react: '19.3.1', '@acme/tool': '2.0.0' },
        devDependencies: { secret: '9.9.9' }
      })
    )
    mkdirSync(join(appPath, 'node_modules', 'react'), { recursive: true })
    writeFileSync(join(appPath, 'node_modules', 'react', 'package.json'), JSON.stringify({ version: '19.3.1', license: 'MIT' }))
    mkdirSync(join(appPath, 'node_modules', '@acme', 'tool'), { recursive: true })
    writeFileSync(
      join(appPath, 'node_modules', '@acme', 'tool', 'package.json'),
      JSON.stringify({ version: '2.0.0', license: { type: 'Apache-2.0' } })
    )
    mkdirSync(join(appPath, 'node_modules', 'secret'), { recursive: true })
    writeFileSync(join(appPath, 'node_modules', 'secret', 'package.json'), JSON.stringify({ version: '9.9.9', license: 'MIT' }))
    mkdirSync(join(appPath, 'node_modules', 'electron'), { recursive: true })
    writeFileSync(join(appPath, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: '44.7.2' }))

    const notices = await licenseNotices(appPath)
    const react = notices.find((n) => /react/i.test(n.name))
    const electron = notices.find((n) => /electron/i.test(n.name))
    const acme = notices.find((n) => n.name === '@acme/tool')

    expect(react?.version).toBe('19.3.1')
    expect(react?.license).toBe('MIT')
    expect(acme?.license).toBe('Apache-2.0')
    expect(electron?.license).toBe('MIT')
    expect(electron?.version).toBe('44.7.2')
    // Dev dependencies are not shipped, so they are not listed.
    expect(notices.some((n) => n.name === 'secret')).toBe(false)
    // Sorted by name.
    const listed = notices.map((n) => n.name)
    expect(listed).toEqual([...listed].sort((a, b) => a.localeCompare(b)))
  }, 15000)

  it('reads this project: every runtime dependency with its installed version, and Electron', async () => {
    const root = process.cwd()
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    const notices = await licenseNotices(root)
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const installed = JSON.parse(readFileSync(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { version: string }
      expect(notices.find((n) => n.name === name)?.version, name).toBe(installed.version)
    }
    const installedElectron = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')) as { version: string }
    expect(notices.find((n) => n.name === 'Electron')).toEqual({ name: 'Electron', version: installedElectron.version, license: 'MIT' })
  }, 15000)
})

describe('Storage never runs user hooks or filters during scanStorage, removeWorktrees or emptyStorageTrash (V6 finding 1)', () => {
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

  it('moves leftovers to trash and empties trash without running post-index-change or reference-transaction hooks', async () => {
    for (const scope of ['local', 'global'] as const) {
      const repo = makeRepo()
      const worktreesDir = temp(`regatta-storage-v6-${scope}-`)
      const path = addWorktree(repo, worktreesDir, 'proj', 'one')

      const box = temp(`regatta-storage-v6-hooks-${scope}-`)
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

      const future = new Date(Date.now() + 10_000)
      utimesSync(join(path, 'README.md'), future, future)

      const sandbox = join(box, 'regatta-empty-hooks')
      setGitOpsHooksSandbox(sandbox)
      try {
        await withIsolatedGitConfig(gitconfig, async () => {
          const d = deps({ worktreesDir })
          const report = await scanStorage(d)
          expect(rowOf(report, 'one').removable, scope).toBe(true)

          const after = await removeWorktrees(d, [path])
          expect(after.leftovers, scope).toEqual([])
          expect(existsSync(path), scope).toBe(false)
          expect(after.trash, scope).toHaveLength(1)

          const emptied = await emptyStorageTrash(d)
          expect(emptied.outcomes.filter((o) => o.status === 'deleted'), scope).toHaveLength(1)
          expect(emptied.report.trash, scope).toEqual([])

          // Neither hook ever ran or wrote its marker, and removal finished before `release` was written.
          expect(existsSync(markers.postIndexMarker), scope).toBe(false)
          expect(existsSync(markers.refTxMarker), scope).toBe(false)
        })
      } finally {
        writeFileSync(markers.release, '')
        setGitOpsHooksSandbox(temp('regatta-storage-default-hooks-'))
      }
    }
  }, 60000)

  it('refuses removeWorktrees and keeps the leftover when the hooks sandbox folder is not empty', async () => {
    const repo = makeRepo()
    const worktreesDir = temp('regatta-storage-v6-polluted-')
    const path = addWorktree(repo, worktreesDir, 'proj', 'one')
    const polluted = temp('regatta-storage-polluted-hooks-')
    writeFileSync(join(polluted, 'post-index-change'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    setGitOpsHooksSandbox(polluted)
    try {
      const d = deps({ worktreesDir })
      const after = await removeWorktrees(d, [path])
      expect(existsSync(path)).toBe(true)
      const row = rowOf(after, 'one')
      expect(row.removable).toBe(false)
      expect(row.reason).toContain('hooks folder is not empty')
    } finally {
      setGitOpsHooksSandbox(temp('regatta-storage-clean-hooks-'))
    }
  }, 30000)

  it('never runs clean or process filters during scanStorage, removeWorktrees or emptyStorageTrash', async () => {
    for (const kind of ['clean', 'process'] as const) {
      const repo = makeRepo()
      writeFileSync(join(repo, '.gitattributes'), 'README.md filter=lfs\n')
      sh(['add', '.gitattributes'], repo)
      sh([...IDENTITY, 'commit', '-m', 'use lfs filter'], repo)

      const worktreesDir = temp(`regatta-storage-v7-wt-${kind}-`)
      const path = addWorktree(repo, worktreesDir, 'proj', 'one')
      const future = new Date(Date.now() + 10_000)
      utimesSync(join(path, 'README.md'), future, future)

      const box = temp(`regatta-storage-v7-filter-${kind}-`)
      const marker = join(box, 'filter-ran')
      const hookMarker = join(box, 'hook-ran')
      const release = join(box, 'release')
      const filterScript = join(box, 'filter.sh')
      const hookScript = join(box, 'hook.sh')
      writeFileSync(
        filterScript,
        `#!/bin/sh\n: > '${marker}'\ni=0\nwhile [ ! -e '${release}' ] && [ $i -lt 30 ]; do sleep 0.05; i=$((i+1)); done\ncat\n`,
        { mode: 0o755 }
      )
      writeFileSync(hookScript, `#!/bin/sh\n: > '${hookMarker}'\nexit 0\n`, { mode: 0o755 })

      const gitconfig = join(box, 'gitconfig')
      writeFileSync(
        gitconfig,
        `[user]\n\tname = Regatta Test\n\temail = test@regatta.local\n` +
          `[filter "lfs"]\n` +
          (kind === 'clean'
            ? `\tclean = ${filterScript}\n\tsmudge = ${filterScript}\n\trequired = true\n`
            : `\tprocess = ${filterScript}\n\trequired = true\n`) +
          `[hook "spy"]\n\tcommand = ${hookScript}\n\tevent = post-index-change\n\tevent = reference-transaction\n`
      )

      try {
        await withIsolatedGitConfig(gitconfig, async () => {
          const d = deps({ worktreesDir })
          const scanned = await scanStorage(d)
          const row = rowOf(scanned, 'one')
          expect(row.removable, kind).toBe(true)

          const after = await removeWorktrees(d, [path])
          expect(after.leftovers, kind).toEqual([])
          expect(after.trash, kind).toHaveLength(1)
          expect(existsSync(path), kind).toBe(false)

          const emptied = await emptyStorageTrash(d)
          expect(emptied.outcomes.filter((o) => o.status === 'deleted'), kind).toHaveLength(1)

          expect(existsSync(marker), kind).toBe(false)
          expect(existsSync(hookMarker), kind).toBe(false)
        })
      } finally {
        writeFileSync(release, '')
      }
    }
  }, 60000)
})
