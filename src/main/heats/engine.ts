// Orchestrates heats: baseline, lanes in worktrees, checks, gates, merge.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { AGENTS } from '../../shared/agents'
import { decide, duplicateNames, evaluateGates } from '../../shared/heats'
import type { CheckSpec, GateResult, HandoffHistory, HeatState, LaneState } from '../../shared/heats'
import type { MergeResult, StartHeatOptions } from '../../shared/ipc'
import type { AgentKind, DetectedAgent } from '../../shared/types'
import { worktreesDir as defaultWorktreesDir } from '../git'
import { detectChecks, runChecks, runShell } from './checks'
import {
  addDetachedWorktree,
  addWorktree,
  branchExists,
  branchesWithPrefix,
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
  gitFull,
  headSha,
  isAncestor,
  isRepoWithCommit,
  projectPrefix,
  provideModules,
  readModulesClone,
  mergeIntoCurrentBranch,
  removeOwnedWorktree,
  sameWorktree,
  trashOwnedWorktree,
  tryGit,
  worktreeIdentity
} from './git-ops'
import type { CapturedTarget, DiffStat, ModulesClone, OwnedWorktree } from './git-ops'
import { repoLockKey, withRepoLock } from './repo-lock'
import type { RunHandle, RunOptions } from './runner'

export const SYMLINK_REFUSAL = 'Refused: the project folder inside the worktree leads outside it (a symlink).'

export interface HeatEngineDeps {
  root: () => string
  env: () => Record<string, string>
  agents: () => DetectedAgent[]
  /** Starts a headless agent run (real runner in the app, a fake in tests). */
  run: (opts: RunOptions) => RunHandle
  emit: (heat: HeatState) => void
  /** Folder for heat worktrees; defaults to the normal worktrees folder. */
  worktreesDir?: () => string
  /** Makes a heat id. Tests use it to force collisions; defaults to random letters and digits. */
  newId?: () => string
  /** Optional app data folder for project hand-off history. */
  dataDir?: string
}

/** The heat is emitted at most this often while it runs; the final states are always emitted. */
const EMIT_MS = 250
/** How often the live diff of a running lane is measured. */
const DIFF_MS = 2000
/** Length of a heat id, part of a folder name and a branch name. Long enough that a clash is a freak event. */
const ID_LENGTH = 8
/** How often a clashing id is replaced before the heat gives up. */
const ID_TRIES = 20
/** How long discard waits for a cancelled heat to wind down before it leaves everything in place. */
const WIND_DOWN_MS = 60_000

/** A worktree and branch git created for a lane, with what proves they are still the ones we made. */
interface Owned {
  worktree: string
  branch: string
  /** What identified the worktree's private git folder when it was created. */
  identity: string | null
  /** The commit the branch started from. */
  base: string
  /** The latest commit Regatta recorded on the branch. */
  tip?: string
}

interface Runtime {
  heat: HeatState
  dir: string
  handles: Set<RunHandle>
  cancelled: boolean
  /** Aborted on cancel: stops setup commands and checks, which agent handles do not cover. */
  abort: AbortController
  /** The background race. Never rejects; settles when every setup, agent and check has stopped. */
  racing: Promise<void>
  /** True while a merge of this heat runs, so a second request is refused instead of queued. */
  merging: boolean
  /** True once the worktrees and branches were removed. */
  discarded: boolean
  /** What this heat created and has not released yet, by lane id. Cleanup touches nothing else. */
  owned: Map<string, Owned>
  /**
   * Folders whose `git worktree add` has started but whose ownership is not recorded yet. git lists
   * the worktree from inside the add (the user's post-checkout hook runs there), so busyPaths must
   * count these until createWorktree hands the exact ownership over.
   */
  pending: Set<string>
  /** The baseline worktree while it exists. */
  baselineOwn: Owned | null
  /** Where the project sits below the top of the repository ("" at the top). Agents and checks run there in every worktree. */
  prefix: string
  /** The copy of node_modules made in a worktree, by path. Exactly that copy is exempt from the pristine check. */
  modules: Map<string, ModulesClone>
  /** Check worktrees that exist right now, so Storage knows they are in use. */
  checkTrees: Set<string>
  /** Worktrees a process that could not be stopped may still be using, with the reason. Never removed. */
  held: Map<string, string>
  /** What was kept instead of removed, and why. Shown on the heat. */
  notes: string[]
  lastEmit: number
  timer: NodeJS.Timeout | null
  activity: Map<string, string[]>
  resume: (() => void) | null
  overallDeadline: number | null
  overallExpired: boolean
  overallTimer: NodeJS.Timeout | null
}

export class HeatEngine {
  /** Set by quit(): nothing new is started from then on. */
  private quitting = false
  private readonly heats: HeatState[] = []
  private readonly runtimes = new Map<string, Runtime>()
  /** Every heat id handed out, claimed before any await so two starts never share one. */
  private readonly reserved = new Set<string>()

  private readonly history = new Map<string, HandoffHistory>()

  constructor(private readonly deps: HeatEngineDeps) {
    if (!deps.dataDir) return
    try {
      const saved: unknown = JSON.parse(readFileSync(join(deps.dataDir, 'handoff-history.json'), 'utf8'))
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return
      for (const [root, history] of Object.entries(saved)) {
        if (!history || typeof history !== 'object' || Array.isArray(history)) continue
        const entries: HandoffHistory = {}
        for (const [agent, value] of Object.entries(history)) {
          const entry = value as { wins?: unknown; fails?: unknown } | null
          if (entry && Number.isSafeInteger(entry.wins) && Number.isSafeInteger(entry.fails) &&
            Number(entry.wins) >= 0 && Number(entry.fails) >= 0) {
            Object.defineProperty(entries, agent, { value: { wins: Number(entry.wins), fails: Number(entry.fails) }, enumerable: true })
          }
        }
        this.history.set(root, entries)
      }
    } catch {
      // Missing or unreadable preference history never changes repository ownership.
    }
  }

  handoffHistory(root = this.deps.root()): HandoffHistory {
    return structuredClone(this.history.get(resolve(root)) ?? {})
  }

  /**
   * Called when Regatta is quitting, before the running processes are stopped: from now on the
   * engine starts nothing new (no heat, lane, setup, check worktree or check process, no scoring
   * commit, no merge), and what is running is told to stop. Everything already recorded stays as it
   * is. Synchronous and safe to call again.
   */
  quit(): void {
    this.quitting = true
    for (const runtime of this.runtimes.values()) {
      runtime.abort.abort()
      if (runtime.overallTimer) clearTimeout(runtime.overallTimer)
      if (runtime.heat.mode === 'handoff') for (const handle of runtime.handles) handle.stop()
    }
  }

