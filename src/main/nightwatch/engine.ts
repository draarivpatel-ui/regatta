// Night watch engine. See docs/design/phase4.md.
//
// Safety (docs/design/safety.md): the user's folder only ever receives a fast-forward made by
// mergeIntoCurrentBranch; a run worktree is removed only while it is pristine (removeOwnedWorktree)
// and a run branch only while it still points at the commit that was tested (deleteOwnedBranch).
// Agents and checks run in their own process groups, and a folder a process could not be stopped
// in is held and never removed. Checks run in a temporary worktree at the run's committed tip, so a
// run worktree stays exactly as the agent and the user left it. Merges, removals and worktree
// creation for one repository run one at a time (withRepoLock). Git is never run through a shell;
// checks intentionally use /bin/sh -c (see ../heats/checks). Deleting a run branch drops its reflog, so
// deleteOwnedBranch keeps the commits first, whatever else holds them: a keep commit at
// refs/regatta/discarded/night-<run id> whose first parent is the tested commit. The run's note and the
// night's notes say where it is and give the command that brings the work back. quit() is for the app
// quitting: from then on nothing new is started and no status changes.
//
// Restarts: the state (nightwatch.json) holds each run's tested commit (`tip`) and the night's list of
// what was kept (`notes`). What Regatta needs to remove its own worktrees and branches and to know they
// are still its own (the identity of each worktree, the copy of node_modules made in it, the folders it
// holds, the parts of each note, the worktrees folder of the night) is saved beside it in
// nightwatch-owned.json. Both are written whole or not at all. On load every night in the file gets
// its runtime back, so merge and discard work after a restart; what the record cannot prove is kept,
// never removed. A run's folder is on the disk's record before an agent starts in it (saved, and the run
// does not start if that fails), and before git is asked to make it a journal entry names it (and keeps
// naming it until the state names the folder too), so a stop anywhere in between leaves something to
// find. A night that still owns, holds or is making a folder is never dropped from the history. A
// project opened below the top of its repository runs in the same folder below each worktree (asked of
// git: git rev-parse --show-prefix); ownership and removal stay at the top.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { AGENTS } from '../../shared/agents'
import { evaluateGates } from '../../shared/heats'
import type { CheckResult, CheckSpec, GateResult, TestCounts } from '../../shared/heats'
import type { MergeResult } from '../../shared/ipc'
import type { Night, NightState, NightTask, NightTaskRun, NightTaskStatus } from '../../shared/nightwatch'
import type { AgentKind, DetectedAgent } from '../../shared/types'
import { worktreesDir as defaultWorktreesDir } from '../git'
import { runChecks } from '../heats/checks'
import {
  addDetachedWorktree,
  addWorktree,
  branchExists,
  branchTip,
  captureTarget,
  commitAll,
  commitCount,
  countTestsAt,
  currentBranch,
  deleteOwnedBranch,
  diffBetween,
  diffFrom,
  dirtyTracked,
  git,
  headSha,
  isAncestor,
  isRepoWithCommit,
  mergeIntoCurrentBranch,
  MergeRefused,
  provideModules,
  removeOwnedWorktree,
  trashOwnedWorktree,
  worktreeIdentity
} from '../heats/git-ops'
import type { BranchDeletion, CapturedTarget, DiffStat, MergeOutcome, ModulesClone, OwnedWorktree, ProvidedModules, WorktreeRemoval } from '../heats/git-ops'
import { repoLockKey, withRepoLock } from '../heats/repo-lock'
import type { RunHandle, RunOptions } from '../heats/runner'

export interface NightWatchDeps {
  dataDir: string
  root: () => string
  env: () => Record<string, string>
  agents: () => DetectedAgent[]
  run: (opts: RunOptions) => RunHandle
  emit: (state: NightState) => void
  keepAwake: (on: boolean) => void
  /** Folder for night worktrees; defaults to the normal worktrees folder, never the project itself. */
  worktreesDir?: () => string
  now?: () => number
  /** How long one run may take before its agent is stopped. Defaults to 30 minutes; tests shorten it. */
  runLimitMs?: number
  /** How often a scheduled night looks at the clock. Defaults to 30 seconds; tests shorten it. */
  scheduleCheckMs?: number
}

const EMIT_MS = 250
const ID_LENGTH = 4
const DIFF_MS = 5000
const RUN_LIMIT_MS = 30 * 60 * 1000
const SCHEDULE_CHECK_MS = 30_000
/** The longest a timer can wait: anything longer fires after one millisecond. */
const MAX_TIMER_MS = 2 ** 31 - 1
const MAX_NIGHTS = 30
/** How long merge and discard wait for a cancelled night to wind down before they leave everything in place. */
const WIND_DOWN_MS = 60_000
/** What is said when something would start after quit(). */
const QUITTING = 'Regatta is closing, so nothing new was started.'
/** What provideModules says when it could not copy the dependencies; used when it fails in a way it does not report itself. */
const MODULES_NOT_COPIED = 'Dependencies were not copied into the worktree; run your install command there.'

/** A worktree (and branch) git created for a night, with what proves they are still the ones we made. */
interface Owned {
  worktree: string
  /** Empty for a temporary worktree (the baseline, the one checks run in). */
  branch: string
  /** What identified the worktree's private git folder when it was created. */
  identity: string | null
  /** The commit the branch started from. */
  base: string
}

/** What the note of a run says, kept in parts so that a retry replaces what it replaces and nothing else. */
interface RunNote {
  /** Why it failed, that it passed, or what was merged. */
  verdict: string
  /** The sentence that made the last merge attempt refuse; null once it merged. */
  refusal: string | null
  /** What was kept instead of removed while the night ran (a folder a process could not be stopped in). */
  kept: string[]
  /** What the last merge or discard kept instead of removing. Replaced by each attempt. */
  leftovers: string[]
  /** Something about the run's worktrees the user should know, that is not a failure: dependencies that could not be copied into one. Kept for good. */
  notices: string[]
  /** Where a copy of the run's work was parked before its branch went. Kept for good: a later attempt finds the commit protected and reports nothing new. */
  copies: string[]
}

/** A run's folder that git is making: written down before git is asked for it, so a stop in the middle leaves a record. */
interface Pending {
  path: string
  branch: string
  /** The commit the run's branch starts from. */
  base: string
}

/** What is saved next to the state for one run: what it still owns, and the parts of its note. */
interface RunRecord {
  /** Present while the run still owns its worktree and branch, with what proves they are the ones it made. */
  owned: { identity: string | null; modules: ModulesClone | null } | null
  note: RunNote | null
}

/** What is saved next to the state for one night. */
interface NightRecord {
  /** The folder this night's worktrees are in, as it was when the night was scheduled. */
  dir: string
  /** The reasons that concern the whole night. */
  notes: string[]
  /** Worktrees a process that could not be stopped may still be using, by path, with the reason. */
  held: Record<string, string>
  /** Run folders git was making when this was saved, by run id. Empty once the run owns its folder. */
  pending: Record<string, Pending>
  runs: Record<string, RunRecord>
}

/**
 * The file next to the state, in Regatta's data folder. The state is what the user sees; this is
 * what Regatta needs, after a restart, to remove its own worktrees and branches and to know that
 * they are still its own. Written whole or not at all.
 */
interface OwnedFile {
  version: 1
  nights: Record<string, NightRecord>
}

/** The checks run on the untouched code, and the test counts there. Every run is judged against it. */
interface Baseline {
  specs: CheckSpec[]
  results: CheckResult[]
  tests: TestCounts | null
}

interface NightRuntime {
  night: Night
  /** The folder worktrees are made in, fixed when the night is scheduled. */
  dir: string
  handles: Set<RunHandle>
  cancelled: boolean
  /** Aborted on cancel: stops checks, which agent handles do not cover. */
  abort: AbortController
  /** The background night. Never rejects; settles when every agent and check it started has stopped. */
  racing: Promise<void>
  lastEmit: number
  timer: NodeJS.Timeout | null
  scheduleTimer: NodeJS.Timeout | null
  runTimer: NodeJS.Timeout | null
  diffTimers: Map<string, NodeJS.Timeout>
  /** What this night created for a run and has not released yet, by run id. Cleanup touches nothing else. */
  owned: Map<string, Owned>
  /** The copy of node_modules made in a worktree, by path. Exactly that copy is exempt from the pristine check. */
  modules: Map<string, ModulesClone>
  /** Worktrees a process that could not be stopped may still be using, with the reason. Never removed. */
  held: Map<string, string>
  /** Folders this night made and has not handed on yet: the baseline, the check worktrees, and a run's folder until the run owns it. */
  temporary: Set<string>
  /** The folder of a run that git is making, by run id: from before git is asked until the run owns it. Saved, so a stop in the middle leaves a record. */
  pending: Map<string, Pending>
  notes: Map<string, RunNote>
  /** The reasons that concern the whole night, such as a baseline folder that was kept. */
  nightNotes: string[]
  /** Run ids with a merge or discard under way, so a second request is refused instead of queued. */
  busy: Set<string>
  /**
   * Where the project sits below the top of its repository ('' when it is the top, 'app' when the night
   * was opened at the repository's app folder). Asked of git when a night starts; not saved, because
   * nothing after a restart runs in a project folder: merge and discard work at the top of each worktree.
   */
  prefix: string
}

