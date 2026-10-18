// What Regatta keeps on disk, leftover worktrees, Regatta's trash, and the open source notices for About.
// Retiring a leftover worktree moves it
// into Regatta's trash through trashOwnedWorktree; only emptying the trash deletes the trashed folder,
// its worktree git folder, and its owned branch after parking its commits.

import { execFile } from 'node:child_process'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { EmptyTrashResult, LeftoverWorktree, LicenseNotice, StorageItem, StorageReport } from '../shared/types'
import { TRASH_DIR_NAME, TRASH_LOCK_REASON, emptyTrash, listTrash, sandboxGitArgs, trashOwnedWorktree, worktreeIdentity } from './heats/git-ops'
import { withRepoLock } from './heats/repo-lock'
import { withoutRepoRouting } from './env'

export interface StorageDeps {
  /** App data folder (conversations, night reports, videos, models). */
  dataDir: string
  /** Where Regatta creates worktrees (see worktreesDir() in git.ts). */
  worktreesDir: string
  /** Shadow repositories of checkpoints. */
  checkpointsDir: string
  /** Saved sign-ins (shown with their size, never removable here). */
  accountsDir: string
  /** Worktree folders an open pane, heat, night run or flow run still uses. */
  inUse: () => string[]
}

/** Git never needs longer than this here; anything slower is a hang, not a slow disk. */
const GIT_TIMEOUT_MS = 15_000
/** Stop counting one folder after this many milliseconds and report what was counted. */
const SCAN_BUDGET_MS = 2_000
/** At most this many leftovers are inspected with git at once. */
const CHECKS_AT_ONCE = 2

const REPOSITORY_GONE = 'Its repository is gone, so git cannot check it. Delete it in Finder if you are sure.'
const NOT_LISTED = 'Its repository does not list it as a worktree any more, so git cannot check it. Delete it in Finder if you are sure.'

// Folders and numbers.

interface Measure {
  bytes: number | null
  changedAt: number | null
  /** The first folder inside that could not be read (a path inside the measured folder), or null. */
  unreadable: string | null
}

const NOTHING: Measure = { bytes: null, changedAt: null, unreadable: null }

/**
 * Adds up the size and the newest change time inside `path`, walking with lstat only.
 * Symlinks are never followed (and never counted). A folder that does not exist yet measures 0 bytes;
 * one that exists but could not be read measures null. Stops after `budget` ms and reports what was
 * counted up to then.
 */
async function measure(path: string, budget: number): Promise<Measure> {
  const deadline = Date.now() + budget
  let top
  try {
    top = await lstat(path)
  } catch (err) {
    // A path that is simply not there (yet) is an empty folder; anything else that stops us reading
    // it is unknown and stays null.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { bytes: 0, changedAt: null, unreadable: null }
    return NOTHING
  }
  if (top.isSymbolicLink()) return NOTHING
  if (top.isFile()) return { bytes: top.size, changedAt: top.mtimeMs, unreadable: null }
  if (!top.isDirectory()) return NOTHING

  const acc = { bytes: 0, changedAt: top.mtimeMs as number | null, unreadable: null as string | null }
  const readable = await sumDir(path, deadline, acc)
  if (!readable) return NOTHING
  return acc
}

/**
 * Sums files under `dir` into `acc`, and notes the first folder it was not allowed to read (git skips
 * such a folder with a warning and still says everything is clean). Returns false only when `dir`
 * itself cannot be read.
 */
async function sumDir(
  dir: string,
  deadline: number,
  acc: { bytes: number; changedAt: number | null; unreadable: string | null }
): Promise<boolean> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (acc.unreadable === null && (code === 'EACCES' || code === 'EPERM')) acc.unreadable = dir
    return false
  }
  for (const name of names) {
    if (Date.now() > deadline) return true
    const child = join(dir, name)
    let st
    try {
      st = await lstat(child)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue
    if (acc.changedAt === null || st.mtimeMs > acc.changedAt) acc.changedAt = st.mtimeMs
    if (st.isDirectory()) {
      await sumDir(child, deadline, acc)
    } else if (st.isFile()) {
      acc.bytes += st.size
    }
  }
  return true
}

