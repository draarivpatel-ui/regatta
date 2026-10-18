// Board (Labs): one board for everything in flight, whose cards move by themselves as work
// progresses. Only a person moves a card to Done. The board is derived: it stores nothing of its own
// about a run, it reads the engines' own state. See docs/design/spotfix.md "The Board" and
//
// buildBoard is pure and unit tested. It takes the engines' state plus the two things the board does
// keep (archived ids and send-back notes, from src/main/board.ts) and returns the four columns.

import type { HeatState } from './heats'
import type { FlowRun } from './flows'
import type { StartHeatOptions } from './ipc'
import type { NightState } from './nightwatch'
import type { SessionInfo, AgentKind } from './types'
import type { Task } from './tasks'

export type BoardColumn = 'waiting' | 'running' | 'review' | 'done'

export type BoardKind = 'task' | 'heat' | 'night' | 'flow' | 'pane'

/** The actions a card offers. Each maps to a channel the engine already has. */
export type BoardAction = 'run' | 'stop' | 'retry' | 'sendback' | 'merge' | 'choose' | 'approve' | 'markdone' | 'archive'

export interface BoardCard {
  /** Stable, and the id used in data-testid. Prefixed by kind so kinds never collide. */
  id: string
  kind: BoardKind
  title: string
  /** Agent badges to show on the card (unique, in order). */
  agents: AgentKind[]
  /** Epoch ms this card entered its column, for the "x s ago" line. */
  since: number
  /** The latest one-line readout, or an empty string. */
  latest: string
  actions: BoardAction[]
}

export interface BoardColumnDef {
  id: BoardColumn
  label: string
}

/** The four columns, in the order they read. */
export const BOARD_COLUMNS: BoardColumnDef[] = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'To review' },
  { id: 'done', label: 'Done' }
]

/** Done cards older than this drop off the board. */
export const DONE_WINDOW_MS = 7 * 86_400_000

/** The two things the board keeps of its own: hidden card ids and send-back notes by card id. */
export interface BoardData {
  archived: string[]
  notes: Record<string, string>
}

export interface BoardInput {
  tasks: Task[]
  heats: HeatState[]
  /** Null until main has answered the first time. */
  night: NightState | null
  runs: FlowRun[]
  /** The live sessions (panes), keyed or listed. */
  sessions: SessionInfo[]
  /** Card ids the user archived; anything in here is hidden. */
  archived: string[]
  /** Send-back notes by card id. A note turns a "to review" task into a waiting card. */
  notes: Record<string, string>
  /** Crew member id to the agent it runs with, so a crew task can show its badge. */
  teammateAgents?: Record<string, AgentKind>
}

export type Board = Record<BoardColumn, BoardCard[]>

export type RetryableHeat = HeatState &
  Partial<Pick<StartHeatOptions, 'order' | 'attemptLimitMin' | 'overallLimitMin' | 'askBeforeNext' | 'timeLimitMin' | 'setup' | 'allowCommands'>>

const EMPTY: AgentKind[] = []

/** Unique agent kinds, in the order given, dropping anything nullish. */
function uniq(agents: (AgentKind | null | undefined)[]): AgentKind[] {
  const seen = new Set<AgentKind>()
  const out: AgentKind[] = []
  for (const agent of agents) {
    if (!agent || seen.has(agent)) continue
    seen.add(agent)
    out.push(agent)
  }
  return out
}

/** The lead agent of a task, or null for a crew whose member is gone. */
function taskAgents(task: Task, teammateAgents: Record<string, AgentKind>): AgentKind[] {
  if (task.assignee.kind === 'agent') return uniq([task.assignee.agent, ...task.backups])
  const lead = teammateAgents[task.assignee.teammateId]
  return uniq([lead, ...task.backups])
}

/** The newest lane that has something to say: where a running task's latest line comes from. */
function latestLane(heat: HeatState | undefined): string {
  if (!heat) return ''
  for (let i = heat.lanes.length - 1; i >= 0; i--) {
    const line = heat.lanes[i]?.latest
    if (line) return line
  }
  return ''
}

function inWindow(since: number, now: number): boolean {
  return now - since <= DONE_WINDOW_MS
}

/** True when a decided heat has a winner or a tie that goes to To review. */
export function goesToReview(heat: HeatState | undefined): boolean {
  if (!heat || heat.status !== 'decided') return false
  const kind = heat.decision?.kind
  return kind === 'winner' || kind === 'tie'
}

/** True when a decided heat has a single winning lane that can be merged in one click. */
export function hasSingleWinner(heat: HeatState | undefined): boolean {
  if (!heat || heat.status !== 'decided') return false
  return heat.decision?.kind === 'winner' && heat.decision.laneIds.length === 1
}

