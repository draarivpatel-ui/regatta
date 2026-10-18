import { describe, expect, it } from 'vitest'
import { nextRunAfter, parseTime } from './schedules'

const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

describe('nextRunAfter', () => {
  it('adds whole hours for an hourly schedule', () => {
    expect(nextRunAfter({ kind: 'hours', hours: 3 }, local(2026, 10, 14, 9, 15))).toBe(local(2026, 10, 14, 12, 15))
  })

  it('runs later today when the time has not passed, otherwise tomorrow', () => {
    expect(nextRunAfter({ kind: 'daily', time: '18:30' }, local(2026, 10, 14, 9, 0))).toBe(local(2026, 10, 14, 18, 30))
    expect(nextRunAfter({ kind: 'daily', time: '08:00' }, local(2026, 10, 14, 9, 0))).toBe(local(2026, 10, 15, 8, 0))
    expect(nextRunAfter({ kind: 'daily', time: '09:00' }, local(2026, 10, 14, 9, 0))).toBe(local(2026, 10, 15, 9, 0))
  })

  it('finds the next matching weekday, a week ahead when today has passed', () => {
    // 2026-10-14 is a Wednesday (3).
    expect(nextRunAfter({ kind: 'weekly', day: 5, time: '10:00' }, local(2026, 10, 14, 9, 0))).toBe(local(2026, 10, 16, 10, 0))
    expect(nextRunAfter({ kind: 'weekly', day: 3, time: '08:00' }, local(2026, 10, 14, 9, 0))).toBe(local(2026, 10, 21, 8, 0))
    expect(nextRunAfter({ kind: 'weekly', day: 3, time: '10:00' }, local(2026, 10, 14, 9, 0))).toBe(local(2026, 10, 14, 10, 0))
  })

  it('keeps the wall clock time across a month end', () => {
    expect(nextRunAfter({ kind: 'daily', time: '07:45' }, local(2026, 10, 31, 23, 0))).toBe(local(2026, 11, 1, 7, 45))
  })

  it('rejects bad schedules', () => {
    expect(() => nextRunAfter({ kind: 'hours', hours: 0 }, 0)).toThrow(/hours/)
    expect(() => nextRunAfter({ kind: 'daily', time: '25:00' }, 0)).toThrow(/time/)
    expect(() => nextRunAfter({ kind: 'weekly', day: 7, time: '10:00' }, 0)).toThrow(/day/)
  })

  it('reads HH:MM only', () => {
    expect(parseTime('09:05')).toEqual({ h: 9, m: 5 })
    expect(parseTime('9:05')).toBeNull()
  })
})
