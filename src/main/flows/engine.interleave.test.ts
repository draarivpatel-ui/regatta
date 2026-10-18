// Things that happen to the repository in the middle of a flow run's merge, start or step. The git
// helpers are real; some of them are wrapped so a test can act at the exact moment between two steps.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '../../shared/agents'
import type { Flow, FlowRun, FlowStep } from '../../shared/flows'
import type { AgentKind } from '../../shared/types'
import { FlowEngine } from './engine'
import { withRepoLock } from '../heats/repo-lock'
import type { RunHandle, RunOptions, RunResult } from '../heats/runner'

const hooks = vi.hoisted(() => ({
  /** Runs right after the branch and commit were recorded for a merge, before it waits for the repository lock. */
  afterCapture: null as null | (() => void),
  /** Runs inside the merge, after the merge commit exists and right before the final recheck and write. */
  beforeWrite: null as null | (() => void),
  /** Runs right after the branch of a new run was found free, before its folder is made. */
  afterBranchCheck: null as null | ((branch: string) => void),
  /** Runs right after the engine asked git which branch a run folder is on (a look that comes before a commit). */
  afterCurrentBranch: null as null | (() => void),
  /** Runs right after one of the engine's own git calls returned, with its arguments. */
  afterGit: null as null | ((args: string[]) => void),
  /** The folders the engine asked git to make a detached worktree in. */
  detachedAdds: [] as string[],
  /** How many times the repository lock looked up which repository a folder belongs to. */
  commonDirCalls: 0,
  /** How long the fake agent works before it writes its files and ends (0: at once). */
  agentDelayMs: 0
}))

vi.mock('../heats/git-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../heats/git-ops')>()
  return {
    ...actual,
    branchExists: async (cwd: string, branch: string) => {
      const result = await actual.branchExists(cwd, branch)
      hooks.afterBranchCheck?.(branch)
      return result
    },
    captureTarget: async (...args: Parameters<typeof actual.captureTarget>) => {
      const captured = await actual.captureTarget(...args)
      hooks.afterCapture?.()
      return captured
    },
    currentBranch: async (...args: Parameters<typeof actual.currentBranch>) => {
      const result = await actual.currentBranch(...args)
      hooks.afterCurrentBranch?.()
      return result
    },
    git: async (...args: Parameters<typeof actual.git>) => {
      const result = await actual.git(...args)
      hooks.afterGit?.(args[0])
      return result
    },
    gitCommonDir: async (...args: Parameters<typeof actual.gitCommonDir>) => {
      const result = await actual.gitCommonDir(...args)
      hooks.commonDirCalls += 1
      return result
    },
    addDetachedWorktree: async (...args: Parameters<typeof actual.addDetachedWorktree>) => {
      hooks.detachedAdds.push(args[1])
      return actual.addDetachedWorktree(...args)
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

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']
const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }
const LONG = 60_000

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
}

const dirs: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  hooks.afterCapture = null
  hooks.beforeWrite = null
  hooks.afterBranchCheck = null
  hooks.afterCurrentBranch = null
  hooks.afterGit = null
  hooks.detachedAdds.length = 0
  hooks.commonDirCalls = 0
  hooks.agentDelayMs = 0
})
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** An agent that edits app.js and writes DONE.txt, and ends at once (or after `hooks.agentDelayMs`). */
function fakeRun(opts: RunOptions): RunHandle {
  opts.onActivity('working')
  const work = (): void => {
    writeFileSync(join(opts.cwd, 'DONE.txt'), 'done\n')
    appendFileSync(join(opts.cwd, 'src', 'app.js'), '// changed by the agent\n')
  }
  const result: RunResult = { exitCode: 0, durationMs: 5, tokens: null, stopped: false }
  if (hooks.agentDelayMs === 0) {
    work()
    return { done: Promise.resolve(result), stop: () => undefined }
  }
  const done = new Promise<RunResult>((resolve) => {
    setTimeout(() => {
      work()
      resolve(result)
    }, hooks.agentDelayMs).unref()
  })
  return { done, stop: () => undefined }
}

const AGENT_STEP: FlowStep = { id: 's1', kind: 'agent', title: 'Plan it', agent: 'claude', prompt: 'Plan', command: '' }
const DEFAULT_CHECK: FlowStep = { id: 's2', kind: 'check', title: 'Check it', agent: null, prompt: '', command: 'test -f DONE.txt' }

