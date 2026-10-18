// The night watch engine across a restart: a new engine on the same data folder must be able to merge
// and discard what the old one left, keep what it cannot prove is its own, get a scheduled night's
// timer back, and start a night that came due while the computer slept. Real git, real processes.

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AGENTS } from '../../shared/agents'
import type { CheckSpec } from '../../shared/heats'
import type { NightState, NightTask, NightTaskRun } from '../../shared/nightwatch'
import type { AgentKind, DetectedAgent } from '../../shared/types'
import { emptyTrash, listTrash } from '../heats/git-ops'
import { NightWatch as RealNightWatch } from './engine'
import type { NightWatchDeps } from './engine'
import type { RunHandle, RunOptions, RunResult } from '../heats/runner'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']
const CHECKS: CheckSpec[] = [
  { name: 'done', command: 'test -f DONE.txt', kind: 'required' },
  { name: 'guard', command: 'test -f GUARD.txt', kind: 'guard' }
]
const CART = "it('adds', () => { expect(1).toBe(1) })\nit('subtracts', () => { expect(2).toBe(2) })\n"
const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }
const HOUR = 60 * 60 * 1000

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
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

afterAll(cleanUp)

interface Scenario {
  delayMs: number
  /** Runs as soon as the agent starts, before the delay. */
  early?: (cwd: string) => void
  write?: (cwd: string) => void
  /** The agent's run ends with some of its processes still alive (the supervisor gave up on them). */
  stuck?: boolean
}

function finished(cwd: string): void {
  writeFileSync(join(cwd, 'DONE.txt'), 'done\n')
  appendFileSync(join(cwd, 'src', 'app.js'), '// changed by the agent\n')
}

const SCENARIOS: Record<string, Scenario> = {
  good: { delayMs: 60, write: finished },
  noChange: { delayMs: 60 },
  slow: { delayMs: 30000, write: finished }
}

interface Harness {
  engine: NightWatch
  repo: string
  dataDir: string
  worktrees: string
  /** Every run an engine of this harness started. */
  runs: RunOptions[]
  /** Every call to keepAwake, in order. */
  awake: boolean[]
  deps: NightWatchDeps
}

type Plan = Record<string, Scenario>

function makeHarness(kinds: AgentKind[], plan: Plan, options: { prepare?: (repo: string) => void; after?: (repo: string) => void; patch?: Partial<NightWatchDeps> } = {}): Harness {
  const repo = temp('regatta-night-restart-')
  sh(['init', '-b', 'main'], repo)
  sh(['config', 'user.name', 'Regatta Test'], repo)
  sh(['config', 'user.email', 'test@regatta.local'], repo)
  mkdirSync(join(repo, 'test'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'test', 'cart.test.js'), CART)
  writeFileSync(join(repo, 'GUARD.txt'), 'guard\n')
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
  options.prepare?.(repo)
  sh(['add', '.'], repo)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], repo)
  options.after?.(repo)
  const worktrees = temp('regatta-night-restart-wt-')
  const dataDir = temp('regatta-night-restart-data-')

  const seen = { runs: [] as RunOptions[], awake: [] as boolean[] }
  const run = (opts: RunOptions): RunHandle => {
    seen.runs.push(opts)
    const lane = basename(opts.cwd).replace(/^night-[a-z0-9]+-/, '')
    const scenario = plan[lane] ?? plan[opts.agent] ?? { delayMs: 0 }
    const started = Date.now()
    let settle!: (result: RunResult) => void
    let closed = false
    const done = new Promise<RunResult>((resolve) => {
      settle = resolve
    })
    const finish = (result: RunResult): void => {
      if (closed) return
      closed = true
      settle(result)
    }
    opts.onActivity(`${opts.agent} is working on the task`)
    scenario.early?.(opts.cwd)
    const clock = setTimeout(() => {
      scenario.write?.(opts.cwd)
      finish({ exitCode: 0, durationMs: Date.now() - started, tokens: 1, stopped: false, ...(scenario.stuck ? { stuck: true } : {}) })
    }, scenario.delayMs)
    clock.unref()
    return {
      done,
      stop: () => {
        clearTimeout(clock)
        finish({ exitCode: null, durationMs: Date.now() - started, tokens: null, stopped: true, ...(scenario.stuck ? { stuck: true } : {}) })
      }
    }
  }
  const deps: NightWatchDeps = {
    dataDir,
    root: () => repo,
    env: () => ENV,
    agents: () => detectedAgents(kinds),
    run,
    emit: () => undefined,
    worktreesDir: () => worktrees,
    keepAwake: (on) => seen.awake.push(on),
    ...options.patch
  }
  return { engine: new NightWatch(deps), repo, dataDir, worktrees, runs: seen.runs, awake: seen.awake, deps }
}

function detectedAgents(kinds: AgentKind[]): DetectedAgent[] {
  return kinds.map((kind) => ({ ...AGENTS[kind], installed: true, path: `/usr/bin/${AGENTS[kind].command}`, version: '1.0' }))
}

