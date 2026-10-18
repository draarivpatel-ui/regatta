// Process group lifetime for commands that heats start (checks, setup steps, agents).
// The child must be spawned with `detached: true` (so it leads its own process group) on macOS
// and Linux. Stopping signals the whole group, and "done" means the whole group is gone.

import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readdirSync, readlinkSync, realpathSync } from 'node:fs'

/** How long a group gets to stop after SIGTERM before it is killed with SIGKILL. */
export const KILL_GRACE_MS = 3000
/** How long a stuck group is waited for after SIGKILL before giving up on it. */
const GIVE_UP_MS = 5000
/** How long output pipes may stay open after the process itself exited (a leftover background job). */
const PIPE_GRACE_MS = 1000
/** How long after the group is gone the pipes may take to deliver the last output. */
const DRAIN_MS = 500
const POLL_MS = 25

export interface SuperviseOptions {
  killGraceMs?: number
  giveUpMs?: number
  pipeGraceMs?: number
}

/** Whether every process of the group is gone (`stopped`) or some could not be stopped (`stuck`). */
export type SuperviseOutcome = 'stopped' | 'stuck'

export interface GroupSupervisor {
  /** SIGTERM to the whole group, SIGKILL after the grace period. Safe to call any number of times. */
  stop: () => void
  /** True once stop was called, or leftovers of a finished process were being cleaned up. */
  readonly stopping: boolean
  /**
   * Resolves with the exit code (null when killed by a signal) once the process exited, its
   * output closed and no process of its group is left. Never rejects. No signal is sent after it.
   */
  done: Promise<number | null>
  /**
   * Settles together with `done`: `stopped` when no process of the group is left, `stuck` when the
   * shutdown deadline passed and some are still alive. A stuck group is never signaled again, and
   * whatever it could be using (its folder) must not be removed.
   */
  outcome: Promise<SuperviseOutcome>
  /** True once `done` resolved with a stuck group. */
  readonly stuck: boolean
}

/** A live supervised group, as far as `stopAllGroups` needs to know it. */
interface RegisteredGroup {
  /** Same as `stop()`, with the grace this call wants before SIGKILL. */
  stop: (graceMs: number) => void
  outcome: Promise<SuperviseOutcome>
}

/** Every supervised group that has not settled yet. */
const registry = new Set<RegisteredGroup>()

/**
 * Stops every live supervised group the way `stop()` does (SIGTERM to the group, SIGKILL after
 * `graceMs`, nothing sent to a group already seen absent) and resolves when each one is `stopped`
 * or `stuck`. For quitting the app: agents and checks run in detached process groups that would
 * otherwise outlive it. Groups started while this waits are not included.
 */
export async function stopAllGroups(graceMs = 2000): Promise<{ stopped: number; stuck: number }> {
  const live = [...registry]
  for (const group of live) group.stop(graceMs)
  const outcomes = await Promise.all(live.map((group) => group.outcome))
  return { stopped: outcomes.filter((o) => o === 'stopped').length, stuck: outcomes.filter((o) => o === 'stuck').length }
}

