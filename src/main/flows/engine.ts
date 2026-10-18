// Runs flows step by step. See docs/design/flows.md.
//
// Safety (docs/design/safety.md): an isolated run's merge, worktree
// removal and branch deletion go only through the shared mechanisms of ../heats/git-ops, under the
// repository lock; agents and checks run in their own process groups and a folder a program could
// not be stopped in is held; the checks of an isolated run run in a temporary worktree at the run's
// committed tip, never in the run's own folder. A run in the user's folder is never merged, removed
// or committed by this engine: only its programs are supervised.

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { AGENTS } from '../../shared/agents'
import { MAX_STEPS, fillPrompt } from '../../shared/flows'
import type { Flow, FlowRun, StepRun } from '../../shared/flows'
import type { MergeResult } from '../../shared/ipc'
import type { AgentKind, DetectedAgent } from '../../shared/types'
import { worktreesDir as defaultWorktreesDir } from '../git'
import { runShell, tail } from '../heats/checks'
import {
  addDetachedWorktree,
  addWorktree,
  branchExists,
  branchTip,
  branchesWithPrefix,
  captureTarget,
  commitAll,
  commitCount,
  currentBranch,
  deleteOwnedBranch,
  diffBetween,
  git,
  headSha,
  isAncestor,
  isRepoWithCommit,
  mergeIntoCurrentBranch,
  operationInProgress,
  provideModules,
  removeOwnedWorktree,
  sameWorktree,
  trashOwnedWorktree,
  worktreeIdentity
} from '../heats/git-ops'
import type { CapturedTarget, DiffStat, ModulesClone } from '../heats/git-ops'
import type { SuperviseOptions } from '../heats/procgroup'
import { repoLockKey, withRepoLock } from '../heats/repo-lock'
import type { RunHandle, RunOptions } from '../heats/runner'

export interface FlowEngineDeps {
  /** App data folder: flows in <dataDir>/flows.json, runs in <dataDir>/flow-runs/. */
  dataDir: string
  root: () => string
  env: () => Record<string, string>
  agents: () => DetectedAgent[]
  /** Starts a headless agent run (the heats runner in the app, a fake in tests). */
  run: (opts: RunOptions) => RunHandle
  emitFlows: (flows: Flow[]) => void
  emitRun: (run: FlowRun) => void
  /** Folder for run worktrees; defaults to the normal worktrees folder. */
  worktreesDir?: () => string
  /** Shutdown timings for the commands of check steps. The app leaves it out; tests shorten them. */
  supervise?: SuperviseOptions
  /** Makes a run id. Tests use it to force collisions; defaults to random letters and digits. */
  newId?: () => string
}

/** The run is emitted at most this often while it runs; the last state is always emitted. */
const EMIT_MS = 250
/** How many activity or output lines a step keeps. */
const KEEP_LINES = 60
/** The newest runs that are kept; older ones lose their files. */
const MAX_RUNS = 50
/** Maximal length of a flow or run id, part of a branch name and a folder name. */
const ID_LENGTH = 4
/** How often a clashing run id is replaced before the run gives up. */
const ID_TRIES = 20
/** How long discard waits for a stopped run to wind down before it leaves everything in place. */
const WIND_DOWN_MS = 60_000

/** Thrown inside the engine once the app is quitting, to unwind whatever was about to start something new. */
class Quitting extends Error {
  constructor() {
    super('Regatta is quitting, so nothing new was started.')
    this.name = 'Quitting'
  }
}

/**
 * What an isolated run created and has not released yet, with what proves later that it is still
 * the one it created. Saved inside the run's own file (never shown to the window), so a merge or a
 * discard after a restart still knows what it may remove. Anything not listed here is not ours.
 */
interface Owned {
  /** The repository folder the run was started in. Merges and removals go through it, whatever the window shows now. */
  root: string
  /** The folder Regatta keeps its worktrees in. The run's worktree must be inside it. */
  dir: string
  worktree: string
  branch: string
  /** `worktreeIdentity` taken right after git created the worktree. Null means it could not be read: never removed. */
  identity: string | null
  /** The commit the branch started from. */
  base: string
  /** The commit the run's work was last committed at (made by the engine, or found there): what a merge brings in. */
  tip: string | null
  /**
   * Where the project folder sits inside the repository, as git says it: "" at the top, "packages/app"
   * below it. Agents and checks work in the matching folder of a worktree, so a project opened below
   * the top stays below it.
   */
  prefix: string
  /**
   * The run's own copy of the project's node_modules (`provideModules`, read right after it was made):
   * exactly that folder, and what is in it, is not a change when the worktree is looked at before its
   * removal. Null when none was made.
   */
  modules: ModulesClone | null
}

interface Runtime {
  run: FlowRun
  handle: { stop: () => void } | null
  cancelled: boolean
  /** Aborted by stop: a check that has not started never starts, one that runs is stopped with its whole process group. */
  abort: AbortController
  waiting: (() => void) | null
  /** Settles when the pipeline has ended and its last state was saved. Never rejects. */
  finished: Promise<void>
  settleFinished: () => void
  lastEmit: number
  timer: NodeJS.Timeout | null
}

/** What one step of a run delivered, for either kind of command step. */
interface CommandOutcome {
  code: number | null
  output: string
  /**
   * A sentence when the step fails whatever its exit code was: programs it left could not be
   * stopped, or a check changed what it was meant to judge.
   */
  problem: string | null
}

/**
 * A copy of a run's work kept under refs/regatta/discarded/, and the branch name its note suggests for
 * restoring it. The name is chosen once, when the copy is made (free in the repository then, and not
 * suggested for another copy of the same run), and saved with the run, so the note does not change.
 */
interface KeptCopy {
  ref: string
  restore: string
}

/**
 * What a worktree add left behind when git reported an error after it had made something (a
 * post-checkout hook that fails does this): what git said, and which of the folder and the branch
 * are there now.
 */
interface Left {
  detail: string
  folder: boolean
  branch: boolean
}

/** What `makeWorktree` made. `left` is set when git reported an error but the folder or the branch is there all the same. */
interface Made {
  /** `worktreeIdentity` of the folder, read right after git stopped. Null when it could not be read: never removed. */
  identity: string | null
  left: Left | null
}

/** What a merge or a discard removed and what it kept instead. */
interface Released {
  worktrees: number
  branches: number
  kept: string[]
}

export class FlowEngine {
  private flowList: Flow[] = []
  private runList: FlowRun[] = []
  private readonly runtimes = new Map<string, Runtime>()
  /** What isolated runs created and have not released yet, by run id. Saved inside each run's file. */
  private readonly owned = new Map<string, Owned>()
  /**
   * Folders the engine must not remove, by path, with the run they belong to and why: the folder of a
   * program that could not be stopped, and a temporary folder that could not be taken away. Saved with
   * the run, so a restart does not forget them. Never removed.
   */
  private readonly held = new Map<string, { runId: string; reason: string }>()
  /** Check worktrees that exist right now, from before git makes them until they are taken away or held. */
  private readonly temporary = new Set<string>()
  /** The copies of a run's work that were kept, by run id. Saved with the run. */
  private readonly parked = new Map<string, KeptCopy[]>()
  /** What the last merge or discard of a run kept, and why, by run id. Replaced every time. */
  private readonly kept = new Map<string, string[]>()
  /** Problems of a run that still matter (its work could not be committed, programs of a plain run could not be stopped), by run id. */
  private readonly issues = new Map<string, string[]>()
  /** Runs with a merge or a discard under way. */
  private readonly busy = new Set<string>()
  /** Every run id handed out, claimed before any await so two starts never share one. */
  private readonly reserved = new Set<string>()
  /**
   * How many runs of each flow are starting, by flow id: from before the first await of `run()` until
   * the run is registered (or fails to start). Making a worktree takes as long as the user's hooks
   * take, and a flow must not be deleted meanwhile: the run would come up with no flow behind it.
   */
  private readonly starting = new Map<string, number>()
  /** True once the app is quitting: nothing new starts, and what is saved stays as it is. */
  private quitting = false