function task(prompt: string, agent: AgentKind = 'claude', checks: CheckSpec[] = CHECKS): Omit<NightTask, 'id' | 'createdAt'> {
  return { prompt, agent, checks }
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 60000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A new engine on the same data folder: the app quit and started again. */
function restart(harness: Harness, patch: Partial<NightWatchDeps> = {}): NightWatch {
  return new NightWatch({ ...harness.deps, ...patch })
}

/** The same, on a copy of the data folder as it is right now, for a night the old engine is still busy with. */
function restartOnCopy(harness: Harness, patch: Partial<NightWatchDeps> = {}): NightWatch {
  const dataDir = temp('regatta-night-restart-copy-')
  cpSync(harness.dataDir, dataDir, { recursive: true })
  return new NightWatch({ ...harness.deps, dataDir, ...patch })
}

function night(engine: NightWatch, index = 0): NightState['nights'][number] {
  const found = engine.state().nights[index]
  if (!found) throw new Error(`No night ${index}`)
  return found
}

function runOf(engine: NightWatch, index = 0, nightIndex = 0): NightTaskRun {
  const found = night(engine, nightIndex).runs[index]
  if (!found) throw new Error(`No run ${index}`)
  return found
}

async function runNight(harness: Harness, tasks: Omit<NightTask, 'id' | 'createdAt'>[]): Promise<void> {
  for (const t of tasks) harness.engine.addTask(t)
  await harness.engine.schedule('now')
  await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
}

/** A finished night with one task that passed every gate. */
async function readyRun(plan: Plan = {}, options: { prepare?: (repo: string) => void; after?: (repo: string) => void } = {}, checks: CheckSpec[] = CHECKS): Promise<{ harness: Harness; run: NightTaskRun }> {
  const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']!, ...plan }, options)
  await runNight(harness, [task('good task', 'claude', checks)])
  const run = runOf(harness.engine)
  expect(run.status).toBe('ready')
  return { harness, run }
}

/** What a run's note and the night's notes say when its branch went and a copy of its work was parked first. */
function copyNote(run: NightTaskRun, ref = `refs/regatta/discarded/night-${run.id}`): string {
  return `Kept a copy of the run's work at ${ref} (restore the work with git branch night-${run.id}-restored ${ref}^1; git log ${ref} shows everything kept).`
}

function head(repo: string): string {
  return sh(['rev-parse', 'HEAD'], repo).trim()
}

function branches(repo: string): string[] {
  return sh(['branch', '--list', 'regatta/night-*', '--format=%(refname:short)'], repo).trim().split('\n').filter(Boolean)
}

function stateFile(harness: Harness): { nights: { runs: Record<string, unknown>[] }[] } {
  return JSON.parse(readFileSync(join(harness.dataDir, 'nightwatch.json'), 'utf8'))
}

const sleepers: number[] = []
function leaveSleeper(cwd: string): number {
  const child = spawn('/bin/sh', ['-c', 'exec sleep 120'], { cwd, detached: true, stdio: 'ignore' })
  child.unref()
  sleepers.push(child.pid!)
  return child.pid!
}
afterAll(() => {
  for (const pid of sleepers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
})

describe('what is saved', () => {
  it('keeps the tested commit on the run, and writes both files whole', async () => {
    const { harness, run } = await readyRun()
    const tip = sh(['rev-parse', run.branch!], harness.repo).trim()
    expect(run.tip).toBe(tip)
    expect(stateFile(harness).nights[0]!.runs[0]!['tip']).toBe(tip)
    // The proof that the worktree is the one Regatta made is saved next to the state, in the data folder.
    const saved = JSON.parse(readFileSync(join(harness.dataDir, 'nightwatch-owned.json'), 'utf8'))
    const record = saved.nights[night(harness.engine).id]
    expect(record.dir).toBe(harness.worktrees)
    // The identity names the folder, its inode and its creation time; the disk's device number is not in it.
    expect(record.runs[run.id].owned.identity).toMatch(/^.+\|i\d+\|[\d.e+-]+$/)
    expect(readdirSync(harness.dataDir).sort()).toEqual(['nightwatch-owned.json', 'nightwatch.json'])
  }, 90000)

  it('has no tip on a run that was never scored', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, stuck: true }, codex: SCENARIOS['noChange']! })
    await runNight(harness, [task('leaves a mess')])
    expect(runOf(harness.engine).tip ?? null).toBeNull()
  }, 90000)
})