/** Start options that retry a failed heat with its original lanes (including duplicates) and hand-off settings. */
export function retryHeatOptions(heat: RetryableHeat): StartHeatOptions {
  const agents = heat.lanes.map((lane) => lane.agent)
  const checks = heat.checks.map((check) => ({ ...check }))
  const setup = heat.setup ?? ''
  const allowCommands = heat.allowCommands ?? false
  if (heat.mode === 'handoff') {
    const order = heat.order && heat.order.length > 0 ? [...heat.order] : [...agents]
    const attemptLimitMin = heat.attemptLimitMin ?? 15
    return {
      mode: 'handoff',
      order,
      task: heat.task,
      agents: [...order],
      checks,
      setup,
      timeLimitMin: heat.timeLimitMin ?? attemptLimitMin,
      attemptLimitMin,
      overallLimitMin: heat.overallLimitMin ?? null,
      askBeforeNext: heat.askBeforeNext ?? false,
      allowCommands
    }
  }
  return {
    mode: 'race',
    task: heat.task,
    agents,
    checks,
    setup,
    timeLimitMin: heat.timeLimitMin ?? 30,
    allowCommands
  }
}

/**
 * Builds the four columns from the engines' state. Deterministic for a given input and `now`.
 * Cards the user archived are hidden. A heat a task is riding is not shown on its own (the task
 * carries it), and a task sent back (it has a note) reads as waiting again.
 */
