// Things that happen to the repository in the middle of a night merge, and processes that cannot be
// stopped. The git helpers and the check runner are real; a few are wrapped so a test can act at the
// exact moment between two steps.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '../../shared/agents'
import type { CheckSpec } from '../../shared/heats'
import type { NightTask, NightTaskRun } from '../../shared/nightwatch'
import type { AgentKind } from '../../shared/types'
import { emptyTrash } from '../heats/git-ops'
import { NightWatch as RealNightWatch } from './engine'
import type { NightWatchDeps } from './engine'
import type { RunHandle, RunOptions } from '../heats/runner'

const hooks = vi.hoisted(() => ({
  /** Runs right after the engine's own ancestry check, before it removes anything. */
  afterAncestryCheck: null as null | (() => void),
  /** Runs inside the merge, after the merge commit exists and right before the final recheck and write. */
  beforeWrite: null as null | (() => void),
  /** Runs right after the branch and commit were recorded for a merge, before it waits for the repository lock. */
  afterCapture: null as null | (() => void),
  /** Runs right after the check for an existing branch, while a worktree is being made. */
  afterBranchCheck: null as null | ((branch: string, root: string) => void),
  /** Makes the checks that ran in a folder whose name ends like this report a process that could not be stopped. */
  stuckIn: null as null | string,
  /** Runs right after the engine looked at which branch a run's folder is on, when it is about to be scored. */
  afterCurrentBranch: null as null | (() => void),
  /** Runs right after the engine measured the committed change of a run, when it is about to make the folder for its checks. */
  afterDiffBetween: null as null | (() => void),
  /** Runs right after git made the folder of a run. */
  afterAddWorktree: null as null | (() => void),
  /** Runs right after git made a detached folder (the baseline, or the one checks run in), with its path. */
  afterAddDetached: null as null | ((path: string) => void),
  /** Every folder the engine asked to have the project's dependencies copied into. */
  provided: [] as string[],
  /** Makes the copy into a folder whose name ends like this fail (it says it could not, and copies nothing). */
  noModulesIn: null as null | string
}))

vi.mock('../heats/git-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../heats/git-ops')>()
  return {
    ...actual,
    isAncestor: async (...args: Parameters<typeof actual.isAncestor>) => {
      const result = await actual.isAncestor(...args)
      hooks.afterAncestryCheck?.()
      return result
    },
    branchExists: async (cwd: string, branch: string) => {
      const result = await actual.branchExists(cwd, branch)
      hooks.afterBranchCheck?.(branch, cwd)
      return result
    },
    currentBranch: async (...args: Parameters<typeof actual.currentBranch>) => {
      const result = await actual.currentBranch(...args)
      hooks.afterCurrentBranch?.()
      return result
    },
    diffBetween: async (...args: Parameters<typeof actual.diffBetween>) => {
      const result = await actual.diffBetween(...args)
      hooks.afterDiffBetween?.()
      return result
    },
    addWorktree: async (...args: Parameters<typeof actual.addWorktree>) => {
      const result = await actual.addWorktree(...args)
      hooks.afterAddWorktree?.()
      return result
    },
    addDetachedWorktree: async (...args: Parameters<typeof actual.addDetachedWorktree>) => {
      const result = await actual.addDetachedWorktree(...args)
      hooks.afterAddDetached?.(args[1])
      return result
    },
    provideModules: async (...args: Parameters<typeof actual.provideModules>) => {
      hooks.provided.push(args[1])
      if (hooks.noModulesIn && args[1].endsWith(hooks.noModulesIn)) {
        return { clone: null, note: 'Dependencies were not copied into the worktree; run your install command there.' }
      }
      return actual.provideModules(...args)
    },
    captureTarget: async (...args: Parameters<typeof actual.captureTarget>) => {
      const captured = await actual.captureTarget(...args)
      hooks.afterCapture?.()
      return captured
    },
    mergeIntoCurrentBranch: async (...args: Parameters<typeof actual.mergeIntoCurrentBranch>) => {
      const [root, sha, message, captured, opts] = args
      return actual.mergeIntoCurrentBranch(root, sha, message, captured, {
        ...opts,
        beforeWrite: () => {
          hooks.beforeWrite?.()
        }
      })
    }
  }
})

