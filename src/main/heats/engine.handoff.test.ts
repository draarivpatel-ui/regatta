// Hand-offs use real temporary repositories and stub runs, never installed agent CLIs.
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '../../shared/agents'
import { suggestOrder } from '../../shared/heats'
import type { CheckSpec, HeatState } from '../../shared/heats'
import type { StartHeatOptions } from '../../shared/ipc'
import type { AgentKind } from '../../shared/types'
import { HeatEngine } from './engine'
import { emptyTrash, listTrash } from './git-ops'
import { withRepoLock } from './repo-lock'
import type { HeatEngineDeps } from './engine'
import type { RunHandle, RunOptions, RunResult } from './runner'

const dirs: string[] = []
const engines: HeatEngine[] = []
const clocks = new Set<ReturnType<typeof setTimeout>>()
function temp(): string {
  const path = mkdtempSync('/tmp/regatta-handoff-')
  dirs.push(path)
  return path
}
const gitConfig = join(temp(), 'gitconfig')
writeFileSync(gitConfig, '[user]\n name = Regatta Test\n email = test@regatta.local\n[commit]\n gpgsign = false\n')
const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' }
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', timeout: 15000 }).trim()
}
function change(cwd: string): void {
  appendFileSync(join(cwd, 'src', 'app.js'), '// changed by stub\n')
}
interface Attempt {
  write?: (opts: RunOptions) => void
  /** Runs ~25ms after the run starts, while it is still running (the live diff sampler ticks). */
  during?: (opts: RunOptions) => void
  delay?: number
  code?: number
  stuck?: boolean
  stopDelay?: number
}
function harness(plan: Attempt[], patch: Partial<HeatEngineDeps> = {}) {
  const repo = temp()
  const worktrees = temp()
  git(repo, 'init', '-b', 'main')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
  writeFileSync(join(repo, 'app.test.js'), "it('ok', () => expect(1).toBe(1))\n")
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'base')
  const runs: RunOptions[] = []
  const stopped: number[] = []
  const completed: number[] = []
  const emitted: HeatState[] = []
  const deps: HeatEngineDeps = {
    root: () => repo,
    env: () => ENV,
    agents: () =>
      (['fake', 'claude', 'codex', 'gemini'] as AgentKind[]).map((kind) => ({
        ...AGENTS[kind],
        installed: true,
        path: 'unused-stub',
        version: 'test'
      })),
    run: (opts): RunHandle => {
      const index = runs.length
      runs.push(opts)
      const attempt = plan[index] ?? {}
      for (let i = 0; i < 30; i++) opts.onActivity(`activity ${i}`)
      opts.onTokens(123)
      let finish!: (result: RunResult) => void
      let failRun!: (err: unknown) => void
      let settled = false
      const done = new Promise<RunResult>((resolve, reject) => {
        finish = resolve
        failRun = reject
      })
      const settle = (wasStopped: boolean): void => {
        if (settled) return
        settled = true
        completed.push(index)
        finish({ exitCode: wasStopped ? null : attempt.code ?? 0, durationMs: 20, tokens: 123, stopped: wasStopped, stuck: attempt.stuck })
      }
      const clock = setTimeout(() => {
        clocks.delete(clock)
        try {
          attempt.write?.(opts)
          settle(false)
        } catch (err) {
          settled = true
          failRun(err)
        }
      }, attempt.delay ?? 5)
      clocks.add(clock)
      if (attempt.during) {
        const early = setTimeout(() => {
          clocks.delete(early)
          if (!settled) attempt.during?.(opts)
        }, 25)
        clocks.add(early)
      }
      return {
        done,
        stop: () => {
          if (settled) return
          stopped.push(index)
          clearTimeout(clock)
          clocks.delete(clock)
          const stopping = setTimeout(() => {
            clocks.delete(stopping)
            settle(true)
          }, attempt.stopDelay ?? 0)
          clocks.add(stopping)
        }
      }
    },
    emit: (heat) => {
      emitted.push(heat)
    },
    worktreesDir: () => worktrees,
    ...patch
  }
  const engine = new HeatEngine(deps)
  engines.push(engine)
  return { engine, repo, worktrees, runs, stopped, completed, emitted, deps }
}
const OK: CheckSpec[] = [{ name: 'ok', command: 'true', kind: 'required' }]
function options(patch: Partial<StartHeatOptions> = {}): StartHeatOptions {
  return { mode: 'handoff', task: 'Improve app', agents: ['fake'], order: ['fake'], checks: OK, setup: '', timeLimitMin: 10, allowCommands: false, ...patch }
}
async function until(check: () => boolean, ms = 30000): Promise<void> {
  const start = performance.now()
  while (!check()) {
    if (performance.now() - start > ms) throw new Error('Hand-off did not reach the expected state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
function state(engine: HeatEngine, id: string): HeatState {
  const heat = engine.list().find((h) => h.id === id)
  if (!heat) throw new Error('Missing hand-off')
  return heat
}
async function decided(h: ReturnType<typeof harness>, patch: Partial<StartHeatOptions> = {}): Promise<HeatState> {
  const { id } = await h.engine.start(options(patch))
  await until(() => ['decided', 'error'].includes(state(h.engine, id).status))
  expect(state(h.engine, id).error).toBeNull()
  return state(h.engine, id)
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const engine of engines) {
    for (const heat of engine.list()) {
      if (['baseline', 'racing', 'waiting'].includes(heat.status)) {
        engine.cancel(heat.id)
        await engine.discard(heat.id)
      }
    }
    engine.quit()
  }
})
afterAll(async () => {
  for (const engine of engines) engine.quit()
  for (const clock of clocks) clearTimeout(clock)
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true })
})

function deadlineTrigger(): () => void {
  const actual = globalThis.setTimeout
  let expire: (() => void) | undefined
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms && ms > 1700000 && ms <= 1800000) expire = () => callback(...args)
    return actual(callback, ms, ...args)
  }) as typeof setTimeout)
  return () => {
    expect(expire).toBeTypeOf('function')
    expire!()
  }
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Captures every file in `worktree` (path, type, size, mtimeNs, content) plus its git index file and mtimeNs. */
function snapshotWorktreeAndIndex(worktree: string): string {
  const lines: string[] = []
  const walk = (rel: string): void => {
    const dir = rel ? join(worktree, rel) : worktree
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      const full = join(worktree, path)
      const st = lstatSync(full, { bigint: true })
      if (entry.isDirectory()) {
        lines.push(`dir:${path}:${st.mtimeNs}`)
        walk(path)
      } else if (entry.isFile()) {
        lines.push(`file:${path}:${st.size}:${st.mtimeNs}:${readFileSync(full).toString('hex')}`)
      } else {
        lines.push(`other:${path}:${st.mtimeNs}`)
      }
    }
  }
  walk('')
  const dotGit = readFileSync(join(worktree, '.git'), 'utf8').trim()
  const gitDir = dotGit.replace(/^gitdir:\s*/, '')
  const indexFile = join(gitDir, 'index')
  const idxStat = lstatSync(indexFile, { bigint: true })
  lines.push(`index:${idxStat.size}:${idxStat.mtimeNs}:${readFileSync(indexFile).toString('hex')}`)
  return lines.join('\n')
}

