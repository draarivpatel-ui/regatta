// Runs conversations with agent CLIs in headless mode, one turn at a time.
//. See docs/design/conversations.md.

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENTS } from '../../shared/agents'
import { CHAT_AGENTS, REASONING_LEVELS } from '../../shared/chat'
import type { Access, ChatAgent, ChatMessage, Conversation, NewConversation, Reasoning, Skill, Teammate } from '../../shared/chat'
import type { AgentKind, DetectedAgent } from '../../shared/types'
import { supervise, type GroupSupervisor } from '../heats/procgroup'
import { chatArgs, teammateInstructions } from './args'
import { parseLine, type TurnEvent } from './parse'
import {
  deleteConversationFile,
  loadConversations,
  loadTeammates,
  saveConversation,
  saveTeammates
} from './store'

export interface ChatEngineDeps {
  /** App data folder; conversations go in <dataDir>/chats/, teammates in <dataDir>/teammates.json. */
  dataDir: string
  /** Default folder for new conversations. */
  root: () => string
  env: () => Record<string, string>
  agents: () => DetectedAgent[]
  emit: (conversation: Conversation) => void
  emitRemoved: (id: string) => void
  emitTeammates: (teammates: Teammate[]) => void
  /** Skills from Settings > Skills; a crew member's own are added to its instructions. */
  skills?: () => Skill[]
  /** Environment that selects a sign-in for the conversation's CLI (accounts package). */
  accountEnv?: (agent: ChatAgent, account: string | null) => Record<string, string>
  /** Extra command line arguments for an agent's turns (for example tools from an MCP server). */
  extraArgs?: (agent: AgentKind) => string[]
}

/** A streaming conversation reaches the window at most this often. The last state always goes out. */
const EMIT_MS = 100
/** A new conversation is named after its first message, this many characters of it. */
const TITLE_LENGTH = 60
const ID_LENGTH = 8
const DEFAULT_TITLE = 'New chat'
const REFUSED_REQUEST_ERROR = 'That request changed. Look at it again.'
const STUCK_TURN_ERROR = 'Some programs the agent started could not be stopped. Check what is running.'
const QUITTING_ERROR = 'Regatta is quitting, so no new turn was started.'

/** Everything one running turn needs. It goes away when the CLI exits. */
interface Turn {
  child: ChildProcess
  group: GroupSupervisor
  stopped: boolean
  /** The assistant message this turn streams into. */
  assistantId: string | null
  request: string
  access: Access
  stderr: string[]
  lastEmit: number
  emitTimer: NodeJS.Timeout | null
}

export class ChatEngine {
  /** Set by quit(): from then on no new turns start. */
  private quitting = false
  private readonly conversations = new Map<string, Conversation>()
  private readonly turns = new Map<string, Turn>()
  private crew: Teammate[] = []

  constructor(private readonly deps: ChatEngineDeps) {
    for (const conversation of loadConversations(deps.dataDir)) this.conversations.set(conversation.id, conversation)
    this.crew = loadTeammates(deps.dataDir)
  }

  /**
   * Called when Regatta is quitting: from now on no new turns start, and every running turn's
   * process group is stopped. Synchronous and safe to call again.
   */
  quit(): void {
    this.quitting = true
    for (const turn of this.turns.values()) {
      turn.stopped = true
      turn.group.stop()
    }
  }

