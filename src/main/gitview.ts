// Git panel operations: overview, diff, stage, unstage, commit, log, worktrees.
//
// This works on the user's own repository, so the rules in docs/design/safety.md apply: git runs
// only as an argument list (never a shell), every call takes paths literally, nothing here discards
// or moves work, and when something cannot be checked the operation refuses.
//
// Paths: every path this module accepts or returns is relative to `cwd` (the folder the panel was
// opened on), which may be a subfolder of the repository. `git status` reports paths relative to the
// repository top, so they are converted once, in readStatus, and everything else uses that one
// namespace.

import { spawn } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import { withoutRepoRouting } from './env'
import type {
  GitOverview,
  GitDiff,
  GitCommit,
  GitWorktree,
  GitFileChange
} from '../shared/types'

const TIMEOUT_MS = 15_000
const COMMIT_TIMEOUT_MS = 60_000
const MAX_DIFF_SIZE = 1_000_000
/** How much of a file is looked at for a NUL byte, as git does. */
const BINARY_SNIFF_BYTES = 8 * 1024
/** Largest output of any git call that is not a diff. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
/** Output kept of a hook or commit run, for the error line. */
const MAX_ERROR_BYTES = 64 * 1024
/** How long git gets to leave after SIGTERM before it is killed. */
const STOP_GRACE_MS = 2000
/** How long output may keep arriving after git exited. */
const PIPE_GRACE_MS = 300
/** How long a process group may survive SIGKILL before the call gives up on it. */
const GIVE_UP_MS = 3000

const STUCK_NOTE = ', but a process it started could not be stopped'
export const STAGED_CHANGED = 'The staged files changed. Check them and try again.'
const OUTSIDE_STAGED = 'Files outside this folder are staged. Commit them from a terminal, or unstage them first.'

// ---------------------------------------------------------------------------------------------
// Running git

/**
 * The environment for a git call: the user's own, minus variables that would aim git elsewhere.
 * GIT_NO_LAZY_FETCH keeps a partial clone from contacting its remote to fill in a missing object
 * (git 2.49 and later; older git ignores it): the panel never talks to a remote, and that fetch would
 * run the user's uploadpack program, credential helper and ssh command. `english` is for the one
 * place whose output is matched against git's own words.
 */
export function gitEnv(english = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = withoutRepoRouting({ ...process.env })
  env['GIT_TERMINAL_PROMPT'] = '0'
  env['GIT_NO_REPLACE_OBJECTS'] = '1'
  env['GIT_NO_LAZY_FETCH'] = '1'
  // Older git (2.45 was seen) fetches missing objects in bulk without looking at GIT_NO_LAZY_FETCH.
  // An empty allow list denies every transport: file, ssh, and remote helpers, whatever the
  // repository's configuration says. The panel never needs one.
  env['GIT_ALLOW_PROTOCOL'] = ''
  if (english) env['LC_ALL'] = 'C'
  return env
}

// A folder with nothing in it, given to git as core.hooksPath for every call except the hook check.
// The panel refuses whenever a hook exists, so no hook that existed is ever skipped; this only keeps
// git from running a hook file that appears while its own command is running (a slow filter or
// a long status gives plenty of time for that).
let configuredHooksSandbox: string | null = null

/** Sets the folder used as the panel's empty hooks folder (the app's data folder is the right place). */
export function setHooksSandbox(dir: string | null): void {
  configuredHooksSandbox = dir
}

