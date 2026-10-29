// Unit tests for AgentToolStore.

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentToolStore,
  computeFingerprint,
  tomlInlineTable,
  tomlString,
  tomlStringArray,
  type AgentToolDeps
} from './agent-tools'

const fakeMcpScript = resolve(__dirname, '../../scripts/fake-mcp-server.mjs')

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-agent-tools-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeStore(overrides: Partial<AgentToolDeps> = {}): {
  store: AgentToolStore
  dataDir: string
  binDir: string
  emitted: ReturnType<AgentToolStore['list']>[]
} {
  const base = makeTempDir()
  const dataDir = join(base, 'data')
  const binDir = join(base, 'bin')
  const rootDir = join(base, 'workspace')
  rmSync(base, { recursive: true, force: true })
  const { mkdirSync } = require('node:fs') as typeof import('node:fs')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(rootDir, { recursive: true })
  tempDirs.push(base)

  // Place a wrapper executable on PATH so bare command names work too.
  const mcpBin = join(binDir, 'fake-mcp')
  writeFileSync(mcpBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeMcpScript}" "$@"\n`, { mode: 0o755 })
  chmodSync(mcpBin, 0o755)

  const emitted: ReturnType<AgentToolStore['list']>[] = []
  const store = new AgentToolStore({
    dataDir,
    env: () => ({
      PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
      HOME: base
    }),
    root: () => rootDir,
    version: '0.1.0-test',
    emit: (list) => emitted.push(list),
    ...overrides
  })

  return { store, dataDir, binDir, emitted }
}

