// Reading one line of agent output.
// Pure logic: each parser turns a line into zero or more events, and anything it does not
// understand is ignored. Unit tested with sample lines.

import type { ChatAgent } from '../../shared/chat'

export type TurnEvent =
  /** The CLI's own session id, so the next turn can continue the same conversation. */
  | { kind: 'session'; id: string }
  /** A piece of the assistant message as it streams in. */
  | { kind: 'text'; delta: string }
  /** A whole assistant message. */
  | { kind: 'message'; text: string }
  /** A short note about what the agent did, for example "Read src/app.ts". */
  | { kind: 'tool'; text: string }
  /** The agent wants to change files but may not yet. */
  | { kind: 'write-request'; summary: string }
  /** Tokens used by the turn. */
  | { kind: 'tokens'; tokens: number }

/** Longest tool detail and write request summary shown in the transcript. */
const DETAIL_LENGTH = 120
const SUMMARY_LENGTH = 240

// Claude Code, stream-json.

export function parseClaudeLine(line: string): TurnEvent[] {
  const data = json(line)
  if (!data) return []
  const events: TurnEvent[] = []
  const type = text(data['type'])

  if (type === 'system' || type === 'init') {
    const id = text(data['session_id'])
    if (id) events.push({ kind: 'session', id })
    return events
  }

  if (type === 'stream_event') {
    const event = record(data['event'])
    const delta = record(event?.['delta'])
    if (text(event?.['type']) === 'content_block_delta' && text(delta?.['type']) === 'text_delta') {
      const piece = text(delta?.['text'])
      if (piece) events.push({ kind: 'text', delta: piece })
    }
    return events
  }

  if (type === 'assistant') {
    const content = record(data['message'])?.['content']
    for (const block of blocks(content)) {
      const kind = text(block['type'])
      if (kind === 'text') {
        const body = text(block['text'])
        if (body) events.push({ kind: 'message', text: body })
        continue
      }
      if (kind === 'tool_use') {
        const name = text(block['name']) ?? 'tool'
        const input = record(block['input'])
        if (name === 'ExitPlanMode') {
          events.push({ kind: 'write-request', summary: truncate(text(input?.['plan']) ?? 'Ready to make the changes.', SUMMARY_LENGTH) })
        } else {
          events.push({ kind: 'tool', text: toolLine(name, input) })
        }
      }
    }
    return events
  }

  if (type === 'result') {
    const total = usageTotal(record(data['usage']))
    if (total > 0) events.push({ kind: 'tokens', tokens: total })
  }

  return events
}

// Codex, exec --json.

export function parseCodexLine(line: string): TurnEvent[] {
  const data = json(line)
  if (!data) return []
  const events: TurnEvent[] = []

  const session = findString(data, SESSION_KEYS, CONTAINERS)
  if (session) events.push({ kind: 'session', id: session })

  const tokens = findTokens(data)
  if (tokens !== null) events.push({ kind: 'tokens', tokens })

  const refusal = findRefusal(data)
  if (refusal) events.push({ kind: 'write-request', summary: truncate(refusal, SUMMARY_LENGTH) })

  for (const event of codexActivity(data)) events.push(event)
  return events
}

/** The patch codex is about to apply, the command it is about to run, or what it said. */
function codexActivity(data: Record<string, unknown>): TurnEvent[] {
  const msg = record(data['msg']) ?? record(data['data'])
  const item = record(data['item'])
  const msgType = text(msg?.['type']) ?? ''
  const itemType = text(item?.['type']) ?? ''

  if (msgType === 'patch_apply_begin' || itemType === 'file_change') {
    const path = patchPath(msg?.['changes']) ?? patchPath(item?.['changes']) ?? text(msg?.['path'])
    if (path) return [{ kind: 'tool', text: `Edit ${truncate(path, DETAIL_LENGTH)}` }]
  }
  if (msgType === 'exec_command_begin') {
    const command = item?.['command'] ?? msg?.['command']
    const line = Array.isArray(command) ? command.map((part) => text(part) ?? '').join(' ') : text(command)
    if (line) return [{ kind: 'tool', text: `Bash ${truncate(line, DETAIL_LENGTH)}` }]
  }
  if (msgType.startsWith('agent_reasoning') || itemType.startsWith('agent_reasoning')) return []

  if (isMessageDelta(msgType) || isMessageDelta(itemType)) {
    const piece = deltaText(msg) ?? deltaText(item)
    return piece ? [{ kind: 'text', delta: piece }] : []
  }

  const message = codexMessage(data, msg, item, msgType, itemType)
  return message ? [{ kind: 'message', text: message }] : []
}

