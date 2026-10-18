// The heat engine against a real git repository, with a fake agent that writes files.

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENTS } from '../../shared/agents'
import type { CheckSpec, GateResult, HeatState, LaneState } from '../../shared/heats'
import type { StartHeatOptions } from '../../shared/ipc'
import type { AgentKind, DetectedAgent } from '../../shared/types'
import { HeatEngine } from './engine'
import { emptyTrash, listTrash } from './git-ops'
import { withRepoLock } from './repo-lock'
import type { HeatEngineDeps } from './engine'
import type { RunHandle, RunOptions, RunResult } from './runner'

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

/** What the fake agent does in its lane, and how long it takes. */
interface Scenario {
  delayMs: number
  exitCode?: number
  write?: (cwd: string) => void
  /** Runs as soon as the agent starts, before the delay. */
  early?: (cwd: string) => void
  /** The duration the agent reports, instead of the real one (so tie bands do not depend on timer jitter). */
  reportMs?: number
  /** How many activity lines the agent reports as soon as it starts. */
  chatter?: number
  /** The agent's run ends with some of its processes still alive (the supervisor gave up on them). */
  stuck?: boolean
}

function finished(cwd: string): void {
  writeFileSync(join(cwd, 'DONE.txt'), 'done\n')
  appendFileSync(join(cwd, 'src', 'app.js'), '// changed by the agent\n')
}

const SCENARIOS: Record<string, Scenario> = {
  good: { delayMs: 60, write: finished },
  deleteTests: {
    delayMs: 60,
    write: (cwd) => {
      finished(cwd)
      unlinkSync(join(cwd, 'test', 'cart.test.js'))
    }
  },
  breakGuard: {
    delayMs: 60,
    write: (cwd) => {
      finished(cwd)
      unlinkSync(join(cwd, 'GUARD.txt'))
    }
  },
  noChange: { delayMs: 60 },
  fail: { delayMs: 60, exitCode: 2, write: finished }
}

interface Harness {
  engine: HeatEngine
  repo: string
  worktrees: string
  /** Agents whose run was stopped by the engine. */
  stopped: AgentKind[]
  /** Every run the engine started, with the prompt and folder it used. */
  runs: RunOptions[]
  /** Every heat state the engine emitted. */
  emitted: HeatState[]
  /** When each state in `emitted` was emitted. */
  emittedAt: number[]
  /** The dependencies the engine was built with, for building a second engine on the same repository. */
  deps: HeatEngineDeps
}

/** Scenarios by agent ("claude") or by numbered lane when an agent races twice ("claude-2"). */
type Plan = Record<string, Scenario>

function makeHarness(kinds: AgentKind[], plan: Plan, patch: Partial<HeatEngineDeps> = {}): Harness {
  const repo = temp('regatta-heat-run-')
  sh(['init', '-b', 'main'], repo)
  // Merges that need a commit use the repository user's identity.
  sh(['config', 'user.name', 'Regatta Test'], repo)
  sh(['config', 'user.email', 'test@regatta.local'], repo)
  mkdirSync(join(repo, 'test'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'test', 'cart.test.js'), CART)
  writeFileSync(join(repo, 'GUARD.txt'), GUARD)
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
  sh(['add', '.'], repo)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], repo)
  const worktrees = temp('regatta-heat-wt-')

  const seen: Omit<Harness, 'engine' | 'deps'> = { repo, worktrees, stopped: [], runs: [], emitted: [], emittedAt: [] }
  const run = (opts: RunOptions): RunHandle => {
    seen.runs.push(opts)
    const lane = basename(opts.cwd).replace(/^heat-[a-z0-9]+-/, '')
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
    opts.onTokens(4321)
    for (let i = 0; i < (scenario.chatter ?? 0); i++) opts.onActivity(`${opts.agent} step ${i}`)
    scenario.early?.(opts.cwd)
    const clock = setTimeout(() => {
      scenario.write?.(opts.cwd)
      finish({
        exitCode: scenario.exitCode ?? 0,
        durationMs: scenario.reportMs ?? Date.now() - started,
        tokens: 4321,
        stopped: false,
        ...(scenario.stuck ? { stuck: true } : {})
      })
    }, scenario.delayMs)
    clock.unref()
    return {
      done,
      stop: () => {
        seen.stopped.push(opts.agent)
        clearTimeout(clock)
        finish({ exitCode: null, durationMs: Date.now() - started, tokens: null, stopped: true, ...(scenario.stuck ? { stuck: true } : {}) })
      }
    }
  }
  const deps: HeatEngineDeps = {
    root: () => repo,
    env: () => ENV,
    agents: () => detectedAgents(kinds),
    run,
    emit: (heat) => {
      seen.emitted.push(heat)
      seen.emittedAt.push(Date.now())
    },
    worktreesDir: () => worktrees,
    ...patch
  }
  const engine = new HeatEngine(deps)
  return { ...seen, engine, deps }
}

/** Agents that look installed, with an executable to run. */
function detectedAgents(kinds: AgentKind[]): DetectedAgent[] {
  return kinds.map((kind) => ({
    ...AGENTS[kind],
    installed: true,
    path: `/usr/bin/${AGENTS[kind].command}`,
    version: '1.0'
  }))
}

