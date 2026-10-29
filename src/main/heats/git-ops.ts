// Git helpers for heats: worktrees under one folder, lane commits, live diffs, merges.
// Every command is an argument list for execFile, never a shell string, and always has a timeout.

import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { countTests, isTestFile } from '../../shared/heats'
import type { TestCounts } from '../../shared/heats'
import { processesInside } from './procgroup'
import { withoutRepoRouting } from '../env'

/** Git commands here are small local ones; a minute is a hang, not a slow disk. */
export const GIT_TIMEOUT_MS = 60_000
const MAX_BUFFER = 8 * 1024 * 1024

/** The identity lane commits are made with, so a heat never needs the user's git config. */
export const HEAT_AUTHOR = 'Regatta <regatta@localhost>'
const IDENTITY = [
  '-c',
  'user.name=Regatta',
  '-c',
  'user.email=regatta@localhost',
  '-c',
  'commit.gpgsign=false'
]

export interface DiffStat {
  files: number
  added: number
  removed: number
}

export const NO_CHANGES: DiffStat = { files: 0, added: 0, removed: 0 }

/**
 * Every git command the engines run goes through `git`, with replace refs switched off: a
 * `refs/replace` entry must never redirect what a commit, a tree or a file means to Regatta.
 * Sandboxed calls (without `allowHooks`) also disable lazy fetch and all transport protocols so
 * a partial clone never contacts its remote.
 */
const GIT_ENV_OVERRIDES = { GIT_NO_REPLACE_OBJECTS: '1' }
const SANDBOX_ENV_OVERRIDES = {
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: ''
}

/**
 * Settings every engine git call runs with. `core.fsmonitor=false` because the file system monitor
 * only makes git faster and never changes what it reports, but its daemon would be started by a
 * plain `git status` and then hold the worktree open for good (so it could never be removed), and
 * a configured hook path, auto-maintenance or signing program would run the user's script under an engine.
 */
const GIT_SETTINGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.trustctime=true',
  '-c',
  'core.checkStat=default',
  '-c',
  'core.ignoreStat=false',
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgSign=false'
]

const FILTER_CONFIG_PATTERN = '^filter\\..*\\.(clean|smudge|process)$'
const SANDBOX_CONFIG_PATTERN = '^(filter\\..*\\.(clean|smudge|process)|hook\\..*\\.(command|event))$'
const FILTER_CONFIG_LINE = /^filter\.([\s\S]+)\.(clean|smudge|process)$/
const HOOK_CONFIG_LINE = /^hook\.([\s\S]+)\.(command|event)$/

export const CLEAN_FILTER_KEPT =
  'Kept: this repository uses a clean filter (for example Git LFS), so Regatta leaves the worktree for you; remove it with git worktree remove when you are done.'

export class HooksSandboxError extends Error {}

function parseConfigRecords(out: string): Array<{ key: string; value: string }> {
  const records: Array<{ key: string; value: string }> = []
  for (const raw of out.split('\0')) {
    if (raw.length === 0) continue
    const nl = raw.indexOf('\n')
    if (nl === -1) {
      records.push({ key: raw, value: '' })
    } else {
      records.push({ key: raw.slice(0, nl), value: raw.slice(nl + 1) })
    }
  }
  return records
}

function assertSafeConfigName(kind: 'filter' | 'hook', name: string): void {
  if (name.includes('=') || name.includes('\n') || name.includes('\0')) {
    throw new HooksSandboxError(
      `Refused: git config ${kind} "${name}" has a name containing "=", a newline or NUL, which git -c cannot override.`
    )
  }
}

const startupHooksSandbox = mkdtempSync(join(tmpdir(), 'regatta-empty-hooks-'))
let configuredHooksSandbox: string | null = null

/** Sets the folder used as the engines' empty hooks folder (the app's data folder is the right place). */
export function setHooksSandbox(dir: string | null): void {
  configuredHooksSandbox = dir
}
export const setGitOpsHooksSandbox = setHooksSandbox

function hooksSandbox(): string {
  const dir = configuredHooksSandbox ?? startupHooksSandbox
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    throw new HooksSandboxError("Regatta's empty git hooks folder is not a folder.")
  }
  const info = lstatSync(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new HooksSandboxError("Regatta's empty git hooks folder is not a folder.")
  }
  // Finder writes a .DS_Store into a folder that was ever opened; that alone is not a reason to refuse.
  if (readdirSync(dir).some((name) => name !== '.DS_Store')) {
    throw new HooksSandboxError("Regatta's empty git hooks folder is not empty, so git was not run.")
  }
  return dir
}

function queryConfigRegexp(pattern: string, cwd: string, env: NodeJS.ProcessEnv, sandbox: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      'git',
      [...GIT_SETTINGS, '-c', `core.hooksPath=${sandbox}`, 'config', '-z', '--get-regexp', pattern],
      { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const outText = String(stdout ?? '')
        const errText = String(stderr ?? '')
        if (!err) {
          done(outText)
          return
        }
        const e = err as Omit<NodeJS.ErrnoException, 'code'> & {
          code?: number | string | null
          killed?: boolean
          signal?: NodeJS.Signals | null
        }
        // `git config -z --get-regexp` exits 1 with empty output when nothing matches; only that means "none".
        if (!e.killed && !e.signal && e.code === 1 && outText.length === 0 && errText.trim().length === 0) {
          done('')
          return
        }
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(e.message ?? '')) {
          fail(new HooksSandboxError('Refused: git config output exceeded the buffer limit while checking for filters and hooks.'))
          return
        }
        if (e.killed || e.signal) {
          fail(new HooksSandboxError(`Refused: git config timed out or was killed (${e.signal ?? 'timeout'}) while checking for filters and hooks.`))
          return
        }
        if (typeof e.code === 'string') {
          fail(new HooksSandboxError(`Refused: could not start git config to check for filters and hooks (${e.code}: ${e.message}).`))
          return
        }
        const detail =
          errText
            .trim()
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.length > 0) ||
          outText
            .replace(/\0/g, '\n')
            .trim()
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.length > 0) ||
          e.message ||
          `exit code ${String(e.code)}`
        fail(new HooksSandboxError(`Refused: git config failed while checking for filters and hooks (${detail}).`))
      }
    )
  })
}

/**
 * The `-c` flags that keep a git command from running any user-configured hook, filter driver,
 * file-system monitor, background maintenance or signing helper.
 */
export async function sandboxGitArgs(cwd: string, env?: NodeJS.ProcessEnv, skipConfigLookup = false): Promise<string[]> {
  const sandbox = hooksSandbox()
  const base = [...GIT_SETTINGS, '-c', `core.hooksPath=${sandbox}`]
  if (skipConfigLookup) return base
  const runEnv = { ...withoutRepoRouting({ ...process.env }), ...(env ?? {}), ...SANDBOX_ENV_OVERRIDES }
  const configOut = await queryConfigRegexp(SANDBOX_CONFIG_PATTERN, cwd, runEnv, sandbox)
  const drivers = new Set<string>()
  const hooks = new Set<string>()
  for (const { key } of parseConfigRecords(configOut)) {
    const filterMatch = key.match(FILTER_CONFIG_LINE)
    if (filterMatch?.[1]) {
      assertSafeConfigName('filter', filterMatch[1])
      drivers.add(filterMatch[1])
      continue
    }
    const hookMatch = key.match(HOOK_CONFIG_LINE)
    if (hookMatch?.[1]) {
      assertSafeConfigName('hook', hookMatch[1])
      hooks.add(hookMatch[1])
    }
  }
  const extra: string[] = []
  for (const d of drivers) {
    extra.push('-c', `filter.${d}.clean=`, '-c', `filter.${d}.smudge=`, '-c', `filter.${d}.process=`, '-c', `filter.${d}.required=false`)
  }
  for (const h of hooks) {
    extra.push('-c', `hook.${h}.enabled=false`, '-c', `hook.${h}.command=`, '-c', `hook.${h}.event=`)
  }
  return [...base, ...extra]
}

/** Drivers in `cwd` whose `clean` or `process` filter is set to a non-empty command. */
async function configuredCleanFilterDrivers(cwd: string): Promise<Set<string>> {
  const sandbox = hooksSandbox()
  const runEnv = { ...withoutRepoRouting({ ...process.env }), ...SANDBOX_ENV_OVERRIDES }
  const out = await queryConfigRegexp(FILTER_CONFIG_PATTERN, cwd, runEnv, sandbox)
  const drivers = new Set<string>()
  for (const { key, value } of parseConfigRecords(out)) {
    const match = key.match(FILTER_CONFIG_LINE)
    if (!match?.[1]) continue
    assertSafeConfigName('filter', match[1])
    if ((match[2] === 'clean' || match[2] === 'process') && value.trim().length > 0) {
      drivers.add(match[1])
    }
  }
  return drivers
}

export interface GitOptions {
  input?: string
  /** Let git run the repository's hooks (for worktree creation and the fast-forward merge in the user's folder). */
  allowHooks?: boolean
  /** Extra environment variables for this command (for example `GIT_INDEX_FILE` on a scratch index). */
  env?: Record<string, string>
}

/** Runs git in `cwd` and returns what it wrote to standard output and standard error. Throws an Error carrying git's own words. */
export async function gitFull(args: string[], cwd: string, inputOrOpts?: string | GitOptions): Promise<{ stdout: string; stderr: string }> {
  const opts: GitOptions = typeof inputOrOpts === 'string' ? { input: inputOrOpts } : (inputOrOpts ?? {})
  // Routing variables of the app's own environment (GIT_WORK_TREE, GIT_DIR...) would aim git at another folder than `cwd`.
  const baseEnv = opts.allowHooks ? GIT_ENV_OVERRIDES : SANDBOX_ENV_OVERRIDES
  const env = { ...withoutRepoRouting({ ...process.env }), ...baseEnv, ...(opts.env ?? {}) }
  const settings = opts.allowHooks ? GIT_SETTINGS : await sandboxGitArgs(cwd, env, args[0] === 'config')
  return new Promise((done, fail) => {
    const child = execFile('git', [...settings, ...args], { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const lines = String(stderr)
          .trim()
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
        // Progress lines such as "Preparing worktree" come first; the reason is the fatal or error line.
        const detail = lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines[0]
        const failure: Error & { stderr?: string; stdout?: string; code?: number | string | null } = new Error(detail || `git ${args[0]} failed`)
        // Callers that need more than the headline (the paths git lists under it) read the whole text.
        failure.stderr = String(stderr)
        failure.stdout = String(stdout)
        failure.code = (err as { code?: number | string | null }).code ?? null
        fail(failure)
        return
      }
      done({ stdout: String(stdout), stderr: String(stderr) })
    })
    // Text for standard input (a list for `cat-file --batch-check`): one process for any number of names.
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

/** Runs git in `cwd` and returns its standard output. Throws an Error carrying git's own words. */
export async function git(args: string[], cwd: string, opts?: GitOptions): Promise<string> {
  return (await gitFull(args, cwd, opts)).stdout
}

/** Runs git and returns null instead of throwing when git says no. */
export async function tryGit(args: string[], cwd: string, opts?: GitOptions): Promise<string | null> {
  try {
    return await git(args, cwd, opts)
  } catch (err) {
    if (err instanceof HooksSandboxError) throw err
    return null
  }
}

/** True when `root` is inside a git work tree that has at least one commit. */
export async function isRepoWithCommit(root: string): Promise<boolean> {
  if (!existsSync(root)) return false
  if ((await tryGit(['rev-parse', '--is-inside-work-tree'], root))?.trim() !== 'true') return false
  return (await tryGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root)) !== null
}

/** The commit `cwd` points at. */
export async function headSha(cwd: string): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], cwd)).trim()
}

/** The branch `cwd` is on, or its short sha when HEAD is detached. */
export async function branchName(cwd: string): Promise<string> {
  const name = (await tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd))?.trim()
  return name && name !== 'HEAD' ? name : (await headSha(cwd)).slice(0, 7)
}

/** The branch `cwd` is on, or null when HEAD is detached. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const name = (await tryGit(['symbolic-ref', '--short', '-q', 'HEAD'], cwd))?.trim()
  return name ? name : null
}

/** True when the local branch exists. */
export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await tryGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd)) !== null
}

/** Local branch names that start with `prefix`. */
export async function branchesWithPrefix(cwd: string, prefix: string): Promise<string[]> {
  const out = await git(['for-each-ref', '--format=%(refname)', 'refs/heads/'], cwd)
  return out
    .split('\n')
    .map((line) => line.trim().replace(/^refs\/heads\//, ''))
    .filter((name) => name.length > 0 && name.startsWith(prefix))
}

/** True when `sha` names a commit that exists in the repository. */
export async function isCommit(cwd: string, sha: string): Promise<boolean> {
  return (await tryGit(['cat-file', '-e', `${sha}^{commit}`], cwd)) !== null
}

/** The commit a local branch points at. Throws when the branch is not there. */
export async function branchTip(cwd: string, branch: string): Promise<string> {
  return (await git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], cwd)).trim()
}

/** True when `commit` is reachable from `ref`. */
export async function isAncestor(cwd: string, commit: string, ref: string): Promise<boolean> {
  return (await tryGit(['merge-base', '--is-ancestor', commit, ref], cwd)) !== null
}

/** The folder with git's own files for `cwd` (for a linked worktree, its private folder). */
async function gitDirOf(cwd: string): Promise<string> {
  const out = (await git(['rev-parse', '--git-dir'], cwd)).trim()
  return isAbsolute(out) ? out : resolve(cwd, out)
}

/** True when this git directory has a merge underway (the marker a merge leaves until it is committed or aborted). */
export async function mergeHeadExists(cwd: string): Promise<boolean> {
  return existsSync(join(await gitDirOf(cwd), 'MERGE_HEAD'))
}

/**
 * What git operation is half done in `cwd`: a merge, rebase, cherry-pick or revert. Null when none.
 * Throws when git cannot say.
 */
export async function operationInProgress(cwd: string): Promise<string | null> {
  const dir = await gitDirOf(cwd)
  const markers: [string, string][] = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply/applying', 'am'],
    ['rebase-apply', 'rebase'],
    // A squash merge with --autostash leaves the user's stashed edit here and writes no MERGE_HEAD.
    ['MERGE_AUTOSTASH', 'merge (with an autostash)'],
    ['NOTES_MERGE_PARTIAL', 'notes merge'],
    ['NOTES_MERGE_REF', 'notes merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['sequencer', 'cherry-pick or revert sequence'],
    ['BISECT_LOG', 'bisect']
  ]
  for (const [file, name] of markers) {
    if (existsSync(join(dir, file))) return name
  }
  return null
}

/**
 * Aborts a merge, but only one that has left MERGE_HEAD behind. Returns false when there was
 * nothing to abort (the merge never started, so the folder is how it was). Throws when the abort fails.
 */
export async function abortMerge(cwd: string): Promise<boolean> {
  if (!(await mergeHeadExists(cwd))) return false
  await git(['merge', '--abort'], cwd)
  return true
}

/**
 * Whose merge is underway in `cwd`: none, one for exactly the commit `sha` (ours: a merge of that
 * commit is what we ran), or one for anything else (the user's own).
 */
export async function mergeHeadOwner(cwd: string, sha: string): Promise<'none' | 'ours' | 'foreign'> {
  const file = join(await gitDirOf(cwd), 'MERGE_HEAD')
  if (!existsSync(file)) return 'none'
  const heads = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return heads.length === 1 && heads[0] === sha ? 'ours' : 'foreign'
}

/** The git folder that every worktree of this repository shares, as an absolute path. */
export async function gitCommonDir(cwd: string): Promise<string> {
  const out = (await git(['rev-parse', '--git-common-dir'], cwd)).trim()
  return isAbsolute(out) ? out : resolve(cwd, out)
}

/**
 * Where `cwd` is below the top of its working tree, as a relative path with a trailing slash
 * ("" at the top, "app/web/" in a subfolder). A project opened as a subfolder runs there in every worktree.
 */
export async function projectPrefix(cwd: string): Promise<string> {
  // Only git's own trailing newline goes: a folder named " app" has a space that is part of its name.
  return (await git(['rev-parse', '--show-prefix'], cwd)).replace(/\n$/, '')
}

/** The top folder of the working tree that `cwd` is in. */
export async function repoTop(cwd: string): Promise<string> {
  return (await git(['rev-parse', '--show-toplevel'], cwd)).trim()
}

/** True when the volume `dir` is on treats names that differ only in case as the same file. */
export function isCaseInsensitive(dir: string): boolean {
  try {
    const marker = lstatSync(join(dir, '.git'))
    const swapped = lstatSync(join(dir, '.GIT'))
    return marker.ino === swapped.ino && marker.dev === swapped.dev
  } catch {
    return false
  }
}

/**
 * Paths a merge of `rev` would write over in `cwd`'s repository that git does not track: files
 * the user ignores or has not added. git overwrites ignored files silently when it merges with
 * the ort strategy, so this is checked first. Works from the top of the repository whatever
 * folder `cwd` is in, and on case-insensitive volumes treats names that differ in case as one.
 * Returns the colliding paths (relative to the top), empty when the merge is safe.
 */
export async function ignoredCollisions(cwd: string, rev: string): Promise<string[]> {
  const top = await repoTop(cwd)
  const mergeBase = (await git(['merge-base', 'HEAD', rev], top)).trim()
  // What the branch adds or changes, not what it deletes. Renames count as an add.
  const incoming = splitZ(await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--no-renames', '--diff-filter=d', mergeBase, rev], top))
  if (incoming.length === 0) return []
  // Everything git does not track, ignored or not. A folder with nothing tracked in it is one entry "dir/".
  const untracked = splitZ(await git(['ls-files', '--others', '--directory', '--no-empty-directory', '-z'], top))
  if (untracked.length === 0) return []

  const fold = isCaseInsensitive(top) ? (name: string): string => name.normalize('NFC').toLowerCase() : (name: string): string => name
  const entries = untracked.map((raw) => ({ path: fold(raw.replace(/\/$/, '')), folder: raw.endsWith('/') }))
  const hits = new Set<string>()
  for (const dest of incoming) {
    const path = fold(dest)
    for (const entry of entries) {
      // The same name, or an untracked file where the branch needs a folder.
      if (entry.path === path || (!entry.folder && path.startsWith(`${entry.path}/`))) {
        hits.add(dest)
        continue
      }
      // Something untracked beneath a name that the branch turns into a file.
      if (entry.path.startsWith(`${path}/`)) {
        hits.add(dest)
        continue
      }
      // Inside an untracked folder: only a collision when that very path is already there.
      if (entry.folder && path.startsWith(`${entry.path}/`) && pathExists(top, dest)) hits.add(dest)
    }
  }
  return [...hits]
}

function splitZ(out: string): string[] {
  return out.split('\0').filter((name) => name.length > 0)
}

function pathExists(top: string, relative: string): boolean {
  try {
    lstatSync(join(top, relative))
    return true
  } catch {
    return false
  }
}

/** Every worktree git knows for this repository, with the branch it has checked out (null when detached). */
export async function registeredWorktrees(cwd: string): Promise<{ path: string; branch: string | null }[]> {
  const out = await git(['worktree', 'list', '--porcelain'], cwd)
  const list: { path: string; branch: string | null }[] = []
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) list.push({ path: line.slice('worktree '.length), branch: null })
    else if (line.startsWith('branch ') && list.length > 0) list[list.length - 1]!.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
  }
  return list
}

