// Checkpoints: shadow-repo snapshots around every agent step, roll back and redo.
// Hardened in the checkpoints-safety pass.
//
// Rules this file keeps, because roll back writes and deletes the user's own files:
// - Git runs in isolation: no inherited GIT_* variables, no global config, no hooks, no signing, no
//   attribute filters, so the shadow repository stores the raw bytes and never touches the project's .git.
// - Snapshots are parentless commits kept alive by refs, so dropping a step really frees its objects.
// - A file is only ever deleted or overwritten after a successful tree lookup proves what it should be,
//   after a symlink-safe path check, and after its current content is re-checked right before the write.
//   Any git failure aborts the whole operation with nothing changed.
// - Steps that overlap in time in one folder are marked shared and are never rolled back.

import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  chmodSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withoutRepoRouting } from './env'
import type { CheckpointStep, RollbackFile, RollbackResult, SkippedItem, StepFile } from '../shared/checkpoints'
import type { AgentKind } from '../shared/types'

export interface CheckpointsDeps {
  /** Folder that holds every shadow repository; defaults to ~/.regatta/checkpoints. */
  baseDir?: () => string
  emitChanged: (sessionId: string) => void
  /** Told about every problem (failed snapshots, unreadable history). Defaults to console.error. */
  log?: (message: string, err?: unknown) => void
  /** Steps kept per workspace (default 200). */
  maxSteps?: number
  /** Files larger than this are left out of snapshots (default 50 MB). */
  maxFileBytes?: number
  /** One git command may take this long before it is killed (default 120 s). */
  gitTimeoutMs?: number
  /** Pause between attempts when an end snapshot fails (default 300 ms). */
  retryDelayMs?: number
  /** Run `git gc --prune=now` after this many snapshots were dropped (default 100). */
  gcAfterDrops?: number
  /** Failed and unprotected records kept per workspace (default 20). */
  maxFailedRecords?: number
}

/** A problem the user can act on; the message is plain English. */
export class CheckpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckpointError'
  }
}

const DEFAULT_MAX_STEPS = 200
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024
const DEFAULT_GIT_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_DELAY_MS = 300
const DEFAULT_GC_AFTER_DROPS = 100
const MAX_GIT_OUTPUT = 128 * 1024 * 1024
const LS_TREE_CHUNK = 200
/** Folders that hold dependencies or build output; they are never snapshotted. */
const SKIP_FOLDERS = ['node_modules', 'dist', 'build', '.next', 'target']
const MAX_SKIPPED_RECORDED = 100
/** Shadow repository attributes: store raw bytes whatever the project's .gitattributes asks for. */
const RAW_ATTRIBUTES = '* -text -eol -filter -ident -working-tree-encoding\n'
const EXEC_BITS_SUPPORTED = process.platform !== 'win32'
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

const OPEN_WRITER = 'a program has this file open'
const NO_HARD_LINKS = 'this file system has no hard links, so Regatta cannot recreate the file safely'
const ACTIVE_REASON = 'An agent is still working in this folder. Wait for it to finish, then try again.'
const SHARED_REASON =
  'Another agent worked in this folder at the same time, so Regatta cannot tell whose changes are whose. Nothing was rolled back.'

interface OpenStep {
  id: string
  sessionId: string
  agent: AgentKind
  /** Canonical (realpath) workspace folder. */
  root: string
  label: string
  /** Set once the start snapshot exists. */
  start: string | null
  startedAt: number
  shadowDir: string
  /** Another step was open in a related folder at the same time. */
  shared: boolean
  skipped: SkippedItem[]
  /** What was on disk but left out of the start snapshot (ignored files, `dir/` for ignored folders). */
  unrecorded?: Set<string>
  /** Device and inode of the workspace folder when the step registered. */
  rootId: string
  /** Set when the opening snapshot failed or was too slow: the step is recorded but never restorable. */
  unprotected: string | null
  /** Set when the step could not even be registered (storage inside the workspace, unreadable folder). */
  refusal?: CheckpointError
}

interface StoredStep extends CheckpointStep {
  cwd: string
  shadowDir: string
  rewoundPaths?: string[]
  /** Files of this step that were on disk when it began but not recorded (ignored): rollback never deletes them. */
  existedPaths?: string[]
  /** Which operation was left unfinished while `partial` is set. */
  partialDirection?: 'rollback' | 'redo'
  /** Device and inode of the workspace folder when the step was recorded. */
  rootId?: string
}

class ShadowQueue {
  private tail: Promise<unknown> = Promise.resolve()

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = () => task()
    const result = this.tail.then(run, run)
    this.tail = result.then(
      () => {},
      () => {}
    )
    return result
  }
}

interface RunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  input?: Buffer | string
  /** Send stdout straight into this open file descriptor (used to stream big blobs to disk). */
  outFd?: number
}

class GitTimeoutError extends Error {
  readonly timedOut = true
}

/** Runs git and resolves with stdout. Rejects on a non-zero exit, a spawn error or a timeout. */
function runGit(args: string[], sub: string, opts: RunOptions): Promise<Buffer> {
  return new Promise((done, fail) => {
    let child
    try {
      child = spawn('git', args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', opts.outFd ?? 'pipe', 'pipe']
      })
    } catch (err) {
      fail(err)
      return
    }
    const out: Buffer[] = []
    const errChunks: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let settled = false
    const finish = (err: Error | null, value?: Buffer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) fail(err)
      else done(value ?? Buffer.alloc(0))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new GitTimeoutError(`git ${sub} timed out after ${opts.timeoutMs} ms`))
    }, opts.timeoutMs)
    child.on('error', (err) => finish(err))
    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > MAX_GIT_OUTPUT) {
        child.kill('SIGKILL')
        finish(new Error(`git ${sub} produced too much output`))
        return
      }
      out.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes < 64 * 1024) {
        errChunks.push(chunk)
        errBytes += chunk.length
      }
    })
    child.on('close', (code) => {
      if (code === 0) {
        finish(null, Buffer.concat(out))
        return
      }
      const msg = Buffer.concat(errChunks).toString('utf8').trim()
      finish(new Error(msg || `git ${sub} failed (exit ${code})`))
    })
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(opts.input)
    }
  })
}

export function parseNumstat(output: string): StepFile[] {
  const files: StepFile[] = []
  if (!output.trim()) return files
  const tokens = output.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    const tab1 = token.indexOf('\t')
    if (tab1 === -1) continue
    const tab2 = token.indexOf('\t', tab1 + 1)
    if (tab2 === -1) continue
    const addedStr = token.slice(0, tab1)
    const removedStr = token.slice(tab1 + 1, tab2)
    const filePath = token.slice(tab2 + 1)
    if (!filePath && i + 2 < tokens.length) {
      const oldPath = tokens[++i]
      const newPath = tokens[++i]
      const added = addedStr === '-' ? 0 : parseInt(addedStr, 10) || 0
      const removed = removedStr === '-' ? 0 : parseInt(removedStr, 10) || 0
      if (oldPath) files.push({ path: oldPath, added: 0, removed })
      if (newPath) files.push({ path: newPath, added, removed: 0 })
      continue
    }
    const added = addedStr === '-' ? 0 : parseInt(addedStr, 10) || 0
    const removed = removedStr === '-' ? 0 : parseInt(removedStr, 10) || 0
    files.push({ path: filePath, added, removed })
  }
  return files
}

/** Merges repeated paths (a type change can list a path twice). */
function mergeFiles(files: StepFile[]): StepFile[] {
  const byPath = new Map<string, StepFile>()
  for (const f of files) {
    const known = byPath.get(f.path)
    if (known) {
      known.added += f.added
      known.removed += f.removed
    } else byPath.set(f.path, { ...f })
  }
  return [...byPath.values()]
}

// ---- small pure helpers ----

const HEX = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9-]{5,63}$/

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

function related(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a)
}

/** A path from a step's file list: relative, no `.` or `..` parts, never inside a `.git` folder. */
export function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false
  if (p.includes('\0') || p.startsWith('/') || isAbsolute(p)) return false
  if (process.platform === 'win32' && (p.includes('\\') || /^[A-Za-z]:/.test(p))) return false
  for (const part of p.split('/')) {
    if (part === '' || part === '.' || part === '..') return false
    if (part.toLowerCase() === '.git') return false
  }
  return true
}

function errCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Identity of a file at one moment. ctime (change time) is included because no user can set it back. */
function sigOf(st: Stats): string {
  return `${st.dev}:${st.ino}:${st.mode}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
}

/** The git blob id of some bytes, computed here (the shadow repository always uses SHA-1 objects). */
function blobOid(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

/**
 * The only extended attributes that may be lost: macOS puts them on every file by itself. Others look
 * similar but carry meaning (`com.apple.quarantine` feeds Gatekeeper, `com.apple.macl` records consent).
 */
const MANAGED_XATTRS = new Set(['com.apple.provenance', 'com.apple.lastuseddate#PS'])
const XATTR_REASON = 'it has extended attributes or a resource fork that checkpoints do not keep'
const XATTR_UNREADABLE = 'its extended attributes could not be read, so Regatta cannot tell what would be lost'

/** Runs xattr with the arguments as given (the attribute name is one argument, whatever it contains). */
function runXattr(args: string[]): string | null {
  for (const bin of ['xattr', '/usr/bin/xattr']) {
    try {
      return execFileSync(bin, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      if (errCode(err) !== 'ENOENT') return null
    }
  }
  return null
}

/**
 * Why an existing file must be kept: it carries extended attributes (including the resource fork,
 * `com.apple.ResourceFork`) that the shadow repository does not hold, so replacing or deleting it would
 * destroy them. Only the two attributes macOS manages itself are ignored, and only when the listing is
 * unambiguous: attribute names may contain newlines, so a blank line, a repeated name, or an ignored
 * name that cannot be read back under exactly that name means the file is kept. Null means it is safe
 * to replace.
 */
function attributeProblem(abs: string, isLink: boolean): string | null {
  if (process.platform !== 'darwin') return null
  const flags = isLink ? ['-s'] : []
  const listing = runXattr([...flags, abs])
  if (listing === null) return XATTR_UNREADABLE
  if (listing === '') return null
  if (!listing.endsWith('\n')) return XATTR_REASON
  const names = listing.slice(0, -1).split('\n')
  if (new Set(names).size !== names.length) return XATTR_REASON
  for (const name of names) {
    if (name === '' || !MANAGED_XATTRS.has(name)) return XATTR_REASON
    // The listing cannot tell one name from two joined by a newline: ask for exactly this name.
    if (runXattr([...flags, '-p', name, abs]) === null) return XATTR_REASON
  }
  return null
}

/** Files up to this size are hashed again right before they are replaced. */
const REHASH_LIMIT = 8 * 1024 * 1024

/** Flushes a file to disk. */
function fsyncFile(file: string): void {
  const fd = openSync(file, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Flushes a folder's entries (a rename or removal inside it) to disk. Not every platform allows it. */
function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** What one lsof record says about a file reference: who holds it, how, and which file it is. */
interface LsofRecord {
  pid: string
  fd: string
  access: string | null
  device: string | null
  inode: string | null
}

const LSOF_MAX_BYTES = 16 * 1024 * 1024
const LSOF_TIMEOUT_MS = 30_000

/** One lsof run over some files. Anything but a complete, clean answer throws: an unknown is never "nothing open". */
async function runLsof(chunk: string[]): Promise<string> {
  let lastError: unknown = new Error('lsof is not available')
  for (const bin of ['lsof', '/usr/sbin/lsof', '/usr/bin/lsof']) {
    try {
      return await new Promise<string>((done, fail) => {
        // -w keeps warnings off stderr, so any stderr text at all means something went wrong.
        const child = spawn(bin, ['-nP', '-w', '-F', 'pfatDin', '--', ...chunk], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } })
        const out: Buffer[] = []
        const err: Buffer[] = []
        let outBytes = 0
        let settled = false
        const end = (error: Error | null, value?: string): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) fail(error)
          else done(value ?? '')
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          end(new Error('lsof timed out'))
        }, LSOF_TIMEOUT_MS)
        child.on('error', (e) => end(e))
        child.stdout.on('data', (c: Buffer) => {
          outBytes += c.length
          if (outBytes > LSOF_MAX_BYTES) {
            child.kill('SIGKILL')
            end(new Error('lsof printed too much'))
          } else out.push(c)
        })
        child.stderr.on('data', (c: Buffer) => err.push(c))
        child.on('close', (code, signal) => {
          const stdout = Buffer.concat(out).toString('utf8')
          const stderr = Buffer.concat(err).toString('utf8').trim()
          if (signal) return end(new Error(`lsof was stopped by ${signal}`))
          if (stderr) return end(new Error(`lsof reported: ${stderr.slice(0, 200)}`))
          // Exit 1 means "nothing found" only with an empty answer. lsof also exits 1 when it found open
          // instances of some of the files but not of others, and then the listing is complete (it must
          // parse cleanly and end properly, which the caller checks); stderr text always means trouble.
          if (code === 1 && stdout === '') return end(null, '')
          if ((code === 0 || code === 1) && stdout.startsWith('p')) return end(null, stdout)
          end(new Error(`lsof exited with ${code}${stdout ? ' and an answer that is not a listing' : ''}`))
        })
      })
    } catch (e) {
      lastError = e
      if (errCode(e) !== 'ENOENT') break
    }
  }
  throw lastError
}

function parseLsof(output: string): LsofRecord[] {
  if (output === '') return []
  if (!output.endsWith('\n')) throw new Error('lsof output was cut off')
  const records: LsofRecord[] = []
  let pid = ''
  let current: LsofRecord | null = null
  for (const line of output.slice(0, -1).split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      pid = value
      current = null
    } else if (tag === 'f') {
      if (!pid) throw new Error('lsof output was malformed')
      current = { pid, fd: value, access: null, device: null, inode: null }
      records.push(current)
    } else if (tag === 'a' || tag === 'D' || tag === 'i') {
      if (!current) throw new Error('lsof output was malformed')
      if (tag === 'a') current.access = value
      else if (tag === 'D') current.device = value
      else current.inode = value
    } else if (tag !== 't' && tag !== 'n') {
      throw new Error('lsof output was malformed')
    }
  }
  return records
}

/**
 * Files among `files` that some program may write to: open for writing (access w or u), or referenced
 * in any way that is not clearly read-only (a memory mapping, a running program, an unknown mode).
 * Files are matched by device and inode, never by name. Throws when the answer is not complete and
 * clean, because an unchecked file may be written to while it is replaced and lose that data.
 */
async function writersOf(files: string[]): Promise<Set<string>> {
  const writers = new Set<string>()
  if (files.length === 0 || process.platform === 'win32') return writers
  for (let i = 0; i < files.length; i += 100) {
    const chunk: string[] = []
    const ids = new Map<string, string[]>()
    for (const file of files.slice(i, i + 100)) {
      let st: Stats
      try {
        st = lstatSync(file)
      } catch (err) {
        if (errCode(err) === 'ENOENT') continue // nothing there to be open
        throw err
      }
      if (!st.isFile()) continue
      chunk.push(file)
      const key = `${st.dev}:${st.ino}`
      ids.set(key, [...(ids.get(key) ?? []), file])
    }
    if (chunk.length === 0) continue
    const records = parseLsof(await runLsof(chunk))
    for (const record of records) {
      if (record.access === 'r') continue
      const device = record.device === null ? NaN : Number(record.device)
      const hit = record.inode === null || Number.isNaN(device) ? undefined : ids.get(`${device}:${record.inode}`)
      if (hit) for (const file of hit) writers.add(file)
      // Identity could not be established for a busy reference: the whole group counts as busy.
      else for (const file of chunk) writers.add(file)
    }
  }
  return writers
}

/** Escapes a path so it matches exactly one entry in an ignore file. */
function excludePattern(p: string): string {
  let out = ''
  for (const ch of p) out += /[\\*?[\]]/.test(ch) ? `\\${ch}` : ch
  if (/^[!#]/.test(out)) out = `\\${out}`
  return `/${out.replace(/ +$/, (spaces) => '\\ '.repeat(spaces.length))}`
}

const refOf = (id: string, role: string): string => `refs/regatta/s/${id}/${role}`
/** Failed and unprotected records kept per workspace; they carry no snapshots worth keeping. */
const MAX_FAILED_RECORDS = 20

/** A file that is being hashed was written to by someone else: a real conflict, not a failure. */
class ChangedWhileReading extends Error {}

function rootIdOf(root: string): string {
  const st = statSync(root)
  return `${st.dev}:${st.ino}`
}

interface Journal {
  v: 1
  kind: 'rollback' | 'redo'
  stepId: string
  opId: string
  paths: string[]
  rewoundBefore: string[]
  pre: string
  startedAt: number
}

type TreeEntry =
  | { kind: 'absent' }
  | { kind: 'dir' }
  | { kind: 'gitlink' }
  | { kind: 'file'; oid: string; exec: boolean; size: number }
  | { kind: 'symlink'; oid: string; size: number }

type Current =
  | { kind: 'absent' }
  | { kind: 'dir' }
  | { kind: 'other' }
  | { kind: 'file'; oid: string; exec: boolean; sig: string; mode: number; size: number }
  | { kind: 'symlink'; oid: string; sig: string }

/** `operational` marks a disk error (for example EIO), as opposed to the path simply not being ours to touch. */
type Gate = { ok: true; abs: string; st: Stats | null } | { ok: false; reason: string; operational?: boolean }

/** Whether `path` was on disk but not recorded when the step began: listed itself, or inside a listed `dir/`. */
function wasUnrecorded(unrecorded: Set<string> | undefined, path: string): boolean {
  if (!unrecorded) return false
  if (unrecorded.has(path)) return true
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
    if (unrecorded.has(path.slice(0, i + 1))) return true
  }
  return false
}

function entryMatches(cur: Current, entry: TreeEntry): boolean {
  switch (entry.kind) {
    case 'absent':
      return cur.kind === 'absent'
    case 'file':
      return cur.kind === 'file' && cur.oid === entry.oid && (!EXEC_BITS_SUPPORTED || cur.exec === entry.exec)
    case 'symlink':
      return cur.kind === 'symlink' && cur.oid === entry.oid
    default:
      return false
  }
}

interface Ctx {
  root: string
  shadowDir: string
  gitDir: string
  env: NodeJS.ProcessEnv
  cfg: string[]
  /** Canonical checkpoint storage folder. */
  base: string
  /** Expected device and inode of the workspace folder, when known. */
  rootId?: string
}

interface PlanItem {
  file: StepFile
  from: TreeEntry
  to: TreeEntry
  cur: Current
  extracted?: string
}

interface Registration extends OpenStep {}

export class Checkpoints {
  private readonly queues = new Map<string, ShadowQueue>()
  /** Steps whose start was requested and whose end has not finished: pending or open. */
  private readonly regs = new Set<Registration>()
  /** Steps with a start snapshot, waiting for their end. */
  private readonly openSteps = new Map<string, Registration>()
  private readonly sessionChains = new Map<string, Promise<unknown>>()
  /** Per session: why the latest turn could not be checkpointed at all (shown as "not protected"). */
  private readonly notices = new Map<string, { reason: string; at: number; agent: AgentKind; label: string }>()
  private readonly allSteps = new Map<string, StoredStep>()
  private loaded = false

  private readonly maxSteps: number
  private readonly maxFileBytes: number
  private readonly gitTimeoutMs: number
  private readonly retryDelayMs: number
  private readonly gcAfterDrops: number
  private readonly maxFailedRecords: number

  constructor(private readonly deps: CheckpointsDeps) {
    this.maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
    this.maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.gitTimeoutMs = deps.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.gcAfterDrops = deps.gcAfterDrops ?? DEFAULT_GC_AFTER_DROPS
    this.maxFailedRecords = deps.maxFailedRecords ?? MAX_FAILED_RECORDS
  }

  // ---- plumbing ----

  private log(message: string, err?: unknown): void {
    const full = err === undefined ? message : `${message}: ${errText(err)}`
    try {
      if (this.deps.log) this.deps.log(full, err)
      else console.error(`[checkpoints] ${full}`)
    } catch {
      // a broken logger must never break a checkpoint
    }
  }

  private getBaseDir(): string {
    return this.deps.baseDir ? this.deps.baseDir() : join(homedir(), '.regatta', 'checkpoints')
  }

  /** The storage folder, created if needed, with symlinks resolved. */
  private realBase(): string {
    const base = resolve(this.getBaseDir())
    try {
      mkdirSync(base, { recursive: true })
      return realpathSync(base)
    } catch (err) {
      throw new CheckpointError(`Checkpoint storage ${base} is not usable: ${errText(err)}`)
    }
  }

  private shadowDirFor(base: string, root: string): string {
    return join(base, createHash('sha1').update(root).digest('hex').slice(0, 12))
  }

  private queueFor(shadowDir: string): ShadowQueue {
    let queue = this.queues.get(shadowDir)
    if (!queue) {
      queue = new ShadowQueue()
      this.queues.set(shadowDir, queue)
    }
    return queue
  }

  private ctxFor(root: string, shadowDir: string, base: string): Ctx {
    const gitDir = join(shadowDir, 'git')
    // Start from the inherited environment minus every repository-routing variable (and all other GIT_*).
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(withoutRepoRouting({ ...process.env }))) {
      if (!key.toUpperCase().startsWith('GIT_')) env[key] = value
    }
    Object.assign(env, {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: join(shadowDir, 'index'),
      GIT_CONFIG_GLOBAL: NULL_DEVICE,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0'
    })
    const cfg = [
      '-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false',
      '-c', 'core.fileMode=true',
      '-c', 'core.symlinks=true',
      '-c', 'core.precomposeUnicode=false',
      '-c', 'core.quotePath=false',
      '-c', 'core.fsmonitor=false',
      '-c', `core.attributesFile=${join(shadowDir, 'empty-attributes')}`,
      '-c', `core.hooksPath=${join(shadowDir, 'nohooks')}`,
      '-c', 'commit.gpgsign=false',
      '-c', 'tag.gpgsign=false',
      '-c', 'core.fsync=objects,reference,index',
      '-c', 'core.fsyncMethod=fsync',
      '-c', 'gc.auto=0',
      '-c', 'advice.addEmbeddedRepo=false',
      '-c', 'init.defaultBranch=regatta',
      '-c', 'user.name=Regatta',
      '-c', 'user.email=regatta@localhost'
    ]
    return { root, shadowDir, gitDir, env, cfg, base }
  }

  private git(ctx: Ctx, args: string[], extra: { input?: Buffer | string; outFd?: number; timeoutMs?: number } = {}): Promise<Buffer> {
    return runGit([...ctx.cfg, ...args], args[0] ?? 'command', {
      cwd: ctx.root,
      env: ctx.env,
      timeoutMs: extra.timeoutMs ?? this.gitTimeoutMs,
      input: extra.input,
      outFd: extra.outFd
    })
  }

  private async gitText(ctx: Ctx, args: string[], extra: { input?: Buffer | string } = {}): Promise<string> {
    return (await this.git(ctx, args, extra)).toString('utf8')
  }

  /** Static ignore rules, plus anything that must stay out of the snapshot. */
  private writeExclude(ctx: Ctx, extra: string[]): void {
    const lines = ['# Regatta checkpoint rules, rewritten before every snapshot', ...SKIP_FOLDERS.map((n) => `${n}/`)]
    if (isInside(ctx.root, ctx.base)) {
      const rel = relative(ctx.root, ctx.base).split(sep).join('/')
      if (rel) lines.push(`/${rel}/`)
    }
    lines.push(...extra)
    writeFileSync(join(ctx.gitDir, 'info', 'exclude'), `${lines.join('\n')}\n`, 'utf8')
  }

  private async ensureInit(ctx: Ctx): Promise<void> {
    mkdirSync(ctx.shadowDir, { recursive: true })
    mkdirSync(join(ctx.shadowDir, 'nohooks'), { recursive: true })
    writeFileSync(join(ctx.shadowDir, 'empty-attributes'), '', 'utf8')
    if (!existsSync(join(ctx.gitDir, 'HEAD'))) {
      await this.git(ctx, ['init', '-q', '--template='])
    }
    mkdirSync(join(ctx.gitDir, 'info'), { recursive: true })
    writeFileSync(join(ctx.gitDir, 'info', 'attributes'), RAW_ATTRIBUTES, 'utf8')
    // Objects, refs and the index are flushed to disk as git writes them (survives power loss).
    let config = ''
    try {
      config = readFileSync(join(ctx.gitDir, 'config'), 'utf8').toLowerCase()
    } catch {
      // the config is created by init
    }
    if (!config.includes('fsyncmethod')) {
      await this.git(ctx, ['config', '--local', 'core.fsync', 'objects,reference,index'])
      await this.git(ctx, ['config', '--local', 'core.fsyncMethod', 'fsync'])
    }
    const cwdFile = join(ctx.shadowDir, 'cwd.txt')
    if (!existsSync(cwdFile)) {
      try {
        writeFileSync(cwdFile, ctx.root, 'utf8')
      } catch {
        // cosmetic only
      }
    }
  }

  /** Files over the size limit leave the index and the snapshot; returns what was skipped. */
  private async skipOversize(ctx: Ctx): Promise<{ skipped: SkippedItem[]; excludes: string[] }> {
    const listing = await this.gitText(ctx, ['ls-files', '-z', '-m', '-o', '--exclude-standard'])
    const seen = new Set<string>()
    const big: string[] = []
    for (const p of listing.split('\0')) {
      if (!p || seen.has(p)) continue
      seen.add(p)
      let st: Stats
      try {
        st = lstatSync(join(ctx.root, p))
      } catch {
        continue
      }
      // A path with a newline cannot be written into an ignore file, so it is snapshotted as usual.
      if (st.isFile() && st.size > this.maxFileBytes && !p.includes('\n')) big.push(p)
    }
    if (big.length === 0) return { skipped: [], excludes: [] }
    for (let i = 0; i < big.length; i += LS_TREE_CHUNK) {
      await this.git(ctx, ['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', ...big.slice(i, i + LS_TREE_CHUNK)])
    }
    const mb = Math.max(1, Math.round(this.maxFileBytes / (1024 * 1024)))
    return {
      skipped: big.map((path) => ({ path, reason: this.maxFileBytes >= 1024 * 1024 ? `larger than ${mb} MB` : `larger than ${this.maxFileBytes} bytes` })),
      excludes: big.map(excludePattern)
    }
  }

  /** Records the folder as it is now: a parentless commit kept alive by `ref`. */
  private async snapshot(ctx: Ctx, label: string, ref: string): Promise<{ sha: string; skipped: SkippedItem[] }> {
    await this.ensureInit(ctx)
    this.writeExclude(ctx, [])
    const { skipped, excludes } = await this.skipOversize(ctx)
    this.writeExclude(ctx, excludes)
    for (const name of SKIP_FOLDERS) {
      try {
        if (lstatSync(join(ctx.root, name)).isDirectory()) skipped.push({ path: `${name}/`, reason: 'dependency or build folder, not checkpointed' })
      } catch {
        // not there
      }
    }
    await this.git(ctx, ['add', '-A'])
    const tree = (await this.gitText(ctx, ['write-tree'])).trim()
    const sha = (await this.gitText(ctx, ['commit-tree', tree, '-m', label])).trim()
    if (!HEX.test(sha)) throw new Error('git did not return a commit id')
    await this.git(ctx, ['update-ref', ref, sha])
    return { sha, skipped }
  }

  private readGarbage(shadowDir: string): number {
    try {
      return parseInt(readFileSync(join(shadowDir, 'garbage.txt'), 'utf8'), 10) || 0
    } catch {
      return 0
    }
  }

  /** Counts snapshots that became unreachable (persisted) and runs `git gc` once enough piled up. */
  private async addGarbage(ctx: Ctx, count: number): Promise<void> {
    if (count <= 0) return
    let total = this.readGarbage(ctx.shadowDir) + count
    if (total >= this.gcAfterDrops) {
      try {
        await this.git(ctx, ['gc', '--prune=now', '-q'])
        total = 0
      } catch (err) {
        this.log('Checkpoint cleanup (git gc) failed', err)
      }
    }
    try {
      writeFileSync(join(ctx.shadowDir, 'garbage.txt'), String(total), 'utf8')
    } catch {
      // the count is only a hint
    }
  }

  /** Deletes every ref of the given steps (start, end and all safety copies). */
  private async dropRefs(ctx: Ctx, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    try {
      const listing = await this.gitText(ctx, ['for-each-ref', '--format=%(refname)', 'refs/regatta/s/'])
      const wanted = new Set(ids)
      const lines = listing
        .split('\n')
        .filter((ref) => wanted.has(ref.split('/')[3] ?? ''))
        .map((ref) => `delete ${ref}\n`)
        .join('')
      if (lines) await this.git(ctx, ['update-ref', '--stdin'], { input: lines })
    } catch (err) {
      this.log('Could not release old checkpoint snapshots', err)
      return
    }
    await this.addGarbage(ctx, ids.length)
  }

  // ---- history on disk ----

  private validateStep(raw: unknown, shadowDir: string, cwdFallback: string): { step: StoredStep } | { reason: string } {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { reason: 'not an object' }
    const r = raw as Record<string, unknown>
    if (typeof r['id'] !== 'string' || !STEP_ID.test(r['id'])) return { reason: 'bad id' }
    if (typeof r['sessionId'] !== 'string' || !r['sessionId']) return { reason: 'bad session id' }
    if (typeof r['agent'] !== 'string') return { reason: 'bad agent' }
    if (typeof r['label'] !== 'string') return { reason: 'bad label' }
    if (typeof r['startedAt'] !== 'number' || !Number.isFinite(r['startedAt'])) return { reason: 'bad start time' }
    if (typeof r['endedAt'] !== 'number' || !Number.isFinite(r['endedAt'])) return { reason: 'bad end time' }
    const failed = typeof r['failed'] === 'string' ? r['failed'] : undefined
    const unprotected = typeof r['unprotected'] === 'string' ? r['unprotected'] : undefined
    for (const key of ['start', 'end'] as const) {
      const value = r[key]
      if (typeof value !== 'string') return { reason: `bad ${key} snapshot` }
      if (value !== '' ? !HEX.test(value) : failed === undefined && unprotected === undefined) return { reason: `bad ${key} snapshot` }
    }
    if (!Array.isArray(r['files'])) return { reason: 'bad file list' }
    const files: StepFile[] = []
    for (const f of r['files']) {
      if (typeof f !== 'object' || f === null) return { reason: 'bad file entry' }
      const e = f as Record<string, unknown>
      if (!isSafeRelativePath(e['path'])) return { reason: `unsafe path ${JSON.stringify(e['path'])}` }
      const added = typeof e['added'] === 'number' && Number.isFinite(e['added']) ? Math.max(0, Math.floor(e['added'])) : 0
      const removed = typeof e['removed'] === 'number' && Number.isFinite(e['removed']) ? Math.max(0, Math.floor(e['removed'])) : 0
      files.push({ path: e['path'], added, removed })
    }
    const cwd = typeof r['cwd'] === 'string' && r['cwd'] ? r['cwd'] : cwdFallback
    if (!cwd || !isAbsolute(cwd)) return { reason: 'bad folder' }
    let rewoundPaths: string[] | undefined
    if (Array.isArray(r['rewoundPaths'])) {
      rewoundPaths = []
      for (const p of r['rewoundPaths']) if (isSafeRelativePath(p)) rewoundPaths.push(p)
    }
    const existedPaths = Array.isArray(r['existedPaths']) ? r['existedPaths'].filter(isSafeRelativePath) : []
    const skipped: SkippedItem[] = []
    if (Array.isArray(r['skipped'])) {
      for (const s of r['skipped'].slice(0, MAX_SKIPPED_RECORDED)) {
        if (typeof s === 'object' && s !== null && typeof (s as SkippedItem).path === 'string' && typeof (s as SkippedItem).reason === 'string') {
          skipped.push({ path: (s as SkippedItem).path, reason: (s as SkippedItem).reason })
        }
      }
    }
    const step: StoredStep = {
      id: r['id'],
      sessionId: r['sessionId'],
      agent: r['agent'] as AgentKind,
      label: r['label'],
      startedAt: r['startedAt'],
      endedAt: r['endedAt'],
      start: r['start'] as string,
      end: r['end'] as string,
      files,
      rolledBack: r['rolledBack'] === true,
      cwd,
      shadowDir
    }
    if (rewoundPaths) step.rewoundPaths = rewoundPaths
    if (existedPaths.length > 0) step.existedPaths = existedPaths
    if (r['shared'] === true) step.shared = true
    if (r['partial'] === true) step.partial = true
    if (r['partialDirection'] === 'rollback' || r['partialDirection'] === 'redo') step.partialDirection = r['partialDirection']
    if (failed !== undefined) step.failed = failed
    if (unprotected !== undefined) step.unprotected = unprotected
    if (typeof r['rootId'] === 'string' && /^\d+:\d+$/.test(r['rootId'])) step.rootId = r['rootId']
    if (typeof r['blockedReason'] === 'string') step.blockedReason = r['blockedReason']
    else if (step.shared) step.blockedReason = SHARED_REASON
    if (skipped.length > 0) step.skipped = skipped
    return { step }
  }

  /** Reads a history file: the parsed array, null if the file is absent, or an Error if it cannot be used. */
  private readHistory(file: string): unknown[] | null | Error {
    if (!existsSync(file)) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed)) return new Error('the file is not a list')
      return parsed
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err))
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const base = this.getBaseDir()
    if (!existsSync(base)) return
    let entries
    try {
      entries = readdirSync(base, { withFileTypes: true })
    } catch (err) {
      this.log(`Could not read the checkpoint storage ${base}`, err)
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const shadowDir = join(base, entry.name)
      let cwdFromTxt = ''
      try {
        cwdFromTxt = readFileSync(join(shadowDir, 'cwd.txt'), 'utf8').trim()
      } catch {
        // no folder recorded
      }
      const stepsFile = join(shadowDir, 'steps.json')
      let items = this.readHistory(stepsFile)
      if (items instanceof Error) {
        this.log(`Checkpoint history ${stepsFile} is unreadable (${items.message}); looking for a backup`)
        try {
          renameSync(stepsFile, `${stepsFile}.corrupt-${Date.now()}`)
        } catch {
          // keep going with the backup
        }
        items = this.readHistory(`${stepsFile}.bak`)
        if (items instanceof Error) {
          this.log(`The backup of ${stepsFile} is unreadable too (${items.message}); that history is lost`)
          items = null
        } else if (items) this.log(`Recovered ${items.length} checkpoint steps from the backup of ${stepsFile}`)
      } else if (items === null && existsSync(`${stepsFile}.bak`)) {
        items = this.readHistory(`${stepsFile}.bak`)
        if (items instanceof Error) items = null
        else if (items) this.log(`${stepsFile} was missing; recovered ${items.length} steps from its backup`)
      }
      for (const item of items ?? []) {
        const checked = this.validateStep(item, shadowDir, cwdFromTxt)
        if ('reason' in checked) {
          this.log(`Dropped an invalid checkpoint record from ${stepsFile} (${checked.reason})`)
          continue
        }
        this.allSteps.set(checked.step.id, checked.step)
      }
      this.reconcileJournal(shadowDir)
    }
  }

  private saveSteps(shadowDir: string): boolean {
    const stepsToSave = [...this.allSteps.values()].filter((s) => s.shadowDir === shadowDir)
    stepsToSave.sort((a, b) => b.endedAt - a.endedAt)
    const stepsFile = join(shadowDir, 'steps.json')
    const tmp = `${stepsFile}.tmp`
    try {
      mkdirSync(shadowDir, { recursive: true })
      const fd = openSync(tmp, 'w')
      try {
        writeSync(fd, JSON.stringify(stepsToSave.slice(0, this.maxSteps), null, 2))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      // Keep the last good file as a backup, but never replace a good backup with a damaged file.
      if (existsSync(stepsFile) && !(this.readHistory(stepsFile) instanceof Error)) {
        try {
          copyFileSync(stepsFile, `${stepsFile}.bak`)
          fsyncFile(`${stepsFile}.bak`)
        } catch (err) {
          this.log(`Could not back up ${stepsFile}`, err)
        }
      }
      renameSync(tmp, stepsFile)
      fsyncDir(shadowDir)
      return true
    } catch (err) {
      this.log(`Could not save the checkpoint history (${stepsFile})`, err)
      try {
        rmSync(tmp, { force: true })
      } catch {
        // nothing more to do
      }
      return false
    }
  }

  /** Drops the oldest steps beyond the limit from memory and releases their snapshots. */
  private async trim(ctx: Ctx): Promise<void> {
    const mine = [...this.allSteps.values()].filter((s) => s.shadowDir === ctx.shadowDir)
    mine.sort((a, b) => b.endedAt - a.endedAt)
    const gone = mine.slice(this.maxSteps)
    // Failed and unprotected records carry no snapshots worth keeping, so only the newest few stay.
    const broken = mine.slice(0, this.maxSteps).filter((s) => s.failed !== undefined || s.unprotected !== undefined)
    gone.push(...broken.slice(this.maxFailedRecords))
    if (gone.length === 0) return
    for (const s of gone) this.allSteps.delete(s.id)
    await this.dropRefs(ctx, gone.map((s) => s.id))
  }

  // ---- step lifecycle ----

  private sessionOp<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.sessionChains.get(sessionId) ?? Promise.resolve()
    const run = prev.then(task, task)
    const tail = run.then(
      () => {},
      () => {}
    )
    this.sessionChains.set(sessionId, tail)
    void tail.then(() => {
      if (this.sessionChains.get(sessionId) === tail) this.sessionChains.delete(sessionId)
    })
    return run
  }

  /** Synchronous: registers a step before any await so overlapping steps always see each other. Never throws. */
  private register(sessionId: string, agent: AgentKind, cwd: string, label: string): Registration {
    const make = (root: string, shadowDir: string, rootId: string, refusal?: CheckpointError): Registration => ({
      id: randomUUID(),
      sessionId,
      agent,
      root,
      label,
      start: null,
      startedAt: Date.now(),
      shadowDir,
      shared: false,
      skipped: [],
      rootId,
      unprotected: refusal ? refusal.message : null,
      refusal
    })
    // The folder is still registered when it can be identified, so restores that could touch what the
    // unprotected agent changes stay blocked until its step ends.
    const track = (reg: Registration): Registration => {
      if (!reg.root) return reg
      for (const other of this.regs) {
        if (other.sessionId !== sessionId && related(other.root, reg.root)) {
          other.shared = true
          reg.shared = true
        }
      }
      this.regs.add(reg)
      return reg
    }
    let root: string
    try {
      root = realpathSync(resolve(cwd))
    } catch (err) {
      return track(make('', '', '', new CheckpointError(`Checkpoints are off: the folder ${resolve(cwd)} cannot be read (${errText(err)})`)))
    }
    let base: string
    try {
      base = this.realBase()
    } catch (err) {
      return track(make(root, '', '', err instanceof CheckpointError ? err : new CheckpointError(errText(err))))
    }
    if (isInside(root, base)) {
      return track(
        make(
          root,
          '',
          '',
          new CheckpointError(
            `Checkpoints are off for ${root}: it contains Regatta's checkpoint storage (${base}). Run the agent in a folder that does not contain it.`
          )
        )
      )
    }
    if (isInside(base, root)) {
      return track(make(root, '', '', new CheckpointError(`Checkpoints are off for ${root}: it is inside Regatta's checkpoint storage (${base}).`)))
    }
    let rootId: string
    try {
      rootId = rootIdOf(root)
    } catch (err) {
      return track(make(root, '', '', new CheckpointError(`Checkpoints are off: the folder ${root} cannot be read (${errText(err)})`)))
    }
    return track(make(root, this.shadowDirFor(base, root), rootId))
  }

  /** Records a step that can never be restored, so the panel can say why. Replaces any earlier record with the same id. */
  private recordBroken(open: Registration, kind: 'failed' | 'unprotected', text: string): void {
    this.ensureLoaded()
    const step: StoredStep = {
      id: open.id,
      sessionId: open.sessionId,
      agent: open.agent,
      label: open.label,
      startedAt: open.startedAt,
      endedAt: Date.now(),
      start: open.start ?? '',
      end: '',
      files: [],
      rolledBack: false,
      cwd: open.root,
      shadowDir: open.shadowDir,
      rootId: open.rootId,
      blockedReason:
        kind === 'failed'
          ? `Regatta could not record the end of this step (${text}), so it cannot be rolled back.`
          : `This turn is not protected: ${text}`
    }
    if (kind === 'failed') step.failed = `Checkpoint end failed: ${text}`
    else step.unprotected = text
    if (open.shared) step.shared = true
    this.allSteps.set(step.id, step)
    this.pruneBroken(open.shadowDir)
    this.saveSteps(open.shadowDir)
    this.deps.emitChanged(open.sessionId)
  }

  /** Keeps only the newest failed and unprotected records, never touching live steps or an unfinished operation. */
  private pruneBroken(shadowDir: string): void {
    const live = new Set([...this.regs].map((r) => r.id))
    const unfinished = this.pendingJournalStep(shadowDir)
    const broken = [...this.allSteps.values()]
      .filter((s) => s.shadowDir === shadowDir && (s.failed !== undefined || s.unprotected !== undefined))
      .sort((a, b) => b.endedAt - a.endedAt)
    const gone = broken.slice(this.maxFailedRecords).filter((s) => !live.has(s.id) && s.id !== unfinished)
    if (gone.length === 0) return
    for (const s of gone) this.allSteps.delete(s.id)
    const sample = gone[0]!
    void this.queueFor(shadowDir)
      .enqueue(async () => {
        if (!existsSync(join(shadowDir, 'git', 'HEAD'))) return
        const ctx = this.ctxFor(sample.cwd, shadowDir, this.realBase())
        await this.dropRefs(ctx, gone.map((s) => s.id))
      })
      .catch((err) => this.log('Could not release the snapshots of old failed records', err))
  }

  /** A session started a step (the agent began working). Resolves once the start snapshot exists. */
  async stepStart(sessionId: string, agent: AgentKind, cwd: string, label: string): Promise<void> {
    const reg = this.register(sessionId, agent, cwd, label)
    return this.sessionOp(sessionId, async () => {
      const prev = this.openSteps.get(sessionId)
      if (prev) {
        try {
          await this.finishOpen(prev)
        } catch {
          // Its failure is already recorded and logged. The new step starts from its own baseline.
        }
      }
      if (reg.refusal) {
        // No snapshot is possible. Say so on screen, and keep the registration until the step ends.
        this.log(`Checkpoints are off for session ${sessionId}`, reg.refusal)
        this.openSteps.set(sessionId, reg)
        this.notices.set(sessionId, { reason: reg.refusal.message, at: Date.now(), agent, label })
        this.deps.emitChanged(sessionId)
        throw reg.refusal
      }
      if (this.notices.delete(sessionId)) this.deps.emitChanged(sessionId)
      try {
        await this.queueFor(reg.shadowDir).enqueue(async () => {
          const ctx = this.ctxFor(reg.root, reg.shadowDir, this.realBase())
          const snap = await this.snapshot(ctx, 'step start', refOf(reg.id, 'start'))
          reg.start = snap.sha
          reg.skipped = snap.skipped
          // Names only, nothing is read: what is here now but not in the snapshot (ignored), so rollback
          // never deletes it as if the step had made it. A wholly ignored folder is listed once as `dir/`.
          const listing = await this.gitText(ctx, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'])
          reg.unrecorded = new Set(listing.split('\0').filter(Boolean))
          reg.startedAt = Date.now()
        })
        this.openSteps.set(sessionId, reg)
      } catch (err) {
        // The agent may already be working, so the folder stays registered (restores that could touch
        // its changes stay blocked) until the step ends, and the step is recorded as unprotected.
        this.log(`Checkpoint start failed for session ${sessionId} (${label})`, err)
        if (!reg.unprotected) reg.unprotected = `the opening snapshot failed (${errText(err)})`
        this.openSteps.set(sessionId, reg)
        this.recordBroken(reg, 'unprotected', reg.unprotected)
        throw err
      }
    })
  }

  /** The session's current step ended. */
  async stepEnd(sessionId: string): Promise<void> {
    return this.sessionOp(sessionId, async () => {
      const open = this.openSteps.get(sessionId)
      if (!open) return
      await this.finishOpen(open)
    })
  }

  /** Changes the label of the session's current step (for example once the real prompt is known). */
  relabelStep(sessionId: string, label: string): void {
    for (const reg of this.regs) if (reg.sessionId === sessionId) reg.label = label
  }

  /**
   * The session let the agent run before the opening snapshot finished. The step is recorded as
   * unprotected (no roll back is offered); the folder stays registered until the step ends.
   */
  markUnprotected(sessionId: string, reason: string): void {
    for (const reg of this.regs) {
      if (reg.sessionId !== sessionId || reg.unprotected) continue
      reg.unprotected = reason
      this.recordBroken(reg, 'unprotected', reason)
    }
  }

  private async withRetries<T>(task: () => Promise<T>, onReplaced: () => void): Promise<T> {
    let last: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await task()
      } catch (err) {
        last = err
        if (err instanceof GitTimeoutError) break
        onReplaced()
        await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)))
      }
    }
    throw last
  }

  private async finishOpen(open: Registration): Promise<void> {
    if (!open.shadowDir) {
      // A step that could not be registered has no snapshots and no record besides the on-screen notice.
      if (this.openSteps.get(open.sessionId) === open) this.openSteps.delete(open.sessionId)
      this.regs.delete(open)
      return
    }
    await this.queueFor(open.shadowDir).enqueue(async () => {
      this.ensureLoaded()
      const ctx = this.ctxFor(open.root, open.shadowDir, this.realBase())
      // Whatever happens below, this step is over: the next one starts from its own new baseline.
      const close = (): void => {
        if (this.openSteps.get(open.sessionId) === open) this.openSteps.delete(open.sessionId)
        this.regs.delete(open)
      }
      if (open.unprotected) {
        close()
        this.recordBroken(open, 'unprotected', open.unprotected)
        await this.dropRefs(ctx, [open.id])
        return
      }
      let endSha: string
      let files: StepFile[]
      let skipped: SkippedItem[]
      let replaced = 0
      try {
        const done = await this.withRetries(
          async () => {
            const snap = await this.snapshot(ctx, 'step end', refOf(open.id, 'end'))
            const diff = await this.gitText(ctx, ['diff', '--numstat', '--no-renames', '-z', open.start!, snap.sha])
            return { snap, files: mergeFiles(parseNumstat(diff)) }
          },
          () => replaced++
        )
        endSha = done.snap.sha
        files = done.files
        skipped = done.snap.skipped
      } catch (err) {
        // The end could not be recorded. Completing it later would absorb whatever the user did in the
        // meantime, so the step stays failed for good.
        close()
        this.log(`Checkpoint end failed for session ${open.sessionId} (${open.label})`, err)
        this.recordBroken(open, 'failed', errText(err))
        await this.addGarbage(ctx, replaced)
        throw err
      }
      close()
      await this.addGarbage(ctx, replaced)
      if (files.length === 0) {
        const hadRecord = this.allSteps.delete(open.id)
        if (hadRecord) this.saveSteps(open.shadowDir)
        await this.dropRefs(ctx, [open.id])
        return
      }
      const seen = new Set<string>()
      const merged = [...open.skipped, ...skipped].filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)))
      const step: StoredStep = {
        id: open.id,
        sessionId: open.sessionId,
        agent: open.agent,
        label: open.label,
        startedAt: open.startedAt,
        endedAt: Date.now(),
        start: open.start!,
        end: endSha,
        files,
        rolledBack: false,
        cwd: open.root,
        shadowDir: open.shadowDir,
        rootId: open.rootId
      }
      if (open.shared) {
        step.shared = true
        step.blockedReason = SHARED_REASON
      }
      if (merged.length > 0) step.skipped = merged.slice(0, MAX_SKIPPED_RECORDED)
      const existed = files.filter((f) => wasUnrecorded(open.unrecorded, f.path)).map((f) => f.path)
      if (existed.length > 0) step.existedPaths = existed
      this.allSteps.set(step.id, step)
      await this.trim(ctx)
      this.saveSteps(open.shadowDir)
      this.deps.emitChanged(open.sessionId)
    })
  }

  list(sessionId: string): CheckpointStep[] {
    this.ensureLoaded()
    const results: CheckpointStep[] = []
    for (const step of this.allSteps.values()) {
      if (step.sessionId !== sessionId) continue
      const item: CheckpointStep = {
        id: step.id,
        sessionId: step.sessionId,
        agent: step.agent,
        label: step.label,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        start: step.start,
        end: step.end,
        files: step.files,
        rolledBack: step.rolledBack
      }
      if (step.shared) item.shared = true
      if (step.blockedReason) item.blockedReason = step.blockedReason
      if (step.failed) item.failed = step.failed
      if (step.unprotected) item.unprotected = step.unprotected
      if (step.partial) item.partial = true
      if (step.partial && step.partialDirection) item.partialDirection = step.partialDirection
      if (step.skipped?.length) item.skipped = step.skipped
      results.push(item)
    }
    const notice = this.notices.get(sessionId)
    if (notice) {
      results.push({
        id: `notice-${sessionId}`,
        sessionId,
        agent: notice.agent,
        label: notice.label,
        startedAt: notice.at,
        endedAt: notice.at,
        start: '',
        end: '',
        files: [],
        rolledBack: false,
        unprotected: notice.reason,
        blockedReason: `This turn is not protected: ${notice.reason}`
      })
    }
    results.sort((a, b) => b.endedAt - a.endedAt)
    return results
  }

  // ---- roll back and redo ----

  async rollback(stepId: string): Promise<RollbackResult> {
    return this.restoreOp(stepId, 'rollback')
  }

  async redo(stepId: string): Promise<RollbackResult> {
    return this.restoreOp(stepId, 'redo')
  }

  private restoreOp(stepId: string, dir: 'rollback' | 'redo'): Promise<RollbackResult> {
    this.ensureLoaded()
    const step = this.allSteps.get(stepId)
    if (!step) return Promise.reject(new Error(`Checkpoint step ${stepId} not found`))
    return this.queueFor(step.shadowDir).enqueue(() => this.restore(step, dir))
  }

  private anyActive(root: string): boolean {
    for (const reg of this.regs) if (related(reg.root, root)) return true
    return false
  }

  /** Symlink-safe path check: every folder above the file and the file itself must be what we expect. */
  private gate(root: string, base: string, rel: string): Gate {
    if (!isSafeRelativePath(rel)) return { ok: false, reason: 'the path is not safe to touch' }
    const abs = join(root, ...rel.split('/'))
    if (isInside(base, abs)) return { ok: false, reason: "the path is inside Regatta's checkpoint storage" }
    const parts = rel.split('/')
    let dir = root
    for (let i = 0; i < parts.length - 1; i++) {
      dir = join(dir, parts[i]!)
      let st: Stats
      try {
        st = lstatSync(dir)
      } catch (err) {
        if (errCode(err) === 'ENOENT') return { ok: true, abs, st: null }
        return { ok: false, operational: true, reason: `a parent folder cannot be read (${errCode(err) ?? errText(err)})` }
      }
      if (st.isSymbolicLink()) return { ok: false, reason: 'a parent folder is now a symbolic link' }
      if (!st.isDirectory()) return { ok: false, reason: 'a parent of this path is no longer a folder' }
      // A folder that became its own git repository since the checkpoint is not ours to change.
      let nested = true
      try {
        lstatSync(join(dir, '.git'))
      } catch (err) {
        if (errCode(err) === 'ENOENT') nested = false
        else return { ok: false, operational: true, reason: `a parent folder cannot be read (${errCode(err) ?? errText(err)})` }
      }
      if (nested) return { ok: false, reason: 'a parent folder is now a nested git repository' }
    }
    try {
      return { ok: true, abs, st: lstatSync(abs) }
    } catch (err) {
      if (errCode(err) === 'ENOENT') return { ok: true, abs, st: null }
      return { ok: false, operational: true, reason: `the file cannot be read (${errCode(err) ?? errText(err)})` }
    }
  }

  /** What is on disk at this path now, by git hash (no filters), never following symlinks. */
  private async describeCurrent(ctx: Ctx, g: Extract<Gate, { ok: true }>): Promise<Current> {
    const st = g.st
    if (!st) return { kind: 'absent' }
    if (st.isDirectory()) return { kind: 'dir' }
    let oid: string
    if (st.isSymbolicLink()) {
      const target = readlinkSync(g.abs, { encoding: 'buffer' })
      oid = (await this.gitText(ctx, ['hash-object', '--stdin'], { input: target })).trim()
    } else if (st.isFile()) {
      oid = (await this.gitText(ctx, ['hash-object', '--no-filters', '--', g.abs])).trim()
    } else return { kind: 'other' }
    const after = lstatSync(g.abs)
    if (sigOf(after) !== sigOf(st)) throw new ChangedWhileReading('the file changed while Regatta was reading it')
    if (st.isSymbolicLink()) return { kind: 'symlink', oid, sig: sigOf(st) }
    return { kind: 'file', oid, exec: (st.mode & 0o100) !== 0, sig: sigOf(st), mode: st.mode & 0o7777, size: st.size }
  }

  /** One `git ls-tree` per chunk of paths. Absence is only reported when the command succeeded. */
  private async lookupTree(ctx: Ctx, sha: string, paths: string[]): Promise<Map<string, TreeEntry>> {
    if (!HEX.test(sha)) throw new Error('the step has no usable snapshot')
    const result = new Map<string, TreeEntry>()
    const prefixes = new Set<string>()
    for (let i = 0; i < paths.length; i += LS_TREE_CHUNK) {
      const chunk = paths.slice(i, i + LS_TREE_CHUNK)
      const listing = await this.gitText(ctx, ['ls-tree', '-r', '-z', '-l', sha, '--', ...chunk])
      for (const rec of listing.split('\0')) {
        if (!rec) continue
        const m = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t([\s\S]*)$/.exec(rec)
        if (!m) throw new Error('could not read the snapshot listing')
        const [, mode, type, oid, size, path] = m as unknown as [string, string, string, string, string, string]
        if (chunk.includes(path)) {
          if (mode === '160000' || type === 'commit') result.set(path, { kind: 'gitlink' })
          else if (mode === '120000') result.set(path, { kind: 'symlink', oid, size: Number(size) })
          else if (type === 'blob') result.set(path, { kind: 'file', oid, exec: mode === '100755', size: Number(size) })
          else throw new Error(`unexpected entry type ${type}`)
        } else {
          // Something lives below one of the asked paths: that path is a folder in this snapshot.
          for (const asked of chunk) if (path.startsWith(`${asked}/`)) prefixes.add(asked)
        }
      }
    }
    for (const p of paths) {
      if (result.has(p)) continue
      result.set(p, prefixes.has(p) ? { kind: 'dir' } : { kind: 'absent' })
    }
    return result
  }

  private async extractBlob(ctx: Ctx, oid: string, size: number, dest: string): Promise<void> {
    const fd = openSync(dest, 'w', 0o600)
    try {
      await this.git(ctx, ['cat-file', 'blob', oid], { outFd: fd })
    } finally {
      closeSync(fd)
    }
    if (statSync(dest).size !== size) throw new Error(`the saved copy of a file is incomplete (blob ${oid.slice(0, 8)})`)
    const check = (await this.gitText(ctx, ['hash-object', '--no-filters', '--', dest])).trim()
    if (check !== oid) throw new Error(`the saved copy of a file is damaged (blob ${oid.slice(0, 8)})`)
  }

  /** The last check, run synchronously right before a write or delete: root, every parent, and the file itself. */
  private lastCheck(ctx: Ctx, rel: string, cur: Current): string | null {
    if (ctx.rootId) {
      let same: boolean
      try {
        same = rootIdOf(ctx.root) === ctx.rootId
      } catch (err) {
        // A disk error is not a conflict: it makes the operation partial, and Retry can finish it.
        throw new Error(`the project folder cannot be read (${errCode(err) ?? errText(err)})`)
      }
      if (!same) return 'not touched: the project folder is not the one this step was recorded in'
    }
    const g = this.gate(ctx.root, ctx.base, rel)
    if (!g.ok) {
      if (g.operational) throw new Error(g.reason)
      return `not touched: ${g.reason}`
    }
    if (cur.kind === 'absent') return g.st === null ? null : 'you edited it since'
    if (g.st === null || !('sig' in cur) || sigOf(g.st) !== cur.sig) return 'you edited it since'
    const attributes = attributeProblem(g.abs, cur.kind === 'symlink')
    if (attributes) return attributes
    // Small files are hashed once more right here, so same-length edits cannot slip through.
    if (cur.kind === 'file' && cur.size < REHASH_LIMIT) {
      let bytes: Buffer
      try {
        bytes = readFileSync(g.abs)
      } catch (err) {
        if (errCode(err) === 'ENOENT') return 'you edited it since'
        throw new Error(`the file cannot be read (${errCode(err) ?? errText(err)})`)
      }
      if (blobOid(bytes) !== cur.oid) return 'you edited it since'
    }
    return null
  }

  /** Refuses a file that some program has open for writing; throws when that cannot be checked. */
  private async openForWriting(abs: string): Promise<boolean> {
    return (await writersOf([abs])).has(abs)
  }

  /**
   * Puts `item.to` in place of the current file, after re-checking that the file is still what we planned for.
   * Returns a conflict (the user's file is kept) or throws on an operational failure.
   */
  private async applyOne(ctx: Ctx, item: PlanItem): Promise<'applied' | { kept: string }> {
    const g = this.gate(ctx.root, ctx.base, item.file.path)
    if (!g.ok) {
      if (g.operational) throw new Error(g.reason)
      return { kept: `not touched: ${g.reason}` }
    }
    let cur: Current
    try {
      cur = await this.describeCurrent(ctx, g)
    } catch (err) {
      if (err instanceof ChangedWhileReading) return { kept: 'you edited it since' }
      throw err
    }
    if (!entryMatches(cur, item.from)) return { kept: 'you edited it since' }

    const to = item.to
    if (to.kind === 'absent') {
      if (cur.kind === 'absent') return 'applied'
      if (cur.kind === 'file' && (await this.openForWriting(g.abs))) return { kept: OPEN_WRITER }
      const why = this.lastCheck(ctx, item.file.path, cur)
      if (why) return { kept: why }
      unlinkSync(g.abs)
      return 'applied'
    }
    if (to.kind !== 'file' && to.kind !== 'symlink') return { kept: 'not touched: this is a folder or nested repository' }
    if (!item.extracted) throw new Error('no saved copy to restore from')

    // Make missing parent folders one level at a time, checking each is a real folder.
    const parts = item.file.path.split('/')
    let dir = ctx.root
    for (let i = 0; i < parts.length - 1; i++) {
      dir = join(dir, parts[i]!)
      let st: Stats | null = null
      try {
        st = lstatSync(dir)
      } catch (err) {
        if (errCode(err) !== 'ENOENT') throw err
      }
      if (!st) {
        mkdirSync(dir)
        st = lstatSync(dir)
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return { kept: 'not touched: a parent folder changed' }
    }

    if (to.kind === 'symlink') {
      // The target is raw bytes: never decode it.
      const target = readFileSync(item.extracted)
      if (cur.kind === 'absent') {
        const why = this.lastCheck(ctx, item.file.path, cur)
        if (why) return { kept: why }
        try {
          symlinkSync(target as unknown as string, g.abs)
        } catch (err) {
          if (errCode(err) === 'EEXIST') return { kept: 'you edited it since' }
          throw err
        }
        return 'applied'
      }
      const tmp = join(dirname(g.abs), `.regatta-${randomBytes(6).toString('hex')}.tmp`)
      symlinkSync(target as unknown as string, tmp)
      try {
        if (cur.kind === 'file' && (await this.openForWriting(g.abs))) return { kept: OPEN_WRITER }
        const why = this.lastCheck(ctx, item.file.path, cur)
        if (why) return { kept: why }
        renameSync(tmp, g.abs)
      } finally {
        rmSync(tmp, { force: true })
      }
      return 'applied'
    }

    // A regular file: keep the permissions of the file being replaced, change only the executable bits.
    let mode = to.exec ? 0o755 : 0o644
    if (cur.kind === 'file') {
      mode = cur.mode
      mode = to.exec ? mode | ((mode & 0o444) >> 2) : mode & ~0o111
    }
    const tmp = join(dirname(g.abs), `.regatta-${randomBytes(6).toString('hex')}.tmp`)
    copyFileSync(item.extracted, tmp, fsConstants.COPYFILE_EXCL)
    try {
      if (EXEC_BITS_SUPPORTED) chmodSync(tmp, mode)
      if (cur.kind === 'file' && (await this.openForWriting(g.abs))) return { kept: OPEN_WRITER }
      const why = this.lastCheck(ctx, item.file.path, cur)
      if (why) return { kept: why }
      if (cur.kind === 'absent') {
        // A hard link is the only way to create the file complete and without ever replacing another one.
        try {
          linkSync(tmp, g.abs)
        } catch (err) {
          const code = errCode(err)
          if (code === 'EEXIST') return { kept: 'you edited it since' }
          if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS' || code === 'EXDEV' || code === 'EMLINK') {
            return { kept: NO_HARD_LINKS }
          }
          throw err
        }
      } else renameSync(tmp, g.abs)
    } finally {
      rmSync(tmp, { force: true })
    }
    return 'applied'
  }

  // ---- the operation journal ----

  private journalPath(shadowDir: string): string {
    return join(shadowDir, 'op.json')
  }

  /** Writes the intent of a roll back or redo to disk before anything is touched. Throws on failure. */
  private writeJournal(shadowDir: string, journal: Journal): void {
    const file = this.journalPath(shadowDir)
    const tmp = `${file}.tmp`
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, JSON.stringify(journal))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
    fsyncDir(shadowDir)
  }

  private pendingJournalStep(shadowDir: string): string | null {
    try {
      const raw = JSON.parse(readFileSync(this.journalPath(shadowDir), 'utf8')) as { stepId?: unknown }
      return typeof raw.stepId === 'string' ? raw.stepId : null
    } catch {
      return null
    }
  }

  private clearJournal(shadowDir: string): void {
    try {
      rmSync(this.journalPath(shadowDir), { force: true })
      fsyncDir(shadowDir)
    } catch (err) {
      this.log('Could not remove the finished operation record', err)
    }
  }

  /** After a crash (or a failed history save) an unfinished roll back or redo is made redoable from its journal. */
  private reconcileJournal(shadowDir: string): void {
    const file = this.journalPath(shadowDir)
    if (!existsSync(file)) return
    let journal: Journal
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Journal>
      if ((raw.kind !== 'rollback' && raw.kind !== 'redo') || typeof raw.stepId !== 'string' || !Array.isArray(raw.paths)) throw new Error('bad shape')
      journal = {
        v: 1,
        kind: raw.kind,
        stepId: raw.stepId,
        opId: String(raw.opId ?? ''),
        paths: raw.paths.filter(isSafeRelativePath),
        rewoundBefore: Array.isArray(raw.rewoundBefore) ? raw.rewoundBefore.filter(isSafeRelativePath) : [],
        pre: String(raw.pre ?? ''),
        startedAt: Number(raw.startedAt) || 0
      }
    } catch (err) {
      this.log(`The operation record ${file} is unreadable`, err)
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`)
      } catch {
        // leave it
      }
      return
    }
    const step = this.allSteps.get(journal.stepId)
    if (step && step.shadowDir === shadowDir) {
      this.log(`Recovering an unfinished ${journal.kind} of "${step.label}" (${journal.paths.length} files)`)
      step.rolledBack = true
      step.partial = true
      step.partialDirection = journal.kind
      step.rewoundPaths = journal.kind === 'rollback' ? [...new Set([...(step.rewoundPaths ?? []), ...journal.paths])] : journal.rewoundBefore
      if (!this.saveSteps(shadowDir)) return
    }
    this.clearJournal(shadowDir)
  }

  private async restore(step: StoredStep, dir: 'rollback' | 'redo'): Promise<RollbackResult> {
    const verb = dir === 'rollback' ? 'rewound' : 'restored'
    const refuse = (reason: string): RollbackResult => ({
      stepId: step.id,
      files: step.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, action: 'kept' as const, note: reason })),
      verified: false,
      summary: reason,
      refused: reason,
      direction: dir
    })
    const rewound = new Set(step.rewoundPaths ?? [])
    const existed = new Set(step.existedPaths ?? [])

    if (step.failed || step.unprotected) return refuse(step.blockedReason ?? step.failed ?? step.unprotected ?? 'This step cannot be restored.')
    if (step.shared) return refuse(step.blockedReason ?? SHARED_REASON)
    if (!step.rootId) {
      return refuse('This step was recorded by an older version of Regatta, which did not save the identity of the project folder, so it cannot be restored safely.')
    }
    if (dir === 'rollback' && step.rolledBack && !step.partial) {
      return {
        stepId: step.id,
        files: step.files.map((f) => ({
          path: f.path,
          added: f.added,
          removed: f.removed,
          action: rewound.has(f.path) ? ('rewound' as const) : ('kept' as const),
          note: rewound.has(f.path) ? '' : 'you edited it since'
        })),
        verified: false,
        summary: 'Already rolled back. Nothing changed.',
        refused: 'Already rolled back. Nothing changed.',
        direction: dir
      }
    }
    if (dir === 'redo' && !step.rolledBack) {
      return {
        stepId: step.id,
        files: step.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, action: 'kept' as const, note: 'not rolled back' })),
        verified: false,
        summary: 'This step is not rolled back. Nothing to redo.',
        refused: 'This step is not rolled back. Nothing to redo.',
        direction: dir
      }
    }

    // One operation record per folder: an earlier operation whose history could not be saved must be
    // recovered (on the next start) before another step is changed.
    const earlier = this.pendingJournalStep(step.shadowDir)
    if (earlier && earlier !== step.id) {
      return refuse('An earlier roll back or redo in this folder is not recorded yet. Restart Regatta to recover it, then try again.')
    }

    let root: string
    let base: string
    try {
      root = realpathSync(step.cwd)
      base = this.realBase()
      if (step.rootId && (root !== step.cwd || rootIdOf(root) !== step.rootId)) {
        return refuse('Nothing was changed: the project folder is not the one this step was recorded in (it was moved, replaced or is now a link).')
      }
    } catch (err) {
      return refuse(`Nothing was changed: the folder ${step.cwd} cannot be read (${errText(err)}).`)
    }
    if (isInside(base, root)) return refuse("Nothing was changed: this folder is inside Regatta's checkpoint storage.")
    if (this.anyActive(root)) return refuse(ACTIVE_REASON)

    const ctx = this.ctxFor(root, step.shadowDir, base)
    ctx.rootId = step.rootId
    const fromSha = dir === 'rollback' ? step.end : step.start
    const toSha = dir === 'rollback' ? step.start : step.end
    const outcome = new Map<string, RollbackFile>()
    const note = (f: StepFile, action: RollbackFile['action'], text: string, error = false): void => {
      const entry: RollbackFile = { path: f.path, added: f.added, removed: f.removed, action, note: text }
      if (error) entry.error = true
      outcome.set(f.path, entry)
    }

    // Which files this request may touch.
    const candidates: StepFile[] = []
    for (const f of step.files) {
      if (dir === 'rollback' || !step.rewoundPaths || rewound.has(f.path)) candidates.push(f)
      // After a partly finished redo, the files that are not listed any more were already restored.
      else if (step.partial && step.partialDirection === 'redo') note(f, 'restored', '')
      else note(f, 'kept', 'you edited it since')
    }

    // Leftovers of an interrupted roll back live here; restores are serialized per folder, so none is running.
    rmSync(join(step.shadowDir, 'tmp'), { recursive: true, force: true })
    const opId = randomBytes(6).toString('hex')
    const tmpDir = join(step.shadowDir, 'tmp', opId)
    let eligible: PlanItem[] = []
    // Files kept only because a program has them open: the step stays retryable for them.
    const busy = new Set<string>()
    try {
      // ---- plan: lookups only, nothing is written ----
      let fromTree: Map<string, TreeEntry>
      let toTree: Map<string, TreeEntry>
      try {
        const paths = candidates.map((f) => f.path)
        fromTree = await this.lookupTree(ctx, fromSha, paths)
        toTree = await this.lookupTree(ctx, toSha, paths)
      } catch (err) {
        return refuse(`Nothing was changed: Regatta could not read this checkpoint (${errText(err)}).`)
      }
      mkdirSync(tmpDir, { recursive: true })
      let n = 0
      for (const f of candidates) {
        const from = fromTree.get(f.path)!
        const to = toTree.get(f.path)!
        if (from.kind === 'dir' || from.kind === 'gitlink' || to.kind === 'dir' || to.kind === 'gitlink') {
          note(f, 'kept', 'not touched: this is a folder or a nested git repository')
          continue
        }
        const g = this.gate(root, base, f.path)
        if (!g.ok) {
          // A disk error is not the user's doing: stop before anything is changed.
          if (g.operational) return refuse(`Nothing was changed: ${f.path}: ${g.reason}.`)
          note(f, 'kept', `not touched: ${g.reason}`)
          continue
        }
        let cur: Current
        try {
          cur = await this.describeCurrent(ctx, g)
        } catch (err) {
          if (err instanceof ChangedWhileReading) {
            note(f, 'kept', 'you edited it since')
            continue
          }
          // A git or disk failure is not a user edit: stop before anything is changed.
          return refuse(`Nothing was changed: Regatta could not check ${f.path} (${errText(err)}).`)
        }
        if (step.partial && entryMatches(cur, to) && !entryMatches(cur, from)) {
          note(f, verb, '')
          continue
        }
        if (cur.kind === 'dir') {
          note(f, 'kept', 'not touched: a folder is in the way')
          continue
        }
        if (cur.kind === 'other') {
          note(f, 'kept', 'not touched: this is not a regular file')
          continue
        }
        if (!entryMatches(cur, from)) {
          note(f, 'kept', 'you edited it since')
          continue
        }
        if (cur.kind === 'file' || cur.kind === 'symlink') {
          const attributes = attributeProblem(g.abs, cur.kind === 'symlink')
          if (attributes) {
            note(f, 'kept', attributes)
            continue
          }
        }
        // Missing from the start snapshot does not prove a file is the step's: one an ignore rule kept out
        // of it (a rule the step then removed) was already here, so it is never deleted.
        if (dir === 'rollback' && to.kind === 'absent' && existed.has(f.path)) {
          note(f, 'kept', 'not touched: it was here before this step began')
          continue
        }
        const item: PlanItem = { file: f, from, to, cur }
        if (to.kind === 'file' || to.kind === 'symlink') {
          item.extracted = join(tmpDir, String(n++))
          try {
            await this.extractBlob(ctx, to.oid, to.size, item.extracted)
          } catch (err) {
            return refuse(`Nothing was changed: Regatta could not read the saved copy of ${f.path} (${errText(err)}).`)
          }
        }
        eligible.push(item)
      }

      // ---- programs that have a file open for writing would lose what they write into the replaced file ----
      const existing = eligible.filter((i) => i.cur.kind === 'file').map((i) => join(root, ...i.file.path.split('/')))
      if (existing.length > 0) {
        let writers: Set<string>
        try {
          writers = await writersOf(existing)
        } catch (err) {
          return refuse(`Nothing was changed: Regatta could not check which programs have these files open (${errText(err)}).`)
        }
        if (writers.size > 0) {
          for (const item of eligible) {
            if (writers.has(join(root, ...item.file.path.split('/')))) {
              note(item.file, 'kept', OPEN_WRITER)
              busy.add(item.file.path)
            }
          }
          eligible = eligible.filter((i) => !writers.has(join(root, ...i.file.path.split('/'))))
        }
      }

      // ---- a pinned safety copy of everything about to be overwritten, and a durable record of the intent ----
      if (eligible.length > 0) {
        let pre: string
        try {
          pre = (await this.snapshot(ctx, dir === 'rollback' ? 'before roll back' : 'before redo', refOf(step.id, `${dir === 'rollback' ? 'pre' : 'pre-redo'}-${opId}`))).sha
        } catch (err) {
          return refuse(`Nothing was changed: Regatta could not save a safety copy first (${errText(err)}).`)
        }
        if (this.anyActive(root)) return refuse(ACTIVE_REASON)
        try {
          this.writeJournal(step.shadowDir, {
            v: 1,
            kind: dir,
            stepId: step.id,
            opId,
            paths: eligible.map((i) => i.file.path),
            rewoundBefore: [...rewound],
            pre,
            startedAt: Date.now()
          })
        } catch (err) {
          return refuse(`Nothing was changed: Regatta could not record this operation first (${errText(err)}).`)
        }
      }

      // ---- apply: each file is re-checked right before it is written ----
      let failed = 0
      const applied: PlanItem[] = []
      const failedPaths = new Set<string>()
      for (const item of eligible) {
        try {
          const res = await this.applyOne(ctx, item)
          if (res === 'applied') {
            applied.push(item)
            note(item.file, verb, '')
          } else {
            note(item.file, 'kept', res.kept)
            if (res.kept === OPEN_WRITER) busy.add(item.file.path)
          }
        } catch (err) {
          failed++
          failedPaths.add(item.file.path)
          note(item.file, 'kept', `could not be written: ${errText(err).replace(root, '.')}`, true)
        }
      }

      // ---- read every written file back; a file that cannot be confirmed leaves the operation retryable ----
      const unverified = new Set<string>()
      for (const item of applied) {
        try {
          const g = this.gate(root, base, item.file.path)
          if (!g.ok || !entryMatches(await this.describeCurrent(ctx, g), item.to)) unverified.add(item.file.path)
        } catch {
          unverified.add(item.file.path)
        }
      }
      for (const path of unverified) {
        const f = outcome.get(path)
        if (f) f.note = 'written, but could not be read back to confirm'
      }

      // ---- bookkeeping ----
      const partialNow = failed > 0 || unverified.size > 0 || busy.size > 0
      const doneNow = step.files.filter((f) => outcome.get(f.path)?.action === verb).map((f) => f.path)
      if (dir === 'rollback') {
        if (doneNow.length > 0) {
          step.rolledBack = true
          step.rewoundPaths = doneNow
          if (partialNow) {
            step.partial = true
            step.partialDirection = 'rollback'
          } else {
            delete step.partial
            delete step.partialDirection
          }
        } else {
          step.rolledBack = false
          delete step.rewoundPaths
          // Nothing was applied, but a failure that Retry can fix must stay visible, with its direction.
          if (partialNow) {
            step.partial = true
            step.partialDirection = 'rollback'
          } else {
            delete step.partial
            delete step.partialDirection
          }
        }
      } else if (partialNow) {
        step.rolledBack = true
        step.partial = true
        step.partialDirection = 'redo'
        step.rewoundPaths = [...new Set([...failedPaths, ...unverified, ...busy])]
      } else {
        step.rolledBack = false
        delete step.partial
        delete step.partialDirection
        delete step.rewoundPaths
      }
      const saved = this.saveSteps(step.shadowDir)
      if (saved) this.clearJournal(step.shadowDir)
      this.deps.emitChanged(step.sessionId)

      const results = step.files.map((f) => outcome.get(f.path)!).filter(Boolean)
      const affected = results.filter((f) => f.action === verb)
      const added = affected.reduce((sum, f) => sum + f.added, 0)
      const removed = affected.reduce((sum, f) => sum + f.removed, 0)
      const head = dir === 'rollback' ? 'Rewound' : 'Restored'
      let summary = `${head} ${affected.length} of ${results.length} files +${added} -${removed}`
      if (failed > 0) summary += ` (${failed} could not be written; use Retry)`
      if (unverified.size > 0) summary += ` (${unverified.size} could not be confirmed; use Retry)`
      if (busy.size > 0) summary += ` (${busy.size} open in a program; close it, then use Retry)`
      if (!saved) summary += ' (the history could not be saved; Regatta will recover it on the next start)'
      return { stepId: step.id, files: results, verified: !partialNow && saved, summary, direction: dir }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }
}
