// Unit tests for McpBridge: the local HTTP server, its token and port, and both protocol handshakes.

import { request as httpRequest } from 'node:http'
import { createServer, type Server } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { McpBridge, MCP_PROTOCOL_VERSION } from './bridge'
import type { McpTool } from './tools'
import type { McpState } from '../../shared/mcp'

const VERSION = '9.9.9'

const fakeTools: McpTool[] = [
  {
    name: 'regatta_project',
    title: 'Project',
    description: 'The open project.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ text: 'Project: regatta', data: { name: 'regatta' } })
  },
  {
    name: 'regatta_read_pane',
    title: 'Read a pane',
    description: 'The output of one pane.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, lines: { type: 'integer', minimum: 1, maximum: 200 } },
      required: ['id'],
      additionalProperties: false
    },
    run: async (args) => ({ text: `pane ${String(args.id)} last ${String(args.lines ?? 60)} lines` })
  },
  {
    name: 'regatta_boom',
    title: 'Boom',
    description: 'A tool that always fails.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      throw new Error('the search engine died')
    }
  },
  {
    name: 'regatta_huge',
    title: 'Huge',
    description: 'A tool that says far too much.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ text: 'x'.repeat(21_000) })
  }
]

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  json: { jsonrpc?: string; id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string; data?: Record<string, unknown> } }
}

const tempDirs: string[] = []
const bridges: McpBridge[] = []
const blockers: Server[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-mcp-'))
  tempDirs.push(dir)
  return dir
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/** A bridge on a free port, off until the test turns it on. */
async function makeBridge(opts: { portOverride?: number; dir?: string } = {}): Promise<{ bridge: McpBridge; port: number; dir: string; events: McpState[] }> {
  const dir = opts.dir ?? tempDir()
  const events: McpState[] = []
  const bridge = new McpBridge({
    dataDir: dir,
    tools: () => fakeTools,
    version: VERSION,
    emit: (state) => events.push(state),
    ...(opts.portOverride === undefined ? {} : { portOverride: opts.portOverride })
  })
  bridges.push(bridge)
  await bridge.init()
  return { bridge, port: bridge.state().port, dir, events }
}

function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/mcp',
        method: options.method ?? 'POST',
        // A fresh connection each time: the bridge closes sockets on stop, and a pooled one would be stale.
        agent: false,
        headers: options.headers ?? {}
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          let json: Reply['json'] = {}
          try {
            json = body ? (JSON.parse(body) as Reply['json']) : {}
          } catch {
            json = {}
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json })
        })
      }
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

function legacyMessage(method: string, params?: Record<string, unknown>, id: number | string = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
}

function modernMessage(method: string, params: Record<string, unknown> = {}, id: number | string = 1): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION }, ...params }
  })
}

function modernHeaders(method: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    'mcp-method': method,
    ...extra
  }
}

/** Starts a bridge with the server on and returns a helper that always sends the right token. */
async function running(opts: { dir?: string; portOverride?: number } = {}): Promise<{
  bridge: McpBridge
  port: number
  token: string
  dir: string
  events: McpState[]
  call: (body: string, headers?: Record<string, string>) => Promise<Reply>
}> {
  const made = await makeBridge(opts)
  const state = await made.bridge.setEnabled(true)
  const token = made.bridge.token()
  const port = state.port
  return {
    ...made,
    port,
    token,
    call: (body, headers = {}) =>
      send(port, { headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body })
  }
}

