// Unit tests for ScheduleEngine: validation, timing, runs and persistence.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextRunAfter } from '../shared/schedules'
import type { NewSchedule } from '../shared/schedules'
import { ScheduleEngine } from './schedules'

const cleanup: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-schedules-'))
  cleanup.push(dir)
  return join(dir, 'data')
}

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

interface EngineHarness {
  engine: ScheduleEngine
  emitted: number
  crewCalls: Array<{ teammateId: string; prompt: string }>
  flowCalls: string[]
  failCrewWith: (err: Error | null) => void
  failFlowWith: (err: Error | null) => void
  setNow: (value: number) => void
  now: () => number
}

function harness(dataDir: string, startNow = 1_700_000_000_000): EngineHarness {
  let nowValue = startNow
  let crewError: Error | null = null
  let flowError: Error | null = null
  const crewCalls: Array<{ teammateId: string; prompt: string }> = []
  const flowCalls: string[] = []
  let emitted = 0
  const engine = new ScheduleEngine({
    dataDir,
    now: () => nowValue,
    runCrew: async (teammateId, prompt) => {
      crewCalls.push({ teammateId, prompt })
      if (crewError) throw crewError
      return { conversationId: `conv-${crewCalls.length}` }
    },
    runFlow: async (flowId) => {
      flowCalls.push(flowId)
      if (flowError) throw flowError
      return { flowRunId: `flowrun-${flowCalls.length}` }
    },
    emit: () => {
      emitted += 1
    }
  })
  return {
    engine,
    emitted: 0,
    crewCalls,
    flowCalls,
    failCrewWith: (err) => {
      crewError = err
    },
    failFlowWith: (err) => {
      flowError = err
    },
    setNow: (value) => {
      nowValue = value
    },
    now: () => nowValue
  }
}

function crewSchedule(overrides: Partial<NewSchedule> = {}): NewSchedule {
  return {
    name: 'Daily check',
    target: { kind: 'crew', teammateId: 'mate-1', prompt: 'Check the open issues' },
    every: { kind: 'daily', time: '09:30' },
    enabled: true,
    ...overrides
  }
}

const flush = async (ms = 20): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

let engines: ScheduleEngine[] = []
afterEach(() => {
  for (const e of engines) e.stop()
  engines = []
  vi.useRealTimers()
})

function track(engine: ScheduleEngine): ScheduleEngine {
  engines.push(engine)
  return engine
}

describe('validation', () => {
  it('rejects a missing or long name', () => {
    const h = harness(tempDir())
    expect(() => h.engine.save(crewSchedule({ name: '' }))).toThrow()
    expect(() => h.engine.save(crewSchedule({ name: '   ' }))).toThrow()
    expect(() => h.engine.save(crewSchedule({ name: 'x'.repeat(61) }))).toThrow()
  })

  it('rejects crew schedules without a teammate or prompt', () => {
    const h = harness(tempDir())
    expect(() => h.engine.save(crewSchedule({ target: { kind: 'crew', teammateId: '', prompt: 'hi' } }))).toThrow()
    expect(() => h.engine.save(crewSchedule({ target: { kind: 'crew', teammateId: 'm', prompt: '' } }))).toThrow()
    expect(() =>
      h.engine.save(crewSchedule({ target: { kind: 'crew', teammateId: 'm', prompt: 'x'.repeat(4001) } }))
    ).toThrow()
  })

  it('rejects flow schedules without a flow', () => {
    const h = harness(tempDir())
    expect(() => h.engine.save({ name: 'F', target: { kind: 'flow', flowId: '' }, every: { kind: 'daily', time: '09:30' }, enabled: true })).toThrow()
  })

  it('rejects a bad cadence with the shared message', () => {
    const h = harness(tempDir())
    expect(() => h.engine.save(crewSchedule({ every: { kind: 'hours', hours: 0 } }))).toThrow('Pick 1 to 24 hours.')
    expect(() => h.engine.save(crewSchedule({ every: { kind: 'daily', time: 'nope' } }))).toThrow('Pick a time like 09:30.')
    expect(() => h.engine.save(crewSchedule({ every: { kind: 'weekly', day: 9, time: '09:30' } }))).toThrow('Pick a day of the week.')
  })

  it('gives new schedules an 8 character id', () => {
    const h = harness(tempDir())
    const list = h.engine.save(crewSchedule())
    expect(list[0]!.id).toHaveLength(8)
  })
})