  constructor(private readonly deps: FlowEngineDeps) {
    this.load()
  }

  list(): Flow[] {
    return this.flowList.map((flow) => clone(flow))
  }

  /** Validates the flow, stores it and emits the full list. New flows get an id and a createdAt. */
  save(flow: Flow): Flow {
    const name = flow.name.trim()
    if (name.length === 0) throw new Error('A flow needs a name.')
    if (flow.steps.length > MAX_STEPS) throw new Error(`A flow has at most ${MAX_STEPS} steps.`)
    for (const step of flow.steps) {
      if (step.kind === 'agent' && (step.agent === null || step.prompt.trim().length === 0)) {
        throw new Error('Every agent step needs an agent and a prompt.')
      }
      if (step.kind === 'check' && step.command.trim().length === 0) {
        throw new Error('Every check step needs a command.')
      }
    }

    const now = Date.now()
    const found = flow.id ? this.flowList.findIndex((f) => f.id === flow.id) : -1
    const next: Flow = {
      ...flow,
      id: found >= 0 ? this.flowList[found]!.id : flow.id.trim().length > 0 ? flow.id : shortId(),
      createdAt: found >= 0 ? this.flowList[found]!.createdAt : flow.createdAt || now,
      updatedAt: now
    }
    if (found >= 0) this.flowList[found] = next
    else this.flowList.push(next)
    this.writeFlows()
    this.deps.emitFlows(this.list())
    return clone(next)
  }

  /**
   * Deletes a flow. Refused while any run of it is starting, live, or still owns a worktree, a branch
   * or a held folder: the flow is what that run's card, its merge and its discard hang on.
   */
  remove(id: string): void {
    const found = this.flowList.findIndex((f) => f.id === id)
    if (found < 0) return
    if ((this.starting.get(id) ?? 0) > 0 || this.runList.some((run) => run.flowId === id && this.mustKeep(run))) {
      throw new Error('This flow has a run that is still running or still holds a worktree; discard or merge it first.')
    }
    this.flowList.splice(found, 1)
    this.writeFlows()
    this.deps.emitFlows(this.list())
  }

  runs(): FlowRun[] {
    return this.runList.map((run) => clone(run))
  }

  /**
   * Every folder the engine owns or holds right now: the worktrees of its runs, the check worktrees
   * that exist at this moment, and the folders it must not remove. For Storage's list of what is in
   * use, so none of them is offered as a leftover.
   */
  busyPaths(): string[] {
    const paths = new Set<string>()
    for (const run of this.runList) if (run.worktree) paths.add(resolve(run.worktree))
    for (const path of this.temporary) paths.add(path)
    for (const path of this.held.keys()) if (existsSync(path)) paths.add(path)
    return [...paths]
  }

  /**
   * The app is quitting. From now on the engine starts no new step, check folder, check process or
   * end-of-run commit, and saves nothing more about a live run: the next start loads a run the quit
   * interrupted as stopped, like any other. New runs, merges and discards are refused; a merge or
   * discard already under way finishes. A hold is still saved, because it records a folder that must
   * not be removed. Synchronous, and safe to call again.
   */
  quit(): void {
    this.quitting = true
  }

  /** Throws when the app is quitting, so that nothing new gets started. */
  private ensureNotQuitting(): void {
    if (this.quitting) throw new Quitting()
  }

  /** Creates the run, hands back its first state and keeps going in the background. */
  async run(flowId: string): Promise<FlowRun> {
    this.ensureNotQuitting()
    const flow = this.flowList.find((f) => f.id === flowId)
    if (!flow) throw new Error('That flow is no longer here.')
    // Counted before anything is awaited, and until the run is registered or fails to start.
    this.starting.set(flow.id, (this.starting.get(flow.id) ?? 0) + 1)
    let counted = true
    const registered = (): void => {
      if (!counted) return
      counted = false
      const left = (this.starting.get(flow.id) ?? 1) - 1
      if (left > 0) this.starting.set(flow.id, left)
      else this.starting.delete(flow.id)
    }
    try {
      return await this.start(flow, registered)
    } finally {
      registered()
    }
  }

  /** Makes the run of a flow and registers it. Calls `registered` the moment the run is in the list. */
  private async start(flow: Flow, registered: () => void): Promise<FlowRun> {
    const detected = new Map(this.deps.agents().map((agent) => [agent.kind, agent]))
    for (const step of flow.steps) {
      if (step.kind !== 'agent' || step.agent === null) continue
      const agent = detected.get(step.agent)
      if (!agent?.installed) throw new Error(`Not installed: ${nameOf(step.agent)}.`)
    }

    const dir = resolve(this.deps.worktreesDir?.() ?? defaultWorktreesDir())
    let id: string
    let owned: Owned | null = null
    // Set when git reported an error after making the folder or the branch: they are the run's, and the run does not start.
    let left: Left | null = null
    if (flow.isolate) {
      const root = resolve(this.deps.root())
      if (!(await isRepoWithCommit(root))) {
        throw new Error('Isolated runs need a git repository with at least one commit.')
      }
      id = await this.freeId(root, dir)
      const made = await this.createRunWorktree(id, root, dir)
      owned = made.owned
      left = made.left
    } else {
      id = this.claimId()
    }

    const run: FlowRun = {
      id,
      flowId: flow.id,
      flowName: flow.name,
      isolated: flow.isolate,
      status: 'running',
      worktree: owned && (!left || left.folder) ? owned.worktree : null,
      branch: owned && (!left || left.branch) ? owned.branch : null,
      steps: flow.steps.map(
        (step): StepRun => ({
          stepId: step.id,
          status: 'pending',
          output: '',
          exitCode: null,
          startedAt: null,
          endedAt: null
        })
      ),
      startedAt: Date.now(),
      endedAt: null,
      mergeSummary: null
    }
    let settleFinished!: () => void
    const finished = new Promise<void>((resolve) => {
      settleFinished = resolve
    })
    const runtime: Runtime = {
      run,
      handle: null,
      cancelled: false,
      abort: new AbortController(),
      waiting: null,
      finished,
      settleFinished,
      lastEmit: 0,
      timer: null
    }
    if (owned) this.owned.set(id, owned)
    this.runList.unshift(run)
    this.runtimes.set(id, runtime)
    registered()
    // Saved even if the app has just started to quit: the worktree exists, and its record must too.
    runtime.lastEmit = Date.now()
    this.saveRun(run)
    this.emitRun(run)

    // The pipeline starts on a later tick so the run this returns still has every step pending.
    queueMicrotask(() => {
      void (left ? this.failedToStart(runtime, left) : this.execute(runtime, flow))
        .catch((err: unknown) => this.crashed(runtime, err))
        // A run whose last state cannot even be saved has nothing more to give.
        .catch(() => undefined)
        .finally(() => runtime.settleFinished())
    })
    return clone(run)
  }

  /** Stops the step that is running, if any. The run settles as stopped in the background. */
  stop(runId: string): void {
    const runtime = this.must(runId)
    if (runtime.cancelled) return
    if (runtime.run.status !== 'running' && runtime.run.status !== 'waiting') return
    runtime.cancelled = true
    runtime.abort.abort()
    runtime.handle?.stop()
    runtime.waiting?.()
    runtime.waiting = null
  }

