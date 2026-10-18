// Unit tests for the task MCP tools.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Task } from '../../shared/tasks'
import { TaskStore } from '../tasks'
import { taskTools } from './task-tools'

const cleanup: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-task-tools-'))
  cleanup.push(dir)
  return join(dir, 'data')
}

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

/** A store whose heat and night deps are never reached: these tools only list and create. */
function storeFor(dataDir: string): { store: TaskStore; started: number; night: number } {
  let started = 0
  let night = 0
  const store = new TaskStore({
    dataDir,
    startHeat: async () => {
      started += 1
      return { id: 'heat-1' }
    },
    night: {
      addTask: () => {
        night += 1
        return null
      }
    },
    teammates: () => [],
    skills: () => [],
    emit: () => undefined,
    now: () => 1_700_000_000_000
  })
  return {
    store,
    get started(): number {
      return started
    },
    get night(): number {
      return night
    }
  }
}

describe('taskTools', () => {
  it('offers only list and create, so a client cannot start a task', () => {
    const { store } = storeFor(tempDir())
    expect(taskTools(store).map((tool) => tool.name)).toEqual(['regatta_list_tasks', 'regatta_create_task'])
  })

  it('creates a task in To do with createdBy mcp, with nothing run', async () => {
    const holder = storeFor(tempDir())
    const [, create] = taskTools(holder.store)
    const made = await create!.run({ title: 'Tidy the docs', prompt: 'Fix the setup steps in README.md.', agent: 'codex' })
    expect(made.isError).toBeFalsy()
    expect(made.text).toContain('Tidy the docs')
    expect(made.text).toContain('To do')
    const created = made.data as Task
    expect(created.status).toBe('todo')
    expect(created.createdBy).toBe('mcp')
    expect(created.assignee).toEqual({ kind: 'agent', agent: 'codex' })
    expect(created.checks).toEqual([])
    expect(created.heatId).toBeNull()
    expect(holder.started).toBe(0)
    expect(holder.night).toBe(0)
    // Without checks a task cannot be run, which is the store's rule, not a tool's.
    await expect(holder.store.run(created.id)).rejects.toThrow(/check/)
  })

  it('lists tasks with their status, who they are handed to and the heat they ride', async () => {
    const holder = storeFor(tempDir())
    const [list] = taskTools(holder.store)
    const empty = await list!.run({})
    expect(empty.text).toContain('No tasks')
    expect(empty.data).toEqual([])
    holder.store.create(
      {
        title: 'Fix the flaky test',
        prompt: 'Make the cart test stop failing.',
        assignee: { kind: 'agent', agent: 'claude' },
        backups: ['codex'],
        checks: [{ name: 'test', command: 'npm test', kind: 'required' }],
        note: ''
      },
      'you'
    )
    const result = await list!.run({})
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('Fix the flaky test')
    expect(result.text).toContain('agent claude')
    expect(result.text).toContain('1 check')
    const rows = result.data as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!['status']).toBe('todo')
    expect(rows[0]!['statusLabel']).toBe('To do')
    const onlyDone = await list!.run({ status: 'done' })
    expect(onlyDone.text).toContain('No tasks are Done')
    expect(onlyDone.data).toEqual([])
  })

  it('refuses a bad create as an error, never a throw', async () => {
    const { store } = storeFor(tempDir())
    const [, create] = taskTools(store)
    expect((await create!.run({ prompt: 'Do it', agent: 'claude' })).isError).toBe(true)
    expect((await create!.run({ title: 'Do it', agent: 'claude' })).isError).toBe(true)
    expect((await create!.run({ title: 'Do it', prompt: 'Do it', agent: 'nope' })).isError).toBe(true)
    const blankTitle = await create!.run({ title: '   ', prompt: 'Do it', agent: 'claude' })
    expect(blankTitle.isError).toBe(true)
    expect(blankTitle.text).toContain('title')
    expect(store.list()).toHaveLength(0)
  })
})
