// Unit tests for the board store (archived ids and send-back notes) and the pure buildBoard,
// which turns every engine's state into the four columns.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Decision, HeatState, LaneState } from '@shared/heats'
import type { FlowRun } from '@shared/flows'
import type { NightState, NightTaskRun } from '@shared/nightwatch'
import type { AgentKind, SessionInfo } from '@shared/types'
import type { Board, BoardCard, BoardColumn, BoardInput, RetryableHeat } from '@shared/board'
import { buildBoard, BOARD_COLUMNS, DONE_WINDOW_MS, goesToReview, hasSingleWinner, retryHeatOptions } from '@shared/board'
import type { Task } from '@shared/tasks'
import { BoardStore, sanitize } from './board'
import { TaskStore } from './tasks'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 10 * DAY

const dirs: string[] = []
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'regatta-board-'))
  dirs.push(root)
  return join(root, 'data')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function store(dataDir: string, emit = (_d: unknown): void => undefined): BoardStore {
  return new BoardStore({ dataDir, emit, now: () => 1_000_000 })
}

/** The column a card landed in, for readability in the assertions. */
function columnOf(board: Board, id: string): BoardColumn | 'none' {
  const found = BOARD_COLUMNS.find((c) => board[c.id].some((x) => x.id === id))
  return found ? found.id : 'none'
}

function findCard(board: Board, id: string): BoardCard | undefined {
  for (const column of BOARD_COLUMNS) {
    const card = board[column.id].find((c) => c.id === id)
    if (card) return card
  }
  return undefined
}

describe('BoardStore', () => {
  it('starts empty', () => {
    expect(store(tempDir()).list()).toEqual({ archived: [], notes: {} })
  })

  it('archives a card, does not repeat it, and puts it back', () => {
    const s = store(tempDir())
    expect(s.archive('task-1').archived).toEqual(['task-1'])
    expect(s.archive('task-1').archived).toEqual(['task-1'])
    expect(s.unarchive('task-1').archived).toEqual([])
  })

  it('saves to disk and reads it back', () => {
    const dir = tempDir()
    const first = store(dir)
    first.archive('heat-1')
    first.sendBack('task-2', 'Add a test first')
    const text = readFileSync(join(dir, 'board.json'), 'utf8')
    expect(text).toContain('heat-1')
    expect(text).toContain('Add a test first')
    expect(store(dir).list()).toEqual({ archived: ['heat-1'], notes: { 'task-2': 'Add a test first' } })
  })

  it('records, clears and replaces a send-back note', () => {
    const s = store(tempDir())
    expect(s.sendBack('task-1', 'needs a test').notes['task-1']).toBe('needs a test')
    expect(s.sendBack('task-1', '   ').notes['task-1']).toBeUndefined()
    expect(s.sendBack('task-1', 'reworded').notes['task-1']).toBe('reworded')
  })

  it('drops malformed disk data instead of crashing', () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'board.json'), JSON.stringify({ archived: ['a', 3, 'a'], notes: { t: 'note', n: 5, e: '  ' } }), 'utf8')
    expect(store(dir).list()).toEqual({ archived: ['a'], notes: { t: 'note' } })
  })

  it('emits the newest state on every change', () => {
    const seen: unknown[] = []
    const s = store(tempDir(), (d) => seen.push(d))
    s.archive('x')
    s.sendBack('y', 'note')
    expect(seen).toHaveLength(2)
    expect((seen[1] as { notes: Record<string, string> }).notes['y']).toBe('note')
  })
})

describe('sanitize', () => {
  it('keeps only string ids and non-empty string notes', () => {
    expect(sanitize(null)).toEqual({ archived: [], notes: {} })
    expect(sanitize({ archived: 'no', notes: 'no' })).toEqual({ archived: [], notes: {} })
    expect(sanitize({ archived: ['a', ''], notes: { k: '', z: 'ok' } })).toEqual({ archived: ['a'], notes: { z: 'ok' } })
  })
})

function lane(id: string, agent: AgentKind, latest = ''): LaneState {
  return {
    id,
    agent,
    worktree: null,
    branch: null,
    phase: 'done',
    startedAt: 10,
    endedAt: 20,
    exitCode: 0,
    durationMs: 1000,
    timedOut: false,
    diff: { files: 1, added: 2, removed: 1 },
    tokens: null,
    latest,
    checks: [],
    tests: null,
    gates: [],
    error: null
  }
}

