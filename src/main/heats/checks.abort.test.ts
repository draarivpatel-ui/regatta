// A check whose signal is already aborted must not start a process at all.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      spawned.count++
      return actual.spawn(...args)
    }) as typeof actual.spawn
  }
})

import { runCheck, runChecks, runShell } from './checks'

const dir = mkdtempSync(join(tmpdir(), 'regatta-heat-abort-check-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }

describe('an aborted signal', () => {
  it('returns a cancelled result without spawning anything', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runShell('echo started > started.txt', { cwd: dir, env: ENV, signal: controller.signal })
    expect(result).toEqual({ code: null, output: '', cancelled: true })
    const check = await runCheck({ name: 'late', command: 'echo started > started.txt', kind: 'required' }, dir, ENV, { signal: controller.signal })
    expect(check).toMatchObject({ passed: false, exitCode: null })
    expect(await runChecks([{ name: 'late', command: 'true', kind: 'required' }], dir, ENV, { signal: controller.signal })).toEqual([])
    expect(spawned.count).toBe(0)
    expect(existsSync(join(dir, 'started.txt'))).toBe(false)
  })
})
