// Reads token usage and live limits from the files each CLI keeps on this computer.
// See docs/design/phase4.md.

import * as nodeFs from 'node:fs'
import * as nodeFsPromises from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { AGENT_ORDER } from '../shared/agents'
import type { AgentKind, SessionInfo } from '../shared/types'
import type { AgentUsage, LiveLimits, UsageSummary } from '../shared/usage'

export interface UsageDeps {
  /** Sessions Regatta started (Claude sessions carry transcriptPath). */
  sessions: () => SessionInfo[]
  /** Home folder (Codex sessions live under ~/.codex/sessions). Overridable for tests. */
  home: () => string
  /** The CODEX_HOME folder of every saved Codex sign-in; their sessions are under <folder>/sessions. */
  codexHomes?: () => string[]
  now?: () => number
}

/** How many days the daily chart holds, oldest first. */
const DAILY_DAYS = 14

/** A reset time below this many seconds since 1970 is seconds, not milliseconds. */
const SECONDS_CEILING = 1e11

/** Tokens found for one CLI: how many runs, and the tokens measured per local day. */
interface Totals {
  runs: number
  days: Map<string, number>
}

function makeTotals(): Totals {
  return { runs: 0, days: new Map() }
}

/** Any finite number, otherwise 0, so a missing field never breaks a sum. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** A number kept as a percentage, or null when the CLI did not report one. */
function pct(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Epoch milliseconds from seconds since 1970, milliseconds since 1970, or an ISO string. */
function epochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < SECONDS_CEILING ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** Local calendar day key, "YYYY-MM-DD". */
function dayKey(ms: number): string {
  const day = new Date(ms)
  const month = String(day.getMonth() + 1).padStart(2, '0')
  const date = String(day.getDate()).padStart(2, '0')
  return `${day.getFullYear()}-${month}-${date}`
}

/** Day keys for the last `count` days ending today, oldest first. Steps a day at a time. */
function recentDays(now: number, count: number): string[] {
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  const keys = [dayKey(cursor.getTime())]
  for (let i = 1; i < count; i += 1) {
    cursor.setDate(cursor.getDate() - 1)
    keys.unshift(dayKey(cursor.getTime()))
  }
  return keys
}

function addTokens(days: Map<string, number>, key: string, tokens: number): void {
  if (tokens <= 0) return
  days.set(key, (days.get(key) ?? 0) + tokens)
}

/** Called for every parsed JSONL line, with the file's modified time as the fallback stamp. */
type LineHandler = (line: Record<string, unknown>, mtime: number) => void

/** What a readable file gave us: when it was last written, used when a line carries no stamp. */
interface FileStamp {
  mtime: number
}

/**
 * Reads a JSONL file one line at a time, because a transcript can be many megabytes, and hands each
 * parsed object to `onLine`. Returns null when the file cannot be opened. A file that breaks half
 * way through still counts for the lines it already gave us.
 */
async function eachJsonLine(file: string, onLine: LineHandler): Promise<FileStamp | null> {
  let stamp: FileStamp
  try {
    const info = await nodeFsPromises.stat(file)
    if (!info.isFile()) return null
    stamp = { mtime: info.mtimeMs }
  } catch {
    return null
  }
  const stream = nodeFs.createReadStream(file, { encoding: 'utf8' })
  fileReadCount += 1
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const text of lines) {
      const trimmed = text.trim()
      if (!trimmed) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      const value = record(parsed)
      if (value) onLine(value, stamp.mtime)
    }
  } catch {
    // Keep the lines read before the unreadable part.
  } finally {
    lines.close()
    stream.destroy()
  }
  return stamp
}

/** Largest number of transcript files kept in memory. Least recently used goes first when full. */
export const USAGE_CACHE_MAX_FILES = 5000

interface ClaudeCacheEntry {
  kind: 'claude'
  size: number
  mtimeMs: number
  days: Array<[string, number]>
  ok: boolean
}

interface CodexCacheEntry {
  kind: 'codex'
  size: number
  mtimeMs: number
  sessionTokens: number
  readings: LimitsReading[]
  ok: boolean
}

type UsageCacheEntry = ClaudeCacheEntry | CodexCacheEntry

const usageFileCache = new Map<string, UsageCacheEntry>()

/** Test hook: the live cache map, so tests can fill it or check eviction. */
export const __usageFileCache: Map<string, UsageCacheEntry> = usageFileCache

let fileReadCount = 0

/** Test hook: how many transcript files were opened for reading since the last reset. */
export function __getUsageFileReads(): number {
  return fileReadCount
}

/** Test hook: resets the file open counter. */
export function __resetUsageFileReads(): void {
  fileReadCount = 0
}

/** Drops every cached file, for tests. */
export function clearUsageCache(): void {
  usageFileCache.clear()
}

/** How many files are cached right now, for tests. */
export function getUsageCacheSize(): number {
  return usageFileCache.size
}

/** Marks a cache hit as most recently used. */
function touchCacheEntry(key: string, entry: UsageCacheEntry): void {
  usageFileCache.delete(key)
  usageFileCache.set(key, entry)
}

