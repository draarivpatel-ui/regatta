// MCP tools for schedules: list them and run one now.

import type { Schedule } from '../../shared/schedules'
import type { ScheduleEngine } from '../schedules'
import type { McpTool } from './tools'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function everyText(schedule: Schedule): string {
  const every = schedule.every
  if (every.kind === 'hours') return every.hours === 1 ? 'Every hour' : `Every ${every.hours} hours`
  if (every.kind === 'daily') return `Every day at ${every.time}`
  return `Every ${DAYS[every.day]} at ${every.time}`
}

export function targetText(schedule: Schedule): string {
  if (schedule.target.kind === 'crew') return `crew member ${schedule.target.teammateId}`
  return `flow ${schedule.target.flowId}`
}

function summaryLine(schedule: Schedule): string {
  const last = schedule.runs[0]
  const next = schedule.enabled && schedule.nextRunAt != null ? new Date(schedule.nextRunAt).toISOString() : 'off'
  const lastText = last ? `${last.ok ? 'ok' : 'failed'}: ${last.note}` : 'no runs yet'
  return `${schedule.name} (${schedule.id}): runs ${targetText(schedule)}, ${everyText(schedule)}, ${schedule.enabled ? 'on' : 'off'}, next run ${next}, last result ${lastText}`
}

function facts(schedule: Schedule): Record<string, unknown> {
  const last = schedule.runs[0] ?? null
  return {
    id: schedule.id,
    name: schedule.name,
    target: schedule.target,
    runs: targetText(schedule),
    every: schedule.every,
    howOften: everyText(schedule),
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt,
    lastResult: last ? { ok: last.ok, note: last.note, at: last.at } : null
  }
}

export function scheduleTools(engine: ScheduleEngine): McpTool[] {
  return [
    {
      name: 'regatta_list_schedules',
      title: 'List schedules',
      description: 'Lists the schedules that run a crew member prompt or a flow on a timer.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const schedules = engine.list()
        if (schedules.length === 0) return { text: 'No schedules yet.', data: [] }
        return { text: schedules.map(summaryLine).join('\n'), data: schedules.map(facts) }
      }
    },
    {
      name: 'regatta_run_schedule',
      title: 'Run a schedule now',
      description: 'Runs a schedule now without changing its next run.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The schedule id.' } },
        required: ['id'],
        additionalProperties: false
      },
      run: async (args) => {
        const id = args['id']
        if (typeof id !== 'string' || !id) return { text: 'Give a schedule id.', isError: true }
        try {
          const schedules = await engine.runNow(id)
          const found = schedules.find((s) => s.id === id)
          if (!found) return { text: `Ran schedule ${id}.`, data: { id } }
          return { text: `Ran ${found.name}.`, data: facts(found) }
        } catch (err) {
          return { text: err instanceof Error ? err.message : String(err), isError: true }
        }
      }
    }
  ]
}
