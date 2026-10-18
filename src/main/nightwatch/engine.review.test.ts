// The findings of the review of the night engine, each as the sequence that was found: a merge target
// recorded only after a wait, a run's folder lost between git and the disk, a history limit that forgot
// folders still on disk, and a project below the top of its repository. Real git, real processes; a few
// git helpers are wrapped so a test can act at the exact moment between two steps.

import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '../../shared/agents'
import type { CheckSpec } from '../../shared/heats'
import type { NightTask, NightTaskRun } from '../../shared/nightwatch'
import type { AgentKind } from '../../shared/types'
import { emptyTrash, listTrash } from '../heats/git-ops'
import { NightWatch as RealNightWatch } from './engine'
import type { NightWatchDeps } from './engine'
import type { RunHandle, RunOptions, RunResult } from '../heats/runner'

const hooks = vi.hoisted(() => ({
  /** Runs right after the branch and commit were recorded for a merge. */
  afterCapture: null as null | (() => void),
  /** Runs inside the repository lock, right after the check for an existing branch, before the folder is made. */
  afterBranchCheck: null as null | ((branch: string) => void),
  /** Runs right before git is asked to make the folder of a run, with its path. */
  beforeAddWorktree: null as null | ((path: string) => void),
  /** Runs right after git made the folder of a run, with its path. */
  afterAddWorktree: null as null | ((path: string) => void),
  /** Runs right after the engine measured the committed change of a run, when it is about to make the folder for its checks. */
  afterDiffBetween: null as null | (() => void),
  /** Makes the checks that ran in a folder whose name ends like this report a process that could not be stopped. */
  stuckIn: null as null | string,
  /** Runs right before a saved file is replaced by its new version: the path being replaced, and the finished temporary file that replaces it. */
  beforeRename: null as null | ((target: string, from: string) => void)
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: import('node:fs').PathLike, to: import('node:fs').PathLike) => {
      hooks.beforeRename?.(String(to), String(from))
      return actual.renameSync(from, to)
    }
  }
})

vi.mock('../heats/git-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../heats/git-ops')>()
  return {
    ...actual,
    captureTarget: async (...args: Parameters<typeof actual.captureTarget>) => {
      const captured = await actual.captureTarget(...args)
      hooks.afterCapture?.()
      return captured
    },
    branchExists: async (cwd: string, branch: string) => {
      const result = await actual.branchExists(cwd, branch)
      hooks.afterBranchCheck?.(branch)
      return result
    },
    diffBetween: async (...args: Parameters<typeof actual.diffBetween>) => {
      const result = await actual.diffBetween(...args)
      hooks.afterDiffBetween?.()
      return result
    },
    addWorktree: async (...args: Parameters<typeof actual.addWorktree>) => {
      hooks.beforeAddWorktree?.(args[1])
      const result = await actual.addWorktree(...args)
      hooks.afterAddWorktree?.(args[1])
      return result
    }
  }
})

vi.mock('../heats/checks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../heats/checks')>()
  return {
    ...actual,
    runChecks: async (...args: Parameters<typeof actual.runChecks>) => {
      const results = await actual.runChecks(...args)
      const folder = args[1]
      return hooks.stuckIn && folder.endsWith(hooks.stuckIn) ? results.map((result) => ({ ...result, stuck: true })) : results
    }
  }
})

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']
const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }
const HOUR = 60 * 60 * 1000
const CHECKS: CheckSpec[] = [
  { name: 'done', command: 'test -f DONE.txt', kind: 'required' },
  { name: 'guard', command: 'test -f GUARD.txt', kind: 'guard' }
]

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 })
}

const dirs: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Every engine this file made. They are stopped before their folders are removed, or they would make the folders again. */
const engines: NightWatch[] = []
class NightWatch extends RealNightWatch {
  constructor(deps: NightWatchDeps) {
    super(deps)
    engines.push(this)
  }
}

/** Stops every engine this file made and waits for it to finish what it was doing, then removes the folders it used. */
async function cleanUp(): Promise<void> {
  for (const engine of engines.splice(0)) {
    let timer: NodeJS.Timeout | undefined
    try {
      engine.cancel()
      await Promise.race([
        engine.whenIdle(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000)
        })
      ])
    } catch {
      // Its folders may be gone, or blocked by the test itself: nothing more can be done for it.
    } finally {
      clearTimeout(timer)
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

beforeEach(() => {
  hooks.afterCapture = null
  hooks.afterBranchCheck = null
  hooks.beforeAddWorktree = null
  hooks.afterAddWorktree = null
  hooks.afterDiffBetween = null
  hooks.stuckIn = null
  hooks.beforeRename = null
})
afterEach(() => {
  vi.useRealTimers()
})
afterAll(cleanUp)

/** What a fake agent does. */
interface Behavior {
  /** Runs as soon as the agent starts. */
  early?: (opts: RunOptions) => void
  /** What the agent writes into its folder before it finishes. */
  write?: (cwd: string) => void
  /** The agent does not finish by itself: once it is stopped it ends when this settles. */
  hang?: Promise<void>
  /** Its run ends with some of its processes still alive (the supervisor gave up on them). */
  stuck?: boolean
}
type Behave = (opts: RunOptions) => Behavior

/** The change a good agent makes: the file the checks look for, and an edit to the project. */
function finished(cwd: string): void {
  writeFileSync(join(cwd, 'DONE.txt'), 'done\n')
  mkdirSync(join(cwd, 'src'), { recursive: true })
  appendFileSync(join(cwd, 'src', 'app.js'), '// changed by the agent\n')
}

const GOOD: Behave = () => ({ write: finished })

interface Deferred {
  promise: Promise<void>
  open: () => void
}
function gate(): Deferred {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

type Layout = 'top' | 'app' | 'newapp'

interface Harness {
  engine: NightWatch
  /** The repository's top folder. */
  repo: string
  /** The project folder the engine is given: the top, or `app` below it. */
  root: string
  dataDir: string
  worktrees: string
  /** Every run an engine of this harness started. */
  runs: RunOptions[]
  deps: NightWatchDeps
}

/**
 * A repository and an engine for it. `top`: the project is the whole repository. `app`: the project is
 * the repository's app folder, which holds the files the checks look for. `newapp`: the app folder is
 * on disk but the commit has nothing in it.
 */
function makeHarness(options: { layout?: Layout; behave?: Behave; prepare?: (root: string) => void; dataDir?: string; patch?: Partial<NightWatchDeps> } = {}): Harness {
  const layout = options.layout ?? 'top'
  const repo = temp('regatta-night-review-')
  sh(['init', '-b', 'main'], repo)
  sh(['config', 'user.name', 'Regatta Test'], repo)
  sh(['config', 'user.email', 'test@regatta.local'], repo)
  writeFileSync(join(repo, 'README.md'), 'a repository\n')
  const root = layout === 'top' ? repo : join(repo, 'app')
  mkdirSync(root, { recursive: true })
  if (layout !== 'newapp') {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'GUARD.txt'), 'guard\n')
    writeFileSync(join(root, 'src', 'app.js'), 'export const app = 1\n')
  }
  options.prepare?.(root)
  sh(['add', '.'], repo)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], repo)
  const worktrees = temp('regatta-night-review-wt-')
  const dataDir = options.dataDir ?? temp('regatta-night-review-data-')
  const behave = options.behave ?? GOOD
  const seen: RunOptions[] = []
  const deps: NightWatchDeps = {
    dataDir,
    root: () => root,
    env: () => ENV,
    agents: () => (['claude', 'codex'] as AgentKind[]).map((kind) => ({ ...AGENTS[kind], installed: true, path: `/usr/bin/${AGENTS[kind].command}`, version: '1.0' })),
    run: (opts) => fakeAgent(behave, seen, opts),
    emit: () => undefined,
    keepAwake: () => undefined,
    worktreesDir: () => worktrees,
    ...options.patch
  }
  return { engine: new NightWatch(deps), repo, root, dataDir, worktrees, runs: seen, deps }
}