  /** Lets a run continue that is waiting at an approval step. */
  approve(runId: string): void {
    const runtime = this.must(runId)
    if (runtime.cancelled || runtime.run.status !== 'waiting') return
    runtime.waiting?.()
    runtime.waiting = null
  }

  /**
   * Brings an isolated run's tested commit home and removes the run's worktree and branch where that
   * loses nothing. One merge or discard at a time per run and per repository. A refusal leaves the
   * run as it was (done), with its worktree and branch, and says why.
   */
  async merge(runId: string): Promise<MergeResult> {
    this.ensureNotQuitting()
    const run = this.mustRun(runId)
    if (!run.worktree && !run.branch) throw new Error('Only isolated runs can be merged.')
    if (run.mergeSummary) throw new Error('That run was already merged.')
    if (!run.worktree || !run.branch) throw new Error('That run was discarded, so there is nothing to merge.')
    if (run.status !== 'done') throw new Error('Only a finished run can be merged.')
    const owned = this.mustOwn(run)
    this.begin(runId)
    try {
      // The branch and commit are recorded now, when the merge is asked for, not when the lock frees up:
      // a branch the user switches to while this waits must not receive the change.
      await repoLockKey(owned.root) // fails closed before anything else is looked at
      const captured = await captureTarget(owned.root)
      return await withRepoLock(owned.root, () => this.mergeNow(run, owned, captured))
    } finally {
      this.busy.delete(runId)
    }
  }

  /**
   * The merge itself, alone in its repository. `captured` is the branch and commit seen when the
   * merge was asked for; mergeIntoCurrentBranch checks them again right before it writes. Only the
   * commit the run's work was committed at is ever merged, never a branch name that can move.
   */
  private async mergeNow(run: FlowRun, owned: Owned, captured: CapturedTarget): Promise<MergeResult> {
    if (run.status !== 'done' || !run.worktree || !run.branch) throw new Error('Only a finished run can be merged.')
    const root = owned.root
    const tip = owned.tip ?? owned.base
    const [ahead, stat] = await Promise.all([commitCount(root, owned.base, tip), diffBetween(root, owned.base, tip)])
    const outcome = await mergeIntoCurrentBranch(root, tip, `Merge flow ${run.id}`, captured, { scratchDir: owned.dir })
    const target = captured.branch

    // Only release anything once the merged work is really on the branch the user is on.
    if (!(await isAncestor(root, tip, `refs/heads/${target}`))) {
      throw new Error(`The merge finished, but ${target} does not contain the tested commit, so nothing was removed.`)
    }
    let released: Released
    try {
      released = await this.release(run, owned)
    } catch (err) {
      // The change is home; cleanup stopping early must not hide that. What was not released stays on the run.
      const text = `Cleanup stopped early: ${messageOf(err)}`
      released = { worktrees: 0, branches: 0, kept: [text] }
      this.kept.set(run.id, [text])
      this.refreshNotes(run)
    }
    run.mergeSummary = mergeSummary(target, ahead, stat, released, outcome)
    this.persist(run)
    return { merged: true, summary: run.mergeSummary }
  }

  /**
   * Stops a live run, waits for everything it started to stop, then removes the run's worktree and
   * branch where that loses nothing. What is kept (a folder with changes, one a program is using,
   * a branch that moved on) stays on the run with the reason in its notes.
   */
  async discard(runId: string): Promise<void> {
    this.ensureNotQuitting()
    const run = this.mustRun(runId)
    if (!run.worktree && !run.branch) throw new Error('That run has no worktree to discard.')
    const owned = this.mustOwn(run)
    const runtime = this.runtimes.get(runId)
    if (runtime && (run.status === 'running' || run.status === 'waiting')) this.stop(runId)
    // Agents and checks may still be running; nothing is removed under them.
    if (runtime?.cancelled) {
      let timer: NodeJS.Timeout | undefined
      const slow = new Promise<'slow'>((resolve) => {
        timer = setTimeout(() => resolve('slow'), WIND_DOWN_MS)
        timer.unref()
      })
      const outcome = await Promise.race([runtime.finished.then(() => 'ended' as const), slow])
      if (timer) clearTimeout(timer)
      if (outcome === 'slow') throw new Error('The run is still stopping. Try discarding again in a moment.')
    }
    this.begin(runId)
    try {
      await repoLockKey(owned.root) // fails closed
      await withRepoLock(owned.root, async () => {
        await this.release(run, owned)
        this.persist(run)
      })
    } finally {
      this.busy.delete(runId)
    }
  }

  /**
   * Ends a run whose worktree git stopped making: git said it failed, but the folder or the branch is
   * there. Both are recorded as the run's (with the folder's identity if it could be read), so a
   * discard looks at them like at any other run's, and nothing of what a hook wrote is committed or
   * removed here. No step starts; the first one is the one that failed, so the card says so.
   */
  private async failedToStart(runtime: Runtime, left: Left): Promise<void> {
    if (this.quitting) return
    const run = runtime.run
    const owned = this.owned.get(run.id)!
    const them = left.branch ? 'them' : 'it'
    const kept = left.folder
      ? `The folder${left.branch ? ` and its branch ${owned.branch} were` : ' was'} kept as git left ${them}`
      : `The folder is gone, and the branch ${owned.branch} that git made was kept`
    const next = !left.folder
      ? '; Discard keeps a copy of its commits and deletes it.'
      : owned.identity === null
        ? '. Regatta cannot tell whether the folder is the one git made, so it will not be removed.'
        : `; Discard removes ${them} when nothing in the folder is unsaved.`
    const sentence = `Git stopped while it was making ${owned.worktree} (${left.detail}), so the run was not started. ${kept}${next}`
    this.addIssue(run, sentence)
    const first = run.steps[0]
    if (first) {
      first.status = 'failed'
      first.endedAt = Date.now()
      first.output = sentence
    }
    for (const step of run.steps) if (step.status === 'pending') step.status = 'skipped'
    run.status = 'failed'
    run.endedAt = Date.now()
    this.flush(runtime)
  }

  // The pipeline itself: every step in order, each handing its output to the next.