/** The `.git` file of a linked worktree (it points at the worktree's private folder), or null. */
export function worktreeGitdir(path: string): string | null {
  try {
    return readFileSync(join(path, '.git'), 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * What identifies the private git folder of a linked worktree (the one its `.git` file points
 * at): its path, inode and creation time. A worktree removed and made again at the same path gets
 * a new folder, so a changed identity means it is not the one that was recorded. Null when it
 * cannot be read.
 *
 * The device number is left out on purpose. On macOS st_dev is built from the BSD disk number
 * (here 16777232, minor 16, major 1 for disk3's data volume), which is handed out when a volume is
 * mounted and can differ after a reboot or when a disk is attached, while the inode and creation
 * time stay with the folder. A record that no longer matched would leave its worktree behind for good.
 */
export function worktreeIdentity(path: string): string | null {
  const pointer = worktreeGitdir(path)
  const written = pointer?.match(/^gitdir:\s*(.+)$/)?.[1]?.trim()
  if (!written) return null
  // With worktree.useRelativePaths the pointer is relative to the worktree's folder, not to this process.
  const dir = isAbsolute(written) ? written : resolve(path, written)
  try {
    const stat = lstatSync(dir)
    return `${dir}|i${stat.ino}|${stat.birthtimeMs}`
  } catch {
    return null
  }
}

/**
 * True when the worktree at `path` is the one `recorded` (an earlier `worktreeIdentity`) names.
 * Records made before the device number was dropped (`dir|dev:ino|birth`) still count when the
 * folder, inode and creation time match, whatever device number the volume has now.
 */
export function sameWorktree(path: string, recorded: string | null): boolean {
  if (recorded === null) return false
  const now = worktreeIdentity(path)
  if (now === null) return false
  if (now === recorded) return true
  const old = recorded.match(/^(.*)\|\d+:(\d+)\|([\d.e+-]+)$/)
  const current = now.match(/^(.*)\|i(\d+)\|([\d.e+-]+)$/)
  return old !== null && current !== null && old[1] === current[1] && old[2] === current[2] && old[3] === current[3]
}

/** True when some worktree of the repository has this branch checked out. */
export async function branchCheckedOut(cwd: string, branch: string): Promise<boolean> {
  return (await registeredWorktrees(cwd)).some((entry) => entry.branch === branch)
}

/** Adds a worktree of `root` on a new branch at `base`. */
export async function addWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
  await git(['worktree', 'add', '-b', branch, path, base], root, { allowHooks: true })
}

/** Adds a detached worktree of `root` at `base`, used for the baseline. */
export async function addDetachedWorktree(root: string, path: string, base: string): Promise<void> {
  await git(['worktree', 'add', '--detach', path, base], root, { allowHooks: true })
}

/** What became of a branch the engine meant to delete. */
export interface BranchDeletion {
  deleted: boolean
  /** Why it was kept; null when it was deleted or was already gone. */
  reason: string | null
  /**
   * The ref holding the keep commit made before the branch was deleted: a commit with an empty tree
   * whose parents are every commit the branch could have been the last holder of (`ref^1` is the tip).
   */
  parked?: string
  /** Not used any more: the keep commit holds the reflog commits too. */
  parkedMore?: string[]
}

export interface DeleteBranchOptions {
  /** The name to keep under, below `refs/regatta/discarded/`. Defaults to the branch name without a leading `regatta/`. */
  parkAs?: string
}

/** Where kept commits are parked. */
export const PARKED_PREFIX = 'refs/regatta/discarded/'

/** More parents than this and the keep commits are chained (git itself has no limit; this keeps command lines short). */
const KEEP_CHUNK = 500
const ZERO_ID = /^0+$/

/**
 * Reads a reflog file as git wrote it and returns every commit id in it, old and new. `%H` of
 * `git reflog` lists only the new ids, but after a partial expiry the oldest retained entry's old
 * id can be the only trace of a commit. Returns [] when there is no reflog; throws when the
 * repository does not store reflogs as files (then nothing can be promised, and callers keep everything).
 */
async function reflogSnapshot(commonDir: string, logPath: string): Promise<string> {
  const format = (await tryGit(['rev-parse', '--show-ref-format'], commonDir))?.trim()
  if (format && format !== 'files') throw new Error(`reflogs are stored as ${format}, which this cannot read`)
  return readLogText(commonDir, logPath)
}

/** The raw text of a reflog file ('' when there is none); throws on a real read error. */
function readLogText(dir: string, logPath: string): string {
  try {
    return readFileSync(join(dir, 'logs', logPath), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

/** Every commit id in reflog text, old and new. */
function idsInLog(text: string): string[] {
  const ids: string[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) /)
    if (match) ids.push(match[1]!, match[2]!)
  }
  return ids
}

/** Root-level files of a worktree's git folder that hold object ids: ORIG_HEAD, FETCH_HEAD, MERGE_HEAD and the like. */
const PSEUDO_REF = /^[A-Z][A-Z0-9_]*$/

/**
 * The per-worktree pseudo refs: every root-level entry of the worktree's own git folder named like
 * ORIG_HEAD, FETCH_HEAD, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, REBASE_HEAD, BISECT_HEAD or
 * AUTO_MERGE (HEAD and index excepted: HEAD is read on its own, index is not a ref). A regular file
 * is read in full (throws on a read error, so the caller keeps the worktree); anything else (a link, a folder)
 * is listed by kind only, so a change to it still changes the stamp.
 */
function pseudoRefs(gitDir: string): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = []
  for (const entry of readdirSync(gitDir, { withFileTypes: true })) {
    if (!PSEUDO_REF.test(entry.name) || entry.name === 'HEAD' || entry.name === 'index') continue
    out.push({ name: entry.name, text: entry.isFile() ? readFileSync(join(gitDir, entry.name), 'utf8') : `(not a regular file: ${entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'folder' : 'other'})` })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Every object id a pseudo ref names: the first word of each line (FETCH_HEAD has one per line, then tab-separated text). */
function idsInPseudoRef(text: string): string[] {
  const ids: string[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^([0-9a-f]{40,64})(?=\s|$)/)
    if (match) ids.push(match[1]!)
  }
  return ids
}

/** Every regular file below `dir`, sorted, without following links. Missing is empty. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    let handle
    try {
      handle = opendirSync(current)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile()) out.push(path)
      }
    } finally {
      handle.closeSync()
    }
  }
  walk(dir)
  return out.sort()
}

/** The git folder of this repository that holds shared files such as `logs/`, as an absolute path. */
async function commonGitDir(cwd: string): Promise<string> {
  return gitCommonDir(cwd)
}

/**
 * A name that is safe below `refs/regatta/discarded/`: folder names can hold characters a ref may
 * not (a tab, a newline, a backslash, a space, `~`, `^`, `:`, `?`, `*`, `[`, `..`, a trailing `.lock`),
 * so each part of the name keeps only letters, digits, dot, dash and underscore.
 */
export function safeRefName(name: string): string {
  const parts = name
    .split('/')
    .map((part) =>
      part
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/\.{2,}/g, '_')
        .replace(/^\./, '_')
        .replace(/\.lock$/, '_lock')
        .replace(/\.$/, '_')
    )
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts.join('/') : 'kept'
}

/**
 * Keeps every commit in `ids`, unconditionally: one commit with an empty tree and one parent per
 * commit id (deduplicated, anything that is not a commit dropped), pointed at by
 * `refs/regatta/discarded/<name>` (`-2`, `-3` when taken; created only if it does not exist). Whatever
 * is deleted afterwards, those commits stay reachable from that ref, however the user's own refs
 * move meanwhile. No question is asked about who else holds them, because the answer can change
 * while it is being asked. Returns the ref; throws if it could not be made, and then nothing may be deleted.
 * More than KEEP_CHUNK commits are chained through several keep commits (the ref has the last).
 */
export async function keepCommits(root: string, ids: string[], name: string, message: string, chunk = KEEP_CHUNK): Promise<string> {
  const unique = [...new Set(ids.filter((id) => /^[0-9a-f]{40,64}$/.test(id) && !ZERO_ID.test(id)))]
  // One process for all of them: the commit each name peels to. An annotated tag (which a private ref such as
  // refs/worktree/x can point at, with its commit reachable from nowhere else) resolves to the commit it names;
  // a tree, a blob, a tag of a tree or a missing object answers "missing" and is dropped. Output lines are 1:1 with input.
  const peeled =
    unique.length > 0
      ? (await gitFull(['cat-file', '--batch-check=%(objecttype) %(objectname)'], root, unique.map((id) => `${id}^{commit}\n`).join(''))).stdout.split('\n')
      : []
  const commits = [
    ...new Set(
      unique.flatMap((_, index) => {
        const match = (peeled[index] ?? '').match(/^commit ([0-9a-f]{40,64})$/)
        return match ? [match[1]!] : []
      })
    )
  ]
  if (commits.length === 0) throw new Error('there is no commit to keep')
  const tree = (await git(['hash-object', '-w', '-t', 'tree', '/dev/null'], root)).trim()
  // The first id is the work to restore (the tip, or HEAD): it is the first parent of every keep commit, so
  // `<ref>^1` is it however many keep commits there are. The chain goes through the other parents.
  const [tip, ...rest] = commits as [string, ...string[]]
  let keep = ''
  const chunks = rest.length > 0 ? Math.ceil(rest.length / chunk) : 1
  for (let index = 0; index < chunks; index++) {
    const parents = [tip, ...(keep ? [keep] : []), ...rest.slice(index * chunk, (index + 1) * chunk)]
    keep = (await git([...IDENTITY, 'commit-tree', tree, ...parents.flatMap((id) => ['-p', id]), '-m', message], root)).trim()
  }
  for (let n = 1; n <= 50; n++) {
    const ref = `${PARKED_PREFIX}${safeRefName(name)}${n === 1 ? '' : `-${n}`}`
    try {
      // An empty old value means the ref must not exist yet: git makes it only if it is free.
      await git(['update-ref', ref, keep, ''], root)
      return ref
    } catch (err) {
      if (err instanceof HooksSandboxError) throw err
      // Taken (or its name blocks this one): try the next.
    }
  }
  throw new Error(`no free name below ${PARKED_PREFIX}${name}`)
}

/**
 * Deletes a branch the engine made, and only that: it must not be a symbolic ref, must not be
 * checked out in any worktree, and must point exactly at `expectedSha` (the tested commit, or the
 * commit a lane that never committed was started at). A branch that moved, was made symbolic or is
 * in use is kept, with the reason. A branch that is already gone is not an error.
 *
 * Deleting also drops the branch's reflog, so before it goes everything it could be the last
 * holder of is kept with `keepCommits`: the tip and the old and new id of every reflog entry, in
 * one keep commit at `refs/regatta/discarded/<name>`. That is done whatever else holds the commits,
 * because who holds them can change while it is checked. If it cannot be done the branch stays. The
 * keep ref comes back as `parked` (`git branch <name> <ref>^1` restores the tip; `git log <ref>`
 * lists them all). The branch is then deleted with `update-ref --no-deref -d <ref> <expectedSha>`,
 * which git performs only if the ref still has that value and never follows a symbolic ref.
 */
export async function deleteOwnedBranch(
  root: string,
  name: string,
  expectedSha: string,
  opts: DeleteBranchOptions = {}
): Promise<BranchDeletion> {
  const ref = `refs/heads/${name}`
  const keep = (reason: string): BranchDeletion => ({ deleted: false, reason })
  if (!/^[0-9a-f]{40,64}$/.test(expectedSha)) return keep(`Branch ${name} was kept: no commit was recorded for it.`)
  try {
    hooksSandbox()
  } catch (err) {
    return keep(`Branch ${name} was kept: ${err instanceof Error ? err.message : String(err)}.`)
  }
  // Whatever someone aimed at another ref is not the branch we made, and deleting through it would delete theirs.
  if ((await tryGit(['symbolic-ref', '-q', ref], root)) !== null) {
    return keep(`Branch ${name} was kept: it is now a symbolic ref, not the branch Regatta made.`)
  }
  let tip: string
  try {
    tip = (await git(['rev-parse', '--verify', '--quiet', ref], root)).trim()
  } catch (err) {
    if (err instanceof HooksSandboxError) return keep(`Branch ${name} was kept: ${err.message}.`)
    return { deleted: false, reason: null }
  }
  if (tip !== expectedSha) return keep(`Branch ${name} was kept: it has commits Regatta did not make or test.`)
  if (await branchCheckedOut(root, name)) return keep(`Branch ${name} was kept: it is checked out in a worktree.`)

  let parked: string
  let logPath = ''
  let snapshot = ''
  try {
    const common = await commonGitDir(root)
    logPath = `refs/heads/${name}`
    // The whole reflog as it is now: what is kept is exactly this, and it is looked at again right before the delete.
    snapshot = await reflogSnapshot(common, logPath)
    parked = await keepCommits(
      root,
      [expectedSha, ...idsInLog(snapshot)],
      opts.parkAs ?? name.replace(/^regatta\//, ''),
      `Kept commits of branch ${name} before Regatta deleted it`
    )
    // Keeping takes a moment, and the user can commit on the branch and reset it back meanwhile: a reflog that grew
    // holds commits that were not kept, and deleting the branch would drop them.
    if ((await reflogSnapshot(common, logPath)) !== snapshot) {
      return { deleted: false, reason: `Branch ${name} was kept: its history changed while its commits were being kept, so it will be looked at again.`, parked }
    }
  } catch (err) {
    return keep(`Branch ${name} was kept: a copy of its commits could not be made (${err instanceof Error ? err.message : String(err)}).`)
  }
  // The last look before the delete: someone may have checked it out while we were looking.
  if (await branchCheckedOut(root, name)) return { deleted: false, reason: `Branch ${name} was kept: it is checked out in a worktree.`, parked }
  try {
    await git(['update-ref', '--no-deref', '-d', ref, expectedSha], root)
    return { deleted: true, reason: null, parked }
  } catch (err) {
    return { deleted: false, reason: `Branch ${name} was kept: ${err instanceof Error ? err.message : String(err)}`, parked }
  }
}

/**
 * Keeps git out of submodules and nested repositories: their own config (a clean filter, a hook) is not
 * Regatta's to run, and the sandbox flags only reach the repository git was started in. Used with
 * `--ignore-submodules=all` on status and diff, and `gitlinkExcludes` on `git add -A`.
 */
const NO_SUBMODULE_RECURSE = ['-c', 'submodule.recurse=false', '-c', 'diff.ignoreSubmodules=all']

/** `git diff` flags for a NUL-separated list of changed paths that never runs a user program or enters a submodule. */
const DIFF_NAMES = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--name-only', '-z']

/**
 * One `:(top,literal,exclude)<path>` pathspec per gitlink (submodule) in the index of `cwd` (or
 * `env.GIT_INDEX_FILE`), so `git add -A` never looks inside a submodule's working tree.
 */
async function gitlinkExcludes(cwd: string, env?: Record<string, string>): Promise<string[]> {
  const staged = await git(['ls-files', '--stage', '--full-name', '-z', '--', ':(top)'], cwd, env ? { env } : undefined)
  const excludes: string[] = []
  for (const entry of staged.split('\0')) {
    if (!entry.startsWith('160000 ')) continue
    const tab = entry.indexOf('\t')
    if (tab !== -1) excludes.push(`:(top,literal,exclude)${entry.slice(tab + 1)}`)
  }
  return excludes
}

/**
 * True when tracked files in `cwd` differ from what is committed. Untracked files do not count.
 * Throws when git cannot say (a failed status is not a clean folder).
 */
export async function dirtyTracked(cwd: string): Promise<boolean> {
  const out = await withScratchIndex(cwd, async (env) => {
    await tryGit(['update-index', '-q', '--really-refresh'], cwd, { env })
    return git(['--no-optional-locks', ...NO_SUBMODULE_RECURSE, 'status', '--porcelain', '--untracked-files=no', '--ignore-submodules=all'], cwd, { env })
  })
  return out.trim().length > 0
}

/**
 * True when `cwd` has anything to commit, untracked files included.
 * Throws when git cannot say (a failed status is not a clean folder).
 */
export async function hasChanges(cwd: string): Promise<boolean> {
  const out = await withScratchIndex(cwd, async (env) => {
    await tryGit(['update-index', '-q', '--really-refresh'], cwd, { env })
    return git(['--no-optional-locks', ...NO_SUBMODULE_RECURSE, 'status', '--porcelain', '--ignore-submodules=all'], cwd, { env })
  })
  return out.trim().length > 0
}

/**
 * Runs `fn` with `GIT_INDEX_FILE` pointed at a temporary copy of `cwd`'s index, so a measurement
 * or check can refresh or add intent-to-add entries without touching the worktree's own index or
 * colliding with a `git` command running inside it.
 */
async function withScratchIndex<T>(cwd: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const gitDir = await gitDirOf(cwd)
  const dir = mkdtempSync(join(tmpdir(), 'regatta-index-'))
  const indexFile = join(dir, 'index')
  try {
    const current = join(gitDir, 'index')
    if (pathStillThere(current)) {
      copyFileSync(current, indexFile)
      try {
        const epoch1 = new Date(1000)
        utimesSync(indexFile, epoch1, epoch1)
      } catch {
        // Best-effort timestamp reset so git treats every entry as racy and hashes content.
      }
    }
    return await fn({ GIT_INDEX_FILE: indexFile })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Refreshes the git index at `cwd` (or `env.GIT_INDEX_FILE` when set). Git exits 1 with
 * `<path>: needs update` or `<path>: needs merge` lines on stdout when tracked files differ
 * from the index or are unmerged, which is expected; any other non-zero exit or error output throws.
 */
async function refreshIndex(cwd: string, env?: Record<string, string>): Promise<void> {
  try {
    await gitFull(['update-index', '--really-refresh'], cwd, env ? { env } : undefined)
  } catch (err) {
    const e = err as { code?: number | string | null; stdout?: string; stderr?: string }
    const out = (e.stdout ?? '').trim()
    const errOut = (e.stderr ?? '').trim()
    if (
      e.code === 1 &&
      errOut.length === 0 &&
      out.length > 0 &&
      out.split('\n').every((line) => line.endsWith(': needs update') || line.endsWith(': needs merge'))
    ) {
      return
    }
    throw err
  }
}

/** True when any path in `paths` has a `filter` attribute naming one of `cleanDrivers`. */
async function pathsUseCleanFilterDriver(target: string, paths: string[], cleanDrivers: Set<string>): Promise<boolean> {
  if (paths.length === 0 || cleanDrivers.size === 0) return false
  const out = await git(['check-attr', '-z', '--stdin', 'filter'], target, { input: paths.map((p) => `${p}\0`).join('') })
  const fields = out.split('\0')
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (cleanDrivers.has(fields[i + 2]!)) return true
  }
  return false
}

/** Parses `git diff --shortstat` output such as "3 files changed, 10 insertions(+), 1 deletion(-)". */
export function parseShortstat(text: string): DiffStat {
  const files = text.match(/(\d+) files? changed/)
  const added = text.match(/(\d+) insertions?\(\+\)/)
  const removed = text.match(/(\d+) deletions?\(-\)/)
  return {
    files: files ? Number(files[1]) : 0,
    added: added ? Number(added[1]) : 0,
    removed: removed ? Number(removed[1]) : 0
  }
}

/**
 * How much a lane worktree differs from `from`, untracked files included. Runs against a scratch
 * copy of the index with the empty hooks folder so `diffFrom` never modifies `.git/index` or runs
 * a `post-index-change` hook.
 */
export async function diffFrom(cwd: string, from: string, exclude: string[] = []): Promise<DiffStat> {
  const skip = await withModulesExcluded(cwd, exclude)
  const out = await withScratchIndex(cwd, async (env) => {
    await refreshIndex(cwd, env)
    const addSkip = [...skip, ...(await gitlinkExcludes(cwd, env))]
    await git(['add', '-A', '--intent-to-add', ...(addSkip.length > 0 ? ['--', ...addSkip] : [])], cwd, { env })
    return git(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--shortstat', from], cwd, { env })
  })
  return parseShortstat(out)
}

/** How much two commits differ, for example the lane branch against the base. */
export async function diffBetween(cwd: string, from: string, to: string): Promise<DiffStat> {
  const out = await git(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--shortstat', from, to], cwd)
  return parseShortstat(out)
}

/** The pathspec that keeps the worktree's own `node_modules` out of what a lane commits. */
export const EXCLUDE_NODE_MODULES = ':(top,exclude)node_modules'

/**
 * `exclude` plus EXCLUDE_NODE_MODULES when `node_modules` in `cwd` exists (the copy `provideModules`
 * made, or an old setup link) and git does not track it. A `node_modules/` ignore line does not
 * match a link, and a project without one would have the whole copy committed, so without this
 * every engine that adds with `-A` would commit it and a later fast-forward would be refused.
 * A `node_modules` the project tracks itself is left alone.
 */
async function withModulesExcluded(cwd: string, exclude: string[]): Promise<string[]> {
  if (exclude.includes(EXCLUDE_NODE_MODULES)) return exclude
  try {
    lstatSync(join(cwd, 'node_modules'))
  } catch {
    return exclude
  }
  // An ignored one is never added, and naming an ignored path in a pathspec makes `git add` fail.
  if ((await tryGit(['check-ignore', '-q', '--', 'node_modules'], cwd)) !== null) return exclude
  const tracked = await tryGit(['ls-files', '--error-unmatch', '--', 'node_modules'], cwd)
  return tracked === null ? [...exclude, EXCLUDE_NODE_MODULES] : exclude
}

/**
 * Commits everything in `cwd` as Regatta, except paths matching `exclude` (pathspecs) and the
 * untracked `node_modules` that setup provides. Returns false when there was nothing to commit.
 *
 * It refuses (throws) while a merge, rebase, cherry-pick, revert or bisect is in progress in `cwd`:
 * committing then would finish someone's half-done operation, conflict markers and all. And a path
 * the user staged at one version and then changed again is committed as staged first, so the staged
 * version is not left unreachable by the second `git add`.
 *
 * `stopped` is asked after every awaited step: when it answers true (a cancel or a quit), nothing
 * more is written and the call throws, so a preservation that was stopped mid-way leaves no commit.
 */
export async function commitAll(cwd: string, message: string, exclude: string[] = [], stopped?: () => boolean): Promise<boolean> {
  // A caller that is cancelling or quitting must write nothing: every step below is an await, and
  // the check runs right after each one, so a stop that lands mid-commit stops before the next write.
  const check = (): void => {
    if (stopped?.()) throw new Error('Committing was stopped: Regatta was cancelled or quit before this commit was written.')
  }
  const busy = await operationInProgress(cwd)
  check()
  if (busy) {
    throw new Error(`A ${busy} is in progress in this folder, so nothing was committed. Finish or abort it first.`)
  }
  const skip = await withModulesExcluded(cwd, exclude)
  check()
  const cleanDrivers = await configuredCleanFilterDrivers(cwd)
  check()
  if (cleanDrivers.size > 0) {
    const usesCleanFilter = await withScratchIndex(cwd, async (env) => {
      await refreshIndex(cwd, env)
      const preStaged = splitLines(await git([...NO_SUBMODULE_RECURSE, 'diff', ...DIFF_NAMES, '--cached'], cwd, { env }), '\0')
      const addSkip = [...skip, ...(await gitlinkExcludes(cwd, env))]
      await git([...NO_SUBMODULE_RECURSE, 'add', '-A', ...(addSkip.length > 0 ? ['--', ...addSkip] : [])], cwd, { env })
      const postStaged = splitLines(await git([...NO_SUBMODULE_RECURSE, 'diff', ...DIFF_NAMES, '--cached'], cwd, { env }), '\0')
      const candidatePaths = [...new Set([...preStaged, ...postStaged])]
      return pathsUseCleanFilterDriver(cwd, candidatePaths, cleanDrivers)
    })
    check()
    if (usesCleanFilter) {
      throw new Error('Refused: this repository uses a clean or process filter (for example Git LFS), so Regatta did not commit content the filter would have changed.')
    }
  }
  const indexPath = join(await gitDirOf(cwd), 'index')
  if (existsSync(indexPath)) {
    try {
      const epoch1 = new Date(1000)
      utimesSync(indexPath, epoch1, epoch1)
    } catch {
      // Best-effort timestamp reset so git hashes content even on same-second, same-size edits.
    }
  }
  await refreshIndex(cwd)
  check()
  let committed = false
  const staged = new Set(splitLines(await git([...NO_SUBMODULE_RECURSE, 'diff', ...DIFF_NAMES, '--cached'], cwd), '\0'))
  check()
  if (staged.size > 0) {
    const changedAgain = splitLines(await git([...NO_SUBMODULE_RECURSE, 'diff', ...DIFF_NAMES], cwd), '\0').filter((path) => staged.has(path))
    check()
    if (changedAgain.length > 0) {
      await git([...IDENTITY, ...NO_SUBMODULE_RECURSE, 'commit', '--author', HEAT_AUTHOR, '-m', `${message} (staged changes)`], cwd)
      committed = true
      check()
    }
  }
  // A submodule's pointer is left out: recording it would mean looking inside the submodule's working tree.
  const addSkip = [...skip, ...(await gitlinkExcludes(cwd))]
  check()
  await git([...NO_SUBMODULE_RECURSE, 'add', '-A', ...(addSkip.length > 0 ? ['--', ...addSkip] : [])], cwd)
  check()
  // What is staged now is what would be committed; an excluded, untracked path does not count.
  if ((await git([...NO_SUBMODULE_RECURSE, 'diff', ...DIFF_NAMES, '--cached'], cwd)).trim().length === 0) {
    check()
    return committed
  }
  check()
  await git([...IDENTITY, ...NO_SUBMODULE_RECURSE, 'commit', '--author', HEAT_AUTHOR, '-m', message], cwd)
  return true
}

function splitLines(out: string, sep: string): string[] {
  return out.split(sep).filter((entry) => entry.length > 0)
}

/** How many commits `to` is ahead of `from`. */
export async function commitCount(cwd: string, from: string, to: string): Promise<number> {
  const out = await tryGit(['rev-list', '--count', `${from}..${to}`], cwd)
  return out ? Number(out.trim()) || 0 : 0
}

/**
 * Test files at a revision and how many cases and assertions each one holds. Names are read
 * exactly as stored (NUL separated, whole tree, never quoted), contents with `git show` from the
 * repository top level. A name that cannot be read throws: a silently shorter list would let a
 * lane delete protected tests without the integrity gate noticing.
 */
export async function countTestsAt(cwd: string, rev: string): Promise<TestCounts> {
  const top = (await git(['rev-parse', '--show-toplevel'], cwd)).trim()
  const listed = await git(['ls-tree', '--full-tree', '-r', '-z', '--name-only', rev], top)
  const paths = listed.split('\0').filter((name) => name.length > 0 && isTestFile(name))
  const counts: TestCounts = {}
  await mapLimit(paths, 8, async (path) => {
    counts[path] = countTests(await git(['show', `${rev}:${path}`], top))
  })
  return counts
}

/** Runs at most `limit` of `fn` at a time and keeps the order of the results. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}
// Removing a worktree the engine made.

/** The `node_modules` link that setup made into a worktree: what it is, exactly. */
export interface SetupLink {
  dev: number
  ino: number
  target: string
}

/** Reads the `node_modules` link in a worktree as it is now, or null when there is none. */
export function readSetupLink(path: string): SetupLink | null {
  try {
    const link = join(path, 'node_modules')
    const stat = lstatSync(link)
    return stat.isSymbolicLink() ? { dev: stat.dev, ino: stat.ino, target: readlinkSync(link) } : null
  } catch {
    return null
  }
}

/** The copy of `node_modules` that `provideModules` made: its top folder's inode and creation time (no device number). */
export interface ModulesClone {
  ino: number
  birthtimeMs: number
}

/** Reads `node_modules` in a worktree as it is now when it is a real folder, or null. */
export function readModulesClone(path: string): ModulesClone | null {
  try {
    const stat = lstatSync(join(path, 'node_modules'))
    return stat.isDirectory() ? { ino: stat.ino, birthtimeMs: stat.birthtimeMs } : null
  } catch {
    return null
  }
}

/** The name of the marker file inside a copy of node_modules that Regatta made. */
export const COPY_MARKER = '.regatta-copy'

/**
 * True when `node_modules` in the worktree is a real folder (never a link) holding Regatta's marker
 * for exactly this folder: the marker carries the folder's own inode and creation time, so a marker
 * copied along with a copy of the folder, or left in a folder that was replaced, does not match.
 * Storage uses it to recognise copies in leftovers that have no engine record.
 */
export function isMarkedCopy(worktree: string): boolean {
  const now = readModulesClone(worktree)
  if (!now) return false
  try {
    const marker = join(worktree, 'node_modules', COPY_MARKER)
    if (!lstatSync(marker).isFile()) return false
    return readFileSync(marker, 'utf8').trim() === `${now.ino}:${now.birthtimeMs}`
  } catch {
    return false
  }
}

export interface ProvidedModules {
  /** What was made, to record with the worktree. Null when nothing was copied. */
  clone: ModulesClone | null
  /** Something the user should be told, or null. */
  note: string | null
}

/** How long a copy of node_modules may take: a copy-on-write clone is seconds, a minute means something is wrong. */
const CLONE_TIMEOUT_MS = 120_000
const NOT_COPIED = 'Dependencies were not copied into the worktree; run your install command there.'
const LINKS_OUT = 'node_modules links outside the worktree (for example npm link); install dependencies in the worktree yourself.'
const MARKER_TAKEN = 'node_modules already holds a .regatta-copy entry; install dependencies in the worktree yourself.'

/** True when `path` is `base` or inside it. */
function within(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * The symlinks in the copy, now in place at `to`, whose real target is not inside the real worktree
 * or cannot be worked out at all (a loop, a dangling link). The operating system resolves each one
 * (`realpath` on the link's own path), so every ancestor and every chain is followed exactly as a
 * write through it would follow them, including `..` after a link, which a hand-written resolver
 * gets wrong. Links that stay inside (`.bin`, workspace packages under the worktree) are fine.
 */
async function linksLeaving(to: string, worktree: string): Promise<string[]> {
  const listing = await new Promise<string>((done, fail) => {
    execFile('find', [to, '-type', 'l', '-print0'], { timeout: CLONE_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) =>
      err ? fail(err) : done(String(stdout))
    )
  })
  const real = realpathSync(worktree)
  const out: string[] = []
  for (const link of listing.split('\0').filter((name) => name.length > 0)) {
    try {
      if (!within(realpathSync(link), real)) out.push(link)
    } catch {
      out.push(link)
    }
  }
  return out
}

/**
 * Gives a worktree its own `node_modules`: a copy-on-write clone of the project's (`cp -c -R` on
 * macOS APFS, which takes seconds and no extra disk until a file changes; `--reflink=always` where
 * Linux supports it). It is a copy, never a link, because anything that runs in a worktree
 * (`npm ci`, `rm -rf node_modules`) must not be able to touch the user's own dependencies.
 *
 * The copy is made in a private folder of Regatta's own (`<worktrees folder>/.regatta-tmp/<random>`,
 * on the same volume), checked, marked, and only then renamed into place, and only if nothing is
 * there by then. A failure cleans up that private folder and nothing else, so a file the user made
 * in the worktree meanwhile is never touched. The check refuses a copy with a symlink that leaves
 * the worktree (`npm link`, absolute links into the project): the worktree then gets no
 * `node_modules` and the note says so.
 *
 * When the project has no `node_modules`, or the worktree already has one (the project tracks it),
 * nothing is done. When cloning is not possible (another volume, not APFS, not macOS) the worktree
 * gets no `node_modules` and the note says to install there. The returned `clone` is what
 * `pristineCheck` later exempts: the worktree's own marked copy.
 */
export async function provideModules(projectRoot: string, worktree: string, tmpDir?: string): Promise<ProvidedModules> {
  const from = join(projectRoot, 'node_modules')
  const to = join(worktree, 'node_modules')
  try {
    if (!lstatSync(from).isDirectory()) throw new Error('not a folder')
  } catch {
    // No dependencies to give (or a link in the project, which a copy of would still lead out of the worktree).
    return { clone: null, note: pathStillThere(from) ? NOT_COPIED : null }
  }
  if (pathStillThere(to)) return { clone: null, note: null }
  const args =
    process.platform === 'darwin' ? ['-c', '-R'] : process.platform === 'linux' ? ['--reflink=always', '-R'] : null
  if (!args) return { clone: null, note: NOT_COPIED }

  const base = tmpDir ?? join(dirname(resolve(worktree)), '.regatta-tmp')
  let staging: string | null = null
  try {
    // Another copy finishing may remove the empty folder between these two steps: try again.
    for (let attempt = 0; staging === null; attempt++) {
      try {
        mkdirSync(base, { recursive: true })
        staging = mkdtempSync(join(base, 'copy-'))
      } catch (err) {
        if (attempt >= 3) throw err
      }
    }
    const copy = join(staging, 'node_modules')
    await new Promise<void>((done, fail) => {
      execFile('cp', [...args, from, copy], { timeout: CLONE_TIMEOUT_MS }, (err) => (err ? fail(err) : done()))
    })
    // The marker is written into the copy; a copy that already has such an entry (a link in the project's own
    // node_modules, say) would have the write land wherever the entry leads.
    if (pathStillThere(join(copy, COPY_MARKER))) {
      rmSync(staging, { recursive: true, force: true })
      return { clone: null, note: MARKER_TAKEN }
    }
    const stat = lstatSync(copy)
    writeFileSync(join(copy, COPY_MARKER), `${stat.ino}:${stat.birthtimeMs}\n`, { flag: 'wx' })
    // Into place only if nothing has appeared there meanwhile; the rename keeps the folder's inode and creation time.
    if (pathStillThere(to)) {
      rmSync(staging, { recursive: true, force: true })
      return { clone: null, note: null }
    }
    renameSync(copy, to)
    // Only now, in place and before anything runs in the worktree, are the links looked at: the system resolves them.
    let leaving: string[]
    try {
      leaving = await linksLeaving(to, worktree)
    } catch {
      leaving = [to]
    }
    if (leaving.length > 0) {
      // Back to the private folder, and gone from there.
      try {
        renameSync(to, copy)
      } catch {
        // If it cannot be moved back it is not deleted where the user can see it: the note says what to do.
        return { clone: null, note: `${LINKS_OUT} (the copy stays at ${to}; remove it before installing)` }
      }
      rmSync(staging, { recursive: true, force: true })
      return { clone: null, note: LINKS_OUT }
    }
    rmSync(staging, { recursive: true, force: true })
  } catch {
    // Not a clone, not a half copy: only the private folder goes.
    if (staging) rmSync(staging, { recursive: true, force: true })
    return { clone: null, note: NOT_COPIED }
  } finally {
    try {
      rmdirSync(base)
    } catch {
      // Other copies are being made, or something else lives there.
    }
  }
  return { clone: readModulesClone(worktree), note: null }
}

import { closeSync, fsyncSync, openSync } from 'node:fs'
import { ALTERED_TRASH_ENTRY, MOVED_OUT_TRASH_ENTRY, REATTACHED_TRASH_ENTRY, UNFINISHED_TRASH_ENTRY } from '../../shared/trash'

export { processesInside }
export const TRASH_DIR_NAME = '.regatta-trash'
export const TRASH_LOCK_REASON = "In Regatta's trash"
export const LOST_ENTRY_RECORD = "Regatta's record of this entry was lost"
/**
 * The name Empty trash renames a worktree folder to inside its entry just before deleting what is in it. Only Regatta
 * puts a folder there, so an entry holding it (and an `emptying` mark) was being emptied when it stopped: the next
 * Empty trash finishes it, and a folder the user moves out of an entry is never mistaken for one Regatta deleted.
 */
const DELETING_FOLDER = '.regatta-deleting'
// The listed states live in src/shared/trash.ts so Settings > Storage shows exactly these strings.
export { ALTERED_TRASH_ENTRY, MOVED_OUT_TRASH_ENTRY, REATTACHED_TRASH_ENTRY, UNFINISHED_TRASH_ENTRY }

/** A worktree an engine created, with what it needs to prove later that it is still the one it made. */
export interface OwnedWorktree {
  /** The repository the worktree belongs to. */
  root: string
  path: string
  /** The branch checked out in the worktree, when known. */
  branch?: string | null
  /** `worktreeIdentity(path)` taken when git created it. Null means it could not be read: never retired. */
  identity: string | null
  /** The folder Regatta keeps its worktrees in. For a lane worktree `path` must be inside it. */
  dir?: string
  /** Legacy fields kept for caller compatibility. */
  setupLink?: SetupLink | null
  modulesClone?: ModulesClone | null
  /** The name to keep its commits under, below `refs/regatta/discarded/`. Defaults to the folder's name. */
  keepAs?: string
  /**
   * True for a temporary worktree that exists only during one operation and is never shown: a
   * baseline, the one checks run in, the one a merge is built in. It is removed (forced) whatever
   * it holds, once its identity is confirmed. A lane worktree is never disposable.
   */
  disposable?: boolean
}

/** What became of retiring a worktree. `foreign`: another folder sits there now, left alone and not ours to track. */
export interface WorktreeRetirement {
  status: 'trashed' | 'removed' | 'gone' | 'foreign' | 'kept'
  /** Why it was kept or left alone. Null when it was trashed, removed, or was already gone. */
  reason: string | null
  /** Where the worktree sits now inside Regatta's trash (`status === 'trashed'`). */
  trashPath?: string
  /** The ref holding the keep commit made before retiring (a lane worktree only); `git log <ref>` shows what it keeps. */
  keepRef?: string
}

export type WorktreeRemoval = WorktreeRetirement

/** What `entry.json` records inside each `.regatta-trash/<entry>/` folder. */
export interface TrashEntryMeta {
  version: 1
  originalPath: string
  root: string
  branch: string | null
  identity: string
  keepRef: string
  movedAt: string
  repaired: boolean
  repairError?: string | null
  lastEmptyError?: string | null
  /**
   * When Empty trash started deleting this entry (written before its first deletion). An entry that still
   * has it was interrupted, and the next Empty trash finishes it instead of taking it for one the user moved out.
   */
  emptying?: string | null
  /**
   * When Empty trash itself deleted the worktree folder (written right after the delete succeeded). Only an entry with
   * both marks and nothing but `entry.json` left is finished as unfinished: a delete that failed leaves `emptying`
   * alone, and a worktree the user then moved out of the entry is "moved out", git records untouched.
   */
  folderDeleted?: string | null
}

/** One trashed worktree entry as listed for Settings > Storage. */
export interface ListedTrashEntry {
  entryId: string
  entryPath: string
  trashPath: string
  originalPath: string
  root: string
  branch: string | null
  identity: string | null
  keepRef: string
  movedAt: string
  bytes: number | null
  inUse: string[]
  changedSinceMoved: 'yes' | 'no' | 'unknown'
  repaired: boolean
  note?: string | null
  repairError?: string | null
  emptyError?: string | null
  lastEmptyError?: string | null
}

/** What happened to one trash entry when the user emptied the trash. */
export interface EmptyTrashOutcome {
  entryId: string
  entryPath: string
  trashPath: string
  originalPath: string
  branch: string | null
  status: 'deleted' | 'skipped' | 'error'
  reason: string | null
  keepRef?: string
  branchDeleted?: boolean
  branchParked?: string
  branchOutcome?: string | null
}

const lastEmptyTrashErrors = new Map<string, string>()

function writeAndFsyncFile(filePath: string, content: string, mode = 0o600): void {
  const fd = openSync(filePath, 'w', mode)
  try {
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function fsyncDir(dirPath: string): void {
  const fd = openSync(dirPath, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function tryFsyncDir(dirPath: string): void {
  try {
    fsyncDir(dirPath)
  } catch {
    // Best-effort directory sync on cleanup paths.
  }
}

/**
 * Keeps everything a worktree could be the last holder of, before it is retired: its HEAD, the
 * old and new id of every entry in its HEAD reflog, and its per-worktree refs, in one keep commit at
 * `refs/regatta/discarded/<name>` (see `keepCommits`). Returns that ref. Throws if it could not be
 * made; then the worktree must not be retired.
 *
 * When `worktreeGitDir` is supplied (or can be read from `<worktreePath>/.git`), all git commands
 * run inside that git folder rather than `worktreePath`, so a tampered or deleted `<worktreePath>/.git`
 * cannot redirect git to another repository.
 */
export async function keepWorktreeHistory(
  root: string,
  worktreePath: string,
  name: string,
  worktreeGitDir?: string
): Promise<string> {
  const target = resolve(worktreePath)
  const resolvedFromDotGit = worktreeGitDir ? resolve(worktreeGitDir) : readDotGitTarget(target)
  const gitDir = resolvedFromDotGit ?? (await git(['rev-parse', '--absolute-git-dir'], target)).trim()
  const format = (await tryGit(['rev-parse', '--show-ref-format'], gitDir))?.trim()
  if (format && format !== 'files') throw new Error(`reflogs are stored as ${format}, which this cannot read`)
  const ids: string[] = []
  const head = (await tryGit(['rev-parse', '--verify', '-q', 'HEAD'], gitDir))?.trim()
  if (head) ids.push(head)
  // Every log the worktree owns, old and new id of every entry: HEAD's, and those of its own refs (refs/worktree,
  // refs/bisect, refs/rewritten and any other), where a ref that moved from A to B may be the only one remembering A.
  for (const file of filesUnder(join(gitDir, 'logs'))) ids.push(...idsInLog(readFileSync(file, 'utf8')))
  const own = await git(['for-each-ref', '--format=%(objectname)', 'refs/worktree', 'refs/bisect', 'refs/rewritten'], gitDir)
  ids.push(...own.split('\n').map((line) => line.trim()).filter(Boolean))
  // The worktree's own pseudo refs (ORIG_HEAD, every FETCH_HEAD entry, MERGE_HEAD...): reflog expiry and a reset
  // leave a commit remembered only there, and they go with the worktree's git folder.
  for (const ref of pseudoRefs(gitDir)) ids.push(...idsInPseudoRef(ref.text))
  // A `rebase --autostash` in progress holds the user's uncommitted changes as a commit only a file names: keep it by a ref.
  for (const folder of ['rebase-merge', 'rebase-apply']) {
    try {
      ids.push(...idsInPseudoRef(readFileSync(join(gitDir, folder, 'autostash'), 'utf8')))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
    }
  }
  return keepCommits(root, ids, name, `Kept commits of worktree ${basename(target)} before Regatta retired it`)
}

/**
 * Byte snapshot of the worktree-local git state (the names at its top level, `HEAD`, pseudo refs, `logs/**`
 * and `refs/**`) inside `<common dir>/worktrees/<id>`. Re-read as the very last step before each deletion of
 * Empty trash (the worktree folder, the entry folder, the git folder) so any commit written after
 * `keepWorktreeHistory` stops it.
 */
function worktreeGitStateSnapshot(gitDir: string): string | null {
  try {
    const st = lstatSync(gitDir)
    if (!st.isDirectory() || st.isSymbolicLink()) return null
    // What the folder holds at its top level (name and kind), so a new entry such as `modules/` changes the stamp too.
    const listing = readdirSync(gitDir, { withFileTypes: true })
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : entry.isFile() ? '' : '@'}`)
      .sort()
    const parts: string[] = [`LIST:${listing.join('\0')}`]
    const headPath = join(gitDir, 'HEAD')
    try {
      const hStat = lstatSync(headPath)
      if (hStat.isSymbolicLink() || !hStat.isFile()) return null
      parts.push(`HEAD:${readFileSync(headPath, 'utf8')}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    for (const ref of pseudoRefs(gitDir).sort((a, b) => a.name.localeCompare(b.name))) {
      parts.push(`PSEUDO:${ref.name}:${ref.text}`)
    }
    for (const sub of ['logs', 'refs']) {
      const files = filesUnder(join(gitDir, sub)).sort()
      for (const file of files) {
        const rel = file.slice(gitDir.length)
        parts.push(`${rel}:${readFileSync(file, 'utf8')}`)
      }
    }
    return parts.join('\0')
  } catch {
    return null
  }
}

function parseWorktreeIdentity(identity: string | null): { gitDir: string; ino: string; birthtimeMs: string } | null {
  if (!identity) return null
  const match = identity.match(/^(.*)\|(?:i|\d+:)(\d+)\|([\d.e+-]+)$/)
  if (!match) return null
  return { gitDir: match[1]!, ino: match[2]!, birthtimeMs: match[3]! }
}

interface ResolvedIdentityGit {
  gitDir: string
  commonDir: string
  root: string
}

/**
 * Resolves the worktree git folder, common git directory, and repository root directly from a
 * recorded `identity` (`<gitDir>|i<ino>|<birthtimeMs>`) and `<gitDir>/commondir`, without running git
 * inside the trashed worktree folder.
 */
function resolveIdentityGitFolder(identity: string | null): ResolvedIdentityGit | null {
  const parsed = parseWorktreeIdentity(identity)
  if (!parsed) return null
  try {
    const st = lstatSync(parsed.gitDir)
    if (!st.isDirectory() || st.isSymbolicLink()) return null
    if (String(st.ino) !== parsed.ino || String(st.birthtimeMs) !== parsed.birthtimeMs) return null
    const realGitDir = realpathSync(parsed.gitDir)
    const commondirFile = join(realGitDir, 'commondir')
    const commonStat = lstatSync(commondirFile)
    if (!commonStat.isFile() || commonStat.isSymbolicLink()) return null
    const rawCommon = readFileSync(commondirFile, 'utf8').trim()
    if (!rawCommon) return null
    const resolvedCommon = isAbsolute(rawCommon) ? resolve(rawCommon) : resolve(realGitDir, rawCommon)
    const commonDirStat = lstatSync(resolvedCommon)
    if (!commonDirStat.isDirectory()) return null
    const realCommonDir = realpathSync(resolvedCommon)
    if (dirname(realGitDir) !== join(realCommonDir, 'worktrees')) return null
    const root = basename(realCommonDir) === '.git' ? dirname(realCommonDir) : realCommonDir
    return { gitDir: realGitDir, commonDir: realCommonDir, root }
  } catch {
    return null
  }
}

function existingWorktreeLockReason(identity: string | null): string | null {
  const parsed = parseWorktreeIdentity(identity)
  if (!parsed) return null
  try {
    const lockedFile = join(parsed.gitDir, 'locked')
    const st = lstatSync(lockedFile)
    if (!st.isFile() || st.isSymbolicLink()) return null
    return readFileSync(lockedFile, 'utf8').replace(/\r?\n$/, '')
  } catch {
    return null
  }
}

function readWorktreeBranchFromIdentity(identity: string | null): string | null {
  const parsed = parseWorktreeIdentity(identity)
  if (!parsed) return null
  return readBranchFromGitDir(parsed.gitDir)
}

function readBranchFromGitDir(gitDir: string): string | null {
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length).trim() || null : null
  } catch {
    return null
  }
}

function readDotGitTarget(worktreePath: string, fallbackBase?: string): string | null {
  try {
    const dotGit = join(worktreePath, '.git')
    const st = lstatSync(dotGit)
    if (!st.isFile() || st.isSymbolicLink()) return null
    const text = readFileSync(dotGit, 'utf8').trim()
    const written = text.match(/^gitdir:\s*(.+)$/)?.[1]?.trim()
    if (!written) return null
    if (isAbsolute(written)) return resolve(written)
    const fromWorktree = resolve(worktreePath, written)
    if (pathStillThere(fromWorktree) || !fallbackBase) return fromWorktree
    return resolve(fallbackBase, written)
  } catch {
    return null
  }
}

function isValidTrashFolderName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    name !== 'entry.json' &&
    name !== '.DS_Store' &&
    name !== DELETING_FOLDER &&
    basename(name) === name &&
    !name.includes('/') &&
    !name.includes('\0')
  )
}

function isRealSubdirectoryOf(entryPath: string, childPath: string): boolean {
  try {
    const entrySt = lstatSync(entryPath)
    if (!entrySt.isDirectory() || entrySt.isSymbolicLink()) return false
    const childSt = lstatSync(childPath)
    if (!childSt.isDirectory() || childSt.isSymbolicLink()) return false
    return dirname(realpathSync(childPath)) === realpathSync(entryPath)
  } catch {
    return false
  }
}

type DotGitInspection =
  | { status: 'matches'; gitDir: string }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string }

function inspectTrashDotGit(trashPath: string, originalPath: string, identity: string): DotGitInspection {
  const parsed = parseWorktreeIdentity(identity)
  if (!parsed) return { status: 'invalid', reason: 'The worktree identity in entry.json is invalid.' }
  const dotGit = join(trashPath, '.git')
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(dotGit)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid', reason: 'The trashed worktree .git entry could not be read.' }
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    return { status: 'invalid', reason: 'The trashed worktree .git entry is not a regular file.' }
  }
  let pointer: string
  try {
    pointer = readFileSync(dotGit, 'utf8').trim()
  } catch {
    return { status: 'invalid', reason: 'The trashed worktree .git file could not be read.' }
  }
  const written = pointer.match(/^gitdir:\s*(.+)$/)?.[1]?.trim()
  if (!written) {
    return { status: 'invalid', reason: 'The trashed worktree .git file has no gitdir pointer.' }
  }
  const matchesIdentity = [trashPath, originalPath].some((base) => {
    try {
      const candidateDir = isAbsolute(written) ? resolve(written) : resolve(base, written)
      const dirStat = lstatSync(candidateDir)
      return (
        realpathSync(candidateDir) === realpathSync(parsed.gitDir) &&
        String(dirStat.ino) === parsed.ino &&
        String(dirStat.birthtimeMs) === parsed.birthtimeMs
      )
    } catch {
      return false
    }
  })
  if (!matchesIdentity) {
    return { status: 'invalid', reason: 'The trashed worktree .git file does not name the worktree git folder.' }
  }
  return { status: 'matches', gitDir: realpathSync(parsed.gitDir) }
}

/**
 * Repairs git's link to a trashed worktree after it moved into `.regatta-trash/<entry>/<name>`.
 * Only runs `git worktree repair <trashPath>` when `<trashPath>` is a real folder inside `entryDir`
 * and `<trashPath>/.git` is a regular file whose `gitdir:` line names the worktree's own git folder
 * (matching `meta.identity`), then confirms `<gitDir>/gitdir` and `<trashPath>/.git` point to each
 * other without running git inside `<trashPath>`. Any error is caught and recorded in `entry.json`
 * with `repaired: false`.
 */
export async function repairTrashedWorktree(entryDir: string, loadedMeta?: TrashEntryMeta): Promise<TrashEntryMeta> {
  const metaPath = join(entryDir, 'entry.json')
  const meta: TrashEntryMeta = loadedMeta ?? (JSON.parse(readFileSync(metaPath, 'utf8')) as TrashEntryMeta)
  const fail = (reason: string): TrashEntryMeta => {
    const updated: TrashEntryMeta = { ...meta, repaired: false, repairError: reason }
    try {
      writeAndFsyncFile(metaPath, JSON.stringify(updated, null, 2), 0o600)
      tryFsyncDir(entryDir)
    } catch {
      // Best-effort metadata update.
    }
    return updated
  }
  try {
    const folderName = basename(meta.originalPath)
    if (!isValidTrashFolderName(folderName)) return fail(ALTERED_TRASH_ENTRY)
    const trashPath = join(entryDir, folderName)
    if (!isRealSubdirectoryOf(entryDir, trashPath)) return fail(ALTERED_TRASH_ENTRY)
    const idGit = resolveIdentityGitFolder(meta.identity)
    if (!idGit) return fail('The worktree identity in entry.json does not resolve to a worktree git folder.')
    // A copy the user restored (repaired elsewhere, or put back at the original path) uses the git folder now:
    // repairing would take it back.
    if (attachedElsewhere(idGit.gitDir, trashPath, meta.originalPath, meta.repaired === true)) return fail(REATTACHED_TRASH_ENTRY)
    const dotGitCheck = inspectTrashDotGit(trashPath, meta.originalPath, meta.identity)
    if (dotGitCheck.status !== 'matches') {
      return fail(dotGitCheck.status === 'missing' ? 'The trashed worktree has no .git entry.' : dotGitCheck.reason)
    }
    await git(['worktree', 'repair', trashPath], idGit.root)
    const afterCheck = inspectTrashDotGit(trashPath, meta.originalPath, meta.identity)
    if (afterCheck.status !== 'matches') {
      return fail('git worktree repair did not leave a valid .git pointer in the trashed worktree.')
    }
    const expectedDotGit = join(realpathSync(trashPath), '.git')
    if (!verifyWorktreeGitFolderBeforeDeleteSync(idGit.commonDir, idGit.gitDir, expectedDotGit)) {
      return fail('git worktree repair did not point the worktree git folder at the trashed worktree.')
    }
    const updated: TrashEntryMeta = { ...meta, root: idGit.root, repaired: true }
    delete updated.repairError
    writeAndFsyncFile(metaPath, JSON.stringify(updated, null, 2), 0o600)
    tryFsyncDir(entryDir)
    return updated
  } catch (err) {
    return fail(errorText(err))
  }
}

/**
 * Retires a worktree an engine or Storage owns.
 *
 * A temporary (`disposable: true`) worktree is removed with `git worktree remove --force` once its
 * identity is confirmed. A lane worktree is never deleted here: after `keepWorktreeHistory` parks
 * every commit it could be the last holder of under `refs/regatta/discarded/`, the worktree is
 * locked in git with reason `"In Regatta's trash"`, the whole folder is moved into
 * `<worktreesDir>/.regatta-trash/<entry>/<name>` with a single `renameSync`, and `git worktree repair`
 * keeps git pointing at the new path so its branch stays checked out there until the user empties
 * the trash in Settings > Storage.
 */
export async function trashOwnedWorktree(record: OwnedWorktree): Promise<WorktreeRetirement> {
  const { root, path } = record
  const keep = (reason: string): WorktreeRetirement => ({ status: 'kept', reason })
  const target = resolve(path)
  if (record.dir) {
    const base = resolve(record.dir)
    if (target === base || !target.startsWith(base + sep)) return keep(`${path} is not inside ${base}, so it was left alone.`)
  }
  let targetStat: ReturnType<typeof lstatSync>
  try {
    targetStat = lstatSync(target)
  } catch {
    return { status: 'gone', reason: null }
  }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    return keep(`${path} is not a real folder, so it was left alone.`)
  }
  if (record.identity === null) return keep(`${path} was kept: Regatta cannot tell whether it is the worktree it made.`)
  if (!sameWorktree(target, record.identity)) {
    return { status: 'foreign', reason: `${path} is not the worktree Regatta made any more, so it was left alone.` }
  }
  if (!record.disposable && !record.dir) {
    return keep(`${path} was kept: Regatta does not know its worktrees folder.`)
  }
  try {
    hooksSandbox()
  } catch (err) {
    return keep(`${path} was kept: ${errorText(err)}.`)
  }

  if (record.disposable) {
    try {
      await git(['worktree', 'remove', '--force', target], root)
    } catch (err) {
      if (!pathStillThere(target)) return { status: 'removed', reason: null }
      return keep(`${path} was kept: ${errorText(err)}`)
    }
    return { status: 'removed', reason: null }
  }

  const parsedIdentity = parseWorktreeIdentity(record.identity)
  const idGit = resolveIdentityGitFolder(record.identity)
  const effectiveRoot = idGit?.root ?? (() => {
    try {
      return realpathSync(root)
    } catch {
      return resolve(root)
    }
  })()

  const branch = record.branch !== undefined ? record.branch : readWorktreeBranchFromIdentity(record.identity)
  let keepRef: string
  try {
    keepRef = await keepWorktreeHistory(
      effectiveRoot,
      target,
      record.keepAs ?? basename(target),
      parsedIdentity?.gitDir
    )
  } catch (err) {
    return keep(`${path} was kept: a copy of its commits could not be made (${errorText(err)}).`)
  }

  let realDir: string
  try {
    realDir = realpathSync(record.dir!)
  } catch (err) {
    return { ...keep(`${path} was kept: ${errorText(err)}`), keepRef }
  }

  const trash = join(realDir, TRASH_DIR_NAME)
  try {
    let st: ReturnType<typeof lstatSync> | null = null
    try {
      st = lstatSync(trash)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    if (!st) {
      mkdirSync(trash, { mode: 0o700 })
      st = lstatSync(trash)
    }
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return { ...keep(`${path} was kept: ${trash} is not a folder.`), keepRef }
    }
  } catch (err) {
    return { ...keep(`${path} was kept: ${errorText(err)}`), keepRef }
  }

  const folderName = basename(target)
  // An entry is only ever trusted with a worktree folder of a name it can hold (never `entry.json` or `.regatta-deleting`).
  if (!isValidTrashFolderName(folderName)) return { ...keep(`${path} was kept: Regatta's trash cannot hold a folder named ${folderName}.`), keepRef }
  let entryDir: string
  try {
    entryDir = mkdtempSync(join(trash, `${folderName}-`))
  } catch (err) {
    return { ...keep(`${path} was kept: ${errorText(err)}`), keepRef }
  }

  // Wait 2ms before stamping movedAt so any file written before trashing has mtime strictly <= movedAt.
  await new Promise((r) => setTimeout(r, 2))
  const metaPath = join(entryDir, 'entry.json')
  const trashPath = join(entryDir, folderName)
  const meta: TrashEntryMeta = {
    version: 1,
    originalPath: target,
    root: effectiveRoot,
    branch,
    identity: record.identity,
    keepRef,
    movedAt: new Date().toISOString(),
    repaired: false
  }

  const cleanupFailedEntry = (): void => {
    try {
      unlinkSync(metaPath)
    } catch {
      // Best-effort cleanup of entry.json.
    }
    try {
      rmdirSync(entryDir)
    } catch {
      // Best-effort cleanup of the empty entry folder.
    }
    tryFsyncDir(trash)
  }

  try {
    writeAndFsyncFile(metaPath, JSON.stringify(meta, null, 2), 0o600)
    fsyncDir(entryDir)
    fsyncDir(trash)
  } catch (err) {
    cleanupFailedEntry()
    return { ...keep(`${path} was kept: ${errorText(err)}`), keepRef }
  }

  // Re-verify target is still a real directory with the same worktree identity right before locking and renaming.
  try {
    const stNow = lstatSync(target)
    if (stNow.isSymbolicLink() || !stNow.isDirectory() || !sameWorktree(target, record.identity)) {
      cleanupFailedEntry()
      return keep(`${path} changed while Regatta was preparing to move it, so it was left alone.`)
    }
  } catch {
    cleanupFailedEntry()
    return { status: 'gone', reason: null, keepRef }
  }

  // Lock the worktree in git before moving so git worktree prune and git gc never remove its git folder.
  try {
    await git(['worktree', 'lock', '--reason', TRASH_LOCK_REASON, target], effectiveRoot)
  } catch (err) {
    if (err instanceof HooksSandboxError || existingWorktreeLockReason(record.identity) !== TRASH_LOCK_REASON) {
      cleanupFailedEntry()
      return { ...keep(`${path} was kept: ${errorText(err)}`), keepRef }
    }
  }

  try {
    renameSync(target, trashPath)
  } catch (err) {
    await tryGit(['worktree', 'unlock', target], effectiveRoot).catch(() => null)
    cleanupFailedEntry()
    if (!pathStillThere(target)) return { status: 'gone', reason: null, keepRef }
    return { ...keep(`${path} was kept: ${errorText(err)}`), keepRef }
  }

  tryFsyncDir(entryDir)
  tryFsyncDir(trash)
  tryFsyncDir(realDir)

  await repairTrashedWorktree(entryDir, meta)
  return { status: 'trashed', reason: null, trashPath, keepRef }
}

export const removeOwnedWorktree = trashOwnedWorktree

const MAX_TRASH_SCAN_ENTRIES = 100_000

/**
 * Checks whether any entry inside `trashPath` has an `lstat` mtime newer than `movedAtIso`, without
 * following symlinks, skipping `.git` and the `node_modules` copy that Regatta (`provideModules`)
 * provided. Stops at 100,000 entries and returns `'unknown'` ("could not check every file").
 */
function checkChangedSinceMoved(trashPath: string, movedAtIso: string): 'yes' | 'no' | 'unknown' {
  const movedAtMs = Date.parse(movedAtIso)
  if (!Number.isFinite(movedAtMs)) return 'unknown'
  let count = 0
  let newestMs = 0
  try {
    const top = lstatSync(trashPath)
    if (top.isSymbolicLink() || !top.isDirectory()) return 'unknown'
    newestMs = Math.floor(top.mtimeMs)
  } catch {
    return 'unknown'
  }
  const stack = [trashPath]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let handle
    try {
      handle = opendirSync(dir)
    } catch {
      return 'unknown'
    }
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (dir === trashPath && entry.name === '.git') continue
        if (entry.name === 'node_modules' && isMarkedCopy(dir)) continue
        count++
        if (count > MAX_TRASH_SCAN_ENTRIES) return 'unknown'
        const full = join(dir, entry.name)
        let st: ReturnType<typeof lstatSync>
        try {
          st = lstatSync(full)
        } catch {
          return 'unknown'
        }
        if (st.mtimeMs > newestMs) newestMs = st.mtimeMs
        if (!st.isSymbolicLink() && st.isDirectory()) {
          stack.push(full)
        }
      }
    } finally {
      handle.closeSync()
    }
  }
  return newestMs > movedAtMs ? 'yes' : 'no'
}

/** Measures `path` with `du -sk`, returning bytes (`kb * 1024`) or null when `du` fails. */
function measureDuBytes(path: string): Promise<number | null> {
  return new Promise((done) => {
    execFile('du', ['-sk', path], { timeout: 15_000 }, (err, stdout) => {
      if (err) return done(null)
      const token = String(stdout ?? '').trim().split(/\s+/)[0] ?? ''
      const kb = Number.parseInt(token, 10)
      done(Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null)
    })
  })
}

type MetaReadOutcome =
  | { kind: 'valid'; meta: TrashEntryMeta }
  | { kind: 'missing-or-corrupt' }
  | { kind: 'altered'; rawMeta: TrashEntryMeta | null }

function inspectEntryMetaFile(entryPath: string, expectedChildName?: string): MetaReadOutcome {
  const metaFile = join(entryPath, 'entry.json')
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(metaFile)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing-or-corrupt' }
    return { kind: 'altered', rawMeta: null }
  }
  if (!st.isFile() || st.isSymbolicLink()) return { kind: 'altered', rawMeta: null }
  let raw: Partial<TrashEntryMeta>
  try {
    raw = JSON.parse(readFileSync(metaFile, 'utf8')) as Partial<TrashEntryMeta>
  } catch {
    return { kind: 'missing-or-corrupt' }
  }
  if (typeof raw !== 'object' || raw === null) return { kind: 'missing-or-corrupt' }
  if (typeof raw.originalPath !== 'string' || typeof raw.root !== 'string' || typeof raw.identity !== 'string') {
    return { kind: 'missing-or-corrupt' }
  }
  const meta: TrashEntryMeta = {
    version: 1,
    originalPath: raw.originalPath,
    root: raw.root,
    branch: typeof raw.branch === 'string' ? raw.branch : null,
    identity: raw.identity,
    keepRef: typeof raw.keepRef === 'string' ? raw.keepRef : '',
    movedAt: typeof raw.movedAt === 'string' ? raw.movedAt : new Date(0).toISOString(),
    repaired: Boolean(raw.repaired),
    ...(typeof raw.repairError === 'string' ? { repairError: raw.repairError } : {}),
    ...(typeof raw.lastEmptyError === 'string' ? { lastEmptyError: raw.lastEmptyError } : {}),
    ...(typeof raw.emptying === 'string' ? { emptying: raw.emptying } : {}),
    ...(typeof raw.folderDeleted === 'string' ? { folderDeleted: raw.folderDeleted } : {})
  }
  const base = basename(meta.originalPath)
  if (!isValidTrashFolderName(base)) return { kind: 'altered', rawMeta: meta }
  if (expectedChildName !== undefined && base !== expectedChildName) return { kind: 'altered', rawMeta: meta }
  if (!parseWorktreeIdentity(meta.identity)) return { kind: 'altered', rawMeta: meta }
  return { kind: 'valid', meta }
}

interface RecoveredTrashEntry {
  gitDir: string
  commonDir: string
  root: string
  branch: string | null
  recordedDotGit: string
}

/**
 * Recovers git folder, common dir, repository root, and branch metadata when `entry.json` is missing
 * or unreadable, by reading `<trashPath>/.git`, `<gitDir>/commondir`, and `<gitDir>/HEAD` directly
 * (never running git inside `trashPath`). For a relative `gitdir:` written by `git worktree add --relative-paths`
 * before `worktree repair` ran, also resolves against `<realWorktreesDir>/<name>`.
 */
function recoverLostTrashEntry(trashPath: string, realWorktreesDir: string): RecoveredTrashEntry | null {
  try {
    const dotGit = join(trashPath, '.git')
    const st = lstatSync(dotGit)
    if (!st.isFile() || st.isSymbolicLink()) return null
    const text = readFileSync(dotGit, 'utf8').trim()
    const written = text.match(/^gitdir:\s*(.+)$/)?.[1]?.trim()
    if (!written) return null

    const folderName = basename(trashPath)
    const fallbackOriginalPath = join(realWorktreesDir, folderName)
    const bases = isAbsolute(written) ? [trashPath] : [trashPath, fallbackOriginalPath]

    let realGitDir: string | null = null
    for (const base of bases) {
      try {
        const candidate = isAbsolute(written) ? resolve(written) : resolve(base, written)
        const dirStat = lstatSync(candidate)
        if (dirStat.isDirectory() && !dirStat.isSymbolicLink()) {
          realGitDir = realpathSync(candidate)
          break
        }
      } catch {
        // Try next base.
      }
    }
    if (!realGitDir) return null

    const commondirFile = join(realGitDir, 'commondir')
    const commonStat = lstatSync(commondirFile)
    if (!commonStat.isFile() || commonStat.isSymbolicLink()) return null
    const rawCommon = readFileSync(commondirFile, 'utf8').trim()
    if (!rawCommon) return null
    const resolvedCommon = isAbsolute(rawCommon) ? resolve(rawCommon) : resolve(realGitDir, rawCommon)
    const commonDirStat = lstatSync(resolvedCommon)
    if (!commonDirStat.isDirectory()) return null
    const realCommonDir = realpathSync(resolvedCommon)
    if (dirname(realGitDir) !== join(realCommonDir, 'worktrees')) return null

    const gitdirFile = join(realGitDir, 'gitdir')
    const gitdirStat = lstatSync(gitdirFile)
    if (!gitdirStat.isFile() || gitdirStat.isSymbolicLink()) return null
    const recorded = readFileSync(gitdirFile, 'utf8').trim()
    if (!recorded) return null
    const resolvedRecorded = isAbsolute(recorded) ? resolve(recorded) : resolve(realGitDir, recorded)

    const root = basename(realCommonDir) === '.git' ? dirname(realCommonDir) : realCommonDir
    const branch = readBranchFromGitDir(realGitDir)
    return {
      gitDir: realGitDir,
      commonDir: realCommonDir,
      root,
      branch,
      recordedDotGit: resolvedRecorded
    }
  } catch {
    return null
  }
}

/** Names the programs (with pid) reported by `processesInside`. */
function describeProcessesInside(users: readonly { pid: number }[]): string[] {
  const pids = [...new Set(users.map((u) => u.pid))].sort((a, b) => a - b)
  if (pids.length === 0) return []
  const names = new Map<number, string>()
  try {
    const out = execFileSync('ps', ['-p', pids.join(','), '-o', 'pid=,comm='], { encoding: 'utf8', timeout: 2000 })
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/)
      if (m) {
        const pid = Number(m[1])
        const comm = basename(m[2]!.trim())
        if (comm) names.set(pid, comm)
      }
    }
  } catch {
    // Fall back to process <pid>.
  }
  return pids.map((pid) => {
    const comm = names.get(pid)
    return comm ? `${comm} (pid ${pid})` : `process ${pid}`
  })
}