function fakeAgent(behave: Behave, seen: RunOptions[], opts: RunOptions): RunHandle {
  seen.push(opts)
  const behavior = behave(opts)
  let settle!: (result: RunResult) => void
  const done = new Promise<RunResult>((resolve) => {
    settle = resolve
  })
  let ended = false
  const end = (stopped: boolean): void => {
    if (ended) return
    ended = true
    settle({ exitCode: stopped ? null : 0, durationMs: 5, tokens: 1, stopped, ...(behavior.stuck ? { stuck: true } : {}) })
  }
  opts.onActivity('working')
  behavior.early?.(opts)
  if (behavior.hang) {
    const hang = behavior.hang
    return { done, stop: () => void hang.then(() => end(true)) }
  }
  const clock = setTimeout(() => {
    try {
      behavior.write?.(opts.cwd)
    } catch (err) {
      opts.onActivity(`could not write: ${err instanceof Error ? err.message : String(err)}`)
    }
    end(false)
  }, 30)
  clock.unref()
  return {
    done,
    stop: () => {
      clearTimeout(clock)
      end(true)
    }
  }
}

function task(prompt: string, agent: AgentKind = 'claude', checks: CheckSpec[] = CHECKS): Omit<NightTask, 'id' | 'createdAt'> {
  return { prompt, agent, checks }
}