  private async execute(runtime: Runtime, flow: Flow): Promise<void> {
    const run = runtime.run
    const env = this.deps.env()
    const owned = this.owned.get(run.id) ?? null
    const root = owned?.root ?? resolve(this.deps.root())
    // An isolated run works in the matching folder of its worktree, so a project opened below the top of the repository stays below it.
    const cwd = owned ? folderIn(owned.worktree, owned.prefix) : root
    // The run's own copy of the project's dependencies, so an agent can run the project's tests in it.
    if (owned) await this.provideFor(runtime, owned, owned.worktree, true)
    let previous = ''
    for (let i = 0; i < flow.steps.length; i++) {
      if (this.quitting) return
      if (runtime.cancelled) return this.endStopped(runtime)
      const step = flow.steps[i]!
      const stepRun = run.steps[i]!
      stepRun.status = 'running'
      stepRun.startedAt = Date.now()
      this.touch(runtime)
      try {
        if (step.kind === 'approval') {
          stepRun.status = 'waiting'
          run.status = 'waiting'
          this.touch(runtime)
          await new Promise<void>((resolve) => {
            runtime.waiting = resolve
          })
          if (this.quitting) return
          if (runtime.cancelled) return this.endStopped(runtime)
          stepRun.status = 'done'
          stepRun.output = 'Approved'
          stepRun.endedAt = Date.now()
          previous = stepRun.output
          this.touch(runtime)
          continue
        }
        if (step.kind === 'agent') {
          if (owned) {
            // Never run an agent in a folder that is not the one this run made (the user may have replaced it).
            assertOwnFolder(owned)
            mkdirSync(cwd, { recursive: true })
          }
          const detected = this.agentFor(step.agent)
          const lines: string[] = []
          this.ensureNotQuitting()
          const handle = this.deps.run({
            agent: detected.kind,
            command: detected.path ?? detected.command,
            baseArgs: detected.args,
            prompt: fillPrompt(step.prompt, flow.brief, previous),
            cwd,
            env,
            allowCommands: false,
            onActivity: (line) => {
              lines.push(line)
              stepRun.output = tail(lines.join('\n'), KEEP_LINES)
              this.touch(runtime)
            },
            onTokens: () => undefined
          })
          runtime.handle = handle
          if (runtime.cancelled) handle.stop()
          const result = await handle.done
          runtime.handle = null
          // Whatever the agent started and the stop could not end may still use this folder. That is
          // known before anything else is decided, even when the run was stopped meanwhile.
          const stuck = result.stuck ? this.stuck(runtime, nameOf(step.agent), owned?.worktree ?? root, owned !== null, true) : null
          if (this.quitting) return
          if (runtime.cancelled) return this.endStopped(runtime)
          stepRun.exitCode = result.exitCode
          stepRun.output = tail(lines.join('\n'), KEEP_LINES)
          stepRun.endedAt = Date.now()
          previous = stepRun.output
          if (stuck) {
            stepRun.status = 'failed'
            stepRun.output = withSentence(stepRun.output, stuck)
            return this.endFailed(runtime)
          }
          if (result.exitCode === 0) {
            stepRun.status = 'done'
          } else {
            stepRun.status = 'failed'
            return this.endFailed(runtime)
          }
          this.touch(runtime)
          continue
        }
        // A check runs through /bin/sh in its own process group: in the user's folder for a plain run,
        // in a temporary worktree at the run's committed tip for an isolated one.
        const result = await this.checkStep(runtime, owned, i, step.command, root, env)
        if (this.quitting) return
        if (runtime.cancelled) return this.endStopped(runtime)
        stepRun.exitCode = result.code
        stepRun.output = tail(result.output, KEEP_LINES)
        stepRun.endedAt = Date.now()
        previous = stepRun.output
        if (result.problem) {
          stepRun.status = 'failed'
          stepRun.output = withSentence(stepRun.output, result.problem)
          return this.endFailed(runtime)
        }
        if (result.code === 0) {
          stepRun.status = 'done'
        } else {
          stepRun.status = 'failed'
          return this.endFailed(runtime)
        }
        this.touch(runtime)
      } catch (err) {
        // A quit is not a failure of the step: the run stays as it was saved and loads as stopped next time.
        if (this.quitting || err instanceof Quitting) return
        if (runtime.cancelled) return this.endStopped(runtime)
        stepRun.status = 'failed'
        stepRun.endedAt = Date.now()
        stepRun.output = stepRun.output || messageOf(err)
        return this.endFailed(runtime)
      } finally {
        runtime.handle = null
      }
    }
    if (this.quitting) return
    return this.endDone(runtime)
  }

  /**
   * Runs one check command. In the user's folder for a plain run. For an isolated run: commits the
   * run's work first (so the check judges what a merge would bring), makes a temporary worktree at
   * that commit, runs there and removes it again, so the run's own folder stays exactly as the
   * agent and the user left it. A check that changed the commit it was judging fails, whatever its
   * exit code: its fixes die with the temporary folder, and the unfixed commit is what would merge.
   */
  private async checkStep(
    runtime: Runtime,
    owned: Owned | null,
    index: number,
    command: string,
    root: string,
    env: Record<string, string>
  ): Promise<CommandOutcome> {
    const shell = async (cwd: string, folder: string): Promise<CommandOutcome> => {
      // Right before the process starts, with nothing awaited in between.
      this.ensureNotQuitting()
      const result = await runShell(command, {
        cwd,
        env,
        signal: runtime.abort.signal,
        ...(this.deps.supervise ? { supervise: this.deps.supervise } : {})
      })
      return {
        code: result.code,
        output: result.output,
        problem: result.stuck ? this.stuck(runtime, 'The check', folder, owned !== null, false) : null
      }
    }
    if (!owned) return shell(root, root)

    const tip = await this.commitRun(runtime.run, owned)
    this.ensureNotQuitting()
    if (runtime.cancelled) return { code: null, output: '', problem: null }
    const path = join(owned.dir, `flow-${runtime.run.id}-check-${index + 1}`)
    const key = resolve(path)
    // In use from before git makes it, so a scan of the worktrees folder never takes it for a leftover.
    this.temporary.add(key)
    let made: Made
    try {
      made = await this.makeWorktree(owned.root, path, null, tip)
    } catch (err) {
      this.temporary.delete(key)
      throw err
    }
    if (made.left) {
      // Git stopped after it made the folder. It is a temporary copy of ours: taken away like any other, or held when that cannot be done.
      await this.releaseTemporary(runtime, owned, path, made.identity)
      return { code: null, output: '', problem: `Git stopped while it was making the temporary folder for the check (${made.left.detail}), so the check did not run.` }
    }
    const identity = made.identity
    try {
      const folder = folderIn(path, owned.prefix)
      mkdirSync(folder, { recursive: true })
      await this.provideFor(runtime, owned, path, false)
      const before = await trackedSnapshot(path)
      const outcome = await shell(folder, path)
      if (outcome.code === 0 && outcome.problem === null && !runtime.cancelled) {
        outcome.problem = await this.changedByCheck(owned, path, tip, before)
      }
      return outcome
    } finally {
      await this.releaseTemporary(runtime, owned, path, identity)
    }
  }

  /**
   * Gives a worktree its own copy of the project's node_modules (`provideModules`: a copy-on-write
   * clone, never a link, so `npm ci` or `rm -rf node_modules` run there cannot reach the user's own
   * dependencies). It goes at the top of the worktree, where the shared exemption for a worktree's own
   * copy looks and where Node finds it from any folder below. The run's copy is recorded with the run,
   * so removal knows it; when cloning is impossible the worktree gets none and the run's notes say so.
   */
  private async provideFor(runtime: Runtime, owned: Owned, worktree: string, record: boolean): Promise<void> {
    this.ensureNotQuitting()
    const provided = await provideModules(owned.root, worktree)
    if (provided.clone && record) {
      owned.modules = provided.clone
      // Recorded at once, quit or not: a copy nobody recorded would keep the worktree from ever being removed.
      if (this.quitting) this.writeRun(runtime.run)
      else this.saveRun(runtime.run)
    }
    if (provided.note) {
      this.addIssue(runtime.run, provided.note)
      this.touch(runtime)
    }
  }

  /**
   * What a check did to the commit it was meant to judge, as a sentence, or null when it left it
   * alone: it committed, it changed tracked files, or the run's branch moved meanwhile. Tracked files
   * are compared as bytes (and the index as git has it) before and after the check, not by what
   * `git status` calls them: a file that already shows as changed in a fresh checkout, or one whose
   * change the check hid from status, would otherwise let an edit through. Untracked output (builds,
   * coverage) is not a change.
   */
  private async changedByCheck(owned: Owned, path: string, tip: string, before: string): Promise<string | null> {
    if ((await headSha(path)) !== tip) return 'The check committed in its folder, so its result does not match the committed change.'
    if ((await trackedSnapshot(path)) !== before) return 'The check changed tracked files, so its result does not match the committed change.'
    if ((await branchTip(owned.root, owned.branch)) !== tip) {
      return "The run's branch moved while the check ran, so its result does not match the committed change."
    }
    return null
  }

