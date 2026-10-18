// Tasks: outcomes handed to an agent or a crew member, saved in <dataDir>/tasks.json.
// A run is a hand-off heat (the lead, then its backups), so a task follows its heat's heat.
// See docs/design/heats.md "Tasks".

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS } from '../shared/agents'
import type { CheckSpec, HeatState } from '../shared/heats'
import type { StartHeatOptions } from '../shared/ipc'
import type { AgentKind } from '../shared/types'
import type { Skill, Teammate } from '../shared/chat'
import type { NewTask, Task, TaskPatch, TaskStatus } from '../shared/tasks'
import { EDITABLE_STATUSES, statusFromHeat } from '../shared/tasks'
import { teammateInstructions } from './chat/args'

/** The minutes one attempt may take, and the overall limit: a task left one agent plus its backups. */
const ATTEMPT_LIMIT_MIN = 15
const STOPPED_ON_RESTART_NOTE = 'Stopped when Regatta closed before its heat finished.'

export interface TaskStoreDeps {
  /** App data folder: <dataDir>/tasks.json. */
  dataDir: string
  /** Starts the hand-off heat a run begins; resolves with the heat that started. */
  startHeat: (opts: StartHeatOptions) => Promise<{ id: string }>
  /** Heats still in memory, so a restart or check knows whether a running or review task still has its heat. */
  heats?: () => Array<{ id: string }>
  /** Night watch: addToTonight puts the task in tonight's queue. */
  night: { addTask: (task: { prompt: string; agent: AgentKind; checks: CheckSpec[] }) => unknown }
  /** The crew members, so a crew assignee's instructions can go before its prompt. */
  teammates: () => Teammate[]
  /** The skills from Settings > Skills, which a crew member's own list picks from. */
  skills: () => Skill[]
  emit: (tasks: Task[]) => void
  now?: () => number
}

export class TaskStore {
  private tasks: Task[] = []
  private readonly starting = new Set<string>()
  private readonly sessionHeats = new Set<string>()
  private readonly seenInHeats = new Set<string>()

  constructor(private readonly deps: TaskStoreDeps) {
    const loaded = loadFromDisk(deps.dataDir, this.recordSeenHeats(), this.clock())
    this.tasks = loaded.tasks
    if (loaded.changed) saveToDisk(deps.dataDir, this.tasks)
  }

  list(): Task[] {
    this.reconcileHeats()
    return this.tasks.map(clone)
  }

  get(id: string): Task | undefined {
    this.reconcileHeats()
    const found = this.tasks.find((task) => task.id === id)
    return found ? clone(found) : undefined
  }

  create(input: NewTask, createdBy: Task['createdBy']): Task[] {
    const now = this.clock()
    const clean = validate(input)
    const task: Task = {
      id: shortId(),
      ...clean,
      status: 'todo',
      heatId: null,
      createdBy,
      createdAt: now,
      updatedAt: now
    }
    this.tasks = [task, ...this.tasks]
    this.persist()
    return this.list()
  }

  /** Only the words and the plan change, and only while nobody is working on the task. */
  update(id: string, patch: TaskPatch): Task[] {
    this.reconcileHeats()
    if (this.starting.has(id)) throw new Error('That task is already starting.')
    const found = this.tasks.find((task) => task.id === id)
    if (!found) throw new Error('That task is no longer here.')
    if (
      found.status === 'review' &&
      typeof patch.note === 'string' &&
      patch.note.trim().length > 0 &&
      patch.title === undefined &&
      patch.prompt === undefined &&
      patch.assignee === undefined &&
      patch.backups === undefined &&
      patch.checks === undefined
    ) {
      return this.sendBack(id, patch.note)
    }
    if (!isEditable(found.status)) throw new Error('A task can be edited only while it is to do, failed or stopped.')
    const merged = validate({
      title: patch.title ?? found.title,
      prompt: patch.prompt ?? found.prompt,
      assignee: patch.assignee ?? found.assignee,
      backups: patch.backups ?? found.backups,
      checks: patch.checks ?? found.checks,
      note: patch.note ?? found.note
    })
    this.tasks = this.tasks.map((task) =>
      task.id === id ? { ...task, ...merged, updatedAt: this.clock() } : task
    )
    this.persist()
    return this.list()
  }