describe('AgentToolStore', () => {
  it('saves a server, computes deterministic fingerprint, and writes 0600 files', () => {
    const { store, dataDir, emitted } = makeStore()

    const list = store.save({
      name: 'notes-mcp',
      command: process.execPath,
      args: [fakeMcpScript],
      env: { Z_VAR: 'two', A_VAR: 'one' },
      agents: ['claude', 'codex']
    })

    expect(list).toHaveLength(1)
    expect(emitted).toHaveLength(1)
    const srv = list[0]!
    expect(srv.id).toBe('notes-mcp')
    expect(srv.name).toBe('notes-mcp')
    expect(srv.enabled).toBe(false)
    expect(srv.verified).toBeNull()

    // Fingerprint sorts env entries by key.
    const expectedFp = computeFingerprint(process.execPath, [fakeMcpScript], { A_VAR: 'one', Z_VAR: 'two' })
    expect(srv.fingerprint).toBe(expectedFp)

    const storeFile = join(dataDir, 'agent-tools.json')
    const claudeFile = join(dataDir, 'agent-tools', 'claude.json')
    expect(statSync(storeFile).mode & 0o777).toBe(0o600)
    expect(statSync(claudeFile).mode & 0o777).toBe(0o600)
  })

  it('validates server id, command, and environment variable names', () => {
    const { store } = makeStore()

    expect(() =>
      store.save({
        name: 'bad@name!',
        command: process.execPath,
        args: [],
        env: {},
        agents: ['claude']
      })
    ).toThrow()

    expect(() =>
      store.save({
        name: 'missing-cmd',
        command: 'definitely-not-a-command-on-path-xyz',
        args: [],
        env: {},
        agents: ['claude']
      })
    ).toThrow(/PATH/)

    expect(() =>
      store.save({
        name: 'bad-env',
        command: process.execPath,
        args: [],
        env: { '123_BAD': 'val' },
        agents: ['claude']
      })
    ).toThrow(/Invalid environment variable name/)
  })

  it('refuses to enable a server while unverified', () => {
    const { store } = makeStore()
    store.save({
      name: 'unverified-srv',
      command: process.execPath,
      args: [fakeMcpScript],
      env: {},
      agents: ['claude', 'codex']
    })

    expect(() => store.setEnabled('unverified-srv', true)).toThrow(/Verify this server/)
    expect(store.list()[0]?.enabled).toBe(false)
  })

  it('verifies against fake-mcp-server.mjs, lists tools, enables, and clears verification on edit', async () => {
    const { store } = makeStore()
    store.save({
      name: 'notes-mcp',
      command: 'fake-mcp',
      args: ['--echo-env', 'SECRET_TOKEN'],
      env: { SECRET_TOKEN: 's3cr3t' },
      agents: ['claude', 'codex']
    })

    const res = await store.verify('notes-mcp')
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.server.verified).not.toBeNull()
    expect(res.server.verified?.serverName).toBe('fake-mcp-s3cr3t')
    expect(res.server.verified?.serverVersion).toBe('1.0.0')
    expect(res.server.verified?.tools).toEqual([
      { name: 'read_notes', description: 'Read notes (s3cr3t).' },
      { name: 'write_note', description: 'Append a short note to the workspace.' }
    ])

    // Can now enable.
    const afterEnable = store.setEnabled('notes-mcp', true)
    expect(afterEnable[0]?.enabled).toBe(true)

    // Changing only the display name or agents keeps verification and enabled state.
    const sameFp = store.save({
      id: 'notes-mcp',
      name: 'Notes MCP',
      command: 'fake-mcp',
      args: ['--echo-env', 'SECRET_TOKEN'],
      env: { SECRET_TOKEN: 's3cr3t' },
      agents: ['claude']
    })
    expect(sameFp[0]?.verified).not.toBeNull()
    expect(sameFp[0]?.enabled).toBe(true)

    // Editing arguments changes fingerprint, clears verification, and turns the server off.
    const edited = store.save({
      id: 'notes-mcp',
      name: 'Notes MCP',
      command: 'fake-mcp',
      args: [],
      env: { SECRET_TOKEN: 's3cr3t' },
      agents: ['claude']
    })
    expect(edited[0]?.verified).toBeNull()
    expect(edited[0]?.enabled).toBe(false)
    expect(() => store.setEnabled('notes-mcp', true)).toThrow(/Verify this server/)
  })

  it('follows tools/list pagination up to 10 pages and truncates long descriptions to 300 chars', async () => {
    const { store } = makeStore()
    store.save({
      name: 'paged',
      command: process.execPath,
      args: [fakeMcpScript, '--paginate'],
      env: {},
      agents: ['claude', 'codex']
    })

    const pagedRes = await store.verify('paged')
    expect(pagedRes.ok).toBe(true)
    if (pagedRes.ok) {
      expect(pagedRes.server.verified?.tools.map((t) => t.name)).toEqual([
        'page_one_tool',
        'page_two_tool',
        'page_three_tool'
      ])
    }

    store.save({
      name: 'infinite',
      command: process.execPath,
      args: [fakeMcpScript, '--infinite-pages'],
      env: {},
      agents: ['claude']
    })
    const infRes = await store.verify('infinite')
    expect(infRes.ok).toBe(true)
    if (infRes.ok) {
      expect(infRes.server.verified?.tools).toHaveLength(10)
    }

    store.save({
      name: 'long-desc',
      command: process.execPath,
      args: [fakeMcpScript, '--long-desc'],
      env: {},
      agents: ['claude']
    })
    const descRes = await store.verify('long-desc')
    expect(descRes.ok).toBe(true)
    if (descRes.ok) {
      expect(descRes.server.verified?.tools[0]?.description.length).toBe(300)
    }
  })

  it('ignores non-JSON lines logged to stdout during verification', async () => {
    const { store } = makeStore()
    store.save({
      name: 'noisy-srv',
      command: process.execPath,
      args: [fakeMcpScript, '--noisy'],
      env: {},
      agents: ['claude', 'codex']
    })

    const res = await store.verify('noisy-srv')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.server.verified?.tools.map((t) => t.name)).toEqual(['read_notes', 'write_note'])
    }
  })

  it('handles a server that exits early or returns an error and captures stderr', async () => {
    const { store } = makeStore()
    store.save({
      name: 'exiting-srv',
      command: process.execPath,
      args: [fakeMcpScript, '--exit'],
      env: {},
      agents: ['claude', 'codex']
    })

    const res = await store.verify('exiting-srv')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.stderr).toContain('configuration file is missing')
      expect(res.server?.verified).toBeNull()
      expect(res.server?.enabled).toBe(false)
    }

    store.save({
      name: 'rpc-err-srv',
      command: process.execPath,
      args: [fakeMcpScript, '--rpc-error'],
      env: {},
      agents: ['claude', 'codex']
    })

    const errRes = await store.verify('rpc-err-srv')
    expect(errRes.ok).toBe(false)
    if (!errRes.ok) {
      expect(errRes.error).toContain('Tool registry unavailable')
      expect(errRes.stderr).toContain('tool registry failed to load')
    }
  })

  it('fails verification instead of crashing when the server closes its input (sol-loop S4)', async () => {
    const { store } = makeStore({ verifyTimeoutMs: 5000, killGraceMs: 300 })
    // Answers initialize, then closes its input and stays alive, so the next request hits a closed pipe.
    store.save({
      name: 'closing-srv',
      command: '/bin/sh',
      args: ['-c', `read line; exec 0<&-; printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}'; sleep 3`],
      env: {},
      agents: ['claude', 'codex']
    })

    const res = await store.verify('closing-srv')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/closed its input|EPIPE/)
  })

  it('times out a server that never answers and kills its entire process group', async () => {
    const { store } = makeStore({ verifyTimeoutMs: 1200, killGraceMs: 300 })
    store.save({
      name: 'hanging-srv',
      command: process.execPath,
      args: [fakeMcpScript, '--hang'],
      env: {},
      agents: ['claude', 'codex']
    })

    const res = await store.verify('hanging-srv')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/Timed out/i)
      expect(res.stderr).toContain('fake-mcp: hanging')
      const match = /child_pid=(\d+)/.exec(res.stderr)
      const childPid = match ? Number(match[1]) : 0
      expect(childPid).toBeGreaterThan(0)
      expect(() => process.kill(childPid, 0)).toThrow()
    }
  })

  it('escapes TOML strings, arrays and inline tables with quotes, backslashes, newlines, controls and non-ASCII', () => {
    expect(tomlString('plain')).toBe('"plain"')
    expect(tomlString('say "hi" \\path\\')).toBe('"say \\"hi\\" \\\\path\\\\"')
    expect(tomlString('line1\nline2\r\t\b\f')).toBe('"line1\\nline2\\r\\t\\b\\f"')
    expect(tomlString('ctrl:\x00\x07\x1b\x7f')).toBe('"ctrl:\\u0000\\u0007\\u001b\\u007f"')
    expect(tomlString('café 東京')).toBe('"café 東京"')

    expect(tomlStringArray(['--flag', 'a"b\\c', 'line\nnext'])).toBe('["--flag", "a\\"b\\\\c", "line\\nnext"]')
    expect(
      tomlInlineTable({
        B_KEY: 'val\n2',
        A_KEY: 'q"1\\2\x7fcafé'
      })
    ).toBe('{ A_KEY = "q\\"1\\\\2\\u007fcafé", B_KEY = "val\\n2" }')
  })

  it('returns the right argsFor each agent and respects per-agent selection', async () => {
    const { store, dataDir } = makeStore()
    store.save({
      name: 'both-tools',
      command: process.execPath,
      args: [fakeMcpScript],
      env: { API_KEY: 'val"1\\2\ncafé' },
      agents: ['claude', 'codex']
    })
    store.save({
      name: 'codex-only',
      command: process.execPath,
      args: [fakeMcpScript, '--noisy'],
      env: {},
      agents: ['codex']
    })

    // Before verification and enabling, argsFor returns [].
    expect(store.argsFor('claude')).toEqual([])
    expect(store.argsFor('codex')).toEqual([])
    expect(store.argsFor('fake')).toEqual([])

    await store.verify('both-tools')
    await store.verify('codex-only')
    store.setEnabled('both-tools', true)
    store.setEnabled('codex-only', true)

    const claudeFile = join(dataDir, 'agent-tools', 'claude.json')
    expect(store.argsFor('claude')).toEqual(['--mcp-config', claudeFile])
    expect(store.argsFor('fake')).toEqual(['--mcp-config', claudeFile])
    expect(store.argsFor('gemini')).toEqual([])
    expect(store.argsFor('shell')).toEqual([])

    const claudeJson = JSON.parse(readFileSync(claudeFile, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
    }
    expect(Object.keys(claudeJson.mcpServers)).toEqual(['both-tools'])
    expect(claudeJson.mcpServers['both-tools']).toEqual({
      command: process.execPath,
      args: [fakeMcpScript],
      env: { API_KEY: 'val"1\\2\ncafé' }
    })

    const codexArgs = store.argsFor('codex')
    expect(codexArgs).toEqual([
      '-c',
      `mcp_servers.both-tools.command=${tomlString(process.execPath)}`,
      '-c',
      `mcp_servers.both-tools.args=${tomlStringArray([fakeMcpScript])}`,
      '-c',
      `mcp_servers.both-tools.env={ API_KEY = "val\\"1\\\\2\\ncafé" }`,
      '-c',
      `mcp_servers.codex-only.command=${tomlString(process.execPath)}`,
      '-c',
      `mcp_servers.codex-only.args=${tomlStringArray([fakeMcpScript, '--noisy'])}`
    ])
  })
})