const ITEM_DEFS: { id: StorageItem['id']; label: string; at: (d: StorageDeps) => string }[] = [
  { id: 'worktrees', label: 'Worktrees', at: (d) => d.worktreesDir },
  { id: 'checkpoints', label: 'Checkpoints', at: (d) => d.checkpointsDir },
  { id: 'conversations', label: 'Conversations', at: (d) => join(d.dataDir, 'chats') },
  { id: 'nights', label: 'Night reports', at: (d) => join(d.dataDir, 'nightwatch.json') },
  { id: 'videos', label: 'Videos', at: (d) => join(d.dataDir, 'videos') },
  { id: 'models', label: 'Dictation models', at: (d) => join(d.dataDir, 'models') },
  { id: 'accounts', label: 'Sign-ins', at: (d) => d.accountsDir }
]

async function measureItems(deps: StorageDeps): Promise<StorageItem[]> {
  const items: StorageItem[] = []
  for (const def of ITEM_DEFS) {
    const size = await measure(def.at(deps), SCAN_BUDGET_MS)
    items.push({ id: def.id, label: def.label, path: def.at(deps), bytes: size.bytes })
  }
  return items
}

// Paths.

async function safeRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

/** True when `child` sits strictly inside `parent` (both already resolved with realpath). */
function inside(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

async function isRealFolder(path: string): Promise<boolean> {
  try {
    const st = await lstat(path)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

/** Runs `task` over `items`, at most `limit` at a time, and keeps the order of the results. */
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await task(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}

// Git.

interface GitResult {
  stdout: string
  stderr: string
  /** git said no (a non zero exit code, a timeout, or the process never ran). */
  failed: boolean
}

/** Runs git with an argument list (never a shell string) in `cwd`, with replace refs, hooks and filters switched off. */
async function runGit(args: string[], cwd: string): Promise<GitResult> {
  // No inherited GIT_WORK_TREE and friends: they would aim git at another folder than `cwd`.
  const env = {
    ...withoutRepoRouting({ ...process.env }),
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: ''
  }
  let settings: string[]
  try {
    settings = await sandboxGitArgs(cwd, env)
  } catch (err) {
    return { stdout: '', stderr: err instanceof Error ? err.message : String(err), failed: true }
  }
  return new Promise((done) => {
    execFile('git', [...settings, ...args], { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      done({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), failed: Boolean(err) })
    })
  })
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  )
}

interface ListedWorktree {
  path: string
  /** The words after `locked` in git's list (empty when git gave none), or null when it is not locked. */
  locked: string | null
}

/** Reads `git worktree list --porcelain -z`: the first entry is the main working tree, the rest are linked ones. */
function parseWorktreeList(out: string): ListedWorktree[] {
  const list: ListedWorktree[] = []
  for (const field of out.split('\0')) {
    if (field.startsWith('worktree ')) {
      list.push({ path: field.slice('worktree '.length), locked: null })
    } else if (field === 'locked' || field.startsWith('locked ')) {
      const last = list[list.length - 1]
      if (last) last.locked = field.slice('locked'.length).trim()
    }
  }
  return list
}

/** A normal repository keeps its git folder inside its working folder; a bare one is its own git folder. */
function repositoryOf(commonDir: string): string {
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * git could not say which repository the worktree folder `real` belongs to. "Its repository is gone"
 * is only said when the folders its `.git` file points at are really missing; a git that is not
 * installed, does not answer in time or does not trust the folder is not a gone repository.
 */
async function whyNoRepository(real: string, said: string): Promise<RepositoryLookup> {
  const unanswered: RepositoryLookup = { repo: null, problem: `Regatta could not ask git about it${said ? ` (${said})` : ''}, so it was kept.` }
  let pointer: string | undefined
  try {
    pointer = (await readFile(join(real, '.git'), 'utf8')).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
  } catch {
    return unanswered
  }
  if (!pointer) return unanswered
  const gitdir = isAbsolute(pointer) ? pointer : resolve(real, pointer)
  // The folder git keeps for this worktree is there, so git failed for some other reason.
  if (await pathExists(gitdir)) return unanswered
  // It is gone: <git folder>/worktrees/<name>. With the git folder still there, the repository only forgot this worktree.
  const commonDir = dirname(dirname(gitdir))
  if (await pathExists(commonDir)) return { repo: repositoryOf(commonDir), problem: NOT_LISTED }
  return { repo: null, problem: REPOSITORY_GONE }
}

interface RepositoryLookup {
  /** The main repository folder; null when git cannot tell which one it is. */
  repo: string | null
  /** Why git cannot vouch for the worktree. Null when the repository knows it as a linked worktree. */
  problem: string | null
}

/**
 * Finds the main repository of the worktree folder `real` and asks it whether it lists the folder as
 * one of its linked worktrees (real paths compared, since git writes the path it resolved). A
 * worktree whose repository is gone, or that its repository no longer knows, is never removable.
 */
async function findRepository(real: string): Promise<RepositoryLookup> {
  const common = await runGit(['rev-parse', '--git-common-dir'], real)
  const printed = common.failed ? '' : common.stdout.trim()
  if (!printed) return whyNoRepository(real, firstLine(common.stderr))
  const repo = repositoryOf(isAbsolute(printed) ? printed : resolve(real, printed))

  const listed = await runGit(['worktree', 'list', '--porcelain', '-z'], repo)
  if (listed.failed) {
    const said = firstLine(listed.stderr)
    return { repo, problem: `Regatta could not ask its repository about it${said ? ` (${said})` : ''}, so it was kept.` }
  }
  const entries = parseWorktreeList(listed.stdout)
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    const entryReal = (await safeRealpath(entry.path)) ?? entry.path
    if (entryReal !== real) continue
    if (index === 0) return { repo, problem: "It is the repository's own folder, not a worktree made from it, so it was kept." }
    if (entry.locked !== null && entry.locked !== TRASH_LOCK_REASON) {
      return { repo, problem: `Git has it locked${entry.locked ? ` (${entry.locked})` : ''}, so it was kept. Unlock it in git first if you want it gone.` }
    }
    return { repo, problem: null }
  }
  return { repo, problem: NOT_LISTED }
}

async function branchOf(real: string): Promise<string | null> {
  const out = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], real)
  const name = out.failed ? '' : out.stdout.trim()
  return name || null
}