/** Watches a freshly spawned, detached child and everything it starts. */
export function supervise(child: ChildProcess, opts: SuperviseOptions = {}): GroupSupervisor {
  const killGrace = opts.killGraceMs ?? KILL_GRACE_MS
  const giveUp = opts.giveUpMs ?? GIVE_UP_MS
  const pipeGrace = opts.pipeGraceMs ?? PIPE_GRACE_MS
  const grouped = process.platform !== 'win32'
  const pgid = child.pid

  let exited = false
  let closed = false
  let exitCode: number | null = null
  let stopping = false
  let settled = false
  let goneSince: number | null = null
  /**
   * Set the first time the group is seen absent. From then on the id may belong to someone else's
   * group, so it is never probed or signaled again.
   */
  let retired = false
  let stuck = false
  let poll: NodeJS.Timeout | null = null
  const timers = new Set<NodeJS.Timeout>()
  let resolveDone!: (code: number | null) => void
  const done = new Promise<number | null>((resolve) => {
    resolveDone = resolve
  })
  let resolveOutcome!: (outcome: SuperviseOutcome) => void
  const outcome = new Promise<SuperviseOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  /** A timer that is cleared when the supervisor settles, so nothing fires at a recycled group id. */
  const later = (fn: () => void, ms: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!settled) fn()
    }, ms)
    timers.add(timer)
  }

  const alive = (): boolean => {
    if (!pgid || retired) return false
    if (!grouped) return !exited
    try {
      process.kill(-pgid, 0)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return true
      retired = true
      return false
    }
  }

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (settled || !pgid || retired) return
    try {
      if (grouped) process.kill(-pgid, signal)
      else child.kill(signal)
    } catch (err) {
      // The group is already gone: its id is not ours to use any more.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') retired = true
    }
  }

  const entry: RegisteredGroup = { stop: (grace) => begin(grace), outcome }

  const finish = (): void => {
    if (settled) return
    settled = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    if (poll) clearInterval(poll)
    child.stdout?.destroy()
    child.stderr?.destroy()
    registry.delete(entry)
    resolveDone(exitCode)
    resolveOutcome(stuck ? 'stuck' : 'stopped')
  }

  /** The shutdown deadline: whatever is still alive now could not be stopped. */
  const giveUpNow = (): void => {
    if (settled) return
    stuck = alive()
    finish()
  }

  const begin = (grace = killGrace): void => {
    if (settled) return
    if (stopping) {
      // Already on its way out: a shorter grace asked for later still brings the SIGKILL forward.
      if (grace < killGrace) {
        later(() => {
          if (alive()) signalGroup('SIGKILL')
        }, grace)
      }
      return
    }
    stopping = true
    if (alive()) signalGroup('SIGTERM')
    // Escalate only while the group is still there; once it is gone the timer is cleared.
    later(() => {
      if (alive()) signalGroup('SIGKILL')
    }, grace)
    later(giveUpNow, grace + giveUp)
    ensurePoll()
  }

  const check = (): void => {
    if (settled || !exited) return
    if (alive()) {
      goneSince = null
      // Everything closed but the group lives on: leftovers of a finished command.
      if (closed) begin()
      return
    }
    goneSince ??= Date.now()
    if (closed || Date.now() - goneSince >= DRAIN_MS) finish()
  }

  function ensurePoll(): void {
    if (poll || settled) return
    poll = setInterval(check, POLL_MS)
  }

  if (!pgid) {
    // Spawning failed: there is nothing to wait for once the error was reported.
    const over = (): void => {
      exited = true
      closed = true
      finish()
    }
    child.once('error', over)
    child.once('close', over)
    return { stop: () => undefined, stopping: false, done, outcome, stuck: false }
  }

  registry.add(entry)

  child.on('exit', (code) => {
    exited = true
    exitCode = typeof code === 'number' ? code : null
    // Output still open after the process left means a leftover job holds it.
    later(() => {
      if (!closed && alive()) begin()
    }, pipeGrace)
    ensurePoll()
    check()
  })
  child.on('close', (code) => {
    closed = true
    if (exitCode === null && typeof code === 'number') exitCode = code
    check()
  })

  return {
    stop: () => begin(),
    get stopping() {
      return stopping
    },
    done,
    outcome,
    get stuck() {
      return stuck
    }
  }
}

/** One process that uses something inside a folder: its working folder, or a file it has open. */
export interface ProcessInside {
  pid: number
  /** The path inside the folder, as the system reports it. */
  path: string
  kind: 'cwd' | 'file'
}

/** A listing of every open file of every process is quick; this long means lsof is stuck. */
const LSOF_TIMEOUT_MS = 30_000
/** The whole listing must fit: output that was cut off is not an answer. */
const LSOF_MAX_BYTES = 256 * 1024 * 1024

/**
 * Processes that use something inside `folder`: a working folder at or below it, or any open file
 * (including a running program and memory-mapped files) below it, whichever session or process
 * group they belong to. A server an agent started with setsid is not in the agent's group, and one
 * whose working folder is elsewhere can still hold a file here open.
 *
 * Uses one complete `lsof -nP -F pfn` on macOS and /proc on Linux. Throws when the answer is not
 * complete: lsof failing to start, exiting with an error, being killed, timing out, or filling its
 * output buffer. Callers keep the folder then; an unknown is never an empty list. On Windows it
 * answers nothing (an open file blocks the removal there by itself).
 */