  /** Sends a task waiting for review back to To do with a note for its next run. */
  sendBack(id: string, note: string): Task[] {
    this.reconcileHeats()
    if (this.starting.has(id)) throw new Error('That task is already starting.')
    const found = this.tasks.find((task) => task.id === id)
    if (!found) throw new Error('That task is no longer here.')
    if (found.status === 'running') throw new Error('Stop its heat first: a running task cannot be sent back.')
    if (found.status === 'done') throw new Error('A finished task cannot be sent back.')
    const cleanNote = (note ?? '').trim() || found.note.trim()
    if (!cleanNote) throw new Error('Write a note for the next run.')
    if (cleanNote.length > 4000) throw new Error('Keep the note to 4,000 characters or fewer.')
    const now = this.clock()
    this.tasks = this.tasks.map((task) =>
      task.id === id ? { ...task, status: 'todo', note: cleanNote, updatedAt: now } : task
    )
    this.persist()
    return this.list()
  }

  remove(id: string): Task[] {
    this.reconcileHeats()
    if (this.starting.has(id)) throw new Error('That task is already starting.')
    const found = this.tasks.find((task) => task.id === id)
    if (!found) return this.list()
    if (found.status === 'running') throw new Error('Stop its heat first: a running task cannot be removed.')
    if (found.status === 'review') throw new Error('Merge it or mark it done first.')
    this.tasks = this.tasks.filter((task) => task.id !== id)
    this.persist()
    return this.list()
  }

  /** Starts a hand-off: the assignee leads, the backups follow. Refused unless the task is waiting. */
  async run(id: string): Promise<Task[]> {
    this.reconcileHeats()
    if (this.starting.has(id)) throw new Error('That task is already starting.')
    const found = this.tasks.find((task) => task.id === id)
    if (!found) throw new Error('That task is no longer here.')
    if (!isEditable(found.status)) throw new Error('That task is already running, waiting for review or done.')
    if (found.checks.length === 0) throw new Error('Give the task at least one check before running it.')
    const lead = this.leadOf(found)
    const order = [lead, ...found.backups]
    const prompt = this.promptFor(found)
    const previous = {
      status: found.status,
      heatId: found.heatId,
      note: found.note,
      updatedAt: found.updatedAt
    }
    this.starting.add(id)
    const startedAt = this.clock()
    this.tasks = this.tasks.map((task) =>
      task.id === id ? { ...task, status: 'running', note: '', updatedAt: startedAt } : task
    )
    try {
      const heat = await this.deps.startHeat({
        mode: 'handoff',
        task: prompt,
        agents: order,
        order,
        checks: found.checks.map((check) => ({ ...check })),
        setup: '',
        timeLimitMin: ATTEMPT_LIMIT_MIN,
        attemptLimitMin: ATTEMPT_LIMIT_MIN,
        overallLimitMin: null,
        askBeforeNext: false,
        allowCommands: false
      })
      this.sessionHeats.add(heat.id)
      const now = this.clock()
      this.tasks = this.tasks.map((task) =>
        task.id === id ? { ...task, status: 'running', heatId: heat.id, note: '', updatedAt: now } : task
      )
      this.persist()
      return this.list()
    } catch (err) {
      this.tasks = this.tasks.map((task) =>
        task.id === id ? { ...task, ...previous } : task
      )
      throw err
    } finally {
      this.starting.delete(id)
    }
  }

  /** Only a person marks a task done, with or without merging the heat. */
  markDone(id: string): Task[] {
    this.reconcileHeats()
    if (this.starting.has(id)) throw new Error('That task is already starting.')
    const found = this.tasks.find((task) => task.id === id)
    if (!found) throw new Error('That task is no longer here.')
    if (found.status === 'running') throw new Error('A running task cannot be marked done: stop its heat first.')
    if (found.status === 'done') return this.list()
    this.tasks = this.tasks.map((task) =>
      task.id === id ? { ...task, status: 'done', updatedAt: this.clock() } : task
    )
    this.persist()
    return this.list()
  }

  /** Puts the same work in tonight's queue: same prompt, same lead, same checks. */
  addToTonight(id: string): Task[] {
    const found = this.tasks.find((task) => task.id === id)
    if (!found) throw new Error('That task is no longer here.')
    const lead = this.leadOf(found)
    this.deps.night.addTask({
      prompt: this.promptFor(found),
      agent: lead,
      checks: found.checks.map((check) => ({ ...check }))
    })
    return this.list()
  }

