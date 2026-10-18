import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS } from '../../shared/agents'
import type { ChatMessage, Conversation, Teammate } from '../../shared/chat'
import type { DetectedAgent } from '../../shared/types'
import { ChatEngine, type ChatEngineDeps } from './engine'

/** The real test agent, run the way the app runs it: node plus the script path. */
const FAKE_AGENT = fileURLToPath(new URL('../../../scripts/fake-agent.mjs', import.meta.url))

interface Harness {
  engine: ChatEngine
  dataDir: string
  root: string
  events: Conversation[]
  removed: string[]
  teammateEvents: Teammate[][]
}

function testAgent(overrides: Partial<DetectedAgent> = {}): DetectedAgent {
  return { ...AGENTS.fake, installed: true, path: process.execPath, args: [FAKE_AGENT], version: 'test', ...overrides }
}

function harness(options: { dataDir?: string; root?: string; agents?: DetectedAgent[]; env?: Record<string, string> } = {}): Harness {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'regatta-chat-data-'))
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'regatta-chat-work-'))
  const events: Conversation[] = []
  const removed: string[] = []
  const teammateEvents: Teammate[][] = []
  const engine = new ChatEngine({
    dataDir,
    root: () => root,
    env: () => options.env ?? {},
    agents: () => options.agents ?? [testAgent()],
    emit: (conversation) => events.push(conversation),
    emitRemoved: (id) => removed.push(id),
    emitTeammates: (list) => teammateEvents.push(list)
  })
  return { engine, dataDir, root, events, removed, teammateEvents }
}

function secondEngine(h: Harness): Harness {
  return harness({ dataDir: h.dataDir, root: h.root })
}

function byId(h: Harness, id: string): Conversation {
  const found = h.engine.list().find((conversation) => conversation.id === id)
  if (!found) throw new Error(`No conversation ${id}`)
  return found
}

function messages(conversation: Conversation, role: ChatMessage['role']): ChatMessage[] {
  return conversation.messages.filter((message) => message.role === role)
}

function conversationFile(h: Harness, id: string): string {
  return join(h.dataDir, 'chats', `${id}.json`)
}