  /**
   * Commits everything in the run's worktree on the run's branch and records the commit as the run's
   * tip. Refuses when the folder is not on that branch any more: the user can open it and switch, and
   * an add and a commit would then put the agent's work on their branch.
   */
  private async commitRun(run: FlowRun, owned: Owned): Promise<string> {
    this.ensureNotQuitting()
    assertOwnFolder(owned, 'so its work was not committed')
    // A merge, rebase or cherry-pick half done in the folder: an add and a commit would finish it in a way nobody chose.
    const busy = await operationInProgress(owned.worktree)
    if (busy) throw new Error(`A ${busy} is in progress in the run's folder, so its work was not committed.`)
    if ((await currentBranch(owned.worktree)) !== owned.branch) {
      throw new Error(`The run's folder is not on ${owned.branch} any more, so its work was not committed and cannot be checked or merged.`)
    }
    // The looks above take a moment: a quit that came meanwhile must not be followed by a commit.
    this.ensureNotQuitting()
    await commitAll(owned.worktree, `Flow run ${run.id}: ${run.flowName}`)
    // The branch's own commit, not whatever the folder's HEAD is by now: a switch right after the commit must not change what is tested.
    const tip = await branchTip(owned.root, owned.branch)
    if (owned.tip !== tip) {
      owned.tip = tip
      if (!this.quitting) this.saveRun(run)
    }
    return tip
  }

  /**
   * Commits the work of an isolated run that has ended, so its folder is clean and its result is on
   * its branch, the commit a merge brings in. Not when a program that could not be stopped may still
   * write there. Returns a sentence when the work could not be committed, null otherwise.
   */
  private async settle(runtime: Runtime): Promise<string | null> {
    const owned = this.owned.get(runtime.run.id)
    if (!owned || this.held.has(resolve(owned.worktree))) return null
    try {
      await this.commitRun(runtime.run, owned)
      return null
    } catch (err) {
      if (err instanceof Quitting) return null
      const text = messageOf(err)
      this.addIssue(runtime.run, text)
      return text
    }
  }

  private async endDone(runtime: Runtime): Promise<void> {
    if (this.quitting) return
    // The work is committed before the run is called done: a merge asked for right after must see it.
    const problem = this.owned.has(runtime.run.id) ? await this.settle(runtime) : null
    if (this.quitting) return
    runtime.run.status = problem ? 'failed' : 'done'
    runtime.run.endedAt = Date.now()
    this.flush(runtime)
  }

  /** A stopped run never finished the step it was on, so that step counts as skipped. */
  private async endStopped(runtime: Runtime): Promise<void> {
    if (this.quitting) return
    if (this.owned.has(runtime.run.id)) await this.settle(runtime)
    if (this.quitting) return
    for (const step of runtime.run.steps) {
      if (step.status === 'running' || step.status === 'waiting' || step.status === 'pending') {
        step.status = 'skipped'
      }
    }
    runtime.run.status = 'stopped'
    runtime.run.endedAt = Date.now()
    this.flush(runtime)
  }

  private async endFailed(runtime: Runtime): Promise<void> {
    if (this.quitting) return
    if (this.owned.has(runtime.run.id)) await this.settle(runtime)
    if (this.quitting) return
    for (const step of runtime.run.steps) {
      if (step.status === 'pending') step.status = 'skipped'
    }
    runtime.run.status = 'failed'
    runtime.run.endedAt = Date.now()
    this.flush(runtime)
  }

  /** The pipeline threw: settle the run as stopped when it was stopped, otherwise as failed on the step it was in. */
  private async crashed(runtime: Runtime, err: unknown): Promise<void> {
    const run = runtime.run
    if (this.quitting || err instanceof Quitting) return
    if (run.status !== 'running' && run.status !== 'waiting') return
    if (runtime.cancelled) return this.endStopped(runtime)
    const current = run.steps.find((s) => s.status === 'running' || s.status === 'waiting')
    if (current) {
      current.status = 'failed'
      current.endedAt = Date.now()
      current.output = current.output || messageOf(err)
    }
    return this.endFailed(runtime)
  }

  private agentFor(kind: AgentKind | null): DetectedAgent {
    const found = kind ? this.deps.agents().find((agent) => agent.kind === kind) : undefined
    if (!found?.installed) throw new Error(`${nameOf(kind)} is not installed.`)
    return found
  }

  // Worktrees and branches: only what this engine made, only through the shared mechanisms.

  /**
   * Notes that programs of a step could not be stopped, and returns the sentence. For an isolated run
   * the folder they may still use (the run's worktree, or a check's temporary one) is held: it is
   * never removed. A plain run works in the user's own folder, which is never removed anyway, so it
   * only gets the warning.
   */
  private stuck(runtime: Runtime, who: string, folder: string, isolated: boolean, hasBranch: boolean): string {
    if (isolated) {
      const kept = hasBranch ? 'the folder and its branch were kept' : 'the folder was kept'
      const reason = `${who} left programs running in ${folder} that could not be stopped, so ${kept}.`
      this.hold(runtime, folder, reason)
      return reason
    }
    const reason = `${who} left programs running that could not be stopped. They may still change files in your folder, so check what is running.`
    this.addIssue(runtime.run, reason)
    this.touch(runtime)
    return reason
  }

  /** Marks a folder as one the engine must not remove (programs may still use it), and saves that with the run. */
  private hold(runtime: Runtime, path: string, reason: string): void {
    this.held.set(resolve(path), { runId: runtime.run.id, reason })
    this.refreshNotes(runtime.run)
    // Saved at once: a hold that only reached memory would be forgotten by a crash or a quit. It is
    // the one thing still saved when the app is quitting, because it records a folder that must not be removed.
    if (this.quitting) this.writeRun(runtime.run)
    else this.saveRun(runtime.run)
    this.touch(runtime)
  }

  /** Records a problem of the run itself that still matters, once. */
  private addIssue(run: FlowRun, text: string): void {
    const issues = this.issues.get(run.id) ?? []
    if (!issues.includes(text)) this.issues.set(run.id, [...issues, text])
    this.refreshNotes(run)
  }

  /**
   * Builds the run's notes from what is true now: problems of the run itself, the folders held, what
   * the last merge or discard kept, and where copies of its work were parked. Nothing is carried over
   * from before, so a reason that no longer holds is gone from the notes.
   */
  private refreshNotes(run: FlowRun): void {
    const lines = new Set<string>(this.issues.get(run.id) ?? [])
    for (const [path, entry] of this.held) if (entry.runId === run.id && existsSync(path)) lines.add(entry.reason)
    for (const line of this.kept.get(run.id) ?? []) lines.add(line)
    for (const copy of this.parked.get(run.id) ?? []) lines.add(parkedSentence(copy))
    if (lines.size > 0) run.notes = [...lines]
    else delete run.notes
  }

  /**
   * Makes a worktree on a folder that did not exist a moment ago, one at a time per repository: the
   * folder is made exclusively (it fails if anything is there, even an empty folder), then git fills
   * it. A branch is made when given, otherwise the worktree is detached at `base`. Returns the
   * identity of the new worktree, read right after git made it. Nothing is claimed when this throws.
   *
   * Git can report an error after it made the worktree and the branch: a post-checkout hook of the
   * user's that writes a file and exits with an error does that, and a checkout that fails leaves the
   * branch. What is there then is ours to look after, not to forget, so this returns it as `left`
   * (with the folder's identity if that can be read) instead of throwing.
   */
  private async makeWorktree(root: string, path: string, branch: string | null, base: string): Promise<Made> {
    this.ensureNotQuitting()
    mkdirSync(resolve(path, '..'), { recursive: true })
    return withRepoLock(root, async () => {
      if (branch && (await branchExists(root, branch))) throw new Error(`The branch ${branch} already exists, so it was left alone.`)
      // Waiting for the lock can take a while, and so can the look above: a quit that came meanwhile starts no folder.
      this.ensureNotQuitting()
      try {
        mkdirSync(path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`The folder ${path} is already there, so it was left alone.`)
        throw err
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
        // The branch did not exist a moment ago (looked at above, under the lock), so one that is there now is git's.
        const folder = await lstat(path).then(
          () => true,
          () => false
        )
        const made = branch !== null && (await branchExists(root, branch).catch(() => false))
        if (!folder && !made) throw err
        return { identity: folder ? worktreeIdentity(path) : null, left: { detail: gitDetail(err), folder, branch: made } }
      }
      return { identity: worktreeIdentity(path), left: null }
    })
  }