describe('merging and discarding after a restart', () => {
  it('merges a ready run, and moves its worktree to the trash', async () => {
    const { harness, run } = await readyRun()
    const tip = run.tip!
    const next = restart(harness)
    expect(runOf(next).status).toBe('ready')
    expect(runOf(next).tip).toBe(tip)
    const result = await next.merge(run.id)
    expect(result.summary).toMatch(/^Fast-forwarded main by 1 commit/)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(result.summary).toContain("Moved its worktree to Regatta's trash")
    expect(head(harness.repo)).toBe(tip)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(branches(harness.repo)).toEqual([run.branch])
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    expect(runOf(next).status).toBe('merged')
    expect(runOf(restart(harness)).status).toBe('merged')
  }, 90000)

  it('merges the tested commit into a folder that moved on, with a merge commit', async () => {
    const { harness, run } = await readyRun()
    writeFileSync(join(harness.repo, 'LATER.txt'), 'later\n')
    sh(['add', 'LATER.txt'], harness.repo)
    sh([...IDENTITY, 'commit', '-m', 'work in the folder'], harness.repo)
    const result = await restart(harness).merge(run.id)
    expect(result.summary).toMatch(/^Merged into main with 1 commit/)
    expect(sh(['rev-list', '--parents', '-n', '1', 'HEAD'], harness.repo).trim().split(' ')).toHaveLength(3)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(branches(harness.repo)).toEqual([run.branch])
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
  }, 90000)

  it('discards a run, and moves its worktree to the trash', async () => {
    const { harness, run } = await readyRun()
    const next = restart(harness)
    await next.discard(run.id)
    expect(runOf(next).status).toBe('discarded')
    expect(existsSync(run.worktree!)).toBe(false)
    expect(branches(harness.repo)).toEqual([run.branch])
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    await expect(next.discard(run.id)).rejects.toThrow('That run has already been merged or discarded.')
    await expect(restart(harness).discard(run.id)).rejects.toThrow('That run has already been merged or discarded.')
  }, 90000)

  it('refuses a merge after a restart the same way, and the sentence is saved with the run', async () => {
    const { harness, run } = await readyRun()
    writeFileSync(join(harness.repo, 'GUARD.txt'), 'guard\nbeing edited\n')
    const next = restart(harness)
    await expect(next.merge(run.id)).rejects.toThrow('Commit or stash your changes first.')
    expect(runOf(next).status).toBe('ready')
    expect(runOf(restart(harness)).note).toContain('Not merged: Commit or stash your changes first.')
    sh(['checkout', '--', 'GUARD.txt'], harness.repo)
    expect((await restart(harness).merge(run.id)).merged).toBe(true)
  }, 90000)

  it.skipIf(process.platform !== 'darwin')('moves a worktree that holds its own copy of node_modules to the trash, and emptying the trash removes it', async () => {
    for (const how of ['merge', 'discard'] as const) {
      const prepare = (repo: string): void => {
        writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
        mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
        writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
      }
      const { harness, run } = await readyRun({}, { prepare })
      // The copy is recorded beside the state: its folder's inode and creation time, and no device number.
      const saved = JSON.parse(readFileSync(join(harness.dataDir, 'nightwatch-owned.json'), 'utf8'))
      expect(saved.nights[night(harness.engine).id].runs[run.id].owned.modules).toEqual({ ino: expect.any(Number), birthtimeMs: expect.any(Number) })
      const next = restart(harness)
      if (how === 'merge') expect((await next.merge(run.id)).summary).toContain('Removed 1 worktree and 0 branches.')
      else await next.discard(run.id)
      expect(existsSync(run.worktree!)).toBe(false)
      expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
      expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
      expect(branches(harness.repo)).toEqual([])
      expect(readdirSync(join(harness.worktrees, '.regatta-trash'))).toEqual([])
      expect(readFileSync(join(harness.repo, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    }
  }, 120000)

  it.skipIf(process.platform !== 'darwin')('preserves a worktree whose copy of node_modules is not on the saved record inside the trash', async () => {
    const prepare = (repo: string): void => {
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
      mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    }
    const { harness, run } = await readyRun({}, { prepare })
    const file = join(harness.dataDir, 'nightwatch-owned.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.nights[night(harness.engine).id].runs[run.id].owned.modules = null
    writeFileSync(file, JSON.stringify(saved))
    const next = restart(harness)
    await next.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    const trashed = await listTrash(harness.worktrees)
    expect(trashed).toHaveLength(1)
    expect(readFileSync(join(trashed[0]!.trashPath, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(runOf(next).note).toContain("Moved its worktree to Regatta's trash")
  }, 90000)

  it('moves a night\'s worktree to the trash in the folder it was made in, though the worktrees folder setting changed since', async () => {
    const { harness, run } = await readyRun()
    const elsewhere = temp('regatta-night-restart-elsewhere-')
    const next = restart(harness, { worktreesDir: () => elsewhere })
    await next.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    // A new night uses the folder that is set now.
    next.addTask(task('another task'))
    await next.schedule('now')
    await waitFor('the new night to finish', () => night(next).status === 'finished')
    expect(runOf(next).worktree!.startsWith(elsewhere)).toBe(true)
  }, 90000)

  it('keeps what could not be moved to the trash, and the reason and the leftovers survive more restarts', async () => {
    const { harness, run } = await readyRun()
    writeFileSync(join(run.worktree!, 'MINE.txt'), 'mine\n')
    chmodSync(harness.worktrees, 0o555)
    try {
      const next = restart(harness)
      await next.discard(run.id)
      expect(readFileSync(join(run.worktree!, 'MINE.txt'), 'utf8')).toBe('mine\n')
      expect(branches(harness.repo)).toEqual([run.branch])
      expect(runOf(next).note).toContain('was kept:')

      // Another restart: the reason is still there, on the run and on the night, and the run can still be tried again.
      const again = restart(harness)
      expect(runOf(again).status).toBe('discarded')
      expect(runOf(again).note).toContain('was kept:')
      expect(night(again).notes).toEqual([expect.stringContaining('was kept:')])
      chmodSync(harness.worktrees, 0o755)
      await again.discard(run.id)
      expect(existsSync(run.worktree!)).toBe(false)
      const trashed = await listTrash(harness.worktrees)
      expect(trashed).toHaveLength(1)
      expect(readFileSync(join(trashed[0]!.trashPath, 'MINE.txt'), 'utf8')).toBe('mine\n')
      expect(branches(harness.repo)).toEqual([run.branch])
      // What was kept back is gone from the note; what is said now is where the worktree and the copy of the work were parked.
      expect(runOf(again).note).not.toContain('Kept:')
      const parked = runOf(again).note.match(/at (refs\/regatta\/discarded\/\S+) /)?.[1]
      expect(parked).toMatch(new RegExp(`^refs/regatta/discarded/night-${run.id}(-2)?$`))
      expect(runOf(again).note).toContain(copyNote(run, parked))
      expect(night(again).notes).toEqual([expect.stringContaining("Moved its worktree to Regatta's trash"), copyNote(run, parked)])

      // And once it is in the trash, nothing is left to try again, and the notes are still named after another restart.
      const last = restart(harness)
      expect(night(last).notes).toEqual([expect.stringContaining("Moved its worktree to Regatta's trash"), copyNote(run, parked)])
      expect(runOf(last).note).toContain(copyNote(run, parked))
      await expect(last.discard(run.id)).rejects.toThrow('That run has already been merged or discarded.')
    } finally {
      try {
        chmodSync(harness.worktrees, 0o755)
      } catch {
        // Already writable or gone.
      }
    }
  }, 120000)

  it('moves a worktree a program is using to the trash, and emptyTrash skips it while it is in use', async () => {
    const { harness, run } = await readyRun()
    const pid = leaveSleeper(run.worktree!)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await restart(harness).discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(runOf(restart(harness)).note).toContain("Moved its worktree to Regatta's trash")
    const outcome = await emptyTrash(harness.worktrees)
    expect(outcome.outcomes.filter((o) => o.status === 'skipped')).toHaveLength(1)
    expect(outcome.outcomes[0]?.reason).toContain(String(pid))
  }, 90000)

  it('keeps the folder of an agent that could not be stopped held, though it holds nothing and could otherwise go', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, stuck: true }, codex: SCENARIOS['noChange']! })
    await runNight(harness, [task('leaves a mess')])
    const run = runOf(harness.engine)
    expect(run.status).toBe('failed')
    const next = restart(harness)
    await next.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(true)
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(runOf(next).note).toContain('could not be stopped')
    expect(night(next).notes).toEqual([expect.stringContaining('could not be stopped')])
    // The hold is saved too: another restart, another discard, the same answer.
    await restart(harness).discard(run.id)
    expect(existsSync(run.worktree!)).toBe(true)
    expect(branches(harness.repo)).toEqual([run.branch])
  }, 90000)

  it('finds a run of an earlier night as well as one of the latest', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    await runNight(harness, [task('first night')])
    await runNight(harness, [task('second night', 'codex')])
    const next = restart(harness)
    expect(next.state().nights).toHaveLength(2)
    const old = runOf(next, 0, 1)
    const latest = runOf(next, 0, 0)
    expect(old.status).toBe('ready')
    expect(latest.status).toBe('ready')
    expect((await next.merge(old.id)).merged).toBe(true)
    await next.discard(latest.id)
    expect(existsSync(old.worktree!)).toBe(false)
    expect(existsSync(latest.worktree!)).toBe(false)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(2)
    expect(branches(harness.repo)).toEqual([])
  }, 120000)
})

/**
 * Rewrites the identity saved for a run the way builds before the device number was dropped wrote
 * it (`dir|dev:ino|birth`), with a device number that is not the disk's. `moved` makes the inode or
 * the creation time another one, so the record names a different folder.
 */
function writeOldIdentity(harness: Harness, run: NightTaskRun, moved: 'inode' | 'birth' | null = null): void {
  const file = join(harness.dataDir, 'nightwatch-owned.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  const record = saved.nights[night(harness.engine).id].runs[run.id].owned
  const parts = /^(.*)\|i(\d+)\|(.*)$/.exec(record.identity)
  if (!parts) throw new Error(`Not an identity in the current form: ${record.identity}`)
  const device = lstatSync(parts[1]!).dev + 7
  const inode = moved === 'inode' ? String(Number(parts[2]) + 1) : parts[2]
  const birth = moved === 'birth' ? `${parts[3]}1` : parts[3]
  record.identity = `${parts[1]}|${device}:${inode}|${birth}`
  writeFileSync(file, JSON.stringify(saved))
}

describe('a record made before the device number was left out of worktree identities', () => {
  it('still lets merge and discard move the worktree to the trash, whatever device number the disk has now', async () => {
    for (const how of ['merge', 'discard'] as const) {
      const { harness, run } = await readyRun()
      writeOldIdentity(harness, run)
      expect(JSON.parse(readFileSync(join(harness.dataDir, 'nightwatch-owned.json'), 'utf8')).nights[night(harness.engine).id].runs[run.id].owned.identity).toMatch(/\|\d+:\d+\|/)
      const next = restart(harness)
      if (how === 'merge') expect((await next.merge(run.id)).summary).toContain('Removed 1 worktree and 0 branches.')
      else await next.discard(run.id)
      expect(existsSync(run.worktree!)).toBe(false)
      expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
      expect(branches(harness.repo)).toEqual([])
      expect(next.busyPaths()).toEqual([])
    }
  }, 120000)

  it('does not take a record for another folder, or another time, for the worktree', async () => {
    for (const moved of ['inode', 'birth'] as const) {
      const { harness, run } = await readyRun()
      writeOldIdentity(harness, run, moved)
      const next = restart(harness)
      await next.discard(run.id)
      // Left alone, and said so; the branch stays with it.
      expect(existsSync(run.worktree!)).toBe(true)
      expect(branches(harness.repo)).toEqual([run.branch])
      expect(runOf(next).note).toContain('is not the worktree Regatta made any more')
    }
  }, 120000)
})

describe('the folders in use after a restart', () => {
  it('are the ones the night still owns or holds, from the saved record', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, stuck: true }, codex: SCENARIOS['good']! })
    await runNight(harness, [task('leaves a mess'), task('clean one', 'codex')])
    const stuck = runOf(harness.engine, 0)
    const fine = runOf(harness.engine, 1)
    const next = restart(harness)
    expect([...next.busyPaths()].sort()).toEqual([stuck.worktree!, fine.worktree!].sort())
    await next.merge(fine.id)
    expect(next.busyPaths()).toEqual([stuck.worktree])
    // And after another restart: what is held is still held, and what was removed is not on the list.
    expect(restart(harness).busyPaths()).toEqual([stuck.worktree])
  }, 90000)

  it('are empty for a night that has nothing left, and cover every night in the file', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    await runNight(harness, [task('first night')])
    await runNight(harness, [task('second night', 'codex')])
    const next = restart(harness)
    const folders = next.state().nights.map((n) => n.runs[0]!.worktree!)
    expect([...next.busyPaths()].sort()).toEqual([...folders].sort())
    for (const n of next.state().nights) await next.discard(n.runs[0]!.id)
    expect(next.busyPaths()).toEqual([])
    expect(restart(harness).busyPaths()).toEqual([])
  }, 120000)
})