function options(agents: AgentKind[], patch: Partial<StartHeatOptions> = {}): StartHeatOptions {
  return {
    task: 'add a done file and a note',
    agents,
    checks: CHECKS,
    setup: '',
    timeLimitMin: 10,
    allowCommands: false,
    ...patch
  }
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 60000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function heat(harness: Harness, id: string): HeatState {
  const found = harness.engine.list().find((h) => h.id === id)
  if (!found) throw new Error(`Heat ${id} is not in the list`)
  return found
}

function laneOf(state: HeatState, agent: AgentKind): LaneState {
  const found = state.lanes.find((l) => l.agent === agent)
  if (!found) throw new Error(`No lane for ${agent}`)
  return found
}

function gate(lane: LaneState, id: GateResult['id']): GateResult {
  const found = lane.gates.find((g) => g.id === id)
  if (!found) throw new Error(`No ${id} gate on ${lane.agent}`)
  return found
}

/** Programs the tests left running on purpose; every one is killed when the file is done. */
const sleepers: number[] = []

/** Starts a program that stays in `cwd` after the agent is gone, in a session of its own. */
function leaveSleeper(cwd: string): number {
  const child = spawn('/bin/sh', ['-c', 'exec sleep 120'], { cwd, detached: true, stdio: 'ignore' })
  child.unref()
  sleepers.push(child.pid!)
  return child.pid!
}

function killSleepers(): void {
  for (const pid of sleepers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

afterAll(() => {
  killSleepers()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('starting a heat', () => {
  const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })

  it('needs two to four agents, an installed one each time, a task, a check and a repository', async () => {
    await expect(harness.engine.start(options(['claude']))).rejects.toThrow('A heat needs two to four agents.')
    await expect(harness.engine.start(options(['claude', 'codex', 'gemini', 'grok', 'aider']))).rejects.toThrow(
      'A heat needs two to four agents.'
    )
    await expect(harness.engine.start(options(['claude', 'codex'], { task: '   ' }))).rejects.toThrow(
      'Describe the task before starting a heat.'
    )
    await expect(harness.engine.start(options(['claude', 'codex'], { checks: [] }))).rejects.toThrow(
      'A heat needs at least one check to decide.'
    )
    const missing = makeHarness(['claude'], { claude: SCENARIOS['good']! })
    await expect(missing.engine.start(options(['claude', 'codex']))).rejects.toThrow('Not installed: Codex.')

    const noAgents = new HeatEngine({
      root: () => harness.repo,
      env: () => ENV,
      agents: () => [],
      run: () => {
        throw new Error('nothing runs when the request is refused')
      },
      emit: () => undefined
    })
    await expect(noAgents.start(options(['claude', 'codex']))).rejects.toThrow('Not installed: Claude Code, Codex.')
  }, 30000)

  it('races the same agent twice on separate numbered branches', async () => {
    const twice = makeHarness(['claude'], { claude: SCENARIOS['good']! })
    const started = await twice.engine.start(options(['claude', 'claude']))
    await waitFor('the heat to be decided', () => heat(twice, started.id).status === 'decided')
    const lanes = heat(twice, started.id).lanes
    expect(lanes.map((l) => l.branch)).toEqual([`regatta/heat-${started.id}-claude-1`, `regatta/heat-${started.id}-claude-2`])
    expect(new Set(lanes.map((l) => l.id)).size).toBe(2)
    expect(lanes.map((l) => l.label)).toEqual(['Claude Code 1', 'Claude Code 2'])
    expect(new Set(lanes.map((l) => l.worktree)).size).toBe(2)
    expect(lanes.every((l) => l.phase === 'done' && l.gates.every((g) => g.passed))).toBe(true)
  }, 60000)

  it('needs a git repository with a commit', async () => {
    const plain = new HeatEngine({
      root: () => temp('regatta-heat-plain-'),
      env: () => ENV,
      agents: () => detectedAgents(['claude', 'codex']),
      run: () => {
        throw new Error('nothing runs when the request is refused')
      },
      emit: () => undefined,
      worktreesDir: () => temp('regatta-heat-wt-')
    })
    await expect(plain.start(options(['claude', 'codex']))).rejects.toThrow(
      'Heats need a git repository with at least one commit.'
    )
  }, 30000)

  it('finds the checks of the project', async () => {
    expect(await harness.engine.detectChecks()).toEqual([])
    writeFileSync(join(harness.repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    expect(await harness.engine.detectChecks()).toEqual([{ name: 'test', command: 'npm test', kind: 'required' }])
    rmSync(join(harness.repo, 'package.json'))
  })

  it('hands back the first state right away and lists the heat', async () => {
    const first = await harness.engine.start(options(['claude', 'codex']))
    expect(first.status).toBe('baseline')
    expect(first.base).toBeNull()
    expect(first.decision).toBeNull()
    expect(first.lanes.map((l) => l.agent)).toEqual(['claude', 'codex'])
    expect(first.lanes.every((l) => l.phase === 'queued')).toBe(true)
    expect(harness.engine.list().map((h) => h.id)).toContain(first.id)
    harness.engine.cancel(first.id)
    await waitFor('the heat to settle', () => heat(harness, first.id).status === 'cancelled')
  }, 60000)
})

describe('a clear winner', () => {
  const harness = makeHarness(['claude', 'codex'], {
    claude: { ...SCENARIOS['good']!, delayMs: 60 },
    codex: { ...SCENARIOS['good']!, delayMs: 400 }
  })
  let id = ''
  const winner = (): string => laneOf(heat(harness, id), 'claude').id

  beforeAll(async () => {
    id = (await harness.engine.start(options(['claude', 'codex']))).id
    await waitFor('the heat to be decided', () => heat(harness, id).status === 'decided')
  }, 90000)

  it('runs the baseline on untouched code', () => {
    const state = heat(harness, id)
    expect(state.base).toBe(sh(['rev-parse', 'HEAD'], harness.repo).trim())
    expect(state.baseline.map((c) => [c.name, c.passed])).toEqual([
      ['done', false],
      ['guard', true]
    ])
    expect(state.baselineTests).toEqual({ 'test/cart.test.js': { cases: 2, assertions: 2 } })
  })

  it('gives every lane its own worktree and branch, and keeps the run it started', () => {
    const state = heat(harness, id)
    expect(state.lanes.map((l) => l.branch)).toEqual([`regatta/heat-${id}-claude`, `regatta/heat-${id}-codex`])
    for (const lane of state.lanes) {
      expect(lane.worktree).toBe(join(harness.worktrees, `heat-${id}-${lane.agent}`))
      expect(existsSync(lane.worktree!)).toBe(true)
      expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], lane.worktree!).trim()).toBe(lane.branch)
    }
    // The baseline worktree is gone again.
    expect(existsSync(join(harness.worktrees, `heat-${id}-base`))).toBe(false)
  })

  it('runs each agent on the task in its own folder with the checks the user chose', () => {
    // Lanes start in parallel, so the order they reach the agent is not fixed.
    expect(harness.runs.map((r) => r.agent).slice().sort()).toEqual(['claude', 'codex'])
    for (const run of harness.runs) {
      expect(run.prompt).toBe('add a done file and a note')
      expect(run.cwd).toBe(join(harness.worktrees, `heat-${id}-${run.agent}`))
      expect(run.env).toEqual(ENV)
      expect(run.allowCommands).toBe(false)
      expect(run.command).toBe(`/usr/bin/${AGENTS[run.agent].command}`)
    }
  })

  it('commits what the agent left, scores every gate and records the run', () => {
    const state = heat(harness, id)
    for (const lane of state.lanes) {
      expect(lane.phase).toBe('done')
      expect(lane.exitCode).toBe(0)
      expect(lane.timedOut).toBe(false)
      expect(lane.error).toBeNull()
      expect(lane.diff.files).toBe(2)
      expect(lane.tokens).toBe(4321)
      expect(lane.latest).toBe(`${lane.agent} is working on the task`)
      expect(lane.checks.map((c) => [c.name, c.passed])).toEqual([
        ['done', true],
        ['guard', true]
      ])
      expect(lane.tests).toEqual({ 'test/cart.test.js': { cases: 2, assertions: 2 } })
      expect(lane.gates.map((g) => [g.id, g.passed])).toEqual([
        ['finished', true],
        ['changed', true],
        ['checks', true],
        ['no-regressions', true],
        ['integrity', true]
      ])
      expect(sh(['log', '-1', '--format=%an <%ae>|%s'], lane.worktree!).trim()).toBe(
        `Regatta <regatta@localhost>|Heat ${id}: ${lane.agent}`
      )
    }
  })

  it('picks the faster lane when it is outside the 20% band', () => {
    const state = heat(harness, id)
    expect(state.decision?.kind).toBe('winner')
    expect(state.decision?.laneIds).toEqual([laneOf(state, 'claude').id])
    expect(state.decision?.note).toContain('Claude Code wins')
    expect(state.decision?.note).toContain('Codex')
    expect(laneOf(state, 'claude').durationMs).toBeLessThan(laneOf(state, 'codex').durationMs!)
  })

  it('emits the heat as it changes and always ends on the final state', () => {
    const states = harness.emitted.filter((h) => h.id === id)
    expect(states.length).toBeGreaterThan(2)
    expect(states[0]?.status).toBe('baseline')
    expect(states[states.length - 1]?.status).toBe('decided')
    expect(states.some((h) => h.status === 'racing')).toBe(true)
    // Nothing that was emitted can change afterwards: the renderer keeps what it got.
    expect(states[0]?.lanes[0]?.phase).toBe('queued')
  })

  it('refuses to merge a lane that did not win', async () => {
    await expect(harness.engine.merge(id, laneOf(heat(harness, id), 'codex').id)).rejects.toThrow('Only the winning lane can be merged.')
    await expect(harness.engine.merge('nosuchheat', 'claude')).rejects.toThrow('That heat is no longer here.')
  }, 30000)

  it('refuses a folder that has changes of its own', async () => {
    writeFileSync(join(harness.repo, 'GUARD.txt'), 'guard\nbeing edited\n')
    await expect(harness.engine.merge(id, winner())).rejects.toThrow(
      'Commit or stash your changes first. Merging needs a clean folder.'
    )
    expect(existsSync(join(harness.repo, 'DONE.txt'))).toBe(false)
    writeFileSync(join(harness.repo, 'GUARD.txt'), GUARD)
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
  }, 30000)

  it('merges the winner, brings the change home and removes the worktrees and branches', async () => {
    const result = await harness.engine.merge(id, winner())
    expect(result.merged).toBe(true)
    expect(result.summary).toMatch(/^Fast-forwarded main by 1 commit \(\+[0-9]+ -0 in 2 files\)\./)
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')

    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(readFileSync(join(harness.repo, 'src', 'app.js'), 'utf8')).toContain('changed by the agent')
    expect(sh(['log', '-1', '--format=%s'], harness.repo).trim()).toBe(`Heat ${id}: claude`)
    for (const lane of heat(harness, id).lanes) {
      expect(existsSync(lane.worktree!)).toBe(false)
    }
    expect(await listTrash(harness.worktrees)).toHaveLength(2)
    await emptyTrash(harness.worktrees)
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(1)
    expect(sh(['branch', '--list', 'regatta/heat-*'], harness.repo).trim()).toBe('')
    expect(heat(harness, id).status).toBe('merged')
  }, 60000)

  it('will not merge the same heat twice', async () => {
    await expect(harness.engine.merge(id, winner())).rejects.toThrow('This heat has not been decided yet.')
  }, 30000)
})

describe('a tie', () => {
  const harness = makeHarness(['claude', 'codex'], {
    claude: { ...SCENARIOS['good']!, delayMs: 100, reportMs: 100 },
    codex: { ...SCENARIOS['good']!, delayMs: 110, reportMs: 110 }
  })
  let id = ''

  beforeAll(async () => {
    id = (await harness.engine.start(options(['claude', 'codex']))).id
    await waitFor('the heat to be decided', () => heat(harness, id).status === 'decided')
  }, 90000)

  it('leaves the pick to the user when two lanes finish inside 20%', () => {
    const state = heat(harness, id)
    expect(state.decision?.kind).toBe('tie')
    expect(state.decision?.laneIds?.slice().sort()).toEqual([laneOf(state, 'claude').id, laneOf(state, 'codex').id].sort())
    expect(state.decision?.note).toContain('Tie')
    expect(state.decision?.note).toContain('You pick')
  })

  it('merges either lane of the tie', async () => {
    const result = await harness.engine.merge(id, laneOf(heat(harness, id), 'codex').id)
    expect(result.merged).toBe(true)
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')
    expect(existsSync(join(harness.repo, 'DONE.txt'))).toBe(true)
  }, 60000)
})

describe('the gates', () => {
  const harness = makeHarness(['claude', 'codex', 'gemini', 'grok'], {
    claude: SCENARIOS['good']!,
    codex: SCENARIOS['deleteTests']!,
    gemini: SCENARIOS['breakGuard']!,
    grok: SCENARIOS['noChange']!
  })
  let id = ''

  beforeAll(async () => {
    id = (await harness.engine.start(options(['claude', 'codex', 'gemini', 'grok']))).id
    await waitFor('the heat to be decided', () => heat(harness, id).status === 'decided')
  }, 90000)

  it('disqualifies a lane that deletes a test file', () => {
    const lane = laneOf(heat(harness, id), 'codex')
    expect(gate(lane, 'integrity').passed).toBe(false)
    expect(gate(lane, 'integrity').detail).toBe('deleted test/cart.test.js')
    expect(gate(lane, 'finished').passed).toBe(true)
    expect(gate(lane, 'checks').passed).toBe(true)
  })

  it('disqualifies a lane that breaks something that passed before', () => {
    const lane = laneOf(heat(harness, id), 'gemini')
    expect(gate(lane, 'no-regressions').passed).toBe(false)
    expect(gate(lane, 'no-regressions').detail).toBe('broke: guard')
    expect(gate(lane, 'checks').passed).toBe(true)
    expect(gate(lane, 'integrity').passed).toBe(true)
  })

  it('disqualifies a lane that changed nothing', () => {
    const lane = laneOf(heat(harness, id), 'grok')
    expect(gate(lane, 'changed').passed).toBe(false)
    expect(gate(lane, 'changed').detail).toBe('changed nothing')
    expect(gate(lane, 'finished').passed).toBe(true)
  })

  it('decides on the only lane that passed everything', () => {
    const state = heat(harness, id)
    expect(state.decision?.kind).toBe('winner')
    expect(state.decision?.laneIds).toEqual([laneOf(state, 'claude').id])
  })
})

describe('no lane passed', () => {
  const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['fail']!, codex: SCENARIOS['noChange']! })
  let id = ''

  beforeAll(async () => {
    id = (await harness.engine.start(options(['claude', 'codex']))).id
    await waitFor('the heat to be decided', () => heat(harness, id).status === 'decided')
  }, 90000)

  it('says so and names the first gate each lane failed', async () => {
    const state = heat(harness, id)
    expect(state.decision?.kind).toBe('none')
    expect(state.decision?.laneIds).toEqual([])
    expect(state.decision?.note).toContain('No lane passed every gate.')
    expect(state.decision?.note).toContain('Claude Code: exited with code 2')
    expect(state.decision?.note).toContain('Codex: changed nothing')
    await expect(harness.engine.merge(id, laneOf(state, 'claude').id)).rejects.toThrow('Only the winning lane can be merged.')
  }, 30000)
})

describe('cancelling', () => {
  const harness = makeHarness(['claude', 'codex'], {
    claude: { ...SCENARIOS['good']!, delayMs: 30000 },
    codex: { ...SCENARIOS['good']!, delayMs: 30000 }
  })
  let id = ''

  beforeAll(async () => {
    id = (await harness.engine.start(options(['claude', 'codex']))).id
    await waitFor('both lanes to run', () => heat(harness, id).lanes.every((l) => l.phase === 'running'))
    harness.engine.cancel(id)
    await waitFor('every lane to stop', () => heat(harness, id).lanes.every((l) => l.phase === 'done'))
  }, 90000)

  it('stops the running agents and marks the heat cancelled', () => {
    const state = heat(harness, id)
    expect(state.status).toBe('cancelled')
    expect(state.decision).toBeNull()
    expect(harness.stopped.sort()).toEqual(['claude', 'codex'])
    for (const lane of state.lanes) {
      expect(lane.exitCode).toBeNull()
      expect(lane.error).toBe('Cancelled')
      expect(gate(lane, 'finished').passed).toBe(false)
      // The agent never got to write, and nothing was committed for it.
      expect(existsSync(join(lane.worktree!, 'DONE.txt'))).toBe(false)
      expect(sh(['log', '-1', '--format=%s'], lane.worktree!).trim()).toBe('first commit')
    }
  })

  it('keeps the worktrees until the heat is discarded', async () => {
    const state = heat(harness, id)
    for (const lane of state.lanes) expect(existsSync(lane.worktree!)).toBe(true)
    await harness.engine.discard(id)
    for (const lane of heat(harness, id).lanes) {
      expect(existsSync(lane.worktree!)).toBe(false)
    }
    expect(await listTrash(harness.worktrees)).toHaveLength(2)
    await emptyTrash(harness.worktrees)
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(1)
    expect(sh(['branch', '--list', 'regatta/heat-*'], harness.repo).trim()).toBe('')
    expect(harness.stopped).toEqual(['claude', 'codex'])
  }, 60000)
})

describe('the time limit', () => {
  const harness = makeHarness(['claude', 'codex'], {
    claude: { ...SCENARIOS['good']!, delayMs: 600000 },
    codex: { ...SCENARIOS['good']!, delayMs: 600000 }
  })
  let id = ''

  beforeAll(async () => {
    id = (await harness.engine.start(options(['claude', 'codex'], { timeLimitMin: 0.02 }))).id
    await waitFor('the heat to be decided', () => heat(harness, id).status === 'decided')
  }, 90000)

  it('stops a lane that runs out of time and says so', () => {
    const state = heat(harness, id)
    expect(harness.stopped.sort()).toEqual(['claude', 'codex'])
    for (const lane of state.lanes) {
      expect(lane.timedOut).toBe(true)
      expect(gate(lane, 'finished').passed).toBe(false)
      expect(gate(lane, 'finished').detail).toBe('ran out of time')
    }
    expect(state.decision?.kind).toBe('none')
  })
})

// Safety: what happens when lanes repeat, names clash, the folder moves, or things stop.

/** Starts a heat and waits for its decision. */
async function decideHeat(harness: Harness, agents: AgentKind[], patch: Partial<StartHeatOptions> = {}): Promise<string> {
  const id = (await harness.engine.start(options(agents, patch))).id
  await waitFor('the heat to be decided', () => heat(harness, id).status === 'decided')
  return id
}