/** Waits for a condition; the clock is `performance.now`, which a test that freezes `Date` does not stop. */
async function waitFor(what: string, check: () => boolean, timeoutMs = 60000): Promise<void> {
  const started = performance.now()
  while (!check()) {
    if (performance.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

/** True when the condition came true within the time; false when the time ran out. */
async function happensWithin(check: () => boolean, ms: number): Promise<boolean> {
  try {
    await waitFor('a condition', check, ms)
    return true
  } catch {
    return false
  }
}

function nightOf(engine: NightWatch, index = 0): ReturnType<NightWatch['state']>['nights'][number] {
  const found = engine.state().nights[index]
  if (!found) throw new Error(`No night ${index}`)
  return found
}

function runOf(engine: NightWatch, index = 0, nightIndex = 0): NightTaskRun {
  const found = nightOf(engine, nightIndex).runs[index]
  if (!found) throw new Error(`No run ${index}`)
  return found
}

/** Runs one night to its end with the given tasks. */
async function runNight(harness: Harness, tasks: Omit<NightTask, 'id' | 'createdAt'>[]): Promise<void> {
  for (const t of tasks) harness.engine.addTask(t)
  await harness.engine.schedule('now')
  await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
}

/** A new engine on the same data folder: the app quit and started again. */
function restart(harness: Harness, patch: Partial<NightWatchDeps> = {}): NightWatch {
  return new NightWatch({ ...harness.deps, ...patch })
}

function head(repo: string, ref = 'HEAD'): string {
  return sh(['rev-parse', ref], repo).trim()
}

function branches(repo: string): string[] {
  return sh(['branch', '--list', 'regatta/night-*', '--format=%(refname:short)'], repo).trim().split('\n').filter(Boolean)
}

interface Sidecar {
  nights: Record<string, { held: Record<string, string>; pending?: Record<string, { path: string; branch: string; base: string }>; runs: Record<string, { owned: { identity: string | null } | null }> }>
}

function sidecar(harness: Harness): Sidecar {
  return JSON.parse(readFileSync(join(harness.dataDir, 'nightwatch-owned.json'), 'utf8'))
}

describe('a merge asked for while the night is still stopping', () => {
  it('goes by the branch the folder was on when it was asked for, not the one the user switched to during the wait', async () => {
    const hold = gate()
    const harness = makeHarness({ behave: (opts) => (opts.agent === 'codex' ? { hang: hold.promise } : { write: finished }) })
    const { engine, repo } = harness
    engine.addTask(task('the good one', 'claude'))
    engine.addTask(task('the slow one', 'codex'))
    await engine.schedule('now')
    await waitFor('the first run to be ready and the second to be working', () => runOf(engine, 0).status === 'ready' && runOf(engine, 1).status === 'running' && harness.runs.length === 2)
    const ready = runOf(engine, 0)

    // The slow run's agent is told to stop, but it only ends when the gate opens (a real agent takes a while).
    engine.cancel()
    const before = head(repo)
    let recorded = false
    hooks.afterCapture = () => {
      recorded = true
    }
    const merging = engine.merge(ready.id).then(
      () => 'merged',
      (err: Error) => err.message
    )
    // A merge records its target at once, and this goes on the moment it has. The bound is only for an engine that waits for the night first
    // and records nothing until the gate opens: it would otherwise wait for ever.
    await happensWithin(() => recorded, 20000)
    sh(['checkout', '-q', '-b', 'feature-after-request'], repo)
    hold.open()

    const outcome = await merging
    expect(outcome).toContain('Your folder is on feature-after-request now, not main')
    // Nothing was merged anywhere, and nothing was removed.
    expect(head(repo, 'main')).toBe(before)
    expect(head(repo, 'feature-after-request')).toBe(before)
    expect(runOf(engine, 0).status).toBe('ready')
    expect(runOf(engine, 0).note).toContain('Not merged: Your folder is on feature-after-request now, not main')
    expect(existsSync(ready.worktree!)).toBe(true)
    expect(branches(repo)).toContain(ready.branch)

    // Back on main, the same run merges into main.
    sh(['checkout', '-q', 'main'], repo)
    const result = await engine.merge(ready.id)
    expect(result.summary).toMatch(/^Fast-forwarded main by 1 commit/)
    expect(head(repo, 'main')).toBe(ready.tip)
    expect(head(repo, 'feature-after-request')).toBe(before)
  }, 120000)
})

/** A copy of a data folder: an engine started on it changes the copy, not the image. */
function copyOf(dir: string): string {
  const copy = temp('regatta-night-review-image-')
  cpSync(dir, copy, { recursive: true })
  return copy
}

/** Thirty more nights that did nothing: scheduled for later and cancelled, so each is quick and owns nothing. */
async function thirtyMoreNights(harness: Harness): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < 30; i++) {
    // A night that is cancelled before it starts gives its task back, so the same task serves for the next one.
    if (harness.engine.state().queue.length === 0) harness.engine.addTask(task(`later ${i}`))
    await harness.engine.schedule(Date.now() + HOUR)
    ids.push(nightOf(harness.engine).id)
    harness.engine.cancel()
  }
  for (const queued of harness.engine.state().queue) harness.engine.removeTask(queued.id)
  return ids
}

describe('the history limit', () => {
  it('keeps a night whose folder a program could not be stopped in, through 30 more nights and a restart', async () => {
    const harness = makeHarness({ behave: () => ({ write: finished, stuck: true }) })
    await runNight(harness, [task('leaves a mess')])
    const held = nightOf(harness.engine)
    const run = runOf(harness.engine)
    expect(run.status).toBe('failed')
    const folder = run.worktree!
    expect(harness.engine.busyPaths()).toContain(folder)

    const later = await thirtyMoreNights(harness)

    // The oldest nights over the limit went, but not the one that holds a folder.
    const kept = harness.engine.state().nights.map((n) => n.id)
    expect(kept).toHaveLength(30)
    expect(kept).toContain(held.id)
    expect(kept).not.toContain(later[0])
    expect(kept).toEqual([...later.slice(1).reverse(), held.id])
    expect(harness.engine.busyPaths()).toContain(folder)
    expect(sidecar(harness).nights[held.id]!.held[folder]).toContain('could not be stopped')

    // Discard finds it, and keeps the folder with the reason, as it would have the night after.
    await harness.engine.discard(run.id)
    expect(existsSync(folder)).toBe(true)
    expect(runOf(harness.engine, 0, 29).note).toContain('could not be stopped')

    // After a restart it is all still there.
    const next = restart(harness)
    expect(next.state().nights.map((n) => n.id)).toContain(held.id)
    expect(next.busyPaths()).toContain(folder)
    await next.discard(run.id)
    expect(existsSync(folder)).toBe(true)
  }, 180000)

  it('keeps a night with a run that was never merged or discarded, so that it can still be merged', async () => {
    const harness = makeHarness()
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    expect(run.status).toBe('ready')
    const night = nightOf(harness.engine)

    await thirtyMoreNights(harness)
    expect(harness.engine.state().nights).toHaveLength(30)
    expect(harness.engine.state().nights.map((n) => n.id)).toContain(night.id)
    expect(harness.engine.busyPaths()).toContain(run.worktree)

    const next = restart(harness)
    expect(next.busyPaths()).toContain(run.worktree)
    const result = await next.merge(run.id)
    expect(result.summary).toMatch(/^Fast-forwarded main by 1 commit/)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(next.busyPaths()).not.toContain(run.worktree)
  }, 180000)

  it('keeps a night whose baseline folder is held, though every run of it was merged', async () => {
    const harness = makeHarness()
    hooks.stuckIn = '-base'
    await runNight(harness, [task('good')])
    hooks.stuckIn = null
    const run = runOf(harness.engine)
    const night = nightOf(harness.engine)
    expect(run.status).toBe('ready')
    await harness.engine.merge(run.id)
    // The run's folder and branch are gone; the baseline's folder is held, because a program in it could not be stopped.
    const base = join(harness.worktrees, `night-${night.id}-base`)
    expect(existsSync(base)).toBe(true)
    expect(harness.engine.busyPaths()).toEqual([base])

    await thirtyMoreNights(harness)
    expect(harness.engine.state().nights).toHaveLength(30)
    expect(harness.engine.state().nights.map((n) => n.id)).toContain(night.id)
    expect(harness.engine.busyPaths()).toEqual([base])
    expect(Object.keys(sidecar(harness).nights)).toContain(night.id)
    expect(restart(harness).busyPaths()).toEqual([base])
  }, 180000)

  it('still drops the oldest nights that own nothing, once their folders are released', async () => {
    const harness = makeHarness()
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    const first = nightOf(harness.engine).id
    await harness.engine.merge(run.id)
    expect(harness.engine.busyPaths()).toEqual([])

    await thirtyMoreNights(harness)
    expect(harness.engine.state().nights).toHaveLength(30)
    expect(harness.engine.state().nights.map((n) => n.id)).not.toContain(first)
    await expect(harness.engine.discard(run.id)).rejects.toThrow('That night is no longer here.')
    expect(Object.keys(sidecar(harness).nights)).toHaveLength(30)
  }, 180000)
})

describe('a project opened below the top of its repository', () => {
  it('runs the agent and every check in the project folder of each worktree, and merges the result', async () => {
    const where = join(temp('regatta-night-review-where-'), 'folders.txt')
    const checks: CheckSpec[] = [...CHECKS, { name: 'where', command: `pwd -P >> '${where}'`, kind: 'required' }]
    const harness = makeHarness({ layout: 'app' })
    await runNight(harness, [task('change the app', 'claude', checks)])
    const { engine, repo, worktrees } = harness
    const night = nightOf(engine)
    const run = runOf(engine)

    // The run's folder, and everything Regatta keeps about it, is the top of the worktree.
    expect(run.status).toBe('ready')
    expect(run.worktree).toBe(join(worktrees, `night-${night.id}-claude`))
    // The agent works in the project's own folder of it, exactly where the path says (the temp folder is under a symlink).
    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0]!.cwd).toBe(join(run.worktree!, 'app'))
    // The baseline and the checks ran in the project's folder too (the guard and DONE.txt are only there).
    const real = realpathSync(worktrees)
    expect(readFileSync(where, 'utf8').trim().split('\n')).toEqual([join(real, `night-${night.id}-base`, 'app'), join(real, `night-${night.id}-claude-check`, 'app')])
    // What the agent wrote went in at the project folder, and so did the commit.
    expect(sh(['ls-tree', '-r', '--name-only', run.branch!], repo).trim().split('\n')).toEqual(['README.md', 'app/DONE.txt', 'app/GUARD.txt', 'app/src/app.js'])

    const result = await engine.merge(run.id)
    expect(result.summary).toMatch(/^Fast-forwarded main by 1 commit/)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(readFileSync(join(repo, 'app', 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(readdirSync(worktrees)).toEqual(['.regatta-trash'])
    expect((await emptyTrash(worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(readdirSync(join(worktrees, '.regatta-trash'))).toEqual([])
    expect(branches(repo)).toEqual([])
  }, 120000)

  it('makes the project folder in a worktree whose commit has none', async () => {
    const harness = makeHarness({ layout: 'newapp' })
    expect(readdirSync(harness.root)).toEqual([])
    await runNight(harness, [task('start the app', 'claude', [CHECKS[0]!])])
    const run = runOf(harness.engine)
    expect(run.status).toBe('ready')
    expect(harness.runs[0]!.cwd).toBe(join(run.worktree!, 'app'))
    expect(existsSync(join(run.worktree!, 'app', 'DONE.txt'))).toBe(true)
    expect(existsSync(join(run.worktree!, 'DONE.txt'))).toBe(false)
    const result = await harness.engine.merge(run.id)
    expect(result.summary).toMatch(/^Fast-forwarded main by 1 commit/)
    expect(readFileSync(join(harness.repo, 'app', 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(readdirSync(join(harness.worktrees, '.regatta-trash'))).toEqual([])
  }, 120000)

  it.skipIf(process.platform !== 'darwin')('keeps the copy of node_modules at the top of the worktree, where the project finds it and removal exempts it', async () => {
    const prepare = (root: string): void => {
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    }
    const checks: CheckSpec[] = [
      ...CHECKS,
      // The copy is not in the project's folder but above it, and Node finds the package from the project's folder anyway.
      { name: 'copy at the top', command: 'test -d ../node_modules/pkg && test ! -e node_modules', kind: 'required' },
      { name: 'finds the package', command: `node -e "process.exit(require('pkg') === 1 ? 0 : 1)"`, kind: 'required' }
    ]
    const harness = makeHarness({ layout: 'app', prepare })
    await runNight(harness, [task('change the app', 'claude', checks)])
    const run = runOf(harness.engine)
    expect(run.checks.map((c) => `${c.name}:${c.passed}`)).toEqual(['done:true', 'guard:true', 'copy at the top:true', 'finds the package:true'])
    expect(run.status).toBe('ready')
    expect(existsSync(join(run.worktree!, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    expect(existsSync(join(run.worktree!, 'app', 'node_modules'))).toBe(false)
    // The worktree moves to the trash when the run is merged, and emptying the trash removes it.
    const result = await harness.engine.merge(run.id)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(readdirSync(join(harness.worktrees, '.regatta-trash'))).toEqual([])
    expect(readFileSync(join(harness.root, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(existsSync(join(harness.repo, 'node_modules'))).toBe(false)
  }, 120000)
})

describe('a run\'s folder is on the disk before anything runs in it', () => {
  it('has the folder and the proof of it saved when the agent starts, though an update went out a moment ago', async () => {
    // Updates are saved at most four times a second. With the clock stopped, the save that follows making the
    // folder is always "too soon", which is the case that used to leave the disk saying the run had no folder.
    vi.useFakeTimers({ toFake: ['Date'] })
    let harness!: Harness
    let atStart: { worktree: string | null; branch: string | null; identity: string | null | undefined } | null = null
    let image = ''
    harness = makeHarness({
      behave: () => ({
        write: finished,
        early: () => {
          const state = JSON.parse(readFileSync(join(harness.dataDir, 'nightwatch.json'), 'utf8'))
          const saved = state.nights[0].runs[0]
          atStart = { worktree: saved.worktree, branch: saved.branch, identity: sidecar(harness).nights[state.nights[0].id]?.runs[saved.id]?.owned?.identity }
          image = temp('regatta-night-review-image-')
          cpSync(harness.dataDir, image, { recursive: true })
        }
      })
    })
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    expect(atStart).toEqual({ worktree: run.worktree, branch: run.branch, identity: expect.stringMatching(/^.+\|i\d+\|[\d.e+-]+$/) })

    // An app that stopped right then starts again from that disk: the run is a stopped one that still has its folder.
    const next = new NightWatch({ ...harness.deps, dataDir: image })
    expect(runOf(next).status).toBe('stopped')
    expect(runOf(next).worktree).toBe(run.worktree)
    expect(next.busyPaths()).toEqual([run.worktree])
    await next.discard(run.id)
    expect(runOf(next).status).toBe('discarded')
    expect(existsSync(run.worktree!)).toBe(false)
  }, 120000)

  it('saves the tested commit as soon as it is known', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let harness!: Harness
    let image = ''
    hooks.afterDiffBetween = () => {
      // The disk right after the run was committed and measured: the commit is known, and no update has been saved since.
      image = temp('regatta-night-review-image-')
      cpSync(harness.dataDir, image, { recursive: true })
      hooks.afterDiffBetween = null
    }
    harness = makeHarness()
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    expect(run.status).toBe('ready')
    expect(run.tip).toBe(head(harness.repo, run.branch!))
    const next = new NightWatch({ ...harness.deps, dataDir: image })
    expect(runOf(next).status).toBe('stopped')
    expect(runOf(next).tip).toBe(run.tip)
  }, 120000)

  it('writes down the folder it is about to ask git for, before git starts', async () => {
    let harness!: Harness
    const seen: { pending: unknown; entries: string[] }[] = []
    hooks.beforeAddWorktree = (path) => {
      const record = sidecar(harness)
      seen.push({ pending: Object.values(record.nights)[0]!.pending, entries: readdirSync(path) })
    }
    harness = makeHarness()
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    // Git was asked for a folder that existed and was empty, and the record already named it, its branch and its start.
    expect(seen).toEqual([{ pending: { [run.id]: { path: run.worktree, branch: run.branch, base: run.base } }, entries: [] }])
    // Once the run owns it the journal is empty again.
    expect(sidecar(harness).nights[nightOf(harness.engine).id]!.pending).toEqual({})
  }, 120000)

  it('finds the folder git was making when the app stopped, so that the run can be discarded', async () => {
    let harness!: Harness
    let image = ''
    hooks.beforeAddWorktree = () => {
      // The disk a moment before git started: the folder exists, and only the journal knows about it.
      image = temp('regatta-night-review-image-')
      cpSync(harness.dataDir, image, { recursive: true })
    }
    harness = makeHarness()
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    const saved = JSON.parse(readFileSync(join(image, 'nightwatch.json'), 'utf8'))
    expect(saved.nights[0].runs[0].worktree).toBeNull()

    const next = new NightWatch({ ...harness.deps, dataDir: image })
    expect(runOf(next).status).toBe('stopped')
    expect(runOf(next).worktree).toBe(run.worktree)
    expect(runOf(next).branch).toBe(run.branch)
    expect(next.busyPaths()).toEqual([run.worktree])
    expect(runOf(next).note).toContain(`Regatta stopped while it was setting up ${run.worktree}`)
    // A restart after that remembers it too (the journal was turned into the run's own record).
    expect(new NightWatch({ ...harness.deps, dataDir: image }).busyPaths()).toEqual([run.worktree])
    await next.discard(run.id)
    expect(runOf(next).status).toBe('discarded')
    expect(existsSync(run.worktree!)).toBe(false)
  }, 120000)

  it('removes an empty folder a stop left, keeps one with anything in it, and leaves alone one outside the worktrees folder', async () => {
    const harness = makeHarness()
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    const night = nightOf(harness.engine)
    /** An engine on a copy of the disk as it was before the run's folder was recorded, with the journal naming `path`. */
    const stoppedMaking = (path: string): NightWatch => {
      const image = temp('regatta-night-review-image-')
      cpSync(harness.dataDir, image, { recursive: true })
      const state = JSON.parse(readFileSync(join(image, 'nightwatch.json'), 'utf8'))
      // The night was still going when the app stopped.
      Object.assign(state.nights[0], { status: 'running', finishedAt: null })
      Object.assign(state.nights[0].runs[0], { worktree: null, branch: null, status: 'running' })
      writeFileSync(join(image, 'nightwatch.json'), JSON.stringify(state))
      const record = JSON.parse(readFileSync(join(image, 'nightwatch-owned.json'), 'utf8'))
      record.nights[night.id].runs[run.id].owned = null
      record.nights[night.id].pending = { [run.id]: { path, branch: run.branch, base: run.base } }
      writeFileSync(join(image, 'nightwatch-owned.json'), JSON.stringify(record))
      return new NightWatch({ ...harness.deps, dataDir: image })
    }

    // Empty: it is only what the engine's own mkdir left, so it goes, and the run has no folder.
    const empty = join(harness.worktrees, `night-${night.id}-claude-empty`)
    mkdirSync(empty)
    const a = stoppedMaking(empty)
    expect(existsSync(empty)).toBe(false)
    expect(runOf(a).worktree).toBeNull()
    expect(a.busyPaths()).toEqual([])

    // With something in it: not ours to remove. It is the run's folder, in use, and discarding keeps it.
    const full = join(harness.worktrees, `night-${night.id}-claude-full`)
    mkdirSync(full)
    writeFileSync(join(full, 'mine.txt'), 'mine\n')
    const b = stoppedMaking(full)
    expect(runOf(b).worktree).toBe(full)
    expect(b.busyPaths()).toEqual([full])
    await b.discard(run.id)
    expect(readFileSync(join(full, 'mine.txt'), 'utf8')).toBe('mine\n')
    expect(runOf(b).note).toContain('cannot tell whether it is the worktree it made')

    // Not in the worktrees folder at all (a record that was changed): nothing is removed or taken on.
    const elsewhere = temp('regatta-night-review-elsewhere-')
    const c = stoppedMaking(elsewhere)
    expect(existsSync(elsewhere)).toBe(true)
    expect(runOf(c).worktree).toBeNull()
    expect(c.busyPaths()).toEqual([])

    // Gone: nothing to protect.
    const d = stoppedMaking(join(harness.worktrees, `night-${night.id}-claude-gone`))
    expect(runOf(d).worktree).toBeNull()
    expect(d.busyPaths()).toEqual([])
  }, 120000)

  it('does not start the agent when the record of its folder cannot be saved, and keeps the folder', async () => {
    const harness = makeHarness()
    // A folder where the record's temporary file goes: from then on nothing can be saved.
    const block = join(harness.dataDir, 'nightwatch-owned.json.tmp')
    hooks.afterAddWorktree = () => {
      mkdirSync(block)
    }
    harness.engine.addTask(task('good'))
    await harness.engine.schedule('now')
    await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
    rmSync(block, { recursive: true })

    const run = runOf(harness.engine)
    expect(harness.runs).toHaveLength(0)
    expect(run.status).toBe('failed')
    expect(run.note).toContain(`Regatta could not save its record of ${run.worktree}, so the run was not started`)
    // The folder git made is still the run's: listed, and removed by discarding it.
    expect(existsSync(run.worktree!)).toBe(true)
    expect(harness.engine.busyPaths()).toEqual([run.worktree])
    await harness.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    expect(harness.engine.busyPaths()).toEqual([])
  }, 120000)

  it('makes no folder when the journal of it cannot be saved', async () => {
    const harness = makeHarness()
    const block = join(harness.dataDir, 'nightwatch-owned.json.tmp')
    hooks.afterBranchCheck = () => {
      mkdirSync(block)
    }
    harness.engine.addTask(task('good'))
    await harness.engine.schedule('now')
    await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
    rmSync(block, { recursive: true })

    const run = runOf(harness.engine)
    expect(harness.runs).toHaveLength(0)
    expect(run.status).toBe('failed')
    expect(run.note).toContain('Regatta could not save its record of the folder it was about to make, so none was made')
    expect(run.worktree).toBeNull()
    expect(readdirSync(harness.worktrees)).toEqual([])
    expect(branches(harness.repo)).toEqual([])
    expect(harness.engine.busyPaths()).toEqual([])
  }, 120000)

  it('takes the folder out of the journal when git cannot make it, and reads a record from before the journal', async () => {
    let harness!: Harness
    hooks.beforeAddWorktree = () => {
      throw new Error('fatal: could not make the folder')
    }
    harness = makeHarness()
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    const night = nightOf(harness.engine)
    expect(run.status).toBe('failed')
    expect(run.note).toContain('fatal: could not make the folder')
    expect(harness.runs).toHaveLength(0)
    // Nothing is left on the disk, in memory, or in the journal.
    expect(readdirSync(harness.worktrees)).toEqual([])
    expect(harness.engine.busyPaths()).toEqual([])
    expect(sidecar(harness).nights[night.id]!.pending).toEqual({})

    // A record written before there was a journal has no such entry: it reads the same as an empty one.
    const file = join(harness.dataDir, 'nightwatch-owned.json')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    delete record.nights[night.id].pending
    writeFileSync(file, JSON.stringify(record))
    const next = restart(harness)
    expect(runOf(next).status).toBe('failed')
    expect(next.busyPaths()).toEqual([])
  }, 120000)
})

describe('the save that gives a run its folder', () => {
  /** What an image of the data folder says about the first run: the folder in the state, and whether the record beside it holds the journal entry and the run's ownership. */
  function peek(image: string): { stateFolder: string | null; journal: string[]; owns: boolean } {
    const state = JSON.parse(readFileSync(join(image, 'nightwatch.json'), 'utf8'))
    const record = JSON.parse(readFileSync(join(image, 'nightwatch-owned.json'), 'utf8')) as Sidecar
    const night = Object.values(record.nights)[0]!
    return { stateFolder: state.nights[0].runs[0].worktree, journal: Object.keys(night.pending ?? {}), owns: Object.values(night.runs).some((r) => r.owned !== null) }
  }

  const owns = (record: Sidecar): boolean => Object.values(record.nights).some((n) => Object.values(n.runs).some((r) => r.owned !== null))

  interface Images {
    before?: string
    between?: string
    after?: string
    settled?: string
  }

  /**
   * Takes an image of the data folder at four points of the save that gives the run its folder, found by
   * the engine's own file replacements and not by the clock (how long git takes decides when the next
   * write comes): before the record is replaced, between its two files, as the first write after that
   * save found the disk, and as the second one did. Stays on until the test turns `hooks.beforeRename` off.
   */
  function watchTransferSave(harness: () => Harness | undefined): Images {
    const images: Images = {}
    let writesAfter = 0
    hooks.beforeRename = (target, from) => {
      const watched = harness()
      if (!watched) return
      try {
        if (target.endsWith('nightwatch-owned.json')) {
          if (images.between !== undefined) {
            writesAfter++
            if (writesAfter === 1) images.after = copyOf(watched.dataDir)
            else if (writesAfter === 2) images.settled = copyOf(watched.dataDir)
          } else if (images.before === undefined && owns(JSON.parse(readFileSync(from, 'utf8')))) {
            // The record that says the run owns its folder is about to replace the one that does not.
            images.before = copyOf(watched.dataDir)
          }
        } else if (target.endsWith('nightwatch.json') && images.before !== undefined && images.between === undefined) {
          // The state file of that same save: the record beside it was replaced a moment ago, the state is about to be.
          images.between = copyOf(watched.dataDir)
        }
      } catch {
        // A file that is not there yet (the very first save): not the save looked for.
      }
    }
    return images
  }

  /**
   * Starts an engine on a copy of an image (the app starting again after a stop) with an image taken at each
   * point of the save that ends loading, which writes the same two files in the same order: before the record is
   * replaced, between the two files, once both are written, and after the next write.
   */
  function startAgain(harness: Harness, image: string): { engine: NightWatch; images: Required<Images> } {
    const dir = copyOf(image)
    const taken: Images = {}
    hooks.beforeRename = (target) => {
      if (!target.startsWith(dir)) return
      if (target.endsWith('nightwatch-owned.json') && taken.before === undefined) taken.before = copyOf(dir)
      else if (target.endsWith('nightwatch.json') && taken.between === undefined) taken.between = copyOf(dir)
    }
    let engine: NightWatch
    try {
      engine = new NightWatch({ ...harness.deps, dataDir: dir })
    } finally {
      hooks.beforeRename = null
    }
    taken.after = copyOf(dir)
    // Any save is the next write.
    engine.cancel()
    taken.settled = copyOf(dir)
    return { engine, images: taken as Required<Images> }
  }

  /** Starts an app on a copy of an image and checks that it knows the run, its folder and its branch, with the proof taken when git made the folder. */
  function expectFound(harness: Harness, image: string, run: NightTaskRun, label: string): NightWatch {
    const dir = copyOf(image)
    const next = new NightWatch({ ...harness.deps, dataDir: dir })
    const night = nightOf(harness.engine)
    expect(runOf(next).status, label).toBe('stopped')
    expect(runOf(next).worktree, label).toBe(run.worktree)
    expect(runOf(next).branch, label).toBe(run.branch)
    expect(next.busyPaths(), label).toEqual([run.worktree])
    const original = sidecar(harness).nights[night.id]!.runs[run.id]!.owned!.identity
    expect(sidecar({ ...harness, dataDir: dir }).nights[night.id]!.runs[run.id]!.owned!.identity, label).toBe(original)
    return next
  }

  /** How many times the note says the folder may be incomplete. */
  function timesSaid(run: NightTaskRun): number {
    return run.note.split('Regatta stopped while it was setting up').length - 1
  }

  it('leaves the folder findable when the app stops before, between or after the two files of it', async () => {
    let harness: Harness | undefined
    const images = watchTransferSave(() => harness)
    harness = makeHarness()
    await runNight(harness, [task('good')])
    hooks.beforeRename = null
    const run = runOf(harness.engine)
    expect(run.status).toBe('ready')
    expect(Object.keys(images).sort()).toEqual(['after', 'before', 'between', 'settled'])
    const night = nightOf(harness.engine)
    const identity = sidecar(harness).nights[night.id]!.runs[run.id]!.owned!.identity
    expect(identity).toMatch(/^.+\|i\d+\|[\d.e+-]+$/)

    // What each image holds. The journal entry is there from before git was asked until the first write after the state names the folder;
    // the proof of ownership comes with the save that gives the run its folder, and the folder in the state with the second file of it.
    expect(peek(images.before!)).toEqual({ stateFolder: null, journal: [run.id], owns: false })
    expect(peek(images.between!)).toEqual({ stateFolder: null, journal: [run.id], owns: true })
    expect(peek(images.after!)).toEqual({ stateFolder: run.worktree, journal: [run.id], owns: true })
    expect(peek(images.settled!)).toEqual({ stateFolder: run.worktree, journal: [], owns: true })

    // From any of them an app that starts again knows the run, its folder and its branch, with the proof taken when git made the folder.
    for (const [boundary, image] of Object.entries(images)) expectFound(harness, image, run, boundary)

    // When the record says the folder's identity could not be read, that stays unproven after the restart: the folder is kept.
    const unproven = copyOf(images.between!)
    const record = JSON.parse(readFileSync(join(unproven, 'nightwatch-owned.json'), 'utf8')) as Sidecar
    record.nights[night.id]!.runs[run.id]!.owned!.identity = null
    writeFileSync(join(unproven, 'nightwatch-owned.json'), JSON.stringify(record))
    const cautious = new NightWatch({ ...harness.deps, dataDir: unproven })
    await cautious.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(true)
    expect(runOf(cautious).note).toContain('cannot tell whether it is the worktree it made')

    // And with the proof it is the run's own to discard.
    const last = new NightWatch({ ...harness.deps, dataDir: copyOf(images.between!) })
    await last.discard(run.id)
    expect(runOf(last).status).toBe('discarded')
    expect(existsSync(run.worktree!)).toBe(false)
  }, 120000)

  it('finds the folder again when the app stops a second time, while it is putting the first stop right', async () => {
    let harness: Harness | undefined
    const first = watchTransferSave(() => harness)
    harness = makeHarness()
    await runNight(harness, [task('good')])
    hooks.beforeRename = null
    const run = runOf(harness.engine)
    expect(run.status).toBe('ready')
    expect(Object.keys(first).sort()).toEqual(['after', 'before', 'between', 'settled'])

    // The first stop: before the record was replaced (only the journal knows the folder), or between its two files (the record has the proof too).
    for (const [stop, image] of [
      ['before', first.before!],
      ['between', first.between!]
    ] as const) {
      // The app starts again and puts that right by writing the two files once more: it can be stopped again at any point of that.
      const again = startAgain(harness, image)
      const label = (point: string): string => `stopped ${stop}, then ${point}`
      expect(peek(again.images.before), label('before the record is replaced')).toEqual({ stateFolder: null, journal: [run.id], owns: stop === 'between' })
      expect(peek(again.images.between), label('between the two files')).toEqual({ stateFolder: null, journal: [run.id], owns: true })
      expect(peek(again.images.after), label('after both')).toEqual({ stateFolder: run.worktree, journal: [run.id], owns: true })
      expect(peek(again.images.settled), label('after the next write')).toEqual({ stateFolder: run.worktree, journal: [], owns: true })

      // Another restart from each of them knows the folder, and says only once that it may be incomplete.
      for (const [point, next] of Object.entries(again.images)) {
        const found = expectFound(harness, next, run, label(point))
        expect(timesSaid(runOf(found)), label(point)).toBe(1)
      }
    }

    // The run that was put right twice is still the run's own to discard.
    const last = new NightWatch({ ...harness.deps, dataDir: copyOf(startAgain(harness, first.between!).images.between) })
    await last.discard(run.id)
    expect(runOf(last).status).toBe('discarded')
    expect(existsSync(run.worktree!)).toBe(false)
  }, 120000)

  it('lets go of the journal entry of a folder that was discarded before any save could name it, and so of its night', async () => {
    const harness = makeHarness()
    // From the moment git has made the run's folder, nothing can be saved.
    const block = join(harness.dataDir, 'nightwatch-owned.json.tmp')
    hooks.afterAddWorktree = () => {
      mkdirSync(block)
    }
    harness.engine.addTask(task('good'))
    await harness.engine.schedule('now')
    await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
    const run = runOf(harness.engine)
    const night = nightOf(harness.engine)
    expect(run.status).toBe('failed')
    expect(run.note).toContain(`Regatta could not save its record of ${run.worktree}`)

    // The run is discarded while saving still fails: its folder moves to the trash, and the disk still says what it said before git was asked.
    await harness.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    expect(harness.engine.busyPaths()).toEqual([])
    expect(peek(harness.dataDir)).toEqual({ stateFolder: null, journal: [run.id], owns: false })

    // Saving works again. The first good save writes the entry once more and lets it go; the next one leaves it out.
    rmSync(block, { recursive: true })
    const extra = harness.engine.addTask(task('another')).queue[0]!.id
    harness.engine.removeTask(extra)
    expect(peek(harness.dataDir)).toEqual({ stateFolder: run.worktree, journal: [], owns: false })
    expect(restart(harness).busyPaths()).toEqual([])

    // Nothing holds the night in the history any more: 30 later nights push it out.
    await thirtyMoreNights(harness)
    expect(harness.engine.state().nights).toHaveLength(30)
    expect(harness.engine.state().nights.map((n) => n.id)).not.toContain(night.id)
  }, 120000)
})

describe('cancelling a night that has not started', () => {
  const OTHER: CheckSpec[] = [{ name: 'other', command: 'true', kind: 'required' }]

  /** What the saved state says about the first night and the queue. */
  function peekQueue(image: string): { night: string; queue: string[] } {
    const state = JSON.parse(readFileSync(join(image, 'nightwatch.json'), 'utf8'))
    return { night: state.nights[0].status, queue: state.queue.map((t: { id: string }) => t.id) }
  }

  /** Three tasks queued and a night scheduled for later with them. */
  async function scheduled(): Promise<{ harness: Harness; ids: string[] }> {
    const harness = makeHarness()
    harness.engine.addTask(task('first task'))
    harness.engine.addTask(task('second task', 'codex', OTHER))
    harness.engine.addTask(task('third task'))
    const ids = harness.engine.state().queue.map((t) => t.id)
    await harness.engine.schedule(Date.now() + HOUR)
    expect(harness.engine.state().queue).toEqual([])
    return { harness, ids }
  }

  it('puts its tasks back in the queue with the ids they had, in order, ahead of anything queued since, and so after a restart', async () => {
    const { harness, ids } = await scheduled()
    // A task queued for the night after, while this one waits.
    const later = harness.engine.addTask(task('queued meanwhile')).queue[0]!

    const state = harness.engine.cancel()
    expect(state.nights[0]!.status).toBe('cancelled')
    expect(state.queue.map((t) => t.id)).toEqual([...ids, later.id])
    expect(state.queue.map((t) => [t.prompt, t.agent, t.checks.map((c) => c.name)])).toEqual([
      ['first task', 'claude', ['done', 'guard']],
      ['second task', 'codex', ['other']],
      ['third task', 'claude', ['done', 'guard']],
      ['queued meanwhile', 'claude', ['done', 'guard']]
    ])

    // Saved with the cancel: another start sees the same, and cancelling again puts nothing twice.
    const again = restart(harness)
    expect(nightOf(again).status).toBe('cancelled')
    expect(again.state().queue.map((t) => t.id)).toEqual([...ids, later.id])
    again.cancel()
    expect(again.state().queue.map((t) => t.id)).toEqual([...ids, later.id])
    expect(again.state().queue).toHaveLength(4)

    // Started again from the queue, the night has the same tasks under the same ids.
    const next = await again.schedule(Date.now() + 2 * HOUR)
    expect(next.nights[0]!.runs.map((r) => r.taskId)).toEqual([...ids, later.id])
    expect(next.queue).toEqual([])
    expect(next.nights[1]!.status).toBe('cancelled')
  }, 60000)

  it('saves the night as cancelled and its tasks back in the queue in one file, so a stop between the two files loses none', async () => {
    const { harness, ids } = await scheduled()
    const images: { before?: string; between?: string } = {}
    hooks.beforeRename = (target) => {
      if (target.endsWith('nightwatch-owned.json')) images.before = copyOf(harness.dataDir)
      else if (target.endsWith('nightwatch.json')) images.between = copyOf(harness.dataDir)
    }
    harness.engine.cancel()
    hooks.beforeRename = null
    const after = copyOf(harness.dataDir)

    // The night and the queue are in the one file, which is replaced whole: before it the night waits with its tasks inside it, after it they are back.
    expect(peekQueue(images.before!)).toEqual({ night: 'scheduled', queue: [] })
    expect(peekQueue(images.between!)).toEqual({ night: 'scheduled', queue: [] })
    expect(peekQueue(after)).toEqual({ night: 'cancelled', queue: ids })

    // An app that starts again from the first two still has the night, with all three tasks in it, and cancelling it again gives them back.
    for (const [stop, image] of [['before', images.before!], ['between', images.between!]] as const) {
      const next = new NightWatch({ ...harness.deps, dataDir: copyOf(image) })
      expect(nightOf(next).status, stop).toBe('scheduled')
      expect(nightOf(next).runs.map((r) => r.taskId), stop).toEqual(ids)
      expect(next.state().queue, stop).toEqual([])
      expect(next.cancel().queue.map((t) => t.id), stop).toEqual(ids)
    }
    expect(restart(harness).state().queue.map((t) => t.id)).toEqual(ids)
  }, 60000)

  it('does not put a task back that is in the queue already, such as one of a missed night', async () => {
    const { harness, ids } = await scheduled()
    // As if the second task had been put back before: it is in the saved queue, under its id.
    const file = join(harness.dataDir, 'nightwatch.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.queue = [{ id: ids[1], prompt: 'second task', agent: 'codex', checks: OTHER, createdAt: 1 }]
    writeFileSync(file, JSON.stringify(saved))
    // The night's time came while the app was closed.
    const next = restart(harness, { now: () => nightOf(harness.engine).startAt + 5 * 60 * 1000 })
    expect(nightOf(next).status).toBe('cancelled')
    expect(next.state().queue.map((t) => t.id).sort()).toEqual([...ids].sort())
  }, 60000)

  it('gives nothing back when the night had started: its work is in its runs', async () => {
    const hold = gate()
    const harness = makeHarness({ behave: () => ({ hang: hold.promise }) })
    harness.engine.addTask(task('slow task'))
    await harness.engine.schedule('now')
    await waitFor('the agent to start', () => harness.runs.length === 1)
    const state = harness.engine.cancel()
    expect(state.queue).toEqual([])
    expect(state.nights[0]!.runs.map((r) => r.status)).toEqual(['stopped'])
    hold.open()
    await harness.engine.whenIdle()
    expect(harness.engine.state().queue).toEqual([])
  }, 60000)
})

describe('an engine that has been told to stop', () => {
  it('is idle at once when nothing is going on', async () => {
    const harness = makeHarness()
    await expect(harness.engine.whenIdle()).resolves.toBeUndefined()
    await runNight(harness, [task('good')])
    await expect(harness.engine.whenIdle()).resolves.toBeUndefined()
  }, 60000)

  it('is idle once the night it cancelled has wound down, and writes nothing more on its own', async () => {
    const hold = gate()
    const harness = makeHarness({ behave: () => ({ hang: hold.promise }) })
    harness.engine.addTask(task('slow task'))
    await harness.engine.schedule('now')
    await waitFor('the agent to start', () => harness.runs.length === 1)
    harness.engine.cancel()

    let idle = false
    const waiting = harness.engine.whenIdle().then(() => {
      idle = true
    })
    // The agent has not stopped yet, so the night has not wound down.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(idle).toBe(false)
    hold.open()
    await waiting
    expect(idle).toBe(true)

    // Nothing is left to happen: once the folder is removed it stays removed.
    rmSync(harness.dataDir, { recursive: true, force: true })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(existsSync(harness.dataDir)).toBe(false)
  }, 60000)

  it('writes at once an update that was waiting for its turn, and so makes nothing again after the folder is removed', async () => {
    // A night that waits looks at the clock every 30 ms, and each look is an update; they are sent at most four a second.
    const harness = makeHarness({ patch: { scheduleCheckMs: 30 } })
    harness.engine.addTask(task('later task'))
    await harness.engine.schedule(Date.now() + HOUR)
    await new Promise((resolve) => setTimeout(resolve, 100))
    harness.engine.cancel()
    await harness.engine.whenIdle()
    rmSync(harness.dataDir, { recursive: true, force: true })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(existsSync(harness.dataDir)).toBe(false)
  }, 60000)
})

describe('a git that stops after it has made something', () => {
  /** A post-checkout hook in the repository: git runs it in each new worktree once it has checked it out, and a failing one makes `git worktree add` fail with the worktree and branch in place. */
  function hook(repo: string, body: string): void {
    const file = join(repo, '.git', 'hooks', 'post-checkout')
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
  }

  it('keeps the folder and the branch of a run when a hook fails after the checkout, and a discard finishes the job', async () => {
    const harness = makeHarness()
    hook(harness.repo, 'case "$PWD" in *-claude) echo "written by the hook" > HOOK.txt; exit 1;; esac')
    // What is listed as in use each time the branch is looked for: once before anything exists, once to see what git left.
    const listed: string[][] = []
    hooks.afterBranchCheck = () => {
      listed.push(harness.engine.busyPaths())
    }
    await runNight(harness, [task('good')])
    hooks.afterBranchCheck = null
    const run = runOf(harness.engine)
    const night = nightOf(harness.engine)
    const folder = join(harness.worktrees, `night-${night.id}-claude`)
    expect(listed).toEqual([[], [folder]])

    // Git left the folder, filled, and the branch. They are the run's: recorded, listed, and the agent never started.
    expect(run.status).toBe('failed')
    expect(harness.runs).toHaveLength(0)
    expect(run.worktree).toBe(folder)
    expect(run.branch).toBe(`regatta/night-${night.id}-claude`)
    expect(readFileSync(join(folder, 'HOOK.txt'), 'utf8')).toBe('written by the hook\n')
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(harness.engine.busyPaths()).toEqual([folder])
    expect(run.note).toContain(`Git stopped while it was making ${folder}, so the run was not started. The folder and its branch ${run.branch} were kept as git left them`)
    expect(run.note).not.toContain('cannot tell whether the folder')
    expect(sidecar(harness).nights[night.id]!.runs[run.id]!.owned!.identity).toMatch(/^.+\|i\d+\|[\d.e+-]+$/)
    // The journal entry went once the record named the folder.
    expect(sidecar(harness).nights[night.id]!.pending).toEqual({})

    // A restart knows it too.
    const next = restart(harness)
    expect(runOf(next).worktree).toBe(folder)
    expect(runOf(next).branch).toBe(run.branch)
    expect(next.busyPaths()).toEqual([folder])

    // A discard moves the folder (including the file the hook wrote) to the trash, and parks the branch's commits.
    await next.discard(run.id)
    expect(existsSync(folder)).toBe(false)
    const trashed = await listTrash(harness.worktrees)
    expect(trashed).toHaveLength(1)
    expect(readFileSync(join(trashed[0]!.trashPath, 'HOOK.txt'), 'utf8')).toBe('written by the hook\n')
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(next.busyPaths()).toEqual([])
    const ref = `refs/regatta/discarded/night-${run.id}`
    expect(runOf(next).note).toContain("Moved its worktree to Regatta's trash")
    expect(runOf(next).note).toContain(`Kept a copy of the run's work at ${ref} `)
    expect(sh(['rev-parse', `${ref}^1`], harness.repo).trim()).toBe(run.base)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
  }, 120000)

  it('keeps a folder it cannot tell is the one git made, and never removes it', async () => {
    const harness = makeHarness()
    // The hook takes the link to the repository out of the folder, so nothing proves what the folder is.
    hook(harness.repo, 'case "$PWD" in *-claude) rm -f .git; echo "written by the hook" > HOOK.txt; exit 1;; esac')
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    const night = nightOf(harness.engine)
    const folder = join(harness.worktrees, `night-${night.id}-claude`)

    expect(run.status).toBe('failed')
    expect(run.worktree).toBe(folder)
    expect(harness.engine.busyPaths()).toEqual([folder])
    expect(run.note).toContain('Regatta cannot tell whether the folder is the one git made, so it will not be removed.')
    expect(sidecar(harness).nights[night.id]!.runs[run.id]!.owned!.identity).toBeNull()

    // Discarding keeps it, and the branch, however often it is asked.
    await restart(harness).discard(run.id)
    await harness.engine.discard(run.id)
    expect(readFileSync(join(folder, 'HOOK.txt'), 'utf8')).toBe('written by the hook\n')
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(runOf(harness.engine).note).toContain('cannot tell whether it is the worktree it made')
  }, 120000)

  it('does not claim a branch when no folder is left to show that git made it for this run, and a discard leaves it alone', async () => {
    let harness!: Harness
    // Git made the worktree and the branch; then something went wrong and the folder was taken away again.
    hooks.afterAddWorktree = (path) => {
      sh(['worktree', 'remove', '--force', path], harness.repo)
      throw new Error('the disk filled up')
    }
    harness = makeHarness()
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    const night = nightOf(harness.engine)
    const folder = join(harness.worktrees, `night-${night.id}-claude`)

    // The branch could as well be someone's, made between the check and git: it is not the run's, and nothing about it is recorded.
    expect(run.status).toBe('failed')
    expect(run.note).toBe('the disk filled up')
    expect(run.worktree).toBeNull()
    expect(run.branch).toBeNull()
    expect(existsSync(folder)).toBe(false)
    expect(branches(harness.repo)).toEqual([`regatta/night-${night.id}-claude`])
    expect(harness.engine.busyPaths()).toEqual([])
    expect(sidecar(harness).nights[night.id]!.pending).toEqual({})

    await restart(harness).discard(run.id)
    expect(branches(harness.repo)).toEqual([`regatta/night-${night.id}-claude`])
  }, 120000)

  it('says so when it leaves the folder it was making for the baseline, and claims nothing', async () => {
    const harness = makeHarness()
    hook(harness.repo, 'case "$PWD" in *-base) echo "written by the hook" > HOOK.txt; exit 1;; esac')
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    const night = nightOf(harness.engine)
    const base = join(harness.worktrees, `night-${night.id}-base`)

    expect(run.status).toBe('failed')
    expect(run.note).toContain('The baseline could not be prepared')
    expect(harness.runs).toHaveLength(0)
    expect(readdirSync(harness.worktrees)).toEqual([`night-${night.id}-base`])
    expect(night.notes).toEqual([expect.stringContaining(`${base} was left where it is: git stopped while it was making it`)])
    // It holds nothing of anyone's and nothing is waiting on it: not listed, not held.
    expect(harness.engine.busyPaths()).toEqual([])
    expect(restart(harness).busyPaths()).toEqual([])
  }, 120000)
})

describe('a commit made on a detached head in a run\'s folder', () => {
  it('moves the folder to the trash after keeping a commit that only a stash and the folder\'s own history held, so the commit survives stash pop and gc', async () => {
    const harness = makeHarness()
    await runNight(harness, [task('good')])
    const run = runOf(harness.engine)
    expect(run.status).toBe('ready')
    const folder = run.worktree!

    // The user opens the run's folder, detaches, commits a file that exists nowhere else, and stashes a separate edit.
    sh(['checkout', '-q', '--detach'], folder)
    writeFileSync(join(folder, 'unique.txt'), 'only on this detached commit\n')
    sh(['add', '-A'], folder)
    sh([...IDENTITY, 'commit', '-m', 'unique detached commit'], folder)
    const unique = head(folder)
    writeFileSync(join(folder, 'work.txt'), 'a separate edit\n')
    sh(['add', '-A'], folder)
    sh([...IDENTITY, 'stash'], folder)
    sh(['checkout', '-q', run.branch!], folder)
    // The stash commit's parent is the detached commit, so refs/stash reaches it. The folder is clean and back on its branch.
    expect(sh(['for-each-ref', '--contains', unique, '--format=%(refname)', 'refs/stash'], harness.repo).trim()).toBe('refs/stash')
    expect(sh(['status', '--porcelain'], folder).trim()).toBe('')

    await harness.engine.discard(run.id)
    // A stash is popped or dropped one day, so it holds nothing: a keep commit does. Emptying the trash removes the folder and branch.
    expect(existsSync(folder)).toBe(false)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    expect(harness.engine.busyPaths()).toEqual([])

    sh([...IDENTITY, 'stash', 'pop'], harness.repo)
    sh(['reflog', 'expire', '--expire=now', '--all'], harness.repo)
    sh(['gc', '--prune=now', '-q'], harness.repo)
    expect(sh(['cat-file', '-t', unique], harness.repo).trim()).toBe('commit')
    const refs = sh(['for-each-ref', '--format=%(refname)', 'refs/regatta/discarded/'], harness.repo).split('\n').filter(Boolean)
    expect(refs.some((ref) => sh(['rev-list', ref], harness.repo).split('\n').includes(unique))).toBe(true)
    expect(sh(['show', `${unique}:unique.txt`], harness.repo)).toBe('only on this detached commit\n')
  }, 120000)
})