describe('when what a restart needs is not there', () => {
  it('refuses a merge, and says why, when the tested commit was not saved', async () => {
    const { harness, run } = await readyRun()
    // A state file from before the tested commit was saved.
    const file = join(harness.dataDir, 'nightwatch.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    delete saved.nights[0].runs[0].tip
    writeFileSync(file, JSON.stringify(saved))

    const next = restart(harness)
    const before = head(harness.repo)
    await expect(next.merge(run.id)).rejects.toThrow('Regatta has no record of the commit that was tested for this run, so it cannot be merged.')
    expect(head(harness.repo)).toBe(before)
    expect(runOf(next).status).toBe('ready')
    expect(runOf(next).note).toContain(`The branch ${run.branch} is still there to review.`)
    expect(existsSync(run.worktree!)).toBe(true)

    // A discard still works, moving the worktree to the trash and keeping the branch until the trash is emptied.
    await next.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(runOf(next).note).toContain("Moved its worktree to Regatta's trash")
  }, 90000)

  it('keeps what it cannot prove is its own when the record next to the state is gone', async () => {
    for (const how of ['missing', 'unreadable', 'wrong'] as const) {
      const { harness, run } = await readyRun()
      const file = join(harness.dataDir, 'nightwatch-owned.json')
      if (how === 'missing') rmSync(file)
      else if (how === 'unreadable') writeFileSync(file, '{ this is not json')
      else writeFileSync(file, JSON.stringify({ version: 1, nights: { [night(harness.engine).id]: { dir: 7, runs: 'no' } } }))

      const next = restart(harness)
      expect(runOf(next).status).toBe('ready')
      await next.discard(run.id)
      expect(existsSync(run.worktree!)).toBe(true)
      expect(branches(harness.repo)).toEqual([run.branch])
      expect(runOf(next).note).toContain('cannot tell whether it is the worktree it made')
    }
  }, 120000)

  it('still merges the tested commit when the record is gone, and keeps what it cannot prove', async () => {
    const { harness, run } = await readyRun()
    rmSync(join(harness.dataDir, 'nightwatch-owned.json'))
    const result = await restart(harness).merge(run.id)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(result.summary).toContain('Removed 0 worktrees and 0 branches.')
    expect(result.summary).toContain('cannot tell whether it is the worktree it made')
    expect(existsSync(run.worktree!)).toBe(true)
    expect(branches(harness.repo)).toEqual([run.branch])
  }, 90000)

  it('starts empty, and does not fail to start, when the saved state parses but cannot be used', async () => {
    const { harness } = await readyRun()
    const file = join(harness.dataDir, 'nightwatch.json')
    for (const text of ['{ "nights": [null] }', '{ "nights": [{ "id": "x", "runs": "no" }] }', '{ "nights": "no", "queue": 7 }', 'not json at all']) {
      writeFileSync(file, text)
      const next = restart(harness)
      expect(next.state()).toEqual({ queue: [], nights: [], keepingAwake: false })
    }
  }, 90000)

  it('does not treat a worktree that was removed and made again at the same place as its own', async () => {
    const { harness, run } = await readyRun()
    // The user removes the worktree and makes a new one with the same name, on the same branch, with work of their own.
    sh(['worktree', 'remove', '--force', run.worktree!], harness.repo)
    sh(['worktree', 'add', run.worktree!, run.branch!], harness.repo)
    writeFileSync(join(run.worktree!, 'THEIRS.txt'), 'theirs\n')
    const next = restart(harness)
    await next.discard(run.id)
    expect(readFileSync(join(run.worktree!, 'THEIRS.txt'), 'utf8')).toBe('theirs\n')
    expect(runOf(next).note).toContain('is not the worktree Regatta made any more')
  }, 90000)
})

describe('a night that was running when the app quit', () => {
  it('keeps the runs that were ready mergeable, stops the rest, and lets them be discarded', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['slow']! })
    harness.engine.addTask(task('quick one'))
    harness.engine.addTask(task('slow one', 'codex'))
    await harness.engine.schedule('now')
    await waitFor('the first run to be ready and the second agent to start', () => runOf(harness.engine, 0).status === 'ready' && harness.runs.length === 2)
    await waitFor('the state on disk to show it', () => {
      const saved = JSON.parse(readFileSync(join(harness.dataDir, 'nightwatch.json'), 'utf8')) as NightState
      return saved.nights[0]?.runs[0]?.status === 'ready' && saved.nights[0]?.runs[1]?.status === 'running' && Boolean(saved.nights[0]?.runs[1]?.worktree)
    })
    // The app quits here. The next one starts from what was saved, on its own copy so the old engine's wind-down cannot interfere.
    const next = restartOnCopy(harness)
    expect(night(next).status).toBe('cancelled')
    const [ready, interrupted] = night(next).runs
    expect(ready!.status).toBe('ready')
    expect(interrupted!.status).toBe('stopped')
    expect(interrupted!.note).toBe('Cancelled on app quit')

    expect((await next.merge(ready!.id)).merged).toBe(true)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    // The stopped run's agent had written nothing, so its worktree goes to the trash with a discard.
    await next.discard(interrupted!.id)
    expect(existsSync(interrupted!.worktree!)).toBe(false)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(2)
    expect(branches(harness.repo)).toEqual([])
    harness.engine.cancel()
  }, 120000)
})

