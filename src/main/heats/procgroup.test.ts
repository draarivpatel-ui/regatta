// Process group supervision with real processes.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { processesInside, stopAllGroups, supervise } from './procgroup'

function start(script: string) {
  return spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('supervise', () => {
  it('sends no signal after it settled, so a recycled group id is never hit', async () => {
    const child = start('sleep 300')
    const group = supervise(child, { killGraceMs: 150, giveUpMs: 200 })
    group.stop()
    await group.done
    // From here on the group id may belong to someone else: no timer may signal it.
    const kill = vi.spyOn(process, 'kill')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(kill).not.toHaveBeenCalled()
  }, 15000)

  it('resolves with the exit code of a command that finishes by itself', async () => {
    const child = start('echo hi; exit 4')
    const group = supervise(child)
    expect(await group.done).toBe(4)
  })

  it('cleans up a leftover background job after the command finished', async () => {
    const child = start('sleep 300 & exit 0')
    const group = supervise(child, { pipeGraceMs: 100, killGraceMs: 200 })
    expect(await group.done).toBe(0)
    expect(() => process.kill(-child.pid!, 0)).toThrow()
  }, 15000)
})

describe('a group that was seen absent', () => {
  it('is never probed or signaled again, so a reused group id is safe', async () => {
    const child = start('sleep 300')
    const pgid = child.pid!
    const real = process.kill.bind(process)
    let probes = 0
    const signals: unknown[] = []
    // The first probe of the group answers "no such process", as it would after the group ended and the id was reused.
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -pgid && signal === 0) {
        probes++
        if (probes === 1) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
        return true
      }
      if (pid === -pgid) {
        signals.push(signal)
        return true
      }
      return real(pid, signal as NodeJS.Signals)
    }) as typeof process.kill)
    const group = supervise(child, { killGraceMs: 100, giveUpMs: 100 })
    // Asking for a stop probes the group once: it looks absent, so it is retired and never signaled.
    group.stop()
    await new Promise((resolve) => setTimeout(resolve, 400))
    const probesAfterStop = probes
    expect(signals).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(probes).toBe(probesAfterStop)
    vi.restoreAllMocks()
    real(-pgid, 'SIGKILL')
    await group.done
  }, 15000)
})

describe('the shutdown deadline', () => {
  it('says stopped when every process is gone', async () => {
    const child = start('sleep 300')
    const group = supervise(child, { killGraceMs: 100, giveUpMs: 2000 })
    group.stop()
    await group.done
    expect(await group.outcome).toBe('stopped')
    expect(group.stuck).toBe(false)
  }, 15000)

  it('says stuck, not done, when the group is still alive at the deadline, and signals nothing afterwards', async () => {
    const child = start('sleep 300')
    const pgid = child.pid!
    const real = process.kill.bind(process)
    const signals: unknown[] = []
    // Signals to the group are swallowed, as if the processes could not be killed. Probing still works.
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -pgid && signal !== 0) {
        signals.push(signal)
        return true
      }
      return real(pid, signal as NodeJS.Signals)
    }) as typeof process.kill)
    const group = supervise(child, { killGraceMs: 100, giveUpMs: 200 })
    group.stop()
    await group.done
    expect(await group.outcome).toBe('stuck')
    expect(group.stuck).toBe(true)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    vi.restoreAllMocks()
    real(-pgid, 'SIGKILL')
  }, 15000)
})

describe('processesInside', () => {
  const made: string[] = []
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('finds a program that runs in the folder or below it, in a session of its own, by any path to it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'regatta-inside-'))
    made.push(dir)
    const inner = join(dir, 'a', 'b')
    mkdirSync(inner, { recursive: true })
    const sibling = `${dir}-sibling`
    mkdirSync(sibling)
    made.push(sibling)
    const link = join(mkdtempSync(join(tmpdir(), 'regatta-inside-link-')), 'link')
    made.push(join(link, '..'))
    symlinkSync(dir, link)
    const mine = spawn('/bin/sh', ['-c', 'exec sleep 120'], { cwd: inner, detached: true, stdio: 'ignore' })
    const theirs = spawn('/bin/sh', ['-c', 'exec sleep 120'], { cwd: sibling, detached: true, stdio: 'ignore' })
    // Working folder elsewhere, but a file of the folder held open.
    writeFileSync(join(dir, 'held.txt'), 'x')
    const holder = spawn('/bin/sh', ['-c', `exec sleep 120 < ${join(dir, 'held.txt')}`], { cwd: '/', detached: true, stdio: 'ignore' })
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      for (const path of [dir, link]) {
        const found = await processesInside(path)
        expect(found.map((p) => p.pid)).toContain(mine.pid)
        expect(found.map((p) => p.pid)).not.toContain(theirs.pid)
        expect(found.find((p) => p.pid === mine.pid)?.path).toBe(realpathSync(inner))
      }
      expect((await processesInside(sibling)).map((p) => p.pid)).toContain(theirs.pid)
      const held = (await processesInside(dir)).find((p) => p.pid === holder.pid)
      expect(held).toMatchObject({ kind: 'file', path: join(realpathSync(dir), 'held.txt') })
    } finally {
      holder.kill('SIGKILL')
      mine.kill('SIGKILL')
      theirs.kill('SIGKILL')
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await processesInside(dir)).toEqual([])
  }, 30000)
})

describe('stopAllGroups', () => {
  it('stops every live group, including one that ignores SIGTERM, and counts them', async () => {
    // The second ignores SIGTERM (an ignored signal is inherited by what it starts), so it needs the SIGKILL.
    const polite = start('sleep 300')
    const stubborn = start("trap '' TERM; sleep 300")
    const first = supervise(polite)
    const second = supervise(stubborn)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const started = Date.now()
    expect(await stopAllGroups(400)).toEqual({ stopped: 2, stuck: 0 })
    expect(Date.now() - started).toBeLessThan(4000)
    for (const child of [polite, stubborn]) expect(() => process.kill(-child.pid!, 0)).toThrow()
    expect(await first.outcome).toBe('stopped')
    expect(await second.outcome).toBe('stopped')
    // Settled groups are not registered any more.
    expect(await stopAllGroups(100)).toEqual({ stopped: 0, stuck: 0 })
  }, 20000)

  it('counts a group that cannot be stopped as stuck and signals nothing after giving up', async () => {
    const child = start('sleep 300')
    const pgid = child.pid!
    const real = process.kill.bind(process)
    const signals: unknown[] = []
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -pgid && signal !== 0) {
        signals.push(signal)
        return true
      }
      return real(pid, signal as NodeJS.Signals)
    }) as typeof process.kill)
    const group = supervise(child, { giveUpMs: 200 })
    expect(await stopAllGroups(100)).toEqual({ stopped: 0, stuck: 1 })
    expect(group.stuck).toBe(true)
    const sent = signals.length
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(signals).toHaveLength(sent)
    vi.restoreAllMocks()
    real(-pgid, 'SIGKILL')
  }, 20000)
})