function heat(patch: Partial<RetryableHeat> & { id: string }): RetryableHeat {
  return {
    task: 'Race this',
    root: '/r',
    base: null,
    createdAt: NOW,
    status: 'racing',
    checks: [],
    baseline: [],
    baselineTests: null,
    lanes: [lane('l1', 'codex')],
    decision: null,
    error: null,
    ...patch
  }
}

function decide(kind: Decision['kind'], note: string): Decision {
  return { kind, laneIds: kind === 'none' ? [] : ['l1'], note }
}

function task(patch: Partial<Task> & { id: string }): Task {
  return {
    title: 'Task',
    prompt: 'Do it',
    assignee: { kind: 'agent', agent: 'claude' },
    backups: [],
    checks: [],
    status: 'todo',
    heatId: null,
    createdBy: 'you',
    createdAt: NOW,
    updatedAt: NOW,
    note: '',
    ...patch
  }
}

function flowRun(patch: Partial<FlowRun> & { id: string }): FlowRun {
  return {
    flowId: 'f1',
    flowName: 'Ship it',
    isolated: false,
    status: 'running',
    worktree: null,
    branch: null,
    steps: [],
    startedAt: NOW,
    endedAt: null,
    mergeSummary: null,
    ...patch
  }
}

function pane(id: string, state: SessionInfo['status']['state'], agent: AgentKind = 'claude'): SessionInfo {
  return {
    id,
    agent,
    title: `pane ${id}`,
    cwd: '/r',
    command: 'claude',
    args: [],
    createdAt: 10,
    pid: 123,
    status: { state, since: 20, reason: 'working on it', source: 'output' },
    exitCode: null,
    signals: 'output',
    worktree: null,
    branch: null,
    limit: null,
    transcriptPath: null,
    account: null
  }
}

function nightRun(id: string, status: NightTaskRun['status'], prompt = 'Tidy docs'): NightTaskRun {
  return {
    id,
    taskId: `${id}-t`,
    prompt,
    agent: 'codex',
    status,
    worktree: null,
    branch: null,
    base: null,
    startedAt: NOW,
    endedAt: NOW,
    exitCode: 0,
    durationMs: 1000,
    diff: { files: 1, added: 1, removed: 0 },
    tokens: null,
    latest: '',
    checkSpecs: [],
    checks: [],
    gates: [],
    tests: null,
    note: ''
  }
}

function nightState(runs: NightTaskRun[]): NightState {
  return {
    queue: [{ id: 'nq', prompt: 'Queue a doc pass', agent: 'codex', checks: [], createdAt: NOW }],
    nights: [{ id: 'night1', root: '/r', startAt: NOW, status: 'running', finishedAt: null, runs }],
    keepingAwake: false
  }
}

function baseInput(patch: Partial<BoardInput> = {}): BoardInput {
  return { tasks: [], heats: [], night: null, runs: [], sessions: [], archived: [], notes: {}, ...patch }
}