describe('a night that was scheduled when the app quit', () => {
  it('gets its timer back and starts when its time comes', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! })
    harness.engine.addTask(task('good task'))
    const startAt = Date.now() + HOUR
    await harness.engine.schedule(startAt)
    // A new engine, whose clock says the time is a second and a half away.
    const next = restart(harness, { now: () => startAt - 1500 })
    expect(night(next).status).toBe('scheduled')
    await expect(next.schedule('now')).rejects.toThrow('A night is already scheduled or running.')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(night(next).status).toBe('scheduled')
    expect(harness.runs).toHaveLength(0)

    await waitFor('the night to start by its timer', () => night(next).status !== 'scheduled', 5000)
    await waitFor('the night to finish', () => night(next).status === 'finished')
    expect(runOf(next).status).toBe('ready')
    expect(harness.runs).toHaveLength(1)
  }, 90000)

  it('can be cancelled after a restart, and then never starts', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! })
    harness.engine.addTask(task('good task'))
    const startAt = Date.now() + HOUR
    await harness.engine.schedule(startAt)
    const next = restart(harness, { now: () => startAt - 300, scheduleCheckMs: 40 })
    next.cancel()
    expect(night(next).status).toBe('cancelled')
    expect(restart(harness).state().nights[0]?.status).toBe('cancelled')
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(night(next).status).toBe('cancelled')
    expect(harness.runs).toHaveLength(0)
    // And the way is free for another night.
    next.addTask(task('another'))
    await expect(next.schedule(startAt + HOUR)).resolves.toBeDefined()
  }, 90000)

  it('is marked missed, not started late, when its time passed while the app was closed, and its tasks go back to the queue', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! })
    harness.engine.addTask(task('first task'))
    harness.engine.addTask(task('second task', 'codex', [{ name: 'other', command: 'true', kind: 'required' }]))
    const startAt = Date.now() + HOUR
    await harness.engine.schedule(startAt)
    expect(harness.engine.state().queue).toHaveLength(0)

    const next = restart(harness, { now: () => startAt + 5 * 60 * 1000 })
    const missed = night(next)
    expect(missed.status).toBe('cancelled')
    expect(missed.finishedAt).not.toBeNull()
    expect(missed.runs.map((r) => [r.status, r.note])).toEqual([
      ['stopped', 'Missed'],
      ['stopped', 'Missed']
    ])
    expect(missed.notes).toEqual([expect.stringMatching(/^Missed: Regatta was not running at \d{4}-\d\d-\d\d \d\d:\d\d, when this night was due, so it was not started\. Its tasks are back in the queue\.$/)])
    // The tasks are where they were, as they were typed.
    expect(next.state().queue.map((t) => [t.prompt, t.agent, t.checks.map((c) => c.name)])).toEqual([
      ['first task', 'claude', ['done', 'guard']],
      ['second task', 'codex', ['other']]
    ])
    // Nothing ran, and the computer was not kept awake.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(harness.runs).toHaveLength(0)
    expect(harness.awake).toEqual([])
    expect(next.state().keepingAwake).toBe(false)

    // It is saved: another restart sees the same, and the queue is not doubled.
    const again = restart(harness, { now: () => startAt + 6 * 60 * 1000 })
    expect(night(again).status).toBe('cancelled')
    expect(night(again).notes).toEqual(missed.notes)
    expect(again.state().queue).toHaveLength(2)

    // The user starts it again with one call, from the queue.
    await again.schedule('now')
    await waitFor('the new night to finish', () => night(again).status === 'finished')
    expect(night(again).runs.map((r) => r.status)).toEqual(['ready', 'failed'])
    expect(again.state().nights).toHaveLength(2)
  }, 90000)

  it('starts a night whose time has not quite come when the app starts again, by the timer', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! })
    harness.engine.addTask(task('good task'))
    const startAt = Date.now() + HOUR
    await harness.engine.schedule(startAt)
    // One millisecond to go: not missed.
    const next = restart(harness, { now: () => startAt - 1 })
    expect(night(next).status).toBe('scheduled')
    expect(next.state().queue).toHaveLength(0)
    await waitFor('the night to finish', () => night(next).status === 'finished', 30000)
  }, 90000)
})