/** A heat where Claude is the only lane that passes (Codex changes nothing), ready to merge. */
async function winnerHeat(plan: Plan = {}): Promise<{ harness: Harness; id: string; lane: LaneState }> {
  const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']!, ...plan })
  const id = await decideHeat(harness, ['claude', 'codex'])
  const lane = laneOf(heat(harness, id), 'claude')
  expect(heat(harness, id).decision).toMatchObject({ kind: 'winner', laneIds: [lane.id] })
  return { harness, id, lane }
}

function head(repo: string): string {
  return sh(['rev-parse', 'HEAD'], repo).trim()
}

function branches(repo: string): string[] {
  return sh(['branch', '--list', 'regatta/heat-*', '--format=%(refname:short)'], repo).trim().split('\n').filter(Boolean)
}

function stillThere(harness: Harness, id: string): void {
  for (const lane of heat(harness, id).lanes) {
    expect(existsSync(lane.worktree!)).toBe(true)
    expect(branches(harness.repo)).toContain(lane.branch)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // A process that died but is not reaped yet still answers signal 0; it is not running.
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return stat !== '' && !stat.startsWith('Z')
  } catch {
    return false
  }
}

async function gone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const started = Date.now()
  while (alive(pid)) {
    if (Date.now() - started > timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

describe('the same agent racing twice', () => {
  const harness = makeHarness(['claude'], {
    'claude-1': SCENARIOS['noChange']!,
    'claude-2': { ...SCENARIOS['good']!, write: (cwd) => {
      finished(cwd)
      writeFileSync(join(cwd, 'SECOND.txt'), 'second\n')
    } }
  })
  let id = ''

  beforeAll(async () => {
    id = await decideHeat(harness, ['claude', 'claude'])
  }, 90000)

  it('gives each lane its own id and a numbered label', () => {
    const lanes = heat(harness, id).lanes
    expect(new Set(lanes.map((l) => l.id)).size).toBe(2)
    expect(lanes.map((l) => l.label)).toEqual(['Claude Code 1', 'Claude Code 2'])
  })

  it('decides on the second lane, which is the only one that qualified', () => {
    const state = heat(harness, id)
    expect(gate(state.lanes[0]!, 'changed').passed).toBe(false)
    expect(state.decision).toMatchObject({ kind: 'winner', laneIds: [state.lanes[1]!.id] })
    expect(state.decision?.note).toContain('Claude Code 2 wins')
  })

  it('merges the second lane and deletes the first, not the other way round', async () => {
    const state = heat(harness, id)
    const tip = sh(['rev-parse', state.lanes[1]!.branch!], harness.repo).trim()
    const result = await harness.engine.merge(id, state.lanes[1]!.id)
    expect(result.merged).toBe(true)
    expect(head(harness.repo)).toBe(tip)
    expect(readFileSync(join(harness.repo, 'SECOND.txt'), 'utf8')).toBe('second\n')
    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).toEqual([])
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(1)
  }, 60000)

  it('has a single lane named plainly when an agent races once', async () => {
    const once = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    const oneId = await decideHeat(once, ['claude', 'codex'])
    expect(heat(once, oneId).lanes.map((l) => l.label)).toEqual([undefined, undefined])
    expect(new Set(heat(once, oneId).lanes.map((l) => l.id)).size).toBe(2)
  }, 60000)
})

describe('merging into the real folder', () => {
  it('will not overwrite an ignored file the winning branch also tracks (fast-forward)', async () => {
    const { harness, id, lane } = await winnerHeat()
    // The user keeps their own DONE.txt, ignored by a .gitignore that was never committed.
    writeFileSync(join(harness.repo, '.gitignore'), 'DONE.txt\n')
    writeFileSync(join(harness.repo, 'DONE.txt'), 'precious\n')
    const before = head(harness.repo)

    await expect(harness.engine.merge(id, lane.id)).rejects.toThrow(/DONE\.txt/)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('precious\n')
    expect(head(harness.repo)).toBe(before)
    expect(existsSync(join(harness.repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('?? .gitignore')
    expect(heat(harness, id).status).toBe('decided')
    stillThere(harness, id)

    // Once the user moves their file away, the same merge goes through.
    unlinkSync(join(harness.repo, 'DONE.txt'))
    expect((await harness.engine.merge(id, lane.id)).merged).toBe(true)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
  }, 60000)

  it('will not overwrite an ignored file when the folder moved ahead either', async () => {
    const { harness, id, lane } = await winnerHeat()
    writeFileSync(join(harness.repo, 'LATER.txt'), 'later\n')
    sh(['add', 'LATER.txt'], harness.repo)
    sh([...IDENTITY, 'commit', '-m', 'work in the folder'], harness.repo)
    writeFileSync(join(harness.repo, '.gitignore'), 'DONE.txt\n')
    writeFileSync(join(harness.repo, 'DONE.txt'), 'precious\n')
    const before = head(harness.repo)

    await expect(harness.engine.merge(id, lane.id)).rejects.toThrow(/DONE\.txt/)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('precious\n')
    expect(head(harness.repo)).toBe(before)
    expect(existsSync(join(harness.repo, '.git', 'MERGE_HEAD'))).toBe(false)
    stillThere(harness, id)
  }, 60000)

  it('makes a merge commit when the folder moved ahead of the heat', async () => {
    const { harness, id, lane } = await winnerHeat()
    writeFileSync(join(harness.repo, 'LATER.txt'), 'later\n')
    sh(['add', 'LATER.txt'], harness.repo)
    sh([...IDENTITY, 'commit', '-m', 'work in the folder'], harness.repo)
    const ahead = head(harness.repo)

    const result = await harness.engine.merge(id, lane.id)
    expect(result.summary).toMatch(/^Merged into main with 1 commit \(\+[0-9]+ -0 in 2 files\)\./)
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')
    const parents = sh(['rev-list', '--parents', '-n', '1', 'HEAD'], harness.repo).trim().split(' ')
    expect(parents).toHaveLength(3)
    expect(parents[1]).toBe(ahead)
    expect(sh(['log', '-1', '--format=%s'], harness.repo).trim()).toBe(`Merge heat ${id} (claude)`)
    expect(readFileSync(join(harness.repo, 'LATER.txt'), 'utf8')).toBe('later\n')
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).toEqual([])
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
    expect(heat(harness, id).status).toBe('merged')
  }, 60000)

  it('leaves the folder exactly as it was on a conflict, keeps the lanes, and can be retried', async () => {
    const { harness, id, lane } = await winnerHeat()
    appendFileSync(join(harness.repo, 'src', 'app.js'), '// made in the folder\n')
    sh([...IDENTITY, 'commit', '-am', 'conflicting work'], harness.repo)
    const before = head(harness.repo)

    await expect(harness.engine.merge(id, lane.id)).rejects.toThrow(/conflicts with work in main/)
    expect(head(harness.repo)).toBe(before)
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
    expect(existsSync(join(harness.repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(readFileSync(join(harness.repo, 'src', 'app.js'), 'utf8')).not.toContain('changed by the agent')
    expect(heat(harness, id).status).toBe('decided')
    stillThere(harness, id)

    // The user takes their commit out again; the same heat then merges.
    sh(['reset', '--hard', 'HEAD~1'], harness.repo)
    expect((await harness.engine.merge(id, lane.id)).merged).toBe(true)
    expect(readFileSync(join(harness.repo, 'src', 'app.js'), 'utf8')).toContain('changed by the agent')
  }, 60000)

  it('does not touch a merge the user has under way', async () => {
    const { harness, id, lane } = await winnerHeat()
    sh(['checkout', '-b', 'topic'], harness.repo)
    writeFileSync(join(harness.repo, 'GUARD.txt'), 'topic\n')
    sh([...IDENTITY, 'commit', '-am', 'topic'], harness.repo)
    sh(['checkout', 'main'], harness.repo)
    writeFileSync(join(harness.repo, 'GUARD.txt'), 'main\n')
    sh([...IDENTITY, 'commit', '-am', 'main'], harness.repo)
    expect(() => sh([...IDENTITY, 'merge', 'topic'], harness.repo)).toThrow()
    const status = sh(['status', '--porcelain'], harness.repo)
    expect(existsSync(join(harness.repo, '.git', 'MERGE_HEAD'))).toBe(true)

    await expect(harness.engine.merge(id, lane.id)).rejects.toThrow(/merge is already in progress/)
    expect(existsSync(join(harness.repo, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(sh(['status', '--porcelain'], harness.repo)).toBe(status)
    stillThere(harness, id)
    sh(['merge', '--abort'], harness.repo)
  }, 60000)

  it('needs a branch checked out, and keeps everything when it is not', async () => {
    const { harness, id, lane } = await winnerHeat()
    sh(['checkout', '--detach'], harness.repo)
    const before = head(harness.repo)
    await expect(harness.engine.merge(id, lane.id)).rejects.toThrow('Check out a branch before merging.')
    expect(head(harness.repo)).toBe(before)
    stillThere(harness, id)
    sh(['checkout', 'main'], harness.repo)
    expect((await harness.engine.merge(id, lane.id)).merged).toBe(true)
  }, 60000)

  it('refuses to merge when it cannot tell whether the folder is clean', async () => {
    const { harness, id, lane } = await winnerHeat()
    writeFileSync(join(harness.repo, '.git', 'index'), 'this is not an index')
    const before = head(harness.repo)
    await expect(harness.engine.merge(id, lane.id)).rejects.toThrow(/Could not tell whether your folder has uncommitted changes/)
    expect(head(harness.repo)).toBe(before)
    stillThere(harness, id)
  }, 60000)

  it('refuses a second merge request while one runs, and the first still completes', async () => {
    const { harness, id, lane } = await winnerHeat()
    const first = harness.engine.merge(id, lane.id)
    await expect(harness.engine.merge(id, lane.id)).rejects.toThrow('A merge is already running for this heat.')
    expect((await first).merged).toBe(true)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).toEqual([])
  }, 60000)

  it('merges two heats of one repository that are asked at the same moment, one after the other, the second after a retry', async () => {
    const own = (cwd: string): void => writeFileSync(join(cwd, `${basename(cwd)}.txt`), 'mine\n')
    const harness = makeHarness(['claude', 'codex'], {
      claude: { delayMs: 60, write: own },
      codex: SCENARIOS['noChange']!
    })
    const checks: CheckSpec[] = [{ name: 'ok', command: 'true', kind: 'required' }]
    const a = await decideHeat(harness, ['claude', 'codex'], { checks })
    const b = await decideHeat(harness, ['claude', 'codex'], { checks })
    const laneA = laneOf(heat(harness, a), 'claude')
    const laneB = laneOf(heat(harness, b), 'claude')
    // Both were asked for while main was at the same commit; the first one moves it, so the second is refused, not guessed at.
    const results = await Promise.allSettled([harness.engine.merge(a, laneA.id), harness.engine.merge(b, laneB.id)])
    // Which one the repository lock lets in first is up to timing; the other one is refused.
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refusedIndex = results.findIndex((r) => r.status === 'rejected')
    expect(String((results[refusedIndex] as PromiseRejectedResult).reason)).toContain('moved on since the merge was asked for')
    const [refusedHeat, refusedLane] = refusedIndex === 0 ? [a, laneA] : [b, laneB]
    expect(existsSync(join(harness.repo, `heat-${refusedHeat}-claude.txt`))).toBe(false)
    stillThere(harness, refusedHeat)
    // Asked again, it is judged on the new state of the branch and goes through.
    expect((await harness.engine.merge(refusedHeat, refusedLane.id)).merged).toBe(true)
    expect(existsSync(join(harness.repo, `heat-${a}-claude.txt`))).toBe(true)
    expect(existsSync(join(harness.repo, `heat-${b}-claude.txt`))).toBe(true)
    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).toEqual([])
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
    expect(existsSync(join(harness.repo, '.git', 'MERGE_HEAD'))).toBe(false)
  }, 90000)
})

describe('owning only what it made', () => {
  it('picks another heat id when the first one clashes with an existing branch or folder', async () => {
    const ids = ['clash0001', 'clash0002', 'clash0003', 'fresh0004']
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! }, { newId: () => ids.shift()! })
    // Someone else's branch for the first id, someone else's folder for the second, and a baseline folder for the third.
    sh(['branch', 'regatta/heat-clash0001-claude'], harness.repo)
    mkdirSync(join(harness.worktrees, 'heat-clash0002-codex'), { recursive: true })
    writeFileSync(join(harness.worktrees, 'heat-clash0002-codex', 'mine.txt'), 'mine\n')
    mkdirSync(join(harness.worktrees, 'heat-clash0003-base'), { recursive: true })
    const theirBranch = sh(['rev-parse', 'regatta/heat-clash0001-claude'], harness.repo).trim()

    const id = await decideHeat(harness, ['claude', 'codex'])
    expect(id).toBe('fresh0004')
    expect(id.length).toBeGreaterThanOrEqual(8)
    await harness.engine.discard(id)
    await emptyTrash(harness.worktrees)

    expect(sh(['rev-parse', 'regatta/heat-clash0001-claude'], harness.repo).trim()).toBe(theirBranch)
    expect(readFileSync(join(harness.worktrees, 'heat-clash0002-codex', 'mine.txt'), 'utf8')).toBe('mine\n')
    expect(existsSync(join(harness.worktrees, 'heat-clash0003-base'))).toBe(true)
    expect(branches(harness.repo)).toEqual(['regatta/heat-clash0001-claude'])
  }, 60000)

  it('gives up with a clear message when no free id can be found', async () => {
    const harness = makeHarness(['claude', 'codex'], {}, { newId: () => 'sameid01' })
    sh(['branch', 'regatta/heat-sameid01-claude'], harness.repo)
    await expect(harness.engine.start(options(['claude', 'codex']))).rejects.toThrow('Could not find a free name for this heat.')
  }, 30000)

  it('fails a lane whose branch or folder got taken after the id was chosen, and never deletes them', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! }, { newId: () => 'late0001' })
    const folder = join(harness.worktrees, 'heat-late0001-codex')
    // The baseline setup runs after the id was chosen, so it stands in for someone else creating these in between.
    const setup = `git branch regatta/heat-late0001-claude; mkdir -p ${folder}; echo mine > ${folder}/mine.txt`
    const theirs = sh(['rev-parse', 'HEAD'], harness.repo).trim()
    const id = await decideHeat(harness, ['claude', 'codex'], { setup })

    const state = heat(harness, id)
    const claude = laneOf(state, 'claude')
    const codex = laneOf(state, 'codex')
    expect(claude.error).toContain('regatta/heat-late0001-claude already exists')
    expect(codex.error).toContain('is already there')
    for (const lane of [claude, codex]) {
      expect(lane.worktree).toBeNull()
      expect(lane.branch).toBeNull()
      expect(lane.gates.every((g) => g.passed)).toBe(false)
    }
    expect(state.decision?.kind).toBe('none')

    await harness.engine.discard(id)
    expect(sh(['rev-parse', 'regatta/heat-late0001-claude'], harness.repo).trim()).toBe(theirs)
    expect(readFileSync(join(folder, 'mine.txt'), 'utf8')).toBe('mine\n')
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(1)
  }, 60000)

  it('removes the baseline worktree it made and nothing else', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    const id = await decideHeat(harness, ['claude', 'codex'])
    expect(readdirSync(harness.worktrees).sort()).toEqual([`heat-${id}-claude`, `heat-${id}-codex`])
  }, 60000)
})

describe('discarding while work is still running', () => {
  it('waits for a setup command to stop before removing anything', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    const pidFile = join(temp('regatta-heat-pid-'), 'setup.pid')
    const id = (await harness.engine.start(options(['claude', 'codex'], { setup: `sleep 300 & echo $! > ${pidFile}; wait` }))).id
    await waitFor('the setup command to run', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(alive(pid)).toBe(true)
    expect(readdirSync(harness.worktrees)).toEqual([`heat-${id}-base`])

    await harness.engine.discard(id)
    // By the time discard returns, the command is dead and the run is over.
    expect(alive(pid)).toBe(false)
    expect(heat(harness, id).status).toBe('cancelled')
    expect(readdirSync(harness.worktrees)).toEqual([])
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    expect(heat(harness, id).lanes.every((l) => l.phase === 'done' && l.error === 'Cancelled')).toBe(true)
  }, 60000)

  it('waits for the checks in the lanes and stops what they started', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    const pids = temp('regatta-heat-pids-')
    // Passes at once in the baseline (no DONE.txt yet); in a lane it starts a long sleep.
    const slow = `if [ -f DONE.txt ]; then sleep 300 & echo $! > ${pids}/$(basename "$PWD").pid; wait; fi`
    const checks: CheckSpec[] = [{ name: 'slow', command: slow, kind: 'required' }]
    const id = (await harness.engine.start(options(['claude', 'codex'], { checks }))).id
    await waitFor('both checks to run', () => readdirSync(pids).length === 2 && readdirSync(pids).every((name) => readFileSync(join(pids, name), 'utf8').trim() !== ''))
    const found = readdirSync(pids).map((name) => Number(readFileSync(join(pids, name), 'utf8').trim()))
    expect(found.every(alive)).toBe(true)
    expect(heat(harness, id).lanes.every((l) => l.phase === 'checking')).toBe(true)

    await harness.engine.discard(id)
    for (const pid of found) expect(alive(pid)).toBe(false)
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    await emptyTrash(harness.worktrees)
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    expect(heat(harness, id).status).toBe('cancelled')
  }, 60000)

  it('leaves a decided heat alone when cancel is called late', async () => {
    const { harness, id } = await winnerHeat()
    harness.engine.cancel(id)
    expect(heat(harness, id).status).toBe('decided')
    stillThere(harness, id)
  }, 60000)
})

