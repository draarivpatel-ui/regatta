// Regatta's own MCP server: other tools (Claude Code, Cursor, any MCP client) can use Regatta.

export interface McpState {
  /** The user turned the server on (saved; it starts with the app). */
  enabled: boolean
  /** Listening right now. */
  running: boolean
  port: number
  /** For example "http://127.0.0.1:47821/mcp", or null while stopped. */
  url: string | null
  /** The token with all but its last 4 characters hidden, for display. */
  tokenHint: string
  /** Why it is not running when it should be, for example "Port 47821 is in use". */
  error: string | null
  tools: McpToolInfo[]
}

export interface McpToolInfo {
  name: string
  title: string
  description: string
}

/** The first port tried; the user can pick another in Settings > MCP. */
export const DEFAULT_MCP_PORT = 47821