/** The programs using something inside `entryPath`, for the Storage list. */
async function inUseInside(entryPath: string): Promise<string[]> {
  try {
    return describeProcessesInside(await processesInside(entryPath, isCaseInsensitive(entryPath)))
  } catch {
    return ['unknown (could not check running programs)']
  }
}

function isMovedOutEntry(meta: TrashEntryMeta | null): boolean {
  if (!meta) return false
  if (meta.repaired || Boolean(meta.repairError)) return true
  return existingWorktreeLockReason(meta.identity) === TRASH_LOCK_REASON && !sameWorktree(meta.originalPath, meta.identity)
}

function cleanupOrphanEntryDir(entryPath: string): void {
  for (const file of ['entry.json', '.DS_Store']) {
    try {
      unlinkSync(join(entryPath, file))
    } catch {
      // Best-effort cleanup.
    }
  }
  try {
    rmdirSync(entryPath)
  } catch {
    // Not empty or could not be removed.
  }
}

/**
 * Lists the entries in `<worktreesDir>/.regatta-trash`.
 * Removes any entry folder that holds only `entry.json` from a crash before `renameSync`, reports
 * any entry whose worktree was moved out of the trash after trashing, flags any entry whose layout
 * or `entry.json` was altered, retries `repairTrashedWorktree` for unrepaired entries, and recovers
 * entries whose `entry.json` was lost or corrupted.
 */