export class NightWatch {
  private readonly statePath: string
  /** What is needed to remove a night's own worktrees and branches after a restart, next to the state. */
  private readonly ownedPath: string
  private readonly runtimes = new Map<string, NightRuntime>()
  private state_: NightState = { queue: [], nights: [], keepingAwake: false }
  /** Set by quit(): from then on nothing new is started. */
  private quitting = false

  constructor(private readonly deps: NightWatchDeps) {
    this.statePath = join(deps.dataDir, 'nightwatch.json')
    this.ownedPath = join(deps.dataDir, 'nightwatch-owned.json')
    this.load()
  }

  getState(): NightState {
    return this.cloneState()
  }

  state(): NightState {
    return this.cloneState()
  }

  /**
   * Every folder this engine owns or holds right now, for the in-use list of Settings > Storage: the
   * run worktrees it still owns (one it kept included, until its cleanup is done), the baseline and
   * the check worktrees while they exist, and the folders it holds because a process in them could
   * not be stopped. Absolute paths, each once. A folder the engine has finished with, or never made,
   * is not in it.
   */
  busyPaths(): string[] {
    const paths = new Set<string>()
    for (const runtime of this.runtimes.values()) {
      for (const own of runtime.owned.values()) paths.add(own.worktree)
      for (const path of runtime.temporary) paths.add(path)
      for (const path of runtime.held.keys()) paths.add(path)
    }
    return [...paths]
  }

  /**
   * The app is quitting. From now on nothing new is started: no run, no baseline, no scoring step
   * that commits, no worktree for checks, no check process, no night whose time comes, and no new
   * night, merge or discard (one already under way is left to finish). Nothing that already started
   * is cut off here, apart from the checks that are running: those are stopped so that no later check
   * follows them (stopping the agents' processes is stopAllGroups' job).
   *
   * No status changes: the saved state keeps saying what it said, up to date as of this call, and the
   * next start treats a night that was running as it always does (cancelled, its unfinished runs
   * stopped). Synchronous, and safe to call again.
   */
  quit(): void {
    if (this.quitting) return
    this.quitting = true
    for (const runtime of this.runtimes.values()) {
      if (runtime.runTimer) {
        clearTimeout(runtime.runTimer)
        runtime.runTimer = null
      }
      if (runtime.scheduleTimer) {
        clearInterval(runtime.scheduleTimer)
        runtime.scheduleTimer = null
      }
      if (runtime.night.status !== 'running') continue
      // The early returns for a cancelled night do the rest: they never touch a status.
      runtime.cancelled = true
      runtime.abort.abort()
      for (const timer of runtime.diffTimers.values()) clearInterval(timer)
      runtime.diffTimers.clear()
    }
    // On disk as it stands now, before the window in which the processes are stopped.
    this.persist()
  }