  /** Called on every heats:update: a task rides its heat's status. */
  onHeat(heat: HeatState): void {
    this.sessionHeats.add(heat.id)
    let changed = false
    const now = this.clock()
    this.tasks = this.tasks.map((task) => {
      if (!task.heatId || task.heatId !== heat.id) return task
      const next = statusFromHeat(heat, task.status)
      if (next === task.status) return task
      changed = true
      return { ...task, status: next, updatedAt: now }
    })
    // Heats push often; the file and the renderer only see a change that moved a task.
    if (changed) this.persist()
  }

  /** The agent that leads the heat for this task. */
  private leadOf(task: Task): AgentKind {
    const assignee = task.assignee
    if (assignee.kind === 'agent') return assignee.agent
    const mate = this.deps.teammates().find((t) => t.id === assignee.teammateId)
    if (!mate) throw new Error('That crew member no longer exists.')
    return mate.agent
  }

  /** The text handed to the agents: a crew member is told about itself first, as Chat does. */
  private promptFor(task: Task): string {
    const assignee = task.assignee
    let base = task.prompt
    if (assignee.kind === 'crew') {
      const mate = this.deps.teammates().find((t) => t.id === assignee.teammateId)
      if (!mate) throw new Error('That crew member no longer exists.')
      const instructions = teammateInstructions(mate, this.deps.skills())
      base = `${instructions}\n\n${task.prompt}`
    }
    const note = task.note.trim()
    if (!note || note === STOPPED_ON_RESTART_NOTE) return base
    return `${base}\n\nNote from your review: ${note}`
  }

  private recordSeenHeats(): Set<string> {
    const live = new Set<string>()
    for (const heat of this.deps.heats?.() ?? []) {
      live.add(heat.id)
      this.seenInHeats.add(heat.id)
    }
    return live
  }

  /** A review task keeps review only while its heat exists. */
  private reconcileHeats(): void {
    if (!this.deps.heats) return
    const live = this.recordSeenHeats()
    let changed = false
    const now = this.clock()
    this.tasks = this.tasks.map((task) => {
      if (task.status !== 'review') return task
      const hasHeat =
        task.heatId !== null &&
        (live.has(task.heatId) || (this.sessionHeats.has(task.heatId) && !this.seenInHeats.has(task.heatId)))
      if (hasHeat) return task
      changed = true
      return { ...task, status: 'stopped', updatedAt: now }
    })
    if (changed) this.persist()
  }

  private persist(): void {
    saveToDisk(this.deps.dataDir, this.tasks)
    this.deps.emit(this.list())
  }

  private clock(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }
}

function isEditable(status: TaskStatus): boolean {
  return EDITABLE_STATUSES.includes(status)
}

function validate(input: NewTask): NewTask {
  const title = (input.title ?? '').trim()
  const prompt = (input.prompt ?? '').trim()
  const note = (input.note ?? '').trim()
  if (!title) throw new Error('Give the task a title.')
  if (title.length > 120) throw new Error('Keep the title to 120 characters or fewer.')
  if (!prompt) throw new Error('Write what the task is for.')
  if (prompt.length > 4000) throw new Error('Keep the prompt to 4,000 characters or fewer.')
  const assignee = input.assignee
  if (!assignee || (assignee.kind !== 'agent' && assignee.kind !== 'crew')) throw new Error('Pick an agent or a crew member.')
  if (assignee.kind === 'agent') {
    if (!AGENTS[assignee.agent]) throw new Error('Pick an agent Regatta knows.')
  } else if (!assignee.teammateId || !assignee.teammateId.trim()) {
    throw new Error('Pick a crew member.')
  }
  const backups = Array.isArray(input.backups) ? [...new Set(input.backups)] : []
  for (const kind of backups) if (!AGENTS[kind]) throw new Error('Pick agents Regatta knows.')
  if (backups.length > 3) throw new Error('Take at most three backups (four attempts in all).')
  const checks = (Array.isArray(input.checks) ? input.checks : []).map((check) => ({
    name: (check.name ?? '').trim(),
    command: (check.command ?? '').trim(),
    kind: check.kind === 'guard' ? ('guard' as const) : ('required' as const)
  }))
  for (const check of checks) if (!check.name || !check.command) throw new Error('Give each check a name and a command.')
  const names = new Set<string>()
  for (const check of checks) {
    if (names.has(check.name)) throw new Error(`Two checks share the name ${check.name}.`)
    names.add(check.name)
  }
  return {
    title,
    prompt,
    assignee:
      assignee.kind === 'agent'
        ? { kind: 'agent', agent: assignee.agent }
        : { kind: 'crew', teammateId: assignee.teammateId.trim() },
    backups,
    checks,
    note
  }
}