function hooksSandbox(): string {
  const dir =
    configuredHooksSandbox ?? join(process.env['REGATTA_USER_DATA'] || join(homedir(), '.regatta'), 'git-empty-hooks')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const info = lstatSync(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Regatta's empty git hooks folder is not a folder.")
  // Finder writes a .DS_Store into a folder that was ever opened; that alone is not a reason to refuse.
  if (readdirSync(dir).some((name) => name !== '.DS_Store')) throw new Error("Regatta's empty git hooks folder is not empty, so git was not run.")
  return dir
}

/**
 * Global options for every call: file names are literal (a file called `*.txt` is not a pattern),
 * reading never takes the index lock (so the panel's polling cannot collide with the user's git),
 * fsmonitor is off (a configured `core.fsmonitor` program is a hook git runs on every status; it only
 * makes git faster, so turning it off bypasses nothing), diffs do not refresh and write the index, and
 * no hook directory is consulted. Given with -c they also reach the git processes git starts itself,
 * such as a submodule's. `sandbox` is false only for the check that looks for hooks.
 */
function withGlobals(args: string[], sandbox = true): string[] {
  return [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'diff.autoRefreshIndex=false',
    // git commit starts a detached `git maintenance run --auto` that re-reads the configuration and
    // could run a hook added meanwhile. The next git command in a terminal does the maintenance.
    '-c',
    'maintenance.auto=false',
    '-c',
    'gc.auto=0',
    ...(sandbox ? ['-c', `core.hooksPath=${hooksSandbox()}`] : []),
    '--literal-pathspecs',
    '--no-optional-locks',
    ...args
  ]
}

interface RunResult {
  stdout: Buffer
  stderr: string
  code: number | null
  /** The output passed `maxBytes` and git was stopped. */
  truncated: boolean
  timedOut: boolean
  /** Git was stopped but a process of its group could not be confirmed gone. */
  stuck?: boolean
}

interface RunOptions {
  timeout?: number
  maxBytes?: number
  /** Look at the real hook folders (only the hook check does). */
  realHooks?: boolean
}

function run(args: string[], cwd: string, opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((done) => {
    const maxBytes = opts.maxBytes ?? MAX_OUTPUT_BYTES
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let argv: string[]
    try {
      argv = withGlobals(args, !opts.realHooks)
    } catch (err) {
      done({ stdout: Buffer.alloc(0), stderr: (err as Error).message, code: null, truncated: false, timedOut: false })
      return
    }
    // Its own process group, so a timeout reaches what git started (a clean filter, a textconv
    // program) and not only git. Those only read the work tree.
    const child = spawn('git', argv, { cwd, env: gitEnv(opts.realHooks), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const pid = child.pid
    const groupAlive = (): boolean => {
      if (!pid) return false
      try {
        process.kill(-pid, 0)
        return true
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    const signal = (sig: NodeJS.Signals): void => {
      try {
        if (pid) process.kill(-pid, sig)
        else child.kill(sig)
      } catch {
        // Already gone.
      }
    }
    let exited = false
    let exitCode: number | null = null
    let stopping = false
    let stuck = false
    let poll: NodeJS.Timeout | null = null
    const timers: NodeJS.Timeout[] = []
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const t of timers) clearTimeout(t)
      if (poll) clearInterval(poll)
      done({ stdout: Buffer.concat(chunks), stderr, code, truncated, timedOut, ...(stuck ? { stuck } : {}) })
    }
    const closePipes = (): void => {
      child.stdout.destroy()
      child.stderr.destroy()
    }
    // SIGTERM to the group so git can remove its index.lock, SIGKILL if anything is left after the
    // grace period, and the call returns only when the whole group is gone (or cannot be made to go).
    const stop = (): void => {
      if (stopping) return
      stopping = true
      signal('SIGTERM')
      timers.push(
        setTimeout(() => {
          if (groupAlive()) signal('SIGKILL')
          timers.push(
            setTimeout(() => {
              stuck = groupAlive()
              closePipes()
              finish(exitCode)
            }, GIVE_UP_MS)
          )
        }, STOP_GRACE_MS)
      )
      poll = setInterval(() => {
        if (exited && !groupAlive()) {
          closePipes()
          finish(exitCode)
        }
      }, 25)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, opts.timeout ?? TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      chunks.push(chunk)
      size += chunk.length
      if (size > maxBytes) {
        truncated = true
        stop()
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_ERROR_BYTES) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      stderr += err.message
      finish(null)
    })
    // While git is being stopped the call waits for the group, not for the pipes.
    child.on('close', (code) => {
      if (!stopping) finish(code)
    })
    child.on('exit', (code) => {
      exited = true
      exitCode = code
      if (stopping) return
      // A process git left behind can hold the output pipes open for as long as it likes. Once git
      // itself has exited, its remaining output gets a moment to arrive and then the pipes are closed.
      timers.push(
        setTimeout(() => {
          if (settled || stopping) return
          closePipes()
          finish(code)
        }, PIPE_GRACE_MS)
      )
    })
  })
}

/** The line to show for an error: a fatal one if there is one, else an error, else the first line. */
function firstLine(text: string): string | undefined {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  return (
    lines.find((line) => line.startsWith('fatal:')) ??
    lines.find((line) => line.startsWith('error:')) ??
    lines.find((line) => !line.startsWith('warning:')) ??
    lines[0]
  )
}

/** The error to show for a failed git call; a missing object in a partial clone gets a plain explanation. */
export function errorLine(stderr: string): string | undefined {
  if (/could not fetch .* from promisor remote|lazy fetching disabled/.test(stderr)) {
    return 'Some files of this partial clone are not downloaded yet. The Git panel does not contact a remote, so fetch them from a terminal.'
  }
  return firstLine(stderr)
}

/**
 * The error for a git that never gave its own answer: it was stopped (with the stuck note when a
 * process of its group could not be confirmed gone), or it printed more than the limit. Null when
 * the result is git's own and can be read by exit code.
 */
function stoppedError(args: string[], result: RunResult): Error | null {
  if (result.timedOut || result.stuck) return new Error(`git ${args[0]} took too long and was stopped${result.stuck ? STUCK_NOTE : ''}`)
  if (result.truncated) return new Error(`git ${args[0]} printed too much output`)
  return null
}

async function git(args: string[], cwd: string, timeout = TIMEOUT_MS): Promise<string> {
  const result = await run(args, cwd, { timeout })
  const stopped = stoppedError(args, result)
  if (stopped) throw stopped
  if (result.code !== 0) throw new Error(errorLine(result.stderr) ?? `git ${args[0]} failed`)
  return result.stdout.toString('utf8')
}

/**
 * Runs git for an answer that may be "no": null only when git ran to completion and exited non-zero
 * (not a repository, no such branch, no upstream). A git that never answered is not a "no": one that
 * was stopped, overflowed or could not even start is rethrown, so a process group that is still
 * alive is never mistaken for a plain negative (the removal engines must keep whatever it touches).
 */
async function tryGit(args: string[], cwd: string): Promise<string | null> {
  const result = await run(args, cwd)
  const stopped = stoppedError(args, result)
  if (stopped) throw stopped
  if (result.code === null) throw new Error(errorLine(result.stderr) ?? `git ${args[0]} failed`)
  if (result.code !== 0) return null
  return result.stdout.toString('utf8')
}

function splitNul(text: string): string[] {
  return text.split('\0').filter((s) => s.length > 0)
}

function stripNewline(text: string): string {
  return text.replace(/\r?\n$/, '')
}

/** A path from the panel: relative, inside the folder, no `.` or `..` segments, no NUL. */
function validatePath(cwd: string, path: string): void {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error('Invalid path')
  }
  const segments = path.split('/')
  if (segments.some((s) => s === '..' || s === '.')) throw new Error('Invalid path')
  if (resolve(cwd, path) === resolve(cwd)) throw new Error('Invalid path')
}

// ---------------------------------------------------------------------------------------------
// Status in one namespace

const isStagedLetter = (letter: string): boolean => letter !== ' ' && letter !== '?'

interface StatusRead {
  /** Entries whose path is inside `cwd`, paths relative to `cwd`. */
  files: GitFileChange[]
  /** Something staged touches a path outside `cwd`; a commit would record it too. */
  stagedOutside: boolean
}

async function showPrefix(cwd: string): Promise<string> {
  return stripNewline(await git(['rev-parse', '--show-prefix'], cwd))
}

interface RawEntry {
  /** Paths as git prints them, relative to the repository top. */
  path: string
  from: string | null
  staged: string
  unstaged: string
}

async function rawStatus(cwd: string, untracked: boolean, onlyHere: boolean): Promise<RawEntry[]> {
  const args = [
    'status',
    '--porcelain=v1',
    '-z',
    untracked ? '--untracked-files=all' : '--untracked-files=no',
    ...(onlyHere ? ['--', '.'] : [])
  ]
  const fields = splitNul(await git(args, cwd))
  const entries: RawEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.length < 4) continue
    const staged = field[0] ?? ' '
    const unstaged = field[1] ?? ' '
    let from: string | null = null
    if (staged === 'R' || staged === 'C' || unstaged === 'R' || unstaged === 'C') {
      // The next field is the old path.
      if (i + 1 < fields.length) from = fields[++i]!
    }
    entries.push({ path: field.slice(3), from, staged, unstaged })
  }
  return entries
}