describe('hand-off execution', () => {
  it('a solo first attempt wins through every gate and merges its tested tip', async () => {
    const h = harness([{ write: ({ cwd }) => change(cwd) }])
    const heat = await decided(h)
    expect(heat.mode).toBe('handoff')
    expect(heat.lanes[0]?.attempt).toBe(1)
    expect(heat.lanes[0]?.branch).toBe(`regatta/heat-${heat.id}-a1`)
    expect(heat.lanes[0]?.worktree).toBe(join(h.worktrees, `heat-${heat.id}-a1`))
    expect(heat.decision).toMatchObject({ kind: 'winner', laneIds: [heat.lanes[0]!.id] })
    expect(heat.lanes[0]!.gates).toHaveLength(5)
    expect(heat.lanes[0]!.gates.every((gate) => gate.passed)).toBe(true)
    const result = await h.engine.merge(heat.id, heat.lanes[0]!.id)
    expect(result.summary).toContain('Fast-forwarded main by 1 commit')
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(git(h.repo, 'rev-parse', 'HEAD')).toBe(heat.lanes[0]!.tip)
    expect(h.engine.busyPaths()).toEqual([])
  }, 60000)

  it('two attempts make two worktrees and two branches, the second based on the first commit, and never write to the first worktree after its agent stopped', async () => {
    const setupLog = join(temp(), 'setup.log')
    let attempt1SnapshotAfterCommit = ''
    const checks: CheckSpec[] = [
      {
        name: 'twice',
        command: "seq 1 50; test \"$(grep -c 'changed by stub' src/app.js)\" -ge 2",
        kind: 'required'
      }
    ]
    let h!: ReturnType<typeof harness>
    h = harness([
      { write: ({ cwd }) => change(cwd) },
      {
        write: ({ cwd }) => {
          // Attempt 2 starts with attempt 1's committed change already present in its fresh worktree.
          expect(readFileSync(join(cwd, 'src', 'app.js'), 'utf8')).toContain('changed by stub')
          change(cwd)
        }
      }
    ])
    const { id } = await h.engine.start(
      options({
        order: ['fake', 'fake'],
        askBeforeNext: true,
        checks,
        setup: `echo "$PWD" >> '${setupLog}'`
      })
    )
    await until(() => state(h.engine, id).status === 'waiting')
    const w1 = join(h.worktrees, `heat-${id}-a1`)
    const w2 = join(h.worktrees, `heat-${id}-a2`)
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]!.cwd).toBe(w1)
    // Record attempt 1's entire file tree and git index after attempt 1 finished.
    attempt1SnapshotAfterCommit = snapshotWorktreeAndIndex(w1)

    h.engine.continue(id)
    await until(() => state(h.engine, id).status === 'decided')
    const heat = state(h.engine, id)

    expect(h.runs).toHaveLength(2)
    expect(h.runs[0]!.cwd).toBe(w1)
    expect(h.runs[1]!.cwd).toBe(w2)
    expect(w1).not.toBe(w2)
    expect(heat.lanes.map((lane) => lane.branch)).toEqual([`regatta/heat-${heat.id}-a1`, `regatta/heat-${heat.id}-a2`])
    expect(heat.lanes.map((lane) => lane.worktree)).toEqual([w1, w2])

    // Attempt 2's branch is based on attempt 1's commit, not the heat base.
    const tip1 = heat.lanes[0]!.tip!
    const tip2 = heat.lanes[1]!.tip!
    expect(tip1).toBeTruthy()
    expect(tip2).toBeTruthy()
    expect(git(h.repo, 'rev-parse', `${tip2}^1`)).toBe(tip1)

    // Attempt 1's worktree and index were never written after attempt 1 stopped.
    expect(snapshotWorktreeAndIndex(w1)).toBe(attempt1SnapshotAfterCommit)
    expect(readFileSync(join(w1, 'src', 'app.js'), 'utf8').match(/changed by stub/g)).toHaveLength(1)
    expect(readFileSync(join(w2, 'src', 'app.js'), 'utf8').match(/changed by stub/g)).toHaveLength(2)

    // Evidence in attempt 2's prompt is bounded and read from commits.
    expect(h.runs[0]!.prompt).toBe('Improve app')
    expect(h.runs[1]!.prompt).toContain('BEGIN PREVIOUS ATTEMPT EVIDENCE')
    expect(h.runs[1]!.prompt).toContain('checks: failing: twice')
    expect(h.runs[1]!.prompt).toContain('1 file changed, 1 insertion(+)')
    expect(h.runs[1]!.prompt).toContain('11\n12\n')
    expect(h.runs[1]!.prompt).not.toContain('\n10\n')
    expect(h.runs[1]!.prompt).toContain('activity 10\n')
    expect(h.runs[1]!.prompt).not.toContain('activity 9\n')

    // Setup ran in each attempt's own worktree.
    const setupDirs = readFileSync(setupLog, 'utf8').trim().split('\n')
    expect(setupDirs.filter((cwd) => cwd === realpathSync(w1))).toHaveLength(1)
    expect(setupDirs.filter((cwd) => cwd === realpathSync(w2))).toHaveLength(1)

    expect(heat.decision).toMatchObject({ kind: 'winner', laneIds: [heat.lanes[1]!.id] })
    expect(h.engine.busyPaths().sort()).toEqual([w1, w2].sort())

    // Merging attempt 2's tip carries attempt 1's commit and moves both worktrees into Regatta's trash.
    const result = await h.engine.merge(heat.id, heat.lanes[1]!.id)
    expect(result.summary).toContain('Fast-forwarded main by 2 commits')
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')
    expect(git(h.repo, 'rev-parse', 'HEAD')).toBe(tip2)
    expect(git(h.repo, 'rev-list', 'HEAD')).toContain(tip1)
    expect(h.engine.busyPaths()).toEqual([])
    expect(existsSync(w1)).toBe(false)
    expect(existsSync(w2)).toBe(false)
  }, 60000)

  it('without askBeforeNext, attempt 1 worktree and index are never written after attempt 1 finishes scoring', async () => {
    const snapFile = join(temp(), 'a1-snap.txt')
    const checks: CheckSpec[] = [
      {
        name: 'twice',
        command: "test \"$(grep -c 'changed by stub' src/app.js)\" -ge 2",
        kind: 'required'
      }
    ]
    let w1 = ''
    const h = harness([
      {
        write: ({ cwd }) => {
          w1 = cwd
          change(cwd)
        }
      },
      {
        write: ({ cwd }) => {
          writeFileSync(snapFile, snapshotWorktreeAndIndex(w1))
          change(cwd)
        }
      }
    ])
    const heat = await decided(h, { order: ['fake', 'fake'], checks })
    expect(heat.decision).toMatchObject({ kind: 'winner', laneIds: [heat.lanes[1]!.id] })
    expect(snapshotWorktreeAndIndex(w1)).toBe(readFileSync(snapFile, 'utf8'))
    await h.engine.discard(heat.id)
  }, 60000)

  it('all failing attempts give no winner and cannot be merged', async () => {
    const h = harness([{ code: 2 }, { code: 2 }])
    const heat = await decided(h, { order: ['fake', 'fake'] })
    expect(h.runs).toHaveLength(2)
    expect(heat.decision?.kind).toBe('none')
    await expect(h.engine.merge(heat.id, heat.lanes[0]!.id)).rejects.toThrow('Only the winning lane')
  }, 60000)

  it('ask-before-next waits and only an explicit continue launches one backup', async () => {
    const h = harness([{ code: 2 }, { write: ({ cwd }) => change(cwd) }])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true }))
    await until(() => ['waiting', 'decided'].includes(state(h.engine, id).status))
    expect(state(h.engine, id).status).toBe('waiting')
    expect(h.runs).toHaveLength(1)
    expect(h.engine.busyPaths()).toEqual([h.runs[0]!.cwd])
    h.engine.continue(id)
    expect(() => h.engine.continue(id)).toThrow('not waiting')
    await until(() => state(h.engine, id).status === 'decided')
    expect(h.runs).toHaveLength(2)
    expect(state(h.engine, id).decision?.kind).toBe('winner')
  }, 60000)

  it('cancel while waiting wakes the run, keeps edits in trash and never launches the backup', async () => {
    const h = harness([{ write: ({ cwd }) => change(cwd), code: 2 }, {}])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true }))
    await until(() => state(h.engine, id).status === 'waiting')
    writeFileSync(join(h.runs[0]!.cwd, 'USER.txt'), 'precious\n')
    h.engine.cancel(id)
    expect(() => h.engine.continue(id)).toThrow('not waiting')
    await h.engine.discard(id)
    expect(h.runs).toHaveLength(1)
    expect(state(h.engine, id).status).toBe('cancelled')
    const trashed = (await listTrash(h.worktrees))[0]!.trashPath
    expect(readFileSync(join(trashed, 'USER.txt'), 'utf8')).toBe('precious\n')
    expect(h.engine.busyPaths()).toEqual([])
  }, 60000)

  it('discard waits for cancellation to finish and preserves uncommitted work in trash', async () => {
    const h = harness([{ delay: 60000, stopDelay: 3000 }, {}])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'] }))
    await until(() => h.runs.length === 1)
    const cwd = h.runs[0]!.cwd
    change(cwd)
    const base = git(cwd, 'rev-parse', 'HEAD')
    const discarding = h.engine.discard(id)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(existsSync(cwd)).toBe(true)
    expect(h.engine.busyPaths()).toContain(cwd)
    await discarding
    expect(h.completed).toEqual([0])
    expect(h.stopped).toEqual([0])
    expect(h.runs).toHaveLength(1)
    const trashed = (await listTrash(h.worktrees))[0]!.trashPath
    expect(git(trashed, 'rev-parse', 'HEAD')).toBe(base)
    expect(readFileSync(join(trashed, 'src', 'app.js'), 'utf8')).toContain('changed by stub')
    expect(state(h.engine, id).status).toBe('cancelled')
  }, 60000)

  it('per-attempt timeout stops the attempt and permits a backup', async () => {
    const h = harness([{ delay: 60000 }, { write: ({ cwd }) => change(cwd) }])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], attemptLimitMin: 0.001 }))
    await until(() => h.runs.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(h.stopped).toEqual([0])
    await until(() => state(h.engine, id).status === 'decided')
    const heat = state(h.engine, id)
    expect(h.stopped).toEqual([0])
    expect(heat.lanes[0]!.timedOut).toBe(true)
    expect(heat.decision).toMatchObject({ kind: 'winner', laneIds: [heat.lanes[1]!.id] })
  }, 60000)

  it('loop guard stops three identical required failures despite whitespace and durations', async () => {
    const h = harness(Array.from({ length: 4 }, () => ({ write: ({ cwd }: RunOptions) => change(cwd) })))
    const checks: CheckSpec[] = [
      { name: 'broken', command: "printf 'failed   in %sms\\n' \"$(grep -c 'changed by stub' src/app.js)\"; exit 1", kind: 'required' }
    ]
    const heat = await decided(h, { order: ['fake', 'fake', 'fake', 'fake'], checks })
    expect(h.runs).toHaveLength(3)
    expect(heat.decision).toEqual({ kind: 'none', laneIds: [], note: 'Stopped: broken failed the same way 3 times.' })
  }, 60000)

  it('overall deadline stops a running agent and never starts a backup', async () => {
    const expire = deadlineTrigger()
    const h = harness([{ delay: 60000 }, { write: ({ cwd }) => change(cwd) }])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], overallLimitMin: 30 }))
    await until(() => h.runs.length === 1)
    const tip = git(h.runs[0]!.cwd, 'rev-parse', 'HEAD')
    change(h.runs[0]!.cwd)
    expire()
    expect(h.stopped).toEqual([0])
    await until(() => state(h.engine, id).status === 'decided')
    const heat = state(h.engine, id)
    expect(h.stopped).toEqual([0])
    expect(h.runs).toHaveLength(1)
    expect(heat.lanes[0]!.timedOut).toBe(true)
    expect(heat.lanes[0]!.tip).toBeUndefined()
    expect(git(h.runs[0]!.cwd, 'rev-parse', 'HEAD')).toBe(tip)
    expect(heat.decision?.kind).toBe('none')
    expect(heat.decision?.note).toContain('overall time limit')
  }, 60000)

  it('a stuck agent holds its worktree and stops the hand-off before any backup', async () => {
    const h = harness([{ stuck: true }, {}])
    const heat = await decided(h, { order: ['fake', 'fake'] })
    expect(h.runs).toHaveLength(1)
    expect(heat.decision?.kind).toBe('none')
    await h.engine.discard(heat.id)
    expect(h.engine.busyPaths()).toContain(h.runs[0]!.cwd)
    expect(git(h.repo, 'branch', '--list', `regatta/heat-${heat.id}-a1`)).not.toBe('')
    expect(existsSync(h.runs[0]!.cwd)).toBe(true)
  }, 60000)

  it('quit while waiting never restarts, scores or removes attempt 1 worktree', async () => {
    const h = harness([{ code: 2 }, {}])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true }))
    await until(() => state(h.engine, id).status === 'waiting')
    const tip = git(h.runs[0]!.cwd, 'rev-parse', 'HEAD')
    h.engine.quit()
    expect(() => h.engine.continue(id)).toThrow('quitting')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(h.runs).toHaveLength(1)
    expect(git(h.runs[0]!.cwd, 'rev-parse', 'HEAD')).toBe(tip)
    expect(h.engine.busyPaths()).toEqual([h.runs[0]!.cwd])
  }, 60000)

  it('discard parks every attempt under refs/regatta/discarded and removes both worktrees and branches', async () => {
    const h = harness([
      { write: ({ cwd }) => change(cwd), code: 2 },
      { write: ({ cwd }) => change(cwd), code: 2 }
    ])
    const heat = await decided(h, { order: ['fake', 'fake'] })
    const w1 = heat.lanes[0]!.worktree!
    const w2 = heat.lanes[1]!.worktree!
    await h.engine.discard(heat.id)
    expect(h.engine.busyPaths()).toEqual([])
    const refs = git(h.repo, 'for-each-ref', '--format=%(refname)', `refs/regatta/discarded/${heat.id}/`).split('\n')
    for (const lane of heat.lanes) {
      const saved = refs.find((ref) => ref.endsWith(`/${lane.id}`))!
      expect(saved).toBeTruthy()
      expect(git(h.repo, 'rev-parse', `${saved}^1`)).toBe(lane.tip)
    }
    expect(git(h.repo, 'rev-list', `refs/regatta/discarded/${heat.id}/${heat.lanes[1]!.id}`)).toContain(heat.lanes[0]!.tip)
    expect(existsSync(w1)).toBe(false)
    expect(existsSync(w2)).toBe(false)
    expect(await listTrash(h.worktrees)).toHaveLength(2)
    await emptyTrash(h.worktrees)
    expect(git(h.repo, 'branch', '--list', `regatta/heat-${heat.id}-*`)).toBe('')
  }, 60000)

  it('shared names are reserved against pre-existing branches and folders', async () => {
    const ids = ['taken001', 'taken002', 'free0003']
    const h = harness([{ write: ({ cwd }) => change(cwd) }], { newId: () => ids.shift()! })
    git(h.repo, 'branch', 'regatta/heat-taken001-a1')
    mkdirSync(join(h.worktrees, 'heat-taken002-a1'))
    writeFileSync(join(h.worktrees, 'heat-taken002-a1', 'USER.txt'), 'precious\n')
    const heat = await decided(h)
    expect(heat.id).toBe('free0003')
    await h.engine.discard(heat.id)
    expect(git(h.repo, 'branch', '--list', 'regatta/heat-taken001-a1')).not.toBe('')
    expect(readFileSync(join(h.worktrees, 'heat-taken002-a1', 'USER.txt'), 'utf8')).toBe('precious\n')
  }, 60000)

  it('checks run only in temporary worktrees and cannot turn tracked edits into a winner', async () => {
    const h = harness([{ write: ({ cwd }) => change(cwd) }])
    const heat = await decided(h, { checks: [{ name: 'fixer', command: 'echo bad >> src/app.js', kind: 'required' }] })
    expect(heat.decision?.kind).toBe('none')
    expect(heat.lanes[0]!.gates.find((gate) => gate.id === 'checks')?.passed).toBe(false)
    expect(readFileSync(join(h.runs[0]!.cwd, 'src', 'app.js'), 'utf8')).not.toContain('bad')
  }, 60000)

  it('history counts each attempted result once, persists per root and survives a new engine', async () => {
    const dataDir = temp()
    const h = harness([{ code: 2 }, { write: ({ cwd }) => change(cwd) }], { dataDir })
    const heat = await decided(h, { order: ['claude', 'codex'] })
    expect(h.engine.handoffHistory()).toEqual({ claude: { wins: 0, fails: 1 }, codex: { wins: 1, fails: 0 } })
    await h.engine.discard(heat.id)
    const reloaded = new HeatEngine(h.deps)
    engines.push(reloaded)
    expect(reloaded.handoffHistory()).toEqual(h.engine.handoffHistory())
    expect(reloaded.handoffHistory(temp())).toEqual({})
    const snapshot = reloaded.handoffHistory()
    snapshot['claude']!.wins = 99
    expect(reloaded.handoffHistory()['claude']!.wins).toBe(0)
  }, 60000)

  it('busyPaths covers baseline, every attempt worktree in preparing, running, checking, waiting and decided', async () => {
    const marks = temp()
    const baseline = join(marks, 'baseline')
    const preparing1 = join(marks, 'preparing1')
    const checking1 = join(marks, 'checking1')
    const preparing2 = join(marks, 'preparing2')
    const h = harness([{ delay: 100, write: ({ cwd }) => change(cwd), code: 2 }, { write: ({ cwd }) => change(cwd) }])
    const setup = [
      'case "$PWD" in',
      `  *-base) echo $$ > '${baseline}'; while [ ! -f '${baseline}.go' ]; do sleep 0.05; done;;`,
      '  *-check) ;;',
      `  *-a1) echo $$ > '${preparing1}'; while [ ! -f '${preparing1}.go' ]; do sleep 0.05; done;;`,
      `  *-a2) echo $$ > '${preparing2}'; while [ ! -f '${preparing2}.go' ]; do sleep 0.05; done;;`,
      'esac'
    ].join('\n')
    const checks: CheckSpec[] = [
      {
        name: 'ok',
        command: `if [ "$(grep -c 'changed by stub' src/app.js)" -eq 1 ]; then echo $$ > '${checking1}'; while [ ! -f '${checking1}.go' ]; do sleep 0.05; done; fi`,
        kind: 'required'
      }
    ]
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true, setup, checks }))
    const baseTree = join(h.worktrees, `heat-${id}-base`)
    const a1 = join(h.worktrees, `heat-${id}-a1`)
    const a2 = join(h.worktrees, `heat-${id}-a2`)
    await until(() => existsSync(baseline))
    expect(h.engine.busyPaths()).toContain(baseTree)
    writeFileSync(`${baseline}.go`, '')

    await until(() => existsSync(preparing1))
    expect(state(h.engine, id).lanes[0]!.phase).toBe('preparing')
    expect(h.engine.busyPaths()).toContain(a1)
    writeFileSync(`${preparing1}.go`, '')

    await until(() => h.runs.length === 1)
    expect(h.engine.busyPaths()).toContain(a1)

    await until(() => existsSync(checking1))
    expect(state(h.engine, id).lanes[0]!.phase).toBe('checking')
    expect(h.engine.busyPaths().sort()).toEqual([a1, `${a1}-check`].sort())
    writeFileSync(`${checking1}.go`, '')

    await until(() => state(h.engine, id).status === 'waiting')
    expect(h.engine.busyPaths()).toEqual([a1])

    h.engine.continue(id)
    await until(() => existsSync(preparing2))
    expect(state(h.engine, id).lanes[1]!.phase).toBe('preparing')
    expect(h.engine.busyPaths().sort()).toEqual([a1, a2].sort())
    writeFileSync(`${preparing2}.go`, '')

    await until(() => state(h.engine, id).status === 'decided')
    expect(h.engine.busyPaths().sort()).toEqual([a1, a2].sort())
    await h.engine.discard(id)
    expect(h.engine.busyPaths()).toEqual([])
  }, 60000)

  it.each(['baseline', 'preparing', 'checking'] as const)('overall deadline aborts %s and does not start another process', async (phase) => {
    const expire = deadlineTrigger()
    const pidFile = join(temp(), 'pid')
    const h = harness([{ write: ({ cwd }) => change(cwd) }, { write: ({ cwd }) => change(cwd) }])
    const wait = `echo $$ > '${pidFile}'; sleep 30`
    const setup =
      phase === 'checking'
        ? ''
        : phase === 'baseline'
          ? `case "$PWD" in *-base) ${wait};; esac`
          : `case "$PWD" in *-base|*-check) ;; *) ${wait};; esac`
    const checks: CheckSpec[] =
      phase === 'checking' ? [{ name: 'slow', command: `if grep -q 'changed by stub' src/app.js; then ${wait}; fi`, kind: 'required' }] : OK
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], overallLimitMin: 30, setup, checks }))
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(isAlive(pid)).toBe(true)
    expire()
    await until(() => !isAlive(pid), 3000)
    await until(() => state(h.engine, id).status === 'decided')
    expect(isAlive(pid)).toBe(false)
    expect(h.runs).toHaveLength(phase === 'checking' ? 1 : 0)
    expect(state(h.engine, id).decision?.kind).toBe('none')
    expect(state(h.engine, id).decision?.note).toContain('overall time limit')
    await h.engine.discard(id)
  }, 60000)

  it('overall deadline wakes an approval wait without launching a backup', async () => {
    const expire = deadlineTrigger()
    const h = harness([{ code: 2 }, {}])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], overallLimitMin: 30, askBeforeNext: true }))
    await until(() => state(h.engine, id).status === 'waiting')
    expire()
    await until(() => state(h.engine, id).status === 'decided')
    expect(h.runs).toHaveLength(1)
    expect(state(h.engine, id).decision?.kind).toBe('none')
    expect(() => h.engine.continue(id)).toThrow('not waiting')
  }, 60000)

  it('cancel during checks stops the check process before discard and keeps the attempt commits', async () => {
    const pidFile = join(temp(), 'pid')
    const h = harness([{ write: ({ cwd }) => change(cwd) }, {}])
    const checks: CheckSpec[] = [
      { name: 'slow', command: `if grep -q 'changed by stub' src/app.js; then echo $$ > '${pidFile}'; sleep 30; fi`, kind: 'required' }
    ]
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], checks }))
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(isAlive(pid)).toBe(true)
    const tip = state(h.engine, id).lanes[0]!.tip!
    await h.engine.discard(id)
    expect(isAlive(pid)).toBe(false)
    expect(h.runs).toHaveLength(1)
    expect(h.engine.busyPaths()).toEqual([])
    expect(git(h.repo, 'rev-list', '--all')).toContain(tip)
  }, 60000)

  it('quit stops an active hand-off without making a scoring commit or backup', async () => {
    const h = harness([{ delay: 60000 }, {}])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'] }))
    await until(() => h.runs.length === 1)
    const cwd = h.runs[0]!.cwd
    const tip = git(cwd, 'rev-parse', 'HEAD')
    change(cwd)
    h.engine.quit()
    expect(h.stopped).toEqual([0])
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(tip)
    expect(state(h.engine, id).lanes[0]!.tip).toBeUndefined()
    expect(h.runs).toHaveLength(1)
    expect(h.engine.busyPaths()).toContain(cwd)
  }, 60000)