  /**
   * Resolves once every night that is in progress has wound down, and writes at once any update that was
   * waiting for its turn, so that the engine does nothing more on its own. It stops nothing: a night is wound
   * down by cancel() or quit() (and a scheduled one is cancelled, or its timers keep running). For the app
   * closing, and for tests that remove the folders an engine writes to, which it would otherwise make again.
   */
  async whenIdle(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.racing
      if (runtime.timer) this.flush(runtime)
    }
  }

  /**
   * Loads the nights, and puts together again for every one of them what merge and discard need:
   * the worktree and branch it still owns, with the proof that they are the ones it made (kept
   * next to the state), so that nothing in the file is out of reach. A night that was running when
   * the app quit is over; a night that was scheduled gets its timer back (see resume).
   */
  private load(): void {
    if (!existsSync(this.statePath)) return
    try {
      this.restore()
    } catch {
      // A file that cannot be understood is the same as no file: start empty, never fail to start.
      for (const runtime of this.runtimes.values()) {
        for (const timer of [runtime.timer, runtime.scheduleTimer, runtime.runTimer]) if (timer) clearTimeout(timer)
      }
      this.runtimes.clear()
      this.state_ = { queue: [], nights: [], keepingAwake: false }
      return
    }
    this.persist()
  }

  private restore(): void {
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'))
    this.state_ = {
      queue: (parsed.queue ?? []).map((t: NightTask) => ({ ...t })),
      nights: (parsed.nights ?? []).map((n: Night) => ({
        ...n,
        runs: (n.runs ?? []).map((r: NightTaskRun) => ({ ...r }))
      })),
      keepingAwake: false
    }
    const saved = this.readOwned()
    for (const night of this.state_.nights) {
      const interrupted = new Set<string>()
      if (night.status === 'running') {
        // The app quit in the middle of it: whatever it had not finished is stopped.
        night.status = 'cancelled'
        night.finishedAt = this.now()
        for (const run of night.runs) {
          if (run.status === 'queued' || run.status === 'running' || run.status === 'checking') {
            run.status = 'stopped'
            run.endedAt = run.endedAt ?? this.now()
            interrupted.add(run.id)
          }
        }
      }
      const runtime = this.rebuild(night, saved.nights[night.id])
      this.runtimes.set(night.id, runtime)
      for (const run of night.runs) {
        if (interrupted.has(run.id)) this.setVerdict(runtime, run, 'Cancelled on app quit', true)
      }
      if (night.status === 'scheduled') this.resume(runtime)
    }
  }

  /** Writes the state whole or not at all, so a crash in the middle of a write cannot leave half a file. */
  private save(): void {
    mkdirSync(this.deps.dataDir, { recursive: true })
    // What each night owns goes first: whenever the state names a worktree, the proof of it is already saved.
    writeAtomic(this.ownedPath, JSON.stringify(this.ownedFile(), null, 2))
    writeAtomic(this.statePath, JSON.stringify(this.state_, null, 2))
    this.settleJournal()
  }

  /**
   * A journal entry (a run's folder git was making) is let go once the save that just finished has written
   * the state file naming the folder, after the record beside it: from then on a stop leaves a state that
   * names the folder, so the entry has nothing left to find. Until then it stays, so a stop between the two
   * replacements still leaves something that names the folder. It leaves the file with the next write; an
   * entry still there for a folder the state names is ignored when the files are read.
   *
   * Whether the run still owns the folder does not matter: one that was discarded meanwhile (every save
   * failed until then) has released it, and its entry must go with the next good save, not stay for ever
   * and keep the night in the history.
   */
  private settleJournal(): void {
    for (const runtime of this.runtimes.values()) {
      for (const runId of [...runtime.pending.keys()]) {
        const run = runtime.night.runs.find((r) => r.id === runId)
        if (!run || run.worktree) runtime.pending.delete(runId)
      }
    }
  }

  /** What the saved state cannot say about the nights in it, put together from what is in memory. */
  private ownedFile(): OwnedFile {
    const nights: Record<string, NightRecord> = {}
    for (const night of this.state_.nights) {
      const runtime = this.runtimes.get(night.id)
      if (!runtime) continue
      const runs: Record<string, RunRecord> = {}
      for (const run of night.runs) {
        const own = runtime.owned.get(run.id)
        const note = runtime.notes.get(run.id)
        if (!own && !note) continue
        runs[run.id] = {
          owned: own ? { identity: own.identity, modules: runtime.modules.get(own.worktree) ?? null } : null,
          note: note ? { ...note, kept: [...note.kept], leftovers: [...note.leftovers], notices: [...note.notices], copies: [...note.copies] } : null
        }
      }
      nights[night.id] = { dir: runtime.dir, notes: [...runtime.nightNotes], held: Object.fromEntries(runtime.held), pending: Object.fromEntries(runtime.pending), runs }
    }
    return { version: 1, nights }
  }

  /** The saved record, or an empty one when there is none or it cannot be read: then nothing can be proved, and nothing is removed. */
  private readOwned(): OwnedFile {
    try {
      return parseOwned(JSON.parse(readFileSync(this.ownedPath, 'utf8')))
    } catch {
      return { version: 1, nights: {} }
    }
  }

  /** The state on disk is what a restart reloads; a disk that fails must not stop a night. */
  private persist(): void {
    try {
      this.save()
    } catch {
      // The next change tries again.
    }
  }

  private cloneState(): NightState {
    return structuredClone(this.state_)
  }

  private emit(): void {
    this.deps.emit(this.cloneState())
  }

  /** Queues an update, keeping no more than four emissions a second. */
  private touch(runtime: NightRuntime): void {
    const wait = EMIT_MS - (Date.now() - runtime.lastEmit)
    if (wait <= 0) return this.flush(runtime)
    if (runtime.timer) return
    runtime.timer = setTimeout(() => {
      runtime.timer = null
      this.flush(runtime)
    }, wait)
    runtime.timer.unref()
  }

  /** Saves and emits right now: every change is on disk by the time anyone sees it. */
  private flush(runtime: NightRuntime): void {
    if (runtime.timer) {
      clearTimeout(runtime.timer)
      runtime.timer = null
    }
    runtime.lastEmit = Date.now()
    this.persist()
    this.deps.emit(this.cloneState())
  }

  /**
   * Looks at the clock while a night waits for its time. A timer does not count the time a sleeping
   * computer was asleep, so this is what starts a night that came due in the meantime.
   */
  private watchClock(runtime: NightRuntime): void {
    if (runtime.scheduleTimer) return
    runtime.scheduleTimer = setInterval(() => {
      if (runtime.night.status !== 'scheduled') {
        clearInterval(runtime.scheduleTimer!)
        runtime.scheduleTimer = null
        return
      }
      if (this.now() >= runtime.night.startAt) this.begin(runtime)
      else this.touch(runtime)
    }, this.deps.scheduleCheckMs ?? SCHEDULE_CHECK_MS)
    runtime.scheduleTimer.unref()
  }

  /** Gives a scheduled night its timer and its clock check. */
  private arm(runtime: NightRuntime): void {
    this.watchClock(runtime)
    if (runtime.runTimer) clearTimeout(runtime.runTimer)
    const wait = Math.max(0, runtime.night.startAt - this.now())
    // A night more than about 24 days away is waited for in steps: one longer timer would fire at once.
    runtime.runTimer = setTimeout(() => (wait > MAX_TIMER_MS ? this.arm(runtime) : this.begin(runtime)), Math.min(wait, MAX_TIMER_MS))
    runtime.runTimer.unref()
  }

  /** Starts a night that is waiting for its time, once, whichever of the timer and the clock check gets there first. */
  private begin(runtime: NightRuntime): void {
    if (this.quitting || runtime.night.status !== 'scheduled') return
    if (runtime.runTimer) {
      clearTimeout(runtime.runTimer)
      runtime.runTimer = null
    }
    if (runtime.scheduleTimer) {
      clearInterval(runtime.scheduleTimer)
      runtime.scheduleTimer = null
    }
    this.start(runtime)
  }

  private newRuntime(night: Night, dir: string): NightRuntime {
    return {
      night,
      dir,
      handles: new Set(),
      cancelled: false,
      abort: new AbortController(),
      racing: Promise.resolve(),
      lastEmit: 0,
      timer: null,
      scheduleTimer: null,
      runTimer: null,
      diffTimers: new Map(),
      owned: new Map(),
      modules: new Map(),
      held: new Map(),
      temporary: new Set(),
      pending: new Map(),
      notes: new Map(),
      nightNotes: [],
      busy: new Set(),
      prefix: ''
    }
  }

  /**
   * Puts together again, from the saved state and the record next to it, what a night in the file
   * needs for merge and discard: its folder, what it still owns with the proof of ownership, the
   * folders it holds and the parts of its notes. What the record does not say stays unproven, and
   * what is unproven is kept, never removed.
   */
  private rebuild(night: Night, record: NightRecord | undefined): NightRuntime {
    const runtime = this.newRuntime(night, record?.dir ?? resolve(this.deps.worktreesDir?.() ?? defaultWorktreesDir()))
    runtime.cancelled = night.status === 'cancelled'
    runtime.nightNotes = record ? [...record.notes] : [...(night.notes ?? [])]
    for (const [path, reason] of Object.entries(record?.held ?? {})) runtime.held.set(path, reason)
    for (const run of night.runs) {
      const saved = record?.runs[run.id]
      if (saved?.note) runtime.notes.set(run.id, { ...saved.note })
      else if (run.note) runtime.notes.set(run.id, { verdict: run.note, refusal: null, kept: [], leftovers: [], notices: [], copies: [] })
      if (!run.worktree || !run.branch) continue
      // Still owned when the record says so. A run that ended with its worktree and has no record is
      // owned too, but with nothing to prove it, so all that can be done with it is keep it.
      const ended = run.status === 'ready' || run.status === 'failed' || run.status === 'stopped'
      if (!saved?.owned && !ended) continue
      runtime.owned.set(run.id, { worktree: run.worktree, branch: run.branch, identity: saved?.owned?.identity ?? null, base: run.base ?? '' })
      if (saved?.owned?.modules) runtime.modules.set(run.worktree, saved.owned.modules)
    }
    for (const [runId, pending] of Object.entries(record?.pending ?? {})) this.recoverPending(runtime, runId, pending, record?.runs[runId]?.owned)
    this.renderNightNotes(runtime)
    return runtime
  }

  /**
   * A run's folder that git was making when the app stopped, and that the saved state never got to
   * name: only the journal, written before git was asked, knows it. An empty folder is only what the
   * exclusive mkdir left (nothing in it is anyone's), so it is removed. Anything else becomes the run's
   * own folder, so that it is listed as in use and discard can deal with it. What proves it is the one git
   * made is what the record says about the run when it says anything (taken when git had made it: the stop
   * came between the two files of the save that gave the run its folder); otherwise what the folder shows now,
   * which is nothing unless git got far enough to link it (no proof: kept, never removed).
   *
   * The entry goes back into the journal. The save that ends loading writes the record before the state, and
   * the state is what will name the folder: a second stop between the two files must find the folder again,
   * so the entry stays until both are written (settleJournal), exactly as when a run is first given its folder.
   */
  private recoverPending(runtime: NightRuntime, runId: string, pending: Pending, recorded: RunRecord['owned'] | undefined): void {
    const run = runtime.night.runs.find((r) => r.id === runId)
    // The state already names a folder for the run: what the record says about that folder is what counts.
    if (!run || run.worktree || run.branch) return
    // Only a folder directly in the night's worktrees folder: a changed record must not point this anywhere else.
    if (dirname(resolve(pending.path)) !== resolve(runtime.dir)) return
    try {
      rmdirSync(pending.path)
    } catch {
      // Not there, or not empty.
    }
    if (!existsSync(pending.path)) return
    run.worktree = pending.path
    run.branch = pending.branch
    run.base = run.base ?? pending.base
    runtime.owned.set(run.id, { worktree: pending.path, branch: pending.branch, identity: recorded ? recorded.identity : worktreeIdentity(pending.path), base: pending.base })
    runtime.pending.set(run.id, pending)
    // Said once, however many times the folder is taken over (a second stop takes it over again from the record the first one saved).
    const notices = this.meta(runtime, run).notices
    const said = `Regatta stopped while it was setting up ${pending.path}, so it may be incomplete.`
    if (!notices.includes(said)) notices.push(said)
    this.render(runtime, run, true)
  }

  /** A night that was scheduled when the app quit: its timer comes back, or, if its time has passed, it is missed. */
  private resume(runtime: NightRuntime): void {
    if (runtime.night.startAt > this.now()) this.arm(runtime)
    else this.miss(runtime)
  }

  /**
   * A night whose time passed while the app was closed is not started late: nobody was watching, and
   * a start hours or days after the time that was chosen would use the agents when the user does not
   * expect it. It is marked missed and says so, and its tasks go back to the queue to be started again.
   */
  private miss(runtime: NightRuntime): void {
    const night = runtime.night
    runtime.cancelled = true
    night.status = 'cancelled'
    night.finishedAt = this.now()
    for (const run of night.runs) {
      run.status = 'stopped'
      run.endedAt = this.now()
      this.setVerdict(runtime, run, 'Missed', true)
    }
    this.returnTasks(runtime)
    runtime.nightNotes.push(`Missed: Regatta was not running at ${clockText(night.startAt)}, when this night was due, so it was not started. Its tasks are back in the queue.`)
    this.renderNightNotes(runtime)
  }

  /**
   * A night that will not start (cancelled while it waited, or missed) gives its tasks back: they go to the
   * front of the queue with the ids they had and in the order they were queued, ahead of anything queued
   * since. A task that is in the queue already (same id) is left alone, so doing this twice puts nothing
   * twice. The caller saves: the state file holds the night and the queue, so the night is never cancelled
   * without its tasks back, nor the tasks back without the night cancelled, whatever stops the app in between.
   */
  private returnTasks(runtime: NightRuntime): void {
    const back: NightTask[] = []
    for (const run of runtime.night.runs) {
      if (this.state_.queue.some((task) => task.id === run.taskId)) continue
      back.push({ id: run.taskId, prompt: run.prompt, agent: run.agent, checks: run.checkSpecs.map((check) => ({ ...check })), createdAt: this.now() })
    }
    this.state_.queue.unshift(...back)
  }

  /** An id that no night in the file has. */
  private freeNightId(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = this.generateId()
      if (!this.runtimes.has(id) && !this.state_.nights.some((night) => night.id === id)) return id
    }
    throw new Error('Could not find a free name for this night. Try again.')
  }

  private generateId(): string {
    const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789'
    let id = ''
    for (let i = 0; i < ID_LENGTH; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)]
    return id
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private validateTask(task: Omit<NightTask, 'id' | 'createdAt'>): void {
    if (!task.prompt || !task.prompt.trim()) throw new Error('A task needs a prompt.')
    if (task.checks.length === 0) throw new Error('A task needs at least one check.')
    const detected = new Map(this.deps.agents().map((a) => [a.kind, a]))
    const agent = detected.get(task.agent)
    if (!agent || !agent.installed) throw new Error(`${AGENTS[task.agent]?.name ?? task.agent} is not installed.`)
  }

  addTask(task: Omit<NightTask, 'id' | 'createdAt'>): NightState {
    this.validateTask(task)
    const newTask: NightTask = {
      ...task,
      id: this.generateId(),
      createdAt: this.now()
    }
    this.state_.queue.push(newTask)
    this.save()
    this.emit()
    return this.cloneState()
  }

  removeTask(id: string): NightState {
    const idx = this.state_.queue.findIndex((t) => t.id === id)
    if (idx === -1) throw new Error('That task is not in the queue.')
    this.state_.queue.splice(idx, 1)
    this.save()
    this.emit()
    return this.cloneState()
  }

  /** Refuses when a night is already scheduled or running, or there is nothing to run. */
  private checkIdle(): void {
    if (this.state_.nights.some((n) => n.status === 'running' || n.status === 'scheduled')) {
      throw new Error('A night is already scheduled or running.')
    }
    if (this.state_.queue.length === 0) throw new Error('The queue is empty. Add tasks before scheduling.')
  }

  async schedule(startAt: number | 'now'): Promise<NightState> {
    this.checkIdle()

    const root = resolve(this.deps.root())
    if (!(await isRepoWithCommit(root))) throw new Error('Night watch needs a git repository with at least one commit.')
    // Asked twice while the repository was being looked at: only one of the calls may make the night.
    this.checkIdle()
    if (this.quitting) throw new Error('Regatta is closing, so no night was scheduled.')

    const startTime = startAt === 'now' ? this.now() : startAt
    if (startAt !== 'now' && startTime <= this.now()) throw new Error('The start time must be in the future.')

    const nightId = this.freeNightId()
    const runs: NightTaskRun[] = this.state_.queue.map((task, idx) => ({
      id: `${nightId}-${idx}`,
      taskId: task.id,
      prompt: task.prompt,
      agent: task.agent,
      status: 'queued' as NightTaskStatus,
      worktree: null,
      branch: null,
      base: null,
      tip: null,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      durationMs: null,
      diff: { files: 0, added: 0, removed: 0 },
      tokens: null,
      latest: '',
      checkSpecs: task.checks,
      checks: [],
      gates: [],
      tests: null,
      note: ''
    }))

    const night: Night = {
      id: nightId,
      root,
      startAt: startTime,
      status: 'scheduled',
      runs,
      finishedAt: null
    }

    this.state_.queue = []
    this.state_.nights.unshift(night)
    const runtime = this.newRuntime(night, resolve(this.deps.worktreesDir?.() ?? defaultWorktreesDir()))
    this.runtimes.set(nightId, runtime)
    this.trimNights()
    this.save()

    if (startAt === 'now') this.begin(runtime)
    else this.arm(runtime)

    this.emit()
    return this.cloneState()
  }

  /**
   * Keeps the history to MAX_NIGHTS by dropping the oldest nights, but only nights that have let go of
   * everything. A night that still owns a run's folder or branch, holds a folder, or is making one is
   * never dropped, however old: dropping it would forget the folder (it would leave the in-use list and
   * the saved record) and merge and discard would say the night is no longer here. So the history can be
   * longer than MAX_NIGHTS, but only by nights whose folders are still on disk.
   */
  private trimNights(): void {
    while (this.state_.nights.length > MAX_NIGHTS) {
      let oldest = -1
      for (let i = this.state_.nights.length - 1; i >= 0 && oldest < 0; i--) {
        const runtime = this.runtimes.get(this.state_.nights[i]!.id)
        if (runtime && this.letGo(runtime)) oldest = i
      }
      if (oldest < 0) return
      const [dropped] = this.state_.nights.splice(oldest, 1)
      const runtime = this.runtimes.get(dropped!.id)
      if (runtime?.timer) clearTimeout(runtime.timer)
      this.runtimes.delete(dropped!.id)
    }
  }

  /** True when a night is over and owns, holds and is making nothing: only then may it be forgotten. */
  private letGo(runtime: NightRuntime): boolean {
    if (runtime.night.status === 'running' || runtime.night.status === 'scheduled') return false
    return runtime.owned.size === 0 && runtime.held.size === 0 && runtime.temporary.size === 0 && runtime.pending.size === 0
  }

  cancel(): NightState {
    for (const runtime of this.runtimes.values()) {
      const night = runtime.night
      if (night.status === 'scheduled') {
        night.status = 'cancelled'
        night.finishedAt = this.now()
        if (runtime.scheduleTimer) {
          clearInterval(runtime.scheduleTimer)
          runtime.scheduleTimer = null
        }
        if (runtime.runTimer) {
          clearTimeout(runtime.runTimer)
          runtime.runTimer = null
        }
        // It ran nothing, so its tasks are back in the queue, saved with this cancel. Its runs stay as they were.
        this.returnTasks(runtime)
      } else if (night.status === 'running') {
        runtime.cancelled = true
        night.status = 'cancelled'
        night.finishedAt = this.now()
        runtime.abort.abort()
        for (const handle of runtime.handles) handle.stop()
        for (const timer of runtime.diffTimers.values()) clearInterval(timer)
        runtime.diffTimers.clear()
        if (runtime.runTimer) {
          clearTimeout(runtime.runTimer)
          runtime.runTimer = null
        }
        for (const run of night.runs) {
          if (run.status === 'queued' || run.status === 'running' || run.status === 'checking') {
            run.status = 'stopped'
            run.endedAt = this.now()
            this.setVerdict(runtime, run, 'Cancelled')
          }
        }
        this.releaseAwake(runtime)
      }
    }
    this.save()
    this.emit()
    return this.cloneState()
  }

  /**
   * Merges a ready run into the user's folder and removes its worktree and branch, as far as that
   * loses nothing. One merge or discard at a time per run and per repository. A refusal leaves the
   * run ready, with the sentence on its note, and keeps its worktree and branch.
   */
  async merge(runId: string): Promise<MergeResult> {
    if (this.quitting) throw new Error('Regatta is closing, so nothing was merged. Try again after it starts.')
    const { runtime, night, run, index } = this.find(runId)
    if (night.status !== 'finished' && night.status !== 'cancelled') throw new Error('This night has not finished yet.')
    if (run.status !== 'ready') throw new Error('Only a ready run can be merged.')
    if (!run.branch) throw new Error('That run has no branch to merge.')
    if (runtime.busy.has(run.id)) throw new Error('A merge or discard is already running for this run.')

    runtime.busy.add(run.id)
    try {
      let captured: CapturedTarget
      try {
        // The branch and commit are recorded now, when the merge is asked for, before anything waits: not
        // for the night to wind down (a minute at most) and not for the repository lock. A branch the user
        // switches to while this waits must not receive the change; mergeIntoCurrentBranch looks again.
        await repoLockKey(night.root) // fails closed before anything else is looked at
        captured = await captureTarget(night.root)
      } catch (err) {
        this.refuse(runtime, run, messageOf(err))
        throw err
      }
      await this.windDown(runtime)
      return await withRepoLock(night.root, () => this.mergeNow(runtime, run, index, captured))
    } finally {
      runtime.busy.delete(run.id)
    }
  }

  /**
   * The merge itself, alone in its repository. Every refusal happens before anything is changed.
   * `captured` is the branch and commit seen when the merge was asked for; mergeIntoCurrentBranch
   * checks them again right before it writes, so a change since then refuses the merge.
   */
  private async mergeNow(runtime: NightRuntime, run: NightTaskRun, index: number, captured: CapturedTarget): Promise<MergeResult> {
    const night = runtime.night
    const root = night.root
    // Looked at again under the lock: the run may have been discarded while this waited.
    if (run.status !== 'ready') throw new Error('Only a ready run can be merged.')

    // The commit that was tested is the only thing ever merged, never a name that can move or be shadowed.
    const tip = run.tip
    if (!tip) {
      const sentence = `Regatta has no record of the commit that was tested for this run, so it cannot be merged. The branch ${run.branch} is still there to review.`
      this.refuse(runtime, run, sentence)
      throw new Error(sentence)
    }

    const base = run.base ?? captured.head
    const [ahead, stat] = await Promise.all([commitCount(root, base, tip), diffBetween(root, base, tip)])
    let outcome: MergeOutcome
    try {
      outcome = await mergeIntoCurrentBranch(root, tip, `Merge night ${night.id} (run ${index})`, captured, { scratchDir: runtime.dir })
    } catch (err) {
      if (err instanceof MergeRefused) this.refuse(runtime, run, err.message)
      throw err
    }
    const target = captured.branch

    // Only delete anything once the merged work is really on the branch the user is on.
    if (!(await isAncestor(root, tip, `refs/heads/${target}`))) {
      throw new Error(`The merge finished, but ${target} does not contain the tested commit, so nothing was removed.`)
    }

    const removed = await this.cleanupRun(runtime, run)
    const lead = mergeLead(target, ahead, stat, removed, outcome)
    run.status = 'merged'
    const meta = this.meta(runtime, run)
    meta.refusal = null
    this.setVerdict(runtime, run, lead)
    this.flush(runtime)
    return { merged: true, summary: [lead, ...(removed.kept.length > 0 ? [`Kept: ${removed.kept.join(' ')}`] : []), ...removed.copies].join(' ') }
  }

  /**
   * Removes a run's worktree and branch, as far as that loses nothing, and marks it discarded.
   * What is kept (a folder with work in it, one a program is using, a branch that moved on) stays
   * on disk with the reason on the run's note; discarding again retries once that is out of the way.
   */
  async discard(runId: string): Promise<NightState> {
    if (this.quitting) throw new Error('Regatta is closing, so nothing was removed. Try again after it starts.')
    const { runtime, night, run } = this.find(runId)
    const ended = run.status === 'ready' || run.status === 'failed' || run.status === 'stopped'
    const done = run.status === 'merged' || run.status === 'discarded'
    // A merged or discarded run that still owns something it could not remove may be tried again.
    const leftovers = done && runtime.owned.has(run.id)
    if (done && !leftovers) throw new Error('That run has already been merged or discarded.')
    if (!ended && !leftovers) {
      if (night.status === 'running') throw new Error('That run has not finished. Cancel the night first, or wait for it to end.')
      if (night.status === 'scheduled') throw new Error('That night has not started yet. Cancel the night instead.')
      throw new Error('That run never started, so there is nothing to discard.')
    }
    if (runtime.busy.has(run.id)) throw new Error('A merge or discard is already running for this run.')

    runtime.busy.add(run.id)
    try {
      await this.windDown(runtime)
      await withRepoLock(night.root, async () => {
        await this.cleanupRun(runtime, run)
        if (ended) run.status = 'discarded'
      })
    } finally {
      runtime.busy.delete(run.id)
    }
    this.flush(runtime)
    return this.cloneState()
  }

  /** Finds a run from its id, which starts with the id of its night. */
  private find(runId: string): { runtime: NightRuntime; night: Night; run: NightTaskRun; index: number } {
    const nightId = runId.split('-')[0] ?? ''
    const runtime = this.runtimes.get(nightId)
    if (!runtime) throw new Error('That night is no longer here.')
    const index = runtime.night.runs.findIndex((r) => r.id === runId)
    const run = runtime.night.runs[index]
    if (!run) throw new Error('That run does not exist.')
    return { runtime, night: runtime.night, run, index }
  }

  /** A cancelled night may still be stopping its agents and checks; nothing is removed under them. */
  private async windDown(runtime: NightRuntime): Promise<void> {
    if (!runtime.cancelled) return
    let timer: NodeJS.Timeout | undefined
    const slow = new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => resolve('slow'), WIND_DOWN_MS)
      timer.unref()
    })
    const outcome = await Promise.race([runtime.racing.then(() => 'ended' as const), slow])
    if (timer) clearTimeout(timer)
    if (outcome === 'slow') throw new Error('The night is still stopping. Try again in a moment.')
  }

  // The night: baseline on untouched code, then the runs one at a time.

  /** Starts the night in the background. The first stretch, up to its first wait, runs before this returns. */
  private start(runtime: NightRuntime): void {
    // runNight handles its own failures; this is only the last line of defense against an unhandled rejection.
    runtime.racing = this.runNight(runtime).catch(() => undefined)
  }

  private async runNight(runtime: NightRuntime): Promise<void> {
    const night = runtime.night

    night.status = 'running'
    this.deps.keepAwake(true)
    this.state_.keepingAwake = true
    this.touch(runtime)

    try {
      await this.runAll(runtime)
    } catch (err) {
      // However it went wrong, the night must not stay running with the computer kept awake.
      if (!runtime.cancelled) this.failQueued(runtime, messageOf(err))
    } finally {
      this.endNight(runtime)
    }
  }

  private async runAll(runtime: NightRuntime): Promise<void> {
    const night = runtime.night
    const env = this.deps.env()

    // The usual check, again: a night that waited for its time may start in a folder that is no longer a repository.
    if (!(await isRepoWithCommit(night.root))) throw new Error('Night watch needs a git repository with at least one commit.')
    const base = await headSha(night.root)
    for (const run of night.runs) run.base = base
    // Asked of git, not worked out from paths: the folder may be reached through a symlink (/var is /private/var on a Mac).
    // When it cannot be told, nothing runs: guessing would run agents and checks at the top of the repository.
    runtime.prefix = await projectPrefix(night.root)
    if (runtime.cancelled) return

    const baseline = await this.runBaseline(runtime, base, env)
    if (runtime.cancelled) return

    for (const run of night.runs) {
      if (runtime.cancelled) break
      await this.runTask(runtime, run, baseline, env)
    }
  }

  /** Runs every check any task has on the untouched code, once, in a temporary worktree. */
  private async runBaseline(runtime: NightRuntime, base: string, env: Record<string, string>): Promise<Baseline> {
    const night = runtime.night
    const root = night.root
    const path = join(runtime.dir, `night-${night.id}-base`)
    try {
      await this.createWorktree(runtime, path, null, base)
      const own: Owned = { worktree: path, branch: '', identity: worktreeIdentity(path), base }
      try {
        // Dependencies are copied only while the night is still going: a copy is a process.
        if (!runtime.cancelled) await this.provide(runtime, null, path)
        const specs = distinctSpecs(night.runs)
        const results = await runChecks(specs, this.workFolder(runtime, path), env, { signal: runtime.abort.signal })
        this.holdIfStuck(runtime, null, path, results, 'The baseline')
        const tests = runtime.cancelled ? null : await countTestsAt(root, base)
        return { specs, results, tests }
      } finally {
        await this.releaseTemporary(runtime, null, own)
      }
    } catch (err) {
      throw new Error(`The baseline could not be prepared: ${messageOf(err)}`)
    }
  }

  /** Runs one task to its end. Never throws: whatever goes wrong becomes the run's own failure. */
  private async runTask(runtime: NightRuntime, run: NightTaskRun, baseline: Baseline, env: Record<string, string>): Promise<void> {
    try {
      await this.executeRun(runtime, run, baseline, env)
    } catch (err) {
      // cancel() has already marked a run it stopped.
      if (!runtime.cancelled) {
        run.endedAt = this.now()
        run.status = 'failed'
        this.setVerdict(runtime, run, messageOf(err))
      }
    }
    this.touch(runtime)
  }

  private async executeRun(runtime: NightRuntime, run: NightTaskRun, baseline: Baseline, env: Record<string, string>): Promise<void> {
    const night = runtime.night
    const base = run.base ?? ''
    const detected = this.agentFor(run.agent)

    run.startedAt = this.now()
    run.status = 'running'
    this.touch(runtime)

    // The same agent may take more than one task, so number its worktrees.
    const sameAgent = night.runs.filter((r) => r.agent === run.agent)
    const slug = sameAgent.length > 1 ? `${run.agent}-${sameAgent.indexOf(run) + 1}` : run.agent
    const worktree = join(runtime.dir, `night-${night.id}-${slug}`)
    const branch = `regatta/night-${night.id}-${slug}`

    // The run owns its worktree and branch only once git created them. A clash with someone else's
    // folder or branch fails the run and leaves theirs alone.
    await this.createWorktree(runtime, worktree, branch, base, run.id)
    run.worktree = worktree
    run.branch = branch
    const own: Owned = { worktree, branch, identity: worktreeIdentity(worktree), base }
    runtime.owned.set(run.id, own)
    runtime.temporary.delete(worktree)
    // On the disk, and known to be there, before anything is set up or run in the folder. This is not an update
    // for the screen (those wait up to a quarter of a second): the record is what lets a restart find the folder,
    // and a stop right now must not leave an agent working in a folder the disk does not name. The journal entry
    // for the folder stays through both files of this save (it is dropped only after the state names the folder),
    // so a stop between the two replacements still finds it. If it cannot be saved the run does not start; the
    // folder stays the run's, and discarding the run removes it.
    try {
      this.save()
    } catch (err) {
      throw new Error(`Regatta could not save its record of ${worktree}, so the run was not started. The folder and its branch were kept; discarding the run removes them. ${messageOf(err)}`)
    }
    this.touch(runtime)
    // Its dependencies are copied in only while the night is still going: a copy is a process.
    if (runtime.cancelled) return
    await this.provide(runtime, run, worktree)
    if (runtime.cancelled) return

    const handle = this.deps.run({
      agent: run.agent,
      command: detected.path ?? detected.command,
      baseArgs: detected.args,
      prompt: run.prompt,
      cwd: this.workFolder(runtime, worktree),
      env,
      allowCommands: false,
      onActivity: (line) => {
        run.latest = line
        this.touch(runtime)
      },
      onTokens: (total) => {
        run.tokens = total
        this.touch(runtime)
      }
    })
    runtime.handles.add(handle)

    let sampling: Promise<void> | null = null
    const diffTimer = setInterval(() => {
      if (sampling) return
      sampling = this.sampleDiff(runtime, run, base)
        .catch(() => undefined)
        .finally(() => {
          sampling = null
        })
    }, DIFF_MS)
    diffTimer.unref()
    runtime.diffTimers.set(run.id, diffTimer)

    let timedOut = false
    const limitTimer = setTimeout(() => {
      timedOut = true
      handle.stop()
      this.touch(runtime)
    }, this.deps.runLimitMs ?? RUN_LIMIT_MS)
    limitTimer.unref()

    try {
      const result = await handle.done
      run.exitCode = result.exitCode
      run.durationMs = result.durationMs ?? this.now() - (run.startedAt ?? this.now())
      run.tokens = result.tokens ?? run.tokens
      if (result.stuck) {
        this.hold(runtime, run, worktree, `${nameOf(run.agent)} left programs running in ${worktree} that could not be stopped, so the folder and its branch were kept.`)
        throw new Error('Some programs the agent started could not be stopped, so the run was not scored and its folder was kept.')
      }
    } finally {
      clearInterval(diffTimer)
      runtime.diffTimers.delete(run.id)
      clearTimeout(limitTimer)
      runtime.handles.delete(handle)
      // A measurement still in flight must not touch the index while the run is committed.
      await sampling
    }

    await this.endRun(runtime, run, own, baseline, env, timedOut)
  }

  /** Commits what the agent left behind, runs the checks at the committed tip and scores its gates. */
  private async endRun(
    runtime: NightRuntime,
    run: NightTaskRun,
    own: Owned,
    baseline: Baseline,
    env: Record<string, string>,
    timedOut: boolean
  ): Promise<void> {
    const night = runtime.night
    const root = night.root
    const cwd = own.worktree

    run.endedAt = this.now()
    if (runtime.cancelled) return

    run.status = 'checking'
    this.touch(runtime)

    // The agent may have moved the worktree off its branch; what would be merged is then not what is scored.
    if ((await currentBranch(cwd)) !== own.branch) throw new Error('The run left its branch, so its result cannot be scored.')
    // Looked at again: the app may have begun to quit while git was asked, and a commit is new work.
    if (runtime.cancelled) return
    // What counts is the committed change: it is what a merge would bring in.
    // commitAll leaves out the worktree's own copy of node_modules, and refuses (with a sentence that becomes the
    // run's note) while a merge, rebase or the like is half done in the folder.
    await commitAll(cwd, `Night ${night.id}: ${firstLine(run.prompt)}`)
    const committed = await headSha(cwd)
    // Saved with the state at once: from here on, merge and discard find the tested commit after a restart.
    run.tip = committed
    this.persist()
    run.diff = await diffBetween(cwd, own.base, committed)
    this.touch(runtime)

    // Checks never run in the run's own folder, which the user can open: they run in a temporary
    // worktree at the committed tip, so the run stays exactly as it was committed.
    let checksProblem: string | null = null
    const checkPath = join(runtime.dir, `${basename(cwd)}-check`)
    if (runtime.cancelled) return
    await this.createWorktree(runtime, checkPath, null, committed)
    const checkOwn: Owned = { worktree: checkPath, branch: '', identity: worktreeIdentity(checkPath), base: committed }
    try {
      if (runtime.cancelled) return
      await this.provide(runtime, run, checkPath)
      run.checks = await runChecks(run.checkSpecs, this.workFolder(runtime, checkPath), env, { signal: runtime.abort.signal })
      this.holdIfStuck(runtime, run, checkPath, run.checks, 'A check')
      if (runtime.cancelled) return
      // A check that edits or commits files means the checks did not judge the committed change.
      if (
        (await headSha(checkPath)) !== committed ||
        (await currentBranch(cwd)) !== own.branch ||
        (await branchTip(root, own.branch)) !== committed ||
        (await dirtyTracked(checkPath))
      ) {
        checksProblem = 'a check changed tracked files, so the result does not match the committed change'
      }
      if (run.checks.some((check) => check.stuck)) {
        checksProblem = 'a check left programs running that could not be stopped, so the result cannot be trusted'
      }
      run.tests = await countTestsAt(root, committed)
    } finally {
      await this.releaseTemporary(runtime, run, checkOwn)
    }
    if (runtime.cancelled) return

    run.gates = this.gates(run, baseline, timedOut, checksProblem)
    const failedGate = run.gates.find((g) => !g.passed)
    run.status = failedGate ? 'failed' : 'ready'
    this.setVerdict(runtime, run, failedGate ? failedGate.detail : 'All gates passed')
  }

  private gates(run: NightTaskRun, baseline: Baseline, timedOut: boolean, checksProblem: string | null): GateResult[] {
    const gates = evaluateGates(
      { exitCode: run.exitCode, timedOut, diff: run.diff, checks: run.checks, tests: run.tests },
      run.checkSpecs,
      baselineFor(baseline, run.checkSpecs),
      baseline.tests
    )
    if (!checksProblem) return gates
    return gates.map((gate) => (gate.id === 'checks' ? { id: 'checks', passed: false, detail: checksProblem } : gate))
  }

  private async sampleDiff(runtime: NightRuntime, run: NightTaskRun, base: string): Promise<void> {
    if (!run.worktree || run.status !== 'running') return
    try {
      const next = await diffFrom(run.worktree, base)
      // The run may have moved on while git ran; its committed numbers win.
      if (run.status !== 'running') return
      const before = run.diff
      const hadError = Boolean(run.error)
      run.error = null
      if (!hadError && before.files === next.files && before.added === next.added && before.removed === next.removed) return
      run.diff = next
      this.touch(runtime)
    } catch (err) {
      if (run.status !== 'running' || this.quitting || runtime.cancelled) return
      run.error = messageOf(err)
      this.touch(runtime)
    }
  }

  private endNight(runtime: NightRuntime): void {
    const night = runtime.night
    // A cancelled night stays cancelled: cancel() already said so, and its runs are stopped.
    if (!runtime.cancelled) {
      night.status = 'finished'
      night.finishedAt = this.now()
    }
    this.releaseAwake(runtime)
    if (runtime.scheduleTimer) {
      clearInterval(runtime.scheduleTimer)
      runtime.scheduleTimer = null
    }
    if (runtime.runTimer) {
      clearTimeout(runtime.runTimer)
      runtime.runTimer = null
    }
    for (const timer of runtime.diffTimers.values()) clearInterval(timer)
    runtime.diffTimers.clear()
    this.flush(runtime)
  }

  /** Lets the computer sleep again, unless another night is running. */
  private releaseAwake(runtime: NightRuntime): void {
    for (const other of this.runtimes.values()) {
      if (other !== runtime && other.night.status === 'running') return
    }
    this.deps.keepAwake(false)
    this.state_.keepingAwake = false
  }

  /** Marks the runs that have not started as failed, for a night that could not go on. */
  private failQueued(runtime: NightRuntime, message: string): void {
    for (const run of runtime.night.runs) {
      if (run.status !== 'queued') continue
      run.status = 'failed'
      run.endedAt = this.now()
      this.setVerdict(runtime, run, message)
    }
  }

  private agentFor(kind: AgentKind): DetectedAgent {
    const found = this.deps.agents().find((agent) => agent.kind === kind)
    if (!found) throw new Error(`${nameOf(kind)} is not installed.`)
    return found
  }

  // What the night owns: worktrees on folders that did not exist a moment ago, released only while they are still ours.

  /**
   * Makes a worktree on a folder that did not exist a moment ago. The folder is made exclusively
   * (it fails if anything is there, even an empty folder), then git fills it. When git stops after it has
   * made something (a hook that fails leaves the worktree it had checked out, and the branch), a run's
   * folder and branch become the run's own, so that merge, discard and a restart find them; the error says so.
   * Nothing else is claimed when this throws.
   */
  private async createWorktree(runtime: NightRuntime, path: string, branch: string | null, base: string, runId?: string): Promise<void> {
    const root = runtime.night.root
    // One at a time per repository: git does not cope with several worktrees being added at once.
    await withRepoLock(root, async () => {
      if (branch && (await branchExists(root, branch))) throw new Error(`The branch ${branch} already exists, so it was left alone.`)
      // Looked at last, once the lock is ours and git has answered: the wait may have been the moment the
      // app began to quit, and nothing is made after that, not even the folder the worktrees go in.
      if (this.quitting) throw new Error(QUITTING)
      mkdirSync(runtime.dir, { recursive: true })
      try {
        mkdirSync(path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`The folder ${path} is already there, so it was left alone.`)
        throw err
      }
      // Made by this night from here on (and nothing can look in between: no wait separates the two lines).
      runtime.temporary.add(path)
      const forget = (): void => {
        runtime.temporary.delete(path)
        if (runId) runtime.pending.delete(runId)
        try {
          rmdirSync(path)
        } catch {
          // Git removed it, or it holds something: either way it is no longer a folder we made empty.
        }
      }
      // A run's folder is written down, and known to be written, before git is asked for it: git can be
      // stopped in the middle of filling it, and nothing else would remember the folder was ours. The
      // folder was made by the exclusive mkdir above, so what the journal names is never someone else's.
      if (runId && branch) {
        runtime.pending.set(runId, { path, branch, base })
        try {
          this.save()
        } catch (err) {
          forget()
          throw new Error(`Regatta could not save its record of the folder it was about to make, so none was made. ${messageOf(err)}`)
        }
      }
      try {
        if (branch) await addWorktree(root, path, branch, base)
        else await addDetachedWorktree(root, path, base)
      } catch (err) {
        throw await this.afterFailedCreation(runtime, path, branch, base, runId, err)
      }
    })
  }

  /**
   * Git stopped while it was making a worktree, and may have made things first (a hook that fails leaves the
   * worktree it had checked out, and its branch). The folder is removed only if it is still the empty one this
   * night made; whatever is left in it is not forgotten:
   * - a run's folder becomes the run's own, with the branch name the run was given (that branch is git's to
   *   have made, since none was there before git started), and with the identity of the folder if it can be
   *   read, none if not: then it is kept and never removed. Saved at once. The journal entry stays until a
   *   save has written the state naming them, as when a run is first given its folder, so a stop before that
   *   still finds the folder;
   * - a folder made for the baseline or the checks is left where it is, and the night says so (it holds
   *   nothing of anyone's, but it is not ours to throw away without being sure what is in it);
   * - when no folder is left, nothing is claimed and the journal entry goes. A branch of that name may be
   *   there, but with no folder to show that git made it for this run it could as well be someone's who
   *   made it between the check and git: it is left alone, as it always was.
   * Returns the error to throw: git's own when nothing was kept, otherwise one that says what was.
   */
  private async afterFailedCreation(runtime: NightRuntime, path: string, branch: string | null, base: string, runId: string | undefined, err: unknown): Promise<unknown> {
    try {
      rmdirSync(path)
    } catch {
      // Git removed it, or it holds something: then it stays, and is dealt with below.
    }
    const folder = existsSync(path)
    const run = runId ? runtime.night.runs.find((r) => r.id === runId) : undefined
    const adopt = folder && run !== undefined && branch !== null
    // Only to say what was kept: with the folder there, a branch of that name is the one git made with it.
    const made = adopt && (await branchExists(runtime.night.root, branch!))
    // From here nothing waits: the folder goes from "being made" to "the run's" (or to nobody's) in one step, so it is never in neither list.
    runtime.temporary.delete(path)
    if (!adopt || !run || !branch) {
      if (runId) {
        runtime.pending.delete(runId)
        // Takes the folder out of the saved journal as well (best effort: a stale entry is dropped when its folder is gone).
        this.persist()
      }
      if (folder) this.keep(runtime, null, `${path} was left where it is: git stopped while it was making it (${messageOf(err)}).`)
      return err
    }
    const identity = worktreeIdentity(path)
    run.worktree = path
    run.branch = branch
    runtime.owned.set(run.id, { worktree: path, branch, identity, base })
    this.persist()
    const kept = made ? `The folder and its branch ${branch} were kept as git left them` : 'The folder was kept as git left it'
    const unproven = identity === null ? ' Regatta cannot tell whether the folder is the one git made, so it will not be removed.' : ''
    return new Error(`Git stopped while it was making ${path}, so the run was not started. ${kept}; discarding the run removes what can be removed without losing anything.${unproven} Git said: ${messageOf(err)}`)
  }

  /**
   * The folder in a worktree where the project's agents and checks run: the worktree itself, or, for a
   * project opened below the top of its repository, the same folder below it. The commit may not have
   * that folder (the project folder was new), so it is made. Everything else stays at the top of the
   * worktree: its ownership, its removal, what is held, what is committed, and the copy of node_modules
   * (the one place the shared exemption looks, and Node finds it from any folder below).
   */
  private workFolder(runtime: NightRuntime, worktree: string): string {
    const folder = runtime.prefix ? join(worktree, runtime.prefix) : worktree
    mkdirSync(folder, { recursive: true })
    return folder
  }

  /**
   * Gives a worktree its own copy of the project's node_modules (a copy-on-write clone, never a link:
   * whatever runs in a worktree, `npm ci` and `rm -rf node_modules` included, must not reach the
   * user's own dependencies), and remembers exactly that copy: it is the only thing in a worktree that
   * removal may ignore. When no copy can be made the worktree has no node_modules, and the run says so.
   */
  private async provide(runtime: NightRuntime, run: NightTaskRun | null, worktree: string): Promise<void> {
    let provided: ProvidedModules
    try {
      provided = await provideModules(runtime.night.root, worktree)
    } catch {
      provided = { clone: null, note: MODULES_NOT_COPIED }
    }
    if (provided.clone) runtime.modules.set(worktree, provided.clone)
    if (provided.note) this.notice(runtime, run, provided.note)
    // Saved at once, not with the next update: a restart must know which folder is the copy.
    if (provided.clone) this.persist()
    this.touch(runtime)
  }

  /** The proof of ownership trashOwnedWorktree / removeOwnedWorktree wants for one of this night's worktrees. */
  private record(runtime: NightRuntime, own: Owned, disposable = false, keepAs?: string): OwnedWorktree {
    return {
      root: runtime.night.root,
      path: own.worktree,
      branch: own.branch || null,
      identity: own.identity,
      dir: runtime.dir,
      ...(keepAs ? { keepAs } : {}),
      modulesClone: runtime.modules.get(own.worktree) ?? null,
      ...(disposable ? { disposable: true } : {})
    }
  }

  /**
   * Retires the worktree and branch this night created for a run and has not released yet. Safe to
   * call again: a released run is forgotten, so a worktree or branch someone recreated under the
   * same name is never touched. A run worktree is moved to Regatta's trash while it is still the one
   * we made and nothing is using it (trashOwnedWorktree), and its branch stays until Empty trash
   * deletes it; a folder a process could not be stopped in is never removed. Callers hold the
   * repository lock.
   */
  private async cleanupRun(runtime: NightRuntime, run: NightTaskRun): Promise<{ worktrees: number; branches: number; kept: string[]; copies: string[] }> {
    const root = runtime.night.root
    const own = runtime.owned.get(run.id)
    const kept: string[] = []
    const copies: string[] = []
    let worktrees = 0
    let branches = 0
    if (own) {
      let released = true
      const held = runtime.held.get(own.worktree)
      if (held) {
        kept.push(held)
        released = false
      } else {
        const result = await this.removeWorktree(runtime, own, `night-${run.id}`)
        if (result.status === 'trashed') {
          worktrees++
          copies.push(
            `Moved its worktree to Regatta's trash (${result.trashPath}). Its branch ${own.branch} stays until you empty the trash in Settings > Storage.`
          )
          if (result.keepRef) {
            const name = await this.restoreName(root, run.id)
            copies.push(
              `Kept a copy of the run's work at ${result.keepRef} (restore the work with git branch ${name} ${result.keepRef}^1; git log ${result.keepRef} shows everything kept).`
            )
          }
          runtime.owned.delete(run.id)
          released = false
        } else if (result.status === 'removed') worktrees++
        else if (result.status === 'kept') {
          kept.push(result.reason ?? `${own.worktree} was kept.`)
          released = false
        } else if (result.status === 'foreign' && result.reason) kept.push(result.reason)
      }
      if (released) {
        // The tested commit for a run that was scored, the start commit for one that never was. Deleting a
        // branch drops its reflog, so its commits are parked first: nothing the run (or the user, in it)
        // committed becomes unreachable.
        const outcome = await this.removeBranch(root, own.branch, run.tip ?? own.base, `night-${run.id}`)
        if (outcome.deleted) branches++
        if (outcome.parked) {
          // A command that can be pasted as it stands: the branch gets a name nobody has used yet.
          const name = await this.restoreName(root, run.id)
          copies.push(`Kept a copy of the run's work at ${outcome.parked} (restore the work with git branch ${name} ${outcome.parked}^1; git log ${outcome.parked} shows everything kept).`)
        }
        if (outcome.reason) kept.push(outcome.reason)
        // While the branch is kept it is still ours to deal with: the next discard tries it again.
        else runtime.owned.delete(run.id)
      }
    }
    const meta = this.meta(runtime, run)
    meta.leftovers = kept
    for (const copy of copies) if (!meta.copies.includes(copy)) meta.copies.push(copy)
    this.render(runtime, run)
    return { worktrees, branches, kept, copies }
  }

  /**
   * The name for the branch that brings a run's kept work back: night-<run id>-restored, then -2, -3 and so on
   * for as long as a branch of that name is there when the note is written. Only letters, digits and dashes, so
   * the command that carries it is safe to paste into a shell.
   */
  private async restoreName(root: string, runId: string): Promise<string> {
    let name = ''
    for (let n = 1; n <= 50; n++) {
      name = `night-${runId}-restored${n === 1 ? '' : `-${n}`}`
      if (!(await branchExists(root, name))) return name
    }
    return name
  }

  private async removeWorktree(runtime: NightRuntime, own: Owned, keepAs?: string): Promise<WorktreeRemoval> {
    try {
      return await trashOwnedWorktree(this.record(runtime, own, false, keepAs))
    } catch (err) {
      return { status: 'kept', reason: `${own.worktree} was kept: ${messageOf(err)}` }
    }
  }

  private async removeBranch(root: string, branch: string, expected: string, parkAs: string): Promise<BranchDeletion> {
    try {
      return await deleteOwnedBranch(root, branch, expected, { parkAs })
    } catch (err) {
      return { deleted: false, reason: `Branch ${branch} was kept: ${messageOf(err)}` }
    }
  }

  /**
   * Removes a temporary worktree (the baseline, the one checks run in) if it is still ours and idle,
   * under the repository lock; otherwise keeps it and says why. Returns false when it was kept.
   * Never throws: it runs in cleanup paths.
   */
  private async releaseTemporary(runtime: NightRuntime, run: NightTaskRun | null, own: Owned): Promise<boolean> {
    try {
      if (runtime.held.has(own.worktree)) return false
      try {
        const result = await withRepoLock(runtime.night.root, () => removeOwnedWorktree(this.record(runtime, own, true)))
        if (result.status === 'kept') {
          if (result.reason) this.keep(runtime, run, result.reason)
          return false
        }
        return true
      } catch (err) {
        this.keep(runtime, run, `${own.worktree} was kept: ${messageOf(err)}`)
        return false
      }
    } finally {
      // Removed, kept or held, the night is done with it. A held folder stays listed through `held`.
      runtime.temporary.delete(own.worktree)
    }
  }

  /** Marks a worktree as possibly in use by a process that could not be stopped: it is never removed. */
  private hold(runtime: NightRuntime, run: NightTaskRun | null, path: string, reason: string): void {
    runtime.held.set(path, reason)
    this.keep(runtime, run, reason)
  }

  private holdIfStuck(runtime: NightRuntime, run: NightTaskRun | null, path: string, results: { stuck?: boolean }[], who: string): void {
    if (!results.some((result) => result.stuck)) return
    this.hold(runtime, run, path, `${who} left programs running in ${path} that could not be stopped, so the folder was kept.`)
  }

  // The note of a run: why it failed or what was merged, then what was kept and why.

  private meta(runtime: NightRuntime, run: NightTaskRun): RunNote {
    let meta = runtime.notes.get(run.id)
    if (!meta) {
      meta = { verdict: '', refusal: null, kept: [], leftovers: [], notices: [], copies: [] }
      runtime.notes.set(run.id, meta)
    }
    return meta
  }

  /** Puts a run's note together from its parts, and the night's list with it. `quiet` keeps it from emitting (loading). */
  private render(runtime: NightRuntime, run: NightTaskRun, quiet = false): void {
    run.note = renderNote(this.meta(runtime, run))
    this.renderNightNotes(runtime)
    if (!quiet) this.touch(runtime)
  }

  private setVerdict(runtime: NightRuntime, run: NightTaskRun, verdict: string, quiet = false): void {
    this.meta(runtime, run).verdict = verdict
    this.render(runtime, run, quiet)
  }

  /**
   * The night's list of what was kept and why: what concerns the whole night first (the baseline),
   * then what each run kept. It is made again from its parts each time, so a reason that stopped
   * being true after a retry is gone from it.
   */
  private renderNightNotes(runtime: NightRuntime): void {
    const notes: string[] = []
    const add = (text: string): void => {
      if (!notes.includes(text)) notes.push(text)
    }
    for (const text of runtime.nightNotes) add(text)
    for (const run of runtime.night.runs) {
      const meta = runtime.notes.get(run.id)
      for (const text of [...(meta?.notices ?? []), ...(meta?.kept ?? []), ...(meta?.leftovers ?? []), ...(meta?.copies ?? [])]) add(text)
    }
    if (notes.length > 0) runtime.night.notes = notes
    else delete runtime.night.notes
  }

  /** Records what was kept instead of removed on one run, or on the night when it concerns the whole of it. */
  private keep(runtime: NightRuntime, run: NightTaskRun | null, reason: string): void {
    if (!run) {
      if (!runtime.nightNotes.includes(reason)) runtime.nightNotes.push(reason)
      this.renderNightNotes(runtime)
      this.touch(runtime)
      return
    }
    const meta = this.meta(runtime, run)
    if (!meta.kept.includes(reason)) meta.kept.push(reason)
    this.render(runtime, run)
  }

  /** Tells the user something about a run's worktrees that is not a failure: on the run, or on the night when it is about the whole of it (the baseline). */
  private notice(runtime: NightRuntime, run: NightTaskRun | null, text: string): void {
    if (!run) {
      if (!runtime.nightNotes.includes(text)) runtime.nightNotes.push(text)
      this.renderNightNotes(runtime)
      this.touch(runtime)
      return
    }
    const meta = this.meta(runtime, run)
    if (!meta.notices.includes(text)) meta.notices.push(text)
    this.render(runtime, run)
  }

  /** A merge that was refused: the run stays ready and the sentence is shown on it. */
  private refuse(runtime: NightRuntime, run: NightTaskRun, sentence: string): void {
    this.meta(runtime, run).refusal = sentence
    this.render(runtime, run)
    this.flush(runtime)
  }
}

