// MCP servers the user trusts, verified once and then given to Claude Code and Codex.

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import {
  AGENT_TOOL_AGENTS,
  type AgentToolAgent,
  type AgentToolDraft,
  type AgentToolInfo,
  type AgentToolServer,
  type AgentToolVerification,
  type AgentToolVerifyResult
} from '../shared/agent-tools'
import type { AgentKind } from '../shared/types'
import { findOnPath } from './env'

const VERIFY_TIMEOUT_MS = 20_000
const KILL_GRACE_MS = 2_000
const MAX_TOOL_PAGES = 10
const MAX_DESCRIPTION_CHARS = 300
const MAX_STDERR_LINES = 40
const ID_PATTERN = /^[a-z0-9-]{1,40}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface AgentToolDeps {
  /** App data folder: <dataDir>/agent-tools.json keeps the servers. */
  dataDir: string
  /** The shell environment, for finding the command and running it. */
  env: () => Record<string, string>
  /** The project folder a verification runs in. */
  root: () => string
  /** Regatta's version, reported to the server while verifying. */
  version: string
  emit: (list: AgentToolServer[]) => void
  /** Optional timeout override in ms for verify(), used by unit tests. Defaults to 20,000. */
  verifyTimeoutMs?: number
  /** Optional SIGTERM-to-SIGKILL grace period in ms, used by unit tests. Defaults to 2,000. */
  killGraceMs?: number
}

/** Computes sha256 of JSON.stringify([command, args, sorted env entries]). */
export function computeFingerprint(command: string, args: string[], env: Record<string, string>): string {
  const sortedEnv = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256')
    .update(JSON.stringify([command, args, sortedEnv]))
    .digest('hex')
}

/** Formats a string as a TOML basic string with full escaping. */
export function tomlString(value: string): string {
  let out = '"'
  for (const ch of value) {
    const code = ch.codePointAt(0)!
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\b') out += '\\b'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\f') out += '\\f'
    else if (ch === '\r') out += '\\r'
    else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else {
      out += ch
    }
  }
  out += '"'
  return out
}

/** Formats an array of strings as a TOML array of basic strings. */
export function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}

/** Formats an environment record as a TOML inline table. */
export function tomlInlineTable(env: Record<string, string>): string {
  const entries = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (entries.length === 0) return '{}'
  const parts = entries.map(([k, v]) => {
    const key = /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)
    return `${key} = ${tomlString(v)}`
  })
  return `{ ${parts.join(', ')} }`
}

function writeAtomic0600(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, filePath)
  chmodSync(filePath, 0o600)
}

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function stopProcessGroup(pgid: number | undefined, graceMs: number): Promise<void> {
  if (!pgid || process.platform === 'win32') return
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  if (isGroupAlive(pgid)) {
    try {
      process.kill(-pgid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }

  const termDeadline = Date.now() + graceMs
  while (Date.now() < termDeadline) {
    if (!isGroupAlive(pgid)) return
    await sleep(20)
  }

  if (isGroupAlive(pgid)) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }

  const killDeadline = Date.now() + 5_000
  while (Date.now() < killDeadline) {
    if (!isGroupAlive(pgid)) return
    await sleep(20)
  }
}

function resolveExecutable(command: string, env: Record<string, string>): string {
  if (isAbsolute(command)) {
    try {
      accessSync(command, constants.X_OK)
      if (statSync(command).isFile()) return command
    } catch {
      throw new Error(`Command not found or not executable: ${command}`)
    }
    throw new Error(`Command is not a file: ${command}`)
  }
  if (command.includes('/') || command.includes('\\') || /\s/.test(command)) {
    throw new Error('Command must be an absolute path or a program name on PATH.')
  }
  const found = findOnPath(command, env)
  if (!found) {
    throw new Error(`Could not find "${command}" on PATH.`)
  }
  return found
}

function deriveId(name: string): string {
  if (ID_PATTERN.test(name)) return name
  if (!/^[A-Za-z0-9 -]{1,40}$/.test(name)) {
    throw new Error('Name may only use lowercase letters, digits, spaces and hyphens (1 to 40 characters).')
  }
  const slug = name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!ID_PATTERN.test(slug)) {
    throw new Error('Name may only use lowercase letters, digits, spaces and hyphens (1 to 40 characters).')
  }
  return slug
}