/**
 * `git status` as entries relative to `cwd`. Inside a repository subfolder git is asked about the
 * folder (so untracked files elsewhere are not scanned), and separately about tracked changes in
 * the whole repository: a rename from another folder only shows as a rename there, and staged
 * changes outside the folder matter because a commit records the whole index.
 */
async function readStatus(cwd: string, untracked: boolean): Promise<StatusRead> {
  const prefix = await showPrefix(cwd)
  const here = await rawStatus(cwd, untracked, prefix !== '')
  const whole = prefix === '' ? here : await rawStatus(cwd, false, false)
  const dirPrefix = prefix.length > 0 ? prefix.slice(0, -1) : ''
  const local = (path: string): string | null => (path.startsWith(prefix) ? path.slice(prefix.length) : null)
  // An old path outside the folder keeps a `../` form so git can still be given it from `cwd`.
  const relativeFrom = (from: string): string => local(from) ?? posix.relative(dirPrefix || '.', from)

  const wholeByPath = new Map(whole.map((e) => [e.path, e]))
  const files: GitFileChange[] = []
  for (const entry of here) {
    const path = local(entry.path)
    if (path === null) continue
    // The whole repository read is the one that sees a rename whose old path is elsewhere.
    const full = wholeByPath.get(entry.path) ?? entry
    const from = full.from ?? entry.from
    files.push({ path, from: from === null ? null : relativeFrom(from), staged: full.staged, unstaged: full.unstaged })
  }
  let stagedOutside = false
  for (const entry of whole) {
    if (!isStagedLetter(entry.staged)) continue
    if (local(entry.path) === null || (entry.from !== null && local(entry.from) === null)) stagedOutside = true
  }
  return { files, stagedOutside }
}

