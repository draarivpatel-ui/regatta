// Unit tests for the task store and the pure heat-to-task mapping.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { CheckSpec, Decision, HeatState, HeatStatus, LaneState } from '../shared/heats'
import type { StartHeatOptions } from '../shared/ipc'
import type { Teammate } from '../shared/chat'
import type { AgentKind } from '../shared/types'
import type { NewTask, Task } from '../shared/tasks'
import { statusFromHeat } from '../shared/tasks'
import { TaskStore } from './tasks'
import type { TaskStoreDeps } from './tasks'

const cleanup: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-tasks-'))
  cleanup.push(dir)
  return join(dir, 'data')
}

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

const CHECKS: CheckSpec[] = [{ name: 'test', command: 'npm test', kind: 'required' }]

function input(patch: Partial<NewTask> = {}): NewTask {
  return {
    title: 'Fix the flaky test',
    prompt: 'Make the cart test stop failing.',
    assignee: { kind: 'agent', agent: 'claude' },
    backups: ['codex'],
    checks: CHECKS.map((check) => ({ ...check })),
    note: '',
    ...patch
  }
}

const MATE: Teammate = {
  id: 'mate-1',
  name: 'Ada',
  role: 'Release review',
  instructions: 'Check the open issues and report back.',
  agent: 'claude',
  memory: 'Ship notes go in CHANGELOG.md.',
  skills: ['s1'],
  createdAt: 1
}

interface Harness {
  store: TaskStore
  heatCalls: StartHeatOptions[]
  nightCalls: Array<{ prompt: string; agent: AgentKind; checks: CheckSpec[] }>
  emitted: Task[][]
  failStartWith: (err: Error | null) => void
  holdStart: () => { resolve: (id?: string) => void; reject: (err: Error) => void }
}

function harness(dataDir: string, teammates: Teammate[] = [MATE], heats?: () => Array<{ id: string }>): Harness {
  const heatCalls: StartHeatOptions[] = []
  const nightCalls: Harness['nightCalls'] = []
  const emitted: Task[][] = []
  let startError: Error | null = null
  let startGate: Promise<string | undefined> | null = null
  const deps: TaskStoreDeps = {
    dataDir,
    startHeat: async (opts) => {
      heatCalls.push(opts)
      const index = heatCalls.length
      if (startGate) {
        const customId = await startGate
        return { id: customId ?? `heat-${index}` }
      }
      if (startError) throw startError
      return { id: `heat-${index}` }
    },
    ...(heats ? { heats } : {}),
    night: {
      addTask: (task) => {
        nightCalls.push(task)
        return null
      }
    },
    teammates: () => teammates,
    skills: () => [
      { id: 's1', name: 'Careful edits', description: 'Edit with care', instructions: 'Change one file at a time.', source: 'regatta', createdAt: 1, updatedAt: 1 },
      // A skill this crew member does not have: it must not reach the prompt.
      { id: 's2', name: 'Unused', description: 'Not this mate', instructions: 'THIS SKILL IS NOT OWNED', source: 'regatta', createdAt: 1, updatedAt: 1 }
    ],
    emit: (tasks) => emitted.push(tasks),
    now: () => 1_700_000_000_000
  }
  return {
    store: new TaskStore(deps),
    heatCalls,
    nightCalls,
    emitted,
    failStartWith: (err) => {
      startError = err
    },
    holdStart: () => {
      let resolveGate!: (id?: string) => void
      let rejectGate!: (err: Error) => void
      startGate = new Promise<string | undefined>((res, rej) => {
        resolveGate = res
        rejectGate = rej
      })
      return {
        resolve: (id?: string) => {
          startGate = null
          resolveGate(id)
        },
        reject: (err: Error) => {
          startGate = null
          rejectGate(err)
        }
      }
    }
  }
}