describe('gates judge the committed change', () => {
  it('does not let a check that writes files make a lane that changed nothing pass', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['noChange']!, codex: SCENARIOS['good']! })
    const checks: CheckSpec[] = [{ name: 'writer', command: 'echo hi > generated.txt', kind: 'required' }]
    const id = await decideHeat(harness, ['claude', 'codex'], { checks })
    const state = heat(harness, id)
    const idle = laneOf(state, 'claude')
    // Checks run in a temporary worktree at the tip: the lane's own folder never sees their output.
    expect(existsSync(join(idle.worktree!, 'generated.txt'))).toBe(false)
    expect(sh(['status', '--porcelain', '--ignored'], idle.worktree!).trim()).toBe('')
    expect(idle.diff.files).toBe(0)
    expect(gate(idle, 'changed')).toMatchObject({ passed: false, detail: 'changed nothing' })
    // The lane that did change files is measured by its commit: the generated file is not part of it.
    expect(laneOf(state, 'codex').diff.files).toBe(2)
    expect(state.decision).toMatchObject({ kind: 'winner', laneIds: [laneOf(state, 'codex').id] })
  }, 60000)

  it('fails the checks gate when a check changes tracked files', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    const checks: CheckSpec[] = [{ name: 'fixer', command: "echo '// fixed by a check' >> src/app.js", kind: 'required' }]
    const id = await decideHeat(harness, ['claude', 'codex'], { checks })
    const state = heat(harness, id)
    for (const lane of state.lanes) {
      expect(lane.checks.map((c) => [c.name, c.passed])).toEqual([['fixer', true]])
      expect(gate(lane, 'checks')).toMatchObject({
        passed: false,
        detail: 'a check changed tracked files, so the result does not match the committed change'
      })
    }
    expect(state.decision?.kind).toBe('none')
    await expect(harness.engine.merge(id, state.lanes[0]!.id)).rejects.toThrow('Only the winning lane can be merged.')
  }, 60000)

  it('fails a lane when a check commits on its own', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    const checks: CheckSpec[] = [
      { name: 'sneaky', command: 'echo more > extra.txt && git add extra.txt && git -c user.name=x -c user.email=x@x commit -qm sneaky', kind: 'required' }
    ]
    const id = await decideHeat(harness, ['claude', 'codex'], { checks })
    for (const lane of heat(harness, id).lanes) expect(gate(lane, 'checks').passed).toBe(false)
  }, 60000)
})

describe('emitting', () => {
  it('keeps to four updates a second while a lane is busy, apart from the final state', async () => {
    const harness = makeHarness(['claude', 'codex'], {
      claude: { ...SCENARIOS['good']!, delayMs: 1200, chatter: 300 },
      codex: { ...SCENARIOS['good']!, delayMs: 1200, chatter: 300 }
    })
    const id = await decideHeat(harness, ['claude', 'codex'])
    const own = harness.emitted.map((h, i) => ({ h, at: harness.emittedAt[i]! })).filter((e) => e.h.id === id)
    const middle = own.filter((e) => e.h.status !== 'decided')
    expect(middle.length).toBeGreaterThan(2)
    expect(middle.length).toBeLessThan(25)
    for (let i = 1; i < middle.length; i++) {
      expect(middle[i]!.at - middle[i - 1]!.at).toBeGreaterThanOrEqual(200)
    }
    expect(own[own.length - 1]!.h.status).toBe('decided')
  }, 60000)

  it('emits when the live diff of a running lane changes', async () => {
    const early = (cwd: string): void => {
      appendFileSync(join(cwd, 'src', 'app.js'), '// work in progress\n')
      writeFileSync(join(cwd, 'NEW.txt'), 'new\n')
    }
    const harness = makeHarness(['claude', 'codex'], {
      claude: { ...SCENARIOS['good']!, delayMs: 3300, early },
      codex: { ...SCENARIOS['good']!, delayMs: 3300, early }
    })
    const id = await decideHeat(harness, ['claude', 'codex'])
    const live = harness.emitted.filter(
      (h) => h.id === id && h.lanes.some((l) => l.phase === 'running' && l.diff.files === 2 && l.diff.added === 2)
    )
    expect(live.length).toBeGreaterThan(0)
  }, 60000)
})

// Round 2: cleanup that can run twice, merges bound to the tested commit, reserved names.

/** Makes a commit on top of HEAD that adds EVIL.txt, without touching any branch or the work tree. */
function evilCommit(repo: string): string {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'evil\n', encoding: 'utf8' }).trim()
  const tree = execFileSync('git', ['mktree'], { cwd: repo, input: `100644 blob ${blob}\tEVIL.txt\n`, encoding: 'utf8' }).trim()
  return sh([...IDENTITY, 'commit-tree', tree, '-p', 'HEAD', '-m', 'evil'], repo).trim()
}

describe('cleanup that can run twice', () => {
  it('never touches a worktree or branch someone recreated after the first discard', async () => {
    const { harness, id, lane } = await winnerHeat()
    await harness.engine.discard(id)
    expect(existsSync(lane.worktree!)).toBe(false)
    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).toEqual([])

    // The user makes a new worktree on a new branch with the very same names.
    sh(['worktree', 'add', '-b', lane.branch!, lane.worktree!, 'main'], harness.repo)
    writeFileSync(join(lane.worktree!, 'MINE.txt'), 'mine\n')
    const theirs = sh(['rev-parse', lane.branch!], harness.repo).trim()

    await harness.engine.discard(id)
    expect(readFileSync(join(lane.worktree!, 'MINE.txt'), 'utf8')).toBe('mine\n')
    expect(sh(['rev-parse', lane.branch!], harness.repo).trim()).toBe(theirs)
    expect(branches(harness.repo)).toEqual([lane.branch])
  }, 60000)

  it('does not remove a different worktree that now sits at the lane path', async () => {
    const { harness, id, lane } = await winnerHeat()
    // Our worktree is replaced by one of the user's own at the same path.
    sh(['worktree', 'remove', '--force', lane.worktree!], harness.repo)
    sh(['worktree', 'add', '-b', 'users-branch', lane.worktree!, 'main'], harness.repo)
    writeFileSync(join(lane.worktree!, 'MINE.txt'), 'mine\n')

    await harness.engine.discard(id)
    expect(readFileSync(join(lane.worktree!, 'MINE.txt'), 'utf8')).toBe('mine\n')
    expect(sh(['branch', '--list', 'users-branch'], harness.repo).trim()).not.toBe('')
    // The other lane was still ours and went.
    const other = laneOf(heat(harness, id), 'codex')
    expect(existsSync(other.worktree!)).toBe(false)
    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).not.toContain(other.branch)
  }, 60000)

  it('keeps a lane branch that someone moved on, and one that is checked out somewhere else', async () => {
    const { harness, id, lane } = await winnerHeat()
    const other = laneOf(heat(harness, id), 'codex')
    // The user adds a commit to Codex's branch before discarding.
    sh(['worktree', 'remove', '--force', other.worktree!], harness.repo)
    const extra = sh([...IDENTITY, 'commit-tree', 'HEAD^{tree}', '-p', other.branch!, '-m', 'users work'], harness.repo).trim()
    sh(['update-ref', `refs/heads/${other.branch}`, extra], harness.repo)
    await harness.engine.discard(id)
    await emptyTrash(harness.worktrees)
    expect(sh(['rev-parse', other.branch!], harness.repo).trim()).toBe(extra)
    expect(branches(harness.repo)).toEqual([other.branch])
    expect(existsSync(lane.worktree!)).toBe(false)
  }, 60000)
})