/**
 * The old path of a staged rename (it is a deletion in the index that goes with the new path).
 * A copy is not included: its source is a file of its own, with changes of its own.
 */
function stagedSources(file: GitFileChange): string[] {
  return file.from !== null && file.staged === 'R' ? [file.from] : []
}

/** True when a path derived from git's status points out of the open folder. */
function leavesFolder(path: string): boolean {
  return isAbsolute(path) || path.split('/').some((segment) => segment === '..')
}

async function assertInStatus(cwd: string, paths: string[]): Promise<GitFileChange[]> {
  const { files } = await readStatus(cwd, true)
  const byPath = new Map(files.map((f) => [f.path, f]))
  const found: GitFileChange[] = []
  for (const p of paths) {
    const entry = byPath.get(p)
    if (!entry) throw new Error('Path not in current status')
    found.push(entry)
  }
  return found
}

// ---------------------------------------------------------------------------------------------
// Hooks
//
// The panel never runs a user's hook itself and never bypasses one. A hook can run for as long as
// it likes, start processes of its own, and write to the working tree, none of which the panel can
// stop or wait for reliably. So an operation that would run a hook is refused instead.

/** Hooks that `git commit` can run, directly or through what it writes. */
export const COMMIT_HOOK_EVENTS = [
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'post-index-change',
  'reference-transaction',
  'pre-auto-gc',
  'post-rewrite'
]

const HOOKS_UNREADABLE = "Could not check this repository's git hooks."

/**
 * Names of the hooks that would run for `events`, such as "pre-commit" or "commit-msg (lint)" (a
 * hook configured as hook.lint.command). Asks `git hook list`; a git without it is asked for the
 * hook files instead. Throws when it cannot be sure, because the answer decides whether it is safe.
 */
export async function hooksFor(cwd: string, events: string[]): Promise<string[]> {
  const perEvent = await Promise.all(
    events.map(async (event) => {
      const result = await run(['hook', 'list', '-z', event], cwd, { realHooks: true })
      if (result.timedOut || result.stuck) throw new Error(`${HOOKS_UNREADABLE}${result.stuck ? STUCK_NOTE : ''}`)
      if (result.truncated) throw new Error(HOOKS_UNREADABLE)
      // Exit 129 is a usage error and "is not a git command" is a git too old to have `hook`: no `hook list`.
      if (result.code === 129 || /is not a git command/.test(result.stderr)) return null
      if (result.code === 0) return namesFromList(event, result.stdout.toString('utf8'))
      if (result.code === 1 && /no hooks found/.test(result.stderr)) return []
      throw new Error(HOOKS_UNREADABLE)
    })
  )
  // One event without `hook list` means the whole git lacks it: ask for the files instead.
  if (perEvent.some((names) => names === null)) return hooksFromPaths(cwd, events)
  return perEvent.flatMap((names) => names ?? [])
}

