// Tests for the command line a pane starts an agent with: extra arguments (agent tools) come last,
// after the hook settings and the Codex notify arguments.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DetectedAgent } from '../shared/types'

const spawned: { file: string; args: string[] }[] = []

vi.mock('@lydell/node-pty', () => ({
  spawn: vi.fn((file: string, args: string[]) => {
    spawned.push({ file, args })
    return { pid: 4242, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: () => {}, onExit: () => {} }
  })
}))

const { SessionManager } = await import('./sessions')

function agent(kind: DetectedAgent['kind'], signals: DetectedAgent['signals']): DetectedAgent {
  return {
    kind,
    name: kind,
    short: kind,
    command: kind,
    args: ['--base'],
    monogram: kind.slice(0, 2).toUpperCase(),
    color: '#000000',
    signals,
    installed: true,
    path: `/bin/${kind}`,
    version: null
  }
}

const managers: InstanceType<typeof SessionManager>[] = []

function setup(a: DetectedAgent, extraArgs?: (kind: DetectedAgent['kind']) => string[]) {
  const manager = new SessionManager({
    env: () => ({}),
    agents: () => [a],
    hooks: { claudeSettings: () => '{"hooks":{}}', codexArgs: () => ['-c', 'notify=["x"]'] } as never,
    workspaceRoot: () => '/tmp',
    emit: () => {},
    quietAfterSec: () => 60,
    createWorktree: async () => {
      throw new Error('not used')
    },
    ...(extraArgs ? { extraArgs } : {})
  })
  managers.push(manager)
  return manager
}

afterEach(() => {
  for (const m of managers.splice(0)) m.disposeAll()
  spawned.length = 0
})

describe('extra arguments for a pane', () => {
  it('puts them after --settings for Claude Code', async () => {
    const extra = vi.fn(() => ['--mcp-config', '/data/claude.json'])
    await setup(agent('claude', 'hooks'), extra).create({ agent: 'claude', cols: 80, rows: 24 })
    expect(extra).toHaveBeenCalledWith('claude')
    expect(spawned[0]!.args).toEqual(['--base', '--settings', '{"hooks":{}}', '--mcp-config', '/data/claude.json'])
  })

  it('puts them after the notify arguments for Codex', async () => {
    await setup(agent('codex', 'notify'), () => ['-c', 'mcp_servers.x.command="x"']).create({ agent: 'codex', cols: 80, rows: 24 })
    expect(spawned[0]!.args).toEqual(['--base', '-c', 'notify=["x"]', '-c', 'mcp_servers.x.command="x"'])
  })

  it('adds nothing without the dependency', async () => {
    await setup(agent('claude', 'hooks')).create({ agent: 'claude', cols: 80, rows: 24 })
    expect(spawned[0]!.args).toEqual(['--base', '--settings', '{"hooks":{}}'])
  })
})