afterEach(async () => {
  while (bridges.length > 0) await bridges.pop()?.stop()
  while (blockers.length > 0) await new Promise<void>((done) => blockers.pop()?.close(() => done()))
})

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('mcp bridge: the older handshake', () => {
  it('answers initialize with the version the client asked for', async () => {
    const { call } = await running()
    const reply = await call(legacyMessage('initialize', { protocolVersion: '2025-06-18' }))
    expect(reply.status).toBe(200)
    expect(reply.json.id).toBe(1)
    expect(reply.json.result?.protocolVersion).toBe('2025-06-18')
    expect(reply.json.result?.capabilities).toEqual({ tools: { listChanged: false } })
    expect(reply.json.result?.serverInfo).toEqual({ name: 'regatta', title: 'Regatta', version: VERSION })
    expect(String(reply.json.result?.instructions ?? '').length).toBeGreaterThan(10)
  })

  it('falls back to 2025-11-25 for a version it does not know', async () => {
    const { call } = await running()
    const reply = await call(legacyMessage('initialize', { protocolVersion: '1999-01-01' }))
    expect(reply.json.result?.protocolVersion).toBe('2025-11-25')
  })

  it('lists the tools with no resultType', async () => {
    const { call } = await running()
    const reply = await call(legacyMessage('tools/list'))
    const tools = reply.json.result?.tools as { name: string; description: string; inputSchema: unknown }[]
    expect(tools.map((t) => t.name)).toContain('regatta_project')
    expect(tools[0]?.description.length).toBeGreaterThan(10)
    expect(reply.json.result?.resultType).toBeUndefined()
  })

  it('calls a tool', async () => {
    const { call } = await running()
    const reply = await call(legacyMessage('tools/call', { name: 'regatta_read_pane', arguments: { id: 'p1', lines: 12 } }))
    expect(reply.json.result?.content).toEqual([{ type: 'text', text: 'pane p1 last 12 lines' }])
    expect(reply.json.result?.resultType).toBeUndefined()
  })

  it('answers an unknown method with -32601', async () => {
    const { call } = await running()
    const reply = await call(legacyMessage('resources/list'))
    expect(reply.status).toBe(200)
    expect(reply.json.error?.code).toBe(-32601)
  })
})

describe('mcp bridge: the per-request protocol', () => {
  it('answers server/discover', async () => {
    const { call } = await running()
    const reply = await call(modernMessage('server/discover'), modernHeaders('server/discover'))
    expect(reply.status).toBe(200)
    expect(reply.json.result?.supportedVersions).toEqual([MCP_PROTOCOL_VERSION])
    expect(reply.json.result?.capabilities).toEqual({ tools: {} })
    expect(reply.json.result?.resultType).toBe('complete')
    const meta = reply.json.result?._meta as Record<string, { name: string; version: string }>
    expect(meta['io.modelcontextprotocol/serverInfo']).toEqual({ name: 'regatta', version: VERSION })
  })

  it('answers tools/list and ping', async () => {
    const { call } = await running()
    const list = await call(modernMessage('tools/list'), modernHeaders('tools/list'))
    const tools = list.json.result?.tools as { name: string }[]
    expect(tools.some((t) => t.name === 'regatta_read_pane')).toBe(true)
    expect(list.json.result?.resultType).toBe('complete')
    const ping = await call(modernMessage('ping'), modernHeaders('ping'))
    expect(ping.json.result?.resultType).toBe('complete')
  })

  it('calls a tool when the headers agree with the body', async () => {
    const { call } = await running()
    const body = modernMessage('tools/call', { name: 'regatta_read_pane', arguments: { id: 'p2' } })
    const reply = await call(body, modernHeaders('tools/call', { 'mcp-name': 'regatta_read_pane' }))
    expect(reply.json.result?.content).toEqual([{ type: 'text', text: 'pane p2 last 60 lines' }])
    expect(reply.json.result?.structuredContent).toBeUndefined()
    expect(reply.json.result?.resultType).toBe('complete')
  })

  it('keeps the structured data a tool returned', async () => {
    const { call } = await running()
    const reply = await call(modernMessage('tools/call', { name: 'regatta_project' }), modernHeaders('tools/call', { 'mcp-name': 'regatta_project' }))
    expect(reply.json.result?.structuredContent).toEqual({ name: 'regatta' })
  })

  it('refuses a header that disagrees with the body', async () => {
    const { call } = await running()
    const body = modernMessage('tools/call', { name: 'regatta_project' })
    const reply = await call(body, modernHeaders('tools/list', { 'mcp-name': 'regatta_project' }))
    expect(reply.status).toBe(400)
    expect(reply.json.error?.code).toBe(-32020)
    expect(reply.json.error?.message).toContain('Mcp-Method')
  })

  it('refuses a missing header', async () => {
    const { call, port, token } = await running()
    const reply = await send(port, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'mcp-method': 'tools/list' },
      body: modernMessage('tools/list')
    })
    expect(reply.status).toBe(400)
    expect(reply.json.error?.code).toBe(-32020)
    expect(reply.json.error?.message).toContain('MCP-Protocol-Version')
  })

  it('refuses a tool name that does not match', async () => {
    const { call } = await running()
    const body = modernMessage('tools/call', { name: 'regatta_project' })
    const reply = await call(body, modernHeaders('tools/call', { 'mcp-name': 'regatta_read_pane' }))
    expect(reply.json.error?.code).toBe(-32020)
    expect(reply.json.error?.message).toContain('Mcp-Name')
  })

  it('reads a header written as base64', async () => {
    const { call } = await running()
    const body = modernMessage('tools/call', { name: 'regatta_project' })
    const encoded = `=?base64?${Buffer.from('regatta_project').toString('base64')}?=`
    const reply = await call(body, modernHeaders('tools/call', { 'mcp-name': encoded }))
    expect(reply.status).toBe(200)
    expect(reply.json.result?.content).toEqual([{ type: 'text', text: 'Project: regatta' }])
  })

  it('names the versions it does speak', async () => {
    const { call } = await running()
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } }
    })
    const reply = await call(body, { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/list' })
    expect(reply.status).toBe(400)
    expect(reply.json.error?.code).toBe(-32022)
    expect(reply.json.error?.message).toBe('Unsupported protocol version')
    expect(reply.json.error?.data).toEqual({
      supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
      requested: '2025-11-25'
    })
  })

  it('answers an unknown modern method with 404', async () => {
    const { call } = await running()
    const reply = await call(modernMessage('resources/list'), modernHeaders('resources/list'))
    expect(reply.status).toBe(404)
    expect(reply.json.error?.code).toBe(-32601)
  })

  it('takes a notification and answers nothing', async () => {
    const { call } = await running()
    const reply = await call(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(reply.status).toBe(202)
    expect(reply.body).toBe('')
  })
})