  /**
   * Every folder this engine owns or holds right now: lane worktrees, the baseline, check worktrees,
   * folders kept because a program may still use them, and a merge's scratch worktree. For Settings >
   * Storage, so it does not offer them for removal. Worktrees being created right now count too:
   * git lists them from inside `git worktree add`, before the engine can record their ownership.
   */
  busyPaths(): string[] {
    const paths = new Set<string>()
    for (const runtime of this.runtimes.values()) {
      for (const own of runtime.owned.values()) paths.add(own.worktree)
      for (const path of runtime.pending) paths.add(path)
      if (runtime.baselineOwn) paths.add(runtime.baselineOwn.worktree)
      for (const path of runtime.checkTrees) paths.add(path)
      for (const path of runtime.held.keys()) paths.add(path)
      if (runtime.merging) {
        try {
          for (const name of readdirSync(runtime.dir)) if (name.startsWith('merge-')) paths.add(join(runtime.dir, name))
        } catch {
          // The folder is not there yet.
        }
      }
    }
    return [...paths]
  }

  list(): HeatState[] {
    return this.heats.map((heat) => clone(heat))
  }

  async detectChecks(): Promise<CheckSpec[]> {
    return detectChecks(this.deps.root())
  }

  /** Validates the request, then starts the heat in the background and hands back its first state. */
  async start(opts: StartHeatOptions): Promise<HeatState> {
    if (this.quitting) throw new Error('Regatta is quitting, so no new heat was started.')
    const root = resolve(this.deps.root())
    const task = opts.task.trim()
    const handoff = opts.mode === 'handoff'
    const agents = handoff ? [...(opts.order ?? [])] : [...opts.agents]
    if (handoff) {
      if (agents.length < 1 || agents.length > 4) throw new Error('A hand-off needs one to four attempts.')
      if (!Number.isFinite(opts.attemptLimitMin ?? 15) || (opts.attemptLimitMin ?? 15) <= 0) {
        throw new Error('The time per attempt must be a finite positive number.')
      }
      if (opts.overallLimitMin != null && ![30, 60, 120].includes(opts.overallLimitMin)) {
        throw new Error('The overall time limit must be none, 30, 60 or 120 minutes.')
      }
    } else if (agents.length < 2 || agents.length > 4) throw new Error('A heat needs two to four agents.')
    if (!task) throw new Error('Describe the task before starting a heat.')
    if (opts.checks.length === 0) throw new Error('A heat needs at least one check to decide.')
    const repeated = duplicateNames(opts.checks)
    if (repeated.length > 0) {
      throw new Error(`Each check needs its own name. Used more than once: ${repeated.join(', ')}.`)
    }

    const detected = new Map(this.deps.agents().map((agent) => [agent.kind, agent]))
    const missing = agents
      .filter((kind) => !detected.get(kind)?.installed)
      .map((kind) => nameOf(kind))
    if (missing.length > 0) throw new Error(`Not installed: ${missing.join(', ')}.`)
    if (!(await isRepoWithCommit(root))) throw new Error('Heats need a git repository with at least one commit.')

    const dir = resolve(this.deps.worktreesDir?.() ?? defaultWorktreesDir())
    const heat: HeatState = {
      id: await this.freeId(root, dir),
      mode: handoff ? 'handoff' : 'race',
      handoffHistory: this.handoffHistory(root),
      task,
      root,
      base: null,
      createdAt: Date.now(),
      status: 'baseline',
      checks: opts.checks.map((check) => ({ ...check })),
      baseline: [],
      baselineTests: null,
      lanes: agents.map((agent, index) => ({ ...newLane(agent, index, agents), ...(handoff ? { attempt: index + 1 } : {}) })),
      decision: null,
      error: null
    }
    const runtime: Runtime = {
      heat,
      dir,
      handles: new Set(),
      cancelled: false,
      abort: new AbortController(),
      racing: Promise.resolve(),
      merging: false,
      discarded: false,
      owned: new Map(),
      pending: new Set(),
      baselineOwn: null,
      prefix: '',
      modules: new Map(),
      checkTrees: new Set(),
      held: new Map(),
      notes: [],
      lastEmit: 0,
      timer: null,
      activity: new Map(),
      resume: null,
      overallDeadline: handoff && opts.overallLimitMin ? heat.createdAt + timeLimitMs(opts.overallLimitMin) : null,
      overallExpired: false,
      overallTimer: null
    }
    this.heats.unshift(heat)
    this.runtimes.set(heat.id, runtime)
    this.touch(runtime)

    if (runtime.overallDeadline !== null) {
      runtime.overallTimer = setTimeout(() => this.expireOverall(runtime), Math.max(1, runtime.overallDeadline - Date.now()))
      runtime.overallTimer.unref()
    }
    // Keep the caller's options stable even if its object changes after start returns.
    const runOptions = structuredClone(opts)
    runtime.racing = this.race(runtime, runOptions).catch((err: unknown) => {
      if (runtime.cancelled) {
        this.end(runtime)
        return
      }
      if (this.quitting) return
      if (runtime.overallExpired) return this.finishHandoff(runtime, 'Stopped: the overall time limit was reached.')
      heat.status = 'error'
      heat.error = messageOf(err)
      this.flush(runtime)
    }).finally(() => {
      if (runtime.overallTimer) clearTimeout(runtime.overallTimer)
      runtime.overallTimer = null
    })
    return clone(heat)
  }

