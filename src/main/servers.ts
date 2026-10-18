// Saved SSH servers: host key checks and connection tests.

import { execFile } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { HostKeyScan, NewSshServer, SshServer } from '../shared/types'

export interface ProcResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type ProcRunner = (cmd: string, args: string[], opts: { timeout: number; env: Record<string, string> }) => Promise<ProcResult>

export interface ServerStoreDeps {
  /** App data folder: servers.json and Regatta's own known_hosts file live here. */
  dataDir: string
  /** Home folder, for ~/.ssh/config and ~/.ssh/known_hosts (read only). */
  home: string
  env: () => Record<string, string>
  now?: () => number
  /** Injectable process runner so unit tests can fake ssh. Defaults to execFile. */
  run?: ProcRunner
}

interface ScannedKey {
  type: string
  blob: string
  fingerprint: string
  line: string
}

interface LastScan {
  keys: ScannedKey[]
  hostname: string
  port: number
}

const KEYSCAN_TIMEOUT_MS = 10_000
const SSH_TIMEOUT_MS = 10_000
const KEYGEN_TIMEOUT_MS = 10_000
const TEST_TIMEOUT_MS = 15_000

function defaultRunner(cmd: string, args: string[], opts: { timeout: number; env: Record<string, string> }): Promise<ProcResult> {
  return new Promise((done) => {
    try {
      const child = execFile(
        cmd,
        args,
        { timeout: opts.timeout, maxBuffer: 8 * 1024 * 1024, env: opts.env },
        (err, stdout, stderr) => {
          let code = 0
          if (err) {
            const maybe = (err as unknown as { code?: unknown }).code
            code = typeof maybe === 'number' ? maybe : 1
          }
          done({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: code })
        }
      )
      try {
        const stdin = (child as unknown as { stdin?: { end?: () => void } }).stdin
        stdin?.end?.()
      } catch {
        // stdin already closed
      }
    } catch (err) {
      done({ stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 1 })
    }
  })
}

/** SHA256 fingerprint as OpenSSH prints it: SHA256 plus base64 without padding. */
export function fingerprintForBlob(blobBase64: string): string {
  const raw = Buffer.from(blobBase64, 'base64')
  const digest = createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

function sortedServers(servers: SshServer[]): SshServer[] {
  return [...servers].sort((a, b) => a.name.localeCompare(b.name))
}

function stripComment(line: string): string {
  const idx = line.indexOf('#')
  return idx >= 0 ? line.slice(0, idx) : line
}

function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else if (ch === '[') {
      const close = pattern.indexOf(']', i)
      if (close > i) {
        out += pattern.slice(i, close + 1)
        i = close
      } else {
        out += '\\['
      }
    } else if ('\\.+^$()|{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  out += '$'
  return new RegExp(out)
}

function expandIncludePattern(pattern: string, baseDir: string, home: string): string[] {
  let expanded = pattern
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = join(home, expanded.slice(1))
  }
  const absolute = expanded.startsWith('/') ? expanded : join(baseDir, expanded)
  const hasGlob = absolute.includes('*') || absolute.includes('?') || absolute.includes('[')
  if (!hasGlob) {
    try {
      const st = statSync(absolute)
      if (st.isFile()) return [absolute]
    } catch {
      return []
    }
    return []
  }
  const dir = dirname(absolute)
  const base = basename(absolute)
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const re = globToRegExp(base)
  const out: string[] = []
  for (const entry of entries) {
    if (!re.test(entry)) continue
    const full = join(dir, entry)
    try {
      if (statSync(full).isFile()) out.push(full)
    } catch {
      continue
    }
  }
  return out.sort()
}

function hostsFromConfigText(text: string): { hosts: string[]; includes: string[] } {
  const hosts: string[] = []
  const includes: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine).trim()
    if (!line) continue
    const match = line.match(/^(\S+)\s+(.*)$/)
    if (!match) continue
    const keyword = (match[1] ?? '').toLowerCase()
    const rest = (match[2] ?? '').trim()
    if (!rest) continue
    if (keyword === 'host') {
      for (const part of rest.split(/\s+/)) {
        if (part) hosts.push(part)
      }
    } else if (keyword === 'include') {
      for (const part of rest.split(/\s+/)) {
        if (part) includes.push(part)
      }
    }
  }
  return { hosts, includes }
}

function parseSshG(output: string): { hostname: string | null; port: number | null } {
  let hostname: string | null = null
  let port: number | null = null
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const space = line.indexOf(' ')
    if (space < 0) continue
    const key = line.slice(0, space).toLowerCase()
    const value = line.slice(space + 1).trim().split(/\s+/)[0] ?? ''
    if (!value) continue
    if (key === 'hostname' && hostname === null) hostname = value
    if (key === 'port' && port === null) {
      const n = Number(value)
      if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n
    }
  }
  return { hostname, port }
}

