// The night watch engine against a real git repository, with a fake agent that writes files.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '../../shared/agents'
import type { CheckSpec, CheckResult, GateResult, TestCounts } from '../../shared/heats'
import type { NightState, NightTaskRun } from '../../shared/nightwatch'
import type { MergeResult } from '../../shared/ipc'
import type { AgentKind, DetectedAgent } from '../../shared/types'
import { NightWatch as RealNightWatch } from './engine'
import { emptyTrash, listTrash } from '../heats/git-ops'
import type { NightWatchDeps } from './engine'
import type { RunHandle, RunOptions, RunResult } from '../heats/runner'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']
const CHECKS: CheckSpec[] = [
  { name: 'done', command: 'test -f DONE.txt', kind: 'required' },
  { name: 'guard', command: 'test -f GUARD.txt', kind: 'guard' }
]
const CART = "it('adds', () => { expect(1).toBe(1) })\nit('subtracts', () => { expect(2).toBe(2) })\n"
const GUARD = 'guard\n'
const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }

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

interface Scenario {
  delayMs: number
  exitCode?: number
  write?: (cwd: string) => void
}

function finished(cwd: string): void {
  writeFileSync(join(cwd, 'DONE.txt'), 'done\n')
  appendFileSync(join(cwd, 'src', 'app.js'), '// changed by the agent\n')
}

const SCENARIOS: Record<string, Scenario> = {
  good: { delayMs: 60, write: finished },
  breakGuard: {
    delayMs: 60,
    write: (cwd) => {
      finished(cwd)
      unlinkSync(join(cwd, 'GUARD.txt'))
    }
  },
  noChange: { delayMs: 60 }
}

interface Harness {
  engine: NightWatch
  repo: string
  dataDir: string
  worktrees: string
  stopped: AgentKind[]
  runs: RunOptions[]
  emitted: NightState[]
  fakeNow: number
}

function makeHarness(kinds: AgentKind[], plan: Partial<Record<AgentKind, Scenario>>): Harness {
  const repo = temp('regatta-night-run-')
  sh(['init', '-b', 'main'], repo)
  mkdirSync(join(repo, 'test'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'test', 'cart.test.js'), CART)
  writeFileSync(join(repo, 'GUARD.txt'), GUARD)
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
  sh(['add', '.'], repo)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], repo)
  const worktrees = temp('regatta-night-wt-')
  const dataDir = temp('regatta-night-data-')

  const seen: Omit<Harness, 'engine'> = {
    repo,
    worktrees,
    dataDir,
    stopped: [],
    runs: [],
    emitted: [],
    fakeNow: Date.now()
  }

  const run = (opts: RunOptions): RunHandle => {
    seen.runs.push(opts)
    const scenario = plan[opts.agent] ?? { delayMs: 0 }
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
    opts.onTokens(4321)
    const clock = setTimeout(() => {
      scenario.write?.(opts.cwd)
      finish({ exitCode: scenario.exitCode ?? 0, durationMs: Date.now() - started, tokens: 4321, stopped: false })
    }, scenario.delayMs)
    clock.unref()
    return {
      done,
      stop: () => {
        seen.stopped.push(opts.agent)
        clearTimeout(clock)
        finish({ exitCode: null, durationMs: Date.now() - started, tokens: null, stopped: true })
      }
    }
  }

  const engine = new NightWatch({
    dataDir: dataDir,
    root: () => repo,
    env: () => ENV,
    agents: () => detectedAgents(kinds),
    run,
    emit: (state) => seen.emitted.push(state),
    worktreesDir: () => worktrees,
    keepAwake: () => undefined,
    now: () => seen.fakeNow
  })
  return { ...seen, engine }
}

function detectedAgents(kinds: AgentKind[]): DetectedAgent[] {
  return kinds.map((kind) => ({
    ...AGENTS[kind],
    installed: true,
    path: `/usr/bin/${AGENTS[kind].command}`,
    version: '1.0'
  }))
}