  /** Creates the worktree and branch of an isolated run, at the commit the user's folder is on. */
  private async createRunWorktree(id: string, root: string, dir: string): Promise<{ owned: Owned; left: Left | null }> {
    const branch = `regatta/flow-${id}`
    const worktree = join(dir, `flow-${id}`)
    const base = await headSha(root)
    // Asked of git, not worked out from paths: the folder may be reached through a symlink (/var and /private/var).
    const prefix = (await git(['rev-parse', '--show-prefix'], root)).replace(/\r?\n$/, '').replace(/\/+$/, '')
    const made = await this.makeWorktree(root, worktree, branch, base)
    return { owned: { root, dir, worktree, branch, identity: made.identity, base, tip: null, prefix, modules: null }, left: made.left }
  }

  /**
   * Removes a temporary worktree (a check's) if it is still the one we made. One that cannot be taken
   * away is held, with the reason: it stays, and the engine says so.
   */
  private async releaseTemporary(runtime: Runtime, owned: Owned, path: string, identity: string | null): Promise<void> {
    const key = resolve(path)
    try {
      // Programs may still use it: never removed.
      if (this.held.has(key)) return
      try {
        const result = await withRepoLock(owned.root, () =>
          removeOwnedWorktree({ root: owned.root, path, identity, dir: owned.dir, disposable: true })
        )
        if (result.status === 'kept' || result.status === 'foreign') {
          this.hold(runtime, path, result.reason ?? `The temporary folder ${path} was kept.`)
        }
      } catch (err) {
        this.hold(runtime, path, `The temporary folder ${path} could not be removed (${messageOf(err)}), so it was kept.`)
      }
    } finally {
      this.temporary.delete(key)
    }
  }

  /**
   * Releases what an isolated run created: its worktree only while it is still the one we made and
   * nothing is held, using it or unsaved in it (removeOwnedWorktree), then its branch only while it
   * still points where we left it (deleteOwnedBranch, which parks its commits first). A worktree that
   * was kept keeps its branch too. What is kept stays listed on the run, with the reason, and the
   * next call looks at it again; the run's notes are rebuilt from this look. Callers hold the
   * repository lock.
   */
  private async release(run: FlowRun, owned: Owned): Promise<Released> {
    const kept: string[] = []
    let worktrees = 0
    let branches = 0
    let released = true
    let copy: KeptCopy | null = null
    // This look at the run replaces what was said about its own problems before.
    this.issues.delete(run.id)
    if (run.worktree) {
      const path = resolve(owned.worktree)
      const held = this.held.get(path)
      if (held && existsSync(path)) {
        kept.push(held.reason)
        released = false
      } else {
        // A held folder that is gone has nothing left to hold.
        if (held) this.held.delete(path)
        const result = await trashOwnedWorktree({
          root: owned.root,
          path: owned.worktree,
          branch: owned.branch,
          identity: owned.identity,
          dir: owned.dir,
          keepAs: `flow-${run.id}`,
          modulesClone: owned.modules
        })
        if (result.status === 'trashed') {
          worktrees++
          run.worktree = null
          run.branch = null
          released = false
          kept.push(
            `Moved its worktree to Regatta's trash (${result.trashPath}). Its branch ${owned.branch} stays until you empty the trash in Settings > Storage.`
          )
          if (result.keepRef) {
            const copies = this.parked.get(run.id) ?? []
            copy = copies.find((one) => one.ref === result.keepRef) ?? { ref: result.keepRef, restore: await this.freeRestoreName(owned.root, run.id) }
            if (!copies.includes(copy)) this.parked.set(run.id, [...copies, copy])
          }
        } else if (result.status === 'removed') {
          worktrees++
          run.worktree = null
        } else if (result.status === 'gone') {
          run.worktree = null
        } else if (result.status === 'foreign') {
          // Another folder sits there now. It stays on the run with the reason, so the next discard
          // looks at it again; our branch is judged on its own.
          kept.push(result.reason ?? `${owned.worktree} is not the worktree Regatta made any more, so it was left alone.`)
        } else {
          kept.push(result.reason ?? `${owned.worktree} was kept.`)
          released = false
        }
      }
    }
    if (released && run.branch) {
      // The commit the run's work was committed at, or the start commit for a run that never committed.
      // Its commits are parked first, so nothing the run (or the user, in it) committed becomes unreachable.
      const outcome = await deleteOwnedBranch(owned.root, owned.branch, owned.tip ?? owned.base, { parkAs: `flow-${run.id}` })
      if (outcome.deleted) branches++
      if (outcome.parked) {
        const copies = this.parked.get(run.id) ?? []
        copy = copies.find((one) => one.ref === outcome.parked) ?? { ref: outcome.parked, restore: await this.freeRestoreName(owned.root, run.id) }
        if (!copies.includes(copy)) this.parked.set(run.id, [...copies, copy])
      }
      if (outcome.reason) {
        // Still ours to deal with: the next discard tries the branch again.
        kept.push(outcome.reason)
      } else {
        // Gone, or deleted now: a branch someone recreates under the same name later is never touched.
        run.branch = null
      }
    }
    if (!run.worktree && !run.branch) this.owned.delete(run.id)
    this.kept.set(run.id, kept)
    this.refreshNotes(run)
    return { worktrees, branches, kept: copy ? [...kept, parkedSentence(copy)] : kept }
  }

  /**
   * A branch name the note can give for restoring a kept copy: flow-<id>-restored, or -2, -3 and so on
   * when a branch of that name exists in the repository or another copy of this run already suggests it.
   * A real name, because a placeholder like <name> pasted into a shell is read as a redirect.
   */
  private async freeRestoreName(root: string, runId: string): Promise<string> {
    const used = new Set((this.parked.get(runId) ?? []).map((copy) => copy.restore))
    for (let n = 1; n < 1000; n++) {
      const name = `flow-${runId}-restored${n === 1 ? '' : `-${n}`}`
      if (!used.has(name) && !(await branchExists(root, name))) return name
    }
    return `flow-${runId}-restored-${Date.now()}`
  }

  /** The record of what an isolated run created. A run without one was made by a version that did not keep it: nothing of it is touched. */
  private mustOwn(run: FlowRun): Owned {
    const owned = this.owned.get(run.id)
    if (!owned) {
      throw new Error(
        'Regatta has no record of the worktree this run made (an older version started it), so it will not merge or remove it. Remove the folder yourself if you no longer need it.'
      )
    }
    return owned
  }

  /** Claims the run for one merge or discard. A second request while one runs is refused. */
  private begin(runId: string): void {
    if (this.busy.has(runId)) throw new Error('A merge or discard is already running for this run.')
    this.busy.add(runId)
  }

  // Ids.