/** A heat in one status, with the fields the mapping reads. */
function heat(status: HeatStatus, decision: Decision | null = null, id = 'heat-1'): HeatState {
  const lane: LaneState = {
    id: 'lane-1',
    agent: 'claude',
    worktree: null,
    branch: null,
    phase: 'done',
    startedAt: null,
    endedAt: null,
    exitCode: 0,
    durationMs: 1000,
    timedOut: false,
    diff: { files: 1, added: 1, removed: 0 },
    tokens: null,
    latest: '',
    checks: [],
    tests: null,
    gates: [],
    error: null
  }
  return {
    id,
    mode: 'handoff',
    task: 'Make the cart test stop failing.',
    root: '/tmp/nowhere',
    base: null,
    createdAt: 1,
    status,
    checks: CHECKS,
    baseline: [],
    baselineTests: null,
    lanes: [lane],
    decision,
    error: status === 'error' ? 'The worktree could not be made.' : null
  }
}

const winner: Decision = { kind: 'winner', laneIds: ['lane-1'], note: 'Claude Code wins.' }
const none: Decision = { kind: 'none', laneIds: [], note: 'No lane passed every gate.' }
const tie: Decision = { kind: 'tie', laneIds: ['lane-1'], note: 'Tie, you pick.' }

function pick(tasks: Task[], id: string): Task {
  const found = tasks.find((t) => t.id === id)
  if (!found) throw new Error(`no task with id ${id}`)
  return found
}

/** Creates one task, runs it, and returns it fresh: it rides the heat the store just started. */
async function started(h: Harness, patch: Partial<NewTask> = {}): Promise<Task> {
  const task = h.store.create(input(patch), 'you')[0]!
  await h.store.run(task.id)
  return pick(h.store.list(), task.id)
}

/** The heat id a started task rides, or a failure that says so. */
function heatIdOf(task: Task): string {
  if (!task.heatId) throw new Error('the task has no heat')
  return task.heatId
}

describe('statusFromHeat', () => {
  it('reads a baseline, racing or waiting heat as running', () => {
    for (const status of ['baseline', 'racing', 'waiting'] as HeatStatus[]) {
      expect(statusFromHeat(heat(status), 'todo')).toBe('running')
      expect(statusFromHeat(heat(status), 'failed')).toBe('running')
    }
  })

  it('a decided heat with a winner is review, a tie is still work waiting on a person', () => {
    expect(statusFromHeat(heat('decided', winner), 'running')).toBe('review')
    expect(statusFromHeat(heat('decided', tie), 'running')).toBe('review')
  })

  it('decided with nobody, decided with no decision, or an errored heat is failed', () => {
    expect(statusFromHeat(heat('decided', none), 'running')).toBe('failed')
    expect(statusFromHeat(heat('decided', null), 'running')).toBe('failed')
    expect(statusFromHeat(heat('error'), 'running')).toBe('failed')
  })

  it('merged is done and cancelled is stopped', () => {
    expect(statusFromHeat(heat('merged'), 'review')).toBe('done')
    expect(statusFromHeat(heat('cancelled'), 'running')).toBe('stopped')
  })

  it('a heat that no longer exists leaves the status as it was', () => {
    expect(statusFromHeat(undefined, 'review')).toBe('review')
    expect(statusFromHeat(undefined, 'failed')).toBe('failed')
  })

  it('a task marked done stays done', () => {
    for (const status of ['baseline', 'racing', 'waiting', 'decided', 'merged', 'cancelled', 'error'] as HeatStatus[]) {
      expect(statusFromHeat(heat(status, winner), 'done')).toBe('done')
    }
    expect(statusFromHeat(undefined, 'done')).toBe('done')
  })
})

