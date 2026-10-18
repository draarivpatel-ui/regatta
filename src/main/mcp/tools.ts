// The tools Regatta's MCP server offers.
// Other packages (tasks, schedules) add their own tools later through the same McpTool shape.

import { AGENTS } from '../../shared/agents'
import type { HeatState } from '../../shared/heats'
import type { Teammate } from '../../shared/chat'
import type { AgentKind, GitStatus, SearchQuery, SearchResult, SessionInfo, WorkspaceInfo } from '../../shared/types'

/** What a tool returns: text for the model, optional structured data, and whether it failed. */
export interface McpToolResult {
  text: string
  data?: unknown
  isError?: boolean
}

export interface McpTool {
  /** Lowercase with underscores, starting with "regatta_". */
  name: string
  title: string
  description: string
  /** JSON Schema of the arguments (type "object"). */
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<McpToolResult>
}

export interface McpToolDeps {
  workspace: () => WorkspaceInfo
  gitStatus: () => Promise<GitStatus | null>
  sessions: () => SessionInfo[]
  /** Everything the pane has printed so far (raw terminal output with escape codes). */
  output: (id: string) => string
  crew: () => Teammate[]
  search: (query: SearchQuery) => Promise<SearchResult>
  heats: () => HeatState[]
}

/** Longest text a tool hands back to a client: 20 KB. */
export const MCP_MAX_TEXT = 20 * 1024

/** Shortens tool text past 20 KB, saying so where it cut. */
export function cutText(text: string): string {
  if (text.length <= MCP_MAX_TEXT) return text
  return `${text.slice(0, MCP_MAX_TEXT)}\n... (cut)`
}

/** ESC and BEL, the two control bytes terminal output leans on. */
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

/** A CSI sequence ends at the first byte in the range 0x40 to 0x7e. */
function isCsiFinal(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return code >= 0x40 && code <= 0x7e
}

/**
 * Turns raw terminal output into plain text: drops CSI and OSC escape sequences, and keeps only what
 * came after the last carriage return on each line, since that is what the pane finally showed.
 */
export function stripEscapeCodes(text: string): string {
  let out = ''
  // A newline written as CR LF ends the line; a carriage return on its own rewrites it.
  const source = text.replace(/\r\n/g, '\n')
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!
    if (ch === ESC) {
      const next = source[i + 1]
      if (next === '[') {
        i += 2
        while (i < source.length && !isCsiFinal(source[i]!)) i += 1
      } else if (next === ']') {
        i += 2
        while (i < source.length && source[i] !== BEL && !(source[i] === ESC && source[i + 1] === '\\')) i += 1
        if (source[i] === ESC) i += 1
      } else {
        i += 1
      }
      continue
    }
    if (ch === '\r') {
      out = out.slice(0, out.lastIndexOf('\n') + 1)
      continue
    }
    out += ch
  }
  return out
}

/** The plain lines of a pane's output, without blank lines at either end. */
export function plainLines(raw: string): string[] {
  const lines = stripEscapeCodes(raw).split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  return lines
}

function agentName(kind: AgentKind): string {
  return AGENTS[kind]?.name ?? kind
}

/** "42 s", "3 m", "1 h 4 m". */
function span(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s} s`
  const minutes = Math.floor(s / 60)
  if (minutes < 60) return `${minutes} m`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`
}

function secondsIn(from: number): number {
  return Math.max(0, Math.floor((Date.now() - from) / 1000))
}

