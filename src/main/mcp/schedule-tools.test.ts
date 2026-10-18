// Unit tests for the schedule MCP tools.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ScheduleEngine } from '../schedules'
import { scheduleTools } from './schedule-tools'

const cleanup: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-schedule-tools-'))
  cleanup.push(dir)
  return join(dir, 'data')
}

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

function engineFor(dataDir: string): { engine: ScheduleEngine; calls: number } {
  let calls = 0
  const engine = new ScheduleEngine({
    dataDir,
    now: () => 1_700_000_000_000,
    runCrew: async () => {
      calls += 1
      return { conversationId: 'conv-1' }
    },
    runFlow: async () => ({ flowRunId: 'flowrun-1' }),
    emit: () => undefined
  })
  return {
    engine,
    get calls(): number {
      return calls
    }
  }
}

describe('scheduleTools', () => {
  it('lists schedules with what they run, how often, on or off, next run and last result', async () => {
    const { engine } = engineFor(tempDir())
    const [list, run] = scheduleTools(engine)
    const empty = await list!.run({})
    expect(empty.text).toContain('No schedules')
    engine.save({
      name: 'Daily check',
      target: { kind: 'crew', teammateId: 'mate-1', prompt: 'Check the open issues' },
      every: { kind: 'daily', time: '09:30' },
      enabled: true
    })
    const result = await list!.run({})
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('Daily check')
    expect(result.text).toContain('Every day at 09:30')
    expect(result.text).toContain('mate-1')
    const data = result.data as Array<Record<string, unknown>>
    expect(data).toHaveLength(1)
    expect(data[0]!['name']).toBe('Daily check')
    expect(data[0]!['howOften']).toBe('Every day at 09:30')
    expect(data[0]!['enabled']).toBe(true)
    void run
  })

  it('runs a schedule now and reports unknown ids as errors', async () => {
    const holder = engineFor(tempDir())
    const [, run] = scheduleTools(holder.engine)
    const created = holder.engine.save({
      name: 'Hourly',
      target: { kind: 'flow', flowId: 'flow-1' },
      every: { kind: 'hours', hours: 3 },
      enabled: true
    })
    const ok = await run!.run({ id: created[0]!.id })
    expect(ok.isError).toBeFalsy()
    expect(ok.text).toContain('Hourly')
    expect(holder.engine.list()[0]!.runs).toHaveLength(1)
    const missing = await run!.run({ id: 'nope-nope' })
    expect(missing.isError).toBe(true)
    const blank = await run!.run({})
    expect(blank.isError).toBe(true)
  })
})