async function until(what: string, check: () => boolean, timeoutMs = 30000): Promise<void> {
  const begun = Date.now()
  while (!check()) {
    if (Date.now() - begun > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Setup {
  engine: FlowEngine
  repo: string
  worktrees: string
  flow: Flow
}

function setup(steps: FlowStep[] = [AGENT_STEP, DEFAULT_CHECK]): Setup {
  const repo = temp('regatta-flow-interleave-')
  sh(['init', '-b', 'main'], repo)
  sh(['config', 'user.name', 'Regatta Test'], repo)
  sh(['config', 'user.email', 'test@regatta.local'], repo)
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
  writeFileSync(join(repo, 'README.md'), '# project\n')
  sh(['add', '.'], repo)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], repo)
  const worktrees = temp('regatta-flow-interleave-wt-')
  const kinds: AgentKind[] = ['claude']
  const engine = new FlowEngine({
    dataDir: temp('regatta-flow-interleave-data-'),
    root: () => repo,
    env: () => ENV,
    agents: () => kinds.map((kind) => ({ ...AGENTS[kind], installed: true, path: `/usr/bin/${AGENTS[kind].command}`, version: '1' })),
    run: fakeRun,
    emitFlows: () => undefined,
    emitRun: () => undefined,
    worktreesDir: () => worktrees
  })
  const flow = engine.save({
    id: '',
    name: 'Ship it',
    brief: 'a brief',
    trigger: 'manual',
    isolate: true,
    steps,
    createdAt: 0,
    updatedAt: 0
  })
  return { engine, repo, worktrees, flow }
}

async function doneRun(): Promise<Setup & { run: FlowRun }> {
  const made = setup()
  const started = await made.engine.run(made.flow.id)
  const begun = Date.now()
  while (made.engine.runs().find((r) => r.id === started.id)?.status !== 'done') {
    if (Date.now() - begun > 60000) throw new Error('run did not finish')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { ...made, run: made.engine.runs().find((r) => r.id === started.id)! }
}

function head(repo: string): string {
  return sh(['rev-parse', 'HEAD'], repo).trim()
}

function branches(repo: string): string[] {
  return sh(['branch', '--list', 'regatta/*', '--format=%(refname:short)'], repo)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** The run still has its worktree and branch, and the folder holds nothing half done. */
function kept(made: Setup & { run: FlowRun }): void {
  const run = made.engine.runs().find((r) => r.id === made.run.id)!
  expect(run.status).toBe('done')
  expect(run.mergeSummary).toBeNull()
  expect(run.worktree).toBe(made.run.worktree)
  expect(run.branch).toBe(made.run.branch)
  expect(existsSync(made.run.worktree!)).toBe(true)
  expect(branches(made.repo)).toEqual([made.run.branch])
  expect(readdirSync(made.worktrees)).toEqual([`flow-${made.run.id}`])
  expect(existsSync(join(made.repo, '.git', 'MERGE_HEAD'))).toBe(false)
  expect(existsSync(join(made.repo, 'DONE.txt'))).toBe(false)
}

describe('the folder changes after the merge was asked for', () => {
  it('refuses when HEAD moved and the merge would also conflict, then judges the retry on the new state', async () => {
    const made = await doneRun()
    const { engine, repo, run } = made
    hooks.afterCapture = () => {
      appendFileSync(join(repo, 'src', 'app.js'), '// made in the folder\n')
      sh([...IDENTITY, 'commit', '-am', 'conflicting work'], repo)
    }
    await expect(engine.merge(run.id)).rejects.toThrow('moved on since the merge was asked for')
    hooks.afterCapture = null
    const users = head(repo)
    expect(sh(['status', '--porcelain'], repo).trim()).toBe('')
    expect(readFileSync(join(repo, 'src', 'app.js'), 'utf8')).not.toContain('changed by the agent')
    kept(made)

    // Asked again, the conflict is found in a scratch worktree and the folder never sees it.
    await expect(engine.merge(run.id)).rejects.toThrow(/conflicts with work in main/)
    expect(head(repo)).toBe(users)
    expect(sh(['status', '--porcelain'], repo).trim()).toBe('')
    kept(made)

    sh([...IDENTITY, 'revert', '--no-edit', 'HEAD'], repo)
    expect((await engine.merge(run.id)).merged).toBe(true)
    expect(readFileSync(join(repo, 'src', 'app.js'), 'utf8')).toContain('changed by the agent')
  }, LONG)

  it('refuses when the user switched to another branch, or detached, after the merge was asked for', async () => {
    const made = await doneRun()
    const { engine, repo, run } = made
    hooks.afterCapture = () => sh(['checkout', '-q', '-b', 'elsewhere'], repo)
    await expect(engine.merge(run.id)).rejects.toThrow(/Your folder is on elsewhere now, not main/)
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim()).toBe('elsewhere')
    kept(made)

    sh(['checkout', '-q', 'main'], repo)
    hooks.afterCapture = () => sh(['checkout', '-q', '--detach'], repo)
    await expect(engine.merge(run.id)).rejects.toThrow('Check out a branch before merging.')
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim()).toBe('HEAD')
    kept(made)
    sh(['checkout', '-q', 'main'], repo)
    hooks.afterCapture = null
    expect((await engine.merge(run.id)).merged).toBe(true)
  }, LONG)

  it('refuses when tracked files were edited after the merge was asked for', async () => {
    const made = await doneRun()
    const { engine, repo, run } = made
    hooks.afterCapture = () => writeFileSync(join(repo, 'README.md'), '# edited\n')
    await expect(engine.merge(run.id)).rejects.toThrow('Commit or stash your changes first. Merging needs a clean folder.')
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# edited\n')
    expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
    kept({ ...made })
  }, LONG)
})

describe('the folder changes while the merge is being made', () => {
  it('refuses an ignored file created after everything was checked, right before the write, and keeps its bytes', async () => {
    const made = await doneRun()
    const { engine, repo, run } = made
    sh([...IDENTITY, 'commit', '--allow-empty', '-m', 'work in the folder'], repo)
    const before = head(repo)
    hooks.beforeWrite = () => {
      appendFileSync(join(repo, '.git', 'info', 'exclude'), 'DONE.txt\n')
      writeFileSync(join(repo, 'DONE.txt'), 'precious\n')
    }
    await expect(engine.merge(run.id)).rejects.toThrow(/DONE\.txt/)
    expect(readFileSync(join(repo, 'DONE.txt'), 'utf8')).toBe('precious\n')
    expect(head(repo)).toBe(before)
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(readdirSync(made.worktrees)).toEqual([`flow-${run.id}`])
    expect(branches(repo)).toEqual([run.branch])
    expect(existsSync(run.worktree!)).toBe(true)
  }, LONG)

  it('refuses when the user commits or switches branch in that moment, and leaves nothing behind', async () => {
    for (const change of ['commit', 'switch'] as const) {
      const made = await doneRun()
      const { engine, repo, run } = made
      sh([...IDENTITY, 'commit', '--allow-empty', '-m', 'work in the folder'], repo)
      hooks.beforeWrite = () => {
        if (change === 'commit') sh([...IDENTITY, 'commit', '--allow-empty', '-m', 'the user, just now'], repo)
        else sh(['checkout', '-q', '-b', 'elsewhere'], repo)
      }
      await expect(engine.merge(run.id)).rejects.toThrow(/moved on since the merge was asked for|Your folder is on elsewhere now/)
      hooks.beforeWrite = null
      expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
      expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
      expect(readdirSync(made.worktrees)).toEqual([`flow-${run.id}`])
      expect(existsSync(run.worktree!)).toBe(true)
      expect(branches(repo)).toEqual([run.branch])
    }
  }, LONG)

  it('does not touch a merge the user starts in that moment', async () => {
    const made = await doneRun()
    const { engine, repo, run } = made
    sh(['checkout', '-q', '-b', 'topic'], repo)
    writeFileSync(join(repo, 'README.md'), 'topic\n')
    sh([...IDENTITY, 'commit', '-am', 'topic'], repo)
    sh(['checkout', '-q', 'main'], repo)
    writeFileSync(join(repo, 'README.md'), 'main\n')
    sh([...IDENTITY, 'commit', '-am', 'main'], repo)
    hooks.beforeWrite = () => {
      try {
        sh([...IDENTITY, 'merge', 'topic'], repo)
      } catch {
        // It conflicts: MERGE_HEAD is now the user's.
      }
    }
    await expect(engine.merge(run.id)).rejects.toThrow(/merge is already in progress/)
    hooks.beforeWrite = null
    expect(readFileSync(join(repo, '.git', 'MERGE_HEAD'), 'utf8').trim()).toBe(sh(['rev-parse', 'topic'], repo).trim())
    expect(sh(['status', '--porcelain'], repo)).toContain('UU README.md')
    expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
    expect(existsSync(run.worktree!)).toBe(true)
    expect(branches(repo)).toEqual([run.branch])
  }, LONG)
})

describe('a new run claims its folder exclusively', () => {
  it('does not claim an empty folder that appeared after the branch was found free', async () => {
    const made = setup()
    let folder = ''
    hooks.afterBranchCheck = (branch) => {
      folder = join(made.worktrees, branch.replace('regatta/', ''))
      mkdirSync(folder)
    }
    await expect(made.engine.run(made.flow.id)).rejects.toThrow(/is already there, so it was left alone/)
    hooks.afterBranchCheck = null
    expect(folder).not.toBe('')
    expect(existsSync(folder)).toBe(true)
    expect(readdirSync(folder)).toEqual([])
    expect(sh(['worktree', 'list'], made.repo).trim().split('\n')).toHaveLength(1)
    expect(branches(made.repo)).toEqual([])
    expect(made.engine.runs()).toEqual([])
  }, LONG)
})

describe('the app quits in the middle of a step', () => {
  it('makes no check folder for a step that was waiting for the repository when the quit came', async () => {
    const made = setup()
    const base = head(made.repo)
    hooks.agentDelayMs = 300
    const started = await made.engine.run(made.flow.id)
    // The repository is busy with something else when the agent ends.
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    hooks.commonDirCalls = 0
    const busy = withRepoLock(made.repo, () => gate)
    // The step committed the work and now waits, behind that, to make its check folder.
    await until('the work to be committed', () => sh(['rev-parse', `regatta/flow-${started.id}`], made.repo).trim() !== base)
    await until('the step to wait for the repository', () => hooks.commonDirCalls >= 2)
    await sleep(100)
    made.engine.quit()
    open()
    await busy
    await sleep(600)
    expect(hooks.detachedAdds).toEqual([])
    expect(readdirSync(made.worktrees)).toEqual([`flow-${started.id}`])
  }, LONG)

  it('starts no check process when the quit comes after its folder was made', async () => {
    const marker = join(temp('regatta-flow-marker-'), 'started')
    const made = setup([AGENT_STEP, { ...DEFAULT_CHECK, command: `echo started > '${marker}'` }])
    let quit = false
    // The first look at the tracked files of the folder, taken just before the process starts.
    hooks.afterGit = (args) => {
      if (args[0] === 'ls-files' && args.includes('-s') && !quit) {
        quit = true
        made.engine.quit()
      }
    }
    const started = await made.engine.run(made.flow.id)
    await until('the quit to come', () => quit)
    await sleep(600)
    expect(existsSync(marker)).toBe(false)
    expect(hooks.detachedAdds).toHaveLength(1)
    // The folder it had made is taken away again, and the run is left as saved.
    expect(readdirSync(made.worktrees)).toEqual([`flow-${started.id}`])
    expect(made.engine.runs().find((r) => r.id === started.id)?.status).toBe('running')
  }, LONG)

  it('commits nothing when the quit comes after the looks that come before a check step commit', async () => {
    const made = setup()
    const base = head(made.repo)
    let quit = false
    hooks.afterCurrentBranch = () => {
      quit = true
      made.engine.quit()
    }
    const started = await made.engine.run(made.flow.id)
    await until('the quit to come', () => quit)
    await sleep(600)
    expect(sh(['rev-parse', `regatta/flow-${started.id}`], made.repo).trim()).toBe(base)
    expect(hooks.detachedAdds).toEqual([])
    expect(readdirSync(made.worktrees)).toEqual([`flow-${started.id}`])
    expect(sh(['status', '--porcelain'], join(made.worktrees, `flow-${started.id}`))).toContain('?? DONE.txt')
  }, LONG)

  it('makes no end-of-run commit when the quit comes after the looks that come before it', async () => {
    const made = setup([AGENT_STEP])
    const base = head(made.repo)
    let quit = false
    hooks.afterCurrentBranch = () => {
      quit = true
      made.engine.quit()
    }
    const started = await made.engine.run(made.flow.id)
    await until('the quit to come', () => quit)
    await sleep(600)
    expect(sh(['rev-parse', `regatta/flow-${started.id}`], made.repo).trim()).toBe(base)
    // The run was not called done: it stays as saved, and loads as stopped at the next start.
    expect(made.engine.runs().find((r) => r.id === started.id)?.status).toBe('running')
  }, LONG)
})
