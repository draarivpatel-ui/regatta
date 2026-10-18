// Reads a session's conversation from the CLI's own transcript.

import { createReadStream } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionInfo, ThreadMessage } from '../shared/types'

const MAX_MESSAGES = 300

const SECONDS_CEILING = 1e11

function epochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value)
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    const asNum = Number(value)
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < SECONDS_CEILING ? Math.round(asNum * 1000) : Math.round(asNum)
    }
  }
  return null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Removes system reminder sections; empty afterwards means the line was only reminders. */
function withoutReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

function isOnlyReminders(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (!trimmed.includes('<system-reminder>')) return false
  return withoutReminders(trimmed) === ''
}

/** User text from message.content: a string, or the text blocks of an array. */
function userText(content: unknown): string | null {
  if (typeof content === 'string') {
    if (!content.trim() || isOnlyReminders(content)) return null
    return content
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      const b = record(block)
      if (!b) continue
      if (b['type'] === 'tool_result') continue
      if (b['type'] !== 'text') continue
      const t = textOf(b['text'])
      if (!t || !t.trim() || isOnlyReminders(t)) continue
      parts.push(t)
    }
    if (parts.length === 0) return null
    return parts.join('\n')
  }
  return null
}

/** Assistant text from message.content: a string, or the joined text blocks of an array. */
function assistantText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim() ? content : null
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      const b = record(block)
      if (!b || b['type'] !== 'text') continue
      const t = textOf(b['text'])
      if (t && t.trim()) parts.push(t)
    }
    if (parts.length === 0) return null
    return parts.join('\n')
  }
  return null
}

/** Tool blocks from an assistant message.content array, in order. */
function toolBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return []
  const out: Record<string, unknown>[] = []
  for (const block of content) {
    const b = record(block)
    if (b && b['type'] === 'tool_use') out.push(b)
  }
  return out
}

const DETAIL_KEYS = [
  'command',
  'file_path',
  'path',
  'filePath',
  'file',
  'pattern',
  'url',
  'query',
  'text',
  'content'
] as const

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** "Bash: npm test", "Edit: src/app.ts". The detail is the most telling input field. */
function formatToolUse(block: Record<string, unknown>): string | null {
  const name = textOf(block['name'])
  if (!name || !name.trim()) return null
  const cleanName = name.trim()
  const input = record(block['input'])
  let detail = ''
  if (input) {
    for (const key of DETAIL_KEYS) {
      const v = textOf(input[key])
      if (v && v.trim()) {
        detail = singleLine(v)
        break
      }
    }
    if (!detail) {
      for (const value of Object.values(input)) {
        const v = textOf(value)
        if (v && v.trim()) {
          detail = singleLine(v)
          break
        }
      }
    }
  }
  const combined = detail ? `${cleanName}: ${detail}` : cleanName
  return combined.length > 120 ? combined.slice(0, 120) : combined
}

function resolvePath(transcriptPath: string, home: string): string {
  if (isAbsolute(transcriptPath)) return transcriptPath
  return join(home, transcriptPath)
}

/**
 * Reads the focused session's transcript. Each JSONL line with type "user" becomes a user
 * message and each line with type "assistant" becomes an assistant message plus one tool
 * message per tool_use block. Keeps the last 300 messages. Missing or unreadable files
 * give []. A session without a transcriptPath gives []. The agent kind is not checked.
 */
export async function readThread(session: SessionInfo, home: string): Promise<ThreadMessage[]> {
  const transcriptPath = session.transcriptPath
  if (!transcriptPath) return []
  const file = resolvePath(transcriptPath, home)
  const messages: ThreadMessage[] = []
  const push = (msg: ThreadMessage): void => {
    messages.push(msg)
    if (messages.length > MAX_MESSAGES) messages.shift()
  }

  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(file, { encoding: 'utf8' })
  } catch {
    return []
  }
  const opened = await new Promise<boolean>((resolve) => {
    stream.once('open', () => resolve(true))
    stream.once('error', () => resolve(false))
  })
  if (!opened) {
    stream.destroy()
    return []
  }

  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const text of lines) {
      const trimmed = text.trim()
      if (!trimmed) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      const line = record(parsed)
      if (!line) continue
      const message = record(line['message'])
      if (!message) continue
      const kind =
        typeof line['type'] === 'string' ? (line['type'] as string) : textOf(message['role'])
      if (kind !== 'user' && kind !== 'assistant') continue
      const at = epochMs(line['timestamp'])
      const content = message['content']
      if (kind === 'user') {
        const text = userText(content)
        if (text) push({ role: 'user', text, at })
      } else {
        const text = assistantText(content)
        if (text) push({ role: 'assistant', text, at })
        for (const tool of toolBlocks(content)) {
          const label = formatToolUse(tool)
          if (label) push({ role: 'tool', text: label, at })
        }
      }
    }
  } catch {
    // Keep the messages read before the unreadable part.
  } finally {
    lines.close()
    stream.destroy()
  }
  return messages
}