describe('merging only the tested commit', () => {
  it('records the tested commit on the lane', async () => {
    const { harness, id, lane } = await winnerHeat()
    expect(lane.tip).toBe(sh(['rev-parse', lane.branch!], harness.repo).trim())
    const other = laneOf(heat(harness, id), 'codex')
    expect(other.tip).toBe(base(harness, id))
  }, 60000)

  it('is not fooled by a tag with the same name as the branch', async () => {
    const { harness, id, lane } = await winnerHeat()
    const evil = evilCommit(harness.repo)
    sh(['tag', lane.branch!, evil], harness.repo)

    const result = await harness.engine.merge(id, lane.id)
    expect(result.merged).toBe(true)
    expect(head(harness.repo)).toBe(lane.tip)
    expect(existsSync(join(harness.repo, 'EVIL.txt'))).toBe(false)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
  }, 60000)

  it('merges the tested commit even if the branch name was moved to something else', async () => {
    const { harness, id, lane } = await winnerHeat()
    const evil = evilCommit(harness.repo)
    sh(['update-ref', `refs/heads/${lane.branch}`, evil], harness.repo)

    await harness.engine.merge(id, lane.id)
    expect(head(harness.repo)).toBe(lane.tip)
    expect(existsSync(join(harness.repo, 'EVIL.txt'))).toBe(false)
    // The moved branch is no longer where it was left, so it is kept.
    expect(sh(['rev-parse', lane.branch!], harness.repo).trim()).toBe(evil)
  }, 60000)

  it('fails a lane whose agent moved the worktree off its branch', async () => {
    const rogue = (cwd: string): void => {
      finished(cwd)
      sh(['checkout', '-q', '-b', 'rogue'], cwd)
    }
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: rogue }, codex: SCENARIOS['noChange']! })
    const id = await decideHeat(harness, ['claude', 'codex'])
    const lane = laneOf(heat(harness, id), 'claude')
    expect(lane.error).toContain('left its branch')
    expect(lane.gates.every((g) => g.passed)).toBe(false)
    expect(heat(harness, id).decision?.kind).toBe('none')
    expect(lane.tip).toBeUndefined()
    // Discard moves the worktree into Regatta's trash with the uncommitted file and rogue branch intact.
    await harness.engine.discard(id)
    expect(existsSync(lane.worktree!)).toBe(false)
    const trashed = (await listTrash(harness.worktrees)).find((e) => basename(e.trashPath) === basename(lane.worktree!))!
    expect(existsSync(join(trashed.trashPath, 'DONE.txt'))).toBe(true)
    expect(sh(['branch', '--list', 'rogue'], harness.repo).trim()).not.toBe('')
  }, 60000)
})

function base(harness: Harness, id: string): string {
  return heat(harness, id).base!
}

describe('names that are reserved and folders that are made exclusively', () => {
  it('never gives two simultaneous starts the same id', async () => {
    const ids = ['twin0001', 'twin0001', 'twin0001', 'twin0002']
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! }, { newId: () => ids.shift() ?? 'spare000' })
    const [a, b] = await Promise.all([
      harness.engine.start(options(['claude', 'codex'])),
      harness.engine.start(options(['claude', 'codex']))
    ])
    expect(a.id).not.toBe(b.id)
    expect(new Set([a.id, b.id])).toEqual(new Set(['twin0001', 'twin0002']))
    await waitFor('both heats to be decided', () => [a.id, b.id].every((i) => heat(harness, i).status === 'decided'))
    for (const i of [a.id, b.id]) expect(heat(harness, i).lanes.every((l) => l.worktree !== null && l.error === null)).toBe(true)
  }, 90000)

  it('does not claim an empty folder that appeared after the id was chosen', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! }, { newId: () => 'empty001' })
    const folder = join(harness.worktrees, 'heat-empty001-codex')
    // Someone makes an empty folder after the id was checked (the baseline setup stands in for them).
    const id = await decideHeat(harness, ['claude', 'codex'], { setup: `mkdir -p ${folder}` })
    const codex = laneOf(heat(harness, id), 'codex')
    expect(codex.error).toContain('is already there')
    expect(codex.worktree).toBeNull()
    // Claude's lane was not in the way and ran.
    expect(laneOf(heat(harness, id), 'claude').error).toBeNull()

    await harness.engine.discard(id)
    await emptyTrash(harness.worktrees)
    expect(existsSync(folder)).toBe(true)
    expect(readdirSync(folder)).toEqual([])
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(1)
  }, 60000)

  it('refuses a heat whose checks share a name', async () => {
    const harness = makeHarness(['claude', 'codex'], {})
    const checks: CheckSpec[] = [
      { name: 'test', command: 'true', kind: 'required' },
      { name: 'test', command: 'false', kind: 'required' }
    ]
    await expect(harness.engine.start(options(['claude', 'codex'], { checks }))).rejects.toThrow('Each check needs its own name. Used more than once: test.')
    expect(harness.engine.list()).toEqual([])
  })
})

describe('a folder inside the repository', () => {
  it('guards ignored files by their place in the whole repository', async () => {
    const harness = makeHarness(['claude', 'codex'], {
      // Agents run in the project's own folder inside the worktree (src), not at the top of it.
      claude: { delayMs: 60, write: (cwd) => {
        writeFileSync(join(cwd, 'DONE.txt'), 'done\n')
        appendFileSync(join(cwd, 'app.js'), '// changed by the agent\n')
        writeFileSync(join(cwd, 'cache.json'), '{"theirs":true}\n')
      } },
      codex: SCENARIOS['noChange']!
    })
    const inner = new HeatEngine({ ...harness.deps, root: () => join(harness.repo, 'src') })
    const id = (await inner.start(options(['claude', 'codex']))).id
    await waitFor('the heat to be decided', () => inner.list().find((h) => h.id === id)?.status === 'decided')
    const lane = inner.list().find((h) => h.id === id)!.lanes.find((l) => l.agent === 'claude')!
    expect(harness.runs.map((run) => run.cwd.endsWith(`${sep}src`))).toEqual([true, true])
    expect(basename(lane.worktree!)).toMatch(/^heat-/)
    expect(sh(['show', `${lane.tip}:src/DONE.txt`], harness.repo)).toBe('done\n')
    writeFileSync(join(harness.repo, '.gitignore'), 'src/cache.json\n')
    writeFileSync(join(harness.repo, 'src', 'cache.json'), '{"mine":true}\n')
    const before = head(harness.repo)

    await expect(inner.merge(id, lane.id)).rejects.toThrow(/src\/cache\.json/)
    expect(readFileSync(join(harness.repo, 'src', 'cache.json'), 'utf8')).toBe('{"mine":true}\n')
    expect(head(harness.repo)).toBe(before)
    await inner.discard(id)
  }, 90000)
})

