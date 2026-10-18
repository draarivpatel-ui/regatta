// The flow engine against a real git repository, with a fake agent that writes files.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AGENTS } from '../../shared/agents'
import type { Flow, FlowRun, FlowStep } from '../../shared/flows'
import type { AgentKind, DetectedAgent } from '../../shared/types'
import { FlowEngine } from './engine'
import type { RunHandle, RunOptions, RunResult } from '../heats/runner'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']
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

/** What the fake agent does, and how long it takes. */
interface Scenario {
  delayMs: number
  exitCode?: number
  write?: (cwd: string) => void
}

function writeDone(cwd: string): void {
  writeFileSync(join(cwd, 'DONE.txt'), 'done\n')
}

const SCENARIOS: Record<string, Scenario> = {
  writer: { delayMs: 60, write: writeDone },
  slow: { delayMs: 30000, write: writeDone },
  fail: { delayMs: 60, exitCode: 3, write: writeDone },
  quiet: { delayMs: 60 }
}

interface Harness {
  engine: FlowEngine
  repo: string
  dataDir: string
  worktrees: string
  /** Agents whose run was stopped by the engine. */
  stopped: AgentKind[]
  /** Every run the engine started, with the prompt and folder it used. */
  runs: RunOptions[]
  /** Every run state the engine emitted. */
  emitted: FlowRun[]
}