export async function listTrash(worktreesDir: string, emptyErrors?: ReadonlyMap<string, string>): Promise<ListedTrashEntry[]> {
  let realDir: string
  try {
    realDir = realpathSync(worktreesDir)
  } catch {
    return []
  }
  const trashDir = join(realDir, TRASH_DIR_NAME)
  try {
    const st = lstatSync(trashDir)
    if (!st.isDirectory() || st.isSymbolicLink()) return []
  } catch {
    return []
  }

  let names: string[]
  try {
    names = readdirSync(trashDir).sort()
  } catch {
    return []
  }

  const out: ListedTrashEntry[] = []
  for (const name of names) {
    const entryPath = join(trashDir, name)
    try {
      const st = lstatSync(entryPath)
      if (!st.isDirectory() || st.isSymbolicLink()) continue
    } catch {
      continue
    }

    let children: string[]
    try {
      children = readdirSync(entryPath)
    } catch {
      continue
    }

    const significant = children.filter((child) => child !== '.DS_Store').sort()
    const nonMeta = significant.filter((child) => child !== 'entry.json')

    // An Empty trash that stopped while deleting the worktree folder leaves it renamed to `.regatta-deleting`.
    const deletingLeft = nonMeta.length === 1 && nonMeta[0] === DELETING_FOLDER && isRealSubdirectoryOf(entryPath, join(entryPath, DELETING_FOLDER))
    if (nonMeta.length === 0 || deletingLeft) {
      const metaCheck = inspectEntryMetaFile(entryPath)
      const meta = metaCheck.kind === 'valid' ? metaCheck.meta : metaCheck.kind === 'altered' ? metaCheck.rawMeta : null
      const unfinished = metaCheck.kind === 'valid' ? unfinishedGitFolder(entryPath, metaCheck.meta, deletingLeft) : null
      if (unfinished && meta) {
        // An Empty trash deleted the worktree folder and was interrupted: the next one finishes it.
        const emptyError = emptyErrors?.get(entryPath) ?? lastEmptyTrashErrors.get(entryPath) ?? meta.lastEmptyError ?? null
        out.push({
          entryId: name,
          entryPath,
          trashPath: join(entryPath, basename(meta.originalPath)),
          originalPath: meta.originalPath,
          root: unfinished.root,
          branch: meta.branch,
          identity: meta.identity,
          keepRef: meta.keepRef,
          movedAt: meta.movedAt,
          bytes: await measureDuBytes(entryPath),
          inUse: await inUseInside(entryPath),
          changedSinceMoved: 'unknown',
          repaired: meta.repaired,
          note: UNFINISHED_TRASH_ENTRY,
          repairError: UNFINISHED_TRASH_ENTRY,
          ...(emptyError ? { emptyError, lastEmptyError: emptyError } : {})
        })
        continue
      }
      if (!deletingLeft && isMovedOutEntry(meta) && meta) {
        const idGit = resolveIdentityGitFolder(meta.identity)
        const emptyError = emptyErrors?.get(entryPath) ?? lastEmptyTrashErrors.get(entryPath) ?? meta.lastEmptyError ?? null
        out.push({
          entryId: name,
          entryPath,
          trashPath: join(entryPath, isValidTrashFolderName(basename(meta.originalPath)) ? basename(meta.originalPath) : name),
          originalPath: meta.originalPath,
          root: idGit?.root ?? meta.root,
          branch: meta.branch,
          identity: meta.identity,
          keepRef: meta.keepRef,
          movedAt: meta.movedAt,
          bytes: null,
          inUse: [],
          changedSinceMoved: 'unknown',
          repaired: false,
          note: MOVED_OUT_TRASH_ENTRY,
          repairError: MOVED_OUT_TRASH_ENTRY,
          ...(emptyError ? { emptyError, lastEmptyError: emptyError } : {})
        })
        continue
      }
      if (metaCheck.kind === 'altered' || deletingLeft) {
        out.push({
          entryId: name,
          entryPath,
          trashPath: entryPath,
          originalPath: entryPath,
          root: meta?.root ?? '',
          branch: meta?.branch ?? null,
          identity: meta?.identity ?? null,
          keepRef: meta?.keepRef ?? '',
          movedAt: meta?.movedAt ?? '',
          bytes: null,
          inUse: [],
          changedSinceMoved: 'unknown',
          repaired: false,
          note: ALTERED_TRASH_ENTRY,
          repairError: ALTERED_TRASH_ENTRY
        })
        continue
      }
      cleanupOrphanEntryDir(entryPath)
      continue
    }

    const childName = nonMeta[0]!
    const candidateTrashPath = join(entryPath, childName)
    const metaCheck = inspectEntryMetaFile(entryPath, nonMeta.length === 1 ? childName : undefined)
    const isStructurallyValid =
      nonMeta.length === 1 &&
      isValidTrashFolderName(childName) &&
      isRealSubdirectoryOf(entryPath, candidateTrashPath) &&
      metaCheck.kind !== 'altered'

    if (!isStructurallyValid) {
      const rawMeta = metaCheck.kind === 'valid' ? metaCheck.meta : metaCheck.kind === 'altered' ? metaCheck.rawMeta : null
      const idGit = resolveIdentityGitFolder(rawMeta?.identity ?? null)
      const safeOriginal =
        rawMeta && isValidTrashFolderName(basename(rawMeta.originalPath)) ? rawMeta.originalPath : candidateTrashPath
      const emptyError = emptyErrors?.get(entryPath) ?? lastEmptyTrashErrors.get(entryPath) ?? rawMeta?.lastEmptyError ?? null
      out.push({
        entryId: name,
        entryPath,
        trashPath: isValidTrashFolderName(childName) ? candidateTrashPath : entryPath,
        originalPath: safeOriginal,
        root: idGit?.root ?? rawMeta?.root ?? '',
        branch: rawMeta?.branch ?? null,
        identity: rawMeta?.identity ?? null,
        keepRef: rawMeta?.keepRef ?? '',
        movedAt: rawMeta?.movedAt ?? '',
        bytes: null,
        inUse: [],
        changedSinceMoved: 'unknown',
        repaired: false,
        note: ALTERED_TRASH_ENTRY,
        repairError: ALTERED_TRASH_ENTRY,
        ...(emptyError ? { emptyError, lastEmptyError: emptyError } : {})
      })
      continue
    }

    let meta = metaCheck.kind === 'valid' ? metaCheck.meta : null
    const trashPath = candidateTrashPath
    const recovered = meta ? null : recoverLostTrashEntry(trashPath, realDir)

    // A copy the user restored uses the git folder now: never repaired, never emptied. With entry.json lost, the
    // original path is taken to be the worktrees folder's own `<name>`, as recoverLostTrashEntry does.
    const ownIdGit = meta ? resolveIdentityGitFolder(meta.identity) : null
    const ownGitDir = ownIdGit?.gitDir ?? recovered?.gitDir ?? null
    const usedFrom = ownGitDir ? attachedElsewhere(ownGitDir, trashPath, meta?.originalPath ?? join(realDir, childName), meta?.repaired === true) : null
    if (usedFrom) {
      const reattachedRoot = ownIdGit?.root ?? recovered?.root ?? meta?.root ?? ''
      // Nothing at the path git names: say so, with the one command that gives the entry back to the trash.
      const hint = pathStillThere(usedFrom) ? null : reattachedText(usedFrom, reattachedRoot, trashPath)
      const emptyError = emptyErrors?.get(entryPath) ?? lastEmptyTrashErrors.get(entryPath) ?? meta?.lastEmptyError ?? hint
      out.push({
        entryId: name,
        entryPath,
        trashPath,
        originalPath: meta?.originalPath ?? trashPath,
        root: ownIdGit?.root ?? recovered?.root ?? meta?.root ?? '',
        branch: meta ? meta.branch : (recovered?.branch ?? null),
        identity: meta?.identity ?? null,
        keepRef: meta?.keepRef ?? '',
        movedAt: meta?.movedAt ?? '',
        bytes: await measureDuBytes(trashPath),
        inUse: await inUseInside(entryPath),
        changedSinceMoved: 'unknown',
        repaired: false,
        note: REATTACHED_TRASH_ENTRY,
        repairError: REATTACHED_TRASH_ENTRY,
        ...(emptyError ? { emptyError, lastEmptyError: emptyError } : {})
      })
      continue
    }

    // An entry an interrupted Empty trash started on is finished by the next one, never repaired.
    const unfinished = Boolean(meta?.emptying)
    if (meta && !meta.repaired && !unfinished) {
      meta = await repairTrashedWorktree(entryPath, meta)
    }

    const idGit = meta ? resolveIdentityGitFolder(meta.identity) : null
    if (!meta && recovered) {
      try {
        const expectedDotGit = join(realpathSync(trashPath), '.git')
        if (recovered.recordedDotGit !== expectedDotGit) {
          await tryGit(['worktree', 'repair', trashPath], recovered.root)
        }
      } catch {
        // Best-effort repair for a lost-record entry.
      }
    }

    const bytes = await measureDuBytes(trashPath)
    const inUse = await inUseInside(entryPath)
    // A volume mounted inside is not part of the worktree: Empty trash skips the entry until it is ejected.
    try {
      const mounted = foreignVolumeInside(trashPath, lstatSync(entryPath).dev, MAX_TRASH_SCAN_ENTRIES)
      if (mounted) inUse.push(`a volume mounted at ${mounted} (eject it first)`)
    } catch {
      // The entry went away while listing; Empty trash checks again.
    }

    const movedAt = meta?.movedAt ?? ''
    const changedSinceMoved = meta ? checkChangedSinceMoved(trashPath, movedAt) : 'unknown'
    const emptyError = emptyErrors?.get(entryPath) ?? lastEmptyTrashErrors.get(entryPath) ?? meta?.lastEmptyError ?? null
    const repairError = unfinished ? UNFINISHED_TRASH_ENTRY : meta ? meta.repairError : LOST_ENTRY_RECORD

    out.push({
      entryId: name,
      entryPath,
      trashPath,
      originalPath: meta?.originalPath ?? trashPath,
      root: idGit?.root ?? meta?.root ?? recovered?.root ?? '',
      branch: meta ? meta.branch : (recovered?.branch ?? null),
      identity: meta?.identity ?? null,
      keepRef: meta?.keepRef ?? '',
      movedAt,
      bytes,
      inUse,
      changedSinceMoved,
      repaired: meta?.repaired ?? false,
      ...(meta ? (unfinished ? { note: UNFINISHED_TRASH_ENTRY } : {}) : { note: LOST_ENTRY_RECORD }),
      ...(repairError ? { repairError } : {}),
      ...(emptyError ? { emptyError, lastEmptyError: emptyError } : {})
    })
  }
  return out
}