// What is in use.

/** Real paths of everything an open pane, heat, night run or flow run uses. Null when that cannot be told. */
async function realPathsInUse(deps: StorageDeps): Promise<Set<string> | null> {
  let paths: string[]
  try {
    paths = deps.inUse()
  } catch {
    return null
  }
  const out = new Set<string>()
  for (const path of paths) {
    const real = await safeRealpath(path)
    if (real) out.add(real)
  }
  return out
}

/** True when something in use is the folder itself or sits inside it. */
function usedBy(used: Set<string>, real: string): boolean {
  for (const path of used) if (path === real || inside(real, path)) return true
  return false
}

// Leftovers.

interface Candidate {
  /** Where the scan found it: <worktreesDir>/<name> (heats, night watch and flows) or <worktreesDir>/<repo folder>/<name> (panes). */
  path: string
  real: string
}

interface Listing {
  /** worktreesDir after realpath, or null when it is not there. */
  base: string | null
  used: Set<string> | null
  /** Every worktree at either depth (a folder holding a `.git` file), in use or not, in path order. */
  found: Candidate[]
}

/**
 * What a folder under worktreesDir is. A linked worktree keeps its pointer in a `.git` FILE. A `.git`
 * of any other kind (a repository's folder, a link) means something that is not Regatta's to look
 * into. Anything else is a plain folder, which may hold worktrees one level down.
 */
async function kindOf(path: string): Promise<'worktree' | 'other' | 'plain' | null> {
  if (!(await isRealFolder(path))) return null
  try {
    return (await lstat(join(path, '.git'))).isFile() ? 'worktree' : 'other'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'plain' : 'other'
  }
}

/**
 * Lists the worktrees under worktreesDir at the two depths Regatta uses: directly in it (the folders
 * heats, night watch and flows make: `heat-<id>-<lane>`) and one folder down (the panes' worktrees:
 * `<repo folder>/<name>`). A worktree is a leaf, never entered. Nothing deeper is looked at and no
 * link is followed.
 */