function makeHarness(kinds: AgentKind[], plan: Partial<Record<AgentKind, Scenario>>): Harness {
  const repo = temp('regatta-flow-run-')
  sh(['init', '-b', 'main'], repo)
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
  sh(['add', '.'], repo)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], repo)
  const dataDir = temp('regatta-flow-data-')
  const worktrees = temp('regatta-flow-wt-')

  const seen: Omit<Harness, 'engine'> = { repo, dataDir, worktrees, stopped: [], runs: [], emitted: [] }
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
    opts.onActivity(`${opts.agent} is working`)
    appendFileSync(join(opts.cwd, 'PROMPT.txt'), `=== ${opts.agent} ===\n${opts.prompt}\n`)
    const clock = setTimeout(() => {
      scenario.write?.(opts.cwd)
      finish({ exitCode: scenario.exitCode ?? 0, durationMs: Date.now() - started, tokens: null, stopped: false })
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
  const engine = new FlowEngine({
    dataDir,
    root: () => repo,
    env: () => ENV,
    agents: () => detectedAgents(kinds),
    run,
    emitFlows: () => undefined,
    emitRun: (run) => seen.emitted.push(run),
    worktreesDir: () => worktrees
  })
  return { ...seen, engine }
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

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: '',
    name: 'Ship it',
    brief: 'a brief note',
    trigger: 'manual',
    isolate: false,
    steps: [
      { id: 's1', kind: 'agent', title: 'Plan it', agent: 'claude', prompt: 'Plan {{brief}}', command: '' },
      { id: 's2', kind: 'check', title: 'Check it', agent: null, prompt: '', command: 'test -f DONE.txt' },
      { id: 's3', kind: 'approval', title: 'Approve it', agent: null, prompt: '', command: '' }
    ],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function agentStep(id: string, prompt: string): FlowStep {
  return { id, kind: 'agent', title: 'Plan it', agent: 'claude', prompt, command: '' }
}

function checkStep(id: string, command: string): FlowStep {
  return { id, kind: 'check', title: 'Check it', agent: null, prompt: '', command }
}

const approvalStep = { id: 's3', kind: 'approval' as const, title: 'Approve it', agent: null, prompt: '', command: '' }

/** A harness with one fast writing agent. Every test gets its own, so no state leaks between them. */
function writerHarness(): Harness {
  return makeHarness(['claude'], { claude: SCENARIOS['writer']! })
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 60000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function runOf(harness: Harness, id: string): FlowRun {
  const found = harness.engine.runs().find((r) => r.id === id)
  if (!found) throw new Error(`Run ${id} is not in the list`)
  return found
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('a run', () => {
  it('waits at the approval step and finishes once approved', async () => {
    const harness = writerHarness()
    const flow = harness.engine.save(makeFlow())
    const started = await harness.engine.run(flow.id)
    expect(started.status).toBe('running')
    expect(started.steps.map((s) => s.status)).toEqual(['pending', 'pending', 'pending'])

    await waitFor('the run to wait at the approval', () => runOf(harness, started.id).status === 'waiting')
    let run = runOf(harness, started.id)
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'done', 'waiting'])
    expect(run.steps[0]?.output).toBe('claude is working')
    expect(run.steps[1]?.exitCode).toBe(0)

    harness.engine.approve(started.id)
    await waitFor('the run to finish', () => runOf(harness, started.id).status === 'done')
    run = runOf(harness, started.id)
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'done', 'done'])
    expect(run.steps[2]?.output).toBe('Approved')
    expect(run.endedAt).not.toBeNull()
    expect(harness.emitted.at(-1)?.status).toBe('done')
  })

  it('runs the agent headless in the run folder without commands', async () => {
    const harness = writerHarness()
    const flow = harness.engine.save(makeFlow())
    const started = await harness.engine.run(flow.id)
    await waitFor('the run to wait', () => runOf(harness, started.id).status === 'waiting')
    expect(harness.runs).toHaveLength(1)
    const opts = harness.runs[0]!
    expect(opts.agent).toBe('claude')
    expect(opts.command).toBe('/usr/bin/claude')
    expect(opts.baseArgs).toEqual(AGENTS.claude.args)
    expect(opts.prompt).toBe('Plan a brief note')
    expect(opts.cwd).toBe(harness.repo)
    expect(opts.env).toEqual(ENV)
    expect(opts.allowCommands).toBe(false)
    harness.engine.stop(started.id)
  })

  it('hands the previous step output to the next step prompt', async () => {
    const harness = writerHarness()
    const flow = harness.engine.save(
      makeFlow({ steps: [agentStep('s1', 'Plan {{brief}}'), agentStep('s2', 'Previous said:\n{{previous}}'), checkStep('s3', 'test -f DONE.txt')] })
    )
    const started = await harness.engine.run(flow.id)
    await waitFor('the run to finish', () => runOf(harness, started.id).status === 'done')
    const prompts = readFileSync(join(harness.repo, 'PROMPT.txt'), 'utf8').split('=== claude ===\n')
    expect(prompts[1]).toBe('Plan a brief note\n')
    expect(prompts[2]).toBe('Previous said:\nclaude is working\n')
  })

  it('emits the run as it changes and always ends on the final state', async () => {
    const harness = writerHarness()
    const flow = harness.engine.save(makeFlow())
    const started = await harness.engine.run(flow.id)
    await waitFor('the run to wait', () => runOf(harness, started.id).status === 'waiting')
    // Let one throttle window pass so the waiting state reaches the listener.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const states = harness.emitted.filter((r) => r.id === started.id)
    expect(states.length).toBeGreaterThanOrEqual(2)
    expect(states[0]?.status).toBe('running')
    expect(states.some((r) => r.status === 'waiting')).toBe(true)
    harness.engine.approve(started.id)
    await waitFor('the run to finish', () => runOf(harness, started.id).status === 'done')
    const after = harness.emitted.filter((r) => r.id === started.id)
    expect(after.at(-1)?.status).toBe('done')
  })
})