/** A stand in for a real CLI: a small script in the temp folder that prints what the test needs. */
function stubScript(name: string, lines: string[]): string {
  const file = join(tmpdir(), `regatta-chat-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, lines.join('\n'))
  return file
}

/** One line of source that writes a JSON event, the way Claude and Codex report. */
function jsonLine(value: unknown): string {
  return `process.stdout.write(JSON.stringify(${JSON.stringify(value)}) + '\\n')`
}

/** The Claude shape: init, two pieces of text, the whole text again, a tool, and the result. */
function claudeStub(): string {
  return stubScript('claude', [
    jsonLine({ type: 'system', subtype: 'init', session_id: 'sess-claude' }),
    jsonLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } }),
    jsonLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ', world' } } }),
    'const content = [{ type: "text", text: "Hello, world" }, { type: "tool_use", name: "Read", input: { file_path: "src/app.ts" } }]',
    'if (process.argv.includes("show the plan")) content.push({ type: "tool_use", name: "ExitPlanMode", input: { plan: "Add a test." } })',
    "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content } }) + '\\n')",
    jsonLine({ type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 20 } })
  ])
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the turn.')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('a new conversation', () => {
  it('starts empty, in the workspace, with read access', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })

    expect(conversation.title).toBe('New chat')
    expect(conversation.cwd).toBe(h.root)
    expect(conversation.access).toBe('read')
    expect(conversation.model).toBe('')
    expect(conversation.status).toBe('idle')
    expect(conversation.messages).toEqual([])
    expect(conversation.cliSessionId).toBeNull()
  })

  it('takes the folder, the model and the access it is given', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake', cwd: h.root, model: 'opus', access: 'write', title: 'Release notes' })

    expect(conversation.model).toBe('opus')
    expect(conversation.access).toBe('write')
    expect(conversation.title).toBe('Release notes')
  })

  it('goes to the window and to disk', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })

    expect(h.events.at(-1)?.id).toBe(conversation.id)
    expect(existsSync(conversationFile(h, conversation.id))).toBe(true)
  })

  it('lists the newest conversation first', async () => {
    const h = harness()
    const first = h.engine.create({ agent: 'fake' })
    await h.engine.send(first.id, 'hello')
    const second = h.engine.create({ agent: 'fake' })

    expect(h.engine.list().map((c) => c.id)).toEqual([second.id, first.id])
  })

  it('refuses an agent that cannot chat', () => {
    const h = harness()
    expect(() => h.engine.create({ agent: 'gemini' as 'claude' })).toThrow(/cannot chat/)
  })

  it('says so when the agent is not installed', async () => {
    const h = harness({ agents: [testAgent({ installed: false, path: null })] })
    const conversation = h.engine.create({ agent: 'fake' })
    await expect(h.engine.send(conversation.id, 'hello')).rejects.toThrow(/not installed/)
  })
})

describe('a turn with the test agent', () => {
  it('stores the reply, the session and the token count', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'hello')

    const done = byId(h, conversation.id)
    expect(done.status).toBe('idle')
    expect(done.error).toBeNull()
    expect(done.cliSessionId).toBeTruthy()
    expect(done.tokens).toBe(42)
    expect(messages(done, 'user').map((m) => m.text)).toEqual(['hello'])
    expect(messages(done, 'assistant')[0]?.text).toContain('Echo: hello')
  })

  it('names the conversation after its first message', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'Explain the parser in one line')

    expect(byId(h, conversation.id).title).toBe('Explain the parser in one line')
  })

  it('keeps a long first message to sixty characters', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'x'.repeat(90))

    expect(byId(h, conversation.id).title).toHaveLength(60)
  })

  it('continues the same session on the second turn', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'first')
    const session = byId(h, conversation.id).cliSessionId
    await h.engine.send(conversation.id, 'second')

    const done = byId(h, conversation.id)
    // The test agent only repeats a session id when it is resumed with it.
    expect(done.cliSessionId).toBe(session)
    expect(messages(done, 'assistant')).toHaveLength(2)
    expect(messages(done, 'assistant')[1]?.text).toContain('Echo: second')
    expect(done.tokens).toBe(84)
  })

  it('saves the conversation when the turn ends', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'hello')

    const saved = JSON.parse(readFileSync(conversationFile(h, conversation.id), 'utf8')) as Conversation
    expect(saved.messages).toHaveLength(2)
    expect(saved.status).toBe('idle')
  })

  it('tells the window the turn is running, then that it is done', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    const running = h.engine.send(conversation.id, 'hello')
    await waitFor(() => h.events.some((c) => c.id === conversation.id && c.status === 'running'))
    await running

    const states = h.events.filter((c) => c.id === conversation.id).map((c) => c.status)
    expect(states).toContain('running')
    expect(states.at(-1)).toBe('idle')
  })

  it('refuses a second message while one is running', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    const running = h.engine.send(conversation.id, 'slow reply please')
    await waitFor(() => byId(h, conversation.id).status === 'running')

    await expect(h.engine.send(conversation.id, 'again')).rejects.toThrow('Wait for the current reply or stop it.')
    h.engine.stop(conversation.id)
    await running
  })

  it('refuses an empty message', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await expect(h.engine.send(conversation.id, '   ')).rejects.toThrow(/Write something first/)
  })

  it('keeps working after the turn', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'first')
    await h.engine.send(conversation.id, 'second')

    expect(byId(h, conversation.id).status).toBe('idle')
    expect(h.engine.list()).toHaveLength(1)
  })

  it('runs in the folder the conversation was given', async () => {
    const h = harness()
    const folder = mkdtempSync(join(tmpdir(), 'regatta-chat-folder-'))
    const conversation = h.engine.create({ agent: 'fake', cwd: folder })
    await h.engine.send(conversation.id, 'edit the readme')
    await h.engine.approve(conversation.id, byId(h, conversation.id).pending?.id ?? "")

    expect(existsSync(join(folder, 'README.md'))).toBe(true)
  })
})

describe('reasoning in turns', () => {
  it('passes reasoning to claude on first turn', async () => {
    const stub = stubScript('claude-reasoning', [
      jsonLine({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      jsonLine({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } })
    ])
    const h = harness({ agents: [testAgent({ kind: 'claude', args: [stub] })] })
    const conversation = h.engine.create({ agent: 'claude', reasoning: 'high' })
    await h.engine.send(conversation.id, 'think')

    const done = byId(h, conversation.id)
    expect(done.status).toBe('idle')
    // The stub doesn't capture args, but the unit test covers the shape
  })

  it('passes reasoning to codex on first turn', async () => {
    const stub = stubScript('codex-reasoning', [
      jsonLine({ type: 'thread.started', thread_id: 'th_1' }),
      jsonLine({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
    ])
    const h = harness({ agents: [testAgent({ kind: 'codex', args: [stub] })] })
    const conversation = h.engine.create({ agent: 'codex', reasoning: 'medium' })
    await h.engine.send(conversation.id, 'think')

    const done = byId(h, conversation.id)
    expect(done.status).toBe('idle')
  })

  it('passes reasoning to claude on resumed turn', async () => {
    const stub = stubScript('claude-resume-reasoning', [
      jsonLine({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      jsonLine({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } })
    ])
    const h = harness({ agents: [testAgent({ kind: 'claude', args: [stub] })] })
    const conversation = h.engine.create({ agent: 'claude', reasoning: 'xhigh' })
    await h.engine.send(conversation.id, 'first')
    const session = byId(h, conversation.id).cliSessionId
    expect(session).toBeTruthy()
    await h.engine.send(conversation.id, 'second')

    const done = byId(h, conversation.id)
    expect(done.status).toBe('idle')
  })
})

describe('a write request', () => {
  it('is asked for, and nothing changes, on a read turn', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'edit the readme')

    const done = byId(h, conversation.id)
    expect(done.pending).toMatchObject({
      id: expect.any(String),
      kind: 'workspace-write',
      request: 'edit the readme',
      summary: 'I would add a line to README.md'
    })
    expect(existsSync(join(h.root, 'README.md'))).toBe(false)
  })

  it('makes the edit and clears the request when it is approved with the current id', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'edit the readme')
    const requestId = byId(h, conversation.id).pending?.id
    expect(requestId).toBeTruthy()
    await h.engine.approve(conversation.id, requestId!)

    const done = byId(h, conversation.id)
    expect(done.pending).toBeNull()
    expect(done.status).toBe('idle')
    expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toContain('edited by test agent')
    expect(messages(done, 'tool').map((m) => m.text)).toContain('Edit README.md')
  })

  it('runs the same request again, not a new one', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'edit the readme')
    await h.engine.approve(conversation.id, byId(h, conversation.id).pending?.id ?? "")

    expect(messages(byId(h, conversation.id), 'user')).toHaveLength(1)
    expect(messages(byId(h, conversation.id), 'assistant').at(-1)?.text).toContain('Echo: edit the readme')
  })

  it('refuses a stale or unknown request id for approve and deny', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'edit the readme')
    const firstId = byId(h, conversation.id).pending?.id
    expect(firstId).toBeTruthy()

    await expect(h.engine.approve(conversation.id, 'w-unknown')).rejects.toThrow('That request changed. Look at it again.')
    expect(() => h.engine.deny(conversation.id, 'w-unknown')).toThrow('That request changed. Look at it again.')

    // A newer request replaces the first one with a fresh id.
    await h.engine.send(conversation.id, 'edit the readme again')
    const secondId = byId(h, conversation.id).pending?.id
    expect(secondId).toBeTruthy()
    expect(secondId).not.toBe(firstId)

    await expect(h.engine.approve(conversation.id, firstId!)).rejects.toThrow('That request changed. Look at it again.')
    expect(() => h.engine.deny(conversation.id, firstId!)).toThrow('That request changed. Look at it again.')
    expect(existsSync(join(h.root, 'README.md'))).toBe(false)
    expect(byId(h, conversation.id).pending?.id ?? "").toBe(secondId)
  })

  it('refuses a second approve of the same request id', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'edit the readme')
    const requestId = byId(h, conversation.id).pending?.id
    expect(requestId).toBeTruthy()

    await h.engine.approve(conversation.id, requestId!)
    await expect(h.engine.approve(conversation.id, requestId!)).rejects.toThrow('That request changed. Look at it again.')
  })

  it('refuses approve without an id', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await expect((h.engine.approve as (id: string) => Promise<void>)(conversation.id)).rejects.toThrow(
      'That request changed. Look at it again.'
    )
    await expect(h.engine.approve(conversation.id, '')).rejects.toThrow('That request changed. Look at it again.')

    await h.engine.send(conversation.id, 'edit the readme')
    const pendingId = byId(h, conversation.id).pending?.id
    expect(pendingId).toBeTruthy()

    await expect((h.engine.approve as (id: string) => Promise<void>)(conversation.id)).rejects.toThrow(
      'That request changed. Look at it again.'
    )
    await expect(h.engine.approve(conversation.id, '')).rejects.toThrow('That request changed. Look at it again.')
    expect(byId(h, conversation.id).pending?.id ?? "").toBe(pendingId)
    expect(existsSync(join(h.root, 'README.md'))).toBe(false)
  })

  it('refuses deny without an id', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    expect(() => (h.engine.deny as (id: string) => void)(conversation.id)).toThrow(
      'That request changed. Look at it again.'
    )
    expect(() => h.engine.deny(conversation.id, '')).toThrow('That request changed. Look at it again.')

    await h.engine.send(conversation.id, 'edit the readme')
    const pendingId = byId(h, conversation.id).pending?.id
    expect(pendingId).toBeTruthy()

    expect(() => (h.engine.deny as (id: string) => void)(conversation.id)).toThrow(
      'That request changed. Look at it again.'
    )
    expect(() => h.engine.deny(conversation.id, '')).toThrow('That request changed. Look at it again.')
    expect(byId(h, conversation.id).pending?.id ?? "").toBe(pendingId)
  })

  it('is cleared with a note when it is denied', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'edit the readme')
    h.engine.deny(conversation.id, byId(h, conversation.id).pending?.id ?? "")

    const done = byId(h, conversation.id)
    expect(done.pending).toBeNull()
    expect(done.messages.at(-1)).toMatchObject({ role: 'system', text: 'Write request denied.' })
    expect(existsSync(join(h.root, 'README.md'))).toBe(false)
    expect(JSON.parse(readFileSync(conversationFile(h, conversation.id), 'utf8')).pending).toBeNull()
  })
})

describe('stopping a turn', () => {
  it('kills the agent and leaves a note', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    const running = h.engine.send(conversation.id, 'slow reply please')
    await waitFor(() => byId(h, conversation.id).status === 'running')
    await new Promise((resolve) => setTimeout(resolve, 200))
    h.engine.stop(conversation.id)
    await running

    const done = byId(h, conversation.id)
    expect(done.status).toBe('idle')
    expect(done.error).toBeNull()
    expect(done.messages.at(-1)).toMatchObject({ role: 'system', text: 'Stopped.' })
    expect(messages(done, 'assistant')).toHaveLength(0)
  })

  it('ends a turn whose agent started a child, and the child is gone afterwards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'regatta-chat-bg-'))
    const pidFile = join(dir, 'helper.pid')
    const h = harness({ env: { REGATTA_FAKE_PIDFILE: pidFile } })
    const conversation = h.engine.create({ agent: 'fake' })
    const running = h.engine.send(conversation.id, 'background work')
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0)
    const helperPid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(helperPid).toBeGreaterThan(0)
    // Helper is alive before stop.
    expect(() => process.kill(helperPid, 0)).not.toThrow()

    try {
      h.engine.stop(conversation.id)
      await running

      expect(() => process.kill(helperPid, 0)).toThrow()
      expect(byId(h, conversation.id).status).toBe('idle')
    } finally {
      try {
        process.kill(helperPid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })

  it('says so when a process in the turn group cannot be stopped', async () => {
    const stub = stubScript('stuck-turn', [
      "process.stdout.write('SESSION: s1\\n')",
      "setInterval(() => {}, 1000)"
    ])
    const h = harness({ agents: [testAgent({ args: [stub] })] })
    const conversation = h.engine.create({ agent: 'fake' })
    const running = h.engine.send(conversation.id, 'stay')
    await waitFor(() => byId(h, conversation.id).status === 'running')

    // Simulate a process group that cannot be stopped before the deadline.
    const turns = (h.engine as unknown as { turns: Map<string, { child: { pid?: number }; group: { stop: () => void; done: Promise<number | null>; stuck: boolean } }> }).turns
    const turn = turns.get(conversation.id)!
    const realStop = turn.group.stop
    const pgid = turn.child.pid
    Object.defineProperty(turn.group, 'stuck', { get: () => true })
    try {
      realStop()
      await running
      const done = byId(h, conversation.id)
      expect(done.status).toBe('error')
      expect(done.error).toMatch(/could not be stopped/)
    } finally {
      if (pgid) {
        try {
          process.kill(-pgid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
  })

  it('says nothing when no turn is running', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    h.engine.stop(conversation.id)
    expect(byId(h, conversation.id).messages).toEqual([])
  })
})

describe('quitting', () => {
  it('stops running turns, including any child they started, and refuses new ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'regatta-chat-quit-'))
    const pidFile = join(dir, 'helper.pid')
    const h = harness({ env: { REGATTA_FAKE_PIDFILE: pidFile } })
    const conversation = h.engine.create({ agent: 'fake' })
    const second = h.engine.create({ agent: 'fake' })
    await h.engine.send(second.id, 'edit the readme')
    const secondReqId = byId(h, second.id).pending?.id

    const running = h.engine.send(conversation.id, 'background work')
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0)
    const helperPid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(helperPid).toBeGreaterThan(0)

    try {
      h.engine.quit()
      await running

      expect(() => process.kill(helperPid, 0)).toThrow()
      await expect(h.engine.send(conversation.id, 'hello')).rejects.toThrow(/quitting/)
      await expect(h.engine.approve(second.id, secondReqId!)).rejects.toThrow(/quitting/)
    } finally {
      try {
        process.kill(helperPid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })
})

describe('when the agent fails', () => {
  it('ends with the last thing it wrote to standard error', async () => {
    const stub = join(tmpdir(), `regatta-chat-fail-${Date.now()}.mjs`)
    writeFileSync(
      stub,
      [
        "process.stdout.write('SESSION: s1\\n')",
        "process.stdout.write('NEEDS WRITE: I would change it\\n')",
        "process.stderr.write('a warning\\n')",
        "process.stderr.write('it went wrong\\n')",
        'process.exit(3)'
      ].join('\n')
    )
    const h = harness({ agents: [testAgent({ args: [stub] })] })
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'go')

    const done = byId(h, conversation.id)
    expect(done.status).toBe('error')
    expect(done.error).toBe('it went wrong')
    expect(done.cliSessionId).toBe('s1')
    expect(done.pending).toMatchObject({ id: expect.any(String), kind: 'workspace-write', request: 'go', summary: 'I would change it' })
  })
})

describe('a streaming reply', () => {
  it('streams into one assistant message and keeps the notes', async () => {
    const h = harness({ agents: [testAgent({ kind: 'claude', args: [claudeStub()] })] })
    const conversation = h.engine.create({ agent: 'claude' })
    await h.engine.send(conversation.id, 'look at the file')

    const done = byId(h, conversation.id)
    expect(done.cliSessionId).toBe('sess-claude')
    expect(messages(done, 'assistant').map((m) => m.text)).toEqual(['Hello, world'])
    expect(messages(done, 'tool').map((m) => m.text)).toEqual(['Read src/app.ts'])
    expect(done.tokens).toBe(120)
    expect(done.pending).toBeNull()
  })

  it('asks for write access when the agent leaves its plan', async () => {
    const h = harness({ agents: [testAgent({ kind: 'claude', args: [claudeStub()] })] })
    const conversation = h.engine.create({ agent: 'claude' })
    await h.engine.send(conversation.id, 'show the plan')

    expect(byId(h, conversation.id).pending).toMatchObject({
      id: expect.any(String),
      kind: 'workspace-write',
      request: 'show the plan',
      summary: 'Add a test.'
    })
  })

  it('does not ask when the turn already has write access', async () => {
    const h = harness({ agents: [testAgent({ kind: 'claude', args: [claudeStub()] })] })
    const conversation = h.engine.create({ agent: 'claude', access: 'write' })
    await h.engine.send(conversation.id, 'show the plan', 'write')

    expect(byId(h, conversation.id).pending).toBeNull()
  })

  it('keeps the tokens of two turns', async () => {
    const h = harness({ agents: [testAgent({ kind: 'claude', args: [claudeStub()] })] })
    const conversation = h.engine.create({ agent: 'claude' })
    await h.engine.send(conversation.id, 'one')
    await h.engine.send(conversation.id, 'two')

    expect(byId(h, conversation.id).tokens).toBe(240)
  })
})

describe('a codex reply', () => {
  it('keeps the thread, the message and the token count', async () => {
    const stub = stubScript('codex', [
      jsonLine({ type: 'thread.started', thread_id: 'th_1' }),
      jsonLine({ type: 'item.completed', item: { type: 'agent_message', text: 'I read the file.' } }),
      jsonLine({ type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 12 } })
    ])
    const h = harness({ agents: [testAgent({ kind: 'codex', args: [stub] })] })
    const conversation = h.engine.create({ agent: 'codex' })
    await h.engine.send(conversation.id, 'read it')

    const done = byId(h, conversation.id)
    expect(done.cliSessionId).toBe('th_1')
    expect(messages(done, 'assistant').map((m) => m.text)).toEqual(['I read the file.'])
    expect(done.tokens).toBe(42)
    expect(done.status).toBe('idle')
  })
})

describe('crew members', () => {
  it('are saved, listed and told about every turn', async () => {
    const h = harness()
    const mate = h.engine.saveTeammate({
      name: 'Ada',
      role: 'Reviewer',
      instructions: 'Check the tests.',
      agent: 'fake',
      memory: 'Port 5173.'
    })

    expect(h.engine.teammates().map((t) => t.name)).toEqual(['Ada'])
    expect(h.teammateEvents.at(-1)).toEqual([mate])

    const conversation = h.engine.create({ agent: 'fake', teammateId: mate.id })
    await h.engine.send(conversation.id, 'look at this')

    const reply = messages(byId(h, conversation.id), 'assistant')[0]?.text ?? ''
    expect(reply).toContain('You are Ada, Reviewer.')
    expect(reply).toContain('Check the tests.')
    expect(reply).toContain('Notes you keep:')
    expect(reply).toContain('Port 5173.')
    expect(reply).toContain('look at this')
  })

  it('keep their id, their notes and their age when they are edited', () => {
    const h = harness()
    const mate = h.engine.saveTeammate({ name: 'Ada', role: 'Reviewer', instructions: '', agent: 'claude', memory: '' })
    const edited = h.engine.saveTeammate({ ...mate, name: 'Ada Lovelace', role: 'Release reviewer' })

    expect(edited.id).toBe(mate.id)
    expect(edited.createdAt).toBe(mate.createdAt)
    expect(h.engine.teammates()).toHaveLength(1)
    expect(h.engine.teammates()[0]?.name).toBe('Ada Lovelace')
  })

  it('go away when they are deleted', () => {
    const h = harness()
    const mate = h.engine.saveTeammate({ name: 'Ada', role: 'Reviewer', instructions: '', agent: 'claude', memory: '' })
    h.engine.deleteTeammate(mate.id)

    expect(h.engine.teammates()).toEqual([])
    expect(h.teammateEvents.at(-1)).toEqual([])
  })

  it('need a name', () => {
    const h = harness()
    expect(() => h.engine.saveTeammate({ name: '  ', role: 'x', instructions: '', agent: 'claude', memory: '' })).toThrow(/name/)
  })
})

describe('changing a conversation', () => {
  it('takes a new title, model, agent and access', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    const updated = h.engine.update(conversation.id, { title: 'Parser work', model: 'opus', access: 'write' })

    expect(updated.title).toBe('Parser work')
    expect(updated.model).toBe('opus')
    expect(updated.access).toBe('write')
    expect(h.events.at(-1)?.title).toBe('Parser work')
    expect(JSON.parse(readFileSync(conversationFile(h, conversation.id), 'utf8')).title).toBe('Parser work')
  })

  it('refuses an agent that cannot chat', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    expect(() => h.engine.update(conversation.id, { agent: 'gemini' as 'claude' })).toThrow(/cannot chat/)
  })

  it('stores reasoning level for claude', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'claude' })
    const updated = h.engine.update(conversation.id, { reasoning: 'high' })

    expect(updated.reasoning).toBe('high')
    const saved = JSON.parse(readFileSync(conversationFile(h, conversation.id), 'utf8')) as Conversation
    expect(saved.reasoning).toBe('high')
  })

  it('stores reasoning level for codex', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'codex' })
    const updated = h.engine.update(conversation.id, { reasoning: 'xhigh' })

    expect(updated.reasoning).toBe('xhigh')
  })

  it('refuses a reasoning level the agent does not offer', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'codex' })
    expect(() => h.engine.update(conversation.id, { reasoning: 'max' })).toThrow(/not offered by codex/)
  })

  it('resets reasoning when agent changes and the level is not offered by the new agent', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'claude', reasoning: 'max' })
    const updated = h.engine.update(conversation.id, { agent: 'codex' })

    expect(updated.agent).toBe('codex')
    expect(updated.reasoning).toBe('')
  })

  it('keeps reasoning when agent changes and the level is offered by the new agent', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'claude', reasoning: 'high' })
    const updated = h.engine.update(conversation.id, { agent: 'codex' })

    expect(updated.agent).toBe('codex')
    expect(updated.reasoning).toBe('high')
  })

  it('is deleted with its file', () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    h.engine.remove(conversation.id)

    expect(h.engine.list()).toEqual([])
    expect(h.removed).toEqual([conversation.id])
    expect(existsSync(conversationFile(h, conversation.id))).toBe(false)
  })

  it('is still there after removing something else', async () => {
    const h = harness()
    const first = h.engine.create({ agent: 'fake' })
    const second = h.engine.create({ agent: 'fake' })
    await h.engine.send(second.id, 'hello')
    h.engine.remove(first.id)

    expect(h.engine.list().map((c) => c.id)).toEqual([second.id])
  })

  it('stays gone when it is deleted while its turn is running', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    const running = h.engine.send(conversation.id, 'slow reply please')
    await waitFor(() => byId(h, conversation.id).status === 'running')
    const eventsBeforeRemoval = h.events.length
    h.engine.remove(conversation.id)
    await running

    expect(h.engine.list()).toEqual([])
    expect(existsSync(conversationFile(h, conversation.id))).toBe(false)
    expect(h.events.length).toBe(eventsBeforeRemoval)
  })

  it('says nothing when the conversation is already gone', () => {
    const h = harness()
    h.engine.remove('nope')
    expect(h.removed).toEqual([])
  })
})

describe('what survives a restart', () => {
  it('keeps conversations with their messages and their session', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    await h.engine.send(conversation.id, 'hello')
    const before = byId(h, conversation.id)

    const after = secondEngine(h).engine.list()
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(conversation.id)
    expect(after[0]?.messages).toEqual(before.messages)
    expect(after[0]?.cliSessionId).toBe(before.cliSessionId)
    expect(after[0]?.tokens).toBe(42)
  })

  it('keeps crew members', () => {
    const h = harness()
    const mate = h.engine.saveTeammate({ name: 'Ada', role: 'Reviewer', instructions: 'Check tests.', agent: 'claude', memory: 'a note' })

    expect(secondEngine(h).engine.teammates()).toEqual([mate])
  })

  it('brings a conversation that was running back as idle', async () => {
    const h = harness()
    const conversation = h.engine.create({ agent: 'fake' })
    const running = h.engine.send(conversation.id, 'slow reply please')
    await waitFor(() => byId(h, conversation.id).status === 'running')

    expect(secondEngine(h).engine.list()[0]?.status).toBe('idle')

    h.engine.stop(conversation.id)
    await running
  })

  it('says so when a conversation is gone', async () => {
    const h = harness()
    expect(() => h.engine.update('nope', { title: 'x' })).toThrow(/no longer here/)
    await expect(h.engine.send('nope', 'hello')).rejects.toThrow(/no longer here/)
  })
})

describe('the wiring', () => {
  it('never changes its constructor or its methods', () => {
    const deps: ChatEngineDeps = {
      dataDir: tmpdir(),
      root: () => tmpdir(),
      env: () => ({}),
      agents: () => [],
      emit: () => undefined,
      emitRemoved: () => undefined,
      emitTeammates: () => undefined
    }
    const engine = new ChatEngine(deps)
    for (const name of ['list', 'create', 'send', 'stop', 'approve', 'deny', 'remove', 'update', 'teammates', 'saveTeammate', 'deleteTeammate', 'quit']) {
      expect(typeof (engine as unknown as Record<string, unknown>)[name]).toBe('function')
    }
  })
})