/** The built-in tools. */
export function regattaTools(deps: McpToolDeps): McpTool[] {
  const project = (): McpTool => ({
    name: 'regatta_project',
    title: 'Project',
    description: 'The project Regatta has open: its folder, its git branch and how many files are changed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const workspace = deps.workspace()
      const git = await deps.gitStatus()
      const data = {
        name: workspace.name,
        root: workspace.root,
        branch: git?.branch ?? null,
        changedFiles: git?.changes.length ?? 0
      }
      const text = [
        `Project: ${data.name}`,
        `Folder: ${data.root}`,
        `Branch: ${data.branch ?? 'none (not a git repository)'}`,
        `Changed files: ${data.changedFiles}`
      ].join('\n')
      return { text, data }
    }
  })

  const listPanes = (): McpTool => ({
    name: 'regatta_list_panes',
    title: 'List panes',
    description:
      'Every coding agent running in Regatta right now: its pane id, which agent it is, its title, what it is doing and why, how long it has been in that state, and the folder and branch it works in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const panes = deps.sessions().map((session) => ({
        id: session.id,
        agent: agentName(session.agent),
        title: session.title,
        state: session.status.state,
        reason: session.status.reason,
        inStateSec: secondsIn(session.status.since),
        folder: session.cwd,
        branch: session.branch
      }))
      const text =
        panes.length === 0
          ? 'No agents are running in Regatta.'
          : panes
              .map(
                (pane) =>
                  `${pane.id}  ${pane.agent}  ${pane.title}  ${pane.state}  ${span(pane.inStateSec)}  ${pane.reason}  ${pane.folder}${
                    pane.branch ? ` (${pane.branch})` : ''
                  }`
              )
              .join('\n')
      return { text, data: { panes } }
    }
  })

  const readPane = (): McpTool => ({
    name: 'regatta_read_pane',
    title: 'Read a pane',
    description: 'The last lines one Regatta pane printed, with terminal escape codes removed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The pane id, as listed by regatta_list_panes.' },
        lines: { type: 'integer', minimum: 1, maximum: 200, default: 60, description: 'How many lines to read back.' }
      },
      required: ['id'],
      additionalProperties: false
    },
    run: async (args) => {
      const id = String(args.id ?? '')
      const wanted = typeof args.lines === 'number' ? args.lines : 60
      const session = deps.sessions().find((s) => s.id === id)
      if (!session) {
        return { text: `No pane with id ${id}. Call regatta_list_panes for the ids that are running.`, isError: true }
      }
      const all = plainLines(deps.output(id))
      const lines = all.slice(Math.max(0, all.length - wanted))
      const text =
        lines.length === 0 ? `Pane ${id} (${agentName(session.agent)}) has printed nothing yet.` : lines.join('\n')
      return { text, data: { id, agent: agentName(session.agent), state: session.status.state, lines } }
    }
  })

  const listCrew = (): McpTool => ({
    name: 'regatta_list_crew',
    title: 'List crew',
    description: 'The crew members saved in Regatta: each one has a name, a job to do and the agent CLI they use.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const members = deps.crew().map((mate) => ({
        id: mate.id,
        name: mate.name,
        role: mate.role,
        agent: agentName(mate.agent)
      }))
      const text =
        members.length === 0
          ? 'No crew members yet. Add some in Regatta under Chat.'
          : members.map((m) => `${m.id}  ${m.name}  ${m.role}  ${m.agent}`).join('\n')
      return { text, data: { crew: members } }
    }
  })

  const searchProject = (): McpTool => ({
    name: 'regatta_search_project',
    title: 'Search the project',
    description: 'Looks for text (or a regular expression) in the files of the open project and returns where it matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text to look for.' },
        regex: { type: 'boolean', default: false, description: 'Read the query as a regular expression.' },
        caseSensitive: { type: 'boolean', default: false, description: 'Match upper and lower case exactly.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'How many matches to return.' }
      },
      required: ['query'],
      additionalProperties: false
    },
    run: async (args) => {
      const query = String(args.query ?? '')
      const result = await deps.search({
        text: query,
        regex: args.regex === true,
        caseSensitive: args.caseSensitive === true,
        limit: typeof args.limit === 'number' ? args.limit : 50
      })
      const matches = result.matches.map((m) => ({ path: m.path, line: m.line, text: m.text.trim() }))
      const body = matches.map((m) => `${m.path}:${m.line}: ${m.text}`)
      const text =
        body.length === 0
          ? `No matches for ${JSON.stringify(query)}.`
          : body.join('\n') + (result.truncated ? '\n(more matches exist, these were cut)' : '')
      return { text, data: { query, matches, truncated: result.truncated } }
    }
  })

  const listHeats = (): McpTool => ({
    name: 'regatta_list_heats',
    title: 'List heats',
    description:
      'The heats in Regatta: several agents racing the same task in their own worktrees, with each lane its status and which lane won.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const rows = deps.heats().map((heat) => ({
        id: heat.id,
        task: heat.task,
        status: heat.status,
        lanes: heat.lanes.map((lane) => ({
          id: lane.id,
          agent: agentName(lane.agent),
          status: lane.phase,
          branch: lane.branch,
          latest: lane.latest
        })),
        winner: heat.decision ? heat.decision.laneIds.join(', ') : null,
        note: heat.decision?.note ?? null
      }))
      const text =
        rows.length === 0
          ? 'No heats yet. A heat runs several agents on one task and keeps the one that passes.'
          : rows
              .map(
                (heat) =>
                  `${heat.id}  ${heat.status}  ${heat.task}\n    lanes: ${
                    heat.lanes.map((l) => `${l.agent} (${l.status})`).join(', ') || 'none'
                  }${heat.winner ? `\n    winner: ${heat.winner}` : ''}${heat.note ? `\n    ${heat.note}` : ''}`
              )
              .join('\n')
      return { text, data: { heats: rows } }
    }
  })

  return [project(), listPanes(), readPane(), listCrew(), searchProject(), listHeats()]
}