/** Stores one file, evicting the least recently used files past the cap. */
function storeCacheEntry(key: string, entry: UsageCacheEntry): void {
  if (usageFileCache.has(key)) usageFileCache.delete(key)
  usageFileCache.set(key, entry)
  while (usageFileCache.size > USAGE_CACHE_MAX_FILES) {
    const oldest = usageFileCache.keys().next()
    if (oldest.done) break
    usageFileCache.delete(oldest.value)
  }
}

/** Builds the line handler that buckets one Claude transcript's tokens by day. */
function claudeLineToDays(days: Map<string, number>): LineHandler {
  return (line, mtime) => {
    const message = record(line['message'])
    const usage = message ? record(message['usage']) : null
    if (!usage) return
    const tokens =
      num(usage['input_tokens']) + num(usage['output_tokens']) + num(usage['cache_creation_input_tokens'])
    if (tokens <= 0) return
    addTokens(days, dayKey(epochMs(line['timestamp']) ?? mtime), tokens)
  }
}

/**
 * Reads one Claude transcript, using the cache when its size and modified time match.
 * An unchanged file is not opened again. A missing file drops out of the cache.
 */
async function readClaudeFileCached(path: string): Promise<{ days: Map<string, number>; ok: boolean }> {
  let size: number
  let mtimeMs: number
  try {
    const info = await nodeFsPromises.stat(path)
    if (!info.isFile()) {
      usageFileCache.delete(path)
      return { days: new Map(), ok: false }
    }
    size = info.size
    mtimeMs = info.mtimeMs
  } catch {
    usageFileCache.delete(path)
    return { days: new Map(), ok: false }
  }
  const hit = usageFileCache.get(path)
  if (hit && hit.kind === 'claude' && hit.size === size && hit.mtimeMs === mtimeMs) {
    touchCacheEntry(path, hit)
    return { days: new Map(hit.days), ok: hit.ok }
  }
  const days = new Map<string, number>()
  const read = await eachJsonLine(path, claudeLineToDays(days))
  if (!read) {
    usageFileCache.delete(path)
    return { days: new Map(), ok: false }
  }
  storeCacheEntry(path, { kind: 'claude', size, mtimeMs, days: [...days], ok: true })
  return { days, ok: true }
}

/**
 * Reads one Codex rollout file, using the cache when its size and modified time match.
 * A changed file is read again in full. A missing file drops out of the cache.
 */
async function readCodexFileCached(
  path: string
): Promise<{ sessionTokens: number; readings: LimitsReading[]; ok: boolean }> {
  let size: number
  let mtimeMs: number
  try {
    const info = await nodeFsPromises.stat(path)
    if (!info.isFile()) {
      usageFileCache.delete(path)
      return { sessionTokens: 0, readings: [], ok: false }
    }
    size = info.size
    mtimeMs = info.mtimeMs
  } catch {
    usageFileCache.delete(path)
    return { sessionTokens: 0, readings: [], ok: false }
  }
  const hit = usageFileCache.get(path)
  if (hit && hit.kind === 'codex' && hit.size === size && hit.mtimeMs === mtimeMs) {
    touchCacheEntry(path, hit)
    return { sessionTokens: hit.sessionTokens, readings: hit.readings.map((r) => ({ ...r })), ok: hit.ok }
  }
  let sessionTokens = 0
  const readings: LimitsReading[] = []
  const read = await eachJsonLine(path, (line, mtime) => {
    const payload = record(line['payload'])
    const info = (payload ? record(payload['info']) : null) ?? record(line['info'])
    const total = info ? record(info['total_token_usage']) : null
    if (total) sessionTokens = num(total['input_tokens']) + num(total['output_tokens'])

    const rateLimits = (payload ? record(payload['rate_limits']) : null) ?? record(line['rate_limits'])
    const primary = rateLimits ? record(rateLimits['primary']) : null
    if (!primary) return
    const secondary = rateLimits ? record(rateLimits['secondary']) : null
    readings.push({
      seenAt: epochMs(line['timestamp']) ?? mtime,
      fiveHourPct: pct(primary['used_percent']),
      fiveHourResetsAt: epochMs(primary['resets_at']),
      weeklyPct: pct(secondary ? secondary['used_percent'] : null),
      weeklyResetsAt: epochMs(secondary ? secondary['resets_at'] : null)
    })
  })
  if (!read) {
    usageFileCache.delete(path)
    return { sessionTokens: 0, readings: [], ok: false }
  }
  storeCacheEntry(path, {
    kind: 'codex',
    size,
    mtimeMs,
    sessionTokens,
    readings: readings.map((r) => ({ ...r })),
    ok: true
  })
  return { sessionTokens, readings, ok: true }
}