  /** A run id nobody has used yet in this engine, claimed before any await. */
  private claimId(): string {
    const make = this.deps.newId ?? shortId
    for (let i = 0; i < ID_TRIES; i++) {
      const id = make()
      if (this.reserved.has(id) || this.runList.some((r) => r.id === id)) continue
      this.reserved.add(id)
      return id
    }
    throw new Error('Could not find a free name for this run. Try again.')
  }

  /**
   * A run id whose branch and folder nobody uses yet, so the run can never reach someone else's
   * work. The id is claimed before any await, so two starts never get the same one.
   */
  private async freeId(root: string, dir: string): Promise<string> {
    for (let i = 0; i < ID_TRIES; i++) {
      const id = this.claimId()
      if ((await branchesWithPrefix(root, `regatta/flow-${id}`)).length > 0) continue
      if (existsSync(dir) && readdirSync(dir).some((name) => name === `flow-${id}` || name.startsWith(`flow-${id}-`))) continue
      return id
    }
    throw new Error('Could not find a free name for this run. Try again.')
  }

  // Saving and loading.

  private load(): void {
    this.flowList = this.readFlows()
    this.runList = this.readRuns()
  }

  private flowsFile(): string {
    return join(this.deps.dataDir, 'flows.json')
  }

  private runsDir(): string {
    return join(this.deps.dataDir, 'flow-runs')
  }

  private writeFlows(): void {
    mkdirSync(this.deps.dataDir, { recursive: true })
    writeFileSync(this.flowsFile(), JSON.stringify(this.flowList, null, 2))
  }

  private readFlows(): Flow[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.flowsFile(), 'utf8'))
      return Array.isArray(parsed) ? (parsed as Flow[]) : []
    } catch {
      return []
    }
  }

  private readRuns(): FlowRun[] {
    let files: string[] = []
    try {
      files = readdirSync(this.runsDir()).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
    const runs: FlowRun[] = []
    const settled: FlowRun[] = []
    for (const file of files) {
      try {
        const { owned, held, parked, ...saved } = JSON.parse(readFileSync(join(this.runsDir(), file), 'utf8')) as FlowRun & {
          owned?: unknown
          held?: unknown
          parked?: unknown
        }
        const run = this.recovered(saved)
        const own = asOwned(owned)
        if (own) this.owned.set(run.id, own)
        // Runs saved before the field existed are isolated when they own a worktree or a branch.
        if (typeof (run as { isolated?: unknown }).isolated !== 'boolean') run.isolated = own !== null || run.worktree !== null || run.branch !== null
        // A folder that is gone has nothing left to hold.
        for (const [path, reason] of Object.entries(asHeld(held))) if (existsSync(path)) this.held.set(path, { runId: run.id, reason })
        const copies = asParked(parked, run.id)
        if (copies.length > 0) this.parked.set(run.id, copies)
        runs.push(run)
        if (run !== saved) settled.push(run)
      } catch {
        // A run file that no longer parses is skipped rather than losing the rest.
      }
    }
    // A run the app quit on is saved as the stopped run it loaded as.
    for (const run of settled) this.writeRun(run)
    runs.sort((a, b) => b.startedAt - a.startedAt)
    return this.prune(runs)
  }

  /** A run interrupted by a quit never finished: it loads as stopped, its open steps as skipped. */
  private recovered(run: FlowRun): FlowRun {
    if (run.status !== 'running' && run.status !== 'waiting') return run
    const next = clone(run)
    next.status = 'stopped'
    for (const step of next.steps) {
      if (step.status === 'running' || step.status === 'waiting') step.status = 'skipped'
    }
    return next
  }

  /**
   * Keeps the newest runs and forgets the rest, on disk and in memory, except a run that is still
   * running or waiting, or that still owns a worktree, a branch or a held folder: its record is the
   * only proof of what it may merge or remove, so it stays however old it is.
   */
  private prune(runs: FlowRun[]): FlowRun[] {
    const kept: FlowRun[] = []
    runs.forEach((run, index) => {
      if (index < MAX_RUNS || this.mustKeep(run)) {
        kept.push(run)
        return
      }
      rmSync(join(this.runsDir(), `${run.id}.json`), { force: true })
      this.forget(run.id)
    })
    this.runList = kept
    return kept
  }

  private mustKeep(run: FlowRun): boolean {
    if (run.status === 'running' || run.status === 'waiting') return true
    if (run.worktree !== null || run.branch !== null || this.owned.has(run.id)) return true
    for (const [path, entry] of this.held) if (entry.runId === run.id && existsSync(path)) return true
    return false
  }

  /** Drops everything the engine remembers about a run that was forgotten. */
  private forget(id: string): void {
    this.owned.delete(id)
    for (const [path, entry] of this.held) if (entry.runId === id) this.held.delete(path)
    this.parked.delete(id)
    this.kept.delete(id)
    this.issues.delete(id)
  }

  /** The folders held for a run, by path, with the reason. */
  private heldOf(id: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [path, entry] of this.held) if (entry.runId === id) out[path] = entry.reason
    return out
  }

  /** Writes a run to its file in one step (a file written halfway would lose what the run owns). */
  private writeRun(run: FlowRun): void {
    mkdirSync(this.runsDir(), { recursive: true })
    const file = join(this.runsDir(), `${run.id}.json`)
    // What the engine must remember about the run besides the run itself: what it owns, what it holds, where copies were parked.
    const extra: Record<string, unknown> = {}
    const owned = this.owned.get(run.id)
    if (owned) extra['owned'] = owned
    const held = this.heldOf(run.id)
    if (Object.keys(held).length > 0) extra['held'] = held
    const parked = this.parked.get(run.id)
    if (parked && parked.length > 0) extra['parked'] = parked
    const temp = `${file}.tmp`
    writeFileSync(temp, JSON.stringify({ ...run, ...extra }, null, 2))
    renameSync(temp, file)
  }

  private saveRun(run: FlowRun): void {
    this.writeRun(run)
    const index = this.runList.findIndex((r) => r.id === run.id)
    if (index >= 0) this.runList[index] = run
    else this.runList.unshift(run)
    this.prune(this.runList)
  }

  private emitRun(run: FlowRun): void {
    this.deps.emitRun(clone(run))
  }

  /** Saves a run and tells the window, for changes that do not come from a live pipeline. */
  private persist(run: FlowRun): void {
    this.saveRun(run)
    this.emitRun(run)
  }

  private mustRun(id: string): FlowRun {
    const run = this.runList.find((r) => r.id === id)
    if (!run) throw new Error('That run is no longer here.')
    return run
  }

  private must(id: string): Runtime {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('That run is no longer here.')
    return runtime
  }

  /** Queues an update, keeping no more than four emissions a second. */
  private touch(runtime: Runtime): void {
    if (this.quitting) return
    const wait = EMIT_MS - (Date.now() - runtime.lastEmit)
    if (wait <= 0) return this.flush(runtime)
    if (runtime.timer) return
    runtime.timer = setTimeout(() => {
      runtime.timer = null
      this.flush(runtime)
    }, wait)
    runtime.timer.unref()
  }

  /** Emits right now, saves, and always the state the caller sees. */
  private flush(runtime: Runtime): void {
    if (runtime.timer) {
      clearTimeout(runtime.timer)
      runtime.timer = null
    }
    // Once the app is quitting what is saved stays as it is: the next start loads an interrupted run as stopped.
    if (this.quitting) return
    runtime.lastEmit = Date.now()
    this.saveRun(runtime.run)
    this.emitRun(runtime.run)
  }
}

