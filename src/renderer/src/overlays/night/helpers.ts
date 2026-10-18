// Shared formatting and small decisions for the Night watch views.
// Everything here is pure, so helpers.test.ts can check it without a window.

import { AGENTS } from '@shared/agents'
import type { CheckSpec, GateId, TestCounts } from '@shared/heats'
import type { Night, NightState, NightTask, NightTaskRun, NightTaskStatus } from '@shared/nightwatch'
import type { AgentKind } from '@shared/types'

/** The agents the headless runner can start (headlessArgs in src/main/heats/runner.ts). Skipper's heat form keeps the same list. */
export const HEADLESS_AGENTS: AgentKind[] = ['claude', 'codex', 'grok', 'opencode', 'gemini', 'fake']

/** The sentence main sent, without the wrapper Electron puts around an error thrown inside a handler. */
export function cleanError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]+: )?/, '')
}

/** What an agent is called on screen. */
export function agentName(kind: AgentKind): string {
  return AGENTS[kind]?.name ?? kind
}

/** The last folder of a path, for example "my-app" for "/Users/me/code/my-app". */
export function projectName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root
}

/** A count with its noun, for example "1 task" or "3 tasks". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

// Time. Every date and time follows the system locale, so the words and the 12 or 24 hour clock are the user's own.

/** A time of day, for example "01:00" or "1:00 AM". */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** A date for a night, for example "Sat 3 Oct". */
export function formatNightDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** A span of time: "48 s" under a minute, "12 m" under an hour, then "2 h 5 m". */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} m`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`
}

/** How long until a night starts, for example "5 h 12 m" or "12 m". */
export function formatUntil(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return 'less than a minute'
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours} h ${minutes % 60} m` : `${minutes} m`
}

/** How long a check took, for example "0.4 s" or "2 m 5 s". */
export function formatCheckTime(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`
}

/**
 * The next time the clock shows `time` ("01:00", as a time field gives it): today when that is still ahead,
 * otherwise tomorrow. Null when the field is empty or not a time.
 */
export function nextStart(time: string, now: number): { at: number; tomorrow: boolean } | null {
  const found = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!found) return null
  const hours = Number(found[1])
  const minutes = Number(found[2])
  if (hours > 23 || minutes > 59) return null
  const target = new Date(now)
  target.setHours(hours, minutes, 0, 0)
  const tomorrow = target.getTime() <= now
  if (tomorrow) target.setDate(target.getDate() + 1)
  return { at: target.getTime(), tomorrow }
}

/** Tokens as "55k", "1.2k" or a plain count. */
export function compactTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  return `${Number((tokens / 1000).toFixed(1))}k`
}

/** The tokens each agent used in a night, for the runs that reported any: [{ agent, tokens }]. */
export function tokensByAgent(runs: NightTaskRun[]): { agent: AgentKind; tokens: number }[] {
  const totals = new Map<AgentKind, number>()
  for (const run of runs) {
    if (run.tokens === null) continue
    totals.set(run.agent, (totals.get(run.agent) ?? 0) + run.tokens)
  }
  return [...totals].map(([agent, tokens]) => ({ agent, tokens }))
}

/** The diff of a run, for example "+12 -3 in 2 files". */
export function diffText(diff: NightTaskRun['diff']): string {
  return `+${diff.added} -${diff.removed} in ${plural(diff.files, 'file', 'files')}`
}

/** The test counts of a run in total: files, cases and assertions. Null when none were counted. */
export function testTotals(tests: TestCounts | null): { files: number; cases: number; assertions: number } | null {
  if (!tests) return null
  const entries = Object.values(tests)
  if (entries.length === 0) return null
  return {
    files: entries.length,
    cases: entries.reduce((sum, t) => sum + t.cases, 0),
    assertions: entries.reduce((sum, t) => sum + t.assertions, 0)
  }
}

// State of the night and of its runs.

