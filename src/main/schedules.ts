// Runs schedules while the app is open.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NewSchedule, Schedule, ScheduleEvery } from '../shared/schedules'
import { nextRunAfter } from '../shared/schedules'

const TICK_MS = 30_000
const MAX_RUNS = 20

export interface ScheduleEngineDeps {
  /** App data folder: <dataDir>/schedules.json. */
  dataDir: string
  /** Starts a new conversation with the crew member and sends the prompt; resolves once it has started. */
  runCrew: (teammateId: string, prompt: string) => Promise<{ conversationId: string }>
  /** Starts a run of the flow; resolves once it has started. */
  runFlow: (flowId: string) => Promise<{ flowRunId: string }>
  emit: (schedules: Schedule[]) => void
  now?: () => number
}

export class ScheduleEngine {
  private schedules: Schedule[] = []
  private timer: NodeJS.Timeout | null = null
  private readonly running = new Set<string>()

  constructor(private readonly deps: ScheduleEngineDeps) {
    this.schedules = loadFromDisk(deps.dataDir)
  }

  list(): Schedule[] {
    return this.schedules.map(clone)
  }

  save(schedule: NewSchedule): Schedule[] {
    const now = this.clock()
    const name = (schedule.name ?? '').trim()
    if (!name) throw new Error('Give the schedule a name.')
    if (name.length > 60) throw new Error('Keep the name to 60 characters or fewer.')
    const target = schedule.target
    if (!target || (target.kind !== 'crew' && target.kind !== 'flow')) throw new Error('Pick what this schedule runs.')
    if (target.kind === 'crew') {
      if (!target.teammateId || !target.teammateId.trim()) throw new Error('Pick a crew member.')
      const prompt = target.prompt ?? ''
      if (!prompt.trim()) throw new Error('Write a prompt for the crew member.')
      if (prompt.length > 4000) throw new Error('Keep the prompt to 4,000 characters or fewer.')
    } else {
      if (!target.flowId || !target.flowId.trim()) throw new Error('Pick a flow.')
    }
    let every: ScheduleEvery
    try {
      every = normalizeEvery(schedule.every)
      // Validates; throws with a friendly message on a bad schedule.
      nextRunAfter(every, now)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }

    const existing = schedule.id ? this.schedules.find((s) => s.id === schedule.id) : undefined
    if (existing) {
      const everyChanged = JSON.stringify(existing.every) !== JSON.stringify(every)
      const wasOn = existing.enabled
      const on = Boolean(schedule.enabled)
      let nextRunAt = existing.nextRunAt
      if (!on) nextRunAt = null
      else if (!wasOn || everyChanged || nextRunAt == null) nextRunAt = nextRunAfter(every, now)
      const next: Schedule = {
        ...existing,
        name,
        target: cloneTarget(target),
        every: cloneEvery(every),
        enabled: on,
        nextRunAt
      }
      this.schedules = this.schedules.map((s) => (s.id === existing.id ? next : s))
    } else {
      const next: Schedule = {
        id: shortId(),
        name,
        target: cloneTarget(target),
        every: cloneEvery(every),
        enabled: Boolean(schedule.enabled),
        createdAt: now,
        nextRunAt: schedule.enabled ? nextRunAfter(every, now) : null,
        runs: []
      }
      this.schedules = [...this.schedules, next]
    }
    this.persist()
    return this.list()
  }

  remove(id: string): Schedule[] {
    this.schedules = this.schedules.filter((s) => s.id !== id)
    this.persist()
    return this.list()
  }

  async runNow(id: string): Promise<Schedule[]> {
    const found = this.schedules.find((s) => s.id === id)
    if (!found) throw new Error('That schedule is no longer here.')
    if (this.running.has(id)) return this.list()
    await this.execute(found, false)
    return this.list()
  }

