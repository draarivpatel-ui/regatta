import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  headlessArgs,
  runAgent,
  parseClaudeStreamJson,
  parseCodexJson,
  parseFakeCommandLine,
  cleanLine,
  type ParsedCommand
} from './runner'

describe('headlessArgs', () => {
  const cwd = '/workspace'

  describe('claude', () => {
    it('returns correct args without allowCommands', () => {
      const args = headlessArgs('claude', 'fix the bug', cwd, false)
      expect(args).toEqual([
        '-p', 'fix the bug',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'acceptEdits'
      ])
    })

    it('returns correct args with allowCommands', () => {
      const args = headlessArgs('claude', 'fix the bug', cwd, true)
      expect(args).toEqual([
        '-p', 'fix the bug',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'bypassPermissions'
      ])
    })
  })

  describe('codex', () => {
    it('returns correct args without allowCommands', () => {
      const args = headlessArgs('codex', 'fix the bug', cwd, false)
      expect(args).toEqual(['exec', '--json', '-s', 'workspace-write', 'fix the bug'])
    })

    it('returns correct args with allowCommands', () => {
      const args = headlessArgs('codex', 'fix the bug', cwd, true)
      expect(args).toEqual(['exec', '--json', '-s', 'workspace-write', '--approve-for-me', 'fix the bug'])
    })
  })

  describe('grok', () => {
    it('returns correct args without allowCommands', () => {
      const args = headlessArgs('grok', 'fix the bug', cwd, false)
      expect(args).toEqual(['--cwd', cwd, 'fix the bug'])
    })

    it('returns correct args with allowCommands', () => {
      const args = headlessArgs('grok', 'fix the bug', cwd, true)
      expect(args).toEqual(['--cwd', cwd, '--always-approve', 'fix the bug'])
    })
  })

  describe('opencode', () => {
    it('returns correct args without allowCommands', () => {
      const args = headlessArgs('opencode', 'fix the bug', cwd, false)
      expect(args).toEqual(['run', '--dir', cwd, 'fix the bug'])
    })

    it('returns correct args with allowCommands', () => {
      const args = headlessArgs('opencode', 'fix the bug', cwd, true)
      expect(args).toEqual(['run', '--dir', cwd, '--auto', 'fix the bug'])
    })
  })

  describe('gemini', () => {
    it('returns correct args without allowCommands', () => {
      const args = headlessArgs('gemini', 'fix the bug', cwd, false)
      expect(args).toEqual(['-p', 'fix the bug', '--approval-mode', 'auto_edit'])
    })

    it('returns correct args with allowCommands', () => {
      const args = headlessArgs('gemini', 'fix the bug', cwd, true)
      expect(args).toEqual(['-p', 'fix the bug', '--approval-mode', 'yolo'])
    })
  })

  describe('fake', () => {
    it('returns correct args', () => {
      const args = headlessArgs('fake', 'fix the bug', cwd, false)
      expect(args).toEqual(['--headless', 'fix the bug'])
    })

    it('ignores allowCommands', () => {
      const args = headlessArgs('fake', 'fix the bug', cwd, true)
      expect(args).toEqual(['--headless', 'fix the bug'])
    })
  })

  describe('unsupported agents', () => {
    it('throws for cursor', () => {
      expect(() => headlessArgs('cursor', 'fix', cwd, false)).toThrow('Cursor Agent cannot race yet')
    })

    it('throws for aider', () => {
      expect(() => headlessArgs('aider', 'fix', cwd, false)).toThrow('Aider cannot race yet')
    })

    it('throws for qwen', () => {
      expect(() => headlessArgs('qwen', 'fix', cwd, false)).toThrow('Qwen Code cannot race yet')
    })

    it('throws for amp', () => {
      expect(() => headlessArgs('amp', 'fix', cwd, false)).toThrow('Amp cannot race yet')
    })

    it('throws for shell', () => {
      expect(() => headlessArgs('shell', 'fix', cwd, false)).toThrow('Terminal cannot race yet')
    })
  })
})