async function listFolders(deps: StorageDeps): Promise<Listing> {
  const base = await safeRealpath(deps.worktreesDir)
  const used = await realPathsInUse(deps)
  const found: Candidate[] = []
  if (base === null) return { base, used, found }

  const add = async (path: string): Promise<void> => {
    const real = await safeRealpath(path)
    if (real !== null && inside(base, real)) found.push({ path, real })
  }

  let firstLevel: string[]
  try {
    firstLevel = (await readdir(deps.worktreesDir)).sort()
  } catch {
    return { base, used, found }
  }
  for (const first of firstLevel) {
    if (first === TRASH_DIR_NAME) continue
    const firstPath = join(deps.worktreesDir, first)
    const kind = await kindOf(firstPath)
    if (kind === 'worktree') {
      await add(firstPath)
      continue
    }
    if (kind !== 'plain') continue
    let names: string[]
    try {
      names = (await readdir(firstPath)).sort()
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(firstPath, name)
      if ((await kindOf(path)) === 'worktree') await add(path)
    }
  }
  return { base, used, found: found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) }
}

/** Sentence case with a full stop, for a reason written as a fragment. */
function sentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  const first = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(first) ? first : `${first}.`
}

/** Looks at one leftover: size, repository, branch, and whether it can be moved to Regatta's trash. */
async function describeLeftover(candidate: Candidate, unknownUse: boolean): Promise<LeftoverWorktree> {
  const { path, real } = candidate
  const size = await measure(path, SCAN_BUDGET_MS)
  const shown = { path, bytes: size.bytes, changedAt: size.changedAt }
  let repo: string | null = null
  let branch: string | null = null
  try {
    branch = await branchOf(real)
    const found = await findRepository(real)
    repo = found.repo
    if (found.problem !== null) return { ...shown, repo, branch, removable: false, reason: found.problem }
    if (unknownUse) {
      return { ...shown, repo, branch, removable: false, reason: 'Regatta could not tell which worktrees are open, so it was kept.' }
    }
    if (worktreeIdentity(real) === null) {
      return { ...shown, repo, branch, removable: false, reason: 'Regatta cannot tell whether it is the worktree it made, so it was kept.' }
    }
    return { ...shown, repo, branch, removable: true, reason: null }
  } catch (err) {
    const said = err instanceof Error ? firstLine(err.message) : ''
    return { ...shown, repo, branch, removable: false, reason: `Regatta could not check it${said ? ` (${said})` : ''}, so it was kept.` }
  }
}

/**
 * Every unused worktree under worktreesDir. `kept` holds the reasons a move to trash just gave for
 * refusing a worktree, so a row that could not be moved shows why.
 */
async function findLeftovers(deps: StorageDeps, kept: Map<string, string>): Promise<LeftoverWorktree[]> {
  const listing = await listFolders(deps)
  const unused = listing.found.filter((candidate) => listing.used === null || !usedBy(listing.used, candidate.real))
  return mapLimit(unused, CHECKS_AT_ONCE, async (candidate) => {
    const leftover = await describeLeftover(candidate, listing.used === null)
    const note = kept.get(candidate.real)
    return note ? { ...leftover, removable: false, reason: note } : leftover
  })
}

async function report(deps: StorageDeps, kept: Map<string, string>, emptyErrors?: ReadonlyMap<string, string>): Promise<StorageReport> {
  const [items, leftovers, trash] = await Promise.all([
    measureItems(deps),
    findLeftovers(deps, kept),
    listTrash(deps.worktreesDir, emptyErrors)
  ])
  return { items, leftovers, trash, scannedAt: Date.now() }
}

export async function scanStorage(deps: StorageDeps): Promise<StorageReport> {
  return report(deps, new Map())
}

// Moving leftovers to trash and emptying trash.

function skipped(requested: string, why: string): void {
  console.log(`storage: skipped ${requested}: ${why}`)
}

/**
 * Turns a refusal from trashOwnedWorktree into a sentence for the user: without the path it starts
 * with or the path git quotes, and without git's advice to force, which Regatta never gives.
 */
function keptReason(reason: string | null, real: string): string {
  let text = (reason ?? 'It was kept.').trim()
  const prefix = `${real} was kept: `
  if (text.startsWith(prefix)) text = text.slice(prefix.length)
  text = text.replace(/^(fatal|error): /i, '').split(`'${real}'`).join('it').split(real).join('it')
  text = text.replace(/[,;]\s*use\b.*$/i, '')
  if (/(^|\s)--?[a-z]/i.test(text)) text = 'Git would not move it'
  return sentence(text)
}

/**
 * Moves one chosen leftover worktree to Regatta's trash through trashOwnedWorktree (removeOwnedWorktree),
 * or keeps it and notes why in `kept`.
 */