describe('TaskStore create, edit, remove', () => {
  it('lands in To do with what it was given, newest first', () => {
    const { store } = harness(tempDir())
    const first = store.create(input({ title: 'First' }), 'you')
    store.create(input({ title: 'Second', assignee: { kind: 'crew', teammateId: 'mate-1' } }), 'mcp')
    expect(first.map((t) => t.title)).toEqual(['First'])
    const list = store.list()
    expect(list.map((t) => t.title)).toEqual(['Second', 'First'])
    const mine = pick(list, first[0]!.id)
    expect(mine.status).toBe('todo')
    expect(mine.heatId).toBeNull()
    expect(mine.createdBy).toBe('you')
    expect(mine.createdAt).toBe(1_700_000_000_000)
    expect(list[0]!.createdBy).toBe('mcp')
    expect(list[0]!.assignee).toEqual({ kind: 'crew', teammateId: 'mate-1' })
    // What the store hands out is a copy: tampering with it cannot change the store.
    list[0]!.title = 'tampered'
    expect(store.list()[0]!.title).toBe('Second')
  })

  it('refuses an empty title or prompt, a half-written check, repeated names, too many backups', () => {
    const { store } = harness(tempDir())
    expect(() => store.create(input({ title: '   ' }), 'you')).toThrow(/title/)
    expect(() => store.create(input({ prompt: '' }), 'you')).toThrow(/what the task is for/)
    expect(() => store.create(input({ title: 'x'.repeat(121) }), 'you')).toThrow(/120 characters/)
    expect(() => store.create(input({ assignee: { kind: 'crew', teammateId: '  ' } as Task['assignee'] }), 'you')).toThrow(/crew member/)
    expect(() => store.create(input({ assignee: { kind: 'agent', agent: 'nope' as AgentKind } }), 'you')).toThrow(/Regatta knows/)
    expect(() => store.create(input({ checks: [{ name: 'test', command: ' ', kind: 'required' }] }), 'you')).toThrow(/name and a command/)
    expect(() => store.create(input({ checks: [CHECKS[0]!, { ...CHECKS[0]! }] }), 'you')).toThrow(/share the name test/)
    expect(() => store.create(input({ backups: ['codex', 'gemini', 'grok', 'opencode'] }), 'you')).toThrow(/three backups/)
    expect(store.list()).toHaveLength(0)
  })

  it('edits the words and the plan, and never the tracked fields', () => {
    const { store } = harness(tempDir())
    const created = store.create(input({ note: 'old note' }), 'you')[0]!
    const edited = store.update(created.id, {
      title: 'Renamed',
      prompt: 'Renewed brief',
      assignee: { kind: 'crew', teammateId: 'mate-1' },
      backups: ['gemini'],
      checks: [{ name: 'typecheck', command: 'npm run typecheck', kind: 'guard' }],
      note: 'watch the flaky one'
    })
    const task = pick(edited, created.id)
    expect(task.title).toBe('Renamed')
    expect(task.prompt).toBe('Renewed brief')
    expect(task.assignee).toEqual({ kind: 'crew', teammateId: 'mate-1' })
    expect(task.backups).toEqual(['gemini'])
    expect(task.checks).toEqual([{ name: 'typecheck', command: 'npm run typecheck', kind: 'guard' }])
    expect(task.note).toBe('watch the flaky one')
    expect(task.status).toBe('todo')
    expect(task.createdBy).toBe('you')
    expect(task.heatId).toBeNull()
    expect(task.id).toBe(created.id)
    expect(() => store.update('nope-nope', { title: 'ghost' })).toThrow(/no longer here/)
    // An edit is checked the same way a new task is.
    expect(() => store.update(created.id, { checks: [{ name: 'a', command: '', kind: 'required' }] })).toThrow(/name and a command/)
  })

  it('a stopped or failed task is editable again, a running one is not', async () => {
    const h = harness(tempDir())
    const running = await started(h)
    expect(() => h.store.update(running.id, { title: 'Too late' })).toThrow(/to do, failed or stopped/)
    h.store.onHeat(heat('cancelled', null, heatIdOf(running)))
    const stopped = pick(h.store.list(), running.id)
    expect(stopped.status).toBe('stopped')
    h.store.update(stopped.id, { title: 'Retried later' })
    expect(pick(h.store.list(), stopped.id).title).toBe('Retried later')
  })

  it('refuses an edit while running, in review or done, and refuses to remove a running or review task', async () => {
    const h = harness(tempDir())
    const running = await started(h)
    expect(() => h.store.update(running.id, { title: 'Too late' })).toThrow(/to do, failed or stopped/)
    expect(() => h.store.remove(running.id)).toThrow(/Stop its heat first/)
    h.store.onHeat(heat('decided', winner, heatIdOf(running)))
    const review = pick(h.store.list(), running.id)
    expect(review.status).toBe('review')
    expect(() => h.store.update(review.id, { title: 'Too late' })).toThrow(/to do, failed or stopped/)
    // A task waiting for review must be merged or marked done before it can be removed.
    expect(() => h.store.remove(review.id)).toThrow(/Merge it or mark it done first/)
    expect(h.store.list()).toHaveLength(1)
    h.store.markDone(review.id)
    expect(h.store.remove(review.id)).toHaveLength(0)

    const other = await started(h, { title: 'Merge me' })
    h.store.onHeat(heat('merged', winner, heatIdOf(other)))
    const done = pick(h.store.list(), other.id)
    expect(done.status).toBe('done')
    expect(() => h.store.update(done.id, { title: 'Too late' })).toThrow(/to do, failed or stopped/)
  })

  it('removes a task that is not running and keeps the rest', () => {
    const { store } = harness(tempDir())
    const keep = store.create(input({ title: 'Keep' }), 'you')[0]!
    const doomed = store.create(input({ title: 'Drop' }), 'you')[0]!
    expect(store.remove(doomed.id).map((t) => t.id)).toEqual([keep.id])
    expect(store.remove('nope-nope').map((t) => t.id)).toEqual([keep.id])
  })

  it('saves and reloads tasks from <dataDir>/tasks.json when their heat still exists', async () => {
    const dir = tempDir()
    const { store } = harness(dir)
    const task = store.create(input({ note: 'remember this' }), 'mcp')[0]!
    await store.run(task.id)
    const saved = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')) as Task[]
    expect(saved).toHaveLength(1)
    expect(saved[0]!.status).toBe('running')
    expect(saved[0]!.heatId).toBe('heat-1')
    expect(harness(dir, [MATE], () => [{ id: 'heat-1' }]).store.list()).toEqual(store.list())
  })

  it('on load after a restart, a running task whose heat is gone becomes stopped with a note and a review task keeps review only while its heat exists', async () => {
    const dir = tempDir()
    const first = harness(dir)
    const runningTask = await started(first, { title: 'Interrupted run' })
    const reviewKept = await started(first, { title: 'Review still live' })
    first.store.onHeat(heat('decided', winner, heatIdOf(reviewKept)))
    const reviewGone = await started(first, { title: 'Review heat gone' })
    first.store.onHeat(heat('decided', winner, heatIdOf(reviewGone)))

    const live = [{ id: heatIdOf(reviewKept) }]
    const restarted = harness(dir, [MATE], () => live)
    const afterRestart = restarted.store.list()

    const stoppedRun = pick(afterRestart, runningTask.id)
    expect(stoppedRun.status).toBe('stopped')
    expect(stoppedRun.note).toMatch(/Stopped when Regatta closed/)

    const keptReview = pick(afterRestart, reviewKept.id)
    expect(keptReview.status).toBe('review')

    const droppedReview = pick(afterRestart, reviewGone.id)
    expect(droppedReview.status).toBe('stopped')

    // Once the remaining review heat is gone too, the task no longer stays in review.
    live.length = 0
    expect(pick(restarted.store.list(), reviewKept.id).status).toBe('stopped')
  })

  it('reads a broken file as no tasks rather than throwing, and skips a bad entry', () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.json'), '{ not json at all', 'utf8')
    expect(harness(dir).store.list()).toHaveLength(0)
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify([
        { id: 'ok-1', title: 'Good', prompt: 'p', assignee: { kind: 'agent', agent: 'claude' }, backups: [], checks: [], status: 'todo', heatId: null, createdBy: 'you', createdAt: 5, updatedAt: 5, note: 'n' },
        { id: 'bad-1', title: 'Wrong status', prompt: 'p', status: 'halfway' }
      ]),
      'utf8'
    )
    const list = harness(dir).store.list()
    expect(list.map((t) => t.id)).toEqual(['ok-1'])
    expect(list[0]!.note).toBe('n')
  })
})