describe('parseClaudeStreamJson', () => {
  it('extracts assistant text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'I will fix the bug.' }] }
    })
    const result = parseClaudeStreamJson(line)
    expect(result.activity).toBe('I will fix the bug.')
  })

  it('extracts tool use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] }
    })
    const result = parseClaudeStreamJson(line)
    expect(result.activity).toBe('Using Edit')
  })

  it('pairs Bash tool_use with failed, succeeded, and blocked tool_result fixtures', () => {
    const pending = new Map<string, string>()

    const assistantUse = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'ls ./nope-missing', description: '...' }
          }
        ]
      }
    })
    expect(parseClaudeStreamJson(assistantUse, pending).activity).toBe('Using Bash')
    expect(pending.get('toolu_1')).toBe('ls ./nope-missing')

    const failedResult = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: 'Exit code 1\nls: ./nope-missing: No such file or directory'
          }
        ]
      }
    })
    const parsedFail = parseClaudeStreamJson(failedResult, pending)
    expect(parsedFail.commands).toEqual([
      {
        command: 'ls ./nope-missing',
        failed: true,
        output: 'Exit code 1\nls: ./nope-missing: No such file or directory'
      }
    ])

    // Succeeding command with array content
    parseClaudeStreamJson(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'echo fine' } }]
        }
      }),
      pending
    )
    const okResult = parseClaudeStreamJson(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              is_error: false,
              content: [{ type: 'text', text: 'fine' }]
            }
          ]
        }
      }),
      pending
    )
    expect(okResult.commands).toEqual([
      {
        command: 'echo fine',
        failed: false,
        output: 'fine'
      }
    ])

    // Blocked command with no Exit code line, plus top-level block shape
    parseClaudeStreamJson(
      JSON.stringify({
        type: 'tool_use',
        id: 'toolu_3',
        name: 'Bash',
        input: { command: 'rm -rf /', description: '...' }
      }),
      pending
    )
    const blockedResult = parseClaudeStreamJson(
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_3',
        is_error: true,
        content: 'Permission to use Bash has been denied.'
      }),
      pending
    )
    expect(blockedResult.commands).toEqual([
      {
        command: 'rm -rf /',
        failed: true,
        output: 'Permission to use Bash has been denied.'
      }
    ])
  })

  it('keeps only the last 4 KB of command output', () => {
    const pending = new Map<string, string>()
    parseClaudeStreamJson(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_big', name: 'Bash', input: { command: 'big' } }] }
      }),
      pending
    )
    const bigText = 'x'.repeat(5000) + 'TAIL'
    const res = parseClaudeStreamJson(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_big', is_error: true, content: bigText }] }
      }),
      pending
    )
    expect(res.commands?.[0]?.output.length).toBe(4096)
    expect(res.commands?.[0]?.output.endsWith('TAIL')).toBe(true)
  })

  it('extracts tokens from result', () => {
    const line = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }
    })
    const result = parseClaudeStreamJson(line)
    expect(result.tokens).toBe(165)
  })

  it('handles missing optional token fields', () => {
    const line = JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 50 } })
    const result = parseClaudeStreamJson(line)
    expect(result.tokens).toBe(150)
  })

  it('returns empty for unknown types', () => {
    const line = JSON.stringify({ type: 'unknown', data: {} })
    const result = parseClaudeStreamJson(line)
    expect(result).toEqual({})
  })

  it('returns empty for invalid JSON', () => {
    const result = parseClaudeStreamJson('not json')
    expect(result).toEqual({})
  })
})