describe('next run on save', () => {
  it('sets nextRunAt from the cadence when enabled, null when off', () => {
    const now = 1_700_000_000_000
    const h = harness(tempDir(), now)
    const on = h.engine.save(crewSchedule({ every: { kind: 'hours', hours: 3 } }))
    expect(on[0]!.nextRunAt).toBe(nextRunAfter({ kind: 'hours', hours: 3 }, now))
    const off = h.engine.save(crewSchedule({ name: 'Off one', enabled: false, every: { kind: 'hours', hours: 3 } }))
    expect(off.find((s) => s.name === 'Off one')!.nextRunAt).toBeNull()
  })

  it('recomputes nextRunAt when turning on or changing the cadence', () => {
    const h = harness(tempDir(), 1_700_000_000_000)
    const created = h.engine.save(crewSchedule({ enabled: false }))
    const id = created.find((s) => s.name === 'Daily check')!.id
    expect(created.find((s) => s.id === id)!.nextRunAt).toBeNull()
    h.setNow(1_700_000_100_000)
    const turnedOn = h.engine.save({ id, name: 'Daily check', target: { kind: 'crew', teammateId: 'mate-1', prompt: 'Check the open issues' }, every: { kind: 'daily', time: '09:30' }, enabled: true })
    expect(turnedOn.find((s) => s.id === id)!.nextRunAt).toBe(nextRunAfter({ kind: 'daily', time: '09:30' }, 1_700_000_100_000))
    h.setNow(1_700_000_200_000)
    const changed = h.engine.save({ id, name: 'Daily check', target: { kind: 'crew', teammateId: 'mate-1', prompt: 'Check the open issues' }, every: { kind: 'hours', hours: 2 }, enabled: true })
    expect(changed.find((s) => s.id === id)!.nextRunAt).toBe(nextRunAfter({ kind: 'hours', hours: 2 }, 1_700_000_200_000))
  })

  it('keeps nextRunAt when only the name changes', () => {
    const h = harness(tempDir(), 1_700_000_000_000)
    const created = h.engine.save(crewSchedule())
    const id = created[0]!.id
    const before = created[0]!.nextRunAt
    h.setNow(1_700_000_050_000)
    const renamed = h.engine.save({ id, name: 'Renamed', target: { kind: 'crew', teammateId: 'mate-1', prompt: 'Check the open issues' }, every: { kind: 'daily', time: '09:30' }, enabled: true })
    expect(renamed.find((s) => s.id === id)!.nextRunAt).toBe(before)
  })

  it('clears nextRunAt when turning off', () => {
    const h = harness(tempDir())
    const created = h.engine.save(crewSchedule())
    const id = created[0]!.id
    const turnedOff = h.engine.save({ id, name: 'Daily check', target: { kind: 'crew', teammateId: 'mate-1', prompt: 'Hi' }, every: { kind: 'daily', time: '09:30' }, enabled: false })
    expect(turnedOff.find((s) => s.id === id)!.nextRunAt).toBeNull()
  })
})

