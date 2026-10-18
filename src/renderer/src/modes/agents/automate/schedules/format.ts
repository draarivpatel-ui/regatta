// Small text helpers for the Schedules view.

import type { Schedule, ScheduleEvery } from '@shared/schedules'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function dayName(day: number): string {
  return DAYS[day] ?? 'Sunday'
}

/** "Every 3 hours", "Every day at 09:30", "Every Monday at 08:00". */
export function everyText(every: ScheduleEvery): string {
  if (every.kind === 'hours') return every.hours === 1 ? 'Every hour' : `Every ${every.hours} hours`
  if (every.kind === 'daily') return `Every day at ${every.time}`
  return `Every ${dayName(every.day)} at ${every.time}`
}

/** "18:30" in local time. */
export function clockOf(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "today 18:30", "tomorrow 09:30" or "Oct 20, 08:00" in local time. */
export function whenText(at: number, now: number): string {
  const a = new Date(at)
  const b = new Date(now)
  const dayStart = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round((dayStart(a).getTime() - dayStart(b).getTime()) / 86_400_000)
  if (diffDays === 0) return `today ${clockOf(at)}`
  if (diffDays === 1) return `tomorrow ${clockOf(at)}`
  const month = a.toLocaleString(undefined, { month: 'short' })
  return `${month} ${a.getDate()}, ${clockOf(at)}`
}

/** "Next: today 18:30" or "Off". */
export function nextText(schedule: Schedule, now: number): string {
  if (!schedule.enabled || schedule.nextRunAt == null) return 'Off'
  return `Next: ${whenText(schedule.nextRunAt, now)}`
}
