// Tasks: a tracked outcome handed to an agent or a crew member that comes back for review.
// Types plus the pure heat-to-task status mapping (unit tested in src/main/tasks.test.ts).
// See docs/design/heats.md "Tasks".

import type { AgentKind } from './types'
import type { CheckSpec, HeatState } from './heats'

export type TaskStatus = 'todo' | 'running' | 'review' | 'failed' | 'stopped' | 'done'

export type TaskAssignee = { kind: 'agent'; agent: AgentKind } | { kind: 'crew'; teammateId: string }

export interface Task {
  id: string
  title: string
  prompt: string
  /** Who does the work: an agent CLI directly, or a crew member (whose own agent leads). */
  assignee: TaskAssignee
  /** Agents that take over when the lead's attempts leave the checks failing. */
  backups: AgentKind[]
  checks: CheckSpec[]
  status: TaskStatus
  /** The hand-off heat this task is riding, or null before its first run. */
  heatId: string | null
  createdBy: 'you' | 'mcp' | 'crew'
  createdAt: number
  updatedAt: number
  /** A line the user keeps about the task. */
  note: string
}

/** What the form and the MCP tool send in: everything but the tracked fields. */
export type NewTask = Pick<Task, 'title' | 'prompt' | 'assignee' | 'backups' | 'checks' | 'note'>

/** What may be edited, and only while the task is not being worked on. */
export type TaskPatch = Partial<Pick<Task, 'title' | 'prompt' | 'assignee' | 'backups' | 'checks' | 'note'>>

/** One line per status, for the columns and the badges. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  running: 'Running',
  review: 'To review',
  failed: 'Failed',
  stopped: 'Stopped',
  done: 'Done'
}

/** A task can be edited, removed or started only in these statuses. */
export const EDITABLE_STATUSES: TaskStatus[] = ['todo', 'failed', 'stopped']

/**
 * Where a task stands from how its heat is going. A heat that no longer exists (dropped on
 * restart, or removed after a merge) leaves the status as it was. A person marks a task done,
 * and nothing unmarks it.
 */
export function statusFromHeat(heat: HeatState | undefined, current: TaskStatus): TaskStatus {
  if (current === 'done') return 'done'
  if (!heat) return current
  switch (heat.status) {
    case 'baseline':
    case 'racing':
    case 'waiting':
      return 'running'
    case 'decided': {
      // A winner, or a tie the user still has to break, is work waiting to be merged: review.
      const kind = heat.decision?.kind
      return kind === 'winner' || kind === 'tie' ? 'review' : 'failed'
    }
    case 'merged':
      return 'done'
    case 'cancelled':
      return 'stopped'
    case 'error':
      return 'failed'
  }
}