  /** Stops every running lane, setup command and check. The heat keeps its lanes and worktrees until it is discarded. */
  cancel(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.cancelled) return
    // A decided or merged heat has nothing left to stop.
    if (!['baseline', 'racing', 'waiting'].includes(runtime.heat.status)) return
    runtime.cancelled = true
    runtime.abort.abort()
    for (const handle of runtime.handles) handle.stop()
    runtime.heat.status = 'cancelled'
    this.flush(runtime)
  }

  /** Resumes one waiting hand-off. Repeated or late requests cannot start another attempt. */
  continue(id: string): void {
    if (this.quitting) throw new Error('Regatta is quitting, so no attempt was started.')
    const runtime = this.must(id)
    if (runtime.heat.status !== 'waiting' || !runtime.resume || runtime.cancelled) {
      throw new Error('This hand-off is not waiting for another attempt.')
    }
    if (this.overallExpired(runtime)) return
    runtime.heat.status = 'racing'
    runtime.resume()
    this.flush(runtime)
  }

  /**
   * Merges one lane into the user's folder and removes every lane worktree and branch. One merge
   * or discard at a time per repository; a second request for the same heat is refused.
   */
  async merge(id: string, laneId: string): Promise<MergeResult> {
    const runtime = this.must(id)
    const heat = runtime.heat
    if (this.quitting) throw new Error('Regatta is quitting, so nothing was merged.')
    if (runtime.merging) throw new Error('A merge is already running for this heat.')
    if (heat.status !== 'decided' || !heat.decision) throw new Error('This heat has not been decided yet.')
    if (runtime.discarded) throw new Error('This heat was discarded, so there is nothing to merge.')
    if (!heat.decision.laneIds.includes(laneId)) throw new Error('Only the winning lane can be merged.')
    const lane = heat.lanes.find((l) => l.id === laneId)
    if (!lane || !lane.branch) throw new Error('That lane has no branch to merge.')

    runtime.merging = true
    try {
      // The branch and commit are recorded now, when the merge is asked for, not when the lock frees up:
      // a branch the user switches to while this waits must not receive the change.
      await repoLockKey(heat.root) // fails closed before anything else is looked at
      const captured = await captureTarget(heat.root)
      return await withRepoLock(heat.root, () => {
        // Waiting behind the lock can outlast the quit; a merge that was only queued must not run after it.
        if (this.quitting) throw new Error('Regatta is quitting, so nothing was merged.')
        return this.mergeNow(runtime, lane.id, captured)
      })
    } finally {
      runtime.merging = false
    }
  }

  /**
   * The merge itself, alone in its repository. Every refusal happens before anything is changed.
   * `captured` is the branch and commit seen when the merge was asked for; mergeIntoCurrentBranch
   * checks them again right before it writes, so a change since then refuses the merge.
   */
  private async mergeNow(runtime: Runtime, laneId: string, captured: CapturedTarget): Promise<MergeResult> {
    const heat = runtime.heat
    const lane = heat.lanes.find((l) => l.id === laneId)
    if (heat.status !== 'decided' || !lane || !lane.branch) throw new Error('This heat has not been decided yet.')
    if (runtime.discarded) throw new Error('This heat was discarded, so there is nothing to merge.')
    const root = heat.root

    // The commit that was tested is the only thing ever merged, never a name that can move or be shadowed.
    const tip = lane.tip
    if (!tip) throw new Error('This lane was never scored, so it cannot be merged.')

    const base = heat.base ?? captured.head
    const [ahead, stat] = await Promise.all([commitCount(root, base, tip), diffBetween(root, base, tip)])
    if (this.quitting) throw new Error('Regatta is quitting, so nothing was merged.')
    const outcome = await mergeIntoCurrentBranch(root, tip, `Merge heat ${heat.id} (${lane.label ?? lane.agent})`, captured, {
      scratchDir: runtime.dir,
      // Right before the final write: a quit that came during the build stops the merge here.
      beforeWrite: () => {
        if (this.quitting) throw new Error('Regatta is quitting, so nothing was merged.')
      },
      // And once more as the write is launched: the rechecks before it are awaits, and a quit can come during them.
      beforeLaunch: () => {
        if (this.quitting) throw new Error('Regatta is quitting, so nothing was merged.')
      }
    })
    const target = captured.branch

    // Only delete anything once the merged work is really on the branch the user is on.
    if (!(await isAncestor(root, tip, `refs/heads/${target}`))) {
      throw new Error(`The merge finished, but ${target} does not contain the tested commit, so no branch was deleted.`)
    }

    const removed = await this.cleanup(runtime)
    heat.status = 'merged'
    this.flush(runtime)
    return { merged: true, summary: mergeSummary(target, ahead, stat, removed, outcome) }
  }

  /** Cancels a running heat, waits for everything it started to stop, then removes its worktrees and branches. */
  async discard(id: string): Promise<void> {
    const runtime = this.must(id)
    if (['baseline', 'racing', 'waiting'].includes(runtime.heat.status)) this.cancel(id)
    // Agents, setup commands and checks may still be running; nothing is removed under them.
    if (runtime.cancelled) {
      let timer: NodeJS.Timeout | undefined
      const slow = new Promise<'slow'>((resolve) => {
        timer = setTimeout(() => resolve('slow'), WIND_DOWN_MS)
        timer.unref()
      })
      const outcome = await Promise.race([runtime.racing.then(() => 'ended' as const), slow])
      if (timer) clearTimeout(timer)
      if (outcome === 'slow') throw new Error('The heat is still stopping. Try discarding again in a moment.')
    }
    await withRepoLock(runtime.heat.root, async () => {
      if (this.quitting) return
      await this.cleanup(runtime)
    })
  }

  // The run: baseline on untouched code, then every lane in its own worktree, then the decision.

  private async race(runtime: Runtime, opts: StartHeatOptions): Promise<void> {
    const heat = runtime.heat
    const env = this.deps.env()
    const root = heat.root
    const signal = runtime.abort.signal

    const base = await headSha(root)
    heat.base = base
    runtime.prefix = await projectPrefix(root)
    if (runtime.cancelled) return this.end(runtime)
    if (this.quitting) return
    this.touch(runtime)

    const baselinePath = join(runtime.dir, `heat-${heat.id}-base`)
    // Only a worktree this heat created is ever removed again.
    await this.createWorktree(runtime, baselinePath, null, base, (own) => {
      runtime.baselineOwn = own
    })
    try {
      await this.setup(runtime, baselinePath, opts.setup, root, env, signal)
      heat.baseline = await runChecks(heat.checks, this.workDir(runtime, baselinePath), env, { signal })
      this.holdIfStuck(runtime, baselinePath, heat.baseline, 'The baseline')
      if (!runtime.cancelled) heat.baselineTests = await countTestsAt(root, base)
    } catch (err) {
      if (messageOf(err) !== SYMLINK_REFUSAL) throw err
      if (!runtime.cancelled) heat.baselineTests = await countTestsAt(root, base)
    } finally {
      await this.releaseBaseline(runtime)
    }
    if (runtime.cancelled) return this.end(runtime)
    if (this.quitting) return

    heat.status = 'racing'
    this.touch(runtime)
    if (heat.mode === 'handoff') return this.handoff(runtime, opts, env)
    await Promise.all(heat.lanes.map((lane) => this.runLane(runtime, opts, lane, env)))
    if (runtime.cancelled) return this.end(runtime)
    if (this.quitting) return

    heat.decision = decide(heat.lanes, (kind) => nameOf(kind))
    heat.status = 'decided'
    return this.end(runtime)
  }

  /**
   * Sequential attempts in a hand-off: each attempt is a race lane in its own fresh worktree and
   * branch (`regatta/heat-<id>-a<n>`), based on the previous attempt's latest commit. No agent ever
   * writes to a folder it did not create.
   */
  private async handoff(runtime: Runtime, opts: StartHeatOptions, env: Record<string, string>): Promise<void> {
    const heat = runtime.heat
    for (let index = 0; index < heat.lanes.length; index++) {
      if (runtime.cancelled) return this.end(runtime)
      if (this.quitting) return
      if (this.overallExpired(runtime)) return this.finishHandoff(runtime, 'Stopped: the overall time limit was reached.')
      const lane = heat.lanes[index]!
      const previous = heat.lanes[index - 1]
      let latestCommit = heat.base ?? ''
      if (previous) {
        const baseResult = await this.commitUserChanges(runtime, previous)
        if (runtime.cancelled) return this.end(runtime)
        if (this.quitting) return
        if (this.overallExpired(runtime)) return this.finishHandoff(runtime, 'Stopped: the overall time limit was reached.')
        if (baseResult.blocked) return this.finishHandoff(runtime, baseResult.blocked)
        latestCommit = baseResult.base
      }
      const scored = await this.runLane(runtime, opts, lane, env, previous, latestCommit)
      if (runtime.cancelled) return this.end(runtime)
      if (this.quitting) return
      if (this.overallExpired(runtime)) return this.finishHandoff(runtime, 'Stopped: the overall time limit was reached.')
      if (lane.gates.length > 0 && lane.gates.every((gate) => gate.passed)) {
        heat.decision = { kind: 'winner', laneIds: [lane.id], note: `Attempt ${lane.attempt}: ${nameOf(lane.agent)} passed every gate.` }
        return this.finishHandoff(runtime)
      }
      if (!scored || !lane.tip || runtime.held.size > 0) return this.finishHandoff(runtime)
      const repeated = heat.checks.find((check) => {
        if (check.kind !== 'required' || index < 2) return false
        const failures = heat.lanes.slice(index - 2, index + 1).map((attempt) => attempt.checks.find((result) => result.name === check.name))
        return failures.every((result) => result && !result.passed) &&
          new Set(failures.map((result) => normalizedFailure(result!.outputTail))).size === 1
      })
      if (repeated) return this.finishHandoff(runtime, `Stopped: ${repeated.name} failed the same way 3 times.`)
      if (opts.askBeforeNext && index + 1 < heat.lanes.length) {
        await new Promise<void>((resolve) => {
          const resume = (): void => {
            runtime.resume = null
            runtime.abort.signal.removeEventListener('abort', resume)
            resolve()
          }
          runtime.resume = resume
          runtime.abort.signal.addEventListener('abort', resume, { once: true })
          heat.status = 'waiting'
          this.flush(runtime)
          if (runtime.abort.signal.aborted) resume()
        })
      }
    }
    this.finishHandoff(runtime)
  }

  private async handoffPrompt(runtime: Runtime, previous: LaneState, latestCommit: string): Promise<string> {
    const failed = previous.gates.filter((gate) => !gate.passed).map((gate) => `${gate.id}: ${gate.detail}`)
    const checks = previous.checks.filter((check) => !check.passed).map((check) =>
      `Check ${check.name} (last 40 lines):\n${check.outputTail.split(/\r?\n/).slice(-40).join('\n')}`)
    // Evidence is read from commits and recorded results only, never from a live worktree.
    const stat = latestCommit
      ? await diffBetween(runtime.heat.root, runtime.heat.base!, latestCommit)
      : previous.diff
    return [runtime.heat.task, '', 'BEGIN PREVIOUS ATTEMPT EVIDENCE',
      `Attempt ${previous.attempt}: ${nameOf(previous.agent)}`, 'Failed gates:', ...failed, ...checks,
      `Diff against base: ${stat.files} ${stat.files === 1 ? 'file' : 'files'} changed, ${stat.added} insertion(+), ${stat.removed} deletion(-)`,
      'Previous activity (last 20 lines):', ...(runtime.activity.get(previous.id) ?? []),
      'END PREVIOUS ATTEMPT EVIDENCE'].join('\n')
  }

  private overallExpired(runtime: Runtime): boolean {
    if (!runtime.overallExpired && runtime.overallDeadline !== null && Date.now() >= runtime.overallDeadline) this.expireOverall(runtime)
    return runtime.overallExpired
  }

  private expireOverall(runtime: Runtime): void {
    runtime.overallExpired = true
    for (const lane of runtime.heat.lanes) if (lane.phase === 'running') lane.timedOut = true
    runtime.abort.abort()
    for (const handle of runtime.handles) handle.stop()
    this.touch(runtime)
  }

  private finishHandoff(runtime: Runtime, note?: string): void {
    const heat = runtime.heat
    heat.decision = note ? { kind: 'none', laneIds: [], note } : heat.decision ?? decide(heat.lanes.filter((lane) => lane.startedAt !== null), nameOf)
    heat.status = 'decided'
    const history = this.handoffHistory(heat.root)
    for (const lane of heat.lanes) {
      if (lane.startedAt === null) continue
      const entry = history[lane.agent] ?? { wins: 0, fails: 0 }
      if (heat.decision.laneIds.includes(lane.id)) entry.wins++
      else entry.fails++
      history[lane.agent] = entry
    }
    this.history.set(heat.root, history)
    heat.handoffHistory = structuredClone(history)
    if (this.deps.dataDir) {
      try {
        mkdirSync(this.deps.dataDir, { recursive: true })
        const file = join(this.deps.dataDir, 'handoff-history.json')
        writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(this.history), null, 2))
        renameSync(`${file}.tmp`, file)
      } catch (err) {
        this.note(runtime, `Could not save hand-off history: ${messageOf(err)}`)
      }
    }
    this.end(runtime)
  }

  /**
   * One lane or attempt: prepare its fresh worktree and branch, run its agent, commit and score it.
   * Returns true when scoring completed, false when stopped early or failed.
   */
  private async runLane(
    runtime: Runtime,
    opts: StartHeatOptions,
    lane: LaneState,
    env: Record<string, string>,
    previous?: LaneState,
    baseCommit?: string
  ): Promise<boolean> {
    const heat = runtime.heat
    const root = heat.root
    const heatBase = heat.base ?? ''
    const laneBase = baseCommit ?? heatBase
    try {
      lane.startedAt = Date.now()
      lane.phase = 'preparing'
      const handoff = heat.mode === 'handoff'
      const same = heat.lanes.filter((l) => l.agent === lane.agent)
      const slug = same.length > 1 ? `${lane.agent}-${same.indexOf(lane) + 1}` : lane.agent
      const suffix = handoff ? `-a${lane.attempt}` : `-${slug}`
      const worktree = join(runtime.dir, `heat-${heat.id}${suffix}`)
      const branch = `regatta/heat-${heat.id}${suffix}`
      this.touch(runtime)

      const adopt = (own: Owned): void => {
        lane.worktree = own.worktree
        lane.branch = own.branch || null
        runtime.owned.set(lane.id, own)
        this.touch(runtime)
      }
      await this.createWorktree(runtime, worktree, branch, laneBase, adopt)
      await this.setup(runtime, worktree, opts.setup, root, env, runtime.abort.signal)
      if (runtime.cancelled) {
        await this.endLane(runtime, lane, opts)
        return false
      }
      if (this.quitting) return false
      const prompt = previous ? await this.handoffPrompt(runtime, previous, laneBase) : heat.task
      if (runtime.cancelled) {
        await this.endLane(runtime, lane, opts)
        return false
      }
      if (this.quitting) return false
      if (handoff && this.overallExpired(runtime)) throw new Error('The overall time limit was reached.')
      lane.phase = 'running'
      const detected = this.agentFor(lane.agent)
      const handle = this.deps.run({
        agent: lane.agent,
        command: detected.path ?? detected.command,
        baseArgs: detected.args,
        prompt,
        cwd: this.workDir(runtime, worktree),
        env,
        allowCommands: opts.allowCommands,
        onActivity: (line) => {
          lane.latest = line
          if (handoff) {
            const lines = runtime.activity.get(lane.id) ?? []
            runtime.activity.set(lane.id, [...lines, ...line.split(/\r?\n/)].slice(-20))
          }
          this.touch(runtime)
        },
        onTokens: (total) => {
          lane.tokens = total
          this.touch(runtime)
        }
      })
      runtime.handles.add(handle)

      let sampling: Promise<void> | null = null
      const ticker = setInterval(() => {
        if (sampling) return
        sampling = this.sampleDiff(runtime, lane, heatBase).finally(() => {
          sampling = null
        })
      }, DIFF_MS)
      ticker.unref()
      const limit = timeLimitMs(handoff ? opts.attemptLimitMin ?? 15 : opts.timeLimitMin)
      const clock = limit
        ? setTimeout(() => {
            lane.timedOut = true
            handle.stop()
            this.touch(runtime)
          }, limit)
        : null
      clock?.unref()
      try {
        const result = await handle.done
        lane.exitCode = result.exitCode
        lane.durationMs = result.durationMs || Date.now() - (lane.startedAt ?? Date.now())
        lane.tokens = result.tokens ?? lane.tokens
        if (result.stuck) {
          this.hold(runtime, worktree, `${nameOf(lane.agent)} left programs running in ${worktree} that could not be stopped, so the folder and its branch were kept.`)
          throw new Error('Some programs the agent started could not be stopped, so the lane was not scored and its folder was kept.')
        }
      } finally {
        clearInterval(ticker)
        if (clock) clearTimeout(clock)
        runtime.handles.delete(handle)
        // A measurement still in flight must not touch the index while the lane is committed.
        await sampling
      }
      await this.endLane(runtime, lane, opts)
      return true
    } catch (err) {
      if (this.quitting) return false
      lane.endedAt = Date.now()
      lane.error = runtime.cancelled ? 'Cancelled' : messageOf(err)
      lane.phase = 'done'
      if (lane.gates.length === 0) lane.gates = this.failedGates(heat, lane)
      this.touch(runtime)
      return false
    }
  }

  /**
   * If attempt N's worktree changed while the heat waited, commits those changes there ("Your
   * changes after attempt N") and returns the resulting commit as attempt N+1's base. When nothing
   * committable changed, nothing is written to attempt N's worktree or index.
   */
  private async commitUserChanges(runtime: Runtime, previous: LaneState): Promise<{ base: string; blocked: string | null }> {
    const fallback = previous.tip ?? runtime.heat.base ?? ''
    const own = runtime.owned.get(previous.id)
    if (!own || !own.identity || !sameWorktree(own.worktree, own.identity)) return { base: fallback, blocked: null }
    if ((await currentBranch(own.worktree)) !== own.branch) return { base: fallback, blocked: null }
    const stopped = (): boolean => this.quitting || runtime.cancelled || this.overallExpired(runtime)
    if (stopped()) return { base: fallback, blocked: null }
    try {
      const { hasChanges, exclude } = await this.committableChanges(runtime, own.worktree)
      if (stopped()) return { base: fallback, blocked: null }
      if (hasChanges) {
        const saved = await commitAll(own.worktree, `Your changes after attempt ${previous.attempt}`, exclude, stopped)
        if (stopped()) return { base: fallback, blocked: null }
        if (saved) this.note(runtime, `Your changes were saved after attempt ${previous.attempt}.`)
      }
      const head = await headSha(own.worktree)
      own.tip = head
      return { base: head, blocked: null }
    } catch (err) {
      return { base: fallback, blocked: stopped() ? null : messageOf(err) }
    }
  }

  /**
   * Checks whether `worktree` has tracked or untracked changes to commit, using `--no-optional-locks`
   * so git does not refresh `.git/index` when nothing changed. Exempts the engine's `node_modules`
   * copy and excludes untracked nested git repositories so they stay untouched in the worktree.
   */
  private async committableChanges(runtime: Runtime, worktree: string): Promise<{ hasChanges: boolean; exclude: string[] }> {
    const { stdout, stderr } = await gitFull(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '-z'], worktree)
    if (stderr.trim().length > 0) throw new Error(`git status warned: ${stderr.trim().split('\n')[0]}`)
    const clone = runtime.modules.get(worktree)
    const now = clone ? readModulesClone(worktree) : null
    const exemptCopy = clone !== undefined && now !== null && now.ino === clone.ino && now.birthtimeMs === clone.birthtimeMs
    const trackedModules = exemptCopy
      ? (await tryGit(['--no-optional-locks', 'ls-files', '--error-unmatch', '--', 'node_modules'], worktree)) !== null
      : false
    const exclude: string[] = []
    let hasChanges = false
    const entries = stdout.split('\0')
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      if (entry.length === 0) continue
      const status = entry.slice(0, 2)
      const rawPath = entry.slice(3)
      if ((status[0] === 'R' || status[0] === 'C') && i + 1 < entries.length) i++
      const rel = rawPath.replace(/\/$/, '')
      if (exemptCopy && !trackedModules && (rel === 'node_modules' || rel.startsWith('node_modules/'))) continue
      if (status === '??' && (rawPath.endsWith('/') || pathTaken(join(worktree, rel, '.git')))) {
        exclude.push(`:(top,exclude)${rel}`)
        continue
      }
      hasChanges = true
    }
    return { hasChanges, exclude }
  }

  /** Commits what the agent left behind, runs the checks at the committed tip and scores its gates. */
  private async endLane(runtime: Runtime, lane: LaneState, opts: StartHeatOptions): Promise<void> {
    const heat = runtime.heat
    const env = this.deps.env()
    if (this.quitting) return
    lane.endedAt = Date.now()
    const stopped = (): boolean => this.quitting || runtime.cancelled || (heat.mode === 'handoff' && this.overallExpired(runtime))
    const stopLane = (): void => {
      if (this.quitting) return
      if (heat.mode === 'handoff' && this.overallExpired(runtime)) lane.error = 'The overall time limit was reached.'
      this.cancelLane(runtime, lane)
    }
    if (stopped()) return stopLane()

    lane.phase = 'checking'
    this.touch(runtime)
    const cwd = lane.worktree
    const base = heat.base ?? ''
    let checksProblem: string | null = null
    if (cwd) {
      this.workDir(runtime, cwd)
      // The agent may have moved the worktree off its branch; what would be merged is then not what is scored.
      const expected = lane.branch
      if (!expected || (await currentBranch(cwd)) !== expected) {
        throw new Error('The lane left its branch, so its result cannot be scored.')
      }
      if (stopped()) return stopLane()
      // What counts is the committed change: it is what a merge would bring in.
      // commitAll leaves out the worktree's own copy of node_modules.
      try {
        await commitAll(cwd, `Heat ${heat.id}: ${lane.agent}`, [], stopped)
      } catch (err) {
        if (stopped()) return stopLane()
        throw err
      }
      if (stopped()) return stopLane()
      const committed = await headSha(cwd)
      if (stopped()) return stopLane()
      lane.tip = committed
      const own = runtime.owned.get(lane.id)
      if (own) own.tip = committed
      lane.diff = await diffBetween(heat.root, base, committed)
      // Checks never run in the lane's own folder, which the user can open: they run in a temporary
      // worktree at the committed tip, so the lane stays exactly as it was committed.
      if (stopped()) return stopLane()
      const checkPath = join(runtime.dir, `${basename(cwd)}-check`)
      let stray: Owned | null = null
      try {
        await this.createWorktree(runtime, checkPath, null, committed, (ownCheck) => {
          stray = ownCheck
        })
      } catch (err) {
        // Added with an error but made anyway: removed like any check worktree if it is proven ours, otherwise kept and said.
        if (stray) {
          runtime.checkTrees.add(checkPath)
          if (await this.releaseTemporary(runtime, stray)) runtime.checkTrees.delete(checkPath)
        }
        if (stopped()) return stopLane()
        throw err
      }
      const checkOwn: Owned = { worktree: checkPath, branch: '', identity: worktreeIdentity(checkPath), base: committed }
      runtime.checkTrees.add(checkPath)
      try {
        await this.setup(runtime, checkPath, opts.setup, heat.root, env, runtime.abort.signal)
        if (stopped()) return stopLane()
        lane.checks = await runChecks(heat.checks, this.workDir(runtime, checkPath), env, { signal: runtime.abort.signal })
        this.holdIfStuck(runtime, checkPath, lane.checks, nameOf(lane.agent))
        if (stopped()) return stopLane()
        // A check that edits or commits files means the checks did not judge the committed change.
        if (
          (await headSha(checkPath)) !== committed ||
          (await currentBranch(cwd)) !== expected ||
          (await branchTip(heat.root, expected)) !== committed ||
          (await dirtyTracked(checkPath))
        ) {
          checksProblem = 'a check changed tracked files, so the result does not match the committed change'
        }
        if (lane.checks.some((check) => check.stuck)) {
          checksProblem = 'a check left programs running that could not be stopped, so the result cannot be trusted'
        }
        if (stopped()) return stopLane()
        lane.tests = await countTestsAt(heat.root, committed)
      } finally {
        await this.releaseTemporary(runtime, checkOwn)
        if (!runtime.held.has(checkPath) && !pathTaken(checkPath)) runtime.checkTrees.delete(checkPath)
      }
      if (stopped()) return stopLane()
    }
    lane.gates = this.gates(heat, lane, checksProblem)
    lane.phase = 'done'
    this.touch(runtime)
  }

  private cancelLane(runtime: Runtime, lane: LaneState): void {
    lane.phase = 'done'
    lane.error = lane.error ?? 'Cancelled'
    if (lane.gates.length === 0) lane.gates = this.failedGates(runtime.heat, lane)
    this.touch(runtime)
  }

  private gates(heat: HeatState, lane: LaneState, checksProblem: string | null = null): GateResult[] {
    const gates = evaluateGates(lane, heat.checks, heat.baseline, heat.baselineTests)
    if (!checksProblem) return gates
    return gates.map((gate) => (gate.id === 'checks' ? { id: 'checks', passed: false, detail: checksProblem } : gate))
  }

  /** Gates for a lane that stopped early (an error, a cancel): never all green. */
  private failedGates(heat: HeatState, lane: LaneState): GateResult[] {
    const gates = this.gates(heat, lane)
    if (gates.some((gate) => !gate.passed)) return gates
    return gates.map((gate) =>
      gate.id === 'finished' ? { id: 'finished', passed: false, detail: lane.error ?? 'did not finish' } : gate
    )
  }

  /** Runs the setup step in a worktree: the user's command, or a copy of the project's node_modules. */
  private async setup(
    runtime: Runtime,
    worktree: string,
    command: string,
    root: string,
    env: Record<string, string>,
    signal: AbortSignal
  ): Promise<void> {
    if (this.quitting) throw new Error('Cancelled')
    const cwd = this.workDir(runtime, worktree)
    const text = command.trim()
    if (text) {
      const result = await runShell(text, { cwd, env, signal })
      if (result.stuck) {
        this.hold(runtime, worktree, `The setup command left programs running in ${worktree} that could not be stopped, so the folder was kept.`)
        throw new Error('The setup command left programs running that could not be stopped.')
      }
      if (result.cancelled) throw new Error('Cancelled')
      if (result.code !== 0) throw new Error(`Setup failed: ${lastLine(result.output) || `exit code ${result.code}`}`)
      return
    }
    // Its own copy of the project's dependencies, never a link: whatever runs here (npm ci, rm -rf node_modules)
    // must not reach the user's own node_modules.
    const provided = await provideModules(root, worktree)
    if (provided.clone) runtime.modules.set(worktree, provided.clone)
    if (provided.note) this.note(runtime, provided.note)
  }

  /**
   * Where commands run in a worktree: the project's own folder, which is below the top when the
   * project was opened as a subfolder. Made if the commit has no such folder. Every existing
   * ancestor and the resolved folder itself must stay inside the realpath of `worktree`, or the
   * lane is refused before any folder is created or any setup, check or agent runs.
   */
  private workDir(runtime: Runtime, worktree: string): string {
    let rootReal: string
    try {
      rootReal = realpathSync(worktree)
    } catch {
      throw new Error(SYMLINK_REFUSAL)
    }
    if (!runtime.prefix) return worktree
    const segments = runtime.prefix.split(/[\\/]+/).filter((part) => part.length > 0)
    if (segments.length === 0) return worktree

    let probe = worktree
    for (const segment of segments) {
      if (segment === '.' || segment === '..') throw new Error(SYMLINK_REFUSAL)
      probe = join(probe, segment)
      let st: ReturnType<typeof lstatSync> | null = null
      try {
        st = lstatSync(probe)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(SYMLINK_REFUSAL)
      }
      if (!st) break
      let real: string
      try {
        real = realpathSync(probe)
        if (!statSync(probe).isDirectory()) throw new Error(SYMLINK_REFUSAL)
      } catch {
        throw new Error(SYMLINK_REFUSAL)
      }
      if (real === rootReal || !real.startsWith(rootReal + sep)) {
        throw new Error(SYMLINK_REFUSAL)
      }
    }

    let cur = worktree
    for (const segment of segments) {
      cur = join(cur, segment)
      if (!pathTaken(cur)) {
        mkdirSync(cur)
      }
      let real: string
      try {
        real = realpathSync(cur)
        if (!statSync(cur).isDirectory()) throw new Error(SYMLINK_REFUSAL)
      } catch {
        throw new Error(SYMLINK_REFUSAL)
      }
      if (real === rootReal || !real.startsWith(rootReal + sep)) {
        throw new Error(SYMLINK_REFUSAL)
      }
    }
    return cur
  }

  private async sampleDiff(runtime: Runtime, lane: LaneState, base: string): Promise<void> {
    if (!lane.worktree || lane.phase !== 'running') return
    try {
      const next = await diffFrom(lane.worktree, base)
      // The lane may have moved on while git ran; its committed numbers win.
      if (lane.phase !== 'running') return
      const before = lane.diff
      const hadError = lane.error !== null
      lane.error = null
      if (!hadError && before.files === next.files && before.added === next.added && before.removed === next.removed) return
      lane.diff = next
      this.touch(runtime)
    } catch (err) {
      if (lane.phase !== 'running' || this.quitting || runtime.cancelled) return
      const message = messageOf(err)
      lane.error = message
      lane.latest = message
      this.touch(runtime)
    }
  }

  private agentFor(kind: AgentKind): DetectedAgent {
    const found = this.deps.agents().find((agent) => agent.kind === kind)
    if (!found) throw new Error(`${nameOf(kind)} is not installed.`)
    return found
  }

  /**
   * A heat id whose branches and folders nobody uses yet, so cleanup can never reach someone
   * else's work. The id is claimed before any await, so two starts never get the same one.
   */
  private async freeId(root: string, dir: string): Promise<string> {
    const make = this.deps.newId ?? shortId
    for (let i = 0; i < ID_TRIES; i++) {
      const id = make()
      if (this.runtimes.has(id) || this.reserved.has(id)) continue
      this.reserved.add(id)
      if (await branchExists(root, `regatta/heat-${id}`)) continue
      if ((await branchesWithPrefix(root, `regatta/heat-${id}-`)).length > 0) continue
      if (existsSync(dir) && readdirSync(dir).some((name) => name === `heat-${id}` || name.startsWith(`heat-${id}-`))) continue
      return id
    }
    throw new Error('Could not find a free name for this heat. Try again.')
  }

  /**
   * Makes a worktree on a folder that did not exist a moment ago. The folder is made exclusively
   * (it fails if anything is there, even an empty folder), then git fills it. Nothing is claimed
   * when this throws.
   *
   * The path goes into `runtime.pending` before the first await, and busyPaths counts it from then
   * on: git lists the worktree from inside `git worktree add` (the user's post-checkout hook runs
   * there), so the folder is somebody's from that moment, long before the add call returns. The
   * exact ownership is handed to `adopt` here, both when the making succeeds and when it failed
   * leaving something behind; a failure that left nothing takes the path off pending.
   */
  private async createWorktree(
    runtime: Runtime,
    path: string,
    branch: string | null,
    base: string,
    adopt?: (own: Owned) => void
  ): Promise<void> {
    const root = runtime.heat.root
    if (this.quitting) throw new Error('Regatta is quitting, so nothing new was started.')
    if (runtime.heat.mode === 'handoff' && runtime.abort.signal.aborted) throw new Error('Cancelled')
    mkdirSync(runtime.dir, { recursive: true })
    runtime.pending.add(path)
    let recorded = false
    // One at a time per repository: git does not cope with several worktrees being added at once.
    try {
      await withRepoLock(root, async () => {
        // Queued behind another operation, this can start after the quit: nothing is made then.
        if (this.quitting) throw new Error('Regatta is quitting, so nothing new was started.')
        if (runtime.heat.mode === 'handoff' && runtime.abort.signal.aborted) throw new Error('Cancelled')
        if (branch && (await branchExists(root, branch))) throw new Error(`The branch ${branch} already exists, so it was left alone.`)
        try {
          mkdirSync(path)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`The folder ${path} is already there, so it was left alone.`)
          throw err
        }
        const claim = (own: Owned): void => {
          recorded = true
          runtime.pending.delete(path)
          adopt?.(own)
        }
        try {
          if (branch) await addWorktree(root, path, branch, base)
          else await addDetachedWorktree(root, path, base)
        } catch (err) {
          try {
            rmdirSync(path)
          } catch {
            // Git removed it, or it holds something: either way it is no longer a folder we made empty.
          }
          // `git worktree add` can fail after it made the worktree and the branch: a hook of the user's
          // (post-checkout) that writes a file and exits with an error leaves both registered. What is
          // there now is ours to deal with, not to forget: the folder with its identity if that can be read
          // (otherwise it is unproven and never removed), and the branch if it exists. Removal still asks
          // for a pristine worktree, so a file the hook wrote keeps it.
          const there = pathTaken(path)
          const made = branch ? await branchExists(root, branch).catch(() => false) : false
          if (there || made) claim({ worktree: path, branch: branch ?? '', identity: there ? worktreeIdentity(path) : null, base })
          throw err
        }
        claim({ worktree: path, branch: branch ?? '', identity: worktreeIdentity(path), base })
      })
    } finally {
      if (!recorded) runtime.pending.delete(path)
    }
  }

  /**
   * Removes the worktrees and branches this heat created and has not released yet. Safe to call
   * again: a released lane is forgotten, so a worktree or branch someone recreated under the
   * same name is never touched. A worktree is removed only while it is still the one we made and
   * nothing is using or holding unsaved work in it (removeOwnedWorktree), a branch only while it
   * still points where we left it (deleteOwnedBranch). What is kept is noted on the heat. Returns
   * how many of each went.
   */
  private async cleanup(runtime: Runtime): Promise<{ worktrees: number; branches: number; kept: string[] }> {
    const root = runtime.heat.root
    const kept: string[] = []
    let worktrees = 0
    let branches = 0
    for (const lane of runtime.heat.lanes) {
      const own = runtime.owned.get(lane.id)
      if (!own) continue
      let released = true
      const held = runtime.held.get(own.worktree)
      if (held) {
        kept.push(held)
        released = false
      } else {
        const result = await trashOwnedWorktree(this.record(runtime, own, false, `${runtime.heat.id}/${lane.id}`))
        if (result.status === 'trashed') {
          worktrees++
          kept.push(
            `Moved its worktree to Regatta's trash (${result.trashPath}). Its branch ${own.branch} stays until you empty the trash in Settings > Storage.`
          )
          if (result.keepRef) {
            let restored = `heat-${runtime.heat.id}-${lane.id}-restored`
            for (let n = 2; (await branchExists(root, restored)) && n < 50; n++) restored = `heat-${runtime.heat.id}-${lane.id}-restored-${n}`
            kept.push(
              `Kept a copy of ${lane.id}'s work at ${result.keepRef} (restore the work with git branch ${restored} ${result.keepRef}^1; ` +
                `git log ${result.keepRef} shows everything kept).`
            )
          }
          runtime.owned.delete(lane.id)
          continue
        }
        if (result.status === 'removed') worktrees++
        else if (result.status === 'kept') {
          kept.push(result.reason ?? `${own.worktree} was kept.`)
          released = false
        } else if (result.status === 'foreign' && result.reason) kept.push(result.reason)
      }
      if (!released) continue
      // The tested commit for a lane that was scored (or updated with user changes), the start commit for one that never was.
      // The commits are parked first, so nothing the lane (or the user, in it) committed becomes unreachable.
      const expectedTip = own.tip ?? lane.tip ?? own.base
      const parkAs = `${runtime.heat.id}/${lane.id}`
      const outcome = await deleteOwnedBranch(root, own.branch, expectedTip, { parkAs })
      if (outcome.deleted) branches++
      if (outcome.parked) {
        // A name that can be pasted into a shell as it stands, and that is free now.
        let restored = `heat-${runtime.heat.id}-${lane.id}-restored`
        for (let n = 2; (await branchExists(root, restored)) && n < 50; n++) restored = `heat-${runtime.heat.id}-${lane.id}-restored-${n}`
        kept.push(
          `Kept a copy of ${lane.id}'s work at ${outcome.parked} (restore the work with git branch ${restored} ${outcome.parked}^1; ` +
            `git log ${outcome.parked} shows everything kept).`
        )
      }
      if (outcome.reason) {
        // Still ours to deal with: the next discard tries the branch again.
        kept.push(outcome.reason)
        continue
      }
      runtime.owned.delete(lane.id)
    }
    if (runtime.baselineOwn) await this.releaseBaseline(runtime)
    for (const reason of kept) this.note(runtime, reason)
    runtime.discarded = true
    return { worktrees, branches, kept }
  }

  /** The proof of ownership trashOwnedWorktree / removeOwnedWorktree wants for one of this heat's worktrees. */
  private record(runtime: Runtime, own: Owned, disposable = false, keepAs?: string): OwnedWorktree {
    return {
      root: runtime.heat.root,
      path: own.worktree,
      branch: own.branch || null,
      identity: own.identity,
      dir: runtime.dir,
      keepAs: keepAs ?? `${runtime.heat.id}/${basename(own.worktree).replace(/^heat-[a-z0-9]+-/, '')}-worktree`,
      modulesClone: runtime.modules.get(own.worktree) ?? null,
      ...(disposable ? { disposable: true } : {})
    }
  }

  /** Removes the baseline worktree (a temporary one) if it is still ours and idle; otherwise keeps it and says why. */
  private async releaseBaseline(runtime: Runtime): Promise<void> {
    const own = runtime.baselineOwn
    if (!own) return
    if (await this.releaseTemporary(runtime, own)) runtime.baselineOwn = null
  }

  /** Removes a temporary worktree (baseline, checks). Returns false when it was kept. */
  private async releaseTemporary(runtime: Runtime, own: Owned): Promise<boolean> {
    if (runtime.held.has(own.worktree)) return false
    const result = await removeOwnedWorktree(this.record(runtime, own, true))
    if (result.status === 'kept') {
      if (result.reason) this.note(runtime, result.reason)
      return false
    }
    return true
  }

  /** Marks a worktree as possibly in use by a process that could not be stopped: it is never removed. */
  private hold(runtime: Runtime, path: string, reason: string): void {
    runtime.held.set(path, reason)
    this.note(runtime, reason)
  }

  private holdIfStuck(runtime: Runtime, path: string, results: { stuck?: boolean }[], who: string): void {
    if (!results.some((result) => result.stuck)) return
    this.hold(runtime, path, `${who} left programs running in ${path} that could not be stopped, so the folder was kept.`)
  }

  /** Adds a line to the heat's notes, once. */
  private note(runtime: Runtime, text: string): void {
    if (runtime.notes.includes(text)) return
    runtime.notes.push(text)
    runtime.heat.notes = [...runtime.notes]
    this.touch(runtime)
  }

  private must(id: string): Runtime {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('That heat is no longer here.')
    return runtime
  }

  /** Queues an update, keeping no more than four emissions a second. */
  private touch(runtime: Runtime): void {
    const wait = EMIT_MS - (Date.now() - runtime.lastEmit)
    if (wait <= 0) return this.flush(runtime)
    if (runtime.timer) return
    runtime.timer = setTimeout(() => {
      runtime.timer = null
      this.flush(runtime)
    }, wait)
    runtime.timer.unref()
  }

  /** Emits right now and always the state the caller sees. Only final states go through here. */
  private flush(runtime: Runtime): void {
    if (runtime.timer) {
      clearTimeout(runtime.timer)
      runtime.timer = null
    }
    runtime.lastEmit = Date.now()
    this.deps.emit(clone(runtime.heat))
  }

  /** The last state of a finished heat. A cancelled heat stops every lane it still had. */
  private end(runtime: Runtime): void {
    if (runtime.cancelled) {
      runtime.heat.status = 'cancelled'
      for (const lane of runtime.heat.lanes) {
        if (lane.phase === 'done') continue
        lane.phase = 'done'
        lane.endedAt = Date.now()
        lane.error = lane.error ?? 'Cancelled'
        if (lane.gates.length === 0) lane.gates = this.failedGates(runtime.heat, lane)
      }
    }
    this.flush(runtime)
  }
}

