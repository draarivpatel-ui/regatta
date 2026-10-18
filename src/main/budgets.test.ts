import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENTS } from '../shared/agents'
import type { BudgetState } from '../shared/budgets'
import type { AgentKind } from '../shared/types'
import type { UsageSummary } from '../shared/usage'
import { BudgetGuard, normalizeCommandOutput, type BudgetDeps } from './budgets'
import type { RunHandle, RunOptions, RunResult } from './heats/runner'

const NOW = Date.parse('2026-06-15T14:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

function emptySummary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    agents: [],
    limits: [],
    checkedAt: NOW,
    ...overrides
  }
}

function makeOpts(agent: AgentKind = 'claude', overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    agent,
    command: 'echo',
    baseArgs: [],
    prompt: 'test',
    cwd: '/tmp',
    env: {},
    allowCommands: false,
    onActivity: () => undefined,
    onTokens: () => undefined,
    ...overrides
  }
}

describe('BudgetGuard', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'regatta-budgets-test-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  function makeGuard(overrides: Partial<BudgetDeps> = {}): {
    guard: BudgetGuard
    emitted: BudgetState[][]
    usageCalls: () => number
  } {
    let calls = 0
    const emitted: BudgetState[][] = []
    const guard = new BudgetGuard({
      dataDir,
      usage: async () => {
        calls += 1
        return emptySummary()
      },
      agentName: (agent) => AGENTS[agent]?.name ?? agent,
      emit: (s) => emitted.push(s),
      now: () => NOW,
      ...overrides
    })
    return { guard, emitted, usageCalls: () => calls }
  }

  it('saves and loads daily budgets atomically, off by default', async () => {
    const { guard } = makeGuard()
    expect(guard.prefs()).toEqual({ daily: {} })

    expect(guard.set('claude', 5000)).toEqual({ daily: { claude: 5000 } })
    expect(guard.set('codex', 2000)).toEqual({ daily: { claude: 5000, codex: 2000 } })

    const raw = JSON.parse(await readFile(join(dataDir, 'budgets.json'), 'utf8')) as {
      daily: Record<string, number>
    }
    expect(raw.daily).toEqual({ claude: 5000, codex: 2000 })

    // Reload from disk in a fresh instance
    const reloaded = makeGuard()
    expect(reloaded.guard.prefs()).toEqual({ daily: { claude: 5000, codex: 2000 } })

    // Clear with null
    expect(reloaded.guard.set('claude', null)).toEqual({ daily: { codex: 2000 } })
  })

  it('caches deps.usage() for 60 seconds', async () => {
    let clock = NOW
    let calls = 0
    const guard = new BudgetGuard({
      dataDir,
      usage: async () => {
        calls += 1
        return emptySummary({
          agents: [{ agent: 'claude', runs: 1, tokensToday: calls * 100, tokensMonth: 100, daily: [], reported: true }]
        })
      },
      agentName: (a) => AGENTS[a]?.name ?? a,
      emit: () => undefined,
      now: () => clock
    })
    guard.set('claude', 1000)

    const s1 = await guard.states()
    expect(s1[0]?.usedToday).toBe(100)
    const callsAfterFirst = calls

    clock += 30_000
    const s2 = await guard.states()
    expect(s2[0]?.usedToday).toBe(100)
    expect(calls).toBe(callsAfterFirst)

    clock += 31_000
    const s3 = await guard.states()
    expect(s3[0]?.usedToday).toBe(calls * 100)
    expect(calls).toBe(callsAfterFirst + 1)
  })

  it('computes ok, near (from 80%), and over states and emits when level changes', async () => {
    let tokensToday = 500
    let clock = NOW
    const emitted: BudgetState[][] = []
    const guard = new BudgetGuard({
      dataDir,
      usage: async () =>
        emptySummary({
          agents: [{ agent: 'claude', runs: 1, tokensToday, tokensMonth: tokensToday, daily: [], reported: true }]
        }),
      agentName: (a) => AGENTS[a]?.name ?? a,
      emit: (s) => emitted.push(s),
      now: () => clock
    })

    guard.set('claude', 1000)
    await new Promise((r) => setTimeout(r, 10))
    emitted.length = 0

    const okStates = await guard.states()
    expect(okStates).toEqual([
      { agent: 'claude', budget: 1000, usedToday: 500, level: 'ok' }
    ])
    expect(emitted).toHaveLength(0)

    // Advance past cache to 800 tokens (80% -> near)
    clock += 61_000
    tokensToday = 800
    const nearStates = await guard.states()
    expect(nearStates[0]?.level).toBe('near')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.[0]?.level).toBe('near')

    // Calling again at 850 (still near) does not emit again
    clock += 61_000
    tokensToday = 850
    await guard.states()
    expect(emitted).toHaveLength(1)

    // Advance to 1001 tokens (> 100% -> over)
    clock += 61_000
    tokensToday = 1001
    const overStates = await guard.states()
    expect(overStates[0]?.level).toBe('over')
    expect(emitted).toHaveLength(2)
    expect(emitted[1]?.[0]?.level).toBe('over')
  })

  it('adds headless ledger tokens for Claude and Fake, but not for Codex, and prunes entries older than 14 days', async () => {
    const oldDay = new Date(NOW - 20 * DAY_MS).toISOString().slice(0, 10)
    await writeFile(
      join(dataDir, 'budgets.json'),
      JSON.stringify({
        daily: { claude: 5000, codex: 5000, fake: 5000 },
        ledger: { [oldDay]: { claude: 9999 } }
      }),
      'utf8'
    )

    const { guard } = makeGuard({
      usage: async () =>
        emptySummary({
          agents: [
            { agent: 'claude', runs: 1, tokensToday: 1000, tokensMonth: 1000, daily: [], reported: true },
            { agent: 'codex', runs: 1, tokensToday: 2000, tokensMonth: 2000, daily: [], reported: true }
          ]
        })
    })

    const wrapped = guard.wrap((opts) => ({
      done: Promise.resolve({
        exitCode: 0,
        durationMs: 50,
        tokens: opts.agent === 'claude' ? 400 : opts.agent === 'codex' ? 600 : 300,
        stopped: false
      }),
      stop: () => undefined
    }))

    await wrapped(makeOpts('claude')).done
    await wrapped(makeOpts('codex')).done
    await wrapped(makeOpts('fake')).done

    const states = await guard.states()
    const claudeState = states.find((s) => s.agent === 'claude')
    const codexState = states.find((s) => s.agent === 'codex')
    const fakeState = states.find((s) => s.agent === 'fake')

    // Claude gets usage (1000) + ledger (400) = 1400
    expect(claudeState?.usedToday).toBe(1400)
    // Codex gets usage (2000) only, ledger not added
    expect(codexState?.usedToday).toBe(2000)
    // Fake gets ledger (300)
    expect(fakeState?.usedToday).toBe(300)

    const saved = JSON.parse(await readFile(join(dataDir, 'budgets.json'), 'utf8')) as {
      ledger: Record<string, unknown>
    }
    expect(saved.ledger[oldDay]).toBeUndefined()
  })

  it('refuses to start a run when the agent is already past its daily budget', async () => {
    const { guard } = makeGuard({
      usage: async () =>
        emptySummary({
          agents: [{ agent: 'claude', runs: 1, tokensToday: 1500, tokensMonth: 1500, daily: [], reported: true }]
        })
    })
    guard.set('claude', 1000)

    const runSpy = vi.fn()
    const wrapped = guard.wrap(runSpy)
    const activities: string[] = []

    const handle = wrapped(
      makeOpts('claude', {
        onActivity: (line) => activities.push(line)
      })
    )
    const result = await handle.done

    expect(runSpy).not.toHaveBeenCalled()
    const expectedLine = 'Not started: Claude Code is past its daily budget (1500 of 1000 tokens).'
    expect(activities).toEqual([expectedLine])
    expect(result).toEqual({
      exitCode: null,
      durationMs: 0,
      tokens: null,
      stopped: true,
      refused: expectedLine
    })
  })

  it('stops a running agent when its reported tokens push it past its daily budget and drops later activity', async () => {
    const { guard } = makeGuard({
      usage: async () =>
        emptySummary({
          agents: [{ agent: 'claude', runs: 1, tokensToday: 700, tokensMonth: 700, daily: [], reported: true }]
        })
    })
    guard.set('claude', 1000)

    let resolveRun!: (res: RunResult) => void
    let stopped = false

    const wrapped = guard.wrap((opts) => {
      queueMicrotask(() => {
        opts.onActivity('Working on step 1')
        opts.onTokens(200) // 700 + 200 = 900 <= 1000 (ok)
        opts.onActivity('Working on step 2')
        opts.onTokens(400) // 700 + 400 = 1100 > 1000 (over!)
        opts.onActivity('Trailing line from dying agent that must be dropped')
      })
      return {
        done: new Promise<RunResult>((r) => {
          resolveRun = r
        }),
        stop: () => {
          stopped = true
          resolveRun({ exitCode: 143, durationMs: 120, tokens: 400, stopped: true })
        }
      } satisfies RunHandle
    })

    const activities: string[] = []
    const result = await wrapped(
      makeOpts('claude', {
        onActivity: (line) => activities.push(line)
      })
    ).done

    expect(stopped).toBe(true)
    const expectedStop = 'Stopped: Claude Code passed its daily budget (1100 of 1000 tokens).'
    expect(activities).toEqual(['Working on step 1', 'Working on step 2', expectedStop])
    expect(result.stopped).toBe(true)
    expect(result.refused).toBe(expectedStop)

    // Final tokens (400) were recorded in ledger
    const states = await guard.states()
    expect(states[0]?.usedToday).toBe(1100)
  })

  it('stops a run when the same failing command fails the same way 3 times in a row, ignoring durations', async () => {
    const { guard } = makeGuard()
    const base25 = Array.from({ length: 25 }, (_, i) => `failure line ${i + 1}`).join('\n')
    let stopCalled = false
    const wrappedLoop = guard.wrap((opts) => {
      queueMicrotask(() => {
        opts.onActivity('Starting tests')
        opts.onCommand?.({ command: 'npm test', failed: true, output: `${base25}\nRan in 0.84s` })
        opts.onCommand?.({ command: 'npm test', failed: true, output: `${base25}\nRan in 0.91s` })
        opts.onCommand?.({ command: 'npm test', failed: true, output: `${base25}\nRan in 120ms` })
        opts.onActivity('After stop line dropped')
      })
      return {
        done: new Promise<RunResult>((resolve) => {
          setTimeout(() => resolve({ exitCode: 1, durationMs: 80, tokens: 250, stopped: stopCalled }), 10)
        }),
        stop: () => {
          stopCalled = true
        }
      }
    })

    const activities: string[] = []
    const res = await wrappedLoop(makeOpts('fake', { onActivity: (l) => activities.push(l) })).done
    expect(stopCalled).toBe(true)
    expect(activities).toEqual(['Starting tests', 'Stopped: `npm test` failed the same way 3 times.'])
    expect(res.stopped).toBe(true)
    expect(res.refused).toBeDefined()
    const refusedLines = res.refused!.split('\n')
    expect(refusedLines[0]).toBe('Stopped: `npm test` failed the same way 3 times.')
    // Headline + last 20 lines of output = 21 lines total
    expect(refusedLines).toHaveLength(21)
    expect(refusedLines[1]).toBe('failure line 7')
    expect(refusedLines[20]).toBe('Ran in 120ms')
  })

  it('resets the loop guard streak on a successful command or a different failure', async () => {
    const { guard } = makeGuard()
    let stopCalled = false

    const wrapped = guard.wrap((opts) => {
      queueMicrotask(() => {
        // 2 identical failures
        opts.onCommand?.({ command: 'npm test', failed: true, output: 'err A in 10ms' })
        opts.onCommand?.({ command: 'npm test', failed: true, output: 'err A in 20ms' })
        // 1 success resets streak
        opts.onCommand?.({ command: 'npm test', failed: false, output: 'ok' })
        // 2 more identical failures
        opts.onCommand?.({ command: 'npm test', failed: true, output: 'err A in 30ms' })
        opts.onCommand?.({ command: 'npm test', failed: true, output: 'err A in 40ms' })
        // 1 different failure output resets streak
        opts.onCommand?.({ command: 'npm test', failed: true, output: 'err B in 50ms' })
        // 2 more of err A
        opts.onCommand?.({ command: 'npm test', failed: true, output: 'err A in 60ms' })
        opts.onCommand?.({ command: 'npm test', failed: true, output: 'err A in 70ms' })
      })
      return {
        done: new Promise<RunResult>((resolve) => {
          setTimeout(() => resolve({ exitCode: 0, durationMs: 30, tokens: 50, stopped: stopCalled }), 10)
        }),
        stop: () => {
          stopCalled = true
        }
      }
    })

    const res = await wrapped(makeOpts('fake')).done
    expect(stopCalled).toBe(false)
    expect(res.refused).toBeUndefined()
  })

  it('normalizes durations and timestamps out of command output', () => {
    const a = normalizeCommandOutput('  3 failing tests in 0.84s (12ms) at 2026-06-15T14:22:01.123Z  ')
    const b = normalizeCommandOutput('3   failing tests in 1.92s (450ms) at 2026-06-15T14:22:09.999Z')
    expect(a).toBe(b)
  })
})