function loadFromDisk(dataDir: string, liveHeats: ReadonlySet<string>, now: number): { tasks: Task[]; changed: boolean } {
  const file = join(dataDir, 'tasks.json')
  if (!existsSync(file)) return { tasks: [], changed: false }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return { tasks: [], changed: false }
    const out: Task[] = []
    let changed = false
    for (const raw of parsed) {
      const task = sanitize(raw)
      if (!task) continue
      const hasHeat = task.heatId !== null && liveHeats.has(task.heatId)
      if (task.status === 'running' && !hasHeat) {
        changed = true
        out.push({
          ...task,
          status: 'stopped',
          note: task.note ? `${task.note} (${STOPPED_ON_RESTART_NOTE})` : STOPPED_ON_RESTART_NOTE,
          updatedAt: now
        })
      } else if (task.status === 'review' && !hasHeat) {
        changed = true
        out.push({
          ...task,
          status: 'stopped',
          updatedAt: now
        })
      } else {
        out.push(task)
      }
    }
    return { tasks: out, changed }
  } catch {
    return { tasks: [], changed: false }
  }
}

function saveToDisk(dataDir: string, tasks: Task[]): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    const file = join(dataDir, 'tasks.json')
    const tmp = join(dataDir, `tasks.json.tmp-${process.pid}`)
    writeFileSync(tmp, JSON.stringify(tasks, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // The tasks still work while the app is open.
  }
}

function sanitize(raw: unknown): Task | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = typeof r['id'] === 'string' && r['id'] ? r['id'] : null
  const title = typeof r['title'] === 'string' ? r['title'] : null
  const prompt = typeof r['prompt'] === 'string' ? r['prompt'] : null
  if (!id || title === null || prompt === null) return null
  const status = r['status'] as TaskStatus | undefined
  if (!status || !['todo', 'running', 'review', 'failed', 'stopped', 'done'].includes(status)) return null
  const createdBy = r['createdBy']
  if (createdBy !== 'you' && createdBy !== 'mcp' && createdBy !== 'crew') return null
  const assignee = r['assignee'] as Task['assignee'] | undefined
  if (!assignee || (assignee.kind !== 'agent' && assignee.kind !== 'crew')) return null
  if (assignee.kind === 'agent' && !AGENTS[assignee.agent]) return null
  if (assignee.kind === 'crew' && typeof assignee.teammateId !== 'string') return null
  const backups = Array.isArray(r['backups']) ? (r['backups'] as AgentKind[]).filter((kind) => Boolean(AGENTS[kind])) : []
  const checks = Array.isArray(r['checks']) ? (r['checks'] as CheckSpec[]).filter(isCheck) : []
  const heatId = typeof r['heatId'] === 'string' && r['heatId'] ? r['heatId'] : null
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : Date.now())
  return {
    id,
    title,
    prompt,
    assignee:
      assignee.kind === 'agent' ? { kind: 'agent', agent: assignee.agent } : { kind: 'crew', teammateId: assignee.teammateId },
    backups,
    checks: checks.map((check) => ({ name: check.name, command: check.command, kind: check.kind })),
    status,
    heatId,
    createdBy,
    createdAt: num(r['createdAt']),
    updatedAt: num(r['updatedAt']),
    note: typeof r['note'] === 'string' ? r['note'] : ''
  }
}

function isCheck(raw: unknown): raw is CheckSpec {
  if (typeof raw !== 'object' || raw === null) return false
  const r = raw as Record<string, unknown>
  return typeof r['name'] === 'string' && typeof r['command'] === 'string' && (r['kind'] === 'required' || r['kind'] === 'guard')
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