function holdCommitAdd(): { started: string; release: () => void; restore: () => void } {
  const bin = temp()
  const started = join(bin, 'add-started')
  const released = join(bin, 'add-released')
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\ncase " $* " in *" --intent-to-add "*) ;; *" add -A "*) : > '${started}'; i=0; while [ ! -e '${released}' ] && [ $i -lt 400 ]; do sleep 0.02; i=$((i+1)); done;; esac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 }
  )
  const saved = process.env['PATH']
  process.env['PATH'] = `${bin}:${saved}`
  return {
    started,
    release: () => writeFileSync(released, ''),
    restore: () => {
      writeFileSync(released, '')
      if (saved === undefined) delete process.env['PATH']
      else process.env['PATH'] = saved
    }
  }
}

  it('scoring after Quit or Cancel during commitAll writes no commit', async () => {
    for (const mode of ['cancel', 'quit'] as const) {
      const h = harness([{ write: ({ cwd }) => writeFileSync(join(cwd, 'work.slow'), 'agent work\n') }, {}])
      const hold = holdCommitAdd()
      try {
        const { id } = await h.engine.start(options({ order: ['fake', 'fake'] }))
        await until(() => existsSync(hold.started))
        const cwd = h.runs[0]!.cwd
        const before = git(cwd, 'rev-parse', 'HEAD')
        expect(state(h.engine, id).lanes[0]!.phase).toBe('checking')
        if (mode === 'cancel') h.engine.cancel(id)
        else h.engine.quit()
        hold.release()
        if (mode === 'cancel') await until(() => state(h.engine, id).lanes[0]!.phase === 'done')
        else await new Promise((resolve) => setTimeout(resolve, 200))
        expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before)
        expect(state(h.engine, id).lanes[0]!.tip).toBeUndefined()
        expect(h.runs).toHaveLength(1)
      } finally {
        hold.restore()
      }
    }
  }, 60000)

  it('a scratch-index failure in the live sampler shows on the lane without an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      for (const mode of ['handoff', 'race'] as const) {
        let indexFile = ''
        let savedIndex: Buffer | null = null
        const h = harness([
          {
            delay: 3800,
            during: ({ cwd }) => {
              const dotGit = readFileSync(join(cwd, '.git'), 'utf8').trim()
              const gitDir = dotGit.replace(/^gitdir:\s*/, '')
              indexFile = join(gitDir, 'index')
              savedIndex = readFileSync(indexFile)
              rmSync(indexFile)
              mkdirSync(indexFile)
              writeFileSync(join(indexFile, 'sentinel'), 'untouched')
            },
            write: ({ cwd }) => {
              if (indexFile && savedIndex) {
                expect(readFileSync(join(indexFile, 'sentinel'), 'utf8')).toBe('untouched')
                rmSync(indexFile, { recursive: true, force: true })
                writeFileSync(indexFile, savedIndex)
              }
              change(cwd)
            }
          },
          { write: ({ cwd }) => change(cwd) }
        ])
        const { id } = await h.engine.start(
          mode === 'handoff' ? options() : options({ mode: 'race', agents: ['fake', 'fake'] })
        )
        await until(() => state(h.engine, id).lanes.some((lane) => Boolean(lane.error)), 10000)
        const duringRun = state(h.engine, id).lanes.find((lane) => Boolean(lane.error))!
        expect(duringRun.error).toMatch(/copyfile|EISDIR|ENOTSUP/i)
        expect(duringRun.latest).toMatch(/copyfile|EISDIR|ENOTSUP/i)
        await until(() => state(h.engine, id).status === 'decided')
        expect(unhandled).toEqual([])
        await h.engine.discard(id)
      }
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  }, 60000)

  it('merge uses the tested SHA when the winning branch moves and preserves the moved branch', async () => {
    const h = harness([{ write: ({ cwd }) => change(cwd) }])
    const heat = await decided(h)
    const lane = heat.lanes[0]!
    const moved = git(h.repo, 'commit-tree', `${heat.base}^{tree}`, '-p', heat.base!, '-m', 'user work')
    git(h.repo, 'update-ref', `refs/heads/${lane.branch}`, moved)
    await h.engine.merge(heat.id, lane.id)
    expect(git(h.repo, 'rev-parse', 'HEAD')).toBe(lane.tip)
    expect(git(h.repo, 'rev-parse', `refs/heads/${lane.branch}`)).toBe(moved)
  }, 60000)

  it('merge refuses an ignored file collision and preserves the original file', async () => {
    const h = harness([
      {
        write: ({ cwd }) => {
          change(cwd)
          writeFileSync(join(cwd, 'cache.txt'), 'agent content')
        }
      }
    ])
    const heat = await decided(h)
    writeFileSync(join(h.repo, '.gitignore'), 'cache.txt\n')
    writeFileSync(join(h.repo, 'cache.txt'), 'precious')
    await expect(h.engine.merge(heat.id, heat.lanes[0]!.id)).rejects.toThrow(/cache.txt/)
    expect(readFileSync(join(h.repo, 'cache.txt'), 'utf8')).toBe('precious')
    expect(git(h.repo, 'rev-parse', 'HEAD')).toBe(heat.base)
    expect(existsSync(h.runs[0]!.cwd)).toBe(true)
  }, 60000)

  it.skipIf(process.platform !== 'darwin')('provided dependency copies are isolated per attempt worktree and never change the project', async () => {
    const h = harness([
      {
        write: ({ cwd }) => {
          change(cwd)
          writeFileSync(join(cwd, 'node_modules', 'value'), 'lead')
        },
        code: 2
      },
      {
        write: ({ cwd }) => {
          expect(readFileSync(join(cwd, 'node_modules', 'value'), 'utf8')).toBe('original')
          change(cwd)
        }
      }
    ])
    mkdirSync(join(h.repo, 'node_modules'))
    writeFileSync(join(h.repo, 'node_modules', 'value'), 'original')
    const heat = await decided(h, {
      order: ['fake', 'fake'],
      checks: [{ name: 'deps', command: 'echo check > node_modules/value', kind: 'required' }]
    })
    expect(heat.decision?.kind).toBe('winner')
    expect(readFileSync(join(h.repo, 'node_modules', 'value'), 'utf8')).toBe('original')
    await h.engine.discard(heat.id)
    expect(h.engine.busyPaths()).toEqual([])
  }, 60000)

  it('a winning lead leaves every backup queued', async () => {
    const h = harness([{ write: ({ cwd }) => change(cwd) }, {}])
    const heat = await decided(h, { order: ['fake', 'codex'] })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(h.runs).toHaveLength(1)
    expect(heat.lanes[1]!.phase).toBe('queued')
    expect(heat.decision?.laneIds).toEqual([heat.lanes[0]!.id])
  }, 60000)

  it('discard directly from waiting cancels before releasing the attempt worktree', async () => {
    const h = harness([{ code: 2 }, {}])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true }))
    await until(() => state(h.engine, id).status === 'waiting')
    await h.engine.discard(id)
    expect(state(h.engine, id).status).toBe('cancelled')
    expect(h.runs).toHaveLength(1)
    expect(h.engine.busyPaths()).toEqual([])
  }, 60000)

  it('discard preserves a user detached commit held only by an attempt worktree', async () => {
    const h = harness([{ code: 2 }, {}])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true }))
    await until(() => state(h.engine, id).status === 'waiting')
    const cwd = h.runs[0]!.cwd
    git(cwd, 'switch', '--detach', 'HEAD')
    expect(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    writeFileSync(join(cwd, 'USER.txt'), 'precious commit\n')
    git(cwd, 'add', 'USER.txt')
    git(cwd, 'commit', '-m', 'detached user work')
    const user = git(cwd, 'rev-parse', 'HEAD')
    expect(git(h.repo, 'for-each-ref', `--contains=${user}`)).toBe('')
    await h.engine.discard(id)
    expect(existsSync(cwd)).toBe(false)
    expect(git(h.repo, 'rev-list', '--all')).toContain(user)
    expect(git(h.repo, 'show', `${user}:USER.txt`)).toBe('precious commit')
  }, 60000)

  it('cancel queued behind the repository lock creates no baseline worktree', async () => {
    const hooks = temp()
    const marker = join(hooks, 'made')
    const h = harness([{}])
    git(h.repo, 'config', 'core.hooksPath', hooks)
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\necho made >> '${marker}'\n`, { mode: 0o755 })
    const trees = join(h.worktrees, 'queued')
    h.deps.worktreesDir = () => trees
    let release!: () => void
    let locked = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const holding = withRepoLock(h.repo, () => {
      locked = true
      return gate
    })
    await until(() => locked)
    let id = ''
    try {
      id = (await h.engine.start(options())).id
      await until(() => existsSync(trees))
      h.engine.cancel(id)
    } finally {
      release()
      await holding
    }
    await h.engine.discard(id)
    expect(existsSync(marker)).toBe(false)
    expect(readdirSync(trees)).toEqual([])
    expect(h.runs).toHaveLength(0)
  }, 60000)

  it.each(['finished', 'changed', 'checks', 'no-regressions', 'integrity'] as const)('every gate matters: %s', async (gate) => {
    const h = harness([
      {
        code: gate === 'finished' ? 2 : 0,
        write: ({ cwd }) => {
          if (gate !== 'changed') change(cwd)
          if (gate === 'integrity') rmSync(join(cwd, 'app.test.js'))
          if (gate === 'no-regressions') rmSync(join(cwd, 'GUARD.txt'))
        }
      }
    ])
    writeFileSync(join(h.repo, 'GUARD.txt'), 'guard\n')
    git(h.repo, 'add', 'GUARD.txt')
    git(h.repo, 'commit', '-m', 'guard')
    const checks: CheckSpec[] = [
      { name: 'ok', command: gate === 'checks' ? 'test -f missing.txt' : 'true', kind: 'required' },
      { name: 'guard', command: 'test -f GUARD.txt', kind: 'guard' }
    ]
    const heat = await decided(h, { checks })
    expect(heat.lanes[0]!.gates.find((result) => result.id === gate)?.passed).toBe(false)
    expect(heat.decision?.kind).toBe('none')
  }, 60000)

  it('validates hand-off attempts and finite positive time limits', async () => {
    const h = harness([])
    for (const patch of [{ order: [] }, { order: Array(5).fill('fake') }, { attemptLimitMin: 0 }, { attemptLimitMin: NaN }, { overallLimitMin: 1 }]) {
      await expect(h.engine.start(options(patch))).rejects.toThrow()
    }
    expect(h.runs).toHaveLength(0)
  })

  it('a user edit in attempt 1 worktree while waiting is committed and carried into attempt 2', async () => {
    const h = harness([
      { write: ({ cwd }) => change(cwd), code: 2 },
      {
        write: ({ cwd }) => {
          expect(readFileSync(join(cwd, 'src', 'app.js'), 'utf8')).toContain('// user draft')
          expect(readFileSync(join(cwd, 'USER_ADDED.txt'), 'utf8')).toBe('from user\n')
          change(cwd)
        }
      }
    ])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true }))
    await until(() => state(h.engine, id).status === 'waiting')
    const w1 = h.runs[0]!.cwd
    appendFileSync(join(w1, 'src', 'app.js'), '// user draft\n')
    writeFileSync(join(w1, 'USER_ADDED.txt'), 'from user\n')
    h.engine.continue(id)
    await until(() => state(h.engine, id).status === 'decided')
    const heat = state(h.engine, id)
    expect(h.runs).toHaveLength(2)
    expect(heat.notes).toContain('Your changes were saved after attempt 1.')
    expect(heat.decision).toMatchObject({ kind: 'winner', laneIds: [heat.lanes[1]!.id] })
    expect(h.runs[1]!.prompt).toContain('2 files changed, 3 insertion(+), 0 deletion(-)')
    const branch1 = `refs/heads/regatta/heat-${id}-a1`
    const saved = git(h.repo, 'log', '--format=%H %s', branch1)
      .split('\n')
      .find((line) => line.endsWith('Your changes after attempt 1'))
    expect(saved).toBeTruthy()
    const savedCommit = saved!.split(' ')[0]!
    expect(git(h.repo, 'show', `${savedCommit}:src/app.js`)).toContain('user draft')
    expect(git(h.repo, 'show', `${savedCommit}:USER_ADDED.txt`)).toBe('from user')
    expect(git(h.repo, 'rev-parse', `${heat.lanes[1]!.tip!}^1`)).toBe(savedCommit)

    const result = await h.engine.merge(heat.id, heat.lanes[1]!.id)
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')
    expect(readFileSync(join(h.repo, 'src', 'app.js'), 'utf8')).toContain('// user draft')
    expect(readFileSync(join(h.repo, 'USER_ADDED.txt'), 'utf8')).toBe('from user\n')
  }, 60000)

  it('a file the user staged and then deleted while waiting is committed and survives gc', async () => {
    const h = harness([{ write: ({ cwd }) => change(cwd), code: 2 }, { code: 2 }])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true }))
    await until(() => state(h.engine, id).status === 'waiting')
    const cwd = h.runs[0]!.cwd
    writeFileSync(join(cwd, 'DRAFT.txt'), 'precious staged draft\n')
    git(cwd, 'add', 'DRAFT.txt')
    rmSync(join(cwd, 'DRAFT.txt'))
    h.engine.continue(id)
    await until(() => state(h.engine, id).status === 'decided')
    const heat = state(h.engine, id)
    expect(h.runs).toHaveLength(2)
    expect(heat.notes).toContain('Your changes were saved after attempt 1.')
    const branchRef = `refs/heads/regatta/heat-${id}-a2`
    const messages = git(h.repo, 'log', '--format=%s', branchRef)
    expect(messages).toContain('Your changes after attempt 1 (staged changes)')
    expect(messages).toContain('Your changes after attempt 1')
    const kept = git(h.repo, 'log', '--format=%H %s', branchRef)
      .split('\n')
      .find((line) => line.endsWith('Your changes after attempt 1 (staged changes)'))!
      .split(' ')[0]!
    expect(git(h.repo, 'show', `${kept}:DRAFT.txt`)).toBe('precious staged draft')
    expect(git(h.repo, 'rev-list', branchRef)).toContain(kept)
    const blob = git(h.repo, 'rev-parse', `${kept}:DRAFT.txt`)
    git(h.repo, 'reflog', 'expire', '--all', '--expire=now', '--expire-unreachable=now', '--rewrite')
    git(h.repo, 'gc', '--prune=now')
    expect(git(h.repo, 'cat-file', '-e', blob)).toBe('')
    expect(git(h.repo, 'ls-tree', '--name-only', branchRef)).not.toContain('DRAFT.txt')
    expect(existsSync(join(cwd, 'DRAFT.txt'))).toBe(false)
  }, 60000)

  it('a merge the user left in progress in attempt 1 worktree stops the hand-off without touching the merge', async () => {
    const h = harness([{ write: ({ cwd }) => change(cwd), code: 2 }, { write: ({ cwd }) => change(cwd) }])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true }))
    await until(() => state(h.engine, id).status === 'waiting')
    const cwd = h.runs[0]!.cwd
    const branch = `regatta/heat-${id}-a1`
    git(cwd, 'switch', '-c', 'users-side')
    writeFileSync(join(cwd, 'src', 'app.js'), 'export const app = 2\n')
    git(cwd, 'commit', '-am', 'side edit')
    git(cwd, 'switch', branch)
    writeFileSync(join(cwd, 'src', 'app.js'), "export const app = 'mine'\n")
    git(cwd, 'commit', '-am', 'branch edit')
    try {
      git(cwd, 'merge', 'users-side')
    } catch {
      // Leave the conflict in progress.
    }
    const conflicted = readFileSync(join(cwd, 'src', 'app.js'), 'utf8')
    expect(conflicted).toContain('<<<<<<<')
    const before = git(cwd, 'rev-parse', 'HEAD')
    h.engine.continue(id)
    await until(() => state(h.engine, id).status === 'decided')
    const heat = state(h.engine, id)
    expect(heat.decision?.kind).toBe('none')
    expect(heat.decision?.note).toContain('merge is in progress')
    expect(h.runs).toHaveLength(1)
    expect(git(h.repo, 'log', '--format=%s', `refs/heads/${branch}`)).not.toContain('Your changes after attempt 1')
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before)
    expect(existsSync(join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'))).toBe(true)
    expect(readFileSync(join(cwd, 'src', 'app.js'), 'utf8')).toBe(conflicted)
    expect(existsSync(cwd)).toBe(true)
    expect(h.engine.busyPaths()).toContain(cwd)
  }, 60000)

  it('an ignored draft, an assume-unchanged edit and a nested repository in attempt 1 worktree are never touched and keep it at discard while attempt 2 runs in its own worktree', async () => {
    const h = harness([
      { write: ({ cwd }) => change(cwd), code: 2 },
      { write: ({ cwd }) => change(cwd) }
    ])
    writeFileSync(join(h.repo, '.gitignore'), 'drafts/\n')
    writeFileSync(join(h.repo, 'keep.txt'), 'committed\n')
    git(h.repo, 'add', '.gitignore', 'keep.txt')
    git(h.repo, 'commit', '-m', 'ignore drafts and track keep')

    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true }))
    await until(() => state(h.engine, id).status === 'waiting')
    const w1 = h.runs[0]!.cwd

    // 1. Ignored draft
    mkdirSync(join(w1, 'drafts'))
    writeFileSync(join(w1, 'drafts', 'idea.md'), 'precious ignored draft\n')
    // 2. assume-unchanged edit
    git(w1, 'update-index', '--assume-unchanged', 'keep.txt')
    appendFileSync(join(w1, 'keep.txt'), 'precious hidden edit\n')
    // 3. Nested git repository
    mkdirSync(join(w1, 'planned'))
    git(join(w1, 'planned'), 'init', '-q', '-b', 'main')
    writeFileSync(join(w1, 'planned', 'plan.md'), 'precious nested work\n')
    git(join(w1, 'planned'), 'add', 'plan.md')
    git(join(w1, 'planned'), 'commit', '-qm', 'nested commit')
    const nested = git(join(w1, 'planned'), 'rev-parse', 'HEAD')

    const w1BeforeAttempt2 = snapshotWorktreeAndIndex(w1)

    h.engine.continue(id)
    await until(() => state(h.engine, id).status === 'decided')
    const heat = state(h.engine, id)
    const w2 = heat.lanes[1]!.worktree!

    // Attempt 2 ran in its own fresh worktree and won.
    expect(h.runs).toHaveLength(2)
    expect(w2).not.toBe(w1)
    expect(heat.decision).toMatchObject({ kind: 'winner', laneIds: [heat.lanes[1]!.id] })

    // Attempt 1's worktree and index were never touched at all.
    expect(snapshotWorktreeAndIndex(w1)).toBe(w1BeforeAttempt2)

    // At discard, both attempt worktrees move into Regatta's trash, and attempt 1's trashed worktree keeps all three items intact.
    await h.engine.discard(id)
    expect(existsSync(w2)).toBe(false)
    expect(existsSync(w1)).toBe(false)
    expect(h.engine.busyPaths()).toEqual([])
    const trashed = (await listTrash(h.worktrees)).find((e) => e.trashPath.endsWith(`heat-${id}-a1`))!.trashPath
    expect(readFileSync(join(trashed, 'drafts', 'idea.md'), 'utf8')).toBe('precious ignored draft\n')
    expect(readFileSync(join(trashed, 'keep.txt'), 'utf8')).toContain('precious hidden edit')
    expect(git(trashed, 'ls-files', '-v', 'keep.txt')).toMatch(/^[a-z]/)
    expect(existsSync(join(trashed, 'planned', '.git'))).toBe(true)
    expect(git(join(trashed, 'planned'), 'show', `${nested}:plan.md`)).toBe('precious nested work')
  }, 60000)

  it('the live diff sampler does not erase a staged-then-deleted index entry during a running backup', async () => {
    const snapshot = join(temp(), 'index-after-sampler.txt')
    const h = harness([
      { write: ({ cwd }) => change(cwd), code: 2 },
      {
        delay: 2600,
        code: 2,
        during: ({ cwd }) => {
          writeFileSync(join(cwd, 'DRAFT.txt'), 'precious staged draft\n')
          git(cwd, 'add', 'DRAFT.txt')
          rmSync(join(cwd, 'DRAFT.txt'))
        },
        write: ({ cwd }) => writeFileSync(snapshot, git(cwd, 'ls-files', '-s', 'DRAFT.txt'))
      }
    ])
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true }))
    await until(() => state(h.engine, id).status === 'waiting')
    h.engine.continue(id)
    await until(() => state(h.engine, id).status === 'decided')
    expect(readFileSync(snapshot, 'utf8')).toMatch(/^100644 [0-9a-f]{40} 0\tDRAFT\.txt$/)
    const branchRef = `refs/heads/regatta/heat-${id}-a2`
    const kept = git(h.repo, 'log', '--format=%H %s', branchRef)
      .split('\n')
      .find((line) => line.endsWith('DRAFT.txt (staged changes)') || line.endsWith('(staged changes)'))!
      .split(' ')[0]!
    const blob = git(h.repo, 'rev-parse', `${kept}:DRAFT.txt`)
    git(h.repo, 'reflog', 'expire', '--all', '--expire=now', '--expire-unreachable=now', '--rewrite')
    git(h.repo, 'gc', '--prune=now')
    expect(git(h.repo, 'cat-file', 'blob', blob)).toBe('precious staged draft')
  }, 60000)

  it('quit during user-change commit between attempts writes no commit, decides nothing and updates no history', async () => {
    const dataDir = temp()
    const h = harness([{ write: ({ cwd }) => change(cwd), code: 2 }, { write: ({ cwd }) => change(cwd) }], { dataDir })
    const { id } = await h.engine.start(options({ order: ['fake', 'fake'], askBeforeNext: true }))
    await until(() => state(h.engine, id).status === 'waiting')
    const cwd = h.runs[0]!.cwd
    const before = git(cwd, 'rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'payload.slow'), 'precious unsaved work\n')
    const hold = holdCommitAdd()
    try {
      h.engine.continue(id)
      await until(() => existsSync(hold.started))
      h.engine.quit()
      hold.release()
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before)
      expect(git(h.repo, 'log', '--format=%s', `refs/heads/regatta/heat-${id}-a1`)).not.toContain('Your changes after attempt 1')
      expect(h.runs).toHaveLength(1)
      expect(state(h.engine, id).decision).toBeNull()
      expect(h.engine.handoffHistory()).toEqual({})
      expect(existsSync(join(dataDir, 'handoff-history.json'))).toBe(false)
      expect(readFileSync(join(cwd, 'payload.slow'), 'utf8')).toBe('precious unsaved work\n')
    } finally {
      hold.restore()
    }
  }, 60000)

  it('each attempt worktree is busy from before its creation, through a held post-checkout hook', async () => {
    const hooks = temp()
    const held = join(hooks, 'held')
    const h = harness([{ write: ({ cwd }) => change(cwd) }])
    git(h.repo, 'config', 'core.hooksPath', hooks)
    writeFileSync(
      join(hooks, 'post-checkout'),
      `#!/bin/sh\ncase "$(basename "$PWD")" in *-base) exit 0;; esac\necho "$$" > '${held}'\nwhile [ ! -f '${held}.go' ]; do sleep 0.05; done\n`,
      { mode: 0o755 }
    )
    const { id } = await h.engine.start(options())
    const attemptTree = join(h.worktrees, `heat-${id}-a1`)
    await until(() => existsSync(held))
    const listed = git(h.repo, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).replace(/^\/private\/tmp/, '/tmp'))
    expect(listed).toContain(attemptTree)
    expect(state(h.engine, id).lanes[0]!.phase).toBe('preparing')
    expect(h.engine.busyPaths()).toContain(attemptTree)
    writeFileSync(`${held}.go`, '')
    await until(() => state(h.engine, id).status === 'decided')
    expect(state(h.engine, id).decision?.kind).toBe('winner')
    await h.engine.discard(id)
    expect(h.engine.busyPaths()).toEqual([])
    expect(existsSync(attemptTree)).toBe(false)
  }, 60000)
})