function namesFromList(event: string, output: string): string[] {
  // Entries end with a NUL. An empty name is a hook too (git prints just the NUL for it), and exit
  // code 0 always means at least one hook, so nothing is dropped.
  const entries = output.split('\0')
  if (entries[entries.length - 1] === '') entries.pop()
  if (entries.length === 0) entries.push('')
  return entries.map((entry) => {
    if (entry === 'hook from hookdir') return event
    // Every listed entry counts, a "disabled" one too: a hook's name may itself contain a tab, so
    // "disabled<TAB>name" cannot be trusted to mean disabled. Names are shown as git printed them.
    const shown = entry.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    return `${event} (${shown || 'unnamed'})`
  })
}

/**
 * The fallback for a git without `git hook list`: a hook is a file git would run, which is one that
 * exists and can be executed, in the folder `core.hooksPath` or the repository names.
 */
export async function hooksFromPaths(cwd: string, events: string[]): Promise<string[]> {
  const found: string[] = []
  for (const event of events) {
    const result = await run(['rev-parse', '--git-path', `hooks/${event}`], cwd, { realHooks: true })
    if (result.timedOut || result.stuck) throw new Error(`${HOOKS_UNREADABLE}${result.stuck ? STUCK_NOTE : ''}`)
    if (result.code !== 0 || result.truncated) throw new Error(HOOKS_UNREADABLE)
    const path = resolve(cwd, stripNewline(result.stdout.toString('utf8')))
    try {
      if (!statSync(path).isFile()) continue
      accessSync(path, fsConstants.X_OK)
      found.push(event)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Absent, not executable (git ignores it) or not a folder in the way: no hook. Anything else is unsure.
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') continue
      throw new Error(HOOKS_UNREADABLE)
    }
  }
  return found
}

const hooksMessage = (names: string[], action: 'commit' | 'stage'): string =>
  action === 'commit'
    ? `This repository has git hooks (${names.join(', ')}). The Git panel does not run hooks yet, so commit from a terminal.`
    : 'This repository has a post-index-change git hook. The Git panel does not run hooks yet, so stage from a terminal.'

/** Staging writes the index, which runs a post-index-change hook; refuse before touching it. */
async function refuseIndexHook(cwd: string): Promise<void> {
  const names = await hooksFor(cwd, ['post-index-change'])
  if (names.length > 0) throw new Error(hooksMessage(names, 'stage'))
}

// ---------------------------------------------------------------------------------------------
// Repository state

/** What the repository is in the middle of, or 'unknown' when that cannot be read (refuse then). */
async function repoBusy(cwd: string): Promise<string | null> {
  let dir: string
  try {
    dir = resolve(cwd, stripNewline(await git(['rev-parse', '--git-dir'], cwd)))
  } catch {
    return 'unknown'
  }
  const present = (name: string): boolean => {
    try {
      statSync(join(dir, name))
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return false
      throw err
    }
  }
  try {
    if (present('MERGE_HEAD')) return 'merge'
    if (present('rebase-merge') || present('rebase-apply')) return 'rebase'
    if (present('CHERRY_PICK_HEAD')) return 'cherry-pick'
    if (present('REVERT_HEAD')) return 'revert'
    // A multi commit cherry-pick or revert keeps its plan here after the user commits one step.
    if (present('sequencer')) {
      try {
        const todo = readFileSync(join(dir, 'sequencer', 'todo'), 'utf8')
        const first = todo.split('\n').find((line) => line.trim().length > 0 && !line.startsWith('#'))
        if (first?.startsWith('revert') || first?.startsWith('r ')) return 'revert'
      } catch {
        // No readable plan: it is still unfinished.
      }
      return 'cherry-pick'
    }
    return null
  } catch {
    return 'unknown'
  }
}

function busyMessage(busy: string): string {
  if (busy === 'unknown') return 'Regatta could not read the repository state. Check it in a terminal.'
  return `A ${busy} is in progress. Finish it in a terminal.`
}

/**
 * Whether HEAD names a commit. Only git's plain "no such commit" answer (exit code 1) means no; any
 * other failure throws, because choosing the no-commits code path by mistake would stage deletions.
 */
async function headExists(cwd: string): Promise<boolean> {
  const result = await run(['rev-parse', '--verify', '-q', 'HEAD'], cwd)
  if (result.timedOut || result.stuck) {
    throw new Error(`${firstLine(result.stderr) ?? 'Could not read the current commit'}${result.stuck ? STUCK_NOTE : ''}`)
  }
  if (result.truncated) throw new Error(firstLine(result.stderr) ?? 'Could not read the current commit')
  if (result.code === 0) return true
  if (result.code === 1) return false
  throw new Error(firstLine(result.stderr) ?? 'Could not read the current commit')
}