describe('TaskStore run', () => {
  it('starts one hand-off with the lead first and the backups after', async () => {
    const { store, heatCalls } = harness(tempDir())
    const task = store.create(input({ assignee: { kind: 'agent', agent: 'claude' }, backups: ['codex', 'gemini'] }), 'you')[0]!
    const tasks = await store.run(task.id)
    expect(heatCalls).toHaveLength(1)
    const opts = heatCalls[0]!
    expect(opts.mode).toBe('handoff')
    expect(opts.order).toEqual(['claude', 'codex', 'gemini'])
    expect(opts.agents).toEqual(['claude', 'codex', 'gemini'])
    expect(opts.task).toBe('Make the cart test stop failing.')
    expect(opts.checks).toEqual([{ name: 'test', command: 'npm test', kind: 'required' }])
    expect(opts.setup).toBe('')
    expect(opts.timeLimitMin).toBe(15)
    expect(opts.attemptLimitMin).toBe(15)
    expect(opts.overallLimitMin).toBeNull()
    expect(opts.askBeforeNext).toBe(false)
    expect(opts.allowCommands).toBe(false)
    const running = pick(tasks, task.id)
    expect(running.status).toBe('running')
    expect(running.heatId).toBe('heat-1')
  })

  it('locks a task while startHeat is in flight: sets status to running before awaiting and refuses run, update, remove and markDone', async () => {
    const h = harness(tempDir())
    const task = h.store.create(input(), 'you')[0]!
    const gate = h.holdStart()

    const pendingRun = h.store.run(task.id)
    expect(h.store.get(task.id)?.status).toBe('running')
    await expect(h.store.run(task.id)).rejects.toThrow(/already starting/)
    expect(h.heatCalls).toHaveLength(1)
    expect(() => h.store.update(task.id, { title: 'Changed while starting' })).toThrow(/already starting/)
    expect(() => h.store.remove(task.id)).toThrow(/already starting/)
    expect(() => h.store.markDone(task.id)).toThrow(/already starting/)

    gate.resolve('heat-locked')
    const after = pick(await pendingRun, task.id)
    expect(after.status).toBe('running')
    expect(after.heatId).toBe('heat-locked')
  })

  it('a task sent back keeps its note, its next run puts "Note from your review: <note>" into the prompt, and the run clears the note', async () => {
    const h = harness(tempDir())
    const first = await started(h)
    h.store.onHeat(heat('decided', winner, heatIdOf(first)))
    expect(pick(h.store.list(), first.id).status).toBe('review')

    const sentBack = pick(h.store.sendBack(first.id, 'Cover the empty cart case.'), first.id)
    expect(sentBack.status).toBe('todo')
    expect(sentBack.note).toBe('Cover the empty cart case.')

    const runningAgain = pick(await h.store.run(first.id), first.id)
    expect(runningAgain.status).toBe('running')
    expect(runningAgain.note).toBe('')
    expect(h.heatCalls).toHaveLength(2)
    expect(h.heatCalls[1]!.task).toBe('Make the cart test stop failing.\n\nNote from your review: Cover the empty cart case.')

    // Once cleared by the run, a later run without a new note does not repeat the old review note.
    h.store.onHeat(heat('cancelled', null, heatIdOf(runningAgain)))
    await h.store.run(first.id)
    expect(h.heatCalls[2]!.task).toBe('Make the cart test stop failing.')
  })

  it('a solo task runs one attempt with no backup', async () => {
    const { store, heatCalls } = harness(tempDir())
    const task = store.create(input({ backups: [] }), 'you')[0]!
    await store.run(task.id)
    expect(heatCalls[0]!.order).toEqual(['claude'])
  })

  it('a crew task leads with its own agent and puts the instructions and skills before the prompt', async () => {
    const { store, heatCalls } = harness(tempDir())
    const task = store.create(input({ assignee: { kind: 'crew', teammateId: 'mate-1' }, backups: [] }), 'you')[0]!
    await store.run(task.id)
    expect(heatCalls[0]!.order).toEqual(['claude'])
    const prompt = heatCalls[0]!.task
    expect(prompt).toContain('You are Ada, Release review.')
    expect(prompt).toContain('Check the open issues and report back.')
    expect(prompt).toContain('## Careful edits')
    expect(prompt).toContain('Change one file at a time.')
    expect(prompt).not.toContain('THIS SKILL IS NOT OWNED')
    expect(prompt).toContain('Notes you keep:')
    expect(prompt.endsWith('Make the cart test stop failing.')).toBe(true)
    expect(prompt.indexOf('You are Ada')).toBeLessThan(prompt.indexOf('Make the cart test'))
  })

  it('refuses while running, in review or done, and with nothing to check', async () => {
    const { store } = harness(tempDir())
    const task = store.create(input(), 'you')[0]!
    await store.run(task.id)
    await expect(store.run(task.id)).rejects.toThrow(/already running/)
    store.onHeat(heat('decided', winner, 'heat-1'))
    expect(pick(store.list(), task.id).status).toBe('review')
    await expect(store.run(task.id)).rejects.toThrow(/already running, waiting for review or done/)
    store.markDone(task.id)
    await expect(store.run(task.id)).rejects.toThrow(/already running, waiting for review or done/)
    const noChecks = store.create(input({ title: 'Unchecked', checks: [] }), 'you')[0]!
    await expect(store.run(noChecks.id)).rejects.toThrow(/at least one check/)
    await expect(store.run('nope-nope')).rejects.toThrow(/no longer here/)
  })

  it('leaves a task in To do when the heat refuses to start', async () => {
    const { store, failStartWith } = harness(tempDir())
    const task = store.create(input(), 'you')[0]!
    failStartWith(new Error('Heats need a git repository with at least one commit.'))
    await expect(store.run(task.id)).rejects.toThrow(/git repository/)
    const after = pick(store.list(), task.id)
    expect(after.status).toBe('todo')
    expect(after.heatId).toBeNull()
  })

  it('a crew member that is gone stops the run', async () => {
    const { store } = harness(tempDir(), [])
    const task = store.create(input({ assignee: { kind: 'crew', teammateId: 'mate-1' } }), 'crew')[0]!
    await expect(store.run(task.id)).rejects.toThrow(/crew member no longer exists/)
    expect(pick(store.list(), task.id).status).toBe('todo')
  })
})

