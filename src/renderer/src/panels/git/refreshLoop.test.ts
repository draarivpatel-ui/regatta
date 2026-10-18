import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RefreshLoop } from './refreshLoop'
import { RequestGate } from './requestGate'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const later = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

describe('RefreshLoop with RequestGate', () => {
  it('keeps accepting answers when each answer takes longer than the interval', async () => {
    const gate = new RequestGate()
    let accepted = 0
    let discarded = 0
    let started = 0
    const loop = new RefreshLoop(async () => {
      started++
      const ticket = gate.begin('/repo')
      await later(4000)
      if (gate.isCurrent(ticket, '/repo')) accepted++
      else discarded++
    }, 3000)
    loop.start()
    await vi.advanceTimersByTimeAsync(30_000)
    loop.stop()
    expect(discarded).toBe(0)
    expect(accepted).toBeGreaterThanOrEqual(4)
    // Only the refresh still running when the loop stopped may be missing.
    expect(accepted).toBeGreaterThanOrEqual(started - 1)
  })

  it('never has two refreshes running at once', async () => {
    let running = 0
    let most = 0
    const loop = new RefreshLoop(async () => {
      running++
      most = Math.max(most, running)
      await later(500)
      running--
    }, 100)
    loop.start()
    for (let i = 0; i < 10; i++) {
      loop.trigger()
      await vi.advanceTimersByTimeAsync(137)
    }
    loop.stop()
    expect(most).toBe(1)
  })

  it('answers any number of triggers during a refresh with one follow-up', async () => {
    let calls = 0
    const loop = new RefreshLoop(async () => {
      calls++
      await later(1000)
    }, 60_000)
    loop.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toBe(1)
    loop.trigger()
    loop.trigger()
    loop.trigger()
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(2)
    loop.stop()
  })

  it('refreshes again after the interval, counted from the end of the last refresh', async () => {
    let calls = 0
    const loop = new RefreshLoop(async () => {
      calls++
      await later(1000)
    }, 3000)
    loop.start()
    await vi.advanceTimersByTimeAsync(3900)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toBe(2)
    loop.stop()
  })

  it('a folder change still drops the answer that was in flight', async () => {
    const gate = new RequestGate()
    let folder = '/repo/a'
    const taken: string[] = []
    const loop = new RefreshLoop(async () => {
      const target = folder
      const ticket = gate.begin(target)
      await later(2000)
      if (gate.isCurrent(ticket, folder)) taken.push(target)
    }, 3000)
    loop.start()
    await vi.advanceTimersByTimeAsync(500)
    folder = '/repo/b'
    await vi.advanceTimersByTimeAsync(1600)
    expect(taken).toEqual([])
    await vi.advanceTimersByTimeAsync(6000)
    loop.stop()
    expect(taken.length).toBeGreaterThan(0)
    expect(taken.every((f) => f === '/repo/b')).toBe(true)
  })

  it('stop leaves nothing scheduled and a running refresh does not schedule another', async () => {
    let calls = 0
    const loop = new RefreshLoop(async () => {
      calls++
      await later(1000)
    }, 100)
    loop.start()
    await vi.advanceTimersByTimeAsync(10)
    loop.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
