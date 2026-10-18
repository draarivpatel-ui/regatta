// Regatta's MCP server over Streamable HTTP on 127.0.0.1, protected by a per-install token.
// Speaks the per-request protocol (2026-07-28) and the older initialize handshake (2025-11-25 and
// earlier).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { McpState } from '../../shared/mcp'
import { DEFAULT_MCP_PORT } from '../../shared/mcp'
import { cutText, type McpTool } from './tools'

/** The only path the server answers on. */
const MCP_PATH = '/mcp'
/** Largest request body accepted: 1 MB of JSON. */
const MAX_BODY = 1024 * 1024
/** The one modern protocol version this build speaks. */
export const MCP_PROTOCOL_VERSION = '2026-07-28'
/** Versions named when a client asks for one this build does not speak. */
const KNOWN_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']
/** Versions the older handshake answers with, when the client asked for one of them. */
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const INSTRUCTIONS =
  'Regatta runs many coding agents side by side on this computer; these tools show the project, the running agents, a pane output, the crew, project search and heats.'

interface StoredMcp {
  enabled: boolean
  port: number
  token: string
}

export interface McpBridgeDeps {
  /** App data folder: <dataDir>/mcp.json keeps enabled, port and token. */
  dataDir: string
  tools: () => McpTool[]
  /** Regatta's version, reported to clients. */
  version: string
  emit: (state: McpState) => void
  /**
   * Test hook: the port to listen on instead of the saved one (0 picks a free port). An explicit
   * setPort() from the user wins over it.
   */
  portOverride?: number
}

function makeToken(): string {
  return `rgt_${randomBytes(32).toString('base64url')}`
}

/** "rgt_..........Ab3x": the shape of the token with everything but its last four characters hidden. */
function tokenHint(token: string): string {
  return token.length <= 8 ? 'rgt_....' : `rgt_${'.'.repeat(10)}${token.slice(-4)}`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function headerValue(value: string | string[] | undefined): string {
  if (value === undefined) return ''
  return Array.isArray(value) ? (value[0] ?? '') : value
}

/** Header values may be written as =?base64?...?=; clients that avoid plain text use that form. */
function decodeHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  const raw = headerValue(value)
  const match = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(raw)
  if (!match) return raw
  try {
    return Buffer.from(match[1] ?? '', 'base64').toString('utf8')
  } catch {
    return raw
  }
}

/** The protocol version a modern request carries in its params, or null for an older one. */
function metaVersion(params: Record<string, unknown>): string | null {
  const meta = params._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const version = (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion']
  return typeof version === 'string' ? version : null
}

/** True when the port is taken by something else, which is the case the user can fix. */
function busy(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EADDRINUSE' || code === 'EACCES'
}

interface SchemaProperty {
  type?: string
  minimum?: number
  maximum?: number
}

/**
 * Checks arguments against the tool's own JSON Schema: required fields, top level types, and the
 * range of numbers. Returns what is wrong, or null when the arguments fit.
 */
function checkSchema(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const properties = (schema.properties ?? {}) as Record<string, SchemaProperty>
  const required = (schema.required ?? []) as string[]
  for (const key of required) {
    if (!(key in args)) return `missing "${key}"`
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key]
    if (!property) {
      if (schema.additionalProperties === false) return `unknown argument "${key}"`
      continue
    }
    const want = property.type ?? 'string'
    if (want === 'integer' || want === 'number') {
      if (typeof value !== 'number' || (want === 'integer' && !Number.isInteger(value))) {
        return `"${key}" must be ${want === 'integer' ? 'a whole number' : 'a number'}`
      }
      if (property.minimum !== undefined && value < property.minimum) {
        return `"${key}" must be ${property.minimum} or more`
      }
      if (property.maximum !== undefined && value > property.maximum) {
        return `"${key}" must be ${property.maximum} or less`
      }
      continue
    }
    const actual = Array.isArray(value) ? 'array' : typeof value
    if (actual !== want) return `"${key}" must be ${want === 'string' ? 'text' : want}`
  }
  return null
}

export class McpBridge {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly file: string
  private data: StoredMcp = { enabled: false, port: DEFAULT_MCP_PORT, token: '' }
  /** The port in use: the saved one, or the one the socket really got. */
  private port = DEFAULT_MCP_PORT
  private override: number | undefined
  private error: string | null = null

  constructor(private readonly deps: McpBridgeDeps) {
    this.file = join(deps.dataDir, 'mcp.json')
    this.override = deps.portOverride
  }

  /** Starts listening if the saved settings say it is on. Called once at app start. */
  async init(): Promise<void> {
    this.load()
    if (this.data.enabled) await this.start()
    this.deps.emit(this.state())
  }