vi.mock('../heats/checks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../heats/checks')>()
  return {
    ...actual,
    runChecks: async (...args: Parameters<typeof actual.runChecks>) => {
      const results = await actual.runChecks(...args)
      const folder = args[1]
      return hooks.stuckIn && folder.endsWith(hooks.stuckIn) ? results.map((result) => ({ ...result, stuck: true })) : results
    }
  }
})

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']
const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }
const CHECKS: CheckSpec[] = [
  { name: 'done', command: 'test -f DONE.txt', kind: 'required' },
  { name: 'guard', command: 'test -f GUARD.txt', kind: 'guard' }
]

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
}

const dirs: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Every engine this file made. They are stopped before their folders are removed, or they would make the folders again. */
const engines: NightWatch[] = []
class NightWatch extends RealNightWatch {
  constructor(deps: NightWatchDeps) {
    super(deps)
    engines.push(this)
  }
}

/** Stops every engine this file made and waits for it to finish what it was doing, then removes the folders it used. */
async function cleanUp(): Promise<void> {
  for (const engine of engines.splice(0)) {
    let timer: NodeJS.Timeout | undefined
    try {
      engine.cancel()
      await Promise.race([
        engine.whenIdle(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000)
        })
      ])
    } catch {
      // Its folders may be gone, or blocked by the test itself: nothing more can be done for it.
    } finally {
      clearTimeout(timer)
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

beforeEach(() => {
  hooks.afterAncestryCheck = null
  hooks.beforeWrite = null
  hooks.afterCapture = null
  hooks.afterBranchCheck = null
  hooks.stuckIn = null
  hooks.afterCurrentBranch = null
  hooks.afterDiffBetween = null
  hooks.afterAddWorktree = null
  hooks.afterAddDetached = null
  hooks.provided = []
  hooks.noModulesIn = null
})
afterAll(cleanUp)

/** The claude agent writes the change; the codex agent writes nothing. Both finish at once. */
function fakeRun(opts: RunOptions): RunHandle {
  opts.onActivity('working')
  opts.onTokens(1)
  if (opts.agent === 'claude') {
    writeFileSync(join(opts.cwd, 'DONE.txt'), 'done\n')
    appendFileSync(join(opts.cwd, 'src', 'app.js'), '// changed by the agent\n')
  }
  return { done: Promise.resolve({ exitCode: 0, durationMs: 50, tokens: 1, stopped: false }), stop: () => undefined }
}

function task(agent: AgentKind): Omit<NightTask, 'id' | 'createdAt'> {
  return { prompt: `change app with ${agent}`, agent, checks: CHECKS }
}

interface Finished {
  deps: NightWatchDeps
  engine: NightWatch
  repo: string
  worktrees: string
  nightId: string
  /** The claude task, which passed every gate. */
  run: NightTaskRun
  /** The codex task, which changed nothing. */
  other: NightTaskRun
}

function makeRepo(): string {
  const repo = temp('regatta-night-interleave-')
  sh(['init', '-b', 'main'], repo)
  sh(['config', 'user.name', 'Regatta Test'], repo)
  sh(['config', 'user.email', 'test@regatta.local'], repo)
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'GUARD.txt'), 'guard\n')
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
  sh(['add', '.'], repo)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], repo)
  return repo
}