function task(prompt: string, agent: AgentKind = 'claude', checks = CHECKS): Omit<import('../../shared/nightwatch').NightTask, 'id' | 'createdAt'> {
  return { prompt, agent, checks }
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 60000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function night(harness: Harness, id: string) {
  const found = harness.engine.state().nights.find((n) => n.id === id)
  if (!found) throw new Error(`Night ${id} is not in the list`)
  return found
}

function runOf(state: NightState, runId: string): NightTaskRun {
  for (const n of state.nights) {
    const found = n.runs.find((r) => r.id === runId)
    if (found) return found
  }
  throw new Error(`No run ${runId}`)
}

function gate(run: NightTaskRun, id: GateResult['id']): GateResult {
  const found = run.gates.find((g) => g.id === id)
  if (!found) throw new Error(`No ${id} gate on run ${run.id}`)
  return found
}

afterAll(cleanUp)

describe('adding and removing tasks', () => {
  const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })

  it('validates the task and appends to the queue', () => {
    expect(harness.engine.state().queue).toHaveLength(0)
    harness.engine.addTask(task('first task'))
    expect(harness.engine.state().queue).toHaveLength(1)
    expect(harness.engine.state().queue[0]?.prompt).toBe('first task')
    expect(harness.engine.state().queue[0]?.agent).toBe('claude')
    expect(harness.engine.state().queue[0]?.checks).toEqual(CHECKS)

    harness.engine.addTask(task('second task', 'codex'))
    expect(harness.engine.state().queue).toHaveLength(2)
    expect(harness.engine.state().queue[1]?.prompt).toBe('second task')
    expect(harness.engine.state().queue[1]?.agent).toBe('codex')
  })

  it('refuses a task without a prompt', () => {
    expect(() => harness.engine.addTask({ prompt: '   ', agent: 'claude', checks: CHECKS })).toThrow('A task needs a prompt.')
  })

  it('refuses a task without checks', () => {
    expect(() => harness.engine.addTask({ prompt: 'do something', agent: 'claude', checks: [] })).toThrow('A task needs at least one check.')
  })

  it('refuses a task for an agent that is not installed', () => {
    const missing = makeHarness(['claude'], { claude: SCENARIOS['good']! })
    expect(() => missing.engine.addTask(task('do something', 'codex'))).toThrow('Codex is not installed.')
  })

  it('removes a task from the queue', () => {
    const id = harness.engine.state().queue[0]?.id ?? ''
    harness.engine.removeTask(id)
    expect(harness.engine.state().queue).toHaveLength(1)
    expect(harness.engine.state().queue[0]?.prompt).toBe('second task')
  })

  it('throws when removing a task that does not exist', () => {
    expect(() => harness.engine.removeTask('not-a-real-id')).toThrow('That task is not in the queue.')
  })

  it('persists the queue to disk and reloads it', () => {
    const id = harness.engine.state().queue[0]?.id ?? ''
    const newEngine = new NightWatch({
      dataDir: harness.dataDir,
      root: () => harness.repo,
      env: () => ENV,
      agents: () => detectedAgents(['claude', 'codex']),
      run: () => { throw new Error('not used') },
      emit: () => undefined,
      worktreesDir: () => harness.worktrees,
      keepAwake: () => undefined
    })
    expect(newEngine.state().queue).toHaveLength(1)
    expect(newEngine.state().queue[0]?.id).toBe(id)
    expect(newEngine.state().queue[0]?.prompt).toBe('second task')
  })
})

describe('scheduling a night', () => {
  it('refuses when the queue is empty', async () => {
    const empty = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    await expect(empty.engine.schedule('now')).rejects.toThrow('The queue is empty.')
  })

  it('refuses when a night is already running', async () => {
    const running = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    running.engine.addTask(task('task one'))
    running.engine.addTask(task('task two'))
    await running.engine.schedule('now')
    await waitFor('the night to start', () => running.engine.state().nights[0]?.status === 'running')
    await expect(running.engine.schedule('now')).rejects.toThrow('A night is already scheduled or running.')
    running.engine.cancel()
    await waitFor('the night to cancel', () => running.engine.state().nights[0]?.status === 'cancelled')
  })

  it('refuses when a night is already scheduled', async () => {
    const future = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    future.engine.addTask(task('task one'))
    const startAt = future.fakeNow + 60000
    await future.engine.schedule(startAt)
    await expect(future.engine.schedule('now')).rejects.toThrow('A night is already scheduled or running.')
    future.engine.cancel()
  })

  it('refuses when the repo has no commits', async () => {
    const plain = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    rmSync(plain.repo, { recursive: true, force: true })
    mkdirSync(plain.repo, { recursive: true })
    plain.engine.addTask(task('task one'))
    await expect(plain.engine.schedule('now')).rejects.toThrow('Night watch needs a git repository with at least one commit.')
  })

  it('starts immediately when "now"', async () => {
    const now = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    now.engine.addTask(task('task one'))
    now.engine.addTask(task('task two', 'codex'))
    const before = now.fakeNow
    const state = await now.engine.schedule('now')
    expect(state.nights[0]?.status).toBe('running')
    expect(state.nights[0]?.startAt).toBeGreaterThanOrEqual(before)
    expect(state.nights[0]?.runs).toHaveLength(2)
    expect(state.queue).toHaveLength(0)
  })

  it('schedules for a future time and does not start early', async () => {
    const future = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    future.engine.addTask(task('task one'))
    const scheduledTime = future.fakeNow + 1000
    const state = await future.engine.schedule(scheduledTime)
    expect(state.nights[0]?.status).toBe('scheduled')
    expect(state.nights[0]?.startAt).toBe(scheduledTime)

    await waitFor('the scheduled time to pass', () => future.engine.state().nights[0]?.status === 'running', 2000)
  }, 10000)

  it('refuses a start time in the past', async () => {
    const past = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    past.engine.addTask(task('task one'))
    await expect(past.engine.schedule(past.fakeNow - 1000)).rejects.toThrow('The start time must be in the future.')
  })
})