describe('a failing step', () => {
  const harness = makeHarness(['claude'], { claude: SCENARIOS['writer']! })

  it('fails the run and skips the rest when a check fails', async () => {
    const flow = harness.engine.save(makeFlow({ steps: [agentStep('s1', 'Plan'), checkStep('s2', 'test -f MISSING.txt'), approvalStep] }))
    const started = await harness.engine.run(flow.id)
    await waitFor('the run to fail', () => runOf(harness, started.id).status === 'failed')
    const run = runOf(harness, started.id)
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'failed', 'skipped'])
    expect(run.steps[1]?.exitCode).not.toBe(0)
    expect(run.endedAt).not.toBeNull()
    expect(harness.emitted.at(-1)?.status).toBe('failed')
  })

  it('fails the run when the agent exits non zero', async () => {
    const failing = makeHarness(['claude'], { claude: SCENARIOS['fail']! })
    const flow = failing.engine.save(makeFlow({ steps: [agentStep('s1', 'Plan'), checkStep('s2', 'test -f DONE.txt')] }))
    const started = await failing.engine.run(flow.id)
    await waitFor('the run to fail', () => runOf(failing, started.id).status === 'failed')
    const run = runOf(failing, started.id)
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'skipped'])
    expect(run.steps[0]?.exitCode).toBe(3)
  })
})

describe('stopping', () => {
  it('stops the running agent and skips the rest', async () => {
    const harness = makeHarness(['claude'], { claude: SCENARIOS['slow']! })
    const flow = harness.engine.save(makeFlow())
    const started = await harness.engine.run(flow.id)
    await waitFor('the agent step to run', () => runOf(harness, started.id).steps[0]?.status === 'running')
    harness.engine.stop(started.id)
    await waitFor('the run to stop', () => runOf(harness, started.id).status === 'stopped')
    expect(harness.stopped).toEqual(['claude'])
    const run = runOf(harness, started.id)
    expect(run.steps.map((s) => s.status)).toEqual(['skipped', 'skipped', 'skipped'])
    expect(run.endedAt).not.toBeNull()
    expect(harness.emitted.at(-1)?.status).toBe('stopped')
  })

  it('stops a run that is waiting at an approval', async () => {
    const harness = makeHarness(['claude'], { claude: SCENARIOS['writer']! })
    const flow = harness.engine.save(makeFlow())
    const started = await harness.engine.run(flow.id)
    await waitFor('the run to wait', () => runOf(harness, started.id).status === 'waiting')
    harness.engine.stop(started.id)
    await waitFor('the run to stop', () => runOf(harness, started.id).status === 'stopped')
    expect(runOf(harness, started.id).steps.map((s) => s.status)).toEqual(['done', 'done', 'skipped'])
  })

  it('stops a running check', async () => {
    const harness = makeHarness(['claude'], { claude: SCENARIOS['quiet']! })
    const flow = harness.engine.save(makeFlow({ steps: [checkStep('s1', 'sleep 30'), approvalStep] }))
    const started = await harness.engine.run(flow.id)
    await waitFor('the check to run', () => runOf(harness, started.id).steps[0]?.status === 'running')
    harness.engine.stop(started.id)
    await waitFor('the run to stop', () => runOf(harness, started.id).status === 'stopped')
    expect(harness.emitted.at(-1)?.status).toBe('stopped')
  })
})