export async function gitOverview(cwd: string): Promise<GitOverview | null> {
  hooksSandbox() // refuses loudly here instead of looking like "not a repository"
  const inWorkTree = (await tryGit(['rev-parse', '--is-inside-work-tree'], cwd))?.trim() === 'true'
  if (!inWorkTree) return null

  const [branchText, hasCommits, busy, upstreamText, status] = await Promise.all([
    tryGit(['symbolic-ref', '--short', '-q', 'HEAD'], cwd),
    headExists(cwd),
    repoBusy(cwd),
    tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd),
    readStatus(cwd, true)
  ])
  const branch = branchText === null ? null : stripNewline(branchText) || null
  const detached = branch === null && hasCommits
  const upstream = upstreamText === null ? null : stripNewline(upstreamText) || null
  let ahead = 0
  let behind = 0
  if (upstream) {
    const count = await tryGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], cwd)
    if (count) {
      const [a, b] = count.trim().split(/\s+/).map(Number)
      ahead = a ?? 0
      behind = b ?? 0
    }
  }
  // Only a hint for the panel; the operations check again. A failed check leaves it out.
  const hooks = await hooksFor(cwd, COMMIT_HOOK_EVENTS).catch((err: unknown) => {
    if (err instanceof Error && err.message.includes(STUCK_NOTE)) throw err
    return undefined
  })
  return { cwd, branch, detached, hasCommits, busy, upstream, ahead, behind, files: status.files, ...(hooks ? { hooks } : {}) }
}

// ---------------------------------------------------------------------------------------------
// Diffs

const BINARY_NOTICE = /^Binary files /m

/** A unified diff that adds every line of `text` as a new file. */
function additionDiff(text: string): string {
  if (text.length === 0) return ''
  const endsWithNewline = text.endsWith('\n')
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n')
  const out = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)]
  if (!endsWithNewline) out.push('\\ No newline at end of file')
  return out.join('\n') + '\n'
}

/** True when `dir` is `root` or inside it after symbolic links are resolved. */
function insideReal(root: string, dir: string): boolean {
  try {
    const realRoot = realpathSync(root)
    const realDir = realpathSync(dir)
    return realDir === realRoot || realDir.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
  } catch {
    return false
  }
}

interface FileLook {
  text: string
  binary: boolean
  tooLarge: boolean
}

/**
 * Shows an untracked path without trusting it: a link shows where it points (never what is there),
 * a regular file is read at most MAX_DIFF_SIZE + 1 bytes, anything else is refused.
 */
function lookAtUntracked(cwd: string, path: string): FileLook {
  const absolute = resolve(cwd, path)
  if (!insideReal(cwd, dirname(absolute))) throw new Error('Path not in current status')
  let info
  try {
    info = lstatSync(absolute)
  } catch {
    throw new Error('The file is no longer there')
  }
  if (info.isSymbolicLink()) {
    const target = readlinkSync(absolute)
    return { text: `new file mode 120000\n@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`, binary: false, tooLarge: false }
  }
  if (!info.isFile()) throw new Error('Only regular files can be shown')
  // O_NONBLOCK so a file swapped for a named pipe cannot hang the open; O_NOFOLLOW so a swap for a link fails.
  const fd = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Only regular files can be shown')
    const buffer = Buffer.alloc(MAX_DIFF_SIZE + 1)
    let length = 0
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null)
      if (n === 0) break
      length += n
    }
    if (buffer.subarray(0, Math.min(length, BINARY_SNIFF_BYTES)).includes(0)) {
      return { text: '', binary: true, tooLarge: false }
    }
    if (length > MAX_DIFF_SIZE) return { text: '', binary: false, tooLarge: true }
    // An empty file has no lines to show; say that it is new, as git does for an empty added file.
    if (length === 0) return { text: `new file mode ${fstatSync(fd).mode & 0o100 ? '100755' : '100644'}\n`, binary: false, tooLarge: false }
    const text = additionDiff(buffer.toString('utf8', 0, length))
    if (Buffer.byteLength(text) > MAX_DIFF_SIZE) return { text: '', binary: false, tooLarge: true }
    return { text, binary: false, tooLarge: false }
  } finally {
    closeSync(fd)
  }
}