  state(): McpState {
    return {
      enabled: this.data.enabled,
      running: this.server !== null,
      port: this.port,
      url: this.server ? `http://127.0.0.1:${this.port}${MCP_PATH}` : null,
      tokenHint: tokenHint(this.data.token),
      error: this.error,
      tools: this.deps.tools().map(({ name, title, description }) => ({ name, title, description }))
    }
  }

  async setEnabled(on: boolean): Promise<McpState> {
    this.data.enabled = on
    if (on) {
      await this.start()
    } else {
      this.stopServer()
      this.error = null
    }
    this.save()
    return this.publish()
  }

  async setPort(port: number): Promise<McpState> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('Use a whole number between 1024 and 65535.')
    }
    const wasRunning = this.server !== null
    this.stopServer()
    this.data.port = port
    this.override = undefined
    this.port = port
    this.save()
    if (wasRunning) await this.start()
    return this.publish()
  }

  /** The full token, for the Copy and Show buttons. */
  token(): string {
    return this.data.token
  }

  async regenerate(): Promise<McpState> {
    this.data.token = makeToken()
    this.save()
    return this.publish()
  }

  async stop(): Promise<void> {
    this.stopServer()
  }

  // Settings file

  private load(): void {
    let stored: Partial<StoredMcp> | null = null
    try {
      stored = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredMcp>
    } catch {
      stored = null
    }
    const token = typeof stored?.token === 'string' && stored.token.length > 8 ? stored.token : makeToken()
    const port =
      typeof stored?.port === 'number' && Number.isInteger(stored.port) && stored.port >= 1024 && stored.port <= 65535
        ? stored.port
        : DEFAULT_MCP_PORT
    this.data = { enabled: stored?.enabled === true, port, token }
    if (!stored) this.save()
  }

  /** Written through a temporary file so a crash never leaves half a file behind, and only we can read it. */
  private save(): void {
    const tmp = `${this.file}.tmp`
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }

  private publish(): McpState {
    const state = this.state()
    this.deps.emit(state)
    return state
  }

  // Server

  private listenPort(): number {
    return this.override ?? this.data.port
  }

  private async start(): Promise<void> {
    if (this.server) return
    const wanted = this.listenPort()
    const server = createServer((req, res) => {
      this.handle(req, res)
    })
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    let settled = false
    await new Promise<void>((resolve, reject) => {
      server.on('error', (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      })
      server.listen(wanted, '127.0.0.1', () => {
        settled = true
        resolve()
      })
    })
      .then(() => {
        const address = server.address()
        this.port = typeof address === 'object' && address ? address.port : wanted
        this.server = server
        this.error = null
      })
      .catch((err: unknown) => {
        server.close()
        this.port = wanted
        this.error = busy(err)
          ? `Port ${wanted} is in use. Pick another port.`
          : `The MCP server could not start: ${errorText(err)}`
      })
  }

  private stopServer(): void {
    const server = this.server
    this.server = null
    this.port = this.data.port
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    server?.close()
  }

  // Requests

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== MCP_PATH) {
      this.plain(res, 404, { error: 'Not found' })
      return
    }
    if (req.method !== 'POST') {
      this.plain(res, 405, { error: 'Use POST' }, { Allow: 'POST' })
      return
    }
    // Only this machine, on this port. No CORS headers ever go out.
    const host = headerValue(req.headers.host)
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      this.plain(res, 403, { error: 'Forbidden' })
      return
    }
    const origin = headerValue(req.headers.origin)
    if (origin && origin !== `http://127.0.0.1:${this.port}` && origin !== `http://localhost:${this.port}`) {
      this.plain(res, 403, { error: 'Forbidden' })
      return
    }
    const given = Buffer.from(headerValue(req.headers.authorization))
    const wanted = Buffer.from(`Bearer ${this.data.token}`)
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      this.plain(res, 401, { error: 'Bad token' }, { 'WWW-Authenticate': 'Bearer' })
      return
    }
    let body = ''
    let size = 0
    let answered = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (answered) return
      size += Buffer.byteLength(chunk)
      if (size > MAX_BODY) {
        answered = true
        this.plain(res, 413, { error: 'Request body too large' })
        req.resume()
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (!answered) this.dispatch(req, res, body)
    })
    req.on('error', () => {
      answered = true
    })
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      this.errorResult(res, 400, null, { code: -32700, message: 'Parse error' })
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.errorResult(res, 400, null, { code: -32600, message: 'Invalid Request' })
      return
    }
    const message = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      this.errorResult(res, 400, null, { code: -32600, message: 'Invalid Request' })
      return
    }
    // A message with no id is a notification: there is nothing to answer.
    if (!('id' in message)) {
      res.writeHead(202).end()
      return
    }
    const id = (message.id ?? null) as string | number | null
    const params = (
      message.params && typeof message.params === 'object' && !Array.isArray(message.params)
        ? message.params
        : {}
    ) as Record<string, unknown>
    const version = metaVersion(params)
    if (version !== null) await this.modern(req, res, id, message.method, params, version)
    else await this.legacy(res, id, message.method, params)
  }

  /** The per-request protocol: each message carries its version, method and tool name as headers too. */
  private async modern(
    req: IncomingMessage,
    res: ServerResponse,
    id: string | number | null,
    method: string,
    params: Record<string, unknown>,
    version: string
  ): Promise<void> {
    if (version !== MCP_PROTOCOL_VERSION) {
      this.errorResult(res, 400, id, {
        code: -32022,
        message: 'Unsupported protocol version',
        data: { supported: KNOWN_VERSIONS, requested: version }
      })
      return
    }
    if (!this.headerMatches(res, id, 'MCP-Protocol-Version', decodeHeader(req.headers['mcp-protocol-version']), version)) {
      return
    }
    if (!this.headerMatches(res, id, 'Mcp-Method', decodeHeader(req.headers['mcp-method']), method)) return
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!this.headerMatches(res, id, 'Mcp-Name', decodeHeader(req.headers['mcp-name']), name)) return
    }
    switch (method) {
      case 'server/discover':
        this.result(res, id, {
          supportedVersions: [MCP_PROTOCOL_VERSION],
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'regatta', version: this.deps.version } },
          instructions: INSTRUCTIONS,
          resultType: 'complete'
        })
        return
      case 'tools/list':
        this.result(res, id, { tools: this.listTools(), resultType: 'complete' })
        return
      case 'tools/call':
        await this.callTool(res, id, params, true)
        return
      case 'ping':
        this.result(res, id, { resultType: 'complete' })
        return
      default:
        this.errorResult(res, 404, id, { code: -32601, message: `Method not found: ${method}` })
    }
  }

  /** The older handshake: initialize first, then tools, with no per-request version or headers. */
  private async legacy(
    res: ServerResponse,
    id: string | number | null,
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        this.result(res, id, {
          protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'regatta', title: 'Regatta', version: this.deps.version },
          instructions: INSTRUCTIONS
        })
        return
      }
      case 'tools/list':
        this.result(res, id, { tools: this.listTools() })
        return
      case 'tools/call':
        await this.callTool(res, id, params, false)
        return
      case 'ping':
        this.result(res, id, {})
        return
      default:
        this.errorResult(res, 200, id, { code: -32601, message: `Method not found: ${method}` })
    }
  }

  private async callTool(
    res: ServerResponse,
    id: string | number | null,
    params: Record<string, unknown>,
    modern: boolean
  ): Promise<void> {
    const name = typeof params.name === 'string' ? params.name : ''
    const tool = name === '' ? undefined : this.deps.tools().find((t) => t.name === name)
    if (!tool) {
      this.errorResult(res, 200, id, { code: -32602, message: `Unknown tool: ${name || '(none given)'}` })
      return
    }
    const given = params.arguments === undefined ? {} : params.arguments
    if (!given || typeof given !== 'object' || Array.isArray(given)) {
      this.errorResult(res, 200, id, { code: -32602, message: `Bad arguments for ${name}: they must be an object.` })
      return
    }
    const problem = checkSchema(tool.inputSchema, given as Record<string, unknown>)
    if (problem) {
      this.errorResult(res, 200, id, { code: -32602, message: `Bad arguments for ${name}: ${problem}` })
      return
    }
    let result
    try {
      result = await tool.run(given as Record<string, unknown>)
    } catch (err) {
      result = { text: `The tool did not finish: ${errorText(err)}`, isError: true }
    }
    const payload: Record<string, unknown> = { content: [{ type: 'text', text: cutText(result.text) }] }
    if (result.data !== undefined) payload.structuredContent = result.data
    if (result.isError) payload.isError = true
    if (modern) payload.resultType = 'complete'
    this.result(res, id, payload)
  }

  private listTools(): { name: string; title: string; description: string; inputSchema: Record<string, unknown> }[] {
    return this.deps.tools().map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }))
  }

  private headerMatches(
    res: ServerResponse,
    id: string | number | null,
    header: string,
    got: string | null,
    want: string
  ): boolean {
    if (got === null) {
      this.errorResult(res, 400, id, { code: -32020, message: `Header mismatch: ${header} is missing` })
      return false
    }
    if (got !== want) {
      this.errorResult(res, 400, id, { code: -32020, message: `Header mismatch: ${header} says ${got}, the body says ${want}` })
      return false
    }
    return true
  }

  private result(res: ServerResponse, id: string | number | null, result: unknown): void {
    this.plain(res, 200, { jsonrpc: '2.0', id, result })
  }

  private errorResult(
    res: ServerResponse,
    status: number,
    id: string | number | null,
    error: { code: number; message: string; data?: unknown }
  ): void {
    this.plain(res, status, { jsonrpc: '2.0', id, error })
  }

  private plain(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(text)),
      ...headers
    })
    res.end(text)
  }
}