async function removeOne(deps: StorageDeps, requested: string, base: string | null, kept: Map<string, string>): Promise<void> {
  const real = await safeRealpath(requested)
  if (real === null) return skipped(requested, 'no such folder')
  // Strictly inside: worktreesDir itself is never a candidate.
  if (base === null || !inside(base, real)) return skipped(requested, 'not inside the worktrees folder')

  // A fresh look: only what is a leftover right now, and not in use, may go.
  const listing = await listFolders(deps)
  const candidate = listing.found.find((found) => found.real === real)
  if (!candidate) return skipped(requested, 'not a worktree in the worktrees folder')
  if (listing.used === null) return skipped(requested, 'could not tell what is in use')
  if (usedBy(listing.used, real)) return skipped(requested, 'still in use')

  const lookup = await findRepository(real)
  if (lookup.repo === null || lookup.problem !== null) {
    kept.set(real, lookup.problem ?? REPOSITORY_GONE)
    return
  }
  const repo = lookup.repo
  const branch = await branchOf(real)

  try {
    await withRepoLock(repo, async () => {
      const usedNow = await realPathsInUse(deps)
      if (usedNow === null || usedBy(usedNow, real)) return skipped(requested, 'still in use')
      const result = await trashOwnedWorktree({
        root: repo,
        path: real,
        branch: branch && branch.startsWith('regatta/') ? branch : null,
        identity: worktreeIdentity(real),
        dir: base
      })
      if (result.status === 'kept' || result.status === 'foreign') kept.set(real, keptReason(result.reason, real))
    })
  } catch (err) {
    kept.set(real, `Regatta could not move it to trash (${err instanceof Error ? firstLine(err.message) : String(err)}), so it was kept.`)
  }
}

export async function removeWorktrees(deps: StorageDeps, paths: string[]): Promise<StorageReport> {
  const kept = new Map<string, string>()
  const base = await safeRealpath(deps.worktreesDir)
  const asked = new Set<string>()
  for (const requested of Array.isArray(paths) ? paths : []) {
    if (typeof requested !== 'string' || requested.length === 0 || asked.has(requested)) continue
    asked.add(requested)
    try {
      await removeOne(deps, requested, base, kept)
    } catch (err) {
      skipped(requested, err instanceof Error ? firstLine(err.message) : String(err))
    }
  }
  return report(deps, kept)
}

export async function emptyStorageTrash(deps: StorageDeps): Promise<EmptyTrashResult> {
  const { outcomes, errors } = await emptyTrash(deps.worktreesDir, withRepoLock)
  const nextReport = await report(deps, new Map(), errors)
  return { report: nextReport, outcomes }
}

// About.

function readLicense(value: unknown): string {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    const type = (value as { type?: unknown }).type
    if (typeof type === 'string' && type) return type
  }
  return 'Unknown'
}

async function readInstalledVersion(pkgJsonPath: string): Promise<string | null> {
  try {
    const raw = await readFile(pkgJsonPath, 'utf8')
    const version = (JSON.parse(raw) as { version?: unknown }).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/** Name, version and license of every package the app ships with (from node_modules). */
export async function licenseNotices(appPath: string): Promise<LicenseNotice[]> {
  let dependencies: Record<string, string> = {}
  try {
    const raw = await readFile(join(appPath, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
    dependencies = pkg.dependencies ?? {}
  } catch {
    dependencies = {}
  }

  const notices: LicenseNotice[] = []
  for (const name of Object.keys(dependencies).sort()) {
    const pkgJson = join(appPath, 'node_modules', ...name.split('/'), 'package.json')
    let entry: { version?: unknown; license?: unknown }
    try {
      entry = JSON.parse(await readFile(pkgJson, 'utf8')) as { version?: unknown; license?: unknown }
    } catch {
      continue
    }
    const version = typeof entry.version === 'string' ? entry.version : ''
    notices.push({ name, version, license: readLicense(entry.license) })
  }

  const running = (process.versions as { [key: string]: string | undefined })['electron']
  const electronVersion = running ?? (await readInstalledVersion(join(appPath, 'node_modules', 'electron', 'package.json'))) ?? ''
  notices.push({ name: 'Electron', version: electronVersion, license: 'MIT' })

  return notices.sort((a, b) => a.name.localeCompare(b.name))
}
