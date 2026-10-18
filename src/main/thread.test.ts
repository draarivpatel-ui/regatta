// Unit tests for readThread.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentKind, SessionInfo, SessionStatus } from '../shared/types'
import { readThread } from './thread'

const folders: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-thread-'))
  folders.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true })
})

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const status: SessionStatus = { state: 'idle', since: 0, reason: 'ready', source: 'hook' }
  return {
    id: 's1',
    agent: 'fake',
    title: 'Test Agent',
    cwd: '/work/repo',
    command: 'fake',
    args: [],
    createdAt: 0,
    pid: 1,
    status,
    exitCode: null,
    signals: 'output',
    worktree: null,
    branch: null,
    limit: null,
    transcriptPath: null,
    account: null,
    ...overrides
  }
}

function writeTranscript(path: string, lines: unknown[]): void {
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
}

describe('readThread', () => {
  it('reads roles in order: user text, assistant text, then tool lines', async () => {
    const dir = tempDir()
    const path = join(dir, 't.jsonl')
    writeTranscript(path, [
      { type: 'user', timestamp: 1000, message: { role: 'user', content: 'Plan the release' } },
      {
        type: 'assistant',
        timestamp: 1001,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Here is the plan' },
            { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', id: 'b', name: 'Edit', input: { file_path: 'src/app.ts' } }
          ]
        }
      }
    ])

    const msgs = await readThread(makeSession({ transcriptPath: path }), dir)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(msgs[0]!.text).toBe('Plan the release')
    expect(msgs[1]!.text).toBe('Here is the plan')
    expect(msgs[2]!.text).toBe('Bash: npm test')
    expect(msgs[3]!.text).toBe('Edit: src/app.ts')
    expect(msgs[0]!.at).toBe(1000)
    expect(msgs[1]!.at).toBe(1001)
  })

  it('reads user arrays with text blocks and assistant arrays with a code block', async () => {
    const dir = tempDir()
    const path = join(dir, 't.jsonl')
    writeTranscript(path, [
      {
        type: 'user',
        timestamp: '2026-10-15T12:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Check this' }] }
      },
      {
        type: 'assistant',
        timestamp: '2026-10-15T12:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done:\n```ts\nconst x = 1\n```' }]
        }
      }
    ])

    const msgs = await readThread(makeSession({ transcriptPath: path }), dir)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[0]!.text).toBe('Check this')
    expect(msgs[1]!.role).toBe('assistant')
    expect(msgs[1]!.text).toContain('const x = 1')
    expect(msgs[0]!.at).toBe(Date.parse('2026-10-15T12:00:00.000Z'))
  })

  it('formats Read tool lines and trims long input to 120 characters', async () => {
    const dir = tempDir()
    const path = join(dir, 't.jsonl')
    writeTranscript(path, [
      {
        type: 'assistant',
        timestamp: 10,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'README.md' } },
            { type: 'tool_use', id: 'b', name: 'Bash', input: { command: `npm test ${'x'.repeat(200)}` } }
          ]
        }
      }
    ])

    const msgs = await readThread(makeSession({ transcriptPath: path }), dir)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.text).toBe('Read: README.md')
    expect(msgs[1]!.text.length).toBeLessThanOrEqual(120)
    expect(msgs[1]!.text.startsWith('Bash: npm test')).toBe(true)
  })

  it('skips tool result blocks and lines that are only system reminders', async () => {
    const dir = tempDir()
    const path = join(dir, 't.jsonl')
    writeTranscript(path, [
      {
        type: 'user',
        timestamp: 1,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: 'old output' },
            { type: 'text', text: 'Keep going' }
          ]
        }
      },
      {
        type: 'user',
        timestamp: 2,
        message: { role: 'user', content: '<system-reminder>Caveat here</system-reminder>' }
      },
      {
        type: 'user',
        timestamp: 3,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>Another note</system-reminder>' }]
        }
      }
    ])

    const msgs = await readThread(makeSession({ transcriptPath: path }), dir)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'Keep going' })
  })

  it('does not check the agent kind: a test agent session with a transcript is read', async () => {
    const dir = tempDir()
    const path = join(dir, 't.jsonl')
    writeTranscript(path, [
      { type: 'user', timestamp: 1, message: { role: 'user', content: 'hello' } }
    ])

    const fake = await readThread(makeSession({ agent: 'fake' as AgentKind, transcriptPath: path }), dir)
    expect(fake).toHaveLength(1)
    const shell = await readThread(makeSession({ agent: 'shell' as AgentKind, transcriptPath: path }), dir)
    expect(shell).toHaveLength(1)
  })

  it('keeps only the last 300 messages', async () => {
    const dir = tempDir()
    const path = join(dir, 't.jsonl')
    const lines = Array.from({ length: 310 }, (_, i) => ({
      type: 'user',
      timestamp: 1000 + i,
      message: { role: 'user', content: `msg ${i}` }
    }))
    writeTranscript(path, lines)

    const msgs = await readThread(makeSession({ transcriptPath: path }), dir)
    expect(msgs).toHaveLength(300)
    expect(msgs[0]!.text).toBe('msg 10')
    expect(msgs[299]!.text).toBe('msg 309')
  })

  it('resolves a relative transcript path against home', async () => {
    const dir = tempDir()
    writeTranscript(join(dir, 'rel.jsonl'), [
      { type: 'user', timestamp: 1, message: { role: 'user', content: 'hi' } }
    ])

    const msgs = await readThread(makeSession({ transcriptPath: 'rel.jsonl' }), dir)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.text).toBe('hi')
  })

  it('gives [] for a missing file', async () => {
    const dir = tempDir()
    const msgs = await readThread(makeSession({ transcriptPath: join(dir, 'missing.jsonl') }), dir)
    expect(msgs).toEqual([])
  })

  it('gives [] for a session without a transcript', async () => {
    const dir = tempDir()
    expect(await readThread(makeSession({ transcriptPath: null }), dir)).toEqual([])
    expect(await readThread(makeSession({ transcriptPath: '' }), dir)).toEqual([])
  })
})
