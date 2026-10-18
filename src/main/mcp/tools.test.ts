// Unit tests for the built-in MCP tools, with fake dependencies for each one.

import { describe, expect, it } from 'vitest'
import { cutText, MCP_MAX_TEXT, plainLines, regattaTools, stripEscapeCodes, type McpTool, type McpToolDeps } from './tools'
import type { HeatState, LaneState } from '../../shared/heats'
import type { Teammate } from '../../shared/chat'
import type { SearchQuery, SessionInfo } from '../../shared/types'

/** ESC and BEL, written as bytes so this file holds no control characters. */
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'p1',
    agent: 'claude',
    title: 'Fix the login page',
    cwd: '/Users/someone/regatta',
    command: 'claude',
    args: [],
    createdAt: Date.now() - 60_000,
    pid: 4242,
    status: { state: 'working', since: Date.now() - 5_000, reason: 'Claude hook: Stop', source: 'hook' },
    exitCode: null,
    signals: 'hooks',
    worktree: null,
    branch: 'main',
    limit: null,
    transcriptPath: null,
    account: null,
    ...over
  }
}

function teammate(over: Partial<Teammate> = {}): Teammate {
  return {
    id: 'm1',
    name: 'Ada',
    role: 'Implementation and release review',
    instructions: '',
    agent: 'codex',
    memory: '',
    createdAt: Date.now() - 86_400_000,
    ...over
  }
}

function lane(over: Partial<LaneState> = {}): LaneState {
  return {
    id: 'l1',
    agent: 'claude',
    worktree: '/Users/someone/regatta/.worktrees/l1',
    branch: 'heat/l1',
    phase: 'done',
    startedAt: 1,
    endedAt: 2,
    exitCode: 0,
    durationMs: 1000,
    timedOut: false,
    diff: { files: 2, added: 10, removed: 1 },
    tokens: null,
    latest: 'all checks pass',
    checks: [],
    tests: null,
    gates: [],
    error: null,
    ...over
  }
}

function heat(over: Partial<HeatState> = {}): HeatState {
  return {
    id: 'h1',
    task: 'Speed up the search panel',
    root: '/Users/someone/regatta',
    base: 'abc123',
    createdAt: Date.now() - 600_000,
    status: 'decided',
    checks: [],
    baseline: [],
    baselineTests: null,
    lanes: [lane(), lane({ id: 'l2', agent: 'codex', phase: 'checking', branch: 'heat/l2' })],
    decision: { kind: 'winner', laneIds: ['l1'], note: 'Claude Code wins.' },
    error: null,
    ...over
  }
}

interface Harness extends McpToolDeps {
  tools: McpTool[]
  asked: SearchQuery[]
  tool: (name: string) => McpTool
}

function harness(over: Partial<McpToolDeps> = {}): Harness {
  const asked: SearchQuery[] = []
  const deps: McpToolDeps = {
    workspace: () => ({ root: '/Users/someone/regatta', name: 'regatta', recent: [] }),
    gitStatus: async () => ({ branch: 'main', changes: [{ path: 'a.ts', status: ' M' }, { path: 'b.ts', status: '??' }] }),
    sessions: () => [session()],
    output: () => '',
    crew: () => [],
    search: async (query) => {
      asked.push(query)
      return { matches: [], truncated: false, engine: 'rg' }
    },
    heats: () => [],
    ...over
  }
  const tools = regattaTools(deps)
  return {
    ...deps,
    tools,
    asked,
    tool: (name: string) => {
      const found = tools.find((t) => t.name === name)
      if (!found) throw new Error(`no tool ${name}`)
      return found
    }
  }
}

describe('mcp tools: every tool explains itself', () => {
  it('offers the six built-in tools, each described for a model', () => {
    const { tools } = harness()
    expect(tools.map((t) => t.name)).toEqual([
      'regatta_project',
      'regatta_list_panes',
      'regatta_read_pane',
      'regatta_list_crew',
      'regatta_search_project',
      'regatta_list_heats'
    ])
    for (const tool of tools) {
      expect(tool.name.startsWith('regatta_')).toBe(true)
      expect(tool.title.length).toBeGreaterThan(2)
      expect(tool.description.length).toBeGreaterThan(40)
      expect((tool.inputSchema as { type: string }).type).toBe('object')
    }
  })
})