describe('two tasks run one after the other and both become ready', () => {
  const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
  let nightId = ''

  beforeAll(async () => {
    harness.engine.addTask(task('good task one'))
    harness.engine.addTask(task('good task two', 'codex'))
    const state = await harness.engine.schedule('now')
    nightId = state.nights[0]!.id
    await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
  }, 120000)

  it('runs baseline checks once per night', () => {
    const state = harness.engine.state()
    const n = state.nights.find((x) => x.id === nightId)!
    expect(n.runs[0]?.base).toBe(n.runs[1]?.base)
  })

  it('gives each run its own worktree and branch', () => {
    const state = harness.engine.state()
    const n = state.nights.find((x) => x.id === nightId)!
    expect(n.runs[0]?.worktree).toContain(`night-${nightId}-claude`)
    expect(n.runs[1]?.worktree).toContain(`night-${nightId}-codex`)
    expect(n.runs[0]?.branch).toBe(`regatta/night-${nightId}-claude`)
    expect(n.runs[1]?.branch).toBe(`regatta/night-${nightId}-codex`)
  })

  it('commits what the agent left, runs checks and evaluates gates', () => {
    const state = harness.engine.state()
    const n = state.nights.find((x) => x.id === nightId)!
    for (const run of n.runs) {
      expect(run.status).toBe('ready')
      expect(run.exitCode).toBe(0)
      expect(run.diff.files).toBeGreaterThan(0)
      expect(run.checks.map((c) => [c.name, c.passed])).toEqual([
        ['done', true],
        ['guard', true]
      ])
      expect(run.gates.map((g) => [g.id, g.passed])).toEqual([
        ['finished', true],
        ['changed', true],
        ['checks', true],
        ['no-regressions', true],
        ['integrity', true]
      ])
      expect(run.note).toBe('All gates passed')
    }
  })

  it('keeps the computer awake while running and releases it after', () => {
    const states = harness.emitted.filter((s) => s.nights.some((n) => n.id === nightId))
    const running = states.find((s) => s.nights.find((n) => n.id === nightId)?.status === 'running')
    const finished = states.find((s) => s.nights.find((n) => n.id === nightId)?.status === 'finished')
    expect(running?.keepingAwake).toBe(true)
    expect(finished?.keepingAwake).toBe(false)
  })
})

describe('a task that breaks a guard check fails no-regressions', () => {
  const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['breakGuard']!, codex: SCENARIOS['good']! })
  let nightId = ''

  beforeAll(async () => {
    harness.engine.addTask(task('break guard task'))
    harness.engine.addTask(task('good task', 'codex'))
    const state = await harness.engine.schedule('now')
    nightId = state.nights[0]!.id
    await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
  }, 120000)

  it('marks the broken run as failed with the first failed gate', () => {
    const state = harness.engine.state()
    const n = state.nights.find((x) => x.id === nightId)!
    const broken = n.runs[0]!
    expect(broken.status).toBe('failed')
    expect(gate(broken, 'no-regressions').passed).toBe(false)
    expect(gate(broken, 'no-regressions').detail).toBe('broke: guard')
    expect(broken.note).toBe('broke: guard')
  })

  it('the other run still passes', () => {
    const state = harness.engine.state()
    const n = state.nights.find((x) => x.id === nightId)!
    const good = n.runs[1]!
    expect(good.status).toBe('ready')
    expect(gate(good, 'no-regressions').passed).toBe(true)
  })
})