/** Where `root` sits below the top of its repository, as git writes it without the last slash: '' at the top, 'app' or 'packages/app' below. */
async function projectPrefix(root: string): Promise<string> {
  try {
    return (await git(['rev-parse', '--show-prefix'], root)).replace(/\r?\n$/, '').replace(/\/+$/, '')
  } catch (err) {
    throw new Error(`Could not tell where in its repository the project folder is, so nothing was started. ${messageOf(err)}`)
  }
}

/** Writes a file whole or not at all: to a temporary file, flushed, then renamed over the real one. */
function writeAtomic(path: string, text: string): void {
  const temp = `${path}.tmp`
  const fd = openSync(temp, 'w')
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function parseOwnership(value: unknown): RunRecord['owned'] {
  if (!isRecord(value)) return null
  const modules = value['modules']
  return {
    identity: typeof value['identity'] === 'string' ? value['identity'] : null,
    modules:
      isRecord(modules) && typeof modules['ino'] === 'number' && typeof modules['birthtimeMs'] === 'number'
        ? { ino: modules['ino'], birthtimeMs: modules['birthtimeMs'] }
        : null
  }
}

function parseNote(value: unknown): RunNote | null {
  if (!isRecord(value)) return null
  return {
    verdict: typeof value['verdict'] === 'string' ? value['verdict'] : '',
    refusal: typeof value['refusal'] === 'string' ? value['refusal'] : null,
    kept: stringList(value['kept']),
    leftovers: stringList(value['leftovers']),
    notices: stringList(value['notices']),
    copies: stringList(value['copies'])
  }
}

/** Reads the record next to the state. Whatever is not exactly what was written is left out, never guessed at. */
function parseOwned(raw: unknown): OwnedFile {
  const file: OwnedFile = { version: 1, nights: {} }
  if (!isRecord(raw) || !isRecord(raw['nights'])) return file
  for (const [nightId, night] of Object.entries(raw['nights'])) {
    if (!isRecord(night) || typeof night['dir'] !== 'string') continue
    const runs: Record<string, RunRecord> = {}
    if (isRecord(night['runs'])) {
      for (const [runId, run] of Object.entries(night['runs'])) {
        if (isRecord(run)) runs[runId] = { owned: parseOwnership(run['owned']), note: parseNote(run['note']) }
      }
    }
    const held: Record<string, string> = {}
    if (isRecord(night['held'])) {
      for (const [path, reason] of Object.entries(night['held'])) {
        if (typeof reason === 'string') held[path] = reason
      }
    }
    const pending: Record<string, Pending> = {}
    if (isRecord(night['pending'])) {
      for (const [runId, entry] of Object.entries(night['pending'])) {
        if (isRecord(entry) && typeof entry['path'] === 'string' && typeof entry['branch'] === 'string' && typeof entry['base'] === 'string' && entry['path'] && entry['branch']) {
          pending[runId] = { path: entry['path'], branch: entry['branch'], base: entry['base'] }
        }
      }
    }
    file.nights[nightId] = { dir: night['dir'], notes: stringList(night['notes']), held, pending, runs }
  }
  return file
}

/** A time for a sentence the user reads, in their own time zone: 2026-10-15 01:00. */
function clockText(ms: number): string {
  const date = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

function nameOf(kind: AgentKind): string {
  return AGENTS[kind]?.name ?? kind
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function specKey(spec: CheckSpec): string {
  return `${spec.name}\u0000${spec.command}`
}

/** Every different check any task has, once each, in the order they first appear. */
function distinctSpecs(runs: NightTaskRun[]): CheckSpec[] {
  const seen = new Set<string>()
  const specs: CheckSpec[] = []
  for (const run of runs) {
    for (const spec of run.checkSpecs) {
      const key = specKey(spec)
      if (seen.has(key)) continue
      seen.add(key)
      specs.push(spec)
    }
  }
  return specs
}

/** The baseline results of the checks a task has: matched by name and command, so tasks with different checks never borrow each other's. */
function baselineFor(baseline: Baseline, specs: CheckSpec[]): CheckResult[] {
  const results: CheckResult[] = []
  for (const spec of specs) {
    const index = baseline.specs.findIndex((candidate) => specKey(candidate) === specKey(spec))
    const result = index >= 0 ? baseline.results[index] : undefined
    if (result) results.push(result)
  }
  return results
}

/** The sentence a note is made of: it ends in a full stop whenever something follows it. */
function renderNote(meta: RunNote): string {
  const parts: string[] = []
  if (meta.verdict) parts.push(meta.verdict)
  if (meta.refusal) parts.push(`Not merged: ${meta.refusal}`)
  parts.push(...meta.notices)
  const kept = [...new Set([...meta.kept, ...meta.leftovers])]
  if (kept.length > 0) parts.push(`Kept: ${kept.join(' ')}`)
  parts.push(...meta.copies)
  return parts.map((part, i) => (i < parts.length - 1 && !/[.!?]$/.test(part) ? `${part}.` : part)).join(' ')
}

function mergeLead(branch: string, ahead: number, stat: DiffStat, removed: { worktrees: number; branches: number }, outcome: MergeOutcome): string {
  const size = `+${stat.added} -${stat.removed} in ${plural(stat.files, 'file', 'files')}`
  const lead = outcome.alreadyMerged
    ? `${branch} already had this change, so nothing was merged.`
    : outcome.fastForward
      ? `Fast-forwarded ${branch} by ${plural(ahead, 'commit', 'commits')} (${size}).`
      : `Merged into ${branch} with ${plural(ahead, 'commit', 'commits')} (${size}).`
  return `${lead} Removed ${plural(removed.worktrees, 'worktree', 'worktrees')} and ${plural(removed.branches, 'branch', 'branches')}.`
}