/** Only the message streams into the transcript. Command output and reasoning do not. */
function isMessageDelta(type: string): boolean {
  return type.includes('agent_message') && type.endsWith('delta')
}

/** The first file a patch touches. Changes are objects with a path, or the path on its own. */
function patchPath(value: unknown): string | null {
  const entries = Array.isArray(value) ? value : [value]
  for (const entry of entries) {
    const path = text(record(entry)?.['path']) ?? text(entry)
    if (path) return path
  }
  return null
}

function codexMessage(
  data: Record<string, unknown>,
  msg: Record<string, unknown> | undefined,
  item: Record<string, unknown> | undefined,
  msgType: string,
  itemType: string
): string | null {
  if (msgType === 'agent_message' || itemType === 'agent_message') {
    return text(msg?.['message']) ?? text(msg?.['text']) ?? text(item?.['text']) ?? text(item?.['content'])
  }
  if (msgType === 'task_complete' || itemType === 'task_complete') {
    return text(msg?.['last_agent_message']) ?? text(msg?.['message']) ?? text(msg?.['text']) ?? text(item?.['text'])
  }
  if (msgType === 'agent_reasoning' || msgType === 'agent_reasoning_section_break' || msgType.startsWith('agent_reasoning')) return null
  if (msgType === 'error' || msgType === 'stream_error' || msgType === 'turn_failed') return null
  return text(data['message']) ?? text(data['text']) ?? text(msg?.['message']) ?? text(msg?.['text']) ?? null
}

function deltaText(source: Record<string, unknown> | undefined): string | null {
  const delta = source?.['delta']
  if (typeof delta === 'string') return delta
  return text(record(delta)?.['text'])
}

// The test agent, plain lines.

const SESSION_LINE = /^SESSION:\s*(\S+)$/i
const NEEDS_WRITE_LINE = /^NEEDS WRITE:\s*(.+)$/i
const EDITED_LINE = /^Edited\s+(.+)$/i
const TOKENS_LINE = /^tokens:\s*(\d+)$/i

export function parseFakeLine(line: string): TurnEvent[] {
  const body = line.replace(/\r$/, '').trim()
  if (!body) return []

  const session = body.match(SESSION_LINE)
  if (session?.[1]) return [{ kind: 'session', id: session[1] }]

  const needsWrite = body.match(NEEDS_WRITE_LINE)
  if (needsWrite) return [{ kind: 'write-request', summary: truncate(needsWrite[1] ?? '', SUMMARY_LENGTH) || 'It wants to change files.' }]

  const tokens = body.match(TOKENS_LINE)
  if (tokens?.[1]) return [{ kind: 'tokens', tokens: Number(tokens[1]) }]

  const edited = body.match(EDITED_LINE)
  if (edited?.[1]) return [{ kind: 'tool', text: `Edit ${truncate(edited[1].trim(), DETAIL_LENGTH)}` }]

  return [{ kind: 'message', text: body }]
}

/** The parser for one agent. Unknown agents are read as plain lines. */
export function parseLine(agent: ChatAgent, line: string): TurnEvent[] {
  switch (agent) {
    case 'claude':
      return parseClaudeLine(line)
    case 'codex':
      return parseCodexLine(line)
    default:
      return parseFakeLine(line)
  }
}