describe('what a heat keeps instead of removing (round 3)', () => {
  it('never deletes the branch a lane ref was made to point at (a symbolic lane ref)', async () => {
    const { harness, id } = await winnerHeat()
    const other = laneOf(heat(harness, id), 'codex')
    const main = sh(['rev-parse', 'main'], harness.repo).trim()
    // Someone replaces the idle lane's branch with a symbolic ref to main. Its tested commit is the base, which is main's tip.
    sh(['worktree', 'remove', '--force', other.worktree!], harness.repo)
    sh(['branch', '-D', other.branch!], harness.repo)
    sh(['symbolic-ref', `refs/heads/${other.branch}`, 'refs/heads/main'], harness.repo)
    expect(other.tip).toBe(main)

    await harness.engine.discard(id)
    expect(sh(['rev-parse', 'main'], harness.repo).trim()).toBe(main)
    expect(sh(['symbolic-ref', `refs/heads/${other.branch}`], harness.repo).trim()).toBe('refs/heads/main')
    expect(heat(harness, id).notes?.join(' ')).toContain('symbolic')
  }, 60000)

  it('keeps a lane branch that never got a tested commit once the user has committed on it', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60000 }, codex: { delayMs: 60000 } })
    const id = (await harness.engine.start(options(['claude', 'codex']))).id
    await waitFor('both lanes to run', () => heat(harness, id).lanes.every((l) => l.phase === 'running'))
    harness.engine.cancel(id)
    await waitFor('the heat to be cancelled', () => heat(harness, id).lanes.every((l) => l.phase === 'done'))
    const [first, second] = heat(harness, id).lanes
    expect(first!.tip).toBeUndefined()
    // The user checks out the lane branch in its worktree and keeps working on it.
    writeFileSync(join(first!.worktree!, 'USERS.txt'), 'my work\n')
    sh(['add', '-A'], first!.worktree!)
    sh([...IDENTITY, 'commit', '-m', 'my own commit on the lane branch'], first!.worktree!)
    const theirs = sh(['rev-parse', first!.branch!], harness.repo).trim()

    await harness.engine.discard(id)
    expect(sh(['rev-parse', first!.branch!], harness.repo).trim()).toBe(theirs)
    expect(sh(['rev-parse', `refs/regatta/discarded/${id}/${first!.id}^1`], harness.repo).trim()).toBe(theirs)
    // Both lane worktrees are moved to Regatta's trash, with the user's file preserved inside the trashed folder.
    expect(existsSync(second!.worktree!)).toBe(false)
    expect(existsSync(first!.worktree!)).toBe(false)
    const trashed = (await listTrash(harness.worktrees)).find((e) => basename(e.trashPath) === basename(first!.worktree!))!
    expect(readFileSync(join(trashed.trashPath, 'USERS.txt'), 'utf8')).toBe('my work\n')
    expect(heat(harness, id).notes?.join(' ')).toContain(first!.branch)
  }, 60000)

  it('does not remove a baseline worktree that was replaced by one of the user', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! }, { newId: () => 'base0001' })
    const folder = join(harness.worktrees, 'heat-base0001-base')
    // The setup runs in the baseline: it stands in for the user swapping that worktree for their own.
    const swap = `cd ${harness.repo} && git worktree remove --force ${folder} && git worktree add -q -b users-base ${folder} main && echo mine > ${folder}/USER.txt`
    const setup = `case "$PWD" in *-base) ${swap};; esac`
    const id = await decideHeat(harness, ['claude', 'codex'], { setup })
    expect(heat(harness, id).status).toBe('decided')
    expect(readFileSync(join(folder, 'USER.txt'), 'utf8')).toBe('mine\n')
    expect(sh(['branch', '--list', 'users-base'], harness.repo).trim()).not.toBe('')
    await harness.engine.discard(id)
    expect(readFileSync(join(folder, 'USER.txt'), 'utf8')).toBe('mine\n')
  }, 60000)

  it('runs checks away from the lane: its folder stays as committed, and every temporary worktree is gone', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! }, { newId: () => 'base0002' })
    const checks: CheckSpec[] = [
      { name: 'done', command: 'echo output > coverage.txt; test -f DONE.txt', kind: 'required' },
      { name: 'guard', command: 'test -f GUARD.txt', kind: 'guard' }
    ]
    const id = await decideHeat(harness, ['claude', 'codex'], { checks })
    expect(readdirSync(harness.worktrees).sort()).toEqual(['heat-base0002-claude', 'heat-base0002-codex'])
    const state = heat(harness, id)
    const lane = laneOf(state, 'claude')
    const other = laneOf(state, 'codex')
    expect(existsSync(join(lane.worktree!, 'coverage.txt'))).toBe(false)
    expect(sh(['status', '--porcelain', '--ignored'], lane.worktree!).trim()).toBe('')
    // The user adds a file of their own to the other lane's folder: it moves into Regatta's trash intact.
    writeFileSync(join(other.worktree!, 'MINE.txt'), 'mine\n')
    const result = await harness.engine.merge(id, lane.id)
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')
    expect(existsSync(lane.worktree!)).toBe(false)
    expect(existsSync(other.worktree!)).toBe(false)
    const trashed = (await listTrash(harness.worktrees)).find((e) => basename(e.trashPath) === basename(other.worktree!))!
    expect(readFileSync(join(trashed.trashPath, 'MINE.txt'), 'utf8')).toBe('mine\n')
  }, 60000)

  it('keeps what the user writes into a lane while its checks run, instead of taking it for check output', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! })
    // A check that behaves like the user: it drops a file into the lane worktree that the check is judging.
    const checks: CheckSpec[] = [{ name: 'done', command: 'if [ -f DONE.txt ]; then echo mine > "${PWD%-check}/USERS.txt"; fi; test -f DONE.txt', kind: 'required' }]
    const id = await decideHeat(harness, ['claude', 'codex'], { checks })
    const lane = laneOf(heat(harness, id), 'claude')
    expect(readFileSync(join(lane.worktree!, 'USERS.txt'), 'utf8')).toBe('mine\n')
    const result = await harness.engine.merge(id, lane.id)
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')
    const trashed = (await listTrash(harness.worktrees)).find((e) => basename(e.trashPath) === basename(lane.worktree!))!
    expect(readFileSync(join(trashed.trashPath, 'USERS.txt'), 'utf8')).toBe('mine\n')
    await harness.engine.discard(id)
    expect(readFileSync(join(trashed.trashPath, 'USERS.txt'), 'utf8')).toBe('mine\n')
  }, 60000)

  it('keeps a worktree, its branch and says so when the agent leaves programs that cannot be stopped', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: { ...SCENARIOS['good']!, stuck: true } })
    const id = await decideHeat(harness, ['claude', 'codex'])
    const state = heat(harness, id)
    const stuck = laneOf(state, 'codex')
    const fine = laneOf(state, 'claude')
    expect(stuck.error).toContain('could not be stopped')
    expect(stuck.gates.every((g) => g.passed)).toBe(false)
    expect(state.notes?.join(' ')).toContain('could not be stopped')
    expect(state.decision).toMatchObject({ kind: 'winner', laneIds: [fine.id] })

    const result = await harness.engine.merge(id, fine.id)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(result.summary).toContain('Kept:')
    await emptyTrash(harness.worktrees)
    expect(existsSync(stuck.worktree!)).toBe(true)
    expect(branches(harness.repo)).toEqual([stuck.branch])
    // Discarding does not change its mind: whatever could still be using the folder is not under it.
    await harness.engine.discard(id)
    expect(existsSync(stuck.worktree!)).toBe(true)
    expect(branches(harness.repo)).toEqual([stuck.branch])
  }, 60000)

  it('keeps the worktree of a lane whose descendant started its own session and still runs there', async () => {
    let pid = 0
    const leaves = (cwd: string): void => {
      finished(cwd)
      pid = leaveSleeper(cwd)
    }
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: leaves }, codex: SCENARIOS['noChange']! })
    const id = await decideHeat(harness, ['claude', 'codex'])
    const lane = laneOf(heat(harness, id), 'claude')
    const other = laneOf(heat(harness, id), 'codex')
    expect(pid).toBeGreaterThan(0)

    const result = await harness.engine.merge(id, lane.id)
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')
    expect(existsSync(lane.worktree!)).toBe(false)
    expect(existsSync(other.worktree!)).toBe(false)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(alive(pid)).toBe(true)

    // Empty trash skips the trashed worktree that still has a running program inside it.
    const firstEmpty = await emptyTrash(harness.worktrees)
    expect(firstEmpty.outcomes.filter((o) => o.status === 'skipped').map((o) => o.reason).join(' ')).toContain('in use by')
    expect(branches(harness.repo)).toEqual([lane.branch])

    // Once the program is gone, emptying the trash finishes the job, branch included.
    killSleepers()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).toEqual([])
  }, 60000)

  it('refuses to merge or discard when the repository identity cannot be read, and recovers when it can', async () => {
    const { harness, id, lane } = await winnerHeat()
    const headFile = join(harness.repo, '.git', 'HEAD')
    const saved = readFileSync(headFile, 'utf8')
    rmSync(headFile)
    await expect(harness.engine.merge(id, lane.id)).rejects.toThrow(/Could not tell which repository/)
    await expect(harness.engine.discard(id)).rejects.toThrow(/Could not tell which repository/)
    writeFileSync(headFile, saved)
    stillThere(harness, id)
    expect(heat(harness, id).status).toBe('decided')
    expect((await harness.engine.merge(id, lane.id)).merged).toBe(true)
  }, 60000)

  it('merges the tested commit even when a replace ref redirects its contents', async () => {
    const { harness, id, lane } = await winnerHeat()
    // Plain git would now read the lane tip as the base commit, which has no DONE.txt.
    sh(['replace', lane.tip!, base(harness, id)], harness.repo)
    expect((await harness.engine.merge(id, lane.id)).merged).toBe(true)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
  }, 60000)

  it('will not overwrite an ignored file where the winner needs a folder, hidden in a collapsed ignored folder', async () => {
    const nested = (cwd: string): void => {
      finished(cwd)
      mkdirSync(join(cwd, 'out', 'nested'), { recursive: true })
      writeFileSync(join(cwd, 'out', 'nested', 'leaf.txt'), 'theirs\n')
    }
    const { harness, id, lane } = await winnerHeat({ claude: { delayMs: 60, write: nested } })
    writeFileSync(join(harness.repo, '.gitignore'), 'out/\n')
    mkdirSync(join(harness.repo, 'out'))
    writeFileSync(join(harness.repo, 'out', 'nested'), 'precious\n')
    const before = head(harness.repo)
    await expect(harness.engine.merge(id, lane.id)).rejects.toThrow(/Merging would overwrite files.*\bout\b/)
    expect(readFileSync(join(harness.repo, 'out', 'nested'), 'utf8')).toBe('precious\n')
    expect(head(harness.repo)).toBe(before)
    expect(heat(harness, id).status).toBe('decided')
    stillThere(harness, id)
  }, 60000)

  it('moves a conflict into a scratch worktree: the folder never has a merge to abort, and nothing is left behind', async () => {
    const { harness, id, lane } = await winnerHeat()
    appendFileSync(join(harness.repo, 'src', 'app.js'), '// made in the folder\n')
    sh([...IDENTITY, 'commit', '-am', 'conflicting work'], harness.repo)
    const before = head(harness.repo)
    await expect(harness.engine.merge(id, lane.id)).rejects.toThrow(/conflicts with work in main/)
    expect(existsSync(join(harness.repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(head(harness.repo)).toBe(before)
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
    // Only the two lane worktrees are registered and only they are in the worktrees folder.
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(3)
    expect(readdirSync(harness.worktrees).sort()).toEqual(readdirSync(harness.worktrees).filter((name) => name.startsWith(`heat-${id}-`)).sort())
    stillThere(harness, id)
  }, 60000)
})

describe('work the user did in a lane is never lost (round 5)', () => {
  /** An agent that also commits by itself, as a user working in the lane would. */
  const committing = (cwd: string): void => {
    finished(cwd)
    sh(['add', '-A'], cwd)
    sh([...IDENTITY, 'commit', '-m', "the user's own commit in the lane"], cwd)
  }

  it('parks a lane whose tip is a commit made by someone else when the heat is discarded', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: committing }, codex: SCENARIOS['noChange']! })
    const id = await decideHeat(harness, ['claude', 'codex'])
    const lane = laneOf(heat(harness, id), 'claude')
    expect(sh(['log', '-1', '--format=%an', lane.tip!], harness.repo).trim()).toBe('Regatta Test')

    await harness.engine.discard(id)
    const parked = `refs/regatta/discarded/${id}/${lane.id}`
    expect(sh(['rev-parse', `${parked}^1`], harness.repo).trim()).toBe(lane.tip)
    expect(sh(['show', `${parked}^1:DONE.txt`], harness.repo)).toBe('done\n')
    const notes = heat(harness, id).notes?.join(' ') ?? ''
    expect(notes).toContain(`Kept a copy of ${lane.id}'s work at ${parked}`)
    // A hint that works pasted as it is: a real branch name, free now, no placeholder.
    const restoreAs = `heat-${id}-${lane.id}-restored`
    expect(notes).toContain(`restore the work with git branch ${restoreAs} ${parked}^1`)
    expect(notes).not.toContain('<name>')
    expect(notes).toContain(`git log ${parked} shows everything kept`)
    sh(['branch', restoreAs, `${parked}^1`], harness.repo)
    expect(sh(['show', `${restoreAs}:DONE.txt`], harness.repo)).toBe('done\n')
    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).toEqual([])
  }, 60000)

  it('numbers the restore name in the hint when that branch already exists', async () => {
    const { harness, id, lane } = await winnerHeat()
    sh(['branch', `heat-${id}-${lane.id}-restored`, 'main'], harness.repo)
    sh(['branch', `heat-${id}-${lane.id}-restored-2`, 'main'], harness.repo)
    await harness.engine.discard(id)
    const notes = heat(harness, id).notes?.join(' ') ?? ''
    expect(notes).toContain(`git branch heat-${id}-${lane.id}-restored-3 refs/regatta/discarded/${id}/${lane.id}^1`)
  }, 60000)

  it('parks the lanes that lost when another lane is merged, and says so in the summary', async () => {
    const harness = makeHarness(['claude', 'codex'], {
      claude: { delayMs: 60, write: committing, exitCode: 2 },
      codex: SCENARIOS['good']!
    })
    const id = await decideHeat(harness, ['claude', 'codex'])
    const loser = laneOf(heat(harness, id), 'claude')
    const winner = laneOf(heat(harness, id), 'codex')
    expect(heat(harness, id).decision).toMatchObject({ laneIds: [winner.id] })
    const result = await harness.engine.merge(id, winner.id)
    const parked = `refs/regatta/discarded/${id}/${loser.id}`
    expect(result.summary).toContain(`Kept a copy of ${loser.id}'s work at ${parked}`)
    expect(sh(['rev-parse', `${parked}^1`], harness.repo).trim()).toBe(loser.tip)
    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).toEqual([])
  }, 60000)

  it('does not commit the node_modules link when an ignore line with a slash fails to match it, so the winner merges and the lane goes', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! })
    writeFileSync(join(harness.repo, '.gitignore'), 'node_modules/\n')
    sh(['add', '.gitignore'], harness.repo)
    sh([...IDENTITY, 'commit', '-m', 'ignore node_modules'], harness.repo)
    mkdirSync(join(harness.repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(harness.repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    const id = await decideHeat(harness, ['claude', 'codex'])
    const lane = laneOf(heat(harness, id), 'claude')
    expect(sh(['ls-tree', '-r', '--name-only', lane.tip!], harness.repo).split('\n')).not.toContain('node_modules')
    expect(lane.diff.files).toBe(2)
    expect(lane.gates.every((g) => g.passed)).toBe(true)

    const result = await harness.engine.merge(id, lane.id)
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')
    expect(existsSync(lane.worktree!)).toBe(false)
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
  }, 60000)

  it('tries a lane branch again after its folder was deleted by hand, once git has forgotten the folder', async () => {
    const { harness, id, lane } = await winnerHeat()
    rmSync(lane.worktree!, { recursive: true, force: true })
    await harness.engine.discard(id)
    // Git still lists the vanished folder as having the branch checked out, so the branch stays.
    expect(branches(harness.repo)).toContain(lane.branch)
    expect(heat(harness, id).notes?.join(' ')).toContain('checked out in a worktree')
    sh(['worktree', 'prune'], harness.repo)
    await harness.engine.discard(id)
    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).toEqual([])
    expect(sh(['rev-parse', `refs/regatta/discarded/${id}/${lane.id}^1`], harness.repo).trim()).toBe(lane.tip)
  }, 60000)
})