function parseKeyscan(output: string): ScannedKey[] {
  const out: ScannedKey[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const type = parts[1] ?? ''
    const blob = parts[2] ?? ''
    if (!type || !blob) continue
    if (!/^[A-Za-z0-9+/=]+$/.test(blob)) continue
    let fingerprint = ''
    try {
      fingerprint = fingerprintForBlob(blob)
    } catch {
      continue
    }
    out.push({ type, blob, fingerprint, line })
  }
  return out
}

function parseKeygenKnownHosts(output: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const type = parts[1] ?? ''
    const blob = parts[2] ?? ''
    if (!type || !blob) continue
    if (!found.has(type)) found.set(type, blob)
  }
  return found
}

/** Plain message for a failed ssh test, from the first stderr line. */
export function plainTestError(firstLine: string): string {
  const line = firstLine.trim()
  if (!line) return 'Connection failed.'
  const lower = line.toLowerCase()
  if (lower.includes('host key')) return 'Host key not trusted yet. Check the key first.'
  if (lower.includes('permission denied') || lower.includes('publickey') || lower.includes('authentication'))
    return 'Needs key sign-in; password sign-in is not supported here.'
  if (
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('connection refused') ||
    lower.includes('no route') ||
    lower.includes('not known') ||
    lower.includes('could not resolve') ||
    lower.includes('unreachable') ||
    lower.includes('connection closed') ||
    lower.includes('no answer')
  )
    return 'No answer within 8 seconds.'
  return line
}

export class ServerStore {
  private readonly lastScans = new Map<string, LastScan>()

  constructor(private readonly deps: ServerStoreDeps) {}

  private serversFile(): string {
    return join(this.deps.dataDir, 'servers.json')
  }

  private regattaKnownHostsFile(): string {
    return join(this.deps.dataDir, 'known_hosts')
  }

  private homeKnownHostsFile(): string {
    return join(this.deps.home, '.ssh', 'known_hosts')
  }

  private exec(cmd: string, args: string[], timeout: number): Promise<ProcResult> {
    const run = this.deps.run ?? defaultRunner
    return run(cmd, args, { timeout, env: this.deps.env() })
  }