export async function gitDiff(cwd: string, path: string, staged: boolean): Promise<GitDiff> {
  validatePath(cwd, path)
  const [entry] = await assertInStatus(cwd, [path])
  const untracked = entry!.staged === '?'

  let text = ''
  let binary = false
  let tooLarge = false

  if (staged || !untracked) {
    // The old path of a rename joins the request so git can show one rename; outside the folder it is left out.
    const args = staged
      ? ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', '--', path, ...stagedSources(entry!).filter((p) => !leavesFolder(p))]
      : ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', '--', path]
    const result = await run(args, cwd, { maxBytes: MAX_DIFF_SIZE + 1 })
    if (result.timedOut || result.stuck) throw new Error(`git diff took too long and was stopped${result.stuck ? STUCK_NOTE : ''}`)
    if (result.truncated || result.stdout.length > MAX_DIFF_SIZE) {
      tooLarge = true
    } else if (result.code !== 0) {
      throw new Error(errorLine(result.stderr) ?? 'git diff failed')
    } else {
      const output = result.stdout.toString('utf8')
      binary = BINARY_NOTICE.test(output)
      text = binary ? '' : output
    }
  } else {
    const look = lookAtUntracked(cwd, path)
    text = look.text
    binary = look.binary
    tooLarge = look.tooLarge
  }

  return { path, staged, text, binary, tooLarge, untracked }
}

// ---------------------------------------------------------------------------------------------
// Stage and unstage

export async function gitStage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  for (const p of paths) validatePath(cwd, p)
  // Slow reads first, then the hook check, then the change at once: a hook installed while status
  // was running must still be seen.
  await assertInStatus(cwd, paths)
  await refuseIndexHook(cwd)
  await git(['add', '--', ...paths], cwd)
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  for (const p of paths) validatePath(cwd, p)
  const entries = await assertInStatus(cwd, paths)
  // Only entries that are staged have anything to unstage. A rename is two index changes (the new
  // path added, the old path deleted); leaving the old one staged would commit a deletion.
  const staged = entries.filter((e) => isStagedLetter(e.staged))
  if (staged.length === 0) return
  // The old path of a rename that came from another folder is outside what the panel may change.
  if (staged.some((e) => stagedSources(e).some(leavesFolder))) {
    throw new Error('This rename comes from outside the open folder. Unstage it from the repository root or a terminal.')
  }
  const targets = [...new Set(staged.flatMap((e) => [e.path, ...stagedSources(e)]))]
  const hasHead = await headExists(cwd)
  await refuseIndexHook(cwd)
  if (hasHead) {
    // reset limited to paths changes only the index; `restore --staged` would run post-checkout.
    await git(['reset', '-q', '--', ...targets], cwd)
  } else {
    await git(['rm', '--cached', '-q', '--', ...targets], cwd)
  }
}

// ---------------------------------------------------------------------------------------------
// Commit

/** Repositories (by their shared git folder) with a commit running right now. */
const committing = new Set<string>()

export interface CommitTuning {
  /** Time allowed for the commit. Default 60 seconds. */
  timeoutMs?: number
}

/** The repository's shared git folder: one key for the main folder and all its worktrees. */
async function repoKey(cwd: string): Promise<string> {
  const common = stripNewline(await git(['rev-parse', '--git-common-dir'], cwd))
  return realpathSync(resolve(cwd, common))
}

/** The status entries a commit would record, with the checks that make them safe to commit. */
async function stagedNow(cwd: string): Promise<{ files: GitFileChange[]; known: Set<string> }> {
  // The whole repository is read: a commit records everything staged, not only what is under `cwd`.
  const { files, stagedOutside } = await readStatus(cwd, true)
  if (stagedOutside) throw new Error(OUTSIDE_STAGED)
  return { files: files.filter((f) => isStagedLetter(f.staged)), known: new Set(files.map((f) => f.path)) }
}

export async function gitCommit(
  cwd: string,
  message: string,
  expected: string[],
  tune: CommitTuning = {}
): Promise<GitCommit> {
  const trimmed = message.trim()
  if (!trimmed) throw new Error('Commit message cannot be empty')
  for (const p of expected) validatePath(cwd, p)

  const key = await repoKey(cwd)
  if (committing.has(key)) throw new Error('A commit is already running. Wait for it to finish.')
  committing.add(key)
  try {
    return await commitChecked(cwd, trimmed, expected, tune)
  } finally {
    committing.delete(key)
  }
}