describe('an isolated run', () => {
  it('leaves the root untouched until merge, then brings the change home', async () => {
    const harness = writerHarness()
    const flow = harness.engine.save(makeFlow({ isolate: true, steps: [agentStep('s1', 'Plan'), checkStep('s2', 'test -f DONE.txt')] }))
    const started = await harness.engine.run(flow.id)
    await waitFor('the run to finish', () => runOf(harness, started.id).status === 'done')
    let run = runOf(harness, started.id)
    expect(run.worktree).toBe(join(harness.worktrees, `flow-${run.id}`))
    expect(run.branch).toBe(`regatta/flow-${run.id}`)

    expect(existsSync(join(harness.repo, 'DONE.txt'))).toBe(false)
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], run.worktree!).trim()).toBe(run.branch)

    const result = await harness.engine.merge(run.id)
    expect(result.merged).toBe(true)
    expect(result.summary).toMatch(/^Fast-forwarded main by 1 commit \(\+3 -0 in 2 files\)\./)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(result.summary).toContain("Moved its worktree to Regatta's trash")

    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(sh(['log', '-1', '--format=%an <%ae>|%s'], harness.repo).trim()).toBe(
      `Regatta <regatta@localhost>|Flow run ${run.id}: Ship it`
    )
    expect(existsSync(run.worktree!)).toBe(false)
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(2)
    expect(sh(['branch', '--list', 'regatta/flow-*'], harness.repo).trim()).toContain(run.branch!)

    run = runOf(harness, started.id)
    expect(run.mergeSummary).toBe(result.summary)
    expect(run.worktree).toBeNull()
    expect(run.branch).toBeNull()
  }, 60000)

  it('refuses to merge a run into a folder that has changes of its own', async () => {
    const harness = writerHarness()
    const flow = harness.engine.save(makeFlow({ isolate: true, steps: [agentStep('s1', 'Plan'), checkStep('s2', 'test -f DONE.txt')] }))
    const started = await harness.engine.run(flow.id)
    await waitFor('the run to finish', () => runOf(harness, started.id).status === 'done')
    writeFileSync(join(harness.repo, 'src', 'app.js'), 'export const app = 2\n')
    await expect(harness.engine.merge(started.id)).rejects.toThrow(
      'Commit or stash your changes first. Merging needs a clean folder.'
    )
    expect(existsSync(join(harness.repo, 'DONE.txt'))).toBe(false)
    writeFileSync(join(harness.repo, 'src', 'app.js'), 'export const app = 1\n')
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
  }, 60000)

  it('refuses to merge a run that is not isolated or not finished', async () => {
    const harness = writerHarness()
    const plain = harness.engine.save(makeFlow({ steps: [agentStep('s1', 'Plan'), checkStep('s2', 'test -f DONE.txt')] }))
    const plainRun = await harness.engine.run(plain.id)
    await waitFor('the plain run to finish', () => runOf(harness, plainRun.id).status === 'done')
    await expect(harness.engine.merge(plainRun.id)).rejects.toThrow('Only isolated runs can be merged.')

    const waiting = harness.engine.save(makeFlow({ isolate: true }))
    const waitingRun = await harness.engine.run(waiting.id)
    await waitFor('the run to wait', () => runOf(harness, waitingRun.id).status === 'waiting')
    await expect(harness.engine.merge(waitingRun.id)).rejects.toThrow('Only a finished run can be merged.')
    await expect(harness.engine.merge('nosuchrun')).rejects.toThrow('That run is no longer here.')
    harness.engine.stop(waitingRun.id)
  }, 60000)

  it('moves the worktree of a finished run to the trash on discard', async () => {
    const harness = writerHarness()
    const flow = harness.engine.save(makeFlow({ isolate: true, steps: [agentStep('s1', 'Plan'), checkStep('s2', 'test -f DONE.txt')] }))
    const started = await harness.engine.run(flow.id)
    await waitFor('the run to finish', () => runOf(harness, started.id).status === 'done')
    const worktree = runOf(harness, started.id).worktree!
    await harness.engine.discard(started.id)
    expect(existsSync(worktree)).toBe(false)
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(2)
    expect(sh(['branch', '--list', 'regatta/flow-*'], harness.repo).trim()).toContain(`regatta/flow-${started.id}`)
    expect(existsSync(join(harness.repo, 'DONE.txt'))).toBe(false)
    expect(runOf(harness, started.id).worktree).toBeNull()
  }, 60000)

  it('discards a run that is still running', async () => {
    const harness = makeHarness(['claude'], { claude: SCENARIOS['slow']! })
    const flow = harness.engine.save(makeFlow({ isolate: true }))
    const started = await harness.engine.run(flow.id)
    await waitFor('the run to run', () => runOf(harness, started.id).status === 'running')
    const worktree = runOf(harness, started.id).worktree!
    await harness.engine.discard(started.id)
    await waitFor('the run to stop', () => runOf(harness, started.id).status === 'stopped')
    expect(existsSync(worktree)).toBe(false)
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    expect(sh(['branch', '--list', 'regatta/flow-*'], harness.repo).trim()).toContain(`regatta/flow-${started.id}`)
  }, 60000)

  it('needs a git repository with a commit', async () => {
    const engine = new FlowEngine({
      dataDir: temp('regatta-flow-data-'),
      root: () => temp('regatta-flow-plain-'),
      env: () => ENV,
      agents: () => detectedAgents(['claude']),
      run: () => {
        throw new Error('nothing runs when the request is refused')
      },
      emitFlows: () => undefined,
      emitRun: () => undefined,
      worktreesDir: () => temp('regatta-flow-wt-')
    })
    const flow = engine.save(makeFlow({ isolate: true }))
    await expect(engine.run(flow.id)).rejects.toThrow('Isolated runs need a git repository with at least one commit.')
  }, 60000)
})