/** Claude Code transcripts, one run per transcript, bucketed by the day of each line. */
async function claudeTotals(sessions: SessionInfo[]): Promise<Map<AgentKind, Totals>> {
  const byAgent = new Map<AgentKind, Totals>()
  const seen = new Set<string>()
  for (const session of sessions) {
    const path = session.transcriptPath
    if (!path || seen.has(path)) continue
    seen.add(path)
    const totals = byAgent.get(session.agent) ?? makeTotals()
    byAgent.set(session.agent, totals)
    const cached = await readClaudeFileCached(path)
    for (const [key, value] of cached.days) addTokens(totals.days, key, value)
    if (cached.ok) totals.runs += 1
  }
  return byAgent
}

/** One live limits reading taken from a Codex line, without the agent or its stamp filled in. */
interface LimitsReading {
  seenAt: number
  fiveHourPct: number | null
  fiveHourResetsAt: number | null
  weeklyPct: number | null
  weeklyResetsAt: number | null
}

/**
 * Codex rollout files under the current month, one run per file. The last token count in a file is
 * that session's total. Lines carrying rate limits are kept, and the newest valid one wins.
 */
async function codexTotals(codexHome: string, now: number): Promise<{ totals: Totals; readings: LimitsReading[] }> {
  const totals = makeTotals()
  const readings: LimitsReading[] = []
  const today = new Date(now)
  const year = String(today.getFullYear())
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const monthDir = join(codexHome, 'sessions', year, month)

  let dayNames: string[]
  try {
    const entries = await nodeFsPromises.readdir(monthDir, { withFileTypes: true })
    dayNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return { totals, readings }
  }

  const currentPaths = new Set<string>()
  for (const dayName of dayNames) {
    const key = `${year}-${month}-${dayName.padStart(2, '0')}`
    let files: string[]
    try {
      files = (await nodeFsPromises.readdir(join(monthDir, dayName)))
        .filter((name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))
        .sort()
    } catch {
      continue
    }
    for (const name of files) {
      const full = join(monthDir, dayName, name)
      currentPaths.add(full)
      const cached = await readCodexFileCached(full)
      if (!cached.ok) continue
      totals.runs += 1
      addTokens(totals.days, key, cached.sessionTokens)
      for (const reading of cached.readings) readings.push({ ...reading })
    }
  }
  // Files that are gone drop out of the cache.
  for (const key of [...usageFileCache.keys()]) {
    if (key.startsWith(`${monthDir}/`) && !currentPaths.has(key)) usageFileCache.delete(key)
  }
  return { totals, readings }
}

/** Turns one CLI's totals into the card the Usage section draws. */
function toAgentUsage(agent: AgentKind, totals: Totals, now: number): AgentUsage {
  const keys = recentDays(now, DAILY_DAYS)
  const today = keys[keys.length - 1] ?? dayKey(now)
  const monthPrefix = `${today.slice(0, 7)}-`
  let tokensMonth = 0
  for (const [key, value] of totals.days) {
    if (key.startsWith(monthPrefix)) tokensMonth += value
  }
  return {
    agent,
    runs: totals.runs,
    tokensToday: totals.days.get(today) ?? 0,
    tokensMonth,
    daily: keys.map((key) => totals.days.get(key) ?? 0),
    reported: true
  }
}

/**
 * Adds up tokens per agent and reads Codex's live limits from the files on this computer. Nothing
 * here calls a provider: an unreadable or missing file is skipped, never thrown.
 */
export async function readUsage(deps: UsageDeps): Promise<UsageSummary> {
  const now = deps.now ? deps.now() : Date.now()
  const agents: AgentUsage[] = []
  const limits: LiveLimits[] = []
  try {
    for (const [agent, totals] of await claudeTotals(deps.sessions())) {
      if (totals.runs > 0) agents.push(toAgentUsage(agent, totals, now))
    }
    const ownHome = resolve(deps.home(), '.codex')
    const codex = await codexTotals(ownHome, now)
    // Runs on a saved sign-in write their files in its own folder; their tokens count too. Live limits
    // stay those of the computer's own sign-in.
    for (const dir of new Set((deps.codexHomes?.() ?? []).map((d) => resolve(d)))) {
      if (dir === ownHome) continue
      const saved = await codexTotals(dir, now)
      codex.totals.runs += saved.totals.runs
      for (const [key, tokens] of saved.totals.days) addTokens(codex.totals.days, key, tokens)
    }
    if (codex.totals.runs > 0) agents.push(toAgentUsage('codex', codex.totals, now))
    let newest: LimitsReading | null = null
    for (const reading of codex.readings) {
      if (!newest || reading.seenAt >= newest.seenAt) newest = reading
    }
    if (newest) {
      limits.push({
        agent: 'codex',
        fiveHourPct: newest.fiveHourPct,
        fiveHourResetsAt: newest.fiveHourResetsAt,
        weeklyPct: newest.weeklyPct,
        weeklyResetsAt: newest.weeklyResetsAt,
        seenAt: newest.seenAt
      })
    }
  } catch {
    return { agents: [], limits: [], checkedAt: now }
  }
  agents.sort((a, b) => AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent))
  return { agents, limits, checkedAt: now }
}