// Helpers.

const SESSION_KEYS = ['session_id', 'sessionId', 'thread_id', 'threadId', 'conversation_id', 'conversationId', 'rollout_id']
const CONTAINERS = ['msg', 'data', 'info', 'payload', 'item', 'thread', 'conversation', 'response']
const TOKEN_KEYS = ['total_token_usage', 'total_tokens', 'totalTokens', 'token_count']
const REFUSAL_WORDS = /\b(reject\w*|den(?:y|ied)|refus\w*|not\s+allowed|not\s+permitted|read[- ]?only|outside\s+the\s+sandbox)\b/i
const WRITE_WORDS = /\b(writ\w*|edit\w*|patch\w*|modif\w*|file|files)\b/i

function json(line: string): Record<string, unknown> | null {
  const body = line.replace(/\r$/, '').trim()
  if (!body.startsWith('{')) return null
  try {
    return record(JSON.parse(body) as unknown) ?? null
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const body = value.trim()
  return body ? body : null
}

function blocks(content: unknown): Record<string, unknown>[] {
  if (Array.isArray(content)) return content.map(record).filter((block): block is Record<string, unknown> => Boolean(block))
  const single = record(content)
  return single ? [single] : []
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** "Read src/app.ts", "Bash npm test", or just the tool name when it takes nothing we show. */
function toolLine(name: string, input: Record<string, unknown> | undefined): string {
  const detail =
    firstText(input, ['file_path', 'filePath', 'notebook_path', 'path']) ??
    firstText(input, ['command', 'pattern', 'query', 'url', 'prompt', 'description', 'subject'])
  return detail ? `${name} ${truncate(detail, DETAIL_LENGTH)}` : name
}

function firstText(source: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!source) return null
  for (const key of keys) {
    const value = text(source[key])
    if (value) return value
  }
  return null
}

function usageTotal(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0
  const keys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
  let total = 0
  for (const key of keys) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value)) total += value
  }
  return total
}

/** The first string under any of these keys, looking a few levels down. */
function findString(data: unknown, keys: string[], containers: string[], depth = 0): string | null {
  if (depth > 4) return null
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findString(item, keys, containers, depth + 1)
      if (found) return found
    }
    return null
  }
  const object = record(data)
  if (!object) return null
  for (const key of keys) {
    const value = text(object[key])
    if (value) return value
  }
  for (const key of containers) {
    const found = findString(object[key], keys, containers, depth + 1)
    if (found) return found
  }
  return null
}

/** Codex reports token counts in more than one shape. The first total we can read wins. */
function findTokens(data: unknown, depth = 0): number | null {
  if (depth > 4) return null
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findTokens(item, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  const object = record(data)
  if (!object) return null
  for (const key of TOKEN_KEYS) {
    const value = object[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    const found = tokensIn(value, depth)
    if (found !== null) return found
  }
  for (const key of [...CONTAINERS, 'usage']) {
    const found = tokensIn(object[key], depth)
    if (found !== null) return found
  }
  return null
}

function tokensIn(value: unknown, depth: number): number | null {
  const nested = record(value)
  if (!nested) return null
  const found = findTokens(nested, depth + 1)
  if (found !== null) return found
  const summed = usageTotal(nested)
  return summed > 0 ? summed : null
}

/** A write that a read only sandbox refused, in whatever words codex used. */
function findRefusal(data: unknown, depth = 0): string | null {
  if (depth > 4) return null
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRefusal(item, depth + 1)
      if (found) return found
    }
    return null
  }
  const object = record(data)
  if (!object) return null
  for (const [key, value] of Object.entries(object)) {
    const body = text(value)
    if (body && key !== 'type' && REFUSAL_WORDS.test(body) && WRITE_WORDS.test(body)) return body
    const found = findRefusal(value, depth + 1)
    if (found) return found
  }
  return null
}