describe('mcp tools: regatta_project', () => {
  it('reports the folder, the branch and how many files changed', async () => {
    const { tool } = harness()
    const result = await tool('regatta_project').run({})
    expect(result.data).toEqual({
      name: 'regatta',
      root: '/Users/someone/regatta',
      branch: 'main',
      changedFiles: 2
    })
    expect(result.text).toContain('Branch: main')
    expect(result.text).toContain('Changed files: 2')
  })

  it('copes with a folder that is not a git repository', async () => {
    const { tool } = harness({ gitStatus: async () => null })
    const result = await tool('regatta_project').run({})
    expect(result.data).toMatchObject({ branch: null, changedFiles: 0 })
    expect(result.text).toContain('Branch: none')
  })
})

describe('mcp tools: regatta_list_panes', () => {
  it('lists every pane with its state, reason, time, folder and branch', async () => {
    const { tool } = harness({
      sessions: () => [
        session(),
        session({ id: 'p2', agent: 'shell', title: 'Terminal', branch: null, status: { state: 'idle', since: Date.now() - 120_000, reason: 'Process is at its prompt', source: 'output' } })
      ]
    })
    const result = await tool('regatta_list_panes').run({})
    const data = result.data as { panes: { id: string; agent: string; state: string; inStateSec: number; branch: string | null }[] }
    expect(data.panes.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(data.panes[0]?.agent).toBe('Claude Code')
    expect(data.panes[0]?.state).toBe('working')
    expect(data.panes[0]?.inStateSec).toBeGreaterThanOrEqual(4)
    expect(data.panes[1]?.branch).toBeNull()
    expect(result.text).toContain('Fix the login page')
    expect(result.text).toContain('(main)')
  })

  it('says so when nothing is running', async () => {
    const { tool } = harness({ sessions: () => [] })
    expect((await tool('regatta_list_panes').run({})).text).toBe('No agents are running in Regatta.')
  })
})

describe('mcp tools: regatta_read_pane', () => {
  const output = [
    `${ESC}[2J${ESC}[H`,
    `${ESC}]0;regatta${BEL}`,
    'claude > hello',
    'running 10%\rrunning 100%',
    `${ESC}[32mdone${ESC}[0m, nothing to fix`
  ].join('\n')

  it('removes escape codes and keeps what the pane finally showed', () => {
    expect(plainLines(output)).toEqual(['claude > hello', 'running 100%', 'done, nothing to fix'])
  })

  it('reads the last lines of a pane', async () => {
    const { tool } = harness({ output: () => output })
    const result = await tool('regatta_read_pane').run({ id: 'p1', lines: 2 })
    expect(result.data).toEqual({ id: 'p1', agent: 'Claude Code', state: 'working', lines: ['running 100%', 'done, nothing to fix'] })
    expect(result.text).toBe('running 100%\ndone, nothing to fix')
  })

  it('reads sixty lines by default', async () => {
    const { tool } = harness({ output: () => Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') })
    const result = await tool('regatta_read_pane').run({ id: 'p1' })
    const data = result.data as { lines: string[] }
    expect(data.lines).toHaveLength(60)
    expect(data.lines[0]).toBe('line 140')
  })

  it('reports an id it does not know as an error, not a crash', async () => {
    const { tool } = harness({ output: () => output })
    const result = await tool('regatta_read_pane').run({ id: 'nope' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('No pane with id nope')
  })

  it('copes with a pane that has printed nothing', async () => {
    const { tool } = harness({ output: () => '' })
    expect((await tool('regatta_read_pane').run({ id: 'p1' })).text).toContain('printed nothing yet')
  })
})

describe('mcp tools: regatta_list_crew', () => {
  it('lists crew members with their job and agent', async () => {
    const { tool } = harness({ crew: () => [teammate(), teammate({ id: 'm2', name: 'Grace', role: 'Tests', agent: 'claude' })] })
    const result = await tool('regatta_list_crew').run({})
    expect(result.data).toEqual({
      crew: [
        { id: 'm1', name: 'Ada', role: 'Implementation and release review', agent: 'Codex' },
        { id: 'm2', name: 'Grace', role: 'Tests', agent: 'Claude Code' }
      ]
    })
    expect(result.text).toContain('m1  Ada  Implementation and release review  Codex')
  })

  it('says so when there is no crew', async () => {
    const { tool } = harness()
    expect((await tool('regatta_list_crew').run({})).text).toContain('No crew members yet')
  })
})

describe('mcp tools: regatta_search_project', () => {
  it('returns path, line and text for every match', async () => {
    const { tool } = harness({
      search: async () => ({
        matches: [
          { path: 'src/main.ts', line: 12, column: 3, text: '  const port = 47821' },
          { path: 'src/shared/mcp.ts', line: 26, column: 1, text: 'export const DEFAULT_MCP_PORT = 47821' }
        ],
        truncated: true,
        engine: 'rg'
      })
    })
    const result = await tool('regatta_search_project').run({ query: '47821' })
    expect(result.text).toContain('src/main.ts:12: const port = 47821')
    expect(result.text).toContain('src/shared/mcp.ts:26: export const DEFAULT_MCP_PORT = 47821')
    expect(result.text).toContain('cut')
    expect(result.data).toMatchObject({ query: '47821', truncated: true })
  })

  it('passes the options through with its defaults', async () => {
    const h = harness()
    await h.tool('regatta_search_project').run({})
    expect(h.asked[0]).toEqual({ text: '', regex: false, caseSensitive: false, limit: 50 })
    await h.tool('regatta_search_project').run({ query: 'x', regex: true, caseSensitive: true, limit: 10 })
    expect(h.asked[1]).toEqual({ text: 'x', regex: true, caseSensitive: true, limit: 10 })
  })

  it('says so when nothing matched', async () => {
    const { tool } = harness()
    expect((await tool('regatta_search_project').run({ query: 'zzz' })).text).toContain('No matches')
  })

  it('lets a failed search throw, so the server can report it', async () => {
    const { tool } = harness({
      search: async () => {
        throw new Error('ripgrep is missing')
      }
    })
    await expect(tool('regatta_search_project').run({ query: 'x' })).rejects.toThrow('ripgrep is missing')
  })
})

describe('mcp tools: regatta_list_heats', () => {
  it('lists each heat with its lanes and the winner', async () => {
    const { tool } = harness({ heats: () => [heat()] })
    const result = await tool('regatta_list_heats').run({})
    expect(result.data).toEqual({
      heats: [
        {
          id: 'h1',
          task: 'Speed up the search panel',
          status: 'decided',
          lanes: [
            { id: 'l1', agent: 'Claude Code', status: 'done', branch: 'heat/l1', latest: 'all checks pass' },
            { id: 'l2', agent: 'Codex', status: 'checking', branch: 'heat/l2', latest: 'all checks pass' }
          ],
          winner: 'l1',
          note: 'Claude Code wins.'
        }
      ]
    })
    expect(result.text).toContain('lanes: Claude Code (done), Codex (checking)')
    expect(result.text).toContain('winner: l1')
  })

  it('says so when there are no heats', async () => {
    const { tool } = harness()
    expect((await tool('regatta_list_heats').run({})).text).toContain('No heats yet')
  })
})

describe('mcp tools: escape codes and long text', () => {
  it('drops CSI sequences, OSC sequences and other escapes', () => {
    expect(stripEscapeCodes(`${ESC}[1;32mok${ESC}[0m`)).toBe('ok')
    expect(stripEscapeCodes(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link')
    expect(stripEscapeCodes(`a${ESC}Mb`)).toBe('ab')
    expect(stripEscapeCodes('nothing to strip')).toBe('nothing to strip')
  })

  it('keeps the text after the last carriage return on a line', () => {
    expect(stripEscapeCodes('first\rsecond\rthird')).toBe('third')
    expect(stripEscapeCodes('one\r\ntwo\rthree')).toBe('one\nthree')
  })

  it('trims blank lines from the top and bottom', () => {
    expect(plainLines('\n\na\n\nb\n\n\n')).toEqual(['a', '', 'b'])
    expect(plainLines('   ')).toEqual([])
  })

  it('cuts text past 20 KB and says where it cut', () => {
    expect(cutText('short')).toBe('short')
    const cut = cutText('y'.repeat(MCP_MAX_TEXT + 500))
    expect(cut.startsWith('y'.repeat(MCP_MAX_TEXT))).toBe(true)
    expect(cut.endsWith('... (cut)')).toBe(true)
    expect(MCP_MAX_TEXT).toBe(20 * 1024)
  })
})