// MCP tools for tasks: list them and create one. A client may never start a task.

import { AGENTS } from '../../shared/agents'
import type { AgentKind } from '../../shared/types'
import type { Task, TaskStatus } from '../../shared/tasks'
import { TASK_STATUS_LABEL } from '../../shared/tasks'
import type { TaskStore } from '../tasks'
import type { McpTool } from './tools'

const STATUSES: TaskStatus[] = ['todo', 'running', 'review', 'failed', 'stopped', 'done']

function assigneeText(task: Task): string {
  if (task.assignee.kind === 'agent') return `agent ${task.assignee.agent}`
  return `crew member ${task.assignee.teammateId}`
}

function summaryLine(task: Task): string {
  const heat = task.heatId ? `, heat ${task.heatId}` : ''
  const checks = task.checks.length === 0 ? 'no checks' : `${task.checks.length} ${task.checks.length === 1 ? 'check' : 'checks'}`
  return `${task.title} (${task.id}): ${TASK_STATUS_LABEL[task.status]}, ${assigneeText(task)}, ${checks}${heat}, updated ${new Date(task.updatedAt).toISOString()}`
}

function facts(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    assignee: task.assignee,
    assignedTo: assigneeText(task),
    backups: task.backups,
    checks: task.checks,
    status: task.status,
    statusLabel: TASK_STATUS_LABEL[task.status],
    createdBy: task.createdBy,
    heatId: task.heatId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    note: task.note
  }
}

export function taskTools(store: TaskStore): McpTool[] {
  return [
    {
      name: 'regatta_list_tasks',
      title: 'List tasks',
      description:
        'The tasks tracked in Regatta: what each is for, who it is handed to, its checks, its status and the heat it is riding.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: STATUSES,
            description: 'Return only tasks in this status. Omit for every task.'
          }
        },
        additionalProperties: false
      },
      run: async (args) => {
        const wanted = args['status']
        if (wanted !== undefined && typeof wanted !== 'string') {
          return { text: 'Read the status as one of the listed words.', isError: true }
        }
        let tasks = store.list()
        if (typeof wanted === 'string') tasks = tasks.filter((task) => task.status === wanted)
        if (tasks.length === 0) {
          return { text: wanted ? `No tasks are ${TASK_STATUS_LABEL[wanted as TaskStatus] ?? wanted}.` : 'No tasks yet.', data: [] }
        }
        return { text: tasks.map(summaryLine).join('\n'), data: tasks.map(facts) }
      }
    },
    {
      name: 'regatta_create_task',
      title: 'Create a task',
      description:
        'Creates a task in the To do column, handed to an agent. Only a person in Regatta starts a task, and a task needs checks before it can run.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'One line naming the outcome, 120 characters or fewer.' },
          prompt: { type: 'string', description: 'What the agent is told to do, 4,000 characters or fewer.' },
          agent: {
            type: 'string',
            enum: Object.keys(AGENTS),
            description: 'Which agent CLI leads the work, for example "claude" or "codex".'
          }
        },
        required: ['title', 'prompt', 'agent'],
        additionalProperties: false
      },
      run: async (args) => {
        const title = args['title']
        const prompt = args['prompt']
        const agent = args['agent']
        if (typeof title !== 'string' || !title.trim()) return { text: 'Give the task a title.', isError: true }
        if (typeof prompt !== 'string' || !prompt.trim()) return { text: 'Write what the task is for.', isError: true }
        if (typeof agent !== 'string' || !AGENTS[agent as AgentKind]) {
          return { text: `Pick an agent Regatta knows: ${Object.keys(AGENTS).join(', ')}.`, isError: true }
        }
        try {
          const tasks = store.create(
            {
              title: title.trim(),
              prompt: prompt.trim(),
              assignee: { kind: 'agent', agent: agent as AgentKind },
              backups: [],
              checks: [],
              note: ''
            },
            'mcp'
          )
          const created = tasks.find((task) => task.title === title.trim() && task.createdBy === 'mcp')
          if (!created) return { text: `Created "${title.trim()}".` }
          return {
            text: `Created "${created.title}" (${created.id}) in To do, handed to ${assigneeText(created)}. Only a person in Regatta can start it.`,
            data: facts(created)
          }
        } catch (err) {
          return { text: err instanceof Error ? err.message : String(err), isError: true }
        }
      }
    }
  ]
}