describe('parseCodexJson', () => {
  it('extracts message field', () => {
    const line = JSON.stringify({ message: 'Working on the task...' })
    const result = parseCodexJson(line)
    expect(result.activity).toBe('Working on the task...')
  })

  it('extracts text field', () => {
    const line = JSON.stringify({ text: 'Some output' })
    const result = parseCodexJson(line)
    expect(result.activity).toBe('Some output')
  })

  it('extracts tokens from total_token_usage', () => {
    const line = JSON.stringify({ total_token_usage: 1234 })
    const result = parseCodexJson(line)
    expect(result.tokens).toBe(1234)
  })

  it('extracts tokens from token_count', () => {
    const line = JSON.stringify({ token_count: 567 })
    const result = parseCodexJson(line)
    expect(result.tokens).toBe(567)
  })

  it('extracts current Codex command_execution, agent_message, and turn.completed usage', () => {
    const cmdFailed = parseCodexJson(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'FAIL src/app.test.ts',
          exit_code: 1,
          status: 'failed'
        }
      })
    )
    expect(cmdFailed.command).toEqual({
      command: 'npm test',
      failed: true,
      output: 'FAIL src/app.test.ts'
    })

    const cmdFailedByStatusOnly = parseCodexJson(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'bad-cmd',
          aggregated_output: 'denied',
          status: 'failed'
        }
      })
    )
    expect(cmdFailedByStatusOnly.command).toEqual({
      command: 'bad-cmd',
      failed: true,
      output: 'denied'
    })

    const cmdOk = parseCodexJson(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'PASS',
          exit_code: 0,
          status: 'completed'
        }
      })
    )
    expect(cmdOk.command).toEqual({
      command: 'npm test',
      failed: false,
      output: 'PASS'
    })

    const msg = parseCodexJson(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'agent_message',
          text: 'All tests are passing now.'
        }
      })
    )
    expect(msg.activity).toBe('All tests are passing now.')

    const turn = parseCodexJson(
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 1200,
          cached_input_tokens: 800,
          output_tokens: 350
        }
      })
    )
    // usage.ts counts Codex tokens as input_tokens + output_tokens (input_tokens already includes cached_input_tokens).
    expect(turn.tokens).toBe(1550)
  })

  it('returns empty for invalid JSON', () => {
    const result = parseCodexJson('not json')
    expect(result).toEqual({})
  })
})

describe('parseFakeCommandLine', () => {
  it('parses ran: <command> (exit <n>) <output> lines', () => {
    expect(parseFakeCommandLine('ran: npm test (exit 1) 3 failing tests in 0.84s')).toEqual({
      command: 'npm test',
      failed: true,
      output: '3 failing tests in 0.84s'
    })
    expect(parseFakeCommandLine('ran: npm run lint (exit 0) clean')).toEqual({
      command: 'npm run lint',
      failed: false,
      output: 'clean'
    })
    expect(parseFakeCommandLine('Reading the project')).toBeNull()
  })
})

describe('cleanLine', () => {
  it('strips ANSI codes', () => {
    const line = '\x1b[36mHello\x1b[0m World'
    expect(cleanLine(line)).toBe('Hello World')
  })

  it('truncates long lines', () => {
    const long = 'a'.repeat(250)
    const result = cleanLine(long)
    expect(result!.length).toBe(200)
    expect(result).toMatch(/…$/)
  })

  it('returns null for blank lines', () => {
    expect(cleanLine('   \n')).toBeNull()
    expect(cleanLine('')).toBeNull()
  })

  it('returns trimmed line for normal text', () => {
    expect(cleanLine('  hello world  ')).toBe('hello world')
  })
})