describe('TaskStore markDone and addToTonight', () => {
  it('a person marks done from To do, review, failed or stopped, but not running', async () => {
    const a = harness(tempDir())
    const todo = a.store.create(input({ title: 'Todo one' }), 'you')[0]!
    expect(pick(a.store.markDone(todo.id), todo.id).status).toBe('done')
    // Marking a done task again keeps it done.
    expect(pick(a.store.markDone(todo.id), todo.id).status).toBe('done')

    const b = harness(tempDir())
    const running = await started(b)
    expect(() => b.store.markDone(running.id)).toThrow(/running task cannot be marked done/i)
    b.store.onHeat(heat('decided', winner, heatIdOf(running)))
    expect(pick(b.store.markDone(running.id), running.id).status).toBe('done')

    const c = harness(tempDir())
    const failedTask = await started(c)
    c.store.onHeat(heat('decided', none, heatIdOf(failedTask)))
    expect(pick(c.store.list(), failedTask.id).status).toBe('failed')
    expect(pick(c.store.markDone(failedTask.id), failedTask.id).status).toBe('done')

    const d = harness(tempDir())
    const stopped = await started(d)
    d.store.onHeat(heat('cancelled', null, heatIdOf(stopped)))
    expect(pick(d.store.list(), stopped.id).status).toBe('stopped')
    expect(pick(d.store.markDone(stopped.id), stopped.id).status).toBe('done')
    expect(() => d.store.markDone('nope-nope')).toThrow(/no longer here/)
  })

  it('addToTonight hands the same work to the night queue and leaves the task alone', () => {
    const { store, nightCalls } = harness(tempDir())
    const task = store.create(input({ assignee: { kind: 'crew', teammateId: 'mate-1' }, backups: ['codex'] }), 'you')[0]!
    const before = store.list()
    const after = store.addToTonight(task.id)
    expect(nightCalls).toHaveLength(1)
    expect(nightCalls[0]!.agent).toBe('claude')
    expect(nightCalls[0]!.checks).toEqual([{ name: 'test', command: 'npm test', kind: 'required' }])
    expect(nightCalls[0]!.prompt).toContain('You are Ada')
    expect(nightCalls[0]!.prompt.endsWith('Make the cart test stop failing.')).toBe(true)
    expect(after).toEqual(before)
    expect(pick(after, task.id).status).toBe('todo')
  })

  it('an agent task goes to tonight with its own agent', () => {
    const { store, nightCalls } = harness(tempDir())
    const task = store.create(input({ assignee: { kind: 'agent', agent: 'gemini' }, backups: [] }), 'you')[0]!
    store.addToTonight(task.id)
    expect(nightCalls[0]!.agent).toBe('gemini')
    expect(nightCalls[0]!.prompt).toBe('Make the cart test stop failing.')
  })

  it('addToTonight on a task whose crew member is gone says so', () => {
    const { store } = harness(tempDir(), [])
    const task = store.create(input({ assignee: { kind: 'crew', teammateId: 'mate-1' } }), 'you')[0]!
    expect(() => store.addToTonight(task.id)).toThrow(/crew member no longer exists/)
    expect(() => store.addToTonight('nope-nope')).toThrow(/no longer here/)
  })
})

