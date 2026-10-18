// Sign-in status of service CLIs (GitHub, GitLab, Stripe, Cloudflare, Supabase, Vercel, Shopify).
// Only reads; never signs in or out.

import { execFile, type ExecFileException } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ServiceStatus } from '../shared/types'

export interface ServicesDeps {
  env: () => Record<string, string>
  home: string
  now?: () => number
  /** Per command timeout in ms. The app uses 10 seconds; unit tests shorten it. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

interface ServiceCheck {
  id: ServiceStatus['id']
  name: string
  /** Arguments that print the version, for example ["--version"]. */
  versionArgs: string[]
  /** Arguments that report the sign-in state, or null when the CLI has no safe way to ask. */
  statusArgs: string[] | null
}

/** The seven services, always listed, in this order. The id is also the executable name. */
const CHECKS: ServiceCheck[] = [
  { id: 'gh', name: 'GitHub CLI', versionArgs: ['--version'], statusArgs: ['auth', 'status'] },
  { id: 'glab', name: 'GitLab CLI', versionArgs: ['--version'], statusArgs: ['auth', 'status'] },
  { id: 'stripe', name: 'Stripe CLI', versionArgs: ['version'], statusArgs: ['login', 'list'] },
  { id: 'wrangler', name: 'Cloudflare Wrangler', versionArgs: ['--version'], statusArgs: ['whoami', '--json'] },
  { id: 'supabase', name: 'Supabase CLI', versionArgs: ['--version'], statusArgs: null },
  { id: 'vercel', name: 'Vercel CLI', versionArgs: ['--version'], statusArgs: ['whoami', '--non-interactive'] },
  { id: 'shopify', name: 'Shopify CLI', versionArgs: ['version'], statusArgs: null }
]

interface RunResult {
  /** Exit code, or null when the process never ran or was killed. */
  code: number | null
  stdout: string
  stderr: string
  /** Could not be started (missing file, bad permissions). */
  failed: boolean
  /** Killed by the timeout, so it said nothing. */
  timedOut: boolean
}

/**
 * Runs one executable with an argument list (never a shell), stdin closed, a hard timeout.
 * Never throws; the caller reads the result fields.
 */
function run(file: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const done = (err: ExecFileException | null, stdout: string, stderr: string): void => {
      const out = String(stdout ?? '')
      const errText = String(stderr ?? '')
      if (err && err.killed) {
        resolve({ code: null, stdout: out, stderr: errText, failed: false, timedOut: true })
        return
      }
      if (err && typeof err.code === 'number') {
        resolve({ code: err.code, stdout: out, stderr: errText, failed: false, timedOut: false })
        return
      }
      if (err) {
        resolve({ code: null, stdout: out, stderr: errText, failed: true, timedOut: false })
        return
      }
      resolve({ code: 0, stdout: out, stderr: errText, failed: false, timedOut: false })
    }
    try {
      const child = execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, done)
      // Close stdin so a CLI that waits for input sees EOF instead of hanging.
      child.stdin?.end()
    } catch {
      resolve({ code: null, stdout: '', stderr: '', failed: true, timedOut: false })
    }
  })
}

/** Finds an executable on the PATH from deps.env(), in our own scan so nothing extra is run. */
function findOnPath(command: string, env: Record<string, string>): string | null {
  const dirs = (env['PATH'] ?? '').split(':')
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, command)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here, try the next PATH entry.
    }
  }
  return null
}

/** The first number-like token of the first non-empty line, for example "2.62.0". */
function parseVersion(res: RunResult): string | null {
  if (res.timedOut || res.failed) return null
  const line = `${res.stdout}\n${res.stderr}`
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  const match = /\d+(?:\.\d+)*/.exec(line)
  return match ? match[0] : null
}