describe('dependencies are copied, never linked (round 7)', () => {
  /** A fingerprint of a whole folder: names, file contents and link targets. */
  function treeHash(root: string): string {
    const hash = createHash('sha1')
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        if (dir === root && name === '.regatta-copy') continue // the marker Regatta writes into its own copy
        const path = join(dir, name)
        const stat = lstatSync(path)
        hash.update(`${path.slice(root.length)}|${stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? `l:${readlinkSync(path)}` : `f:${stat.size}`}\n`)
        if (stat.isDirectory()) walk(path)
        else if (stat.isFile()) hash.update(readFileSync(path))
      }
    }
    walk(root)
    return hash.digest('hex')
  }

  function withModules(harness: Harness): string {
    mkdirSync(join(harness.repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(harness.repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    mkdirSync(join(harness.repo, 'node_modules', '.bin'))
    symlinkSync('../pkg/index.js', join(harness.repo, 'node_modules', '.bin', 'pkg'))
    return treeHash(join(harness.repo, 'node_modules'))
  }

  it.skipIf(process.platform !== 'darwin')('leaves the project node_modules as it was when an agent and a check delete and rewrite theirs', async () => {
    const wipes = (cwd: string): void => {
      finished(cwd)
      // Emptied and refilled in place: the folder itself stays the copy that was made (a replaced folder would keep the lane).
      // (like `rm -rf node_modules/*`, which leaves dotfiles such as Regatta's marker)
      for (const name of readdirSync(join(cwd, 'node_modules')).filter((n) => !n.startsWith('.'))) rmSync(join(cwd, 'node_modules', name), { recursive: true, force: true })
      writeFileSync(join(cwd, 'node_modules', 'installed.js'), 'by npm ci\n')
    }
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: wipes }, codex: SCENARIOS['noChange']! })
    const original = withModules(harness)
    // A check that does what `npm ci` and `rm -rf node_modules/` do, in whatever folder it runs.
    const checks: CheckSpec[] = [{ name: 'done', command: 'rm -rf node_modules/ && mkdir node_modules && echo x > node_modules/y.js; test -f DONE.txt', kind: 'required' }]
    const id = await decideHeat(harness, ['claude', 'codex'], { checks })
    expect(treeHash(join(harness.repo, 'node_modules'))).toBe(original)
    const lane = laneOf(heat(harness, id), 'claude')
    expect(lane.gates.every((g) => g.passed)).toBe(true)
    // The lane's own copy was rewritten, and none of that is in its commit.
    expect(readFileSync(join(lane.worktree!, 'node_modules', 'installed.js'), 'utf8')).toBe('by npm ci\n')
    expect(sh(['ls-tree', '-r', '--name-only', lane.tip!], harness.repo).split('\n').some((name) => name.startsWith('node_modules'))).toBe(false)

    // Both lanes are moved to Regatta's trash; the project's folder is still as it was.
    const result = await harness.engine.merge(id, lane.id)
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')
    expect(existsSync(lane.worktree!)).toBe(false)
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    expect(treeHash(join(harness.repo, 'node_modules'))).toBe(original)
  }, 90000)

  it.skipIf(process.platform !== 'darwin')('keeps a lane in which the user put a file outside its copy of node_modules', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! })
    withModules(harness)
    const id = await decideHeat(harness, ['claude', 'codex'])
    const state = heat(harness, id)
    const other = laneOf(state, 'codex')
    writeFileSync(join(other.worktree!, 'MINE.txt'), 'mine\n')
    // And a change inside the copy is not a change.
    writeFileSync(join(laneOf(state, 'claude').worktree!, 'node_modules', 'pkg', 'extra.js'), 'x\n')
    const result = await harness.engine.merge(id, laneOf(state, 'claude').id)
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')
    const trashed = (await listTrash(harness.worktrees)).find((e) => basename(e.trashPath) === basename(other.worktree!))!
    expect(readFileSync(join(trashed.trashPath, 'MINE.txt'), 'utf8')).toBe('mine\n')
    expect(existsSync(laneOf(state, 'claude').worktree!)).toBe(false)
  }, 90000)

  it('says what is in use: every worktree the engine owns or holds, and nothing once they are gone', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60000 }, codex: { delayMs: 60000 } })
    expect(harness.engine.busyPaths()).toEqual([])
    const id = (await harness.engine.start(options(['claude', 'codex']))).id
    await waitFor('both lanes to run', () => heat(harness, id).lanes.every((l) => l.phase === 'running'))
    const lanes = heat(harness, id).lanes
    expect(harness.engine.busyPaths().sort()).toEqual(lanes.map((l) => l.worktree!).sort())
    harness.engine.cancel(id)
    await harness.engine.discard(id)
    expect(harness.engine.busyPaths()).toEqual([])
  }, 60000)

  it('lists the baseline while it exists, and a folder held for a program that would not stop', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: { ...SCENARIOS['good']!, stuck: true } }, { newId: () => 'busy0001' })
    const slow = `if [ "$(basename "$PWD")" = heat-busy0001-base ]; then sleep 1; fi`
    const id = (await harness.engine.start(options(['claude', 'codex'], { checks: [{ name: 'slow', command: slow, kind: 'required' }] }))).id
    await waitFor('the baseline to exist', () => harness.engine.busyPaths().some((path) => path.endsWith('-base')))
    expect(harness.engine.busyPaths().some((path) => path.endsWith('heat-busy0001-base'))).toBe(true)
    await waitFor('the heat to be decided', () => heat(harness, id).status === 'decided')
    const stuck = laneOf(heat(harness, id), 'codex')
    expect(harness.engine.busyPaths()).toContain(stuck.worktree!)
    await harness.engine.discard(id)
    expect(harness.engine.busyPaths()).toEqual([stuck.worktree!])
  }, 60000)
})

describe('quitting', () => {
  it('starts nothing new after quit(): no lane, no scoring commit, no check worktree or process, no merge, and it can be called again', async () => {
    const markers = temp('regatta-heat-quit-')
    const checks: CheckSpec[] = [{ name: 'mark', command: `echo ran > ${markers}/check-$(basename "$PWD")`, kind: 'required' }]
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 500, write: finished }, codex: { delayMs: 500, write: finished } })
    const id = (await harness.engine.start(options(['claude', 'codex'], { checks }))).id
    await waitFor('both lanes to run', () => heat(harness, id).lanes.every((l) => l.phase === 'running'))
    const lanes = heat(harness, id).lanes
    const tips = lanes.map((l) => sh(['rev-parse', l.branch!], harness.repo).trim())
    const baselineMarkers = readdirSync(markers).sort()

    harness.engine.quit()
    harness.engine.quit()
    // The agents finish after the quit; the engine does not go on to score them.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(lanes.map((l) => sh(['rev-parse', l.branch!], harness.repo).trim())).toEqual(tips)
    expect(readdirSync(markers).sort()).toEqual(baselineMarkers)
    expect(readdirSync(harness.worktrees).sort()).toEqual(lanes.map((l) => basename(l.worktree!)).sort())
    expect(heat(harness, id).status).toBe('racing')
    expect(heat(harness, id).decision).toBeNull()
    await expect(harness.engine.start(options(['claude', 'codex']))).rejects.toThrow(/quitting/)
    await expect(harness.engine.merge(id, lanes[0]!.id)).rejects.toThrow(/quitting/)
  }, 60000)

  it('stops a baseline that is still running and makes no lane', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    const pidFile = join(temp('regatta-heat-quit-'), 'setup.pid')
    const id = (await harness.engine.start(options(['claude', 'codex'], { setup: `sleep 300 & echo $! > ${pidFile}; wait` }))).id
    await waitFor('the setup command to run', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    harness.engine.quit()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(heat(harness, id).lanes.every((l) => l.worktree === null)).toBe(true)
    expect(harness.runs).toHaveLength(0)
    expect(alive(Number(readFileSync(pidFile, 'utf8').trim()))).toBe(false)
  }, 60000)
})