export function buildBoard(input: BoardInput, now: number): Board {
  const archived = new Set(input.archived)
  const notes = input.notes
  const teammateAgents = input.teammateAgents ?? {}
  const heatById = new Map(input.heats.map((heat) => [heat.id, heat]))

  // Heats a task is riding are represented by the task, never on their own.
  const riddenByTask = new Set<string>()
  for (const task of input.tasks) if (task.heatId) riddenByTask.add(task.heatId)

  const board: Board = { waiting: [], running: [], review: [], done: [] }
  const add = (column: BoardColumn, card: BoardCard): void => {
    if (archived.has(card.id)) return
    board[column].push(card)
  }

  // Tasks.
  for (const task of input.tasks) {
    const heat = task.heatId ? heatById.get(task.heatId) : undefined
    const sentBack = notes[task.id] !== undefined
    const agents = taskAgents(task, teammateAgents)
    if (sentBack && task.status === 'review') {
      add('waiting', {
        id: task.id,
        kind: 'task',
        title: task.title,
        agents,
        since: task.updatedAt,
        latest: notes[task.id] ?? '',
        actions: ['run', 'archive']
      })
      continue
    }
    switch (task.status) {
      case 'todo':
        add('waiting', {
          id: task.id,
          kind: 'task',
          title: task.title,
          agents,
          since: task.updatedAt,
          latest: task.note || notes[task.id] || '',
          actions: ['run', 'archive']
        })
        break
      case 'running':
        add('running', {
          id: task.id,
          kind: 'task',
          title: task.title,
          agents,
          since: task.updatedAt,
          latest: latestLane(heat),
          actions: ['stop', 'archive']
        })
        break
      case 'review': {
        const actions: BoardAction[] = hasSingleWinner(heat)
          ? ['merge', 'sendback', 'markdone', 'archive']
          : goesToReview(heat)
            ? ['choose', 'sendback', 'markdone', 'archive']
            : ['sendback', 'markdone', 'archive']
        add('review', {
          id: task.id,
          kind: 'task',
          title: task.title,
          agents,
          since: task.updatedAt,
          latest: heat?.decision?.note ?? '',
          actions
        })
        break
      }
      case 'failed':
      case 'stopped':
        add('waiting', {
          id: task.id,
          kind: 'task',
          title: task.title,
          agents,
          since: task.updatedAt,
          latest: heat?.error ?? (task.status === 'failed' ? 'The last run failed.' : 'Stopped.'),
          actions: ['retry', 'archive']
        })
        break
      case 'done':
        if (inWindow(task.updatedAt, now)) {
          add('done', {
            id: task.id,
            kind: 'task',
            title: task.title,
            agents,
            since: task.updatedAt,
            latest: heat?.decision?.note ?? '',
            actions: ['archive']
          })
        }
        break
    }
  }

  // Heats that no task is riding (a race run straight from Skipper).
  for (const heat of input.heats) {
    if (riddenByTask.has(heat.id)) continue
    const agents = uniq(heat.lanes.map((lane) => lane.agent))
    const title = firstLine(heat.task)
    if (heat.status === 'baseline' || heat.status === 'racing' || heat.status === 'waiting') {
      add('running', {
        id: heat.id,
        kind: 'heat',
        title,
        agents,
        since: heat.createdAt,
        latest: latestLane(heat),
        actions: ['stop', 'archive']
      })
    } else if (heat.status === 'decided') {
      if (goesToReview(heat)) {
        add('review', {
          id: heat.id,
          kind: 'heat',
          title,
          agents,
          since: heat.createdAt,
          latest: heat.decision?.note ?? '',
          actions: hasSingleWinner(heat) ? ['merge', 'archive'] : ['choose', 'archive']
        })
      } else {
        add('waiting', {
          id: heat.id,
          kind: 'heat',
          title,
          agents,
          since: heat.createdAt,
          latest: heat.decision?.note ?? '',
          actions: ['retry', 'archive']
        })
      }
    } else if (heat.status === 'error') {
      add('waiting', {
        id: heat.id,
        kind: 'heat',
        title,
        agents,
        since: heat.createdAt,
        latest: heat.error ?? 'The heat failed.',
        actions: ['retry', 'archive']
      })
    } else if (heat.status === 'merged') {
      if (inWindow(heat.createdAt, now)) {
        add('done', {
          id: heat.id,
          kind: 'heat',
          title,
          agents,
          since: heat.createdAt,
          latest: heat.decision?.note ?? '',
          actions: ['archive']
        })
      }
    }
  }

  // Night watch: the queue waits, a night's runs move as the night goes.
  const night = input.night
  if (night) {
    for (const queued of night.queue) {
      add('waiting', {
        id: `nightq-${queued.id}`,
        kind: 'night',
        title: firstLine(queued.prompt),
        agents: uniq([queued.agent]),
        since: queued.createdAt,
        latest: 'Queued for tonight.',
        actions: ['archive']
      })
    }
    for (const run of night.nights.flatMap((n) => n.runs)) {
      const card: BoardCard = {
        id: `night-${run.id}`,
        kind: 'night',
        title: firstLine(run.prompt),
        agents: uniq([run.agent]),
        since: run.startedAt ?? run.endedAt ?? now,
        latest: run.latest || run.note,
        actions: ['archive']
      }
      if (run.status === 'running' || run.status === 'checking') add('running', card)
      else if (run.status === 'ready') add('review', { ...card, actions: ['merge', 'archive'] })
      else if (run.status === 'merged' && inWindow(run.endedAt ?? run.startedAt ?? now, now)) add('done', card)
    }
  }

  // Flows.
  for (const run of input.runs) {
    const merged = Boolean(run.mergeSummary)
    const parked = (run.notes ?? []).some((n) => n.includes('refs/regatta/discarded/'))
    const held = Boolean(run.worktree || run.branch)
    const discarded = !merged && !held && (parked || (run.isolated && (run.status === 'done' || run.status === 'stopped')))
    const card: BoardCard = {
      id: `flow-${run.id}`,
      kind: 'flow',
      title: run.flowName,
      agents: EMPTY,
      since: run.startedAt,
      latest: latestStep(run) || run.mergeSummary || '',
      actions: ['archive']
    }
    if (run.status === 'running') add('running', { ...card, actions: ['stop', 'archive'] })
    else if (run.status === 'waiting') add('review', { ...card, actions: ['approve', 'archive'] })
    else if (run.status === 'failed') add('waiting', { ...card, actions: ['retry', 'archive'] })
    else if (run.status === 'done' && !merged && held) add('review', { ...card, actions: ['merge', 'archive'] })
    else if ((merged || discarded) && inWindow(run.endedAt ?? run.startedAt, now)) add('done', card)
  }

  // Panes (the live sessions).
  for (const session of input.sessions) {
    const state = session.status.state
    const card: BoardCard = {
      id: session.id,
      kind: 'pane',
      title: session.title,
      agents: uniq([session.agent]),
      since: session.status.since,
      latest: session.status.reason,
      actions: ['archive']
    }
    if (state === 'working' || state === 'starting') add('running', { ...card, actions: ['stop', 'archive'] })
    else if (state === 'waiting') add('review', card)
  }

  return board
}

/** The first line of a multi-line string, trimmed, for a card title. */
function firstLine(text: string): string {
  const line = (text ?? '').split('\n')[0]?.trim() ?? ''
  return line || text.trim() || 'Untitled'
}

/** The last step of a flow run that has output, for its latest line. */
function latestStep(run: FlowRun): string {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const output = run.steps[i]?.output?.trim()
    if (output) return output.split('\n').slice(-1)[0] ?? output
  }
  return ''
}