async function commitChecked(cwd: string, message: string, expected: string[], tune: CommitTuning): Promise<GitCommit> {
  // Everything that must be true, checked now and again right before git runs.
  const checks = async (): Promise<void> => {
    // The slow reads come first and the hook check last, so a hook installed while they ran is seen.
    const busy = await repoBusy(cwd)
    if (busy) throw new Error(busyMessage(busy))
    const now = await stagedNow(cwd)
    for (const p of expected) if (!now.known.has(p)) throw new Error('Path not in current status')
    if (now.files.length === 0) throw new Error('Nothing staged to commit')
    const staged = now.files.map((f) => f.path).sort()
    const want = [...new Set(expected)].sort()
    if (staged.length !== want.length || staged.some((p, i) => p !== want[i])) throw new Error(STAGED_CHANGED)
    const hooks = await hooksFor(cwd, COMMIT_HOOK_EVENTS)
    if (hooks.length > 0) throw new Error(hooksMessage(hooks, 'commit'))
  }
  await checks()

  const timeoutMs = tune.timeoutMs ?? COMMIT_TIMEOUT_MS
  const folder = mkdtempSync(join(tmpdir(), 'regatta-commit-'))
  try {
    const messageFile = join(folder, 'COMMIT_MSG')
    writeFileSync(messageFile, message + '\n', { mode: 0o600 })
    await checks()
    // Nothing slow may come between the last check and the commit.
    // A plain commit: no hook is bypassed, and there are none to run (checked above).
    const result = await run(['commit', '-q', '-F', messageFile], cwd, { timeout: timeoutMs })
    if (result.timedOut || result.stuck) {
      const seconds = Math.max(1, Math.round(timeoutMs / 1000))
      throw new Error(
        `The commit took longer than ${seconds} seconds and was ${result.stuck ? 'stopped, but a process it started could not be stopped' : 'stopped'}. Check the history before trying again.`
      )
    }
    if (result.truncated || result.code !== 0) {
      throw new Error(errorLine(result.stderr) ?? firstLine(result.stdout.toString('utf8')) ?? 'The commit failed')
    }
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }

  const logText = await git(['log', '--no-show-signature', '-1', '--format=%H%x1f%s%x1f%an%x1f%ct'], cwd)
  const [hash, subject, author, ct] = stripNewline(logText).split('\x1f')
  return { hash: hash ?? '', subject: subject ?? '', author: author ?? '', at: Number(ct) * 1000 || Date.now() }
}

// ---------------------------------------------------------------------------------------------
// History and worktrees

export async function gitLog(cwd: string, limit: number): Promise<GitCommit[]> {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 1))
  if (!(await headExists(cwd))) return []
  const text = await git(['log', '--no-show-signature', `-n${n}`, '--format=%H\x1f%s\x1f%an\x1f%ct\x1e'], cwd)
  if (!text.trim()) return []
  const commits: GitCommit[] = []
  for (const part of text.split('\x1e')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const [hash, subject, author, ct] = trimmed.split('\x1f')
    commits.push({ hash: hash ?? '', subject: subject ?? '', author: author ?? '', at: Number(ct) * 1000 })
  }
  return commits
}

/** A path with symbolic links resolved as far as it exists, so a missing folder still compares correctly. */
function canonical(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync(current), ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      tail.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''))
      current = parent
    }
  }
}

export async function gitWorktrees(cwd: string): Promise<GitWorktree[]> {
  const text = await git(['worktree', 'list', '--porcelain', '-z'], cwd)
  const { worktreesDir } = await import('./git')
  const root = canonical(worktreesDir())
  const worktrees: GitWorktree[] = []
  const fields = splitNul(text)
  let i = 0
  while (i < fields.length) {
    const field = fields[i]!
    if (!field.startsWith('worktree ')) {
      i++
      continue
    }
    const path = field.slice(9)
    let branch: string | null = null
    let head = ''
    i++
    while (i < fields.length && !fields[i]!.startsWith('worktree ')) {
      const attribute = fields[i]!
      if (attribute.startsWith('branch ')) {
        const ref = attribute.slice(7)
        branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      } else if (attribute.startsWith('HEAD ')) {
        head = attribute.slice(5)
      }
      i++
    }
    const real = canonical(path)
    const regatta = real === root || real.startsWith(root + sep)
    worktrees.push({ path, branch, head, main: worktrees.length === 0, regatta })
  }
  return worktrees
}