describe('reloading', () => {
  it('loads flows and runs from the data folder', async () => {
    const harness = makeHarness(['claude'], { claude: SCENARIOS['writer']! })
    const flow = harness.engine.save(makeFlow({ steps: [agentStep('s1', 'Plan'), checkStep('s2', 'test -f DONE.txt')] }))
    const started = await harness.engine.run(flow.id)
    await waitFor('the run to finish', () => runOf(harness, started.id).status === 'done')

    const fresh = new FlowEngine({
      dataDir: harness.dataDir,
      root: () => harness.repo,
      env: () => ENV,
      agents: () => detectedAgents(['claude']),
      run: () => {
        throw new Error('nothing runs after a reload')
      },
      emitFlows: () => undefined,
      emitRun: () => undefined,
      worktreesDir: () => harness.worktrees
    })
    expect(fresh.list().map((f) => f.id)).toEqual([flow.id])
    expect(fresh.list()[0]?.name).toBe('Ship it')
    expect(fresh.runs().map((r) => r.id)).toEqual([started.id])
    expect(fresh.runs()[0]?.status).toBe('done')

    const savedFlow = JSON.parse(readFileSync(join(harness.dataDir, 'flows.json'), 'utf8')) as Flow[]
    expect(savedFlow.map((f) => f.id)).toEqual([flow.id])
    const savedRun = JSON.parse(readFileSync(join(harness.dataDir, 'flow-runs', `${started.id}.json`), 'utf8')) as FlowRun
    expect(savedRun.status).toBe('done')
    expect(savedRun.steps.map((s) => s.status)).toEqual(['done', 'done'])
  })

  it('loads a run that was live when the app quit as stopped', async () => {
    const running = makeHarness(['claude'], { claude: SCENARIOS['slow']! })
    const liveFlow = running.engine.save(makeFlow())
    const liveRun = await running.engine.run(liveFlow.id)
    await waitFor('the run to run', () => runOf(running, liveRun.id).status === 'running')

    const waiting = makeHarness(['claude'], { claude: SCENARIOS['writer']! })
    const waitFlow = waiting.engine.save(makeFlow())
    const waitRun = await waiting.engine.run(waitFlow.id)
    await waitFor('the run to wait', () => runOf(waiting, waitRun.id).status === 'waiting')

    for (const [name, h, id] of [
      ['running', running, liveRun.id],
      ['waiting', waiting, waitRun.id]
    ] as const) {
      const revived = new FlowEngine({
        dataDir: h.dataDir,
        root: () => h.repo,
        env: () => ENV,
        agents: () => detectedAgents(['claude']),
        run: () => {
          throw new Error('nothing runs after a reload')
        },
        emitFlows: () => undefined,
        emitRun: () => undefined,
        worktreesDir: () => h.worktrees
      })
      const loaded = revived.runs().find((r) => r.id === id)
      expect(loaded?.status, name).toBe('stopped')
      expect(loaded?.steps.every((s) => s.status !== 'running' && s.status !== 'waiting'), name).toBe(true)
      const onDisk = JSON.parse(readFileSync(join(h.dataDir, 'flow-runs', `${id}.json`), 'utf8')) as FlowRun
      expect(onDisk.status, `${name} on disk`).toBe('stopped')
    }
  })

  it('keeps the newest 50 runs', async () => {
    const harness = makeHarness(['claude'], { claude: SCENARIOS['writer']! })
    const flow = harness.engine.save(makeFlow({ steps: [] }))
    const first = await harness.engine.run(flow.id)
    for (let i = 0; i < 50; i++) await harness.engine.run(flow.id)
    await waitFor('the runs to settle', () => harness.engine.runs().length === 50)
    expect(harness.engine.runs().map((r) => r.id)).not.toContain(first.id)
    expect(readdirSync(join(harness.dataDir, 'flow-runs'))).toHaveLength(50)
    expect(existsSync(join(harness.dataDir, 'flow-runs', `${first.id}.json`))).toBe(false)
  })
})