describe('mcp bridge: refusing the wrong caller', () => {
  it('answers GET with 405 and Allow: POST', async () => {
    const { port } = await running()
    const reply = await send(port, { method: 'GET', path: '/mcp' })
    expect(reply.status).toBe(405)
    expect(reply.headers.allow).toBe('POST')
  })

  it('answers another path with 404', async () => {
    const { port } = await running()
    expect((await send(port, { path: '/other' })).status).toBe(404)
    expect((await send(port, { path: '/' })).status).toBe(404)
  })

  it('refuses a request with no token or the wrong one', async () => {
    const { port, token } = await running()
    const none = await send(port, { body: legacyMessage('tools/list') })
    expect(none.status).toBe(401)
    expect(none.headers['www-authenticate']).toBe('Bearer')
    const wrong = await send(port, { headers: { authorization: `Bearer ${token}x` }, body: legacyMessage('tools/list') })
    expect(wrong.status).toBe(401)
  })

  it('refuses an Origin or Host from somewhere else', async () => {
    const { port, token } = await running()
    const body = legacyMessage('tools/list')
    const foreignOrigin = await send(port, {
      headers: { authorization: `Bearer ${token}`, origin: 'http://evil.example' },
      body
    })
    expect(foreignOrigin.status).toBe(403)
    expect(foreignOrigin.headers['access-control-allow-origin']).toBeUndefined()
    const foreignHost = await send(port, {
      headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port + 1}` },
      body
    })
    expect(foreignHost.status).toBe(403)
  })

  it('accepts localhost as the caller', async () => {
    const { token, port } = await running()
    const reply = await send(port, {
      headers: { authorization: `Bearer ${token}`, origin: `http://localhost:${port}`, host: `localhost:${port}` },
      body: legacyMessage('ping')
    })
    expect(reply.status).toBe(200)
  })
})

