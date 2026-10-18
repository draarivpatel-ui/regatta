// MCP servers the user trusts and gives to their agents (Claude Code, Codex).

/** The agents that can be given tools from an MCP server. */
export const AGENT_TOOL_AGENTS = ['claude', 'codex'] as const
export type AgentToolAgent = (typeof AGENT_TOOL_AGENTS)[number]

/** One tool a server offers, as it answered `tools/list`. */
export interface AgentToolInfo {
  name: string
  description: string
}

/** What running the server once showed. It only counts while `fingerprint` matches the server's. */
export interface AgentToolVerification {
  at: number
  /** The server's fingerprint when it was verified. */
  fingerprint: string
  serverName: string | null
  serverVersion: string | null
  protocolVersion: string
  tools: AgentToolInfo[]
}

export interface AgentToolServer {
  /** Lowercase letters, digits and "-". It is the name the agents see. */
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  agents: AgentToolAgent[]
  /** Turned on: agents get this server. Only possible while `verified` holds the current fingerprint. */
  enabled: boolean
  /** sha256 of the command, arguments and environment. */
  fingerprint: string
  verified: AgentToolVerification | null
  createdAt: number
  updatedAt: number
}

/** What the user fills in. Without an `id` it is a new server. */
export interface AgentToolDraft {
  id?: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  agents: AgentToolAgent[]
}

export type AgentToolVerifyResult =
  | { ok: true; server: AgentToolServer }
  | { ok: false; error: string; stderr: string; server: AgentToolServer | null }