/** The night that is scheduled or running now. The engine allows one at a time. */
export function activeNight(state: NightState | null): Night | null {
  return state?.nights.find((n) => n.status === 'scheduled' || n.status === 'running') ?? null
}

/** The second line of the Tonight row. */
export function tonightLine(state: NightState | null): string {
  const active = activeNight(state)
  if (active?.status === 'running') return 'Running now'
  if (active?.status === 'scheduled') return `Starts at ${formatClock(active.startAt)}`
  const queued = state?.queue.length ?? 0
  return queued === 0 ? 'No tasks queued' : `${plural(queued, 'task', 'tasks')} queued`
}

/** The title of a night's report, for example "Sat 3 Oct \u00B7 my-app". */
export function nightTitle(night: Night): string {
  return `${formatNightDate(night.startAt)} \u00B7 ${projectName(night.root)}`
}

/** The first line of a night's row: its date, with the time added when another night in the list has the same date. */
export function nightRowTitle(night: Night, all: Night[]): string {
  const date = formatNightDate(night.startAt)
  const shared = all.some((other) => other.id !== night.id && formatNightDate(other.startAt) === date)
  return shared ? `${date} \u00B7 ${formatClock(night.startAt)}` : date
}

/** The second line of a night's row, for example "3 tasks, 2 ready". */
export function nightRowLine(night: Night): string {
  const ready = night.runs.filter((r) => r.status === 'ready').length
  return `${plural(night.runs.length, 'task', 'tasks')}, ${ready} ready`
}

/** Whether a night never got as far as starting a task (cancelled while it waited, or missed). */
export function neverStarted(night: Night): boolean {
  return night.runs.every((r) => r.startedAt === null)
}

/** When the first task of a night started, if one did. */
export function nightStart(night: Night): number | null {
  const starts = night.runs.map((r) => r.startedAt).filter((t): t is number => t !== null)
  return starts.length > 0 ? Math.min(...starts) : null
}

/** The base commit the night worked from, short. Null until the night starts. */
export function nightBase(night: Night): string | null {
  const base = night.runs.find((r) => r.base)?.base
  return base ? base.slice(0, 7) : null
}

const NOTE_IN_SUMMARY = 140

/**
 * The line under the title of a night, for example "2 of 3 ready \u00B7 1 failed (failing: done) \u00B7 ran 01:10 to 03:42".
 * A run that was merged or discarded is counted as that, so the numbers add up after the morning's work.
 */
export function nightSummary(night: Night): string {
  const total = night.runs.length
  if (night.status === 'scheduled') return `${plural(total, 'task', 'tasks')} \u00B7 starts at ${formatClock(night.startAt)}`
  const start = nightStart(night)
  if (night.status === 'cancelled' && start === null) return `${plural(total, 'task', 'tasks')} \u00B7 cancelled before it started`

  const count = (status: NightTaskStatus): number => night.runs.filter((r) => r.status === status).length
  const parts: string[] = [`${count('ready')} of ${total} ready`]
  const failed = night.runs.filter((r) => r.status === 'failed')
  if (failed.length === 1) {
    const note = failed[0]!.note.replace(/\s+/g, ' ').trim()
    const shown = note.length > NOTE_IN_SUMMARY ? `${note.slice(0, NOTE_IN_SUMMARY - 3)}...` : note
    parts.push(shown ? `1 failed (${shown})` : '1 failed')
  } else if (failed.length > 1) {
    parts.push(`${failed.length} failed`)
  }
  if (count('stopped') > 0) parts.push(`${count('stopped')} stopped`)
  if (count('merged') > 0) parts.push(`${count('merged')} merged`)
  if (count('discarded') > 0) parts.push(`${count('discarded')} discarded`)

  if (night.status === 'running') parts.push(start === null ? 'starting up' : `running since ${formatClock(start)}`)
  else if (start !== null && night.finishedAt !== null) parts.push(`ran ${formatClock(start)} to ${formatClock(night.finishedAt)}`)
  else if (night.status === 'finished') parts.push('no task started')
  return parts.join(' \u00B7 ')
}