describe('mcp bridge: bad requests', () => {
  it('rejects broken JSON with a parse error', async () => {
    const { call } = await running()
    const reply = await call('{"jsonrpc": "2.0",')
    expect(reply.status).toBe(400)
    expect(reply.json.id).toBeNull()
    expect(reply.json.error).toEqual({ code: -32700, message: 'Parse error' })
  })

  it('rejects a batch and a message with no method', async () => {
    const { call } = await running()
    expect((await call(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))).json.error?.code).toBe(-32600)
    expect((await call(JSON.stringify({ jsonrpc: '2.0', id: 2 }))).json.error?.code).toBe(-32600)
    expect((await call(JSON.stringify({ jsonrpc: '1.0', id: 3, method: 'ping' }))).json.error?.code).toBe(-32600)
  })

  it('rejects a body over 1 MB', async () => {
    const { call } = await running()
    const reply = await call(legacyMessage('tools/call', { name: 'regatta_read_pane', arguments: { id: 'x'.repeat(1_100_000) } }))
    expect(reply.status).toBe(413)
  })

  it('refuses an unknown tool or arguments that do not fit', async () => {
    const { call } = await running()
    const unknown = await call(legacyMessage('tools/call', { name: 'regatta_nope' }))
    expect(unknown.json.error?.code).toBe(-32602)
    const missing = await call(legacyMessage('tools/call', { name: 'regatta_read_pane', arguments: {} }))
    expect(missing.json.error?.code).toBe(-32602)
    expect(missing.json.error?.message).toContain('id')
    const wrongType = await call(legacyMessage('tools/call', { name: 'regatta_read_pane', arguments: { id: 7 } }))
    expect(wrongType.json.error?.code).toBe(-32602)
    const tooMany = await call(legacyMessage('tools/call', { name: 'regatta_read_pane', arguments: { id: 'p1', lines: 900 } }))
    expect(tooMany.json.error?.code).toBe(-32602)
    const unknownKey = await call(legacyMessage('tools/call', { name: 'regatta_read_pane', arguments: { id: 'p1', deep: true } }))
    expect(unknownKey.json.error?.code).toBe(-32602)
  })

  it('reports a tool that failed as an error result, and cuts very long text', async () => {
    const { call } = await running()
    const failed = await call(legacyMessage('tools/call', { name: 'regatta_boom' }))
    expect(failed.status).toBe(200)
    expect(failed.json.result?.isError).toBe(true)
    expect(String((failed.json.result?.content as { text: string }[])[0]?.text)).toContain('the search engine died')
    const huge = await call(legacyMessage('tools/call', { name: 'regatta_huge' }))
    const text = String((huge.json.result?.content as { text: string }[])[0]?.text)
    expect(text.length).toBeLessThan(21_000)
    expect(text.endsWith('... (cut)')).toBe(true)
  })
})