/**
 * Updates an existing keep ref so it also reaches every commit in `latestKeepRef`, with `firstParent` (or
 * `latestKeepRef^1`) as the first parent, so `<existingRef>^1` is always the work to restore. Used when emptying the trash so `meta.keepRef` includes commits made inside
 * the trashed worktree after it was moved.
 */
async function chainKeepRef(root: string, existingRef: string, latestKeepRef: string, folderName: string, firstParent?: string): Promise<void> {
  if (!existingRef || existingRef === latestKeepRef || !existingRef.startsWith(PARKED_PREFIX)) return
  try {
    const oldKeep = (await tryGit(['rev-parse', '--verify', '-q', existingRef], root))?.trim()
    const newKeep = (await tryGit(['rev-parse', '--verify', '-q', latestKeepRef], root))?.trim()
    // The work to restore stays first: the worktree's HEAD when the caller names it, else the new keep's own first parent.
    const newTip = firstParent ?? (await tryGit(['rev-parse', '--verify', '-q', `${latestKeepRef}^1`], root))?.trim()
    if (!oldKeep || !newKeep || !newTip || oldKeep === newKeep) return
    const tree = (await git(['hash-object', '-w', '-t', 'tree', '/dev/null'], root)).trim()
    const chained = (
      await git(
        [...IDENTITY, 'commit-tree', tree, '-p', newTip, '-p', newKeep, '-p', oldKeep, '-m', `Kept commits of worktree ${folderName} when emptying trash`],
        root
      )
    ).trim()
    await git(['update-ref', '--no-deref', existingRef, chained, oldKeep], root)
  } catch {
    // latestKeepRef already holds all commits from keepWorktreeHistory.
  }
}