describe('TaskStore onHeat', () => {
  it('moves only the task riding that heat, and writes only when a status moves', async () => {
    const h = harness(tempDir())
    const riding = await started(h)
    const id = heatIdOf(riding)
    const other = h.store.create(input({ title: 'Waiting' }), 'you')[0]!
    const before = h.emitted.length
    h.store.onHeat(heat('racing', null, id))
    expect(h.emitted.length).toBe(before)
    h.store.onHeat(heat('decided', winner, id))
    expect(h.emitted.length).toBe(before + 1)
    expect(pick(h.store.list(), riding.id).status).toBe('review')
    expect(pick(h.store.list(), other.id).status).toBe('todo')
    // A heat for something else never moves a task.
    h.store.onHeat(heat('merged', winner, 'heat-99'))
    expect(pick(h.store.list(), riding.id).status).toBe('review')
    // Merged makes it done, and a late cancel cannot take it back or write anything.
    h.store.onHeat(heat('merged', winner, id))
    expect(pick(h.store.list(), riding.id).status).toBe('done')
    const after = h.emitted.length
    h.store.onHeat(heat('cancelled', winner, id))
    expect(pick(h.store.list(), riding.id).status).toBe('done')
    expect(h.emitted.length).toBe(after)
  })

  it('a task with no heat is left alone', () => {
    const { store } = harness(tempDir())
    const fresh = store.create(input(), 'you')[0]!
    store.onHeat(heat('merged', winner, 'heat-1'))
    expect(pick(store.list(), fresh.id).status).toBe('todo')
  })
})