/** Reads back what a run file says its run owns. Anything that is not exactly that shape is no record. */
function asOwned(value: unknown): Owned | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0
  const maybe = (x: unknown): x is string | null => x === null || typeof x === 'string'
  if (!text(v['root']) || !text(v['dir']) || !text(v['worktree']) || !text(v['branch']) || !text(v['base'])) return null
  if (!maybe(v['identity']) || !maybe(v['tip'])) return null
  // Records made before the prefix was kept belong to runs at the top of the repository.
  const prefix = v['prefix'] ?? ''
  if (typeof prefix !== 'string' || isAbsolute(prefix) || prefix.split('/').includes('..')) return null
  // Records made before the copy was kept have none.
  const copy = v['modules'] ?? null
  let modules: ModulesClone | null = null
  if (copy !== null) {
    const m = typeof copy === 'object' ? (copy as Record<string, unknown>) : null
    if (!m || typeof m['ino'] !== 'number' || typeof m['birthtimeMs'] !== 'number') return null
    modules = { ino: m['ino'], birthtimeMs: m['birthtimeMs'] }
  }
  return {
    root: v['root'],
    dir: v['dir'],
    worktree: v['worktree'],
    branch: v['branch'],
    identity: v['identity'],
    base: v['base'],
    tip: v['tip'],
    prefix,
    modules
  }
}

/** The folders a run file says are held, by path. Anything that is not a text for a text is ignored. */
function asHeld(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof value !== 'object' || value === null) return out
  for (const [path, reason] of Object.entries(value as Record<string, unknown>)) {
    if (typeof reason === 'string' && path.length > 0) out[path] = reason
  }
  return out
}

/**
 * The copies of its work a run file says were kept. Files from before the restore name was kept hold
 * plain refs; they get the first name the note would have suggested.
 */
function asParked(value: unknown, runId: string): KeptCopy[] {
  if (!Array.isArray(value)) return []
  const copies: KeptCopy[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.startsWith('refs/')) {
      copies.push({ ref: entry, restore: `flow-${runId}-restored${copies.length === 0 ? '' : `-${copies.length + 1}`}` })
    } else if (typeof entry === 'object' && entry !== null) {
      const { ref, restore } = entry as Record<string, unknown>
      if (typeof ref === 'string' && ref.startsWith('refs/') && typeof restore === 'string' && restore.length > 0) copies.push({ ref, restore })
    }
  }
  return copies
}

/** The matching folder of a worktree for a project that sits `prefix` below the top of the repository. */
function folderIn(base: string, prefix: string): string {
  return prefix ? join(base, prefix) : base
}

/** True when the folder at the run's path is still the worktree git made for it (old records of the same folder count). */
function ownFolder(owned: Owned): boolean {
  // An identity that could not be read at the start proves nothing either way; such a folder is simply never removed.
  return owned.identity === null || sameWorktree(owned.worktree, owned.identity)
}

/** Refuses to go on in a folder that is not the one the run made. */
function assertOwnFolder(owned: Owned, consequence = 'so nothing was run in it'): void {
  if (!ownFolder(owned)) throw new Error(`The run's folder is not the worktree Regatta made any more, ${consequence}.`)
}

/**
 * A fingerprint of everything git tracks in a folder, as bytes: the index as git has it (mode, blob and
 * stage of every path) and, for every tracked path, what is on disk (the file's own bytes and mode, a
 * link's target, or that it is missing). Compared before and after a check. A status label cannot tell a
 * further edit of a file that already shows as changed, and an edit can be hidden from status; bytes
 * cannot be hidden. Files are read as streams a few at a time, so a large tree neither fills memory
 * nor holds up the app.
 */
async function trackedSnapshot(folder: string): Promise<string> {
  const listing = await git(['ls-files', '-s', '-z'], folder)
  const names = new Set<string>()
  for (const entry of listing.split('\0')) {
    const tab = entry.indexOf('\t')
    if (tab > 0) names.add(entry.slice(tab + 1))
  }
  const hash = createHash('sha256')
  hash.update(listing)
  const records = await mapLimit([...names].sort(), 32, async (name) => `${name}\0${await onDisk(join(folder, name))}\n`)
  for (const record of records) hash.update(record)
  return hash.digest('hex')
}

/** What is at a path, as a line of text: a file's mode, size and the hash of its bytes, a link's target, or that it is missing. */
async function onDisk(path: string): Promise<string> {
  const stat = await lstat(path).catch(() => null)
  if (!stat) return 'missing'
  const mode = (stat.mode & 0o7777).toString(8)
  if (stat.isSymbolicLink()) return `link ${mode} ${await readlink(path)}`
  // A folder here is a submodule: the index entry says what it is at. Other special files have no bytes to read.
  if (!stat.isFile()) return `other ${mode}`
  try {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return `file ${mode} ${stat.size} ${hash.digest('hex')}`
  } catch {
    // A file the check made unreadable is a different file from the one that was there, and that is all this has to say.
    return `unreadable ${mode} ${stat.size}`
  }
}

/** Runs at most `limit` of `fn` at a time and keeps the order of the results. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]!)
  })
  await Promise.all(workers)
  return results
}

/**
 * Where a copy of the run's work is kept and how to get it back. The ref holds a keep commit with an
 * empty tree whose parents are the commits kept: the tip is its first parent (`^1`), so that is what
 * a branch is made from, and `git log` of the ref lists everything kept. The branch has a real name,
 * because a placeholder pasted into a shell is read as a redirect. The restore command is closed off
 * by the parenthesis, so a window that copies "the git command in the note" copies just that command.
 */
function parkedSentence(copy: KeptCopy): string {
  return `Kept a copy of the run's work at ${copy.ref} (restore the work with git branch ${copy.restore} ${copy.ref}^1). git log ${copy.ref} shows everything kept.`
}

/**
 * What git said when it stopped, in its own words: what it (and a hook) printed, without the progress
 * lines that come first. Short, because it goes into a sentence.
 */
function gitDetail(err: unknown): string {
  const stderr = err instanceof Error ? String((err as Error & { stderr?: unknown }).stderr ?? '') : ''
  const said = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(Preparing worktree|HEAD is now at|Updating files)/.test(line))
    .slice(0, 3)
    .join(' ')
  if (said.length === 0) return 'git did not say why'
  return said.length > 200 ? `${said.slice(0, 197)}...` : said
}

/** Lowercase letters and digits, short enough for a branch name and a folder name. */
function shortId(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789'
  let id = ''
  for (let i = 0; i < ID_LENGTH; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)]
  return id
}

function mergeSummary(
  target: string,
  ahead: number,
  stat: DiffStat,
  removed: Released,
  outcome: { fastForward: boolean; alreadyMerged: boolean }
): string {
  const size = `+${stat.added} -${stat.removed} in ${plural(stat.files, 'file', 'files')}`
  const lead = outcome.alreadyMerged
    ? `${target} already had this change, so nothing was merged.`
    : outcome.fastForward
      ? `Fast-forwarded ${target} by ${plural(ahead, 'commit', 'commits')} (${size}).`
      : `Merged into ${target} with ${plural(ahead, 'commit', 'commits')} (${size}).`
  const notes = removed.kept.join(' ')
  // A parked note already starts with "Kept", so the label would read "Kept: Kept a copy..."; every
  // other note keeps the label. The note text itself is never changed, because the UI reads git commands from it.
  const kept = removed.kept.length > 0 ? (notes.startsWith('Kept') ? ` ${notes}` : ` Kept: ${notes}`) : ''
  return `${lead} Removed ${plural(removed.worktrees, 'worktree', 'worktrees')} and ${plural(removed.branches, 'branch', 'branches')}.${kept}`
}

function withSentence(output: string, sentence: string): string {
  return output ? `${output}\n${sentence}` : sentence
}

function nameOf(kind: AgentKind | null): string {
  return (kind && AGENTS[kind]?.name) || 'That agent'
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