describe('hand-off continuation and submodules', () => {
  it('reads what changed without entering a submodule, so its clean filter never runs (sol-loop S6)', async () => {
    const { engine } = harness([])
    const base = temp()
    const sub = join(base, 'sub')
    mkdirSync(sub)
    git(sub, 'init', '-b', 'main')
    writeFileSync(join(sub, '.gitattributes'), '*.txt filter=f\n')
    writeFileSync(join(sub, 'a.txt'), 'one\n')
    git(sub, 'add', '-A')
    git(sub, 'commit', '-m', 'sub')
    const repo = join(base, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    writeFileSync(join(repo, 'top.txt'), 'x\n')
    git(base, 'clone', '-q', sub, join(repo, 'sm'))
    git(repo, '-c', 'advice.addEmbeddedRepo=false', 'add', '-A')
    git(repo, 'commit', '-m', 'with submodule')
    const marker = join(base, 'sub-filter-ran')
    const filter = join(base, 'strip.sh')
    writeFileSync(filter, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 })
    git(join(repo, 'sm'), 'config', 'filter.f.clean', filter)
    const future = new Date(Date.now() + 10_000)
    utimesSync(join(repo, 'sm', 'a.txt'), future, future)
    writeFileSync(join(repo, 'top.txt'), 'changed\n')

    const read = (engine as unknown as {
      committableChanges: (runtime: { modules: Map<string, unknown> }, worktree: string) => Promise<{ hasChanges: boolean }>
    }).committableChanges.bind(engine)
    expect((await read({ modules: new Map() }, repo)).hasChanges).toBe(true)
    expect(existsSync(marker)).toBe(false)
  }, 30_000)
})

describe('suggestOrder', () => {
  const installed: AgentKind[] = ['fake', 'codex', 'claude', 'gemini']
  it('uses the fixed preference rankings, filters unavailable agents and deduplicates', () => {
    expect(suggestOrder('quality', [...installed, 'claude'], {})).toEqual(['claude', 'codex', 'gemini', 'fake'])
    expect(suggestOrder('speed', installed, {})).toEqual(['gemini', 'codex', 'claude', 'fake'])
    expect(suggestOrder('balanced', installed, {})).toEqual(['codex', 'claude', 'gemini', 'fake'])
  })
  it('moves up or down one actual position per two net wins or failures', () => {
    expect(suggestOrder('quality', installed, { codex: { wins: 2, fails: 0 } })).toEqual(['codex', 'claude', 'gemini', 'fake'])
    expect(suggestOrder('quality', installed, { claude: { wins: 0, fails: 2 } })).toEqual(['codex', 'claude', 'gemini', 'fake'])
    expect(suggestOrder('quality', installed, { codex: { wins: 2, fails: 1 } })).toEqual(['claude', 'codex', 'gemini', 'fake'])
  })
})
