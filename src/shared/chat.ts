// Conversations with agent CLIs in headless mode. See docs/design/conversations.md.

import type { AgentKind } from './types'

export type ChatAgent = Extract<AgentKind, 'claude' | 'codex' | 'fake'>
export const CHAT_AGENTS: ChatAgent[] = ['claude', 'codex', 'fake']

/**
 * How much the agent reasons on a turn. Empty means the CLI's own default. Claude Code takes
 * `--effort <level>`; Codex takes `-c model_reasoning_effort=<level>` (levels depend on the model,
 * so only the common ones are offered and the CLI refuses the rest). Verified 2026-10-14.
 */
export type Reasoning = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const REASONING_LEVELS: Record<ChatAgent, Reasoning[]> = {
  claude: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['', 'low', 'medium', 'high', 'xhigh'],
  fake: ['']
}
export const REASONING_LABEL: Record<Reasoning, string> = {
  '': 'Default',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/** read: the agent may look but not change files. write: it may edit inside the conversation's folder. */
export type Access = 'read' | 'write'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  at: number
}

export interface WriteRequest {
  /** Random id made when the request is recorded, so an approval is bound to the exact request shown. */
  id?: string
  kind: 'workspace-write'
  /** The user's request that will be rerun with write access. */
  request: string
  /** What the agent said it wants to change. */
  summary: string
}

export interface Conversation {
  id: string
  title: string
  agent: ChatAgent
  /** Empty means the CLI's default model. */
  model: string
  cwd: string
  access: Access
  cliSessionId: string | null
  teammateId: string | null
  /** The sign-in (AccountInfo id) turns run with; null means the CLI's default. */
  account?: string | null
  /** Reasoning level for turns; empty or absent means the CLI's default. */
  reasoning?: Reasoning
  messages: ChatMessage[]
  status: 'idle' | 'running' | 'error'
  pending: WriteRequest | null
  tokens: number | null
  createdAt: number
  updatedAt: number
  error: string | null
}

export interface Teammate {
  id: string
  name: string
  /** One line, for example "Implementation and release review". */
  role: string
  instructions: string
  agent: ChatAgent
  /** Notes the teammate keeps between conversations. */
  memory: string
  /** Ids of the skills this crew member has (Settings > Skills). Missing means none. */
  skills?: string[]
  createdAt: number
}

/** Reusable instructions given to crew members. Settings > Skills. */
export interface Skill {
  id: string
  name: string
  /** One line: what the skill is for. */
  description: string
  instructions: string
  /** Where it came from: written in Regatta, or copied from a Claude Code skill folder. */
  source: 'regatta' | 'claude'
  createdAt: number
  updatedAt: number
}

/** A Claude Code skill found on this computer that can be copied into Regatta. */
export interface ImportableSkill {
  name: string
  description: string
  /** The SKILL.md file it was read from. */
  path: string
}

export interface NewConversation {
  agent: ChatAgent
  model?: string
  cwd?: string
  access?: Access
  teammateId?: string | null
  title?: string
  reasoning?: Reasoning
}
