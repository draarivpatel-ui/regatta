// Usage sums from fake CLI records in a temp home folder.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo, SessionStatus } from '../shared/types'
import {
  __getUsageFileReads,
  __resetUsageFileReads,
  __usageFileCache,
  USAGE_CACHE_MAX_FILES,
  clearUsageCache,
  getUsageCacheSize,
  readUsage,
  type UsageDeps
} from './usage'

/** A fixed clock, so day buckets and the 14 day window never move with the real date. */
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime()
const HOUR = 3600_000
const DAY = 24 * HOUR

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

const folders: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-usage-'))
  folders.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true })
})

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const status: SessionStatus = { state: 'idle', since: NOW, reason: 'ready', source: 'hook' }
  return {
    id: 's1',
    agent: 'claude',
    title: 'Claude',
    cwd: '/work/repo',
    command: 'claude',
    args: [],
    createdAt: NOW - DAY,
    pid: 42,
    status,
    exitCode: null,
    signals: 'hooks',
    worktree: null,
    branch: null,
    limit: null,
    transcriptPath: null,
    account: null,
    ...overrides
  }
}

function deps(overrides: Partial<UsageDeps> = {}): UsageDeps {
  return {
    sessions: () => [],
    home: () => tempHome(),
    now: () => NOW,
    ...overrides
  }
}

function writeLines(path: string, lines: unknown[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
}

/** A Claude transcript: three usage lines, two today and one yesterday, plus a line with no usage. */
function claudeTranscript(dir: string, name: string): string {
  const path = join(dir, 'projects', 'repo', `${name}.jsonl`)
  writeLines(path, [
    { type: 'user', timestamp: iso(NOW - 2 * HOUR), message: { role: 'user', content: 'hello' } },
    { type: 'assistant', timestamp: iso(NOW - 2 * HOUR), message: { usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 250 } } },
    { type: 'assistant', timestamp: iso(NOW - HOUR), message: { usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: 'assistant', timestamp: iso(NOW - DAY), message: { usage: { input_tokens: 200, output_tokens: 100 } } }
  ])
  return path
}

/** A Codex rollout file under the month folder for NOW. */
function rollout(month: string, day: string, name: string, lines: unknown[], home: string): void {
  const dir = join(home, '.codex', 'sessions', month.split('-')[0]!, month.split('-')[1]!, day)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
}

describe('readUsage', () => {
  it('adds up Claude tokens per day and counts one run per transcript', async () => {
    const home = tempHome()
    const path = claudeTranscript(home, 'session-1')
    const summary = await readUsage(deps({ sessions: () => [makeSession({ transcriptPath: path })], home: () => home }))

    expect(summary.checkedAt).toBe(NOW)
    expect(summary.limits).toEqual([])
    const claude = summary.agents.find((a) => a.agent === 'claude')
    expect(claude).toBeDefined()
    expect(claude!.reported).toBe(true)
    expect(claude!.runs).toBe(1)
    // input + output + cache_creation, and a missing number counts as 0.
    expect(claude!.tokensToday).toBe(1000 + 500 + 250 + 10 + 5)
    expect(claude!.tokensMonth).toBe(200 + 100 + 1000 + 500 + 250 + 10 + 5)
    expect(claude!.daily).toHaveLength(14)
    expect(claude!.daily[13]).toBe(claude!.tokensToday)
    expect(claude!.daily[12]).toBe(300)
    expect(claude!.daily.slice(0, 12)).toEqual(new Array(12).fill(0))
  })

  it('skips a transcript that is not there and reports nothing when none can be read', async () => {
    const home = tempHome()
    const summary = await readUsage(
      deps({ sessions: () => [makeSession({ transcriptPath: join(home, 'projects', 'missing.jsonl') })], home: () => home })
    )
    expect(summary.agents).toEqual([])
    expect(summary.limits).toEqual([])
  })

  it('reads Codex rollout files for the current month, one run per file', async () => {
    const home = tempHome()
    rollout('2026-06', '14', 'rollout-a.jsonl', [
      { timestamp: iso(NOW - DAY - HOUR), payload: { info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } } } },
      { timestamp: iso(NOW - DAY), payload: { info: { total_token_usage: { input_tokens: 400, output_tokens: 50 } } } }
    ], home)
    rollout('2026-06', '15', 'rollout-b.jsonl', [
      { timestamp: iso(NOW - 20 * HOUR), payload: { info: { total_token_usage: { input_tokens: 5, output_tokens: 5 } } } }
    ], home)
    // Last month is not read at all.
    rollout('2026-05', '30', 'rollout-old.jsonl', [
      { payload: { info: { total_token_usage: { input_tokens: 99999, output_tokens: 99999 } } } }
    ], home)

    const summary = await readUsage(deps({ home: () => home }))
    const codex = summary.agents.find((a) => a.agent === 'codex')
    expect(codex).toBeDefined()
    expect(codex!.reported).toBe(true)
    expect(codex!.runs).toBe(2)
    // The last token count in a file is that session's total.
    expect(codex!.tokensToday).toBe(10)
    expect(codex!.daily[12]).toBe(450)
    expect(codex!.daily[13]).toBe(10)
    expect(codex!.tokensMonth).toBe(460)
  })

  it('takes live limits from the newest valid line and reads both reset time formats', async () => {
    const home = tempHome()
    const fiveHourMs = NOW + 2 * HOUR + 10 * 60_000
    const weeklySeconds = Math.round((NOW + 3 * DAY) / 1000)
    // The newest line with rate limits has primary: null, so it is skipped.
    const skipStamp = NOW - 30 * 60_000
    const validStamp = NOW - 60 * 60_000
    rollout('2026-06', '15', 'rollout-b.jsonl', [
      { timestamp: iso(validStamp), payload: { rate_limits: { primary: { used_percent: 42, resets_at: fiveHourMs }, secondary: { used_percent: 17, resets_at: weeklySeconds } } } },
      { timestamp: iso(skipStamp), payload: { rate_limits: { primary: null, secondary: { used_percent: 90 } } } }
    ], home)

    const summary = await readUsage(deps({ home: () => home }))
    expect(summary.limits).toHaveLength(1)
    expect(summary.limits[0]).toEqual({
      agent: 'codex',
      fiveHourPct: 42,
      fiveHourResetsAt: fiveHourMs,
      weeklyPct: 17,
      weeklyResetsAt: weeklySeconds * 1000,
      seenAt: validStamp
    })
  })

  it('falls back to the file modified time when a limits line has no timestamp', async () => {
    const home = tempHome()
    const rolloutDir = join(home, '.codex', 'sessions', '2026', '06', '15')
    mkdirSync(rolloutDir, { recursive: true })
    const path = join(rolloutDir, 'rollout-c.jsonl')
    writeFileSync(
      path,
      `${JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 7, resets_at: iso(NOW + HOUR) } } } })}\n`,
      'utf8'
    )
    const summary = await readUsage(deps({ home: () => home }))
    expect(summary.limits[0]!.fiveHourPct).toBe(7)
    expect(summary.limits[0]!.weeklyPct).toBeNull()
    expect(summary.limits[0]!.weeklyResetsAt).toBeNull()
    expect(summary.limits[0]!.fiveHourResetsAt).toBe(NOW + HOUR)
    expect(summary.limits[0]!.seenAt).toBeGreaterThan(0)
  })

  it('never throws when the home folder cannot be read', async () => {
    const summary = await readUsage(deps({ home: () => join(tempHome(), 'no-such-home') }))
    expect(summary).toEqual({ agents: [], limits: [], checkedAt: NOW })
  })
})

