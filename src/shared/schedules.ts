// Schedules: run a crew member's prompt or a flow again and again while the app is open.
// nextRunAfter is shared and tested here.

export type ScheduleEvery =
  /** Every N hours (1 to 24) after the last run. */
  | { kind: 'hours'; hours: number }
  /** Every day at a local time, "HH:MM". */
  | { kind: 'daily'; time: string }
  /** Every week on a day (0 is Sunday) at a local time. */
  | { kind: 'weekly'; day: number; time: string }

export type ScheduleTarget =
  | { kind: 'crew'; teammateId: string; prompt: string }
  | { kind: 'flow'; flowId: string }

export interface ScheduleRun {
  at: number
  ok: boolean
  /** What happened, for example "Started a conversation with Ada", or why it failed. */
  note: string
  conversationId: string | null
  flowRunId: string | null
}

export interface Schedule {
  id: string
  name: string
  target: ScheduleTarget
  every: ScheduleEvery
  enabled: boolean
  createdAt: number
  /** When it runs next; null while turned off. */
  nextRunAt: number | null
  /** Newest first, at most 20. */
  runs: ScheduleRun[]
}

export type NewSchedule = Pick<Schedule, 'name' | 'target' | 'every' | 'enabled'> & { id?: string }

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Hours and minutes of an "HH:MM" string, or null when it is not one. */
export function parseTime(time: string): { h: number; m: number } | null {
  const match = TIME.exec(time)
  return match ? { h: Number(match[1]), m: Number(match[2]) } : null
}

/**
 * The first moment strictly after `from` that `every` falls on, in local time. Daily and weekly
 * times step whole calendar days, so a clock change does not shift them. Throws on a bad schedule.
 */
export function nextRunAfter(every: ScheduleEvery, from: number): number {
  if (every.kind === 'hours') {
    if (!Number.isInteger(every.hours) || every.hours < 1 || every.hours > 24) throw new Error('Pick 1 to 24 hours.')
    return from + every.hours * 3_600_000
  }
  const time = parseTime(every.time)
  if (!time) throw new Error('Pick a time like 09:30.')
  if (every.kind === 'weekly' && (!Number.isInteger(every.day) || every.day < 0 || every.day > 6)) {
    throw new Error('Pick a day of the week.')
  }
  const at = new Date(from)
  at.setHours(time.h, time.m, 0, 0)
  for (let i = 0; i < 8; i++) {
    const fits = every.kind === 'daily' || at.getDay() === every.day
    if (fits && at.getTime() > from) return at.getTime()
    at.setDate(at.getDate() + 1)
    at.setHours(time.h, time.m, 0, 0)
  }
  throw new Error('Could not work out the next run.')
}