/** An "email" string field anywhere in parsed JSON. */
function findEmail(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEmail(item)
      if (found) return found
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'email' && typeof item === 'string' && item) return item
      const found = findEmail(item)
      if (found) return found
    }
  }
  return null
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Decides gh / glab / stripe / wrangler / vercel from the status command's result. */
function decide(check: ServiceCheck, res: RunResult): { signedIn: ServiceStatus['signedIn']; account: string | null } {
  const silent = res.failed || res.timedOut
  switch (check.id) {
    case 'gh': {
      if (res.code === 0) {
        const match = /Logged in to github\.com account (\S+)/.exec(`${res.stdout}\n${res.stderr}`)
        return { signedIn: 'yes', account: match ? (match[1] ?? null) : null }
      }
      return { signedIn: silent ? 'unknown' : 'no', account: null }
    }
    case 'glab': {
      // Its exit codes are not documented, so only exit 0 says something (yes). Anything else is unknown.
      return res.code === 0 ? { signedIn: 'yes', account: null } : { signedIn: 'unknown', account: null }
    }
    case 'stripe': {
      if (res.code !== 0) return { signedIn: 'unknown', account: null }
      // Account lines are plain entries; headers end with ":" and a "No ..." line says there are none.
      const accounts = nonEmptyLines(res.stdout).filter((l) => !l.endsWith(':') && !/^no\b/i.test(l))
      return accounts.length > 0 ? { signedIn: 'yes', account: accounts[0] ?? null } : { signedIn: 'no', account: null }
    }
    case 'wrangler': {
      if (res.code === 0) {
        let email: string | null = null
        try {
          email = findEmail(JSON.parse(res.stdout))
        } catch {
          email = null
        }
        return { signedIn: 'yes', account: email }
      }
      return { signedIn: silent ? 'unknown' : 'no', account: null }
    }
    case 'vercel': {
      if (res.code === 0) {
        const lines = nonEmptyLines(res.stdout)
        return { signedIn: 'yes', account: lines.length > 0 ? (lines[lines.length - 1] ?? null) : null }
      }
      return { signedIn: silent ? 'unknown' : 'no', account: null }
    }
    default:
      return { signedIn: 'unknown', account: null }
  }
}

async function checkOne(check: ServiceCheck, env: Record<string, string>, home: string, timeoutMs: number, checkedAt: number): Promise<ServiceStatus> {
  const base: ServiceStatus = {
    id: check.id,
    name: check.name,
    installed: false,
    version: null,
    signedIn: 'unknown',
    account: null,
    detail: 'Not installed',
    checkedAt
  }
  const bin = findOnPath(check.id, env)
  if (!bin) return base
  try {
    const version = parseVersion(await run(bin, check.versionArgs, env, timeoutMs))
    const found: ServiceStatus = { ...base, installed: true, version }
    if (!check.statusArgs) {
      if (check.id === 'supabase') {
        // No status command. A token in the environment or the CLI's own token file means signed in.
        const tokenSet = (env['SUPABASE_ACCESS_TOKEN'] ?? '') !== ''
        let fileSet = false
        try {
          fileSet = statSync(join(home, '.supabase', 'access-token')).isFile()
        } catch {
          fileSet = false
        }
        const detail = tokenSet
          ? 'SUPABASE_ACCESS_TOKEN is set'
          : fileSet
            ? '~/.supabase/access-token exists'
            : 'No SUPABASE_ACCESS_TOKEN or ~/.supabase/access-token'
        return { ...found, signedIn: tokenSet || fileSet ? 'yes' : 'unknown', detail }
      }
      return { ...found, detail: 'No status command' }
    }
    const res = await run(bin, check.statusArgs, env, timeoutMs)
    const detail = `${check.id} ${check.statusArgs.join(' ')}`
    return { ...found, ...decide(check, res), detail }
  } catch {
    return { ...base, installed: true, detail: 'Check failed' }
  }
}

/** Runs the seven checks in parallel; one CLI failing never affects the others; never throws. */
export async function checkServices(deps: ServicesDeps): Promise<ServiceStatus[]> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const env: Record<string, string> = { ...deps.env(), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }
  const checkedAt = deps.now ? deps.now() : Date.now()
  return Promise.all(CHECKS.map((check) => checkOne(check, env, deps.home, timeoutMs, checkedAt)))
}