describe('runAgent with fake agent', () => {
  let tempDir: string
  const fakeAgentPath = join(process.cwd(), 'scripts/fake-agent.mjs')

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'heats-runner-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('runs good scenario and reports activity, tokens, and exit 0', async () => {
    const activities: string[] = []
    let reportedTokens: number | null = null

    const { done } = runAgent({
      agent: 'fake',
      command: process.execPath,
      baseArgs: [fakeAgentPath],
      prompt: 'test task',
      cwd: tempDir,
      env: { REGATTA_FAKE_SCENARIO: 'good' },
      allowCommands: false,
      onActivity: (a) => activities.push(a),
      onTokens: (t) => { reportedTokens = t }
    })

    const result = await done

    expect(result.exitCode).toBe(0)
    expect(result.stopped).toBe(false)
    expect(result.tokens).toBe(1234)
    expect(reportedTokens).toBe(1234)
    expect(activities.length).toBeGreaterThan(0)
    expect(activities.some(a => a.includes('Reading') || a.includes('Planning') || a.includes('Editing') || a.includes('Running'))).toBe(true)
  })

  it('calls onCommand for loop scenario lines', async () => {
    const commands: ParsedCommand[] = []
    const { done } = runAgent({
      agent: 'fake',
      command: process.execPath,
      baseArgs: [fakeAgentPath],
      prompt: 'test task',
      cwd: tempDir,
      env: { REGATTA_FAKE_SCENARIO: 'loop' },
      allowCommands: false,
      onActivity: () => {},
      onTokens: () => {},
      onCommand: (c) => commands.push(c)
    })

    const result = await done
    expect(result.exitCode).toBe(1)
    expect(commands.length).toBe(5)
    expect(commands[0]).toEqual({
      command: 'npm test',
      failed: true,
      output: '3 failing tests in 0.84s'
    })
  })

  it('creates DONE.txt and modifies src/app.js in good scenario', async () => {
    await runAgent({
      agent: 'fake',
      command: process.execPath,
      baseArgs: [fakeAgentPath],
      prompt: 'test task',
      cwd: tempDir,
      env: { REGATTA_FAKE_SCENARIO: 'good' },
      allowCommands: false,
      onActivity: () => {},
      onTokens: () => {}
    }).done

    const donePath = join(tempDir, 'DONE.txt')
    const doneContent = await readFile(donePath, 'utf8')
    expect(doneContent).toBe('done: test task')

    const appPath = join(tempDir, 'src/app.js')
    const appContent = await readFile(appPath, 'utf8')
    expect(appContent).toContain('// changed by test agent')
  })

  it('exits with code 2 for fail scenario', async () => {
    const { done } = runAgent({
      agent: 'fake',
      command: process.execPath,
      baseArgs: [fakeAgentPath],
      prompt: 'test task',
      cwd: tempDir,
      env: { REGATTA_FAKE_SCENARIO: 'fail' },
      allowCommands: false,
      onActivity: () => {},
      onTokens: () => {}
    })

    const result = await done
    expect(result.exitCode).toBe(2)
  })

  it('stops slow scenario and reports stopped true', async () => {
    const { done, stop } = runAgent({
      agent: 'fake',
      command: process.execPath,
      baseArgs: [fakeAgentPath],
      prompt: 'test task',
      cwd: tempDir,
      env: { REGATTA_FAKE_SCENARIO: 'slow', REGATTA_FAKE_DELAY_MS: '10000' },
      allowCommands: false,
      onActivity: () => {},
      onTokens: () => {}
    })

    await new Promise(r => setTimeout(r, 100))
    stop()

    const result = await done
    expect(result.stopped).toBe(true)
    expect(result.exitCode).not.toBe(0)
    expect(result.durationMs).toBeLessThan(5000)
  })

  it('reports spawn error when command does not exist', async () => {
    const activities: string[] = []
    const { done } = runAgent({
      agent: 'fake',
      command: '/nonexistent/command/that/does/not/exist',
      baseArgs: [],
      prompt: 'test',
      cwd: tempDir,
      env: {},
      allowCommands: false,
      onActivity: (a) => activities.push(a),
      onTokens: () => {}
    })

    const result = await done
    expect(result.exitCode).toBeNull()
    expect(result.stopped).toBe(false)
    expect(activities.some(a => a.includes('Spawn error'))).toBe(true)
  })
})
/** True while the process runs. A process that died but is not reaped yet answers signal 0 and is not running. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return stat !== '' && !stat.startsWith('Z')
  } catch {
    return false
  }
}

describe('stopping an agent', () => {
  it('stops the descendants of the agent too, and resolves only when none is left', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'regatta-runner-group-'))
    const pidFile = join(dir, 'child.pid')
    try {
      // The CLI starts a helper that ignores SIGTERM and closes its output, then waits for it. The helper writes its pid once it ignores SIGTERM.
      const script = `(trap "" TERM; exec sh -c 'echo $$ > ${pidFile}; exec sleep 300') >/dev/null 2>&1 & wait`
      const { done, stop } = runAgent({
        agent: 'fake',
        command: '/bin/sh',
        baseArgs: ['-c', script, 'sh'],
        prompt: 'x',
        cwd: dir,
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        allowCommands: false,
        onActivity: () => {},
        onTokens: () => {}
      })
      let pid = NaN
      for (let i = 0; i < 200 && Number.isNaN(pid); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        try {
          pid = Number((await readFile(pidFile, 'utf8')).trim())
        } catch {
          // Not written yet.
        }
      }
      expect(Number.isNaN(pid)).toBe(false)
      const started = Date.now()
      stop()
      const result = await done
      expect(result.stopped).toBe(true)
      expect(Date.now() - started).toBeGreaterThanOrEqual(3000)
      expect(isRunning(pid)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30000)
})
