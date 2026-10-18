import { describe, expect, it } from 'vitest'
import { parseClaudeLine, parseCodexLine, parseFakeLine } from './parse'

describe('claude stream-json', () => {
  it('keeps the session id from the init event', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-7', tools: ['Read', 'Edit'] })
    expect(parseClaudeLine(line)).toEqual([{ kind: 'session', id: 'sess-7' }])
  })

  it('reads assistant text as a message', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello there' }] } })
    expect(parseClaudeLine(line)).toEqual([{ kind: 'message', text: 'Hello there' }])
  })

  it('reads a partial text event as a piece of the same message', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }
    })
    expect(parseClaudeLine(line)).toEqual([{ kind: 'text', delta: 'Hel' }])
  })

  it('turns a tool use into a short note', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/app.ts' } }] }
    })
    expect(parseClaudeLine(line)).toEqual([{ kind: 'tool', text: 'Read src/app.ts' }])
  })

  it('names the command when the tool takes one', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }
    })
    expect(parseClaudeLine(line)).toEqual([{ kind: 'tool', text: 'Bash npm test' }])
  })

  it('treats the plan exit tool as a write request with its plan text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'Add a test for the parser.' } }] }
    })
    expect(parseClaudeLine(line)).toEqual([{ kind: 'write-request', summary: 'Add a test for the parser.' }])
  })

  it('adds the usage from the result event', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 }
    })
    expect(parseClaudeLine(line)).toEqual([{ kind: 'tokens', tokens: 126 }])
  })

  it('ignores anything it does not understand', () => {
    expect(parseClaudeLine('not json at all')).toEqual([])
    expect(parseClaudeLine('')).toEqual([])
    expect(parseClaudeLine(JSON.stringify({ type: 'tick', elapsed: 3 }))).toEqual([])
    expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'other' }))).toEqual([])
    expect(parseClaudeLine(JSON.stringify({ type: 'result', usage: { input_tokens: 0, output_tokens: 0 } }))).toEqual([])
  })
})

describe('codex json', () => {
  it('keeps the session id from the session event', () => {
    const line = JSON.stringify({ id: '0', msg: { type: 'session_configured', session_id: '0199abc' } })
    expect(parseCodexLine(line)).toEqual([{ kind: 'session', id: '0199abc' }])
  })

  it('keeps a thread id when there is no session id', () => {
    expect(parseCodexLine(JSON.stringify({ type: 'thread.started', thread_id: 'th_1' }))).toEqual([
      { kind: 'session', id: 'th_1' }
    ])
  })

  it('reads the agent message', () => {
    const line = JSON.stringify({ id: '1', msg: { type: 'agent_message', message: 'I read the file.' } })
    expect(parseCodexLine(line)).toEqual([{ kind: 'message', text: 'I read the file.' }])
  })

  it('reads a finished item as a message', () => {
    const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'All done.' } })
    expect(parseCodexLine(line)).toEqual([{ kind: 'message', text: 'All done.' }])
  })

  it('reads a token count in the older shape', () => {
    const line = JSON.stringify({ id: '2', msg: { type: 'token_count', total_token_usage: 42 } })
    expect(parseCodexLine(line)).toEqual([{ kind: 'tokens', tokens: 42 }])
  })

  it('reads a token count in the newer shape', () => {
    const line = JSON.stringify({
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 } }
    })
    expect(parseCodexLine(line)).toEqual([{ kind: 'tokens', tokens: 42 }])
  })

  it('sums usage that has no total', () => {
    const line = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 12 } })
    expect(parseCodexLine(line)).toEqual([{ kind: 'tokens', tokens: 42 }])
  })

  it('turns a refused write into a write request', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'error', message: 'apply_patch was rejected: writes are not allowed in a read-only sandbox' }
    })
    expect(parseCodexLine(line)).toEqual([
      { kind: 'write-request', summary: 'apply_patch was rejected: writes are not allowed in a read-only sandbox' }
    ])
  })

  it('names the file a patch touches', () => {
    const line = JSON.stringify({ msg: { type: 'patch_apply_begin', changes: [{ path: 'src/app.ts', kind: 'update' }] } })
    expect(parseCodexLine(line)).toEqual([{ kind: 'tool', text: 'Edit src/app.ts' }])
  })

  it('ignores events it does not understand', () => {
    expect(parseCodexLine('')).toEqual([])
    expect(parseCodexLine('Error: something')).toEqual([])
    expect(parseCodexLine(JSON.stringify({ type: 'turn.started' }))).toEqual([])
    expect(parseCodexLine(JSON.stringify({ msg: { type: 'token_count', total_token_usage: 0 } }))).toEqual([])
    expect(parseCodexLine(JSON.stringify({ msg: { type: 'exec_command_output_delta', delta: 'building' } }))).toEqual([])
  })
})

describe('test agent lines', () => {
  it('keeps the session id', () => {
    expect(parseFakeLine('SESSION: 2f8c-1234')).toEqual([{ kind: 'session', id: '2f8c-1234' }])
  })

  it('reads the reply as a message', () => {
    expect(parseFakeLine('Echo: hello')).toEqual([{ kind: 'message', text: 'Echo: hello' }])
    expect(parseFakeLine('and one more line')).toEqual([{ kind: 'message', text: 'and one more line' }])
  })

  it('reads a write request', () => {
    expect(parseFakeLine('NEEDS WRITE: I would add a line to README.md')).toEqual([
      { kind: 'write-request', summary: 'I would add a line to README.md' }
    ])
  })

  it('reads an edit as a tool note', () => {
    expect(parseFakeLine('Edited README.md')).toEqual([{ kind: 'tool', text: 'Edit README.md' }])
  })

  it('reads the token count', () => {
    expect(parseFakeLine('tokens: 42')).toEqual([{ kind: 'tokens', tokens: 42 }])
  })

  it('ignores blank lines', () => {
    expect(parseFakeLine('')).toEqual([])
    expect(parseFakeLine('   ')).toEqual([])
  })
})