  /** Newest first: the conversation you just used is the one at the top. */
  list(): Conversation[] {
    const created = new Map<string, number>()
    let index = 0
    for (const id of this.conversations.keys()) created.set(id, index++)
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt || (created.get(b.id) ?? 0) - (created.get(a.id) ?? 0))
      .map(clone)
  }

  create(opts: NewConversation): Conversation {
    if (!CHAT_AGENTS.includes(opts.agent)) throw new Error(`${opts.agent} cannot chat yet.`)
    const now = Date.now()
    const conversation: Conversation = {
      id: shortId(),
      title: opts.title?.trim() || DEFAULT_TITLE,
      agent: opts.agent,
      model: opts.model?.trim() ?? '',
      cwd: resolve(opts.cwd ?? this.deps.root()),
      access: opts.access ?? 'read',
      cliSessionId: null,
      teammateId: opts.teammateId ?? null,
      reasoning: opts.reasoning ?? '',
      messages: [],
      status: 'idle',
      pending: null,
      tokens: null,
      createdAt: now,
      updatedAt: now,
      error: null
    }
    this.conversations.set(conversation.id, conversation)
    this.persist(conversation)
    this.deps.emit(clone(conversation))
    return clone(conversation)
  }

  async send(id: string, text: string, access?: Access): Promise<void> {
    if (this.quitting) throw new Error(QUITTING_ERROR)
    const conversation = this.must(id)
    const request = text.trim()
    if (!request) throw new Error('Write something first.')
    if (conversation.status === 'running') throw new Error('Wait for the current reply or stop it.')
    if (conversation.title === DEFAULT_TITLE) conversation.title = titleFrom(request)
    this.addMessage(conversation, 'user', request)
    await this.runTurn(conversation, request, access ?? conversation.access)
  }

  stop(id: string): void {
    const conversation = this.must(id)
    const turn = this.turns.get(id)
    if (!turn || turn.stopped) return
    turn.stopped = true
    turn.group.stop()
    this.addMessage(conversation, 'system', 'Stopped.')
    this.deps.emit(clone(conversation))
  }

  /** Runs the same request again with write access, so the agent can make the changes itself. */
  async approve(id: string, requestId: string): Promise<void> {
    if (this.quitting) throw new Error(QUITTING_ERROR)
    const conversation = this.must(id)
    if (conversation.status === 'running') throw new Error('Wait for the current reply or stop it.')
    const pending = conversation.pending
    if (!requestId || !pending || pending.id !== requestId) {
      throw new Error(REFUSED_REQUEST_ERROR)
    }
    conversation.pending = null
    await this.runTurn(conversation, pending.request, 'write')
  }

  deny(id: string, requestId: string): void {
    const conversation = this.must(id)
    const pending = conversation.pending
    if (!requestId || !pending || pending.id !== requestId) {
      throw new Error(REFUSED_REQUEST_ERROR)
    }
    conversation.pending = null
    this.addMessage(conversation, 'system', 'Write request denied.')
    this.persist(conversation)
    this.deps.emit(clone(conversation))
  }

  remove(id: string): void {
    const turn = this.turns.get(id)
    if (turn && !turn.stopped) {
      turn.stopped = true
      turn.group.stop()
    }
    if (!this.conversations.delete(id)) return
    deleteConversationFile(this.deps.dataDir, id)
    this.deps.emitRemoved(id)
  }

  update(id: string, patch: { title?: string; model?: string; agent?: Conversation['agent']; access?: Access; account?: string | null; reasoning?: Reasoning }): Conversation {
    const conversation = this.must(id)
    if (patch.title !== undefined) conversation.title = patch.title.trim() || DEFAULT_TITLE
    if (patch.model !== undefined) conversation.model = patch.model.trim()
    if (patch.agent !== undefined) {
      if (!CHAT_AGENTS.includes(patch.agent)) throw new Error(`${patch.agent} cannot chat yet.`)
      if (patch.agent !== conversation.agent) {
        if (conversation.status === 'running') throw new Error('Wait for the current reply or stop it.')
        // The old CLI's session, model and sign-in mean nothing to another CLI: its next turn starts fresh.
        conversation.cliSessionId = null
        conversation.model = patch.model?.trim() ?? ''
        conversation.account = null
      }
      conversation.agent = patch.agent
      const allowed = REASONING_LEVELS[conversation.agent]
      if (!allowed.includes(conversation.reasoning ?? '')) conversation.reasoning = ''
    }
    if (patch.access !== undefined) conversation.access = patch.access
    if (patch.account !== undefined) conversation.account = patch.account
    if (patch.reasoning !== undefined) {
      const allowed = REASONING_LEVELS[conversation.agent]
      if (!allowed.includes(patch.reasoning)) throw new Error(`${patch.reasoning} is not offered by ${conversation.agent}.`)
      conversation.reasoning = patch.reasoning
    }
    this.persist(conversation)
    this.deps.emit(clone(conversation))
    return clone(conversation)
  }

  teammates(): Teammate[] {
    return this.crew.map(clone)
  }

  saveTeammate(teammate: Omit<Teammate, 'id' | 'createdAt'> & { id?: string }): Teammate {
    const existing = teammate.id ? this.crew.find((t) => t.id === teammate.id) : undefined
    const name = teammate.name.trim()
    if (!name) throw new Error('Give this crew member a name.')
    const next: Teammate = {
      id: existing?.id ?? shortId(),
      name,
      role: teammate.role.trim(),
      instructions: teammate.instructions.trim(),
      agent: CHAT_AGENTS.includes(teammate.agent) ? teammate.agent : 'claude',
      memory: teammate.memory ?? existing?.memory ?? '',
      skills: Array.isArray(teammate.skills)
        ? [...new Set(teammate.skills.filter((id): id is string => typeof id === 'string' && id.length > 0))]
        : (existing?.skills ?? []),
      createdAt: existing?.createdAt ?? Date.now()
    }
    this.crew = existing
      ? this.crew.map((t) => (t.id === next.id ? next : t))
      : [...this.crew, next]
    this.emitTeammates()
    return clone(next)
  }

  deleteTeammate(id: string): void {
    const next = this.crew.filter((t) => t.id !== id)
    if (next.length === this.crew.length) return
    this.crew = next
    this.emitTeammates()
  }

  // The turn: one CLI run, then the conversation is saved.

  private async runTurn(conversation: Conversation, request: string, access: Access): Promise<void> {
    if (this.quitting) throw new Error(QUITTING_ERROR)
    const detected = this.agentFor(conversation.agent)
    const teammate = conversation.teammateId ? this.crew.find((t) => t.id === conversation.teammateId) : undefined
    const args = [
      ...detected.args,
      ...(this.deps.extraArgs?.(conversation.agent) ?? []),
      ...chatArgs(conversation.agent, {
        text: request,
        access,
        model: conversation.model,
        sessionId: conversation.cliSessionId,
        instructions: teammate ? teammateInstructions(teammate, this.deps.skills?.() ?? []) : null,
        reasoning: conversation.reasoning
      })
    ]

    conversation.status = 'running'
    conversation.error = null
    conversation.pending = null
    conversation.updatedAt = Date.now()
    this.persist(conversation)
    this.deps.emit(clone(conversation))

    const stdin = openStdin()
    let child: ChildProcess
    try {
      child = spawn(detected.path, args, {
        cwd: conversation.cwd,
        env: { ...process.env, ...this.deps.env(), ...(this.deps.accountEnv?.(conversation.agent, conversation.account ?? null) ?? {}) },
        // Its own process group, so stopping the turn stops everything it started too.
        detached: process.platform !== 'win32',
        stdio: [stdin ?? 'ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      closeFd(stdin)
      conversation.status = 'error'
      conversation.error = messageOf(err)
      conversation.updatedAt = Date.now()
      this.persist(conversation)
      this.deps.emit(clone(conversation))
      return
    }
    // The CLI has standard input now, so the empty device is ours to close.
    closeFd(stdin)

    const group = supervise(child)
    const turn: Turn = {
      child,
      group,
      stopped: false,
      assistantId: null,
      request,
      access,
      stderr: [],
      lastEmit: 0,
      emitTimer: null
    }
    this.turns.set(conversation.id, turn)
    if (this.quitting) {
      turn.stopped = true
      group.stop()
    }

    let outBuffer = ''
    let errBuffer = ''
    let spawnError: string | null = null

    const done = new Promise<void>((resolveTurn) => {
      let settled = false
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        // A last line without a newline still counts.
        if (outBuffer.trim()) this.handleLine(turn, conversation, outBuffer)
        if (errBuffer.trim()) turn.stderr.push(errBuffer.trim())
        this.endTurn(conversation, turn, code, spawnError)
        resolveTurn()
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const parts = (outBuffer + chunk.toString('utf8')).split('\n')
        outBuffer = parts.pop() ?? ''
        for (const part of parts) this.handleLine(turn, conversation, part.replace(/\r$/, ''))
      })
      // Standard error is only kept for the message the conversation ends with.
      child.stderr?.on('data', (chunk: Buffer) => {
        const parts = (errBuffer + chunk.toString('utf8')).split('\n')
        errBuffer = parts.pop() ?? ''
        for (const part of parts) turn.stderr.push(part.replace(/\r$/, ''))
        if (turn.stderr.length > 5) turn.stderr = turn.stderr.slice(-5)
      })

      child.on('error', (err) => {
        spawnError = messageOf(err)
      })
      // Done only once the agent and every process of its group are gone.
      void group.done.then((code) => finish(code))
    })

    await done
  }

  /** One line of output, from stdout only. Anything the parsers do not know is ignored. */
  private handleLine(turn: Turn, conversation: Conversation, line: string): void {
    if (!line.trim()) return
    for (const event of parseLine(conversation.agent, line)) this.apply(turn, conversation, event)
    this.touch(turn, conversation)
  }

  private apply(turn: Turn, conversation: Conversation, event: TurnEvent): void {
    switch (event.kind) {
      case 'session':
        if (!conversation.cliSessionId) conversation.cliSessionId = event.id
        break
      case 'text':
        this.appendText(conversation, turn, event.delta, true)
        break
      case 'message':
        this.appendText(conversation, turn, event.text, false)
        break
      case 'tool':
        this.addMessage(conversation, 'tool', event.text)
        break
      case 'write-request':
        // Only a read turn has to ask. With write access the agent simply does it.
        if (turn.access === 'read') {
          conversation.pending = {
            id: `w-${shortId()}`,
            kind: 'workspace-write',
            request: turn.request,
            summary: event.summary
          }
        }
        break
      case 'tokens':
        conversation.tokens = (conversation.tokens ?? 0) + event.tokens
        break
    }
  }

  /**
   * Assistant text for this turn goes into one message. Streaming pieces land in it as they
   * arrive, and a whole message that only repeats what already streamed in is dropped.
   */
  private appendText(conversation: Conversation, turn: Turn, body: string, delta: boolean): void {
    if (!body) return
    let message = turn.assistantId ? conversation.messages.find((m) => m.id === turn.assistantId) : undefined
    if (!message) {
      message = this.addMessage(conversation, 'assistant', '')
      turn.assistantId = message.id
    }
    if (delta) {
      message.text += body
      return
    }
    if (message.text.endsWith(body)) return
    message.text = message.text ? `${message.text}\n\n${body}` : body
  }

  private addMessage(conversation: Conversation, role: ChatMessage['role'], body: string): ChatMessage {
    const message: ChatMessage = { id: `m${conversation.messages.length}-${shortId(4)}`, role, text: body, at: Date.now() }
    conversation.messages.push(message)
    conversation.updatedAt = message.at
    return message
  }

  /** The CLI is gone: the conversation is saved and its final state goes out. */
  private endTurn(conversation: Conversation, turn: Turn, code: number | null, spawnError: string | null): void {
    if (this.turns.get(conversation.id) === turn) this.turns.delete(conversation.id)
    if (turn.emitTimer) clearTimeout(turn.emitTimer)
    // A conversation that was deleted while its turn was running stays gone.
    if (!this.conversations.has(conversation.id)) return

    const stuck = turn.group.stuck
    const failed = !turn.stopped && code !== null && code !== 0
    conversation.status = stuck || failed || spawnError ? 'error' : 'idle'
    conversation.error =
      spawnError ??
      (stuck ? STUCK_TURN_ERROR : failed ? lastLine(turn.stderr) || `The agent stopped with code ${code}.` : null)
    conversation.updatedAt = Date.now()
    this.persist(conversation)
    turn.lastEmit = Date.now()
    this.deps.emit(clone(conversation))
  }

  private persist(conversation: Conversation): void {
    saveConversation(this.deps.dataDir, conversation)
  }

  private emitTeammates(): void {
    saveTeammates(this.deps.dataDir, this.crew)
    this.deps.emitTeammates(this.crew.map(clone))
  }

  private agentFor(agent: ChatAgent): DetectedAgent & { path: string } {
    const found = this.deps.agents().find((a) => a.kind === agent)
    if (!found || !found.installed || !found.path) throw new Error(`${AGENTS[agent]?.name ?? agent} is not installed.`)
    return found as DetectedAgent & { path: string }
  }

  private must(id: string): Conversation {
    const conversation = this.conversations.get(id)
    if (!conversation) throw new Error('That conversation is no longer here.')
    return conversation
  }

  /** Sends the state now, or at most ten times a second while a turn streams. */
  private touch(turn: Turn, conversation: Conversation): void {
    const wait = EMIT_MS - (Date.now() - turn.lastEmit)
    if (wait <= 0) return this.flush(turn, conversation)
    if (turn.emitTimer) return
    turn.emitTimer = setTimeout(() => {
      turn.emitTimer = null
      this.flush(turn, conversation)
    }, wait)
    turn.emitTimer.unref()
  }

  private flush(turn: Turn, conversation: Conversation): void {
    if (turn.emitTimer) {
      clearTimeout(turn.emitTimer)
      turn.emitTimer = null
    }
    turn.lastEmit = Date.now()
    this.deps.emit(clone(conversation))
  }
}

/** Standard input is the empty device: the CLI never waits for a human to type. */
function openStdin(): number | null {
  try {
    return openSync('/dev/null', 'r')
  } catch {
    return null
  }
}

function closeFd(fd: number | null): void {
  if (fd === null) return
  try {
    closeSync(fd)
  } catch {
    // The CLI already has it.
  }
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line
}

function lastLine(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (line) return line
  }
  return ''
}

/** Lowercase letters and digits, short enough for a file name. */
function shortId(length = ID_LENGTH): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789'
  let id = ''
  for (let i = 0; i < length; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)]
  return id
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