describe('buildBoard', () => {
  it('has four named columns', () => {
    const board = buildBoard(baseInput(), NOW)
    expect(Object.keys(board)).toEqual(['waiting', 'running', 'review', 'done'])
    expect(BOARD_COLUMNS.map((c) => c.label)).toEqual(['Waiting', 'Running', 'To review', 'Done'])
  })

  it('places a task in every status', () => {
    const board = buildBoard(
      baseInput({
        tasks: [
          task({ id: 'todo', status: 'todo' }),
          task({ id: 'run', status: 'running' }),
          task({ id: 'rev', status: 'review' }),
          task({ id: 'fail', status: 'failed' }),
          task({ id: 'stop', status: 'stopped' }),
          task({ id: 'done', status: 'done' })
        ]
      }),
      NOW
    )
    expect(columnOf(board, 'todo')).toBe('waiting')
    expect(columnOf(board, 'run')).toBe('running')
    expect(columnOf(board, 'rev')).toBe('review')
    expect(columnOf(board, 'fail')).toBe('waiting')
    expect(columnOf(board, 'stop')).toBe('waiting')
    expect(columnOf(board, 'done')).toBe('done')
  })

  it('gives a task the right actions and agents', () => {
    const board = buildBoard(baseInput({ tasks: [task({ id: 'todo', status: 'todo', backups: ['codex'] })] }), NOW)
    const card = findCard(board, 'todo')!
    expect(card.kind).toBe('task')
    expect(card.actions).toEqual(['run', 'archive'])
    expect(card.agents).toEqual(['claude', 'codex'])
  })

  it('offers merge for a review task whose heat has a winner', () => {
    const board = buildBoard(
      baseInput({
        heats: [heat({ id: 'h1', status: 'decided', decision: decide('winner', 'Claude wins') })],
        tasks: [task({ id: 't1', status: 'review', heatId: 'h1' })]
      }),
      NOW
    )
    expect(findCard(board, 't1')!.actions).toEqual(['merge', 'sendback', 'markdone', 'archive'])
    expect(findCard(board, 't1')!.latest).toBe('Claude wins')
  })

  it('shows a heat a task is riding only once, as the task', () => {
    const board = buildBoard(
      baseInput({ heats: [heat({ id: 'h1', status: 'racing' })], tasks: [task({ id: 't1', status: 'running', heatId: 'h1' })] }),
      NOW
    )
    expect(findCard(board, 'h1')).toBeUndefined()
    expect(findCard(board, 't1')!.kind).toBe('task')
  })

  it('places a standalone heat by its own state', () => {
    const board = buildBoard(
      baseInput({
        heats: [
          heat({ id: 'racing', status: 'racing' }),
          heat({ id: 'win', status: 'decided', decision: decide('winner', 'Codex wins') }),
          heat({ id: 'lost', status: 'decided', decision: decide('none', 'No lane passed') }),
          heat({ id: 'merged', status: 'merged' }),
          heat({ id: 'err', status: 'error', error: 'crashed' }),
          heat({ id: 'canc', status: 'cancelled' })
        ]
      }),
      NOW
    )
    expect(columnOf(board, 'racing')).toBe('running')
    expect(columnOf(board, 'win')).toBe('review')
    expect(columnOf(board, 'lost')).toBe('waiting')
    expect(columnOf(board, 'merged')).toBe('done')
    expect(columnOf(board, 'err')).toBe('waiting')
    expect(columnOf(board, 'canc')).toBe('none')
  })

  it('carries night, flow and pane state into their columns', () => {
    const board = buildBoard(
      baseInput({
        night: nightState([nightRun('nr-run', 'running'), nightRun('nr-ready', 'ready'), nightRun('nr-merged', 'merged'), nightRun('nr-failed', 'failed')]),
        runs: [
          flowRun({ id: 'fr-run', status: 'running' }),
          flowRun({ id: 'fr-wait', status: 'waiting' }),
          flowRun({ id: 'fr-fail', status: 'failed' }),
          flowRun({ id: 'fr-done', isolated: true, status: 'done', endedAt: NOW, mergeSummary: '1 file (+3 -1)' })
        ],
        sessions: [pane('p-work', 'working'), pane('p-wait', 'waiting'), pane('p-idle', 'idle')]
      }),
      NOW
    )
    expect(columnOf(board, 'nightq-nq')).toBe('waiting')
    expect(columnOf(board, 'night-nr-run')).toBe('running')
    expect(columnOf(board, 'night-nr-ready')).toBe('review')
    expect(columnOf(board, 'night-nr-merged')).toBe('done')
    expect(columnOf(board, 'night-nr-failed')).toBe('none')
    expect(columnOf(board, 'flow-fr-run')).toBe('running')
    expect(columnOf(board, 'flow-fr-wait')).toBe('review')
    expect(columnOf(board, 'flow-fr-fail')).toBe('waiting')
    expect(columnOf(board, 'flow-fr-done')).toBe('done')
    expect(columnOf(board, 'p-work')).toBe('running')
    expect(columnOf(board, 'p-wait')).toBe('review')
    expect(columnOf(board, 'p-idle')).toBe('none')
  })

  it('hides archived ids and leaves a send-back note intact', () => {
    const board = buildBoard(
      baseInput({ tasks: [task({ id: 'gone' }), task({ id: 'keep' })], archived: ['gone'] }),
      NOW
    )
    expect(findCard(board, 'gone')).toBeUndefined()
    expect(findCard(board, 'keep')).toBeDefined()
  })

  it('moves a review task with a send-back note back to waiting with the note', () => {
    const board = buildBoard(baseInput({ tasks: [task({ id: 't1', status: 'review' })], notes: { t1: 'Needs a regression test' } }), NOW)
    const card = findCard(board, 't1')!
    expect(columnOf(board, 't1')).toBe('waiting')
    expect(card.latest).toBe('Needs a regression test')
    expect(card.actions).toEqual(['run', 'archive'])
  })

  it('drops done cards past the 7 day window', () => {
    const board = buildBoard(
      baseInput({ tasks: [task({ id: 'recent', status: 'done', updatedAt: NOW - DAY }), task({ id: 'stale', status: 'done', updatedAt: NOW - DONE_WINDOW_MS - HOUR })] }),
      NOW
    )
    expect(findCard(board, 'recent')).toBeDefined()
    expect(findCard(board, 'stale')).toBeUndefined()
  })

  it('resolves a crew task to its teammate agent for the badge', () => {
    const board = buildBoard(
      baseInput({
        tasks: [task({ id: 'c1', assignee: { kind: 'crew', teammateId: 'mate-1' } })],
        teammateAgents: { 'mate-1': 'gemini' }
      }),
      NOW
    )
    expect(findCard(board, 'c1')!.agents).toEqual(['gemini'])
  })

  it('splits goesToReview from hasSingleWinner so a tied heat never offers one-click Merge (Finding 2)', async () => {
    const singleWinner = heat({
      id: 'h-win',
      status: 'decided',
      lanes: [lane('l1', 'claude'), lane('l2', 'codex')],
      decision: { kind: 'winner', laneIds: ['l1'], note: 'Claude wins' }
    })
    const multiWinner = heat({
      id: 'h-multi',
      status: 'decided',
      lanes: [lane('l1', 'claude'), lane('l2', 'codex')],
      decision: { kind: 'winner', laneIds: ['l1', 'l2'], note: 'Two winners' }
    })
    const tied = heat({
      id: 'h-tie',
      status: 'decided',
      lanes: [lane('l1', 'claude'), lane('l2', 'codex')],
      decision: { kind: 'tie', laneIds: ['l1', 'l2'], note: 'Tied on checks and diff' }
    })
    const noWinner = heat({
      id: 'h-none',
      status: 'decided',
      lanes: [lane('l1', 'claude')],
      decision: { kind: 'none', laneIds: [], note: 'No lane passed' }
    })

    expect(goesToReview(singleWinner)).toBe(true)
    expect(hasSingleWinner(singleWinner)).toBe(true)
    expect(goesToReview(multiWinner)).toBe(true)
    expect(hasSingleWinner(multiWinner)).toBe(false)
    expect(goesToReview(tied)).toBe(true)
    expect(hasSingleWinner(tied)).toBe(false)
    expect(goesToReview(noWinner)).toBe(false)
    expect(hasSingleWinner(noWinner)).toBe(false)

    const board = buildBoard(
      baseInput({
        heats: [
          tied,
          heat({
            id: 'h-task-tie',
            status: 'decided',
            lanes: [lane('l1', 'claude'), lane('l2', 'codex')],
            decision: { kind: 'tie', laneIds: ['l1', 'l2'], note: 'Task heat tied' }
          })
        ],
        tasks: [task({ id: 't-tie', status: 'review', heatId: 'h-task-tie' })]
      }),
      NOW
    )

    const heatCard = findCard(board, 'h-tie')!
    expect(columnOf(board, 'h-tie')).toBe('review')
    expect(heatCard.actions).toEqual(['choose', 'archive'])
    expect(heatCard.actions).not.toContain('merge')

    const taskCard = findCard(board, 't-tie')!
    expect(columnOf(board, 't-tie')).toBe('review')
    expect(taskCard.actions).toEqual(['choose', 'sendback', 'markdone', 'archive'])
    expect(taskCard.actions).not.toContain('merge')

    vi.stubGlobal('window', {
      regatta: {
        invoke: vi.fn(),
        on: () => () => undefined
      }
    })
    const { ACTION_LABEL } = await import('../renderer/src/modes/board/format')
    expect(ACTION_LABEL.choose).toBe('Open in Skipper to choose')
  })

  it('places waiting flow runs in To review with Approve, unmerged isolated finished runs in To review with Merge, and only merged or discarded runs in Done (Finding 6)', async () => {
    const board = buildBoard(
      baseInput({
        runs: [
          flowRun({ id: 'fr-approval', status: 'waiting', worktree: '/tmp/wt-wait', branch: 'regatta/flow/fr-approval' }),
          flowRun({ id: 'fr-iso-unmerged', isolated: true, status: 'done', endedAt: NOW, worktree: '/tmp/wt-iso', branch: 'regatta/flow/fr-iso-unmerged', mergeSummary: null }),
          flowRun({ id: 'fr-iso-merged', isolated: true, status: 'done', endedAt: NOW, worktree: null, branch: null, mergeSummary: '2 files (+8 -1)' }),
          flowRun({ id: 'fr-iso-discarded', isolated: true, status: 'done', endedAt: NOW, worktree: null, branch: null, mergeSummary: null }),
          flowRun({ id: 'fr-plain-done', isolated: false, status: 'done', endedAt: NOW, worktree: null, branch: null, mergeSummary: null })
        ]
      }),
      NOW
    )

    const approvalCard = findCard(board, 'flow-fr-approval')!
    expect(columnOf(board, 'flow-fr-approval')).toBe('review')
    expect(approvalCard.actions).toEqual(['approve', 'archive'])
    expect(approvalCard.actions).not.toContain('merge')

    const unmergedIsoCard = findCard(board, 'flow-fr-iso-unmerged')!
    expect(columnOf(board, 'flow-fr-iso-unmerged')).toBe('review')
    expect(unmergedIsoCard.actions).toEqual(['merge', 'archive'])

    expect(columnOf(board, 'flow-fr-iso-merged')).toBe('done')
    expect(columnOf(board, 'flow-fr-iso-discarded')).toBe('done')
    expect(columnOf(board, 'flow-fr-plain-done')).toBe('none')

    const invoke = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      regatta: {
        invoke,
        on: () => () => undefined
      }
    })
    const { ACTION_LABEL, dispatchCardAction } = await import('../renderer/src/modes/board/format')
    expect(ACTION_LABEL.approve).toBe('Approve')
    await dispatchCardAction(approvalCard, 'approve', {
      tasks: [],
      heats: [],
      runs: [],
      invoke: invoke as never,
      archive: async () => undefined
    })
    expect(invoke).toHaveBeenCalledWith('flows:approve', 'fr-approval')
  })
})