/** The label of the first fact: "Ran", or "Starts" for a night that is still waiting. */
export function ranLabel(night: Night): string {
  return night.status === 'scheduled' ? 'Starts' : 'Ran'
}

/** The first fact: the start and end of the night, how long it has been running, or the time it will start. */
export function ranText(night: Night, now: number): string {
  const start = nightStart(night)
  if (night.status === 'scheduled') return formatClock(night.startAt)
  if (start === null) return 'did not start'
  if (night.status === 'running') return `running for ${formatSpan(now - start)}`
  return night.finishedAt === null ? `since ${formatClock(start)}` : `${formatClock(start)} to ${formatClock(night.finishedAt)}`
}

/** How long a run took: live while it runs, nothing before it starts. */
export function runSpan(run: NightTaskRun, now: number): string | null {
  if (run.startedAt === null) return null
  return formatSpan(run.durationMs ?? (run.endedAt ?? now) - run.startedAt)
}

/** Whether the run's worktree is probably still on disk: not after a merge or discard, unless something was kept. */
export function worktreeLikelyThere(run: NightTaskRun): boolean {
  if (!run.worktree) return false
  if (run.status === 'merged' || run.status === 'discarded') return /\bKept:/.test(run.note)
  return true
}

/** Whether the run's branch is probably still there: it goes with the worktree when a run is merged or discarded. */
export function branchLikelyThere(run: NightTaskRun): boolean {
  return run.branch !== null && worktreeLikelyThere({ ...run, worktree: run.worktree ?? run.branch })
}

/** True when discarding a merged or discarded run again could still remove something the engine kept. */
export function hasLeftovers(run: NightTaskRun): boolean {
  return (run.status === 'merged' || run.status === 'discarded') && /\bKept:/.test(run.note)
}

/**
 * The folder "Open in a pane" opens for a run. The engine runs a project that sits below the top of its repository in the
 * same folder below the worktree, so this is that folder when it can be worked out (`repoTop` is the repository's main working
 * folder as git prints it), and the top of the worktree otherwise.
 */
export function folderForRun(worktree: string, projectRoot: string, repoTop: string | null): string {
  if (!repoTop) return worktree
  const top = repoTop.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root.startsWith(`${top}/`)) return worktree
  const below = root.slice(top.length + 1)
  const sep = worktree.includes('\\') && !worktree.includes('/') ? '\\' : '/'
  return `${worktree.replace(/[\\/]+$/, '')}${sep}${below.split('/').join(sep)}`
}

// Looks. Class names are written out whole so Tailwind finds them.

export interface Look {
  label: string
  text: string
  dot: string
  border: string
  /** The thin bar in a run row. */
  bar: string
}

export const RUN_LOOK: Record<NightTaskStatus, Look> = {
  queued: { label: 'Queued', text: 'text-st-quiet', dot: 'bg-st-quiet', border: 'border-st-quiet/40', bar: 'bg-line-strong' },
  running: { label: 'Running', text: 'text-st-working', dot: 'bg-st-working', border: 'border-st-working/40', bar: 'bg-st-working' },
  checking: { label: 'Checking', text: 'text-st-starting', dot: 'bg-st-starting', border: 'border-st-starting/40', bar: 'bg-st-starting' },
  ready: { label: 'Ready', text: 'text-st-idle', dot: 'bg-st-idle', border: 'border-st-idle/40', bar: 'bg-st-idle' },
  failed: { label: 'Failed', text: 'text-st-failed', dot: 'bg-st-failed', border: 'border-st-failed/40', bar: 'bg-st-failed' },
  stopped: { label: 'Stopped', text: 'text-st-waiting', dot: 'bg-st-waiting', border: 'border-st-waiting/40', bar: 'bg-line-strong' },
  merged: { label: 'Merged', text: 'text-st-done', dot: 'bg-st-done', border: 'border-st-done/40', bar: 'bg-line-strong' },
  discarded: { label: 'Discarded', text: 'text-st-quiet', dot: 'bg-st-quiet', border: 'border-st-quiet/40', bar: 'bg-line-strong' }
}