/**
 * Synchronously checks BEFORE deleting `<entry>/<name>` whether `<common dir>/worktrees/<id>/gitdir`
 * resolves (with relative paths resolved against `<common dir>/worktrees/<id>`, as git does) to one
 * of `expectedDotGitPaths`. Returns the real path of `<common dir>/worktrees/<id>` when it matches,
 * or null when it does not.
 */
function verifyWorktreeGitFolderBeforeDeleteSync(
  realCommonDir: string,
  worktreeGitDir: string,
  expectedDotGitPaths: string | readonly string[]
): string | null {
  try {
    const allowed = typeof expectedDotGitPaths === 'string' ? [expectedDotGitPaths] : expectedDotGitPaths
    const st = lstatSync(worktreeGitDir)
    if (!st.isDirectory() || st.isSymbolicLink()) return null
    const realGitDir = realpathSync(worktreeGitDir)
    if (dirname(realGitDir) !== join(realCommonDir, 'worktrees')) return null
    const gitdirFile = join(realGitDir, 'gitdir')
    const fileStat = lstatSync(gitdirFile)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null
    const recorded = readFileSync(gitdirFile, 'utf8').trim()
    if (!recorded) return null
    const resolvedRecorded = isAbsolute(recorded) ? resolve(recorded) : resolve(realGitDir, recorded)
    if (!allowed.includes(resolvedRecorded)) return null
    return realGitDir
  } catch {
    return null
  }
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Where `<gitDir>/gitdir` says the worktree's `.git` is now, resolved as git does (against the git folder); null when unreadable. */
function recordedDotGitOf(gitDir: string): string | null {
  try {
    const realGitDir = realpathSync(gitDir)
    const file = join(realGitDir, 'gitdir')
    const st = lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink()) return null
    const recorded = readFileSync(file, 'utf8').trim()
    if (!recorded) return null
    return isAbsolute(recorded) ? resolve(recorded) : resolve(realGitDir, recorded)
  } catch {
    return null
  }
}

/** `path` made absolute with its deepest existing ancestor resolved through links, so a missing path compares like an existing one. */
function canonicalPath(path: string): string {
  let current = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync(current), ...rest)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      rest.unshift(basename(current))
      current = parent
    }
  }
}

/** True when `<folder>/.git` is a regular file whose `gitdir:` line (a relative one read against `folder`, as git does) names `gitDir`. */
function dotGitFileNames(folder: string, gitDir: string): boolean {
  try {
    const dotGit = join(folder, '.git')
    const st = lstatSync(dotGit)
    if (!st.isFile() || st.isSymbolicLink()) return false
    const written = readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(.+)$/)?.[1]?.trim()
    if (!written) return false
    return realpathSync(isAbsolute(written) ? written : resolve(folder, written)) === realpathSync(gitDir)
  } catch {
    return false
  }
}

/**
 * Where the worktree's git folder is used from now, when that is not this entry (`ownFolder` is its `<entry>/<name>`):
 * that worktree is the user's (safety.md mechanism 2, "A worktree the user re-attached is theirs"). Null only when the
 * git folder is still the entry's own: its `gitdir` names a path inside the entry, or, for an entry Regatta never
 * repaired (`repairVerified` false), `<originalPath>/.git` while nothing exists at the original path. Once Regatta has
 * seen `gitdir` name the entry (`repaired: true` in entry.json, set by a verified repair or when Empty trash writes a
 * lost entry.json again from a `gitdir` naming the entry, and never cleared, because repair is retried only for
 * entries that are not repaired), a `gitdir` naming the original path
 * can only have been written by the user re-attaching a copy there, so it is theirs even while nothing is at that
 * path (a copy renamed away during Empty trash). Everything else is the user's:
 * - a folder at the original path whose `.git` file names this git folder, repaired or not (git works in a plain copy);
 * - a `gitdir` naming any other path, whether or not anything is there at this moment (a copy renamed away for a
 *   moment, or on a volume that is not mounted, is still theirs).
 * An unreadable `gitdir` is not an attachment; deleting the git folder separately requires it to name this entry.
 */
function attachedElsewhere(gitDir: string, ownFolder: string, originalPath: string | null, repairVerified: boolean): string | null {
  if (originalPath && dotGitFileNames(originalPath, gitDir)) return originalPath
  const dotGit = recordedDotGitOf(gitDir)
  if (!dotGit) return null
  const recorded = canonicalPath(dotGit)
  if (recorded.startsWith(canonicalPath(dirname(ownFolder)) + sep)) return null
  if (originalPath && !repairVerified && !pathStillThere(originalPath) && recorded === join(canonicalPath(originalPath), '.git')) return null
  return dirname(dotGit)
}

/**
 * The `.git` paths that count as this entry's own: `<entry>/<name>/.git`, and, for an entry Regatta never repaired
 * (`repairVerified` false, see `attachedElsewhere`), `<originalPath>/.git` only while nothing exists at the original
 * path (read now, as late as possible).
 */
function entryDotGitTargets(ownFolder: string, originalPath: string | null, repairVerified: boolean): string[] {
  const targets = [join(realOrResolved(ownFolder), '.git')]
  if (originalPath && !repairVerified && !pathStillThere(originalPath)) {
    const original = resolve(originalPath)
    targets.push(join(original, '.git'))
    try {
      targets.push(join(realpathSync(dirname(original)), basename(original), '.git'))
    } catch {
      // Its parent is gone too; the plain path is enough.
    }
  }
  return [...new Set(targets)]
}

/** What Empty trash and the listing say about a volume mounted inside an entry. */
function mountedInsideText(path: string): string {
  return `a volume is mounted at ${path} inside it; eject it first`
}

/**
 * The first folder inside `root` (or `root` itself) that is on another device than `baseDev`: a volume mounted
 * there. Never follows links. Null when there is none, or when `limit` folders and files were looked at first
 * (the delete itself never enters another device either; see `removeOnOneVolume`).
 */
function foreignVolumeInside(root: string, baseDev: number, limit = Number.POSITIVE_INFINITY): string | null {
  const stack = [root]
  let seen = 0
  while (stack.length > 0) {
    const dir = stack.pop()!
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(dir)
    } catch {
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    if (st.dev !== baseDev) return dir
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (++seen > limit) return null
      const full = join(dir, name)
      try {
        const child = lstatSync(full)
        if (child.isDirectory() && !child.isSymbolicLink()) stack.push(full)
      } catch {
        // Gone or unreadable: nothing on another device to find there.
      }
    }
  }
  return null
}

/**
 * Deletes everything inside `root` (and `root` itself unless `keepRoot`), never entering a folder on another device
 * than `baseDev`: a volume mounted inside (a disk image, an sshfs, rclone or network share) is not part of it, and
 * Node's recursive `rmSync` has no one-file-system mode. It throws, naming the mount, before it enters such a folder.
 * Files and links go with `rmSync` one at a time (a link is removed, never followed), folders with `rmdirSync`.
 */