describe('Board actions and navigation (Findings 2, 3, 5, 8)', () => {
  it('retries a heat with duplicate lane agents and hand-off options, and archives the failed card after the new run starts (Finding 3)', async () => {
    const invoke = vi.fn()
    vi.stubGlobal('window', {
      regatta: {
        invoke,
        on: () => () => undefined
      }
    })
    const { dispatchCardAction } = await import('../renderer/src/modes/board/format')

    const handoffHeat = heat({
      id: 'h-failed',
      mode: 'handoff',
      order: ['claude', 'claude', 'codex'],
      attemptLimitMin: 12,
      overallLimitMin: 45,
      askBeforeNext: true,
      task: 'Hand off auth refactor',
      status: 'decided',
      decision: decide('none', 'Timed out'),
      checks: [{ name: 'test', command: 'npm test', kind: 'required' }],
      lanes: [lane('l1', 'claude'), lane('l2', 'claude'), lane('l3', 'codex')]
    })

    const opts = retryHeatOptions(handoffHeat)
    expect(opts).toEqual({
      mode: 'handoff',
      order: ['claude', 'claude', 'codex'],
      attemptLimitMin: 12,
      overallLimitMin: 45,
      askBeforeNext: true,
      task: 'Hand off auth refactor',
      agents: ['claude', 'claude', 'codex'],
      checks: [{ name: 'test', command: 'npm test', kind: 'required' }],
      setup: '',
      timeLimitMin: 12,
      allowCommands: false
    })

    const raceWithDuplicates = heat({
      id: 'h-race-dup',
      mode: 'race',
      task: 'Race two claudes and codex',
      status: 'error',
      lanes: [lane('l1', 'claude'), lane('l2', 'claude'), lane('l3', 'codex')]
    })
    expect(retryHeatOptions(raceWithDuplicates).agents).toEqual(['claude', 'claude', 'codex'])

    const archived: string[] = []
    const callOrder: string[] = []
    invoke.mockImplementation(async (channel: string) => {
      callOrder.push(`invoke:${channel}`)
      if (channel === 'heats:start') return heat({ id: 'h-new' })
      if (channel === 'flows:run') return flowRun({ id: 'fr-new' })
      return undefined
    })
    const archive = async (id: string): Promise<void> => {
      callOrder.push(`archive:${id}`)
      archived.push(id)
    }

    const board = buildBoard(
      baseInput({
        heats: [handoffHeat],
        runs: [flowRun({ id: 'fr-failed', flowId: 'flow-99', status: 'failed' })]
      }),
      NOW
    )
    const heatCard = findCard(board, 'h-failed')!
    const flowCard = findCard(board, 'flow-fr-failed')!

    await dispatchCardAction(heatCard, 'retry', {
      tasks: [],
      heats: [handoffHeat],
      runs: [],
      invoke: invoke as never,
      archive
    })
    expect(invoke).toHaveBeenCalledWith('heats:start', opts)
    expect(archived).toEqual(['h-failed'])
    expect(callOrder).toEqual(['invoke:heats:start', 'archive:h-failed'])

    await dispatchCardAction(flowCard, 'retry', {
      tasks: [],
      heats: [],
      runs: [flowRun({ id: 'fr-failed', flowId: 'flow-99', status: 'failed' })],
      invoke: invoke as never,
      archive
    })
    expect(invoke).toHaveBeenCalledWith('flows:run', 'flow-99')
    expect(archived).toEqual(['h-failed', 'flow-fr-failed'])
    expect(callOrder).toEqual(['invoke:heats:start', 'archive:h-failed', 'invoke:flows:run', 'archive:flow-fr-failed'])
  })

  it('sends a task card back through the Tasks store so the note is kept on the task and it returns to To do (Finding 5)', async () => {
    vi.stubGlobal('window', {
      regatta: {
        invoke: vi.fn(),
        on: () => () => undefined
      }
    })
    const { submitSendBack } = await import('../renderer/src/modes/board/format')

    const dir = tempDir()
    const tasksStore = new TaskStore({
      dataDir: dir,
      startHeat: async () => ({ id: 'h-1' }),
      heats: () => [{ id: 'h-1' }],
      night: { addTask: () => undefined },
      teammates: () => [],
      skills: () => [],
      emit: () => undefined,
      now: () => NOW
    })
    const created = tasksStore.create(
      {
        title: 'Fix login redirect',
        prompt: 'Redirect to /home after login',
        assignee: { kind: 'agent', agent: 'claude' },
        backups: [],
        checks: [{ name: 'test', command: 'npm test', kind: 'required' }],
        note: ''
      },
      'you'
    )[0]!
    await tasksStore.run(created.id)
    tasksStore.onHeat(
      heat({
        id: 'h-1',
        status: 'decided',
        decision: decide('winner', 'Claude passed')
      })
    )
    expect(tasksStore.get(created.id)?.status).toBe('review')

    const reviewBoard = buildBoard(baseInput({ tasks: tasksStore.list() }), NOW)
    const reviewCard = findCard(reviewBoard, created.id)!
    expect(columnOf(reviewBoard, created.id)).toBe('review')

    const sendBackBoard = vi.fn().mockResolvedValue(true)
    const ok = await submitSendBack(reviewCard, 'Handle query string parameters too', {
      updateTask: async (id, patch) => tasksStore.update(id, patch),
      sendBackBoard
    })
    expect(ok).toBe(true)
    expect(sendBackBoard).not.toHaveBeenCalled()

    const updatedTask = tasksStore.get(created.id)!
    expect(updatedTask.status).toBe('todo')
    expect(updatedTask.note).toBe('Handle query string parameters too')

    const nextBoard = buildBoard(baseInput({ tasks: tasksStore.list() }), NOW)
    const waitingCard = findCard(nextBoard, created.id)!
    expect(columnOf(nextBoard, created.id)).toBe('waiting')
    expect(waitingCard.latest).toBe('Handle query string parameters too')
    expect(waitingCard.actions).toEqual(['run', 'archive'])
  })

  it('opens each card in the place it lives when clicked (Finding 8)', async () => {
    const invoke = vi.fn()
    vi.stubGlobal('window', {
      regatta: {
        invoke,
        on: () => () => undefined
      }
    })
    const tasksTabClick = vi.fn()
    const flowToggleClick = vi.fn()
    const flowScrollIntoView = vi.fn()
    vi.stubGlobal('document', {
      querySelector: (selector: string) => {
        if (selector === '[data-testid=automate-tasks]') {
          return { click: tasksTabClick }
        }
        if (selector === '[data-testid=flow-run-card][data-run-id="fr-1"]') {
          return {
            scrollIntoView: flowScrollIntoView,
            querySelector: (sub: string) =>
              sub === '[data-testid=flow-run-toggle]'
                ? { getAttribute: (attr: string) => (attr === 'aria-expanded' ? 'false' : null), click: flowToggleClick }
                : null
          }
        }
        return null
      }
    })

    const { openCard, dispatchCardAction } = await import('../renderer/src/modes/board/format')
    const { useUi } = await import('../renderer/src/store/ui')
    const { useFlows } = await import('../renderer/src/store/flows')
    const { useNight } = await import('../renderer/src/store/night')
    const { useHeats } = await import('../renderer/src/store/heats')
    const { useSessions } = await import('../renderer/src/store/sessions')

    useFlows.setState({ runs: [flowRun({ id: 'fr-1', flowId: 'flow-abc', status: 'running' })], selectedFlowId: null })
    useNight.setState({
      state: nightState([nightRun('nr-42', 'ready')]),
      selected: 'tonight',
      selectedRun: null
    })

    const baseCard: Omit<BoardCard, 'id' | 'kind'> = {
      title: 'Card',
      agents: ['claude'],
      since: NOW,
      latest: '',
      actions: []
    }

    // 1. Task -> Agents > Automate > Tasks
    openCard({ ...baseCard, id: 't-1', kind: 'task' })
    expect(useUi.getState().mode).toBe('agents')
    expect(tasksTabClick).toHaveBeenCalledTimes(1)

    // 2. Flow run -> Flows mode on that run
    openCard({ ...baseCard, id: 'flow-fr-1', kind: 'flow' })
    expect(useUi.getState().mode).toBe('flows')
    expect(useFlows.getState().selectedFlowId).toBe('flow-abc')
    expect(flowToggleClick).toHaveBeenCalledTimes(1)
    expect(flowScrollIntoView).toHaveBeenCalledTimes(1)

    // 3. Night task -> Night watch report on that night and run
    openCard({ ...baseCard, id: 'night-nr-42', kind: 'night' })
    expect(useUi.getState().overlay).toBe('night')
    expect(useNight.getState().selected).toBe('night1')
    expect(useNight.getState().selectedRun).toBe('nr-42')

    // 4. Heat -> Skipper on that heat (including 'choose' on a tied task heat)
    openCard({ ...baseCard, id: 'heat-7', kind: 'heat' })
    expect(useUi.getState().overlay).toBe('skipper')
    expect(useHeats.getState().selectedId).toBe('heat-7')

    await dispatchCardAction(
      { ...baseCard, id: 't-tied', kind: 'task' },
      'choose',
      {
        tasks: [task({ id: 't-tied', status: 'review', heatId: 'heat-99' })],
        heats: [],
        runs: [],
        invoke: invoke as never,
        archive: async () => undefined
      }
    )
    expect(useUi.getState().overlay).toBe('skipper')
    expect(useHeats.getState().selectedId).toBe('heat-99')

    // 5. Pane -> Code mode focused on that pane
    openCard({ ...baseCard, id: 'sess-5', kind: 'pane' })
    expect(useUi.getState().mode).toBe('code')
    expect(useSessions.getState().focusedId).toBe('sess-5')
  })
})