describe('the clock check', () => {
  it('starts a night whose time came while the computer slept, and not before', async () => {
    let clock = Date.now()
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! }, { patch: { now: () => clock, scheduleCheckMs: 40 } })
    harness.engine.addTask(task('good task'))
    const startAt = clock + 10 * 60 * 1000
    await harness.engine.schedule(startAt)
    // Time passes for the clock but the timer, which does not count a sleeping computer's time, has not fired.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(night(harness.engine).status).toBe('scheduled')
    clock = startAt - 1
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(night(harness.engine).status).toBe('scheduled')
    expect(harness.runs).toHaveLength(0)

    clock = startAt + 60 * 60 * 1000
    await waitFor('the clock check to start the night', () => night(harness.engine).status !== 'scheduled', 5000)
    await waitFor('the night to finish', () => night(harness.engine).status === 'finished')
    expect(runOf(harness.engine).status).toBe('ready')
    expect(harness.runs).toHaveLength(1)
    expect(harness.awake).toEqual([true, false])
  }, 90000)

  it('does not start at once a night that is more than 24 days away, which is longer than a timer can wait', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! })
    harness.engine.addTask(task('good task'))
    const startAt = Date.now() + 30 * 24 * HOUR
    await harness.engine.schedule(startAt)
    // The same after a restart.
    const next = restart(harness)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(night(harness.engine).status).toBe('scheduled')
    expect(night(next).status).toBe('scheduled')
    expect(harness.runs).toHaveLength(0)
    next.cancel()
    harness.engine.cancel()
  }, 60000)

  it('starts a night once when the timer and the clock check both come due', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! }, { patch: { scheduleCheckMs: 10 } })
    harness.engine.addTask(task('first task'))
    harness.engine.addTask(task('second task'))
    await harness.engine.schedule(Date.now() + 2000)
    await waitFor('the night to finish', () => night(harness.engine).status === 'finished', 30000)
    expect(harness.runs).toHaveLength(2)
    expect(harness.awake.filter((on) => on)).toHaveLength(1)
    expect(harness.engine.state().nights).toHaveLength(1)
  }, 90000)

  it('makes the usual check when a night starts, so a folder that stopped being a repository fails the night, not the app', async () => {
    let clock = Date.now()
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! }, { patch: { now: () => clock, scheduleCheckMs: 40 } })
    harness.engine.addTask(task('good task'))
    const startAt = clock + HOUR
    await harness.engine.schedule(startAt)
    rmSync(join(harness.repo, '.git'), { recursive: true })
    clock = startAt + 1000
    await waitFor('the night to be over', () => night(harness.engine).status === 'finished', 10000)
    expect(runOf(harness.engine).status).toBe('failed')
    expect(runOf(harness.engine).note).toBe('Night watch needs a git repository with at least one commit.')
    expect(harness.runs).toHaveLength(0)
    expect(harness.awake[harness.awake.length - 1]).toBe(false)
  }, 90000)
})