describe('mcp bridge: settings, token and lifecycle', () => {
  it('starts off, then listens when the user turns it on', async () => {
    const { bridge } = await makeBridge({ portOverride: 0 })
    expect(bridge.state().enabled).toBe(false)
    expect(bridge.state().running).toBe(false)
    expect(bridge.state().url).toBeNull()
    const state = await bridge.setEnabled(true)
    expect(state.enabled).toBe(true)
    expect(state.running).toBe(true)
    expect(state.port).toBeGreaterThan(1024)
    expect(state.url).toBe(`http://127.0.0.1:${state.port}/mcp`)
    expect(state.error).toBeNull()
  })

  it('hides the token but keeps the last four characters', async () => {
    const { bridge } = await makeBridge()
    const token = bridge.token()
    expect(token.startsWith('rgt_')).toBe(true)
    expect(token.length).toBeGreaterThan(40)
    const hint = bridge.state().tokenHint
    expect(hint.startsWith('rgt_')).toBe(true)
    expect(hint.endsWith(token.slice(-4))).toBe(true)
    expect(hint).not.toContain(token.slice(4, 12))
  })

  it('lists the tools in its state', async () => {
    const { bridge } = await makeBridge()
    expect(bridge.state().tools.map((t) => t.name)).toContain('regatta_project')
    expect(bridge.state().tools[0]?.description).toBeTruthy()
  })

  it('moves to another port and keeps answering there', async () => {
    const { bridge, port, token } = await running()
    const next = await freePort()
    const state = await bridge.setPort(next)
    expect(state.port).toBe(next)
    expect(state.running).toBe(true)
    expect(state.url).toBe(`http://127.0.0.1:${next}/mcp`)
    const reply = await send(next, {
      headers: { authorization: `Bearer ${token}` },
      body: legacyMessage('ping')
    })
    expect(reply.status).toBe(200)
    await expect(send(port, { headers: { authorization: `Bearer ${token}` }, body: legacyMessage('ping') })).rejects.toThrow()
  })

  it('refuses a port that is not a whole number in range', async () => {
    const { bridge } = await makeBridge()
    await expect(bridge.setPort(80)).rejects.toThrow()
    await expect(bridge.setPort(70000)).rejects.toThrow()
    await expect(bridge.setPort(47821.5)).rejects.toThrow()
  })

  it('stops the old token working the moment a new one is made', async () => {
    const { bridge, port } = await running()
    const old = bridge.token()
    const state = await bridge.regenerate()
    expect(state.tokenHint.endsWith(bridge.token().slice(-4))).toBe(true)
    expect(bridge.token()).not.toBe(old)
    const refused = await send(port, { headers: { authorization: `Bearer ${old}` }, body: legacyMessage('ping') })
    expect(refused.status).toBe(401)
    const allowed = await send(port, { headers: { authorization: `Bearer ${bridge.token()}` }, body: legacyMessage('ping') })
    expect(allowed.status).toBe(200)
  })

  it('says so when the port is taken', async () => {
    const blocker = createServer()
    blockers.push(blocker)
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        const address = blocker.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    const { bridge } = await makeBridge()
    await bridge.setPort(port)
    const state = await bridge.setEnabled(true)
    expect(state.enabled).toBe(true)
    expect(state.running).toBe(false)
    expect(state.url).toBeNull()
    expect(state.error).toBe(`Port ${port} is in use. Pick another port.`)
  })

  it('closes the server when stopped', async () => {
    const { bridge, port, token } = await running()
    await bridge.stop()
    expect(bridge.state().running).toBe(false)
    await expect(send(port, { headers: { authorization: `Bearer ${token}` }, body: legacyMessage('ping') })).rejects.toThrow()
  })

  it('keeps the settings in <dataDir>/mcp.json, only readable by the user', async () => {
    const dir = tempDir()
    const port = await freePort()
    const { bridge } = await makeBridge({ dir })
    await bridge.setPort(port)
    await bridge.setEnabled(true)
    const file = join(dir, 'mcp.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ enabled: true, port, token: bridge.token() })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('starts again from what it saved', async () => {
    const dir = tempDir()
    const port = await freePort()
    const first = await makeBridge({ dir })
    await first.bridge.setPort(port)
    await first.bridge.setEnabled(true)
    const token = first.bridge.token()
    await first.bridge.stop()

    const events: McpState[] = []
    const second = new McpBridge({
      dataDir: dir,
      tools: () => fakeTools,
      version: VERSION,
      emit: (state) => events.push(state)
    })
    bridges.push(second)
    await second.init()
    const state = second.state()
    expect(state.enabled).toBe(true)
    expect(state.running).toBe(true)
    expect(state.port).toBe(port)
    expect(second.token()).toBe(token)
    expect(events.length).toBeGreaterThan(0)
    const reply = await send(port, { headers: { authorization: `Bearer ${token}` }, body: legacyMessage('ping') })
    expect(reply.status).toBe(200)
  })

  it('emits the state after every change', async () => {
    const { bridge, events } = await makeBridge({ portOverride: 0 })
    await bridge.setEnabled(true)
    await bridge.setPort(await freePort())
    await bridge.regenerate()
    await bridge.setEnabled(false)
    expect(events.map((e) => `${e.enabled}:${e.running}`)).toEqual([
      'false:false',
      'true:true',
      'true:true',
      'true:true',
      'false:false'
    ])
  })
})