describe('cancelling a night', () => {
  it('cancels a scheduled night', async () => {
    const future = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    future.engine.addTask(task('task one'))
    const startAt = future.fakeNow + 60000
    await future.engine.schedule(startAt)
    future.engine.cancel()
    expect(future.engine.state().nights[0]?.status).toBe('cancelled')
    expect(future.engine.state().nights[0]?.finishedAt).not.toBeNull()
  })

  it('stops a running agent and marks runs stopped', async () => {
    const slow = makeHarness(['claude', 'codex'], {
      claude: { ...SCENARIOS['good']!, delayMs: 30000 },
      codex: { ...SCENARIOS['good']!, delayMs: 30000 }
    })
    slow.engine.addTask(task('slow task one'))
    slow.engine.addTask(task('slow task two', 'codex'))
    await slow.engine.schedule('now')
    await waitFor('the first run to start', () => slow.engine.state().nights[0]?.runs[0]?.status === 'running')
    slow.engine.cancel()
    await waitFor('the night to cancel', () => slow.engine.state().nights[0]?.status === 'cancelled')
    const state = slow.engine.state()
    const n = state.nights[0]!
    expect(n.status).toBe('cancelled')
    expect(n.runs[0]?.status).toBe('stopped')
    expect(n.runs[0]?.note).toBe('Cancelled')
    expect(state.keepingAwake).toBe(false)
  }, 60000)
})

describe('merging a ready run', () => {
  const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
  let nightId = ''
  let runId = ''

  beforeAll(async () => {
    harness.engine.addTask(task('merge task'))
    const state = await harness.engine.schedule('now')
    nightId = state.nights[0]!.id
    await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
    runId = harness.engine.state().nights[0]!.runs[0]!.id
  }, 120000)

  it('refuses when the root has changes', async () => {
    writeFileSync(join(harness.repo, 'GUARD.txt'), 'guard\nbeing edited\n')
    await expect(harness.engine.merge(runId)).rejects.toThrow('Commit or stash your changes first.')
    writeFileSync(join(harness.repo, 'GUARD.txt'), GUARD)
  })

  it('merges the run and brings the change home', async () => {
    const result = await harness.engine.merge(runId)
    expect(result.merged).toBe(true)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')

    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(readFileSync(join(harness.repo, 'src', 'app.js'), 'utf8')).toContain('changed by the agent')
    expect(sh(['log', '-1', '--format=%s'], harness.repo).trim()).toContain(`Night ${nightId}`)

    const state = harness.engine.state()
    const n = state.nights.find((x) => x.id === nightId)!
    const run = n.runs[0]!
    expect(run.status).toBe('merged')
    expect(existsSync(run.worktree!)).toBe(false)
  }, 60000)

  it('will not merge the same run twice', async () => {
    await expect(harness.engine.merge(runId)).rejects.toThrow('Only a ready run can be merged.')
  }, 30000)
})

describe('discarding a run', () => {
  const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
  let nightId = ''
  let runId = ''

  beforeAll(async () => {
    harness.engine.addTask(task('discard task'))
    const state = await harness.engine.schedule('now')
    nightId = state.nights[0]!.id
    await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
    runId = harness.engine.state().nights[0]!.runs[0]!.id
  }, 120000)

  it('removes the worktree and branch, marks run discarded', async () => {
    const run = harness.engine.state().nights[0]!.runs[0]!
    const worktree = run.worktree!
    const branch = run.branch!
    await harness.engine.discard(runId)

    const state = harness.engine.state()
    const run2 = state.nights.find((n) => n.id === nightId)!.runs[0]!
    expect(run2.status).toBe('discarded')
    expect(existsSync(worktree)).toBe(false)
    expect(await listTrash(harness.worktrees)).toHaveLength(1)
    await emptyTrash(harness.worktrees)
    expect(sh(['branch', '--list', branch], harness.repo).trim()).toBe('')
  }, 60000)

  it('refuses to discard a merged run', async () => {
    await expect(harness.engine.discard(runId)).rejects.toThrow('That run has already been merged or discarded.')
  }, 30000)
})