function removeOnOneVolume(root: string, baseDev: number, keepRoot = false): void {
  const removeDir = (dir: string, isRoot: boolean): void => {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a real folder`)
    if (st.dev !== baseDev) throw new Error(mountedInsideText(dir))
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const child = lstatSync(full)
      if (child.isDirectory() && !child.isSymbolicLink()) removeDir(full, false)
      else rmSync(full, { force: false })
    }
    if (!isRoot || !keepRoot) rmdirSync(dir)
  }
  removeDir(root, true)
}

/** `path` in single quotes for a shell command shown to the user. */
function shellQuoted(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/**
 * Why an entry is left alone when `usedFrom` uses its git folder. When nothing is at that path now, says so and
 * how to give the entry back to the trash: git's own `worktree prune` cannot, because the trash lock keeps the record.
 */
function reattachedText(usedFrom: string, root: string, trashPath: string): string {
  if (pathStillThere(usedFrom)) return `${REATTACHED_TRASH_ENTRY} (git now uses ${usedFrom})`
  return (
    `${REATTACHED_TRASH_ENTRY} (git now uses ${usedFrom}, which does not exist now; if that copy is gone for good, run ` +
    `git -C ${shellQuoted(root)} worktree repair ${shellQuoted(trashPath)} to give it back to the trash, then Empty trash)`
  )
}

/**
 * The entries of a worktree's git folder Regatta knows (safety.md mechanism 2): everything else may hold work
 * no keep commit can hold (a submodule's whole repository under `modules/`, `rebase --autostash` under
 * `rebase-merge/`), so the folder is then kept. `COMMIT_EDITMSG` is the message of a commit already made.
 */
const KNOWN_GIT_FOLDER_FILES = new Set([
  'HEAD',
  'ORIG_HEAD',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'BISECT_HEAD',
  'AUTO_MERGE',
  'COMMIT_EDITMSG',
  'index',
  'commondir',
  'gitdir',
  'locked',
  'config.worktree'
])
/** The folders below `refs/` of a worktree's git folder that `keepWorktreeHistory` reads in full. */
const KNOWN_WORKTREE_REF_FOLDERS = new Set(['worktree', 'bisect', 'rewritten'])

/** True when `dir` holds only regular files and real folders, all the way down. */
function onlyFilesAndFolders(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!onlyFilesAndFolders(join(dir, entry.name))) return false
    } else if (!entry.isFile()) {
      return false
    }
  }
  return true
}

/**
 * What a worktree's git folder holds that is not on the known list, as names relative to it (a folder ends
 * in `/`). Empty when Regatta knows everything in it. A folder that cannot be read counts as unknown.
 */
function unknownGitFolderEntries(gitDir: string): string[] {
  try {
    const unknown: string[] = []
    for (const entry of readdirSync(gitDir, { withFileTypes: true })) {
      const full = join(gitDir, entry.name)
      if (KNOWN_GIT_FOLDER_FILES.has(entry.name)) {
        if (!entry.isFile()) unknown.push(entry.name)
      } else if (entry.name === 'logs') {
        if (!entry.isDirectory() || !onlyFilesAndFolders(full)) unknown.push('logs/')
      } else if (entry.name === 'refs' && entry.isDirectory()) {
        for (const ref of readdirSync(full, { withFileTypes: true })) {
          if (!KNOWN_WORKTREE_REF_FOLDERS.has(ref.name) || !ref.isDirectory() || !onlyFilesAndFolders(join(full, ref.name))) {
            unknown.push(`refs/${ref.name}${ref.isDirectory() ? '/' : ''}`)
          }
        }
      } else {
        unknown.push(entry.isDirectory() ? `${entry.name}/` : entry.name)
      }
    }
    return unknown.sort()
  } catch (err) {
    return [`(the folder could not be read: ${errorText(err)})`]
  }
}

/**
 * For an entry holding only `entry.json`, or `entry.json` and `.regatta-deleting` (`deleting`): the git folder that an
 * interrupted Empty trash left behind, when `entry.json` says emptying started and that Empty trash itself deleted the
 * worktree folder (`folderDeleted`) or had renamed it to `.regatta-deleting` to delete it, and that git folder still
 * points to this entry (and nowhere else). Null otherwise (a worktree the user moved out, also after a delete that
 * failed, or an orphan from a crash before the move).
 */
function unfinishedGitFolder(entryPath: string, meta: TrashEntryMeta | null, deleting = false): ResolvedIdentityGit | null {
  // Only an entry whose worktree folder Empty trash itself deleted or was deleting: after a failed delete the folder is
  // back under its own name, and the user may have moved it out.
  if (!meta?.emptying || !(meta.folderDeleted || deleting)) return null
  const childName = basename(meta.originalPath)
  if (!isValidTrashFolderName(childName)) return null
  const idGit = resolveIdentityGitFolder(meta.identity)
  if (!idGit) return null
  const own = join(entryPath, childName)
  if (attachedElsewhere(idGit.gitDir, own, meta.originalPath, meta.repaired === true)) return null
  const dotGit = recordedDotGitOf(idGit.gitDir)
  return dotGit && entryDotGitTargets(own, meta.originalPath, meta.repaired === true).includes(dotGit) ? idGit : null
}

function writeEntryMeta(entryPath: string, meta: TrashEntryMeta): void {
  writeAndFsyncFile(join(entryPath, 'entry.json'), JSON.stringify(meta, null, 2), 0o600)
  tryFsyncDir(entryPath)
}

function recordEmptyError(entryPath: string, meta: TrashEntryMeta | null, msg: string, errors: Map<string, string>): void {
  errors.set(entryPath, msg)
  lastEmptyTrashErrors.set(entryPath, msg)
  if (meta) {
    try {
      writeAndFsyncFile(join(entryPath, 'entry.json'), JSON.stringify({ ...meta, lastEmptyError: msg }, null, 2), 0o600)
      tryFsyncDir(entryPath)
    } catch {
      // Best-effort metadata update.
    }
  }
}

/**
 * Empties `<worktreesDir>/.regatta-trash`.
 *
 * For each entry, one at a time (a failure on one is reported and the next goes on):
 * 1. Validate the entry folder (`entry.json` and one real worktree subfolder named `basename(meta.originalPath)`);
 *    skip altered or moved-out entries. An entry an interrupted Empty trash left (its `emptying` mark is set, it holds
 *    a `.regatta-deleting` folder or only `entry.json` with `folderDeleted`, and its git folder still points to it)
 *    is finished.
 * 2. Skip it if in use (`processesInside`), naming the program.
 * 3. Resolve the git folder and repository from `meta.identity` (or from `<trashPath>/.git` and `<gitDir>/commondir`
 *    when `entry.json` was lost). Skip it, touching nothing in git, when that git folder is used from anywhere but this
 *    entry (`attachedElsewhere`: a copy the user restored, repaired or not, even one missing for a moment).
 * 4. Snapshot the worktree git folder, keep its commits (`keepWorktreeHistory`, chained into `meta.keepRef`), read
 *    the branch tip, and mark `entry.json` as being emptied (`emptying`).
 * 5. As the very last step before each deletion, re-read the snapshot and check that the entry (and the worktree
 *    folder in it) is still the real folder it was, never a link, with no volume mounted inside: the worktree folder
 *    (renamed to `.regatta-deleting` and deleted there, then `folderDeleted` is marked), then the entry folder (only
 *    when it holds nothing but `entry.json`), then the git folder, which also must not be used from elsewhere, must
 *    still point to this entry and hold nothing off the known list. Every delete stays on the entry's volume
 *    (`removeOnOneVolume`). A git folder that is kept keeps its lock and the branch too, and the result says where it is.
 * 6. Delete the owned branch (only `regatta/*` when `entry.json` was lost); the keep ref's first parent stays the
 *    worktree's HEAD.
 */
export async function emptyTrash(
  worktreesDir: string,
  runWithLock?: <T>(root: string, fn: () => Promise<T>) => Promise<T>
): Promise<{ outcomes: EmptyTrashOutcome[]; errors: Map<string, string> }> {
  const outcomes: EmptyTrashOutcome[] = []
  const errors = new Map<string, string>()

  let realDir: string
  try {
    realDir = realpathSync(worktreesDir)
  } catch {
    return { outcomes, errors }
  }
  const trashDir = join(realDir, TRASH_DIR_NAME)
  try {
    const st = lstatSync(trashDir)
    if (!st.isDirectory() || st.isSymbolicLink()) return { outcomes, errors }
  } catch {
    return { outcomes, errors }
  }

  let names: string[]
  try {
    names = readdirSync(trashDir).sort()
  } catch {
    return { outcomes, errors }
  }

  for (const name of names) {
    const entryPath = join(trashDir, name)
    try {
      const st = lstatSync(entryPath)
      if (!st.isDirectory() || st.isSymbolicLink()) continue
    } catch {
      continue
    }

    let children: string[]
    try {
      children = readdirSync(entryPath)
    } catch {
      continue
    }

    const significant = children.filter((child) => child !== '.DS_Store').sort()
    const nonMeta = significant.filter((child) => child !== 'entry.json')

    let meta: TrashEntryMeta | null
    let childName: string
    // Where the worktree folder is: in the entry under its own name, renamed to `.regatta-deleting` by an Empty trash
    // that stopped while deleting it, or already gone (an interrupted Empty trash left only entry.json).
    let folderState: 'present' | 'deleting' | 'gone'
    const deletingLeft = nonMeta.length === 1 && nonMeta[0] === DELETING_FOLDER && isRealSubdirectoryOf(entryPath, join(entryPath, DELETING_FOLDER))
    if (nonMeta.length === 0 || deletingLeft) {
      const metaCheck = inspectEntryMetaFile(entryPath)
      const rawMeta = metaCheck.kind === 'valid' ? metaCheck.meta : metaCheck.kind === 'altered' ? metaCheck.rawMeta : null
      if (metaCheck.kind === 'valid' && unfinishedGitFolder(entryPath, metaCheck.meta, deletingLeft)) {
        meta = metaCheck.meta
        childName = basename(meta.originalPath)
        folderState = deletingLeft ? 'deleting' : 'gone'
      } else {
        if (!deletingLeft && isMovedOutEntry(rawMeta) && rawMeta) {
          outcomes.push({
            entryId: name,
            entryPath,
            trashPath: join(entryPath, isValidTrashFolderName(basename(rawMeta.originalPath)) ? basename(rawMeta.originalPath) : name),
            originalPath: rawMeta.originalPath,
            branch: rawMeta.branch,
            status: 'skipped',
            reason: MOVED_OUT_TRASH_ENTRY
          })
          continue
        }
        if (metaCheck.kind === 'altered' || deletingLeft) {
          outcomes.push({
            entryId: name,
            entryPath,
            trashPath: entryPath,
            originalPath: entryPath,
            branch: rawMeta?.branch ?? null,
            status: 'skipped',
            reason: ALTERED_TRASH_ENTRY
          })
          continue
        }
        cleanupOrphanEntryDir(entryPath)
        continue
      }
    } else {
      childName = nonMeta[0]!
      const candidateTrashPath = join(entryPath, childName)
      const metaCheck = inspectEntryMetaFile(entryPath, nonMeta.length === 1 ? childName : undefined)
      const isStructurallyValid =
        nonMeta.length === 1 &&
        isValidTrashFolderName(childName) &&
        isRealSubdirectoryOf(entryPath, candidateTrashPath) &&
        metaCheck.kind !== 'altered'

      if (!isStructurallyValid) {
        const rawMeta = metaCheck.kind === 'valid' ? metaCheck.meta : metaCheck.kind === 'altered' ? metaCheck.rawMeta : null
        const safeOriginal =
          rawMeta && isValidTrashFolderName(basename(rawMeta.originalPath)) ? rawMeta.originalPath : candidateTrashPath
        outcomes.push({
          entryId: name,
          entryPath,
          trashPath: isValidTrashFolderName(childName) ? candidateTrashPath : entryPath,
          originalPath: safeOriginal,
          branch: rawMeta?.branch ?? null,
          status: 'skipped',
          reason: ALTERED_TRASH_ENTRY
        })
        continue
      }
      meta = metaCheck.kind === 'valid' ? metaCheck.meta : null
      folderState = 'present'
    }

    const trashPath = join(entryPath, childName)
    const deletingPath = join(entryPath, DELETING_FOLDER)
    const folderPresent = folderState === 'present'
    const originalPath = meta?.originalPath ?? trashPath

    // 1. Check if in use before locking.
    try {
      const users = await processesInside(entryPath, isCaseInsensitive(entryPath))
      if (users.length > 0) {
        const who = describeProcessesInside(users).join(', ')
        outcomes.push({
          entryId: name,
          entryPath,
          trashPath,
          originalPath,
          branch: meta?.branch ?? null,
          status: 'skipped',
          reason: `Skipped: in use by ${who}.`
        })
        continue
      }
    } catch (err) {
      outcomes.push({
        entryId: name,
        entryPath,
        trashPath,
        originalPath,
        branch: meta?.branch ?? null,
        status: 'skipped',
        reason: `Skipped: Regatta could not tell whether a program is using it (${errorText(err)}).`
      })
      continue
    }

    const idGit = meta ? resolveIdentityGitFolder(meta.identity) : null
    const recovered = meta ? null : recoverLostTrashEntry(trashPath, realDir)
    const entryRoot = idGit?.root ?? recovered?.root ?? ''
    const entryCommonDir = idGit?.commonDir ?? recovered?.commonDir ?? ''
    const worktreeGitDir = idGit?.gitDir ?? recovered?.gitDir ?? ''
    const entryBranch = meta ? meta.branch : (recovered?.branch ?? null)

    if (!entryRoot || !entryCommonDir || !worktreeGitDir) {
      const reason = meta
        ? 'Skipped: the repository or worktree git folder for this entry is gone, so git keeps nothing of it here. Unless ' +
          'its repository is only on a volume that is not mounted now, the folder is plain files: look inside, and ' +
          'delete it in Finder if you do not need them.'
        : 'Skipped: entry.json is missing or invalid and git could not find its repository.'
      recordEmptyError(entryPath, meta, reason, errors)
      outcomes.push({ entryId: name, entryPath, trashPath, originalPath, branch: entryBranch, status: 'error', reason })
      continue
    }

    const executeEntry = async (): Promise<void> => {
      const report = (status: EmptyTrashOutcome['status'], reason: string | null, branch = entryBranch): void => {
        outcomes.push({ entryId: name, entryPath, trashPath, originalPath, branch, status, reason })
      }
      // Re-check the shape of the entry and whether it is in use, inside the repository lock.
      const shapeHolds =
        folderState === 'present'
          ? isRealSubdirectoryOf(entryPath, trashPath)
          : folderState === 'deleting'
            ? isRealSubdirectoryOf(entryPath, deletingPath) && !pathStillThere(trashPath)
            : !pathStillThere(trashPath) && !pathStillThere(deletingPath)
      if (!shapeHolds) {
        report('skipped', ALTERED_TRASH_ENTRY)
        return
      }
      try {
        const users = await processesInside(entryPath, isCaseInsensitive(entryPath))
        if (users.length > 0) {
          report('skipped', `Skipped: in use by ${describeProcessesInside(users).join(', ')}.`)
          return
        }
      } catch (err) {
        report('skipped', `Skipped: Regatta could not tell whether a program is using it (${errorText(err)}).`)
        return
      }

      let realEntry: string
      let ownFolder: string
      // The device the entry is on: nothing on another one (a volume mounted inside) is ever entered or deleted.
      let entryDev: number
      try {
        realEntry = realpathSync(entryPath)
        ownFolder = join(realEntry, childName)
        entryDev = lstatSync(realEntry).dev
      } catch (err) {
        const msg = errorText(err)
        recordEmptyError(entryPath, meta, msg, errors)
        report('error', msg)
        return
      }
      // Read as late as possible, and from the current `meta` (a repair earlier in this run, or the entry.json written
      // again for a lost record, can set `repaired`): <originalPath>/.git counts as this entry's only for an entry
      // Regatta never repaired, and only while nothing exists there.
      const repairVerified = (): boolean => meta?.repaired === true
      const dotGitTargets = (): string[] => entryDotGitTargets(ownFolder, meta ? meta.originalPath : null, repairVerified())
      // With entry.json lost, the original path is taken to be the worktrees folder's own `<name>`.
      const originalForCheck = meta ? meta.originalPath : join(realDir, childName)
      // The entry is still the real folder it was when this started (never a link put in its place) and, with
      // `folder`, that folder (the worktree folder, or `.regatta-deleting`) is still a real folder directly inside it.
      // Asked right before every write into the entry and every delete, so nothing is written or deleted through a link.
      const entryStillOurs = (folder: string | null): boolean => {
        try {
          const st = lstatSync(entryPath)
          if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(entryPath) !== realEntry) return false
          return !folder || (isRealSubdirectoryOf(entryPath, folder) && realpathSync(folder) === join(realEntry, basename(folder)))
        } catch {
          return false
        }
      }
      const recordError = (msg: string): void => recordEmptyError(entryPath, entryStillOurs(null) ? meta : null, msg, errors)
      const reattached = (usedFrom: string): string => reattachedText(usedFrom, entryRoot, trashPath)

      // A copy the user restored uses the git folder now: nothing in git is touched.
      const elsewhere = attachedElsewhere(worktreeGitDir, ownFolder, originalForCheck, repairVerified())
      if (elsewhere) {
        report('skipped', reattached(elsewhere))
        return
      }

      if (!folderPresent) {
        if (!verifyWorktreeGitFolderBeforeDeleteSync(entryCommonDir, worktreeGitDir, dotGitTargets())) {
          report('skipped', 'Skipped: its git folder does not point to this entry any more.')
          return
        }
      } else if (meta) {
        const dotGitCheck = inspectTrashDotGit(trashPath, meta.originalPath, meta.identity)
        if (dotGitCheck.status === 'invalid') {
          report('skipped', `Skipped: ${dotGitCheck.reason}`)
          return
        }
        if (dotGitCheck.status === 'missing') {
          if (!verifyWorktreeGitFolderBeforeDeleteSync(entryCommonDir, worktreeGitDir, dotGitTargets())) {
            report('skipped', 'Skipped: the trashed worktree has no .git file and its git folder does not point to it.')
            return
          }
        } else if (!meta.repaired && !meta.emptying) {
          meta = await repairTrashedWorktree(entryPath, meta)
        }
      } else if (recovered && recovered.recordedDotGit !== join(ownFolder, '.git')) {
        try {
          hooksSandbox()
          await tryGit(['worktree', 'repair', trashPath], entryRoot)
        } catch {
          // Best-effort repair before verifying gitdir.
        }
      }

      // 2. Snapshot the worktree git state, keep its commits from the git folder, and read the branch tip.
      const baseName = basename(originalPath)
      const snapBefore = worktreeGitStateSnapshot(worktreeGitDir)
      if (snapBefore === null) {
        report('skipped', 'Skipped: the worktree git folder could not be read.')
        return
      }

      let latestKeepRef: string
      let headTip: string | null = null
      try {
        hooksSandbox()
        latestKeepRef = await keepWorktreeHistory(entryRoot, trashPath, baseName, worktreeGitDir)
        // The worktree's HEAD (detached or not) is the keep commit's first parent: it stays first in every chain below.
        headTip = (await tryGit(['rev-parse', '--verify', '-q', `${latestKeepRef}^1`], entryRoot))?.trim() || null
        // keepCommits put the worktree's HEAD first in latestKeepRef, which chainKeepRef keeps first by itself.
        if (meta?.keepRef) await chainKeepRef(entryRoot, meta.keepRef, latestKeepRef, baseName)
      } catch (err) {
        report('skipped', `Skipped: a copy of its commits could not be made (${errorText(err)}).`)
        return
      }

      const activeBranch = entryBranch ?? readBranchFromGitDir(worktreeGitDir)
      const deletableBranch = meta
        ? meta.branch
        : activeBranch && activeBranch.startsWith('regatta/')
          ? activeBranch
          : null
      const branchTip = deletableBranch
        ? ((await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${deletableBranch}`], entryRoot))?.trim() ?? null)
        : null

      // 3. Mark entry.json before the first deletion, so an interruption from here on is finished by the next
      //    Empty trash. A lost entry.json is written again from what the git folder says (branch only under regatta/).
      const previousMeta = meta
      let startedMeta: TrashEntryMeta
      try {
        const now = new Date().toISOString()
        if (meta) {
          startedMeta = { ...meta, emptying: now }
        } else {
          const st = lstatSync(worktreeGitDir)
          startedMeta = {
            version: 1,
            originalPath: join(realDir, childName),
            root: entryRoot,
            branch: deletableBranch,
            identity: `${worktreeGitDir}|i${st.ino}|${st.birthtimeMs}`,
            keepRef: latestKeepRef,
            movedAt: now,
            repaired: recordedDotGitOf(worktreeGitDir) === join(ownFolder, '.git'),
            emptying: now
          }
        }
        if (!entryStillOurs(folderState === 'present' ? trashPath : folderState === 'deleting' ? deletingPath : null)) throw new Error('the entry folder is not the one Regatta made any more')
        writeEntryMeta(entryPath, startedMeta)
      } catch (err) {
        report('skipped', `Skipped: Regatta could not record in entry.json that it started emptying it (${errorText(err)}).`)
        return
      }
      meta = startedMeta
      const keptGitFolder = (why: string): string =>
        `Kept its git folder ${worktreeGitDir}${deletableBranch ? ` and branch ${deletableBranch}` : ''}: ${why}.`

      // 4. The worktree folder. The last checks come right before it is renamed to `.regatta-deleting` (one rename(2)
      //    inside the entry) and deleted there, with nothing in between. Only Regatta puts a folder at that name, so an
      //    interruption from the rename on leaves an entry the next Empty trash finishes, never one that looks moved out.
      if (folderState !== 'gone') {
        const folderNow = folderState === 'present' ? trashPath : deletingPath
        const elsewhereNow = attachedElsewhere(worktreeGitDir, ownFolder, originalForCheck, repairVerified())
        const mounted = elsewhereNow ? null : foreignVolumeInside(folderNow, entryDev)
        if (elsewhereNow || mounted || worktreeGitStateSnapshot(worktreeGitDir) !== snapBefore) {
          // Nothing was deleted: drop the mark again, unless an earlier Empty trash had set it.
          if (!previousMeta?.emptying && entryStillOurs(null)) {
            const { emptying: _started, ...unmarked } = startedMeta
            try {
              writeEntryMeta(entryPath, unmarked)
              meta = unmarked
            } catch {
              // The mark only makes the next Empty trash finish the entry; leaving it is harmless.
            }
          }
          report(
            'skipped',
            elsewhereNow
              ? reattached(elsewhereNow)
              : mounted
                ? `Skipped: ${mountedInsideText(mounted)}.`
                : 'Skipped: the worktree git state changed while emptying trash; run Empty trash again so its new commits are kept.',
            activeBranch
          )
          return
        }
        // Never through a link: the entry and the worktree folder must still be the real folders this started with.
        if (!entryStillOurs(folderNow)) {
          report('skipped', ALTERED_TRASH_ENTRY, activeBranch)
          return
        }
        if (folderState === 'present') {
          try {
            renameSync(trashPath, deletingPath)
            tryFsyncDir(entryPath)
          } catch (err) {
            // Nothing was deleted. The `emptying` mark stays, and a worktree the user now moves out of the entry is
            // listed as moved out and left alone, git records included.
            const msg = errorText(err)
            recordError(msg)
            report('error', msg, activeBranch)
            return
          }
        }
        try {
          if (!entryStillOurs(deletingPath)) throw new Error('the entry folder is not the one Regatta made any more')
          removeOnOneVolume(deletingPath, entryDev, true)
        } catch (err) {
          // Put what is left back under its own name, so a worktree the user then moves out of the entry is listed as
          // moved out, its git records untouched. If that fails, `.regatta-deleting` stays and the next Empty trash
          // finishes the entry.
          if (folderState === 'present' && entryStillOurs(deletingPath) && !pathStillThere(trashPath)) {
            try {
              renameSync(deletingPath, trashPath)
              tryFsyncDir(entryPath)
            } catch {
              // `.regatta-deleting` stays: the entry is unfinished, never moved out.
            }
          }
          const msg = errorText(err)
          recordError(msg)
          report('error', msg, activeBranch)
          return
        }
        // Regatta itself deleted the worktree folder: mark it, and only then remove the empty `.regatta-deleting`, so
        // an entry is never left holding only entry.json without the mark.
        try {
          if (!entryStillOurs(deletingPath)) throw new Error('the entry folder is not the one Regatta made any more')
          const deletedMeta: TrashEntryMeta = { ...startedMeta, folderDeleted: new Date().toISOString() }
          writeEntryMeta(entryPath, deletedMeta)
          meta = deletedMeta
          rmdirSync(deletingPath)
          tryFsyncDir(entryPath)
        } catch (err) {
          const msg = `${errorText(err)}. Run Empty trash again to finish this entry.`
          recordError(msg)
          report('error', msg, activeBranch)
          return
        }
      }

      // 5. The entry folder: the last check right before the delete. It must hold only entry.json now (and Finder's
      //    .DS_Store); anything else in it stays, and so does the entry.
      if (worktreeGitStateSnapshot(worktreeGitDir) !== snapBefore) {
        // The entry stays, marked, so the next Empty trash keeps the new commits and finishes it.
        report(
          'skipped',
          `Skipped: the worktree git state changed after its folder was deleted. ${keptGitFolder('its logs hold the new commits')} Run Empty trash again to finish this entry.`,
          activeBranch
        )
        return
      }
      if (!entryStillOurs(null)) {
        report('skipped', ALTERED_TRASH_ENTRY, activeBranch)
        return
      }
      try {
        const other = readdirSync(entryPath).filter((child) => child !== 'entry.json' && child !== '.DS_Store')
        if (other.length > 0) {
          report(
            'skipped',
            `Skipped: its entry folder now holds ${other.sort().join(', ')}, which Regatta did not put there, so the entry stays. ${keptGitFolder('the entry is not finished')} Run Empty trash again once you have looked inside.`,
            activeBranch
          )
          return
        }
        for (const file of ['.DS_Store', 'entry.json']) {
          try {
            rmSync(join(entryPath, file), { force: false })
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          }
        }
        rmdirSync(entryPath)
      } catch (err) {
        const msg = errorText(err)
        recordError(msg)
        report('error', msg, activeBranch)
        return
      }
      lastEmptyTrashErrors.delete(entryPath)

      // 6. The git folder: deleted only when it still points to this entry and Regatta knows everything in it, and
      //    its state is what was kept, re-read right before the delete. Otherwise it stays with its lock and the branch.
      let gitFolderKept: string | null = null
      const usedFrom = attachedElsewhere(worktreeGitDir, ownFolder, originalForCheck, repairVerified())
      const verifiedGitDirToRemove = usedFrom ? null : verifyWorktreeGitFolderBeforeDeleteSync(entryCommonDir, worktreeGitDir, dotGitTargets())
      const unknown = verifiedGitDirToRemove ? unknownGitFolderEntries(verifiedGitDirToRemove) : []
      let gitFolderDev = 0
      let mountedInGit: string | null = null
      if (verifiedGitDirToRemove && unknown.length === 0) {
        try {
          gitFolderDev = lstatSync(dirname(verifiedGitDirToRemove)).dev
          mountedInGit = foreignVolumeInside(verifiedGitDirToRemove, gitFolderDev)
        } catch (err) {
          mountedInGit = `(its folder could not be read: ${errorText(err)})`
        }
      }
      if (usedFrom) {
        gitFolderKept = keptGitFolder(`a worktree at ${usedFrom} uses it now`)
      } else if (!verifiedGitDirToRemove) {
        gitFolderKept = keptGitFolder('it does not point to this entry any more')
      } else if (unknown.length > 0) {
        gitFolderKept = keptGitFolder(`it holds ${unknown.join(', ')}, which Regatta does not know, so whatever is in it stays (look inside before removing it)`)
      } else if (mountedInGit) {
        gitFolderKept = keptGitFolder(mountedInsideText(mountedInGit))
      } else if (worktreeGitStateSnapshot(worktreeGitDir) !== snapBefore) {
        gitFolderKept = keptGitFolder('its git state changed after the worktree folder was deleted; its logs hold the new commits')
      } else {
        try {
          removeOnOneVolume(verifiedGitDirToRemove, gitFolderDev)
        } catch (err) {
          gitFolderKept = keptGitFolder(`it could not be removed (${errorText(err)})`)
        }
      }

      // 7. Delete the owned branch at the tip read above, once its git folder is gone.
      let branchDeleted = false
      let branchParked: string | undefined
      let branchReason: string | null = gitFolderKept
      if (!gitFolderKept && deletableBranch && branchTip) {
        const deleted = await deleteOwnedBranch(entryRoot, deletableBranch, branchTip, { parkAs: baseName })
        branchDeleted = deleted.deleted
        branchParked = deleted.parked
        branchReason = deleted.reason
        if (branchParked && meta?.keepRef) {
          await chainKeepRef(entryRoot, meta.keepRef, branchParked, baseName, headTip ?? undefined)
        }
      }

      outcomes.push({
        entryId: name,
        entryPath,
        trashPath,
        originalPath,
        branch: activeBranch,
        status: 'deleted',
        reason: branchReason,
        keepRef: meta?.keepRef || latestKeepRef,
        branchDeleted,
        ...(branchParked ? { branchParked } : {}),
        branchOutcome: branchReason ?? (branchDeleted && deletableBranch ? `Deleted branch ${deletableBranch}.` : null)
      })
    }

    try {
      if (runWithLock) {
        await runWithLock(entryRoot, executeEntry)
      } else {
        await executeEntry()
      }
    } catch (err) {
      const msg = errorText(err)
      recordEmptyError(entryPath, meta, msg, errors)
      outcomes.push({
        entryId: name,
        entryPath,
        trashPath,
        originalPath,
        branch: entryBranch,
        status: 'error',
        reason: msg
      })
    }
  }

  return { outcomes, errors }
}

function pathStillThere(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Merging into the user's branch.

/** The branch and commit the user's folder was on when the merge was requested. */
export interface CapturedTarget {
  branch: string
  head: string
}

export type MergeRefusal =
  | 'detached'
  | 'moved'
  | 'busy'
  | 'dirty'
  | 'unknown'
  | 'missing'
  | 'conflict'
  | 'overwrite'
  | 'failed'

/** A merge that was not done. The user's folder is as it was; the reason says what to do next. */
export class MergeRefused extends Error {
  constructor(
    readonly reason: MergeRefusal,
    message: string
  ) {
    super(message)
    this.name = 'MergeRefused'
  }
}

export interface MergeOptions {
  /** Where the temporary worktree for a merge commit is made. Defaults to the system temp folder. */
  scratchDir?: string
  /** Runs after the merge commit is built, just before the final recheck. For tests. */
  beforeWrite?: () => void | Promise<void>
  /**
   * Runs synchronously, after the last await and immediately before `merge --ff-only` is started,
   * so a decision it takes (a quit) cannot go stale during the final rechecks. Throwing refuses the merge.
   */
  beforeLaunch?: () => void
}

export interface MergeOutcome {
  /** True when the branch only moved forward to the tested commit; false when a merge commit was made or nothing was needed. */
  fastForward: boolean
  /** The commit the branch is at now. */
  head: string
  /** True when the branch already had the tested commit, so nothing changed. */
  alreadyMerged: boolean
}

/** Records the branch and commit `root` is on now. Refuses a detached HEAD. */
export async function captureTarget(root: string): Promise<CapturedTarget> {
  const branch = await currentBranch(root)
  if (!branch) throw new MergeRefused('detached', 'Check out a branch before merging.')
  let head: string
  try {
    head = await headSha(root)
  } catch (err) {
    throw new MergeRefused('unknown', `Could not look at your folder, so nothing was merged. ${errorText(err)}`)
  }
  return { branch, head }
}

/**
 * Everything that must hold for the user's folder to take a merge: a branch checked out, the one
 * and the commit captured when the merge was requested, no merge, rebase, cherry-pick or revert
 * underway, and no uncommitted changes to tracked files. An error checking any of it refuses.
 */
async function checkMergeTarget(root: string, captured: CapturedTarget): Promise<void> {
  const busy = await operationInProgress(root).catch((err: unknown) => {
    throw new MergeRefused('unknown', `Could not look at your folder, so nothing was merged. ${errorText(err)}`)
  })
  if (busy) throw new MergeRefused('busy', `A ${busy} is already in progress in your folder. Finish or abort it first, then merge.`)
  const branch = await currentBranch(root)
  if (!branch) throw new MergeRefused('detached', 'Check out a branch before merging.')
  let head: string
  try {
    head = await headSha(root)
  } catch (err) {
    throw new MergeRefused('unknown', `Could not look at your folder, so nothing was merged. ${errorText(err)}`)
  }
  if (branch !== captured.branch) {
    throw new MergeRefused('moved', `Your folder is on ${branch} now, not ${captured.branch}, where the merge was asked for. Nothing was merged; try again.`)
  }
  if (head !== captured.head) {
    throw new MergeRefused('moved', `${captured.branch} moved on since the merge was asked for. Nothing was merged; try again.`)
  }
  let dirty: boolean
  try {
    dirty = await dirtyTracked(root)
  } catch (err) {
    throw new MergeRefused('unknown', `Could not tell whether your folder has uncommitted changes, so nothing was merged. ${errorText(err)}`)
  }
  if (dirty) throw new MergeRefused('dirty', 'Commit or stash your changes first. Merging needs a clean folder.')
}

/**
 * Merges the tested commit into the branch checked out in `root`, the one place the user's folder
 * can be changed, and does it so that git itself refuses to lose anything.
 *
 * The user's folder only ever sees a fast-forward made with `--no-overwrite-ignore`: git then
 * refuses to write over an ignored or untracked file, including one where a folder is needed and a
 * case alias on a case-insensitive volume. When the branch is still where the tested commit
 * started, that fast-forward goes to the tested commit. Otherwise the merge commit is built
 * first in a temporary detached worktree at the captured commit, and the fast-forward goes to
 * that. A conflict is found there, so nothing in the user's folder is ever half merged and Regatta
 * never has a merge of its own to abort in it.
 *
 * `captured` is the branch and commit seen when the merge was requested. Everything is checked
 * again right before the write, and a branch or commit that changed refuses. Callers hold the
 * repository lock.
 */
export async function mergeIntoCurrentBranch(
  root: string,
  testedSha: string,
  message: string,
  captured: CapturedTarget,
  opts: MergeOptions = {}
): Promise<MergeOutcome> {
  await checkMergeTarget(root, captured)
  if (!(await isCommit(root, testedSha))) {
    throw new MergeRefused('missing', 'The tested commit is no longer in the repository, so it cannot be merged.')
  }
  if (await isAncestor(root, testedSha, captured.head)) {
    return { fastForward: false, head: captured.head, alreadyMerged: true }
  }

  let target = testedSha
  let fastForward = true
  if (!(await isAncestor(root, captured.head, testedSha))) {
    fastForward = false
    target = await buildMergeCommit(root, testedSha, message, captured, opts.scratchDir)
  }
  await opts.beforeWrite?.()

  // The last look before writing: from here git offers no way to make the check and the write one step.
  await checkMergeTarget(root, captured)
  opts.beforeLaunch?.()
  try {
    await git(['merge', '--ff-only', '--no-overwrite-ignore', target], root, { allowHooks: true })
  } catch (err) {
    throw await explainRefusal(root, target, captured, err)
  }
  return { fastForward, head: target, alreadyMerged: false }
}

/** Turns git's refusal of the fast-forward into words for the user. */
async function explainRefusal(root: string, target: string, captured: CapturedTarget, err: unknown): Promise<MergeRefused> {
  const said = errorText(err)
  const head = await headSha(root).catch(() => null)
  if (head !== captured.head) {
    return new MergeRefused('failed', `${said} The folder changed while the merge ran, so check it before trying again. Nothing was deleted.`)
  }
  if (/untracked|overwritten|ignored/i.test(said)) {
    // git has already refused; the scan only names the files, it decides nothing.
    let hits = await ignoredCollisions(root, target).catch(() => [] as string[])
    if (hits.length === 0) hits = listedPaths(err)
    if (hits.length > 0) {
      const shown = hits.slice(0, 5).join(', ')
      const more = hits.length > 5 ? ` and ${hits.length - 5} more` : ''
      return new MergeRefused('overwrite', `Merging would overwrite files in your folder that git ignores or does not track: ${shown}${more}. Move them away first.`)
    }
    return new MergeRefused('overwrite', `Merging would overwrite files in your folder that git ignores or does not track (${said}). Move them away first.`)
  }
  return new MergeRefused('failed', `${said} Nothing was merged.`)
}

/** The paths git lists, one per tab-indented line, under the headline of a refusal. */
function listedPaths(err: unknown): string[] {
  const text = err instanceof Error ? (err as Error & { stderr?: string }).stderr ?? '' : ''
  return text
    .split('\n')
    .filter((line) => line.startsWith('\t'))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Builds the merge commit of `testedSha` into the captured commit in a temporary detached worktree
 * and returns its sha. The worktree is removed again whatever happens.
 */
async function buildMergeCommit(
  root: string,
  testedSha: string,
  message: string,
  captured: CapturedTarget,
  scratchDir: string | undefined
): Promise<string> {
  const parent = scratchDir ?? tmpdir()
  mkdirSync(parent, { recursive: true })
  const dir = mkdtempSync(join(parent, 'merge-'))
  const path = join(dir, 'tree')
  try {
    await git([...QUIET, 'worktree', 'add', '--detach', path, captured.head], root)
  } catch (err) {
    rmDir(dir)
    throw new MergeRefused('failed', `Could not prepare the merge, so nothing was merged. ${errorText(err)}`)
  }
  const record: OwnedWorktree = { root, path, identity: worktreeIdentity(path), dir, disposable: true }
  try {
    const identity = await commitIdentity(root)
    try {
      await git([...QUIET, ...identity, 'merge', '--no-ff', '--no-edit', '-m', message, testedSha], path)
    } catch (err) {
      if (await mergeHeadExists(path).catch(() => false)) {
        throw new MergeRefused(
          'conflict',
          `The change conflicts with work in ${captured.branch} made since it started, so nothing was merged and your folder is as it was. ` +
            'Its worktree is kept: bring your folder in line and try again, or discard it.'
        )
      }
      throw new MergeRefused('failed', `Could not build the merge, so nothing was merged. ${errorText(err)}`)
    }
    return await headSha(path)
  } finally {
    // A conflicted scratch tree is ours to throw away; abort first so git has nothing half done to object to.
    await abortMerge(path).catch(() => false)
    await removeOwnedWorktree(record).catch(() => null)
    rmDir(dir)
  }
}

/** Settings that keep a merge in the scratch worktree from asking for a signature. */
const QUIET = ['-c', 'commit.gpgsign=false']

/** The identity the merge commit is made with: the repository owner's, or Regatta's when there is none. */
async function commitIdentity(root: string): Promise<string[]> {
  const name = (await tryGit(['config', 'user.name'], root))?.trim()
  const email = (await tryGit(['config', 'user.email'], root))?.trim()
  return name && email ? [] : ['-c', 'user.name=Regatta', '-c', 'user.email=regatta@localhost']
}

function rmDir(path: string): void {
  try {
    rmdirSync(path)
  } catch {
    // Not empty or already gone: either way it is not ours to force.
  }
}