describe('validation', () => {
  const harness = makeHarness(['claude'], { claude: SCENARIOS['writer']! })

  it('needs a name', () => {
    expect(() => harness.engine.save(makeFlow({ name: '   ' }))).toThrow('A flow needs a name.')
  })

  it('allows at most 16 steps', () => {
    const steps = Array.from({ length: 17 }, (_, i) => checkStep(`s${i}`, 'true'))
    expect(() => harness.engine.save(makeFlow({ steps }))).toThrow('A flow has at most 16 steps.')
    const max = Array.from({ length: 16 }, (_, i) => checkStep(`s${i}`, 'true'))
    expect(() => harness.engine.save(makeFlow({ steps: max }))).not.toThrow()
  })

  it('needs an agent and a prompt on agent steps', () => {
    const noAgent: FlowStep = { id: 's1', kind: 'agent', title: 'Plan it', agent: null, prompt: 'Plan', command: '' }
    const noPrompt: FlowStep = { id: 's1', kind: 'agent', title: 'Plan it', agent: 'claude', prompt: '  ', command: '' }
    expect(() => harness.engine.save(makeFlow({ steps: [noAgent] }))).toThrow('Every agent step needs an agent and a prompt.')
    expect(() => harness.engine.save(makeFlow({ steps: [noPrompt] }))).toThrow('Every agent step needs an agent and a prompt.')
  })

  it('needs a command on check steps', () => {
    expect(() => harness.engine.save(makeFlow({ steps: [checkStep('s1', '  ')] }))).toThrow('Every check step needs a command.')
  })

  it('keeps the id and createdAt when a flow is saved again', () => {
    const first = harness.engine.save(makeFlow())
    const again = harness.engine.save({ ...first, name: 'Renamed' })
    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(first.createdAt)
    expect(again.name).toBe('Renamed')
    expect(again.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    expect(harness.engine.list().filter((f) => f.id === first.id)).toHaveLength(1)
  })

  it('refuses an agent that is not installed', async () => {
    const engine = new FlowEngine({
      dataDir: temp('regatta-flow-data-'),
      root: () => harness.repo,
      env: () => ENV,
      agents: () => [],
      run: () => {
        throw new Error('nothing runs when the request is refused')
      },
      emitFlows: () => undefined,
      emitRun: () => undefined,
      worktreesDir: () => temp('regatta-flow-wt-')
    })
    const flow = engine.save(makeFlow())
    await expect(engine.run(flow.id)).rejects.toThrow('Not installed: Claude Code.')
  })

  it('refuses a flow that is gone', async () => {
    await expect(harness.engine.run('nosuchflow')).rejects.toThrow('That flow is no longer here.')
  })
})