describe('round 9', () => {
  it('parks a commit that only the lane branch reflog held (made, then reset away), through discard', async () => {
    const { harness, id, lane } = await winnerHeat()
    // After scoring, the user commits U in the lane, resets the branch back to the tested commit, and removes the clean worktree by hand.
    writeFileSync(join(lane.worktree!, 'unique.txt'), 'made in the lane, then reset away\n')
    sh(['add', '-A'], lane.worktree!)
    sh([...IDENTITY, 'commit', '-m', 'unique commit U'], lane.worktree!)
    const u = sh(['rev-parse', 'HEAD'], lane.worktree!).trim()
    sh(['reset', '--hard', lane.tip!], lane.worktree!)
    sh(['worktree', 'remove', lane.worktree!], harness.repo)
    expect(sh(['rev-list', '--all'], harness.repo)).not.toContain(u)

    await harness.engine.discard(id)
    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).toEqual([])
    const parked = `refs/regatta/discarded/${id}/${lane.id}`
    expect(sh(['rev-parse', `${parked}^1`], harness.repo).trim()).toBe(lane.tip)
    // The commit the branch once had is another parent of the one keep commit.
    expect(sh(['rev-list', '--parents', '-n', '1', parked], harness.repo).trim().split(' ').slice(1)).toContain(u)
    expect(sh(['rev-list', '--all'], harness.repo)).toContain(u)
    sh(['reflog', 'expire', '--expire=now', '--all'], harness.repo)
    sh(['gc', '--prune=now', '-q'], harness.repo)
    expect(sh(['show', `${u}:unique.txt`], harness.repo)).toBe('made in the lane, then reset away\n')
    expect(heat(harness, id).notes?.join(' ')).toContain(parked)
  }, 60000)

  it('does not run a merge that was queued behind the repository lock when Regatta quit meanwhile', async () => {
    const { harness, id, lane } = await winnerHeat()
    const before = head(harness.repo)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const holding = withRepoLock(harness.repo, () => gate)
    const merging = harness.engine.merge(id, lane.id)
    merging.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 400))
    harness.engine.quit()
    release()
    await holding
    await expect(merging).rejects.toThrow(/quitting/)
    expect(head(harness.repo)).toBe(before)
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
    stillThere(harness, id)
    expect(heat(harness, id).status).toBe('decided')
  }, 60000)

  it('does not make a baseline worktree that was queued behind the repository lock when Regatta quit meanwhile', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    // A git that writes down every worktree it is asked to add (a made-and-removed folder would leave no other trace).
    const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
    const bin = temp('regatta-heat-gitlog-')
    const log = join(bin, 'calls.log')
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$*" in *"worktree add"*) echo "$*" >> ${log};; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 })
    const saved = process.env['PATH']
    process.env['PATH'] = `${bin}:${saved}`
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const holding = withRepoLock(harness.repo, () => gate)
      const id = (await harness.engine.start(options(['claude', 'codex']))).id
      await new Promise((resolve) => setTimeout(resolve, 600))
      harness.engine.quit()
      release()
      await holding
      await new Promise((resolve) => setTimeout(resolve, 800))
      expect(existsSync(log)).toBe(false)
      expect(existsSync(harness.worktrees) ? readdirSync(harness.worktrees) : []).toEqual([])
      expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(1)
      expect(branches(harness.repo)).toEqual([])
      expect(harness.runs).toHaveLength(0)
      expect(heat(harness, id).lanes.every((l) => l.worktree === null)).toBe(true)
    } finally {
      process.env['PATH'] = saved
    }
  }, 60000)

  it('stops a merge when Regatta quits during the last status check, right before the fast-forward is launched', async () => {
    const { harness, id, lane } = await winnerHeat()
    const before = head(harness.repo)
    // A git that lingers on the second look at the user's folder (the one right before the write).
    const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
    const bin = temp('regatta-heat-slowgit-')
    const counter = join(bin, 'count')
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\ncase "$*" in *"--untracked-files=no"*) echo x >> ${counter}; if [ "$(wc -l < ${counter})" -eq 2 ]; then sleep 1.2; fi;; esac\nexec ${realGit} "$@"\n`,
      { mode: 0o755 }
    )
    const saved = process.env['PATH']
    process.env['PATH'] = `${bin}:${saved}`
    try {
      const merging = harness.engine.merge(id, lane.id)
      merging.catch(() => undefined)
      await waitFor('the second status call', () => existsSync(counter) && readFileSync(counter, 'utf8').trim().split('\n').length >= 2, 20000)
      harness.engine.quit()
      await expect(merging).rejects.toThrow(/quitting/)
    } finally {
      process.env['PATH'] = saved
    }
    expect(head(harness.repo)).toBe(before)
    expect(existsSync(join(harness.repo, 'DONE.txt'))).toBe(false)
  }, 60000)

  it('runs in a project folder whose name starts with a space, not in its trimmed twin', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: (cwd) => {
      writeFileSync(join(cwd, 'DONE.txt'), 'done\n')
    } }, codex: SCENARIOS['noChange']! })
    mkdirSync(join(harness.repo, ' app'))
    writeFileSync(join(harness.repo, ' app', 'file.txt'), 'x\n')
    sh(['add', '-A'], harness.repo)
    sh([...IDENTITY, 'commit', '-m', 'a folder with a space in its name'], harness.repo)
    const inner = new HeatEngine({ ...harness.deps, root: () => join(harness.repo, ' app') })
    const id = (await inner.start(options(['claude', 'codex']))).id
    await waitFor('the heat to be decided', () => inner.list().find((h) => h.id === id)?.status === 'decided')
    expect(harness.runs.map((run) => run.cwd.endsWith(`${sep} app`))).toEqual([true, true])
    expect(existsSync(join(harness.runs[0]!.cwd, '..', 'app'))).toBe(false)
    await inner.discard(id)
  }, 90000)

  it('runs the baseline, the agents and the checks in the project folder when the project is a subfolder', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: (cwd) => {
      writeFileSync(join(cwd, 'DONE.txt'), 'done\n')
      appendFileSync(join(cwd, 'app.js'), '// changed\n')
    } }, codex: SCENARIOS['noChange']! })
    const inner = new HeatEngine({ ...harness.deps, root: () => join(harness.repo, 'src') })
    const where = temp('regatta-heat-where-')
    // Every check records the folder it ran in.
    const checks: CheckSpec[] = [{ name: 'where', command: `pwd -P >> ${where}/pwd.txt; test -f DONE.txt`, kind: 'required' }]
    const id = (await inner.start(options(['claude', 'codex'], { checks }))).id
    await waitFor('the heat to be decided', () => inner.list().find((h) => h.id === id)?.status === 'decided')
    const folders = readFileSync(join(where, 'pwd.txt'), 'utf8').trim().split('\n')
    // Baseline, then the check worktree of each lane: all inside src of their own worktree.
    expect(folders.length).toBe(3)
    expect(folders.every((folder) => folder.endsWith('/src'))).toBe(true)
    expect(inner.list().find((h) => h.id === id)!.lanes.find((l) => l.agent === 'claude')!.gates.every((g) => g.passed)).toBe(true)
    await inner.discard(id)
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    await emptyTrash(harness.worktrees)
    expect(await listTrash(harness.worktrees)).toEqual([])
  }, 90000)

  it('refuses the lane before any setup, check or agent runs when the project subfolder or an ancestor is a symlink outside the worktree', async () => {
    const EXPECTED = 'Refused: the project folder inside the worktree leads outside it (a symlink).'
    for (const mode of ['leaf-symlink', 'ancestor-symlink'] as const) {
      const harness = makeHarness(
        ['claude', 'codex'],
        {
          claude: {
            delayMs: 10,
            write: (cwd) => {
              writeFileSync(join(cwd, 'agent-touched.txt'), 'agent wrote here\n')
            }
          },
          codex: {
            delayMs: 10,
            write: (cwd) => {
              writeFileSync(join(cwd, 'agent-touched.txt'), 'agent wrote here\n')
            }
          }
        }
      )

      const victim = temp(`regatta-heat-victim-${mode}-`)
      writeFileSync(join(victim, 'precious.txt'), 'original project file\n')

      // Commit a symlink at packages/app (or at packages) pointing to the victim folder, then replace it with a real
      // directory in the main working tree (uncommitted) so opening packages/app sets runtime.prefix = "packages/app/".
      if (mode === 'leaf-symlink') {
        mkdirSync(join(harness.repo, 'packages'), { recursive: true })
        symlinkSync(victim, join(harness.repo, 'packages', 'app'), 'dir')
      } else {
        symlinkSync(victim, join(harness.repo, 'packages'), 'dir')
      }
      sh(['add', '-A'], harness.repo)
      sh([...IDENTITY, 'commit', '-m', `commit ${mode}`], harness.repo)

      rmSync(join(harness.repo, 'packages'), { recursive: true, force: true })
      mkdirSync(join(harness.repo, 'packages', 'app'), { recursive: true })

      const setupMarker = join(victim, 'setup-ran.txt')
      const checkMarker = join(victim, 'check-ran.txt')
      const inner = new HeatEngine({ ...harness.deps, root: () => join(harness.repo, 'packages', 'app') })
      const checks: CheckSpec[] = [{ name: 'probe', command: `echo check > '${checkMarker}'`, kind: 'required' }]
      const id = (await inner.start(options(['claude', 'codex'], { setup: `echo setup > '${setupMarker}'`, checks }))).id
      await waitFor('the heat to be decided', () => inner.list().find((h) => h.id === id)?.status === 'decided')

      const state = inner.list().find((h) => h.id === id)!
      expect(state.decision?.laneIds, mode).toEqual([])
      for (const lane of state.lanes) {
        expect(lane.error, mode).toBe(EXPECTED)
        expect(lane.gates.some((g) => !g.passed), mode).toBe(true)
      }
      // Neither agent, setup, nor check ever ran, and in ancestor-symlink mode mkdirSync never created 'app' inside victim.
      expect(harness.runs, mode).toEqual([])
      expect(existsSync(setupMarker), mode).toBe(false)
      expect(existsSync(checkMarker), mode).toBe(false)
      expect(readdirSync(victim), mode).toEqual(['precious.txt'])
      expect(readFileSync(join(victim, 'precious.txt'), 'utf8'), mode).toBe('original project file\n')

      await inner.discard(id)
    }
  }, 90000)
})

describe('a worktree add that fails after it made something', () => {
  /** A post-checkout hook that writes a file in the new worktree and exits with an error, for worktrees whose name matches. */
  function failingHook(repo: string, pattern: string): void {
    const file = join(repo, '.git', 'hooks', 'post-checkout')
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    writeFileSync(file, `#!/bin/sh\ncase "$(basename "$PWD")" in ${pattern}) echo hook > hook-wrote.txt; exit 1;; esac\nexit 0\n`, { mode: 0o755 })
  }

  it('keeps a lane whose add failed after making the worktree and branch, and parks the branch once the worktree can go', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    failingHook(harness.repo, '*-claude')
    const id = await decideHeat(harness, ['claude', 'codex'])
    const state = heat(harness, id)
    const failed = laneOf(state, 'claude')
    expect(failed.error).toBeTruthy()
    // What git left behind is the lane's: the folder, with the file the hook wrote, and the branch.
    expect(failed.worktree).not.toBeNull()
    expect(readFileSync(join(failed.worktree!, 'hook-wrote.txt'), 'utf8')).toBe('hook\n')
    expect(sh(['branch', '--list', failed.branch!], harness.repo).trim()).not.toBe('')
    expect(harness.engine.busyPaths()).toContain(failed.worktree!)
    expect(sh(['worktree', 'list'], harness.repo)).toContain(basename(failed.worktree!))

    // Discard moves the worktree into Regatta's trash with the hook's file intact, and parks its branch.
    await harness.engine.discard(id)
    expect(existsSync(failed.worktree!)).toBe(false)
    const trashed = (await listTrash(harness.worktrees)).find((e) => basename(e.trashPath) === basename(failed.worktree!))!
    expect(readFileSync(join(trashed.trashPath, 'hook-wrote.txt'), 'utf8')).toBe('hook\n')
    expect(harness.engine.busyPaths()).toEqual([])
    expect(sh(['for-each-ref', 'refs/regatta/discarded/'], harness.repo).trim()).not.toBe('')

    await emptyTrash(harness.worktrees)
    expect(branches(harness.repo)).not.toContain(failed.branch)
  }, 90000)

  it('removes a baseline and a check worktree whose add failed after making them, once their identity is proven', async () => {
    for (const pattern of ['*-base', '*-check']) {
      const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
      failingHook(harness.repo, pattern)
      const id = (await harness.engine.start(options(['claude', 'codex']))).id
      await waitFor('the heat to settle', () => ['error', 'decided'].includes(heat(harness, id).status), 60000)
      await harness.engine.discard(id)
      await emptyTrash(harness.worktrees)
      // Nothing is left of them: not the folder, not a registration.
      expect(existsSync(harness.worktrees) ? readdirSync(harness.worktrees).filter((n) => n !== '.regatta-trash') : [], pattern).toEqual([])
      expect(await listTrash(harness.worktrees), pattern).toEqual([])
      expect(sh(['worktree', 'list'], harness.repo).trim().split('\n'), pattern).toHaveLength(1)
      expect(branches(harness.repo), pattern).toEqual([])
      expect(harness.engine.busyPaths(), pattern).toEqual([])
    }
  }, 120000)
})

describe('live diff sampler', () => {
  it('keeps the last good DiffStat of 7 changed files and sets lane.error when the index is corrupted, then clears the error when repaired', async () => {
    const harness = makeHarness(['claude', 'codex'], {
      claude: {
        delayMs: 30000,
        early: (cwd) => {
          for (let i = 1; i <= 7; i++) {
            writeFileSync(join(cwd, `changed-${i}.txt`), `content ${i}\n`)
          }
        }
      },
      codex: { delayMs: 30000 }
    })
    const id = (await harness.engine.start(options(['claude', 'codex']))).id
    try {
      await waitFor('7 changed files to be sampled', () => laneOf(heat(harness, id), 'claude').diff.files === 7, 15000)
      const firstSample = laneOf(heat(harness, id), 'claude')
      expect(firstSample.diff.files).toBe(7)
      expect(firstSample.error).toBeNull()

      const dotGit = readFileSync(join(firstSample.worktree!, '.git'), 'utf8').trim()
      const gitDir = dotGit.replace(/^gitdir:\s*/, '')
      const indexFile = join(gitDir, 'index')
      const savedIndex = readFileSync(indexFile)

      writeFileSync(indexFile, 'corrupt-index-bytes')
      try {
        await waitFor('sampler to report corrupt index error', () => laneOf(heat(harness, id), 'claude').error !== null, 15000)
        const brokenSample = laneOf(heat(harness, id), 'claude')
        expect(brokenSample.diff.files).toBe(7)
        expect(brokenSample.error).toMatch(/index|corrupt|signature|fatal|error/i)
      } finally {
        writeFileSync(indexFile, savedIndex)
      }

      await waitFor('sampler to clear error after index is repaired', () => laneOf(heat(harness, id), 'claude').error === null, 15000)
      const repairedSample = laneOf(heat(harness, id), 'claude')
      expect(repairedSample.diff.files).toBe(7)
      expect(repairedSample.error).toBeNull()
    } finally {
      harness.engine.cancel(id)
      await waitFor('every lane to stop', () => heat(harness, id).lanes.every((l) => l.phase === 'done'), 30000)
      await harness.engine.discard(id)
    }
  }, 60000)
})