  /** Begins checking the clock (and catches up on a run missed while the app was closed). */
  start(): void {
    if (this.timer) return
    // A schedule whose next run passed while the app was closed runs once now.
    void this.tick(true)
    this.timer = setInterval(() => {
      void this.tick(false)
    }, TICK_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(caughtUp: boolean): Promise<void> {
    const now = this.clock()
    const due = this.schedules.filter((s) => s.enabled && s.nextRunAt != null && s.nextRunAt <= now && !this.running.has(s.id))
    for (const schedule of due) {
      // Sequential so one slow start does not pile up; the running set skips overlaps.
      await this.execute(schedule, caughtUp)
    }
  }

  private async execute(schedule: Schedule, caughtUp: boolean): Promise<void> {
    const current = this.schedules.find((s) => s.id === schedule.id)
    if (!current) return
    if (this.running.has(current.id)) return
    this.running.add(current.id)
    try {
      if (current.target.kind === 'crew') {
        const { conversationId } = await this.deps.runCrew(current.target.teammateId, current.target.prompt)
        this.record(current.id, {
          at: this.clock(),
          ok: true,
          note: caughtUp ? 'Caught up after Regatta was closed' : 'Started a conversation',
          conversationId,
          flowRunId: null
        })
      } else {
        const { flowRunId } = await this.deps.runFlow(current.target.flowId)
        this.record(current.id, {
          at: this.clock(),
          ok: true,
          note: caughtUp ? 'Caught up after Regatta was closed' : 'Started a flow run',
          conversationId: null,
          flowRunId
        })
      }
    } catch (err) {
      this.record(current.id, {
        at: this.clock(),
        ok: false,
        note: messageOf(err),
        conversationId: null,
        flowRunId: null
      })
    } finally {
      this.running.delete(current.id)
    }
  }

  private record(id: string, run: Schedule['runs'][number]): void {
    const now = this.clock()
    this.schedules = this.schedules.map((s) => {
      if (s.id !== id) return s
      let nextRunAt: number | null
      try {
        nextRunAt = s.enabled ? nextRunAfter(s.every, now) : null
      } catch {
        nextRunAt = s.nextRunAt
      }
      return { ...s, runs: [run, ...s.runs].slice(0, MAX_RUNS), nextRunAt }
    })
    this.persist()
  }

  private persist(): void {
    saveToDisk(this.deps.dataDir, this.schedules)
    this.deps.emit(this.list())
  }

  private clock(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }
}

function loadFromDisk(dataDir: string): Schedule[] {
  const file = join(dataDir, 'schedules.json')
  if (!existsSync(file)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    const out: Schedule[] = []
    for (const raw of parsed) {
      const schedule = sanitize(raw)
      if (schedule) out.push(schedule)
    }
    return out
  } catch {
    return []
  }
}

function saveToDisk(dataDir: string, schedules: Schedule[]): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    const file = join(dataDir, 'schedules.json')
    const tmp = join(dataDir, `schedules.json.tmp-${process.pid}`)
    writeFileSync(tmp, JSON.stringify(schedules, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // The schedules still work while the app is open.
  }
}

function sanitize(raw: unknown): Schedule | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = typeof r['id'] === 'string' && r['id'] ? r['id'] : null
  const name = typeof r['name'] === 'string' ? r['name'] : null
  if (!id || !name) return null
  const target = r['target'] as Schedule['target'] | undefined
  if (!target || (target.kind !== 'crew' && target.kind !== 'flow')) return null
  if (target.kind === 'crew' && (typeof target.teammateId !== 'string' || typeof target.prompt !== 'string')) return null
  if (target.kind === 'flow' && typeof target.flowId !== 'string') return null
  const every = r['every'] as ScheduleEvery | undefined
  if (!every || (every.kind !== 'hours' && every.kind !== 'daily' && every.kind !== 'weekly')) return null
  const createdAt = typeof r['createdAt'] === 'number' && Number.isFinite(r['createdAt']) ? r['createdAt'] : Date.now()
  const nextRunAt = r['nextRunAt'] == null ? null : typeof r['nextRunAt'] === 'number' && Number.isFinite(r['nextRunAt']) ? r['nextRunAt'] : null
  const runs = Array.isArray(r['runs']) ? (r['runs'] as Schedule['runs']).filter(isRun).slice(0, MAX_RUNS) : []
  return {
    id,
    name,
    target: cloneTarget(target),
    every: cloneEvery(every),
    enabled: r['enabled'] === true,
    createdAt,
    nextRunAt,
    runs
  }
}

function isRun(raw: unknown): raw is Schedule['runs'][number] {
  if (typeof raw !== 'object' || raw === null) return false
  const r = raw as Record<string, unknown>
  return typeof r['at'] === 'number' && typeof r['ok'] === 'boolean' && typeof r['note'] === 'string'
}

function normalizeEvery(every: ScheduleEvery): ScheduleEvery {
  if (!every || typeof every !== 'object') throw new Error('Pick how often this runs.')
  if (every.kind === 'hours') {
    const hours = (every as { hours?: unknown }).hours
    if (!Number.isInteger(hours) || (hours as number) < 1 || (hours as number) > 24) {
      throw new Error('Pick 1 to 24 hours.')
    }
    return { kind: 'hours', hours: hours as number }
  }
  if (every.kind === 'daily') {
    const time = (every as { time?: unknown }).time
    if (typeof time !== 'string' || !time) throw new Error('Pick a time like 09:30.')
    return { kind: 'daily', time }
  }
  if (every.kind === 'weekly') {
    const t = every as { day?: unknown; time?: unknown }
    if (!Number.isInteger(t.day) || (t.day as number) < 0 || (t.day as number) > 6) throw new Error('Pick a day of the week.')
    if (typeof t.time !== 'string' || !t.time) throw new Error('Pick a time like 09:30.')
    return { kind: 'weekly', day: t.day as number, time: t.time as string }
  }
  throw new Error('Pick how often this runs.')
}

function cloneTarget(target: Schedule['target']): Schedule['target'] {
  return target.kind === 'crew'
    ? { kind: 'crew', teammateId: target.teammateId, prompt: target.prompt }
    : { kind: 'flow', flowId: target.flowId }
}

function cloneEvery(every: ScheduleEvery): ScheduleEvery {
  if (every.kind === 'hours') return { kind: 'hours', hours: every.hours }
  if (every.kind === 'daily') return { kind: 'daily', time: every.time }
  return { kind: 'weekly', day: every.day, time: every.time }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Lowercase letters and digits, short enough to read. */
function shortId(length = 8): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789'
  let id = ''
  for (let i = 0; i < length; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)]
  return id
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