describe('quitting', () => {
  /** The statuses the saved file gives right now: the first night's, then each of its runs'. */
  function savedStatuses(harness: Harness): string[] {
    const saved = JSON.parse(readFileSync(join(harness.dataDir, 'nightwatch.json'), 'utf8')) as NightState
    const first = saved.nights[0]!
    return [first.status, ...first.runs.map((r) => r.status)]
  }

  /** The statuses in memory: the first night's, then each of its runs'. */
  function liveStatuses(engine: NightWatch): string[] {
    return [night(engine).status, ...night(engine).runs.map((r) => r.status)]
  }

  /** Every name that shows up in `folder` between now and `stop()`. */
  function watchFolder(folder: string): { stop: () => string[] } {
    const seen = new Set<string>()
    const look = (): void => {
      for (const name of readdirSync(folder)) seen.add(name)
    }
    const timer = setInterval(look, 5)
    return {
      stop: () => {
        clearInterval(timer)
        look()
        return [...seen].sort()
      }
    }
  }

  /** A check that leaves a mark only when it runs in the folder made for checks, never in the baseline's. */
  function markingCheck(name: string, mark: string, then = ''): CheckSpec {
    return { name, command: `case "$PWD" in *-check) echo ran >> ${mark}; ${then};; esac; test -f DONE.txt`, kind: 'required' }
  }

  it('starts nothing once the agent is gone: no commit, no check folder, no check, no next run, and no status changes', async () => {
    const mark = join(temp('regatta-night-quit-'), 'checks-ran')
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 1200, write: finished }, codex: SCENARIOS['good']! })
    harness.engine.addTask(task('first task', 'claude', [markingCheck('marker', mark)]))
    harness.engine.addTask(task('second task', 'codex', [markingCheck('marker', mark)]))
    const id = (await harness.engine.schedule('now')).nights[0]!.id
    await waitFor('the first agent to start', () => harness.runs.length === 1)
    const run = runOf(harness.engine, 0)
    const watching = watchFolder(harness.worktrees)

    expect(harness.engine.quit()).toBeUndefined()
    harness.engine.quit()
    // Saved as it stands: running, running, queued.
    const before = savedStatuses(harness)
    expect(before).toEqual(['running', 'running', 'queued'])

    // The agent ends (quitting stops it) and everything pending settles.
    await waitFor('the night to wind down', () => harness.awake.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(watching.stop()).toEqual([`night-${id}-claude`])
    expect(harness.runs).toHaveLength(1)
    expect(existsSync(mark)).toBe(false)
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(2)
    // Nothing was committed on the way out: what the agent wrote is still in its folder, uncommitted.
    expect(sh(['rev-list', '--count', `${run.base}..${run.branch}`], harness.repo).trim()).toBe('0')
    expect(sh(['status', '--porcelain'], run.worktree!).split('\n').filter(Boolean).sort()).toEqual([' M src/app.js', '?? DONE.txt'])
    // No status changed, on disk or in memory, and the computer was let go.
    expect(savedStatuses(harness)).toEqual(before)
    expect(liveStatuses(harness.engine)).toEqual(before)
    expect(harness.awake).toEqual([true, false])

    // The next start treats it the way it treats any night that was running when the app quit.
    const next = restart(harness)
    expect(night(next).status).toBe('cancelled')
    expect(night(next).runs.map((r) => [r.status, r.note])).toEqual([
      ['stopped', 'Cancelled on app quit'],
      ['stopped', 'Cancelled on app quit']
    ])
    // And what the stopped run left is looked after as always: a discard moves its folder and uncommitted work to the trash.
    await next.discard(runOf(next, 0).id)
    expect(existsSync(run.worktree!)).toBe(false)
    const trashed = await listTrash(harness.worktrees)
    expect(trashed).toHaveLength(1)
    expect(existsSync(join(trashed[0]!.trashPath, 'DONE.txt'))).toBe(true)
    expect(runOf(next, 0).note).toContain("Moved its worktree to Regatta's trash")
  }, 90000)

  it('starts no later check once the app is quitting, and stops the one that is running', async () => {
    const dir = temp('regatta-night-quit-')
    const first = join(dir, 'first-check-ran')
    const second = join(dir, 'second-check-ran')
    const checks = [markingCheck('first', first, 'sleep 20'), markingCheck('second', second)]
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    harness.engine.addTask(task('first task', 'claude', checks))
    harness.engine.addTask(task('second task', 'codex', checks))
    const id = (await harness.engine.schedule('now')).nights[0]!.id
    await waitFor('the first check to be running', () => existsSync(first))
    const watching = watchFolder(harness.worktrees)

    harness.engine.quit()
    const before = savedStatuses(harness)
    expect(before).toEqual(['running', 'checking', 'queued'])
    await waitFor('the night to wind down', () => harness.awake.length === 2, 30000)
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(existsSync(second)).toBe(false)
    expect(harness.runs).toHaveLength(1)
    // The folder made for the checks before the quit was cleaned up as always; nothing else appeared.
    expect(watching.stop().filter((name) => name.includes('codex'))).toEqual([])
    expect(readdirSync(harness.worktrees)).toEqual([`night-${id}-claude`])
    expect(savedStatuses(harness)).toEqual(before)
    expect(liveStatuses(harness.engine)).toEqual(before)
    // What was committed before the quit is the run's tested commit, saved, so a restart can deal with the run.
    const run = runOf(harness.engine, 0)
    expect(run.tip).toBe(sh(['rev-parse', run.branch!], harness.repo).trim())
    const next = restart(harness)
    expect(runOf(next, 0).status).toBe('stopped')
    await next.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
  }, 90000)

  it('starts no run when the app quits during the baseline', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    const slow: CheckSpec[] = [{ name: 'slow', command: 'case "$PWD" in *-base) sleep 20;; esac; true', kind: 'required' }]
    harness.engine.addTask(task('first task', 'claude', slow))
    harness.engine.addTask(task('second task', 'codex', slow))
    await harness.engine.schedule('now')
    await waitFor('the baseline to be in use', () => harness.engine.busyPaths().some((path) => path.endsWith('-base')))
    const watching = watchFolder(harness.worktrees)

    harness.engine.quit()
    const before = savedStatuses(harness)
    expect(before).toEqual(['running', 'queued', 'queued'])
    await waitFor('the night to wind down', () => harness.awake.length === 2, 30000)
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(harness.runs).toHaveLength(0)
    expect(watching.stop().filter((name) => !name.endsWith('-base'))).toEqual([])
    expect(readdirSync(harness.worktrees)).toEqual([])
    expect(branches(harness.repo)).toEqual([])
    expect(harness.engine.busyPaths()).toEqual([])
    expect(savedStatuses(harness)).toEqual(before)
    expect(liveStatuses(harness.engine)).toEqual(before)
  }, 90000)

  it('does not start a night whose time comes while the app is quitting', async () => {
    // The clock is looked at every 30 ms, so without quit() the night would start at its time.
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! }, { patch: { scheduleCheckMs: 30 } })
    harness.engine.addTask(task('good task'))
    await harness.engine.schedule(Date.now() + 700)
    harness.engine.quit()
    await new Promise((resolve) => setTimeout(resolve, 1400))
    expect(night(harness.engine).status).toBe('scheduled')
    expect(harness.runs).toHaveLength(0)
    expect(readdirSync(harness.worktrees)).toEqual([])
    expect(harness.awake).toEqual([])
    expect(savedStatuses(harness)).toEqual(['scheduled', 'queued'])
    // The next start gives it its timer back, as for any night that was scheduled when the app quit.
    const next = restart(harness, { now: () => Date.now() - 60 * 60 * 1000 })
    expect(night(next).status).toBe('scheduled')
  }, 90000)

  it('refuses a new night, merge or discard after quit, and lets a merge that is under way finish', async () => {
    const own = (cwd: string): void => writeFileSync(join(cwd, `${basename(cwd)}.txt`), 'mine\n')
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: own }, codex: { delayMs: 60, write: own } })
    const ok: CheckSpec[] = [{ name: 'ok', command: 'true', kind: 'required' }]
    await runNight(harness, [task('first', 'claude', ok), task('second', 'codex', ok)])
    const [a, b] = night(harness.engine).runs
    expect([a!.status, b!.status]).toEqual(['ready', 'ready'])

    const underWay = harness.engine.merge(a!.id)
    harness.engine.quit()
    await expect(harness.engine.merge(b!.id)).rejects.toThrow('Regatta is closing, so nothing was merged.')
    await expect(harness.engine.discard(b!.id)).rejects.toThrow('Regatta is closing, so nothing was removed.')
    harness.engine.addTask(task('another'))
    await expect(harness.engine.schedule('now')).rejects.toThrow('Regatta is closing, so no night was scheduled.')
    // The merge that was asked for before is not cut off.
    expect((await underWay).merged).toBe(true)
    expect(existsSync(join(harness.repo, `${basename(a!.worktree!)}.txt`))).toBe(true)
    // The refused run is as it was: ready, with its folder and branch, and no note about the refusal.
    expect(runOf(harness.engine, 1).status).toBe('ready')
    expect(runOf(harness.engine, 1).note).toBe('All gates passed')
    expect(existsSync(a!.worktree!)).toBe(false)
    expect(existsSync(b!.worktree!)).toBe(true)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([b!.branch])
  }, 90000)

  it('stops measuring the live diff of the running run, which would touch its folder\'s index', async () => {
    // The agent writes a new file as it starts and keeps going. Measuring the diff marks new files as
    // intent to add, a change to the folder's index, every five seconds.
    const writeEarly = (cwd: string): void => writeFileSync(join(cwd, 'NEW.txt'), 'new\n')
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 30000, early: writeEarly }, codex: SCENARIOS['good']! })
    harness.engine.addTask(task('slow task'))
    await harness.engine.schedule('now')
    await waitFor('the agent to start', () => harness.runs.length === 1)
    const folder = runOf(harness.engine, 0).worktree!
    harness.engine.quit()
    await new Promise((resolve) => setTimeout(resolve, 6500))
    // Still just an untracked file: the measurement did not run.
    expect(sh(['status', '--porcelain'], folder).trim()).toBe('?? NEW.txt')
    harness.engine.cancel()
  }, 90000)

  it('is synchronous and safe to call again, with or without a night', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    expect(harness.engine.quit()).toBeUndefined()
    // It saved the state on the way (there was nothing on disk before) ...
    const file = join(harness.dataDir, 'nightwatch.json')
    expect(existsSync(file)).toBe(true)
    // ... and a second call does nothing: it does not write again.
    rmSync(file)
    expect(harness.engine.quit()).toBeUndefined()
    expect(existsSync(file)).toBe(false)
    expect(harness.engine.state().nights).toEqual([])
    // Nothing else about the state is touched: tasks can still be queued and taken out.
    harness.engine.addTask(task('good task'))
    expect(harness.engine.state().queue).toHaveLength(1)
    // And a finished night is left as it is.
    const { harness: done, run } = await readyRun()
    const before = JSON.stringify(done.engine.state())
    done.engine.quit()
    done.engine.quit()
    expect(JSON.stringify(done.engine.state())).toBe(before)
    expect(runOf(done.engine).status).toBe('ready')
    expect(run.status).toBe('ready')
  }, 90000)
})