function cloneServer(server: AgentToolServer): AgentToolServer {
  return structuredClone(server)
}

export class AgentToolStore {
  private servers: AgentToolServer[] = []
  private readonly file: string
  private readonly claudeConfigFile: string
  private readonly activeStops = new Set<() => void>()

  constructor(private readonly deps: AgentToolDeps) {
    this.file = join(deps.dataDir, 'agent-tools.json')
    this.claudeConfigFile = join(deps.dataDir, 'agent-tools', 'claude.json')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) {
      this.servers = []
      return
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(parsed)) {
        this.servers = []
        return
      }
      const loaded: AgentToolServer[] = []
      for (const raw of parsed) {
        if (!raw || typeof raw !== 'object') continue
        const item = raw as Partial<AgentToolServer>
        if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) continue
        if (typeof item.name !== 'string' || typeof item.command !== 'string') continue
        const args = Array.isArray(item.args) ? item.args.filter((a): a is string => typeof a === 'string') : []
        const env: Record<string, string> = {}
        if (item.env && typeof item.env === 'object' && !Array.isArray(item.env)) {
          for (const [k, v] of Object.entries(item.env)) {
            if (ENV_NAME_PATTERN.test(k) && typeof v === 'string') env[k] = v
          }
        }
        const agents: AgentToolAgent[] = Array.isArray(item.agents)
          ? AGENT_TOOL_AGENTS.filter((a) => (item.agents as unknown[]).includes(a))
          : [...AGENT_TOOL_AGENTS]
        const fingerprint = computeFingerprint(item.command, args, env)
        const verified =
          item.verified &&
          typeof item.verified === 'object' &&
          typeof item.verified.fingerprint === 'string' &&
          typeof item.verified.at === 'number' &&
          typeof item.verified.protocolVersion === 'string' &&
          Array.isArray(item.verified.tools)
            ? {
                at: item.verified.at,
                fingerprint: item.verified.fingerprint,
                serverName: typeof item.verified.serverName === 'string' ? item.verified.serverName : null,
                serverVersion: typeof item.verified.serverVersion === 'string' ? item.verified.serverVersion : null,
                protocolVersion: item.verified.protocolVersion,
                tools: item.verified.tools
                  .filter((t): t is AgentToolInfo => Boolean(t && typeof t.name === 'string'))
                  .map((t) => ({
                    name: t.name,
                    description: typeof t.description === 'string' ? t.description.slice(0, MAX_DESCRIPTION_CHARS) : ''
                  }))
              }
            : null
        const validVerified = verified !== null && verified.fingerprint === fingerprint
        loaded.push({
          id: item.id,
          name: item.name,
          command: item.command,
          args,
          env,
          agents,
          enabled: Boolean(item.enabled) && validVerified,
          fingerprint,
          verified,
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now()
        })
      }
      this.servers = loaded
      this.writeClaudeConfig()
    } catch {
      this.servers = []
    }
  }

  private persist(): AgentToolServer[] {
    writeAtomic0600(this.file, `${JSON.stringify(this.servers, null, 2)}\n`)
    this.writeClaudeConfig()
    const list = this.list()
    this.deps.emit(list)
    return list
  }

  private activeServersFor(agent: AgentToolAgent): AgentToolServer[] {
    return this.servers.filter(
      (s) => s.enabled && s.verified !== null && s.verified.fingerprint === s.fingerprint && s.agents.includes(agent)
    )
  }

  private writeClaudeConfig(): void {
    const active = this.activeServersFor('claude')
    const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {}
    for (const server of active) {
      mcpServers[server.id] = {
        command: server.command,
        args: [...server.args],
        env: { ...server.env }
      }
    }
    writeAtomic0600(this.claudeConfigFile, `${JSON.stringify({ mcpServers }, null, 2)}\n`)
  }

  list(): AgentToolServer[] {
    return this.servers.map(cloneServer)
  }

  save(draft: AgentToolDraft): AgentToolServer[] {
    const rawName = (draft.name ?? '').trim()
    if (!rawName) throw new Error('Name is required.')
    if (rawName.length > 40) throw new Error('Name must be 40 characters or fewer.')

    const command = (draft.command ?? '').trim()
    if (!command) throw new Error('Command is required.')
    resolveExecutable(command, this.deps.env())

    if (!Array.isArray(draft.args) || !draft.args.every((a) => typeof a === 'string')) {
      throw new Error('Arguments must be a list of strings.')
    }
    const args = [...draft.args]

    if (!draft.env || typeof draft.env !== 'object' || Array.isArray(draft.env)) {
      throw new Error('Environment must be a key-value map.')
    }
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(draft.env)) {
      if (!ENV_NAME_PATTERN.test(k)) {
        throw new Error(`Invalid environment variable name "${k}".`)
      }
      if (typeof v !== 'string') {
        throw new Error(`Environment variable "${k}" must have a string value.`)
      }
      env[k] = v
    }

    const rawAgents = Array.isArray(draft.agents) ? draft.agents : [...AGENT_TOOL_AGENTS]
    for (const a of rawAgents) {
      if (!AGENT_TOOL_AGENTS.includes(a)) {
        throw new Error(`Unsupported agent "${String(a)}".`)
      }
    }
    const agents: AgentToolAgent[] = AGENT_TOOL_AGENTS.filter((a) => rawAgents.includes(a))

    const fingerprint = computeFingerprint(command, args, env)
    const now = Date.now()

    if (draft.id !== undefined) {
      if (!ID_PATTERN.test(draft.id)) {
        throw new Error('Server ID must be 1 to 40 lowercase letters, digits, or hyphens.')
      }
      const existing = this.servers.find((s) => s.id === draft.id)
      if (!existing) throw new Error('Server not found.')
      const duplicateName = this.servers.some(
        (s) => s.id !== existing.id && (s.name.toLowerCase() === rawName.toLowerCase() || s.id === rawName.toLowerCase())
      )
      if (duplicateName) throw new Error('A server with that name already exists.')

      const changed = existing.fingerprint !== fingerprint
      existing.name = rawName
      existing.command = command
      existing.args = args
      existing.env = env
      existing.agents = agents
      existing.fingerprint = fingerprint
      if (changed) {
        existing.verified = null
        existing.enabled = false
      } else if (!existing.verified || existing.verified.fingerprint !== fingerprint) {
        existing.enabled = false
      }
      existing.updatedAt = now
      return this.persist()
    }

    const id = deriveId(rawName)
    if (this.servers.some((s) => s.id === id || s.name.toLowerCase() === rawName.toLowerCase())) {
      throw new Error('A server with that name already exists.')
    }

    const created: AgentToolServer = {
      id,
      name: rawName,
      command,
      args,
      env,
      agents,
      enabled: false,
      fingerprint,
      verified: null,
      createdAt: now,
      updatedAt: now
    }
    this.servers.push(created)
    return this.persist()
  }

  remove(id: string): AgentToolServer[] {
    const idx = this.servers.findIndex((s) => s.id === id)
    if (idx === -1) throw new Error('Server not found.')
    this.servers.splice(idx, 1)
    return this.persist()
  }

  /** Runs the server once and lists its tools. */
  async verify(id: string): Promise<AgentToolVerifyResult> {
    const server = this.servers.find((s) => s.id === id)
    if (!server) {
      return { ok: false, error: 'Server not found.', stderr: '', server: null }
    }

    const startFingerprint = server.fingerprint
    let executable: string
    try {
      executable = resolveExecutable(server.command, this.deps.env())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      server.verified = null
      server.enabled = false
      server.updatedAt = Date.now()
      this.persist()
      return { ok: false, error: msg, stderr: '', server: cloneServer(server) }
    }

    const timeoutMs = this.deps.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS
    const graceMs = this.deps.killGraceMs ?? KILL_GRACE_MS
    const stderrLines: string[] = []
    let stderrRemainder = ''
    let stdoutRemainder = ''

    const child = spawn(executable, server.args, {
      env: { ...this.deps.env(), ...server.env },
      cwd: this.deps.root(),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const pgid = child.pid

    const pending = new Map<
      number,
      {
        resolve: (result: Record<string, unknown>) => void
        reject: (err: Error) => void
      }
    >()

    const failAllPending = (err: Error): void => {
      for (const [, waiter] of pending) waiter.reject(err)
      pending.clear()
    }

    const stopNow = (): void => {
      failAllPending(new Error('Verification cancelled.'))
      try {
        child.stdin?.end()
        child.stdin?.destroy()
      } catch {
        // ignore
      }
      if (pgid && process.platform !== 'win32') {
        try {
          process.kill(-pgid, 'SIGTERM')
        } catch {
          // ignore
        }
      }
    }
    this.activeStops.add(stopNow)

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrRemainder += chunk.toString('utf8')
      const parts = stderrRemainder.split('\n')
      stderrRemainder = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.replace(/\r$/, '')
        stderrLines.push(line)
        if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift()
      }
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutRemainder += chunk.toString('utf8')
      const parts = stdoutRemainder.split('\n')
      stdoutRemainder = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.replace(/\r$/, '').trim()
        if (!line) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          // Ignore non-JSON lines on stdout.
          continue
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        const msg = parsed as { id?: unknown; result?: unknown; error?: unknown }
        if (typeof msg.id !== 'number') continue
        const waiter = pending.get(msg.id)
        if (!waiter) continue
        pending.delete(msg.id)
        if (msg.error !== undefined) {
          const errObj = msg.error && typeof msg.error === 'object' ? (msg.error as { message?: unknown }) : null
          const errText = errObj && typeof errObj.message === 'string' ? errObj.message : 'Server returned an MCP error.'
          waiter.reject(new Error(errText))
        } else if (msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result)) {
          waiter.resolve(msg.result as Record<string, unknown>)
        } else {
          waiter.reject(new Error('Invalid MCP response from server.'))
        }
      }
    })

    child.on('error', (err) => {
      failAllPending(new Error(`Could not start server: ${err.message}`))
    })

    // A server that closes its input makes the next write fail with EPIPE, reported here (not to the write).
    child.stdin?.on('error', (err) => {
      failAllPending(new Error(`Server closed its input: ${err.message}`))
    })

    child.on('exit', (code, signal) => {
      if (pending.size > 0) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
        failAllPending(new Error(`Server exited early (${detail}).`))
      }
    })

    const sendRpc = (idNum: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          reject(new Error(`Server exited early (code ${child.exitCode ?? 'unknown'}).`))
          return
        }
        pending.set(idNum, { resolve, reject })
        const line = `${JSON.stringify({ jsonrpc: '2.0', id: idNum, method, params })}\n`
        try {
          child.stdin?.write(line)
        } catch (err) {
          pending.delete(idNum)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    }

    const sendNotification = (method: string, params?: Record<string, unknown>): void => {
      const payload = params ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method }
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`)
      } catch {
        // ignore
      }
    }

    let timeoutTimer: NodeJS.Timeout | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error(`Timed out after ${Math.max(1, Math.round(timeoutMs / 1000))} seconds.`))
      }, timeoutMs)
    })

    const runHandshake = async (): Promise<AgentToolVerification> => {
      const initResult = await sendRpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'Regatta', version: this.deps.version }
      })

      const protocolVersion =
        typeof initResult['protocolVersion'] === 'string' && initResult['protocolVersion'].trim()
          ? initResult['protocolVersion']
          : '2025-06-18'

      const serverInfo =
        initResult['serverInfo'] && typeof initResult['serverInfo'] === 'object' && !Array.isArray(initResult['serverInfo'])
          ? (initResult['serverInfo'] as Record<string, unknown>)
          : null

      const serverName = serverInfo && typeof serverInfo['name'] === 'string' ? serverInfo['name'] : null
      const serverVersion = serverInfo && typeof serverInfo['version'] === 'string' ? serverInfo['version'] : null

      sendNotification('notifications/initialized')

      const tools: AgentToolInfo[] = []
      let cursor: string | undefined = undefined

      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const params: Record<string, unknown> = cursor !== undefined ? { cursor } : {}
        const listResult = await sendRpc(2 + page, 'tools/list', params)
        const rawTools = Array.isArray(listResult['tools']) ? listResult['tools'] : []
        for (const rawTool of rawTools) {
          if (!rawTool || typeof rawTool !== 'object') continue
          const t = rawTool as Record<string, unknown>
          if (typeof t['name'] !== 'string' || !t['name'].trim()) continue
          const description = typeof t['description'] === 'string' ? t['description'].slice(0, MAX_DESCRIPTION_CHARS) : ''
          tools.push({ name: t['name'].trim(), description })
        }
        const nextCursor = listResult['nextCursor']
        if (typeof nextCursor === 'string' && nextCursor.length > 0) {
          cursor = nextCursor
        } else {
          break
        }
      }

      return {
        at: Date.now(),
        fingerprint: startFingerprint,
        serverName,
        serverVersion,
        protocolVersion,
        tools
      }
    }

    let verification: AgentToolVerification | null = null
    let errorMessage: string | null = null

    try {
      verification = await Promise.race([runHandshake(), timeoutPromise])
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      this.activeStops.delete(stopNow)
      failAllPending(new Error('Verification finished.'))
      try {
        child.stdin?.end()
        child.stdin?.destroy()
      } catch {
        // ignore
      }
      await stopProcessGroup(pgid, graceMs)
      try {
        child.stdout?.destroy()
        child.stderr?.destroy()
      } catch {
        // ignore
      }
      if (stderrRemainder.trim()) {
        stderrLines.push(stderrRemainder.replace(/\r$/, ''))
        while (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift()
      }
    }

    const stderr = stderrLines.slice(-MAX_STDERR_LINES).join('\n')
    const current = this.servers.find((s) => s.id === id)
    if (!current) {
      return { ok: false, error: errorMessage ?? 'Server was removed.', stderr, server: null }
    }

    if (verification && errorMessage === null) {
      if (current.fingerprint === startFingerprint) {
        current.verified = verification
        current.updatedAt = Date.now()
        this.persist()
        return { ok: true, server: cloneServer(current) }
      }
      return {
        ok: false,
        error: 'Server changed while verification was running.',
        stderr,
        server: cloneServer(current)
      }
    }

    current.verified = null
    current.enabled = false
    current.updatedAt = Date.now()
    this.persist()
    return {
      ok: false,
      error: errorMessage ?? 'Verification failed.',
      stderr,
      server: cloneServer(current)
    }
  }

  setEnabled(id: string, on: boolean): AgentToolServer[] {
    const server = this.servers.find((s) => s.id === id)
    if (!server) throw new Error('Server not found.')
    if (on) {
      if (!server.verified || server.verified.fingerprint !== server.fingerprint) {
        throw new Error('Verify this server before turning it on.')
      }
    }
    server.enabled = Boolean(on)
    server.updatedAt = Date.now()
    return this.persist()
  }

  /** Extra command line arguments that give this agent the servers that are on. */
  argsFor(agent: AgentKind): string[] {
    if (agent === 'claude' || agent === 'fake') {
      const active = this.activeServersFor('claude')
      this.writeClaudeConfig()
      if (active.length === 0) return []
      return ['--mcp-config', this.claudeConfigFile]
    }

    if (agent === 'codex') {
      const active = this.activeServersFor('codex')
      const out: string[] = []
      for (const server of active) {
        out.push('-c', `mcp_servers.${server.id}.command=${tomlString(server.command)}`)
        out.push('-c', `mcp_servers.${server.id}.args=${tomlStringArray(server.args)}`)
        if (Object.keys(server.env).length > 0) {
          out.push('-c', `mcp_servers.${server.id}.env=${tomlInlineTable(server.env)}`)
        }
      }
      return out
    }

    return []
  }

  /** Stops any verification still running. */
  dispose(): void {
    for (const stop of [...this.activeStops]) {
      stop()
    }
    this.activeStops.clear()
  }
}