export async function processesInside(
  folder: string,
  caseInsensitive = false,
  limits: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<ProcessInside[]> {
  if (process.platform === 'win32') return []
  const real = realpathSync(folder)
  const fold = caseInsensitive ? (name: string): string => name.normalize('NFC').toLowerCase() : (name: string): string => name
  const prefix = fold(real)
  const under = (path: string, base: string): boolean => path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`)
  // lsof writes some characters as escapes: the folder is compared both as it really is and as lsof would write it.
  const writtenPrefix = fold(encodeLsofName(real))
  const inside = (raw: string): boolean => {
    const decoded = decodeLsofName(raw)
    if (decoded.certain) return under(fold(decoded.text), prefix) || under(fold(raw), writtenPrefix)
    // A backslash sequence that cannot be read with certainty: busy, unless what precedes it cannot be this folder.
    const before = fold(decoded.text)
    return under(before, prefix) || prefix.startsWith(before) || under(fold(raw), writtenPrefix) || writtenPrefix.startsWith(fold(raw.slice(0, firstUnreadable(raw))))
  }
  const found: ProcessInside[] = []
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      const pid = Number(name)
      let cwd: string | null = null
      try {
        cwd = readlinkSync(`/proc/${name}/cwd`)
      } catch {
        // Gone, or another user's: not visible, like the same process in lsof.
      }
      if (cwd !== null && under(fold(cwd), prefix)) found.push({ pid, path: cwd, kind: 'cwd' })
      let fds: string[] = []
      try {
        fds = readdirSync(`/proc/${name}/fd`)
      } catch {
        continue
      }
      for (const fd of fds) {
        try {
          const target = readlinkSync(`/proc/${name}/fd/${fd}`)
          if (target.startsWith('/') && under(fold(target), prefix)) found.push({ pid, path: target, kind: 'file' })
        } catch {
          // The descriptor closed meanwhile.
        }
      }
    }
    return found
  }
  const out = await new Promise<string>((resolve, reject) => {
    // Without a UTF-8 locale (a Finder launch has none) lsof writes "é" as the text \xc3\xa9, which would never match.
    const env = { ...process.env, LC_ALL: 'en_US.UTF-8' }
    execFile('lsof', ['-nP', '-w', '-F', 'pfn'], { env, timeout: limits.timeoutMs ?? LSOF_TIMEOUT_MS, maxBuffer: limits.maxBytes ?? LSOF_MAX_BYTES }, (err, stdout) => {
      // Anything but a clean exit (an error, a signal, a timeout, a full buffer) leaves the listing in doubt.
      if (err) reject(new Error(`lsof did not finish cleanly: ${err.message}`))
      else resolve(String(stdout))
    })
  })
  let pid = 0
  let fd = ''
  let listed = false
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
      fd = ''
      listed = true
    } else if (line.startsWith('f')) {
      fd = line.slice(1)
    } else if (line.startsWith('n') && pid > 0) {
      const name = line.slice(1)
      // Sockets, pipes and the like have names that are not paths.
      if (name.startsWith('/') && inside(name)) found.push({ pid, path: decodeLsofName(name).text, kind: fd === 'cwd' ? 'cwd' : 'file' })
    }
  }
  if (!listed || !out.endsWith('\n')) throw new Error('lsof listed no processes, or its output was cut off')
  return found
}

/**
 * How this lsof (4.91, checked on macOS) writes a name: `\\` for a backslash, `\t`, `\n`, `\r`, `\b`
 * and `\f` for those controls, `^A` to `^_` for the other control characters, and `\xHH` for bytes
 * it will not print (DEL, and anything non-ASCII when the locale is not UTF-8).
 */
export function encodeLsofName(name: string): string {
  let out = ''
  for (const char of name) {
    const code = char.codePointAt(0)!
    if (char === '\\') out += '\\\\'
    else if (char === '\t') out += '\\t'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\b') out += '\\b'
    else if (char === '\f') out += '\\f'
    else if (code < 0x20) out += `^${String.fromCharCode(code + 0x40)}`
    else if (code === 0x7f) out += '\\x7f'
    else out += char
  }
  return out
}

const SIMPLE_ESCAPES: Record<string, string> = { '\\': '\\', t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07', e: '\x1b' }

/** Where the first backslash sequence this reader does not know begins, or the length when there is none. */
function firstUnreadable(raw: string): number {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') continue
    const next = raw[i + 1] ?? ''
    if (next in SIMPLE_ESCAPES) {
      i++
      continue
    }
    if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 2, i + 4))) {
      i += 3
      continue
    }
    return i
  }
  return raw.length
}

/**
 * Turns a name as lsof wrote it back into the characters it was: every backslash escape lsof uses.
 * `^X` is left as written (a real control character and a literal caret look the same), which
 * `inside` covers by also comparing against the folder as lsof would write it. `certain` is false
 * when a backslash sequence could not be read; `text` then holds what came before it.
 */
export function decodeLsofName(raw: string): { text: string; certain: boolean } {
  if (!raw.includes('\\')) return { text: raw, certain: true }
  let bytes: number[] = []
  let text = ''
  const flush = (): void => {
    if (bytes.length > 0) text += Buffer.from(bytes).toString('utf8')
    bytes = []
  }
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!
    if (char !== '\\') {
      flush()
      text += char
      continue
    }
    const next = raw[i + 1] ?? ''
    if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 2, i + 4))) {
      bytes.push(parseInt(raw.slice(i + 2, i + 4), 16))
      i += 3
    } else if (next in SIMPLE_ESCAPES) {
      flush()
      text += SIMPLE_ESCAPES[next]
      i++
    } else {
      flush()
      return { text, certain: false }
    }
  }
  flush()
  return { text, certain: true }
}