function pathTaken(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function newLane(agent: AgentKind, index: number, all: AgentKind[]): LaneState {
  const times = all.filter((kind) => kind === agent).length
  const number = all.slice(0, index + 1).filter((kind) => kind === agent).length
  const lane: LaneState = {
    // Unique even when the same agent races more than once.
    id: `${agent}-${index + 1}`,
    agent,
    worktree: null,
    branch: null,
    phase: 'queued',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    durationMs: null,
    timedOut: false,
    diff: { files: 0, added: 0, removed: 0 },
    tokens: null,
    latest: '',
    checks: [],
    tests: null,
    gates: [],
    error: null
  }
  if (times > 1) lane.label = `${nameOf(agent)} ${number}`
  return lane
}

function nameOf(kind: AgentKind): string {
  return AGENTS[kind]?.name ?? kind
}

function timeLimitMs(minutes: number): number {
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : 0
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n')
  return (lines[lines.length - 1] ?? '').trim()
}

/** Lowercase letters and digits, short enough for a branch name and a folder name. */
function shortId(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789'
  let id = ''
  for (let i = 0; i < ID_LENGTH; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)]
  return id
}

function clone(heat: HeatState): HeatState {
  return structuredClone(heat)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function mergeSummary(
  branch: string,
  ahead: number,
  stat: DiffStat,
  removed: { worktrees: number; branches: number; kept: string[] },
  outcome: { fastForward: boolean; alreadyMerged: boolean }
): string {
  const size = `+${stat.added} -${stat.removed} in ${plural(stat.files, 'file', 'files')}`
  const lead = outcome.alreadyMerged
    ? `${branch} already had this change, so nothing was merged.`
    : outcome.fastForward
      ? `Fast-forwarded ${branch} by ${plural(ahead, 'commit', 'commits')} (${size}).`
      : `Merged into ${branch} with ${plural(ahead, 'commit', 'commits')} (${size}).`
  const kept = removed.kept.length > 0 ? ` Kept: ${removed.kept.join(' ')}` : ''
  return `${lead} Removed ${plural(removed.worktrees, 'worktree', 'worktrees')} and ${plural(removed.branches, 'branch', 'branches')}.${kept}`
}

/** Ignore timer noise when deciding whether a required check is stuck on the same failure. */
function normalizedFailure(output: string): string {
  return output.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, '').replace(/\s+/g, ' ').trim()
}