async function finishedNight(wt: string = temp('regatta-night-interleave-wt-')): Promise<Finished> {
  const repo = makeRepo()
  const kinds: AgentKind[] = ['claude', 'codex']
  const deps: NightWatchDeps = {
    dataDir: temp('regatta-night-interleave-data-'),
    root: () => repo,
    env: () => ENV,
    agents: () => kinds.map((kind) => ({ ...AGENTS[kind], installed: true, path: `/usr/bin/${AGENTS[kind].command}`, version: '1' })),
    run: fakeRun,
    emit: () => undefined,
    keepAwake: () => undefined,
    worktreesDir: () => wt
  }
  const engine = new NightWatch(deps)
  engine.addTask(task('claude'))
  engine.addTask(task('codex'))
  const nightId = (await engine.schedule('now')).nights[0]!.id
  const started = Date.now()
  while (engine.state().nights[0]?.status !== 'finished') {
    if (Date.now() - started > 60000) throw new Error('night did not finish')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const [run, other] = engine.state().nights[0]!.runs
  return { deps, engine, repo, worktrees: wt, nightId, run: run!, other: other! }
}

function runNow(night: Finished): NightTaskRun {
  return night.engine.state().nights[0]!.runs.find((r) => r.id === night.run.id)!
}

function branches(repo: string): string[] {
  return sh(['branch', '--list', 'regatta/night-*', '--format=%(refname:short)'], repo).trim().split('\n').filter(Boolean)
}

describe('a branch that moves after the merge was checked', () => {
  it('is kept with the trashed worktree, not force-deleted, and the tested commit is merged', async () => {
    const night = await finishedNight()
    const { engine, repo, run } = night
    let moved = ''
    hooks.afterCapture = () => {
      // Someone commits to the run's branch between the check and the cleanup.
      moved = sh([...IDENTITY, 'commit-tree', `${run.branch}^{tree}`, '-p', run.branch!, '-m', 'late work'], repo).trim()
      sh(['update-ref', `refs/heads/${run.branch}`, moved], repo)
      hooks.afterCapture = null
    }
    const result = await engine.merge(run.id)
    expect(result.merged).toBe(true)
    expect(moved).not.toBe('')
    expect(sh(['rev-parse', run.branch!], repo).trim()).toBe(moved)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(result.summary).toContain(`Its branch ${run.branch} stays until you empty the trash in Settings > Storage.`)
  }, 90000)
})

describe('things the user does in the middle of a merge', () => {
  it('a merge the user starts at the same moment is refused and left alone', async () => {
    const night = await finishedNight()
    const { engine, repo, run } = night
    // The folder moves on, so Regatta needs a merge commit; a topic branch conflicts with the folder's own work.
    writeFileSync(join(repo, 'NOTES.txt'), 'base\n')
    sh(['add', 'NOTES.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'notes'], repo)
    sh(['checkout', '-q', '-b', 'topic'], repo)
    writeFileSync(join(repo, 'NOTES.txt'), 'topic\n')
    sh([...IDENTITY, 'commit', '-am', 'topic'], repo)
    sh(['checkout', '-q', 'main'], repo)
    writeFileSync(join(repo, 'NOTES.txt'), 'main\n')
    sh([...IDENTITY, 'commit', '-am', 'main'], repo)

    hooks.beforeWrite = () => {
      // The user starts a merge of their own right before Regatta writes.
      try {
        sh([...IDENTITY, 'merge', 'topic'], repo)
      } catch {
        // It conflicts, which is the point: MERGE_HEAD is now the user's.
      }
      hooks.beforeWrite = null
    }
    const mergeHead = join(repo, '.git', 'MERGE_HEAD')
    await expect(engine.merge(run.id)).rejects.toThrow(/merge is already in progress/)
    // The user's merge is still there, with its conflict, and nothing was deleted.
    expect(existsSync(mergeHead)).toBe(true)
    expect(readFileSync(mergeHead, 'utf8').trim()).toBe(sh(['rev-parse', 'topic'], repo).trim())
    expect(sh(['status', '--porcelain'], repo)).toContain('UU NOTES.txt')
    expect(runNow(night).status).toBe('ready')
    expect(runNow(night).note).toContain('Not merged:')
    expect(existsSync(run.worktree!)).toBe(true)
    expect(branches(repo)).toContain(run.branch)
  }, 90000)

  it('an ignored file made after every check is not overwritten', async () => {
    const night = await finishedNight()
    const { engine, repo, run } = night
    writeFileSync(join(repo, 'LATER.txt'), 'later\n')
    sh(['add', 'LATER.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'work in the folder'], repo)
    hooks.beforeWrite = () => {
      writeFileSync(join(repo, 'DONE.txt'), 'precious\n')
      writeFileSync(join(repo, '.git', 'info', 'exclude'), 'DONE.txt\n')
      hooks.beforeWrite = null
    }
    const before = sh(['rev-parse', 'HEAD'], repo).trim()
    await expect(engine.merge(run.id)).rejects.toThrow(/DONE\.txt|overwrite/)
    expect(readFileSync(join(repo, 'DONE.txt'), 'utf8')).toBe('precious\n')
    expect(sh(['rev-parse', 'HEAD'], repo).trim()).toBe(before)
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(runNow(night).status).toBe('ready')
  }, 90000)

  it('a branch switched right after the merge was asked for, before it gets the lock, receives nothing', async () => {
    const night = await finishedNight()
    const { engine, repo, run } = night
    hooks.afterCapture = () => {
      sh(['checkout', '-q', '-b', 'feature'], repo)
      hooks.afterCapture = null
    }
    await expect(engine.merge(run.id)).rejects.toThrow(/feature now, not main/)
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim()).toBe('feature')
    expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
    expect(runNow(night).status).toBe('ready')
    expect(runNow(night).note).toContain('feature now, not main')
    // Back on main, the same merge goes through.
    sh(['checkout', '-q', 'main'], repo)
    expect((await engine.merge(run.id)).merged).toBe(true)
  }, 90000)

  it('a head that moved after the merge was asked for, onto work the merge would conflict with, refuses it', async () => {
    const night = await finishedNight()
    const { engine, repo, run } = night
    let moved = ''
    hooks.afterCapture = () => {
      // The user commits work that conflicts with the run's change, after it was asked for and before it gets the lock.
      appendFileSync(join(repo, 'src', 'app.js'), '// made in the folder\n')
      sh([...IDENTITY, 'commit', '-am', 'conflicting work'], repo)
      moved = sh(['rev-parse', 'HEAD'], repo).trim()
      hooks.afterCapture = null
    }
    await expect(engine.merge(run.id)).rejects.toThrow(/main moved on since the merge was asked for/)
    expect(sh(['rev-parse', 'HEAD'], repo).trim()).toBe(moved)
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(sh(['status', '--porcelain'], repo).trim()).toBe('')
    expect(readFileSync(join(repo, 'src', 'app.js'), 'utf8')).not.toContain('changed by the agent')
    expect(runNow(night).status).toBe('ready')
    expect(existsSync(run.worktree!)).toBe(true)
    expect(branches(repo)).toContain(run.branch)
    // Asked again, it is judged on the new state of the branch: now it is the conflict that refuses it.
    await expect(engine.merge(run.id)).rejects.toThrow(/conflicts with work in main/)
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
  }, 90000)

  it('a branch switched after the merge was asked for refuses the merge', async () => {
    const night = await finishedNight()
    const { engine, repo, run } = night
    hooks.beforeWrite = () => {
      sh(['checkout', '-q', '-b', 'elsewhere'], repo)
      hooks.beforeWrite = null
    }
    writeFileSync(join(repo, 'LATER.txt'), 'later\n')
    sh(['add', 'LATER.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'work in the folder'], repo)
    await expect(engine.merge(run.id)).rejects.toThrow(/elsewhere now, not main/)
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim()).toBe('elsewhere')
    expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
    expect(runNow(night).status).toBe('ready')
  }, 90000)

  it('an edit to a tracked file made after the merge was asked for refuses it, and the edit stays', async () => {
    const night = await finishedNight()
    const { engine, repo, run } = night
    hooks.afterCapture = () => {
      writeFileSync(join(repo, 'GUARD.txt'), 'guard\nedited after the merge was asked for\n')
      hooks.afterCapture = null
    }
    await expect(engine.merge(run.id)).rejects.toThrow('Commit or stash your changes first.')
    expect(readFileSync(join(repo, 'GUARD.txt'), 'utf8')).toBe('guard\nedited after the merge was asked for\n')
    expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(runNow(night).status).toBe('ready')
  }, 90000)
})

describe('a folder that appears while a worktree is being made', () => {
  it('is not claimed: the run fails and the folder stays', async () => {
    const wt = temp('regatta-night-interleave-wt-')
    hooks.afterBranchCheck = (branch) => {
      // Between the checks and git, someone makes the (empty) folder of the codex run.
      if (branch.endsWith('-codex')) mkdirSync(join(wt, `night-${branch.slice('regatta/night-'.length)}`))
    }
    const night = await finishedNight(wt)
    hooks.afterBranchCheck = null
    const state = night.engine.state().nights[0]!
    const [claude, codex] = state.runs
    expect(codex!.status).toBe('failed')
    expect(codex!.note).toContain('is already there')
    expect(codex!.worktree).toBeNull()
    expect(claude!.status).toBe('ready')

    await night.engine.discard(codex!.id)
    expect(readdirSync(wt).sort()).toEqual([`night-${night.nightId}-claude`, `night-${night.nightId}-codex`])
    expect(sh(['worktree', 'list'], night.repo).trim().split('\n')).toHaveLength(2)
  }, 90000)
})

describe('a branch that appears while a worktree is being made', () => {
  it('makes git fail to fill the folder: the empty folder is taken away again, it is not listed, and the branch stays', async () => {
    hooks.afterBranchCheck = (branch, root) => {
      // Between the check and git, someone makes the branch of the claude run.
      if (branch.endsWith('-claude')) sh(['branch', branch, 'main'], root)
    }
    const night = await finishedNight()
    hooks.afterBranchCheck = null
    const [claude, codex] = night.engine.state().nights[0]!.runs
    const folder = join(night.worktrees, `night-${night.nightId}-claude`)
    // It was git, not the check before it, that said no.
    expect(claude!.status).toBe('failed')
    expect(claude!.note).toContain('already exists')
    expect(claude!.note).not.toContain('so it was left alone')
    expect(claude!.worktree).toBeNull()
    expect(existsSync(folder)).toBe(false)
    expect(night.engine.busyPaths()).toEqual([codex!.worktree])
    // The branch someone made is theirs, and discarding the run does not touch it.
    await night.engine.discard(claude!.id)
    expect(sh(['branch', '--list', `regatta/night-${night.nightId}-claude`], night.repo).trim()).not.toBe('')
    expect(night.engine.busyPaths()).toEqual([codex!.worktree])
  }, 90000)
})

/** A night that is only started, not waited for, with its engine in hand so that a hook can act on it. */
function startableNight(checks: CheckSpec[]): {
  engine: NightWatch
  repo: string
  worktrees: string
  dataDir: string
  deps: NightWatchDeps
  awake: boolean[]
  runs: RunOptions[]
  start: () => Promise<string>
  /** Resolves once the night has wound down (the computer was let go that many times) and a moment has passed. */
  over: (letGos?: number) => Promise<void>
  /** The statuses in memory: the night's, then each run's. */
  statuses: () => string[]
} {
  const repo = makeRepo()
  const worktrees = temp('regatta-night-interleave-wt-')
  const dataDir = temp('regatta-night-interleave-data-')
  const awake: boolean[] = []
  const runs: RunOptions[] = []
  const kinds: AgentKind[] = ['claude', 'codex']
  const deps: NightWatchDeps = {
    dataDir,
    root: () => repo,
    env: () => ENV,
    agents: () => kinds.map((kind) => ({ ...AGENTS[kind], installed: true, path: `/usr/bin/${AGENTS[kind].command}`, version: '1' })),
    run: (opts) => {
      runs.push(opts)
      return fakeRun(opts)
    },
    emit: () => undefined,
    keepAwake: (on) => awake.push(on),
    worktreesDir: () => worktrees
  }
  const engine = new NightWatch(deps)
  return {
    engine,
    repo,
    worktrees,
    dataDir,
    deps,
    awake,
    runs,
    start: async () => {
      engine.addTask({ prompt: 'change app with claude', agent: 'claude', checks })
      engine.addTask({ prompt: 'change app with codex', agent: 'codex', checks })
      return (await engine.schedule('now')).nights[0]!.id
    },
    over: async (letGos = 2) => {
      const started = Date.now()
      while (awake.length < letGos) {
        if (Date.now() - started > 60000) throw new Error('the night did not wind down')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    },
    statuses: () => [engine.state().nights[0]!.status, ...engine.state().nights[0]!.runs.map((r) => r.status)]
  }
}

/** Every name that shows up in `folder` between now and `stop()`. */
function watchFolder(folder: string): { stop: () => string[] } {
  const seen = new Set<string>()
  const look = (): void => {
    for (const name of readdirSync(folder)) seen.add(name)
  }
  const timer = setInterval(look, 3)
  return {
    stop: () => {
      clearInterval(timer)
      look()
      return [...seen].sort()
    }
  }
}

describe('the app starts quitting, or a night is cancelled, at the worst moments', () => {
  /** A check that leaves a mark only when it runs in the folder made for checks. */
  function markingChecks(mark: string): CheckSpec[] {
    return [{ name: 'marker', command: `case "$PWD" in *-check) echo ran >> ${mark};; esac; test -f DONE.txt`, kind: 'required' }]
  }

  it('commits nothing and checks nothing when quitting starts between the look at the branch and the commit', async () => {
    const mark = join(temp('regatta-night-quit-'), 'ran')
    const n = startableNight(markingChecks(mark))
    hooks.afterCurrentBranch = () => {
      hooks.afterCurrentBranch = null
      n.engine.quit()
    }
    const watching = watchFolder(n.worktrees)
    const id = await n.start()
    await n.over()
    const run = n.engine.state().nights[0]!.runs[0]!
    expect(sh(['rev-list', '--count', `${run.base}..${run.branch}`], n.repo).trim()).toBe('0')
    expect(run.tip ?? null).toBeNull()
    expect(existsSync(mark)).toBe(false)
    // The baseline and the run's own folder came before the quit; no folder for checks ever appeared.
    expect(watching.stop()).toEqual([`night-${id}-base`, `night-${id}-claude`])
    expect(n.runs).toHaveLength(1)
    // Where it stood when it began to quit: the status was set before the look at the branch, and nothing moved it.
    expect(n.statuses()).toEqual(['running', 'checking', 'queued'])
  }, 90000)

  it('makes no folder for the checks and runs none when quitting starts after the commit', async () => {
    const mark = join(temp('regatta-night-quit-'), 'ran')
    const n = startableNight(markingChecks(mark))
    hooks.afterDiffBetween = () => {
      hooks.afterDiffBetween = null
      n.engine.quit()
    }
    const watching = watchFolder(n.worktrees)
    const id = await n.start()
    await n.over()
    const run = n.engine.state().nights[0]!.runs[0]!
    // The commit was made before the quit, and is saved as the run's tested commit.
    expect(sh(['rev-list', '--count', `${run.base}..${run.branch}`], n.repo).trim()).toBe('1')
    expect(run.tip).toBe(sh(['rev-parse', run.branch!], n.repo).trim())
    expect(existsSync(mark)).toBe(false)
    expect(watching.stop().some((name) => name.endsWith('-check'))).toBe(false)
    expect(readdirSync(n.worktrees)).toEqual([`night-${id}-claude`])
    expect(n.runs).toHaveLength(1)
    expect(n.statuses()).toEqual(['running', 'checking', 'queued'])
  }, 90000)

  it('makes no folder for a run when quitting starts after the check for its branch', async () => {
    const n = startableNight(markingChecks(join(temp('regatta-night-quit-'), 'ran')))
    hooks.afterBranchCheck = (branch) => {
      if (!branch.endsWith('-claude')) return
      hooks.afterBranchCheck = null
      n.engine.quit()
    }
    const watching = watchFolder(n.worktrees)
    const id = await n.start()
    await n.over()
    expect(n.runs).toHaveLength(0)
    // Only the baseline, which came first, was ever made; the run's folder never was.
    expect(watching.stop()).toEqual([`night-${id}-base`])
    expect(readdirSync(n.worktrees)).toEqual([])
    expect(branches(n.repo)).toEqual([])
    expect(sh(['worktree', 'list'], n.repo).trim().split('\n')).toHaveLength(1)
    expect(n.engine.busyPaths()).toEqual([])
    expect(n.statuses()).toEqual(['running', 'running', 'queued'])
  }, 90000)

  it('lets the folder git just made for a run stay owned, saved and removable, and starts no agent in it', async () => {
    const n = startableNight(markingChecks(join(temp('regatta-night-quit-'), 'ran')))
    hooks.afterAddWorktree = () => {
      hooks.afterAddWorktree = null
      n.engine.quit()
    }
    const id = await n.start()
    await n.over()
    const folder = join(n.worktrees, `night-${id}-claude`)
    expect(n.runs).toHaveLength(0)
    expect(existsSync(folder)).toBe(true)
    // The baseline, which came first, had its dependencies copied in; the run's folder, made after the quit began, did not.
    expect(hooks.provided).toEqual([join(n.worktrees, `night-${id}-base`)])
    expect(n.engine.busyPaths()).toEqual([folder])
    expect(n.statuses()).toEqual(['running', 'running', 'queued'])
    // The next start finds the run stopped, with its folder, and a discard takes both folder and branch away.
    const next = new NightWatch(n.deps)
    const run = next.state().nights[0]!.runs[0]!
    expect([run.status, run.worktree]).toEqual(['stopped', folder])
    await next.discard(run.id)
    expect(existsSync(folder)).toBe(false)
    expect((await emptyTrash(n.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(n.repo)).toEqual([])
  }, 90000)

  it('copies no dependencies and starts no run when quitting starts right after the baseline folder was made', async () => {
    const n = startableNight(markingChecks(join(temp('regatta-night-quit-'), 'ran')))
    hooks.afterAddDetached = (path) => {
      if (!path.endsWith('-base')) return
      hooks.afterAddDetached = null
      n.engine.quit()
    }
    await n.start()
    await n.over()
    expect(hooks.provided).toEqual([])
    expect(n.runs).toHaveLength(0)
    expect(readdirSync(n.worktrees)).toEqual([])
    expect(n.statuses()).toEqual(['running', 'queued', 'queued'])
  }, 90000)

  it('copies no dependencies and runs no check when quitting starts right after the folder for the checks was made', async () => {
    const mark = join(temp('regatta-night-quit-'), 'ran')
    const n = startableNight(markingChecks(mark))
    hooks.afterAddDetached = (path) => {
      if (!path.endsWith('-check')) return
      hooks.afterAddDetached = null
      n.engine.quit()
    }
    const id = await n.start()
    await n.over()
    expect(hooks.provided.some((path) => path.endsWith('-check'))).toBe(false)
    expect(existsSync(mark)).toBe(false)
    // The folder was made before the quit and is cleaned up as always; the run's own folder is what is left.
    expect(readdirSync(n.worktrees)).toEqual([`night-${id}-claude`])
    expect(n.runs).toHaveLength(1)
    expect(n.statuses()).toEqual(['running', 'checking', 'queued'])
  }, 90000)

  it('commits nothing when the night is cancelled between the look at the branch and the commit', async () => {
    const mark = join(temp('regatta-night-quit-'), 'ran')
    const n = startableNight(markingChecks(mark))
    hooks.afterCurrentBranch = () => {
      hooks.afterCurrentBranch = null
      n.engine.cancel()
    }
    const watching = watchFolder(n.worktrees)
    await n.start()
    // cancel() lets the computer go at once, and winding down does it again.
    await n.over(3)
    const run = n.engine.state().nights[0]!.runs[0]!
    expect(sh(['rev-list', '--count', `${run.base}..${run.branch}`], n.repo).trim()).toBe('0')
    expect(existsSync(mark)).toBe(false)
    expect(watching.stop().some((name) => name.endsWith('-check'))).toBe(false)
    expect(n.runs).toHaveLength(1)
    expect(n.statuses()).toEqual(['cancelled', 'stopped', 'stopped'])
  }, 90000)

  it('makes no folder for the checks when the night is cancelled after the commit', async () => {
    const mark = join(temp('regatta-night-quit-'), 'ran')
    const n = startableNight(markingChecks(mark))
    hooks.afterDiffBetween = () => {
      hooks.afterDiffBetween = null
      n.engine.cancel()
    }
    const watching = watchFolder(n.worktrees)
    await n.start()
    await n.over(3)
    expect(existsSync(mark)).toBe(false)
    expect(watching.stop().some((name) => name.endsWith('-check'))).toBe(false)
    expect(n.runs).toHaveLength(1)
    expect(n.statuses()).toEqual(['cancelled', 'stopped', 'stopped'])
  }, 90000)
})

describe('dependencies that could not be copied into only one folder', () => {
  it('are said on that run and on the night, and are still said after a restart and after a discard', async () => {
    hooks.noModulesIn = '-claude'
    const night = await finishedNight()
    hooks.noModulesIn = null
    const sentence = 'Dependencies were not copied into the worktree; run your install command there.'
    const state = night.engine.state().nights[0]!
    // Only the claude run's own folder failed; the baseline, the check folders and the codex run were copied into.
    expect(state.runs[0]!.note).toBe(`All gates passed. ${sentence}`)
    expect(state.runs[1]!.note).not.toContain('Dependencies')
    expect(state.notes).toEqual([sentence])

    // Saved: a new engine finds both, the night's list made from what is saved beside the state.
    const next = new NightWatch(night.deps)
    expect(next.state().nights[0]!.notes).toEqual([sentence])
    expect(next.state().nights[0]!.runs[0]!.note).toBe(`All gates passed. ${sentence}`)
    // And the note, put together again by a discard, still says it.
    await next.discard(next.state().nights[0]!.runs[0]!.id)
    expect(next.state().nights[0]!.runs[0]!.note).toContain(sentence)
    expect(next.state().nights[0]!.notes).toContain(sentence)
  }, 90000)
})

describe('programs that a check left and the supervisor could not stop', () => {
  it('hold the folder the check ran in, fail the checks gate, and are never removed', async () => {
    hooks.stuckIn = '-check'
    const night = await finishedNight()
    hooks.stuckIn = null
    const state = night.engine.state().nights[0]!
    const [claude] = state.runs
    expect(claude!.status).toBe('failed')
    expect(claude!.gates.find((g) => g.id === 'checks')).toMatchObject({
      passed: false,
      detail: 'a check left programs running that could not be stopped, so the result cannot be trusted'
    })
    expect(claude!.note).toContain('A check left programs running')
    // The folder the checks ran in is still there, registered, and nothing the night does later takes it away.
    const held = readdirSync(night.worktrees).filter((name) => name.endsWith('-check'))
    expect(held).toContain(`night-${night.nightId}-claude-check`)
    // It is the night's to hold, so it is on the list of what the night is busy with, along with the run's own folder.
    expect(night.engine.busyPaths()).toContain(join(night.worktrees, `night-${night.nightId}-claude-check`))
    expect(night.engine.busyPaths()).toContain(claude!.worktree)
    await night.engine.discard(claude!.id)
    expect(readdirSync(night.worktrees)).toContain(`night-${night.nightId}-claude-check`)
    expect(sh(['worktree', 'list'], night.repo)).toContain(`night-${night.nightId}-claude-check`)
  }, 90000)

  it('hold the baseline folder, and the night says so, also after a restart', async () => {
    hooks.stuckIn = '-base'
    const night = await finishedNight()
    hooks.stuckIn = null
    const state = night.engine.state().nights[0]!
    expect(readdirSync(night.worktrees)).toContain(`night-${night.nightId}-base`)
    // It concerns the whole night, so it is on the night once, not repeated on every run.
    expect(state.notes).toEqual([expect.stringContaining('The baseline left programs running')])
    // The folder is held, so it is on the list of what the night is busy with.
    expect(night.engine.busyPaths()).toContain(join(night.worktrees, `night-${night.nightId}-base`))
    for (const run of state.runs) expect(run.note).not.toContain('The baseline')
    const restarted = new NightWatch(night.deps).state().nights[0]!
    expect(restarted.notes).toEqual(state.notes)
    // The runs themselves were still judged, and the one that passed can be merged.
    expect(state.runs[0]!.status).toBe('ready')
    const result = await night.engine.merge(night.run.id)
    expect(result.merged).toBe(true)
    expect(readdirSync(night.worktrees)).toContain(`night-${night.nightId}-base`)
    expect(basename(night.run.worktree!)).toBe(`night-${night.nightId}-claude`)
  }, 90000)
})