describe('state reloads in a new engine', () => {
  const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
  let nightId = ''

  beforeAll(async () => {
    harness.engine.addTask(task('reload task one'))
    harness.engine.addTask(task('reload task two', 'codex'))
    const state = await harness.engine.schedule('now')
    nightId = state.nights[0]!.id
    await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
  }, 120000)

  it('loads the nights and runs from disk', () => {
    const newEngine = new NightWatch({
      dataDir: harness.dataDir,
      root: () => harness.repo,
      env: () => ENV,
      agents: () => detectedAgents(['claude', 'codex']),
      run: () => { throw new Error('not used') },
      emit: () => undefined,
      worktreesDir: () => harness.worktrees,
      keepAwake: () => undefined
    })
    const state = newEngine.state()
    expect(state.nights.length).toBeGreaterThanOrEqual(1)
    const n = state.nights.find((x) => x.id === nightId)!
    expect(n).toBeDefined()
    expect(n.runs).toHaveLength(2)
    expect(n.runs[0]?.status).toBe('ready')
    expect(n.runs[1]?.status).toBe('ready')
  })

  it('a night that was running when the app quit loads as cancelled with unfinished runs stopped', async () => {
    const crash = makeHarness(['claude', 'codex'], {
      claude: { ...SCENARIOS['good']!, delayMs: 30000 },
      codex: { ...SCENARIOS['good']!, delayMs: 30000 }
    })
    crash.engine.addTask(task('crash task'))
    await crash.engine.schedule('now')
    await waitFor('the run to start', () => crash.engine.state().nights[0]?.runs[0]?.status === 'running')

    const dataDir = crash.dataDir
    const worktrees = crash.worktrees
    const repo = crash.repo
    crash.engine.cancel()

    const newEngine = new NightWatch({
      dataDir,
      root: () => repo,
      env: () => ENV,
      agents: () => detectedAgents(['claude', 'codex']),
      run: () => { throw new Error('not used') },
      emit: () => undefined,
      worktreesDir: () => worktrees,
      keepAwake: () => undefined
    })
    const state = newEngine.state()
    const n = state.nights[0]!
    expect(n.status).toBe('cancelled')
    expect(n.runs[0]?.status).toBe('stopped')
    expect(n.finishedAt).not.toBeNull()
  }, 60000)
})

describe('live diff sampler', () => {
  it('keeps the last good DiffStat of 7 changed files and sets run.error when the index is corrupted, then clears the error when repaired', async () => {
    const harness = makeHarness(['claude', 'codex'], {
      claude: {
        delayMs: 30000,
        write: finished
      }
    })
    harness.engine.addTask(task('sampler task'))
    await harness.engine.schedule('now')
    await waitFor(
      'the run to start',
      () =>
        harness.engine.state().nights[0]?.runs[0]?.status === 'running' &&
        Boolean(harness.engine.state().nights[0]?.runs[0]?.worktree)
    )

    const initialRun = harness.engine.state().nights[0]!.runs[0]!
    for (let i = 1; i <= 7; i++) {
      writeFileSync(join(initialRun.worktree!, `changed-${i}.txt`), `content ${i}\n`)
    }

    await waitFor('7 changed files to be sampled', () => harness.engine.state().nights[0]?.runs[0]?.diff.files === 7, 15000)
    const firstSample = harness.engine.state().nights[0]!.runs[0]!
    expect(firstSample.diff.files).toBe(7)
    expect(firstSample.error ?? null).toBeNull()

    const dotGit = readFileSync(join(firstSample.worktree!, '.git'), 'utf8').trim()
    const gitDir = dotGit.replace(/^gitdir:\s*/, '')
    const indexFile = join(gitDir, 'index')
    const savedIndex = readFileSync(indexFile)

    writeFileSync(indexFile, 'corrupt-index-bytes')
    try {
      await waitFor('sampler to report corrupt index error', () => Boolean(harness.engine.state().nights[0]?.runs[0]?.error), 15000)
      const brokenSample = harness.engine.state().nights[0]!.runs[0]!
      expect(brokenSample.diff.files).toBe(7)
      expect(brokenSample.error).toMatch(/index|corrupt|signature|fatal|error/i)
    } finally {
      writeFileSync(indexFile, savedIndex)
    }

    await waitFor('sampler to clear error after index is repaired', () => !harness.engine.state().nights[0]?.runs[0]?.error, 15000)
    const repairedSample = harness.engine.state().nights[0]!.runs[0]!
    expect(repairedSample.diff.files).toBe(7)
    expect(repairedSample.error ?? null).toBeNull()

    harness.engine.cancel()
  }, 60000)
})