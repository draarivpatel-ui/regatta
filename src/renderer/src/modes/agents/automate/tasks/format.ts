// Small helpers for the Tasks view: its columns, status colors and assignee wording.

import { AGENTS } from '@shared/agents'
import type { Teammate } from '@shared/chat'
import type { AgentKind } from '@shared/types'
import type { Task, TaskStatus } from '@shared/tasks'

export interface TaskColumn {
  id: string
  label: string
  statuses: TaskStatus[]
}

/** The five columns, in the order they read. */
export const TASK_COLUMNS: TaskColumn[] = [
  { id: 'todo', label: 'To do', statuses: ['todo'] },
  { id: 'running', label: 'Running', statuses: ['running'] },
  { id: 'review', label: 'To review', statuses: ['review'] },
  { id: 'stopped', label: 'Failed and stopped', statuses: ['failed', 'stopped'] },
  { id: 'done', label: 'Done', statuses: ['done'] }
]

/** Done tasks older than this drop out of the column; the store keeps them. */
export const DONE_WINDOW_MS = 7 * 86_400_000

const STATUS_COLOR: Record<TaskStatus, string> = {
  todo: 'text-muted',
  running: 'text-st-working',
  review: 'text-st-waiting',
  failed: 'text-st-failed',
  stopped: 'text-st-quiet',
  done: 'text-st-idle'
}

/** The text color a status reads in. */
export function colorOf(status: TaskStatus): string {
  return STATUS_COLOR[status]
}

/** The agent that leads the work: the assignee itself, or a crew member's own agent. */
export function leadOf(task: Task, teammates: Teammate[]): AgentKind | null {
  const assignee = task.assignee
  if (assignee.kind === 'agent') return assignee.agent
  return teammates.find((mate) => mate.id === assignee.teammateId)?.agent ?? null
}

/** "Claude Code" for an agent, the name for a crew member, and a plain line when either is gone. */
export function assigneeName(task: Task, teammates: Teammate[]): string {
  const assignee = task.assignee
  if (assignee.kind === 'agent') return AGENTS[assignee.agent]?.name ?? assignee.agent
  const mate = teammates.find((t) => t.id === assignee.teammateId)
  return mate ? mate.name : 'A crew member that no longer exists'
}

/** Where a task belongs, with done tasks older than a week left out. */
export function columnOf(task: Task, now: number): TaskColumn | null {
  if (task.status === 'done' && now - task.updatedAt > DONE_WINDOW_MS) return null
  return TASK_COLUMNS.find((column) => column.statuses.includes(task.status)) ?? null
}