describe('running', () => {
  it('runs due schedules and moves nextRunAt forward', async () => {
    const start = 1_700_000_000_000
    const h = harness(tempDir(), start)
    h.engine.save(crewSchedule({ every: { kind: 'hours', hours: 1 } }))
    expect(h.crewCalls).toHaveLength(0)
    h.setNow(start + 3_601_000)
    track(h.engine).start()
    await flush(50)
    expect(h.crewCalls).toHaveLength(1)
    expect(h.crewCalls[0]).toEqual({ teammateId: 'mate-1', prompt: 'Check the open issues' })
    const after = h.engine.list()[0]!
    expect(after.runs).toHaveLength(1)
    expect(after.runs[0]!.ok).toBe(true)
    expect(after.runs[0]!.conversationId).toBe('conv-1')
    expect(after.nextRunAt).toBe(nextRunAfter({ kind: 'hours', hours: 1 }, start + 3_601_000))
  })

  it('runs flows through runFlow', async () => {
    const start = 1_700_000_000_000
    const h = harness(tempDir(), start)
    h.engine.save({ name: 'Fix bug nightly', target: { kind: 'flow', flowId: 'flow-9' }, every: { kind: 'hours', hours: 1 }, enabled: true })
    h.setNow(start + 3_601_000)
    track(h.engine).start()
    await flush(50)
    expect(h.flowCalls).toEqual(['flow-9'])
    const after = h.engine.list()[0]!
    expect(after.runs[0]!.ok).toBe(true)
    expect(after.runs[0]!.flowRunId).toBe('flowrun-1')
  })

  it('a failing run records the error and other schedules still run', async () => {
    const start = 1_700_000_000_000
    const h = harness(tempDir(), start)
    h.failCrewWith(new Error('The agent fell over.'))
    h.engine.save(crewSchedule({ name: 'Fails', every: { kind: 'hours', hours: 1 } }))
    h.engine.save({ name: 'Flow ok', target: { kind: 'flow', flowId: 'flow-1' }, every: { kind: 'hours', hours: 1 }, enabled: true })
    h.setNow(start + 3_601_000)
    track(h.engine).start()
    await flush(80)
    const byName = Object.fromEntries(h.engine.list().map((s) => [s.name, s]))
    expect(byName['Fails']!.runs[0]!.ok).toBe(false)
    expect(byName['Fails']!.runs[0]!.note).toBe('The agent fell over.')
    expect(byName['Flow ok']!.runs[0]!.ok).toBe(true)
    expect(h.flowCalls).toHaveLength(1)
  })

  it('keeps the timer going after a failure', async () => {
    vi.useFakeTimers()
    const start = 1_700_000_000_000
    const h = harness(tempDir(), start)
    h.engine.save(crewSchedule({ every: { kind: 'hours', hours: 1 } }))
    track(h.engine).start()
    h.failCrewWith(new Error('Boom.'))
    h.setNow(start + 3_601_000)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.engine.list()[0]!.runs[0]!.ok).toBe(false)
    h.failCrewWith(null)
    h.setNow(start + 2 * 3_601_000)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(0)
    const runs = h.engine.list()[0]!.runs
    expect(runs[0]!.ok).toBe(true)
    expect(runs).toHaveLength(2)
  })

  it('a missed run catches up once at start, never more than once', async () => {
    const start = 1_700_000_000_000
    const h = harness(tempDir(), start)
    h.engine.save(crewSchedule({ every: { kind: 'daily', time: '09:30' } }))
    // Ten days later: many daily runs were missed, but only one catch-up run happens.
    h.setNow(start + 10 * 86_400_000)
    track(h.engine).start()
    await flush(50)
    expect(h.crewCalls).toHaveLength(1)
    const after = h.engine.list()[0]!
    expect(after.runs).toHaveLength(1)
    expect(after.runs[0]!.note).toBe('Caught up after Regatta was closed')
    expect(after.nextRunAt).toBe(nextRunAfter({ kind: 'daily', time: '09:30' }, start + 10 * 86_400_000))
  })

  it('runNow leaves nextRunAt alone', async () => {
    const h = harness(tempDir())
    const created = h.engine.save(crewSchedule())
    const before = created[0]!.nextRunAt
    const after = await h.engine.runNow(created[0]!.id)
    expect(h.crewCalls).toHaveLength(1)
    expect(after[0]!.nextRunAt).toBe(before)
    expect(after[0]!.runs[0]!.note).toBe('Started a conversation')
  })

  it('runNow on an unknown id throws', async () => {
    const h = harness(tempDir())
    await expect(h.engine.runNow('missing-id')).rejects.toThrow()
  })

  it('never runs the same schedule twice at the same time', async () => {
    const start = 1_700_000_000_000
    let release: (() => void) | null = null
    const gate = new Promise<{ conversationId: string }>((resolve) => {
      release = () => resolve({ conversationId: 'conv-gated' })
    })
    let calls = 0
    const dataDir = tempDir()
    const engine = new ScheduleEngine({
      dataDir,
      now: () => start + 3_601_000,
      runCrew: async () => {
        calls += 1
        return gate
      },
      runFlow: async () => ({ flowRunId: 'x' }),
      emit: () => undefined
    })
    track(engine)
    engine.save({ name: 'Slow', target: { kind: 'crew', teammateId: 'm', prompt: 'Go slow' }, every: { kind: 'hours', hours: 1 }, enabled: true })
    const id = engine.list()[0]!.id
    // Force it due by saving when the clock is earlier, then moving on tested via direct runNow overlap.
    const first = engine.runNow(id)
    const second = engine.runNow(id)
    await flush(20)
    release!()
    await first
    await second
    expect(calls).toBe(1)
  })

  it('keeps only 20 runs', async () => {
    const h = harness(tempDir())
    const created = h.engine.save(crewSchedule())
    const id = created[0]!.id
    for (let i = 0; i < 22; i++) {
      await h.engine.runNow(id)
    }
    expect(h.engine.list()[0]!.runs).toHaveLength(20)
  })

  it('remove deletes the schedule', () => {
    const h = harness(tempDir())
    const created = h.engine.save(crewSchedule())
    const after = h.engine.remove(created[0]!.id)
    expect(after).toHaveLength(0)
    expect(h.engine.list()).toHaveLength(0)
  })
})

describe('persistence', () => {
  it('reloads from disk and writes atomically', async () => {
    const dataDir = tempDir()
    const first = harness(dataDir)
    const created = first.engine.save(crewSchedule())
    await first.engine.runNow(created[0]!.id)
    const file = join(dataDir, 'schedules.json')
    expect(existsSync(file)).toBe(true)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(Array.isArray(parsed)).toBe(true)
    const leftovers = readdirSync(dataDir).filter((f) => f.startsWith('schedules.json.tmp'))
    expect(leftovers).toEqual([])
    const second = new ScheduleEngine({
      dataDir,
      runCrew: async () => ({ conversationId: 'c' }),
      runFlow: async () => ({ flowRunId: 'f' }),
      emit: () => undefined
    })
    expect(second.list()).toHaveLength(1)
    expect(second.list()[0]!.runs).toHaveLength(1)
    expect(second.list()[0]!.nextRunAt).toBe(first.engine.list()[0]!.nextRunAt)
  })

  it('a missing or broken file means none', () => {
    const dataDir = tempDir()
    const empty = new ScheduleEngine({
      dataDir,
      runCrew: async () => ({ conversationId: 'c' }),
      runFlow: async () => ({ flowRunId: 'f' }),
      emit: () => undefined
    })
    expect(empty.list()).toEqual([])
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'schedules.json'), '{ not json', 'utf8')
    const broken = new ScheduleEngine({
      dataDir,
      runCrew: async () => ({ conversationId: 'c' }),
      runFlow: async () => ({ flowRunId: 'f' }),
      emit: () => undefined
    })
    expect(broken.list()).toEqual([])
  })
})
