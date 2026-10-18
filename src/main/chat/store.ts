// Conversations and crew members as JSON in the app's data folder.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_AGENTS } from '../../shared/chat'
import type { ChatAgent, ChatMessage, Conversation, Teammate } from '../../shared/chat'

/** One file per conversation, so a conversation can be deleted on its own. */
export function chatsDir(dataDir: string): string {
  return join(dataDir, 'chats')
}

export function loadConversations(dataDir: string): Conversation[] {
  const dir = chatsDir(dataDir)
  if (!existsSync(dir)) return []
  const conversations: Conversation[] = []
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const conversation = readConversation(join(dir, file), file.slice(0, -'.json'.length))
    if (conversation) conversations.push(conversation)
  }
  return conversations
}

export function saveConversation(dataDir: string, conversation: Conversation): void {
  const dir = chatsDir(dataDir)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${safeName(conversation.id)}.json`), JSON.stringify(conversation, null, 2))
  } catch {
    // A conversation that cannot be written to disk still works while the app is open.
  }
}

export function deleteConversationFile(dataDir: string, id: string): void {
  try {
    rmSync(join(chatsDir(dataDir), `${safeName(id)}.json`), { force: true })
  } catch {
    // Already gone.
  }
}

export function loadTeammates(dataDir: string): Teammate[] {
  const file = teammatesFile(dataDir)
  if (!existsSync(file)) return []
  const teammates: Teammate[] = []
  for (const raw of teammateList(readJson(file))) {
    const teammate = teammateFrom(raw)
    if (teammate) teammates.push(teammate)
  }
  return teammates
}

/** The crew is either the list itself or an object with a list in it. */
function teammateList(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed
  const wrapped = record(parsed)?.['teammates']
  return Array.isArray(wrapped) ? wrapped : []
}

export function saveTeammates(dataDir: string, teammates: Teammate[]): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(teammatesFile(dataDir), JSON.stringify(teammates, null, 2))
  } catch {
    // Same as a conversation file: the app keeps working from memory.
  }
}

function teammatesFile(dataDir: string): string {
  return join(dataDir, 'teammates.json')
}

/** A conversation that was running when the app quit comes back idle: no turn is running now. */
function readConversation(file: string, fallbackId: string): Conversation | null {
  const parsed = readJson(file)
  const object = record(parsed)
  if (!object) return null
  const id = text(object['id']) ?? text(fallbackId)
  if (!id) return null
  const now = Date.now()
  const agent = chatAgent(object['agent'])
  const messages = messagesFrom(object['messages'])
  const status = object['status'] === 'error' ? 'error' : 'idle'
  return {
    id,
    title: filled(object['title']) ?? 'New chat',
    agent,
    model: text(object['model']) ?? '',
    cwd: filled(object['cwd']) ?? '',
    access: object['access'] === 'write' ? 'write' : 'read',
    cliSessionId: filled(object['cliSessionId']),
    teammateId: filled(object['teammateId']),
    messages,
    status,
    pending: writeRequestFrom(object['pending']),
    tokens: countFrom(object['tokens']),
    createdAt: numberFrom(object['createdAt']) ?? now,
    updatedAt: numberFrom(object['updatedAt']) ?? now,
    error: status === 'error' ? text(object['error']) : null
  }
}

function teammateFrom(raw: unknown): Teammate | null {
  const object = record(raw)
  if (!object) return null
  const id = text(object['id'])
  const name = text(object['name'])
  if (!id || !name) return null
  const now = Date.now()
  return {
    id,
    name,
    role: text(object['role']) ?? '',
    instructions: text(object['instructions']) ?? '',
    agent: chatAgent(object['agent']),
    memory: text(object['memory']) ?? '',
    ...(Array.isArray(object['skills'])
      ? { skills: object['skills'].filter((id): id is string => typeof id === 'string' && id.length > 0) }
      : {}),
    createdAt: numberFrom(object['createdAt']) ?? now
  }
}

function writeRequestFrom(raw: unknown): Conversation['pending'] {
  const object = record(raw)
  if (!object) return null
  const request = text(object['request'])
  if (!request) return null
  return { kind: 'workspace-write', request, summary: text(object['summary']) ?? request }
}

function messagesFrom(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return []
  const messages: ChatMessage[] = []
  for (const entry of raw) {
    const object = record(entry)
    const body = text(object?.['text'])
    const role = object?.['role']
    if (!object || body === null) continue
    if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') continue
    messages.push({ id: text(object['id']) ?? `m${messages.length}`, role, text: body, at: numberFrom(object['at']) ?? 0 })
  }
  return messages
}

function chatAgent(raw: unknown): ChatAgent {
  return CHAT_AGENTS.includes(raw as ChatAgent) ? (raw as ChatAgent) : 'claude'
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    // A file we cannot read is skipped, not a reason to lose the others.
    return null
  }
}

/** Keeps an id from becoming a path. Ids are short random strings, this only guards a hand edited file. */
function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** A string with something in it. */
function filled(value: unknown): string | null {
  const body = text(value)
  return body && body.trim() ? body : null
}

function numberFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function countFrom(value: unknown): number | null {
  const count = numberFrom(value)
  return count !== null && count > 0 ? count : null
}
