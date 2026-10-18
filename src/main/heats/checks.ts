// Finding the project's own checks and running them in a worktree.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckResult, CheckSpec } from '../../shared/heats'
import { KILL_GRACE_MS, supervise } from './procgroup'
import type { SuperviseOptions } from './procgroup'

export { KILL_GRACE_MS }

/** A check that never finishes inside ten minutes is a hang, not a slow test suite. */
export const CHECK_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TAIL_LINES = 40
/** Output kept per command: the end of it, which is where failures are reported. */
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** Package.json scripts that become checks: the first is required, the rest guard the baseline. */
const SCRIPTS: { name: string; kind: CheckSpec['kind'] }[] = [
  { name: 'test', kind: 'required' },
  { name: 'typecheck', kind: 'guard' },
  { name: 'lint', kind: 'guard' },
  { name: 'build', kind: 'guard' }
]

/** The package manager whose lockfile sits in `root`. npm when there is no lockfile. */
export function packageManager(root: string): PackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun'
  return 'npm'
}

/** The command that runs one package.json script, for example "pnpm lint" or "npm run lint". */
export function scriptCommand(pm: PackageManager, script: string): string {
  // Bun's own `bun test` is a different runner, so the project's test script goes through `run`.
  if (script === 'test') return pm === 'bun' ? 'bun run test' : `${pm} test`
  return pm === 'npm' || pm === 'bun' ? `${pm} run ${script}` : `${pm} ${script}`
}

/** The scripts in `root`'s package.json, or an empty object when there is no package.json. */
export function readScripts(root: string): Record<string, string> {
  const file = join(root, 'package.json')
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts
    if (!scripts || typeof scripts !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value === 'string') out[name] = value
    }
    return out
  } catch {
    return {}
  }
}

/** True when the Makefile in `root` declares a test target. */
export function hasMakeTest(root: string): boolean {
  return makefileText(root)
    .split('\n')
    .some((line) => /^test\s*:/i.test(line.trim()))
}

function makefileText(root: string): string {
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    const file = join(root, name)
    if (!existsSync(file)) continue
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  return ''
}

/** The checks this project already has. Empty when nothing recognisable is there. */
export function detectChecks(root: string): CheckSpec[] {
  const checks: CheckSpec[] = []
  const scripts = readScripts(root)
  if (Object.keys(scripts).length > 0) {
    const pm = packageManager(root)
    for (const { name, kind } of SCRIPTS) {
      if (typeof scripts[name] === 'string') checks.push({ name, command: scriptCommand(pm, name), kind })
    }
  }
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'pytest.ini'))) {
    checks.push({ name: 'pytest', command: 'pytest', kind: 'required' })
  }
  if (existsSync(join(root, 'go.mod'))) {
    checks.push({ name: 'go test', command: 'go test ./...', kind: 'required' })
  }
  if (existsSync(join(root, 'Cargo.toml'))) {
    checks.push({ name: 'cargo test', command: 'cargo test', kind: 'required' })
  }
  if (hasMakeTest(root)) {
    checks.push({ name: 'make test', command: 'make test', kind: 'required' })
  }
  return checks
}

/** The result of one command run through /bin/sh: the exit code, null when it was killed. */
export interface ShellResult {
  code: number | null
  output: string
  /** True when the command was stopped because it ran out of time. */
  timedOut?: boolean
  /** True when the command was stopped because the caller cancelled it. */
  cancelled?: boolean
  /** True when some process the command started could not be stopped, so its folder is still in use. */
  stuck?: boolean
}

export interface ShellOptions {
  cwd: string
  env: Record<string, string>
  timeoutMs?: number
  /** Aborting stops the command and every process it started. */
  signal?: AbortSignal
  /** Shutdown timings, for tests. */
  supervise?: SuperviseOptions
}

/**
 * Runs one command through /bin/sh in `cwd`, in its own process group so that a timeout or a
 * cancel stops the whole tree, not just the shell. Never throws: a failure is a non zero exit
 * code, and a command that was stopped has code null. Resolves only after the process and every
 * process of its group are gone. A signal that is already aborted never starts the command.
 */
export function runShell(command: string, opts: ShellOptions): Promise<ShellResult> {
  if (opts.signal?.aborted) return Promise.resolve({ code: null, output: '', cancelled: true })
  return new Promise((done) => {
    let output = ''
    let timedOut = false
    let cancelled = false

    const child = spawn('/bin/sh', ['-c', command], {
      cwd: opts.cwd,
      env: opts.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const group = supervise(child, opts.supervise)

    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(output.length - MAX_OUTPUT_CHARS)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => {
      output += err.message
    })

    const timeout = setTimeout(() => {
      timedOut = true
      group.stop()
    }, opts.timeoutMs ?? CHECK_TIMEOUT_MS)
    const onAbort = (): void => {
      cancelled = true
      group.stop()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    void group.done.then((code) => {
      clearTimeout(timeout)
      opts.signal?.removeEventListener('abort', onAbort)
      done({
        code: timedOut || cancelled ? null : code,
        output,
        ...(timedOut ? { timedOut } : {}),
        ...(cancelled ? { cancelled } : {}),
        ...(group.stuck ? { stuck: true } : {})
      })
    })
  })
}

export interface CheckRunOptions {
  signal?: AbortSignal
  timeoutMs?: number
  supervise?: SuperviseOptions
}

/** Runs one check and keeps its last lines of output. */
export async function runCheck(spec: CheckSpec, cwd: string, env: Record<string, string>, opts: CheckRunOptions = {}): Promise<CheckResult> {
  const started = Date.now()
  const result = await runShell(spec.command, { cwd, env, signal: opts.signal, timeoutMs: opts.timeoutMs, supervise: opts.supervise })
  return {
    name: spec.name,
    passed: result.code === 0,
    exitCode: result.code,
    durationMs: Date.now() - started,
    outputTail: tail(result.output),
    ...(result.stuck ? { stuck: true } : {})
  }
}

/** Runs every check in order. One failing check does not stop the others; a cancel does. */
export async function runChecks(
  specs: CheckSpec[],
  cwd: string,
  env: Record<string, string>,
  opts: CheckRunOptions = {}
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const spec of specs) {
    if (opts.signal?.aborted) break
    results.push(await runCheck(spec, cwd, env, opts))
  }
  return results
}

/** The last lines of a command's output, newest at the end. */
export function tail(output: string, lines = MAX_TAIL_LINES): string {
  const all = output.replace(/\r/g, '').split('\n')
  while (all.length > 0 && all[all.length - 1]!.trim().length === 0) all.pop()
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}