  private readServers(): SshServer[] {
    try {
      if (!existsSync(this.serversFile())) return []
      const raw = readFileSync(this.serversFile(), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      const out: SshServer[] = []
      for (const item of parsed) {
        const s = item as Partial<SshServer>
        if (typeof s.id !== 'string' || typeof s.name !== 'string' || typeof s.host !== 'string') continue
        out.push({
          id: s.id,
          name: s.name,
          host: s.host,
          user: typeof s.user === 'string' ? s.user : null,
          port: typeof s.port === 'number' ? s.port : null,
          trusted: typeof s.trusted === 'string' ? s.trusted : null,
          lastTest:
            s.lastTest && typeof s.lastTest.ok === 'boolean' && typeof s.lastTest.at === 'number' && typeof s.lastTest.message === 'string'
              ? { ok: s.lastTest.ok, at: s.lastTest.at, message: s.lastTest.message }
              : null
        })
      }
      return out
    } catch {
      return []
    }
  }

  private writeFileAtomic(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
  }

  private writeServers(servers: SshServer[]): void {
    this.writeFileAtomic(this.serversFile(), `${JSON.stringify(servers, null, 2)}\n`)
  }

  list(): SshServer[] {
    return sortedServers(this.readServers())
  }

  async configHosts(): Promise<string[]> {
    const mainFile = join(this.deps.home, '.ssh', 'config')
    let mainText = ''
    try {
      if (!existsSync(mainFile)) return []
      mainText = readFileSync(mainFile, 'utf8')
    } catch {
      return []
    }
    const parsed = hostsFromConfigText(mainText)
    const collected = [...parsed.hosts]
    const baseDir = dirname(mainFile)
    for (const pattern of parsed.includes) {
      const files = expandIncludePattern(pattern, baseDir, this.deps.home)
      for (const file of files) {
        try {
          const text = readFileSync(file, 'utf8')
          const inner = hostsFromConfigText(text)
          collected.push(...inner.hosts)
        } catch {
          continue
        }
      }
    }
    const seen = new Set<string>()
    for (const name of collected) {
      if (!name || name.includes('*') || name.includes('?') || name.includes('!')) continue
      seen.add(name)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  }

  save(server: NewSshServer): SshServer[] {
    const name = (server.name ?? '').trim()
    const host = (server.host ?? '').trim()
    let userValue: string | null = null
    if (typeof server.user === 'string') {
      const trimmed = server.user.trim()
      userValue = trimmed === '' ? null : trimmed
    } else if (server.user == null) {
      userValue = null
    } else {
      userValue = String(server.user)
    }
    let portValue: number | null = null
    const rawPort = server.port as unknown
    if (rawPort == null || rawPort === '') {
      portValue = null
    } else if (typeof rawPort === 'number') {
      portValue = rawPort
    } else if (typeof rawPort === 'string') {
      const text = rawPort.trim()
      if (text === '') portValue = null
      else {
        const n = Number(text)
        portValue = Number.isInteger(n) ? n : NaN
      }
    } else {
      portValue = NaN
    }

    if (!name) throw new Error('Name is required.')
    if (name.length > 60) throw new Error('Name must be 60 characters or fewer.')
    if (!host) throw new Error('Host is required.')
    if (/\s/.test(host)) throw new Error('Host cannot contain spaces.')
    if (host.startsWith('-')) throw new Error('Host cannot start with a dash.')
    if (userValue !== null) {
      if (/\s/.test(userValue)) throw new Error('User cannot contain spaces.')
      if (userValue.includes('@')) throw new Error('User cannot contain @.')
      if (userValue.startsWith('-')) throw new Error('User cannot start with a dash.')
    }
    if (portValue !== null) {
      if (typeof portValue !== 'number' || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
        throw new Error('Port must be between 1 and 65535.')
      }
    }

    const servers = this.readServers()
    if (server.id) {
      const idx = servers.findIndex((s) => s.id === server.id)
      if (idx < 0) throw new Error('Server not found.')
      const prev = servers[idx]!
      const changed = prev.host !== host || (prev.user ?? null) !== userValue || (prev.port ?? null) !== portValue
      const updated: SshServer = {
        ...prev,
        name,
        host,
        user: userValue,
        port: portValue,
        trusted: changed ? null : prev.trusted,
        lastTest: changed ? null : prev.lastTest
      }
      servers[idx] = updated
      if (changed) this.lastScans.delete(server.id)
      this.writeServers(servers)
      return sortedServers(servers)
    }
    const existing = new Set(servers.map((s) => s.id))
    let id = randomBytes(4).toString('hex')
    while (existing.has(id)) id = randomBytes(4).toString('hex')
    const created: SshServer = { id, name, host, user: userValue, port: portValue, trusted: null, lastTest: null }
    servers.push(created)
    this.writeServers(servers)
    return sortedServers(servers)
  }

  remove(id: string): SshServer[] {
    const servers = this.readServers()
    const target = servers.find((s) => s.id === id)
    if (!target) throw new Error('Server not found.')
    const next = servers.filter((s) => s.id !== id)
    this.writeServers(next)
    this.lastScans.delete(id)
    const khFile = this.regattaKnownHostsFile()
    try {
      if (existsSync(khFile)) {
        const content = readFileSync(khFile, 'utf8')
        const candidates = new Set<string>()
        candidates.add(target.host)
        if (target.port != null && target.port !== 22) candidates.add(`[${target.host}]:${target.port}`)
        const filtered: string[] = []
        for (const rawLine of content.split('\n')) {
          const line = rawLine.trim()
          if (!line) continue
          if (line.startsWith('#')) {
            filtered.push(line)
            continue
          }
          const first = line.split(/\s+/)[0] ?? ''
          if (candidates.has(first)) continue
          if (first.startsWith(`[${target.host}]:`)) continue
          const parts = line.split(/\s+/)
          if (target.trusted && parts.length >= 3) {
            try {
              if (fingerprintForBlob(parts[2] ?? '') === target.trusted) continue
            } catch {
              // keep the line when the blob cannot be read
            }
          }
          filtered.push(line)
        }
        const out = filtered.length > 0 ? `${filtered.join('\n')}\n` : ''
        this.writeFileAtomic(khFile, out)
      }
    } catch {
      // removing the server matters more than cleaning known_hosts
    }
    return sortedServers(next)
  }

  async scan(id: string): Promise<HostKeyScan> {
    const servers = this.readServers()
    const server = servers.find((s) => s.id === id)
    if (!server) throw new Error('Server not found.')
    const env = this.deps.env()
    let resolvedHost = server.host
    let resolvedPort = server.port ?? 22
    try {
      const args: string[] = ['-G']
      if (server.port != null) args.push('-p', String(server.port))
      if (server.user) args.push('-l', server.user)
      args.push(server.host)
      const res = await this.exec('ssh', args, SSH_TIMEOUT_MS)
      const parsed = parseSshG(res.stdout)
      if (parsed.hostname) resolvedHost = parsed.hostname
      if (parsed.port != null) resolvedPort = parsed.port
      else if (server.port != null) resolvedPort = server.port
    } catch {
      // fall back to the saved host and port
    }

    let keyscanOut = ''
    try {
      const ks = await this.exec('ssh-keyscan', ['-T', '8', '-p', String(resolvedPort), resolvedHost], KEYSCAN_TIMEOUT_MS)
      keyscanOut = ks.stdout
    } catch {
      keyscanOut = ''
    }
    const parsedKeys = parseKeyscan(keyscanOut)

    let knownHosts: HostKeyScan['knownHosts'] = 'unknown'
    if (parsedKeys.length > 0) {
      const lookup = resolvedPort !== 22 ? `[${resolvedHost}]:${resolvedPort}` : resolvedHost
      try {
        const kg = await this.exec('ssh-keygen', ['-F', lookup, '-f', this.homeKnownHostsFile()], KEYGEN_TIMEOUT_MS)
        const found = parseKeygenKnownHosts(kg.stdout)
        let hasEntry = false
        let mismatch = false
        for (const key of parsedKeys) {
          const knownBlob = found.get(key.type)
          if (knownBlob != null) {
            hasEntry = true
            if (knownBlob !== key.blob) mismatch = true
          }
        }
        if (!hasEntry) knownHosts = 'unknown'
        else if (mismatch) knownHosts = 'mismatch'
        else knownHosts = 'match'
      } catch {
        knownHosts = 'unknown'
      }
    }

    let saved: HostKeyScan['saved'] = 'none'
    if (server.trusted) {
      saved = parsedKeys.some((k) => k.fingerprint === server.trusted) ? 'match' : 'mismatch'
    }

    let error: string | null = null
    if (parsedKeys.length === 0) {
      error = `No answer from ${resolvedHost} on port ${resolvedPort}`
    }

    this.lastScans.set(id, { keys: parsedKeys, hostname: resolvedHost, port: resolvedPort })
    return {
      keys: parsedKeys.map((k) => ({ type: k.type, fingerprint: k.fingerprint })),
      knownHosts,
      saved,
      error
    }
  }

  trust(id: string, fingerprint: string): SshServer[] {
    const servers = this.readServers()
    const idx = servers.findIndex((s) => s.id === id)
    if (idx < 0) throw new Error('Server not found.')
    const server = servers[idx]!
    const last = this.lastScans.get(id)
    if (!last || last.keys.length === 0) throw new Error('Check the key first, then trust it.')
    const found = last.keys.find((k) => k.fingerprint === fingerprint)
    if (!found) throw new Error('That fingerprint is not from the latest check.')
    const updated: SshServer = { ...server, trusted: fingerprint }
    servers[idx] = updated
    this.writeServers(servers)

    const khFile = this.regattaKnownHostsFile()
    let existing = ''
    try {
      if (existsSync(khFile)) existing = readFileSync(khFile, 'utf8')
    } catch {
      existing = ''
    }
    const targetField = found.line.split(/\s+/)[0] ?? ''
    const kept: string[] = []
    for (const rawLine of existing.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('#')) {
        kept.push(line)
        continue
      }
      const first = line.split(/\s+/)[0] ?? ''
      if (first === targetField) continue
      kept.push(line)
    }
    kept.push(found.line)
    this.writeFileAtomic(khFile, `${kept.join('\n')}\n`)
    return sortedServers(servers)
  }

  async test(id: string): Promise<SshServer[]> {
    const servers = this.readServers()
    const idx = servers.findIndex((s) => s.id === id)
    if (idx < 0) throw new Error('Server not found.')
    const server = servers[idx]!
    const homeKh = this.homeKnownHostsFile()
    const regKh = this.regattaKnownHostsFile()
    const knownHostsOpt = `UserKnownHostsFile="${homeKh}" "${regKh}"`
    const args: string[] = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', '-o', knownHostsOpt]
    if (server.port != null) args.push('-p', String(server.port))
    if (server.user) args.push('-l', server.user)
    args.push(server.host, 'true')
    let result: ProcResult
    try {
      result = await this.exec('ssh', args, TEST_TIMEOUT_MS)
    } catch (err) {
      result = { stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 1 }
    }
    const at = this.deps.now?.() ?? Date.now()
    let lastTest: SshServer['lastTest']
    if (result.exitCode === 0) {
      lastTest = { ok: true, at, message: 'Connected' }
    } else {
      const firstLine = String(result.stderr ?? '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? ''
      lastTest = { ok: false, at, message: plainTestError(firstLine) }
    }
    const updated: SshServer = { ...server, lastTest }
    servers[idx] = updated
    this.writeServers(servers)
    return sortedServers(servers)
  }
}

export function _testHelpers(): {
  parseSshG: typeof parseSshG
  parseKeyscan: typeof parseKeyscan
  parseKeygenKnownHosts: typeof parseKeygenKnownHosts
  resolve: typeof resolve
} {
  return { parseSshG, parseKeyscan, parseKeygenKnownHosts, resolve }
}