describe('usage cache', () => {
  beforeEach(() => {
    clearUsageCache()
  })

  it('does not open unchanged transcript files on a second read', async () => {
    const home = tempHome()
    const path = claudeTranscript(home, 'session-cache-1')
    const d = deps({ sessions: () => [makeSession({ transcriptPath: path })], home: () => home })

    __resetUsageFileReads()
    const first = await readUsage(d)
    expect(__getUsageFileReads()).toBeGreaterThan(0)
    const claudeFirst = first.agents.find((a) => a.agent === 'claude')
    expect(claudeFirst?.runs).toBe(1)

    __resetUsageFileReads()
    const second = await readUsage(d)
    expect(__getUsageFileReads()).toBe(0)
    expect(second).toEqual(first)
  })

  it('does not open unchanged Codex rollout files on a second read', async () => {
    const home = tempHome()
    rollout('2026-06', '15', 'rollout-cache.jsonl', [
      { timestamp: iso(NOW - HOUR), payload: { info: { total_token_usage: { input_tokens: 30, output_tokens: 7 } } } }
    ], home)
    const d = deps({ home: () => home })

    await readUsage(d)
    __resetUsageFileReads()
    const first = await readUsage(d)
    expect(__getUsageFileReads()).toBe(0)
    const second = await readUsage(d)
    expect(second).toEqual(first)
    expect(first.agents.find((a) => a.agent === 'codex')?.tokensToday).toBe(37)
  })

  it('picks up an appended line on the next read', async () => {
    const home = tempHome()
    const path = claudeTranscript(home, 'session-cache-2')
    const d = deps({ sessions: () => [makeSession({ transcriptPath: path })], home: () => home })

    const first = await readUsage(d)
    const before = first.agents.find((a) => a.agent === 'claude')!.tokensToday

    appendFileSync(
      path,
      `${JSON.stringify({ type: 'assistant', timestamp: iso(NOW - 30 * 60_000), message: { usage: { input_tokens: 40, output_tokens: 2 } } })}\n`,
      'utf8'
    )
    const second = await readUsage(d)
    expect(second.agents.find((a) => a.agent === 'claude')!.tokensToday).toBe(before + 42)
  })

  it('reads again after a same size rewrite with a new modified time', async () => {
    const home = tempHome()
    const dir = join(home, 'projects', 'repo')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'rewrite.jsonl')
    const stamp = iso(NOW - HOUR)
    const lineA = `${JSON.stringify({ type: 'assistant', timestamp: stamp, message: { usage: { input_tokens: 1000, output_tokens: 500 } } })}\n`
    const lineB = `${JSON.stringify({ type: 'assistant', timestamp: stamp, message: { usage: { input_tokens: 2000, output_tokens: 500 } } })}\n`
    expect(lineB.length).toBe(lineA.length)

    writeFileSync(path, lineA, 'utf8')
    const mtimeA = new Date(NOW - 2 * HOUR)
    utimesSync(path, mtimeA, mtimeA)
    const d = deps({ sessions: () => [makeSession({ transcriptPath: path })], home: () => home })
    const first = await readUsage(d)
    expect(first.agents.find((a) => a.agent === 'claude')!.tokensToday).toBe(1500)
    expect(statSync(path).size).toBe(lineA.length)

    writeFileSync(path, lineB, 'utf8')
    const mtimeB = new Date(NOW - HOUR)
    utimesSync(path, mtimeB, mtimeB)
    expect(statSync(path).size).toBe(lineA.length)
    expect(statSync(path).mtimeMs).toBe(mtimeB.getTime())

    const second = await readUsage(d)
    expect(second.agents.find((a) => a.agent === 'claude')!.tokensToday).toBe(2500)
  })

  it('drops a deleted file from the cache', async () => {
    const home = tempHome()
    const path = claudeTranscript(home, 'session-cache-3')
    const d = deps({ sessions: () => [makeSession({ transcriptPath: path })], home: () => home })

    const first = await readUsage(d)
    expect(first.agents.find((a) => a.agent === 'claude')?.runs).toBe(1)
    expect(__usageFileCache.has(path)).toBe(true)

    unlinkSync(path)
    const second = await readUsage(d)
    expect(second.agents).toEqual([])
    expect(__usageFileCache.has(path)).toBe(false)

    writeLines(path, [
      { type: 'assistant', timestamp: iso(NOW - HOUR), message: { usage: { input_tokens: 7, output_tokens: 1 } } }
    ])
    const third = await readUsage(d)
    expect(third.agents.find((a) => a.agent === 'claude')!.tokensToday).toBe(8)
  })

  it('caps the cache and evicts the least recently used file', async () => {
    expect(USAGE_CACHE_MAX_FILES).toBe(5000)
    const home = tempHome()
    const keepPath = claudeTranscript(home, 'keep')
    const keepDeps = (extra: string[]) =>
      deps({
        sessions: () => [makeSession({ transcriptPath: keepPath }), ...extra.map((p) => makeSession({ id: p, transcriptPath: p }))],
        home: () => home
      })

    await readUsage(keepDeps([]))
    expect(getUsageCacheSize()).toBe(1)

    for (let i = 0; i < USAGE_CACHE_MAX_FILES - 1; i += 1) {
      __usageFileCache.set(`/fake/cache-${i}.jsonl`, { kind: 'claude', size: 1, mtimeMs: 1, days: [], ok: true })
    }
    expect(getUsageCacheSize()).toBe(USAGE_CACHE_MAX_FILES)

    // Touch the real entry so it becomes most recently used.
    await readUsage(keepDeps([]))
    expect(__usageFileCache.has(keepPath)).toBe(true)

    const newPath = claudeTranscript(home, 'newone')
    await readUsage(keepDeps([newPath]))
    expect(getUsageCacheSize()).toBe(USAGE_CACHE_MAX_FILES)
    expect(__usageFileCache.has(newPath)).toBe(true)
    expect(__usageFileCache.has(keepPath)).toBe(true)
    expect(__usageFileCache.has('/fake/cache-0.jsonl')).toBe(false)
    expect(__usageFileCache.has('/fake/cache-1.jsonl')).toBe(true)
  })
})