const NIGHT_LOOK = {
  scheduled: { label: 'Scheduled', text: 'text-st-starting', dot: 'bg-st-starting', border: 'border-st-starting/40', bar: 'bg-st-starting' },
  running: { label: 'Running', text: 'text-st-working', dot: 'bg-st-working', border: 'border-st-working/40', bar: 'bg-st-working' },
  ready: { label: 'Finished', text: 'text-st-idle', dot: 'bg-st-idle', border: 'border-st-idle/40', bar: 'bg-st-idle' },
  quiet: { label: 'Finished', text: 'text-st-quiet', dot: 'bg-st-quiet', border: 'border-st-quiet/40', bar: 'bg-line-strong' },
  cancelled: { label: 'Cancelled', text: 'text-st-quiet', dot: 'bg-st-quiet', border: 'border-st-quiet/40', bar: 'bg-line-strong' }
} satisfies Record<string, Look>

/** The pill and dot of a night: scheduled blue, running blue, finished green when anything is ready and gray otherwise, cancelled gray. */
export function nightLook(night: Night): Look {
  switch (night.status) {
    case 'scheduled':
      return NIGHT_LOOK.scheduled
    case 'running':
      return NIGHT_LOOK.running
    case 'finished':
      return night.runs.some((r) => r.status === 'ready') ? NIGHT_LOOK.ready : NIGHT_LOOK.quiet
    case 'cancelled':
      return NIGHT_LOOK.cancelled
  }
}

export const GATE_LABEL: Record<GateId, string> = {
  finished: 'Finished',
  changed: 'Changed',
  checks: 'Checks',
  'no-regressions': 'No regressions',
  integrity: 'Integrity'
}

/**
 * The last lines of what an agent printed, as a terminal would show them: a carriage return sends the cursor back to the
 * start of the line, so only what follows the last one is on screen (a spinner redraws the same line many times).
 */
export function lastLines(text: string, count: number): string {
  return text
    .split('\n')
    // A carriage return at the very end is half of a Windows line ending, not a redraw.
    .map((line) => (line.replace(/\r+$/, '').split('\r').pop() ?? '').trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-count)
    .join('\n')
}

// Notes and commands.

/**
 * Git commands a note could tell the user to run themselves (never the read-only ones, which only show up in prose).
 * A command ends at a semicolon: "git branch <name> <ref>^1; git log <ref> shows everything kept" is one command and a remark.
 */
const GIT_COMMAND = /\bgit (?:branch|worktree|checkout|switch|merge|restore|update-ref|reset|stash|cherry-pick|rebase)(?: [^\s();]+)*/

/**
 * The git command a note tells the user to run, for example "git branch <name> refs/regatta/discarded/night-abcd-0^1".
 * Null when there is none: a word after "git" that is not a command, or a git error quoted in a sentence, does not count.
 */
export function gitCommandIn(text: string): string | null {
  const found = GIT_COMMAND.exec(text)
  if (!found) return null
  const command = found[0].replace(/[.,;]+$/, '')
  // An argument never ends in a colon; a word that does is a sentence ("git merge failed: ...").
  return /:(?:\s|$)/.test(command) ? null : command
}

// Checks.

const CUSTOM_NAME_MAX = 40

/** A required check from a command the user typed. Its name is the command, and never one the task already has: results are matched by name. */
export function customCheck(command: string, taken: string[]): CheckSpec {
  const text = command.trim()
  const base = text.length > CUSTOM_NAME_MAX ? `${text.slice(0, CUSTOM_NAME_MAX - 3)}...` : text
  let name = base
  for (let n = 2; taken.includes(name); n++) name = `${base} (${n})`
  return { name, command: text, kind: 'required' }
}

