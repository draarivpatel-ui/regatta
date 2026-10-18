// Relay: notice when an agent hits its usage limit, resume it at reset or continue in another agent.
// See docs/design/phase4.md.

import type { LimitInfo } from '../shared/types'

/** A limit message is only read off the bottom of the screen, where the agent just wrote it. */
const TAIL_LINES = 12

/** How much of the screen goes into the carry-over brief. */
const BRIEF_SCREEN_LINES = 40

/**
 * Words that turn a mention of a limit into the agent saying the limit stopped it.
 * Without one of these the line is only talking about limits, for example
 * "add rate limiting to the API".
 */
const LIMIT_EVENT = /reached|exceeded|exhausted|\bhit\b|\bresets?\b|will\s+reset|try\s+again|come\s+back/i

/** Ways an agent names the limit it ran into. */
const NAMED_LIMIT = /(?:usage|session|daily|weekly|monthly|hourly|rate)\s+limit|\d+\s*[- ]?\s*hour\s+limit/i

/** "limit reached", "hit the limit", "the limit will reset": the same event, other words. */
const PLAIN_LIMIT = [
  /\blimit\s+(?:was\s+)?(?:reached|exceeded|exhausted|will\s+reset)\b/i,
  /\b(?:reached|hit|exceeded|exhausted)\b[^.\n]{0,40}\blimit\b/i,
  /\blimit\b[^.\n]{0,40}\b(?:reached|exceeded|exhausted|resets?|will\s+reset)\b/i,
  /\blimit\b[^.\n]{0,30}\btry\s+again\b/i,
  /\btry\s+again\b[^.\n]{0,30}\blimit\b/i
]

/** True when a single screen line reports a usage limit, not code or prose about limits. */
export function isLimitLine(line: string): boolean {
  if (!/\blimit\b/i.test(line)) return false
  if (NAMED_LIMIT.test(line)) return LIMIT_EVENT.test(line)
  return PLAIN_LIMIT.some((re) => re.test(line))
}

/** The next time this clock time comes around after `now`. */
function nextClockTime(now: number, hour24: number, minute: number): number {
  const today = new Date(now)
  today.setHours(hour24, minute, 0, 0)
  if (today.getTime() > now) return today.getTime()
  // Tomorrow, built day by day so a daylight saving change keeps the wall clock time.
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(hour24, minute, 0, 0)
  return tomorrow.getTime()
}

/**
 * Reads a clock time the agent gave, for example "resets 6:30pm", "resets at 18:30" or
 * "try again at 3am". A bare number with no minutes and no am or pm is a count
 * ("try again 5 times"), not a time, so it is skipped.
 */
function parseClockTime(text: string, now: number): number | null {
  const re = /(?:resets?|try\s+again|available\s+again|come\s+back)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\s*\.?\s*m\s*\.?)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const hour = Number(m[1])
    const minute = m[2] === undefined ? 0 : Number(m[2])
    const half = (m[3] ?? '').replace(/[^ap]/gi, '').toLowerCase()
    if (m[2] === undefined && !half) continue
    if (minute < 0 || minute > 59) continue
    let hour24 = hour
    if (half) {
      if (hour < 1 || hour > 12) continue
      hour24 = half === 'p' ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour
    } else if (hour > 23) {
      continue
    }
    return nextClockTime(now, hour24, minute)
  }
  return null
}

/** Reads how long the agent said to wait, for example "in 1h 59m" or "in 2 hours 10 minutes". */
function parseDelay(text: string, now: number): number | null {
  // The long form first, so "1h 59m" is one hour and 59 minutes and not 59 minutes.
  const hoursAndMinutes = /(\d+)\s*h(?:ours?|rs?)?\s*(?:and\s+)?(\d+)\s*m(?:in(?:utes?)?)?\b/i.exec(text)
  if (hoursAndMinutes) {
    const hours = Number(hoursAndMinutes[1])
    const minutes = Number(hoursAndMinutes[2])
    if (Number.isFinite(hours) && Number.isFinite(minutes)) return now + hours * 3_600_000 + minutes * 60_000
  }
  const hours = /(\d+)\s*h(?:ours?|rs?)?\b/i.exec(text)
  if (hours) {
    const h = Number(hours[1])
    if (Number.isFinite(h)) return now + h * 3_600_000
  }
  const minutes = /(\d+)\s*m(?:in(?:utes?)?)?\b/i.exec(text)
  if (minutes) {
    const m = Number(minutes[1])
    if (Number.isFinite(m)) return now + m * 60_000
  }
  return null
}

/**
 * Reads the reset time out of limit text. A clock time wins over a wait, and a wait is
 * only read when the line talks about waiting, so "5-hour limit reached" stays unknown
 * instead of guessing a reset.
 */
function parseResetsAt(text: string, now: number): number | null {
  const clock = parseClockTime(text, now)
  if (clock !== null) return clock
  if (!/resets?|try\s+again|retry|wait|\bin\s+\d/i.test(text)) return null
  return parseDelay(text, now)
}

/** "6:30 PM" for a reset time, the way the user's computer writes times. */
export function formatResetTime(resetsAt: number): string {
  return new Date(resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Finds a usage limit message in the visible screen text. Pure, unit tested. */
export function detectLimit(screen: string, now: number): LimitInfo | null {
  const tail = screen
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-TAIL_LINES)
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i]!
    if (!isLimitLine(line)) continue
    const text = line.trim()
    // A reset time sometimes sits on the line under the message.
    const resetsAt = parseResetsAt(text, now) ?? parseResetsAt(tail.join('\n'), now)
    return { text, resetsAt, resumeScheduled: false }
  }
  return null
}

/** Blank space off the end, without eating the leading status column of git output. */
function trimTail(text: string): string {
  return text.replace(/\s+$/, '')
}

/** The carry-over brief typed into the new agent. Plain text, no model involved. */
export function buildBrief(input: {
  agentName: string
  lastPrompt: string
  gitStatus: string
  diffStat: string
  screenTail: string
}): string {
  const parts: string[] = [`Continuing work that ${input.agentName} started. It stopped at its usage limit.`]
  const lastPrompt = input.lastPrompt.trim()
  if (lastPrompt) parts.push(`What the user asked last:\n${lastPrompt}`)
  const changes = [input.gitStatus, input.diffStat].map(trimTail).filter((part) => part.trim().length > 0)
  if (changes.length > 0) parts.push(`Files changed so far (git status):\n${changes.join('\n\n')}`)
  const screenTail = trimTail(
    input.screenTail
      .split('\n')
      .filter((line) => line.trim().length > 0)
      // The line that reported the limit is left out: the new agent did not hit a limit, and
      // a copy of that line on its screen would put a relay card on a pane that is fine.
      .filter((line) => !isLimitLine(line))
      .slice(-BRIEF_SCREEN_LINES)
      .join('\n')
  )
  if (screenTail) parts.push(`The end of its screen:\n${screenTail}`)
  parts.push('Carry on from here.')
  return parts.join('\n\n')
}
