// Things that happen to the repository in the middle of a merge. The git helpers are real; two of
// them are wrapped so a test can act at the exact moment between two steps.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '../../shared/agents'
import type { StartHeatOptions } from '../../shared/ipc'
import type { AgentKind } from '../../shared/types'
import { HeatEngine } from './engine'
import type { RunHandle, RunOptions } from './runner'

const hooks = vi.hoisted(() => ({
  afterAncestryCheck: null as null | (() => void),
  /** Runs inside the merge, after the merge commit exists and right before the final recheck and write. */
  beforeWrite: null as null | (() => void),
  /** Runs right after the branch and commit were recorded for a merge, before it waits for the repository lock. */
  afterCapture: null as null | (() => void),
  afterBranchCheck: null as null | ((branch: string) => void)
}))

vi.mock('./git-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-ops')>()
  return {
    ...actual,
    isAncestor: async (...args: Parameters<typeof actual.isAncestor>) => {
      const result = await actual.isAncestor(...args)
      hooks.afterAncestryCheck?.()
      return result
    },
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
  hooks.afterAncestryCheck = null
  hooks.beforeWrite = null
  hooks.afterCapture = null
  hooks.afterBranchCheck = null
})
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function fakeRun(opts: RunOptions): RunHandle {
  opts.onActivity('working')
  opts.onTokens(1)
  if (opts.agent === 'claude') {
    writeFileSync(join(opts.cwd, 'DONE.txt'), 'done\n')
    appendFileSync(join(opts.cwd, 'src', 'app.js'), '// changed by the agent\n')
  }
  return { done: Promise.resolve({ exitCode: 0, durationMs: 50, tokens: 1, stopped: false }), stop: () => undefined }
}

async function decidedHeat(wt: string = temp('regatta-heat-interleave-wt-')): Promise<{ engine: HeatEngine; repo: string; id: string; laneId: string; branch: string; other: string }> {
  const repo = temp('regatta-heat-interleave-')
  sh(['init', '-b', 'main'], repo)
  sh(['config', 'user.name', 'Regatta Test'], repo)
  sh(['config', 'user.email', 'test@regatta.local'], repo)
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
  sh(['add', '.'], repo)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], repo)
  const kinds: AgentKind[] = ['claude', 'codex']
  const engine = new HeatEngine({
    root: () => repo,
    env: () => ENV,
    agents: () => kinds.map((kind) => ({ ...AGENTS[kind], installed: true, path: `/usr/bin/${AGENTS[kind].command}`, version: '1' })),
    run: fakeRun,
    emit: () => undefined,
    worktreesDir: () => wt
  })
  const options: StartHeatOptions = {
    task: 'change app',
    agents: kinds,
    checks: [{ name: 'done', command: 'test -f DONE.txt', kind: 'required' }],
    setup: '',
    timeLimitMin: 10,
    allowCommands: false
  }
  const id = (await engine.start(options)).id
  const started = Date.now()
  while (engine.list().find((h) => h.id === id)?.status !== 'decided') {
    if (Date.now() - started > 60000) throw new Error('heat did not finish')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const lanes = engine.list().find((h) => h.id === id)!.lanes
  const winner = lanes.find((l) => l.agent === 'claude')!
  return { engine, repo, id, laneId: winner.id, branch: winner.branch!, other: lanes.find((l) => l.agent === 'codex')!.branch! }
}

describe('a branch that moves after the merge was checked', () => {
  it('is kept, not force-deleted, and the rest is still cleaned up', async () => {
    const wt = temp('regatta-heat-interleave-wt-')
    const { engine, repo, id, laneId, branch, other } = await decidedHeat(wt)
    let moved = ''
    hooks.afterAncestryCheck = () => {
      // Someone commits to the winner's branch between the check and the cleanup.
      moved = sh([...IDENTITY, 'commit-tree', `${branch}^{tree}`, '-p', branch, '-m', 'late work'], repo).trim()
      sh(['update-ref', `refs/heads/${branch}`, moved], repo)
      hooks.afterAncestryCheck = null
    }
    const result = await engine.merge(id, laneId)
    expect(result.merged).toBe(true)
    expect(moved).not.toBe('')
    expect(sh(['rev-parse', branch], repo).trim()).toBe(moved)
    expect(sh(['branch', '--list', other], repo).trim()).not.toBe('')
    expect(result.summary).toContain('Removed 2 worktrees and 0 branches.')
    expect(result.summary).toContain("Moved its worktree to Regatta's trash")
  }, 90000)
})

describe('things the user does in the middle of a merge', () => {
  it('a merge the user starts at the same moment is refused and left alone', async () => {
    const { engine, repo, id, laneId } = await decidedHeat()
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
    await expect(engine.merge(id, laneId)).rejects.toThrow(/merge is already in progress/)
    // The user's merge is still there, with its conflict, and nothing was deleted.
    expect(existsSync(mergeHead)).toBe(true)
    expect(readFileSync(mergeHead, 'utf8').trim()).toBe(sh(['rev-parse', 'topic'], repo).trim())
    expect(sh(['status', '--porcelain'], repo)).toContain('UU NOTES.txt')
    expect(engine.list().find((h) => h.id === id)?.status).toBe('decided')
    expect(sh(['branch', '--list', 'regatta/heat-*'], repo).trim()).not.toBe('')
  }, 90000)

  it('an ignored file made after every check is not overwritten', async () => {
    const { engine, repo, id, laneId } = await decidedHeat()
    writeFileSync(join(repo, 'LATER.txt'), 'later\n')
    sh(['add', 'LATER.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'work in the folder'], repo)
    hooks.beforeWrite = () => {
      writeFileSync(join(repo, '.gitignore'), 'DONE.txt\n')
      writeFileSync(join(repo, 'DONE.txt'), 'precious\n')
      hooks.beforeWrite = null
    }
    const before = sh(['rev-parse', 'HEAD'], repo).trim()
    await expect(engine.merge(id, laneId)).rejects.toThrow(/DONE\.txt|overwrite/)
    expect(readFileSync(join(repo, 'DONE.txt'), 'utf8')).toBe('precious\n')
    expect(sh(['rev-parse', 'HEAD'], repo).trim()).toBe(before)
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(engine.list().find((h) => h.id === id)?.status).toBe('decided')
  }, 90000)

  it('a branch switched right after the merge was asked for, before it gets the lock, receives nothing', async () => {
    const { engine, repo, id, laneId } = await decidedHeat()
    hooks.afterCapture = () => {
      sh(['checkout', '-q', '-b', 'feature'], repo)
      hooks.afterCapture = null
    }
    await expect(engine.merge(id, laneId)).rejects.toThrow(/feature now, not main/)
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim()).toBe('feature')
    expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
    expect(engine.list().find((h) => h.id === id)?.status).toBe('decided')
    // Back on main, the same merge goes through.
    sh(['checkout', '-q', 'main'], repo)
    expect((await engine.merge(id, laneId)).merged).toBe(true)
  }, 90000)

  it('a branch switched after the merge was asked for refuses the merge', async () => {
    const { engine, repo, id, laneId } = await decidedHeat()
    hooks.beforeWrite = () => {
      sh(['checkout', '-q', '-b', 'elsewhere'], repo)
      hooks.beforeWrite = null
    }
    writeFileSync(join(repo, 'LATER.txt'), 'later\n')
    sh(['add', 'LATER.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'work in the folder'], repo)
    await expect(engine.merge(id, laneId)).rejects.toThrow(/elsewhere now, not main/)
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim()).toBe('elsewhere')
    expect(existsSync(join(repo, 'DONE.txt'))).toBe(false)
    expect(engine.list().find((h) => h.id === id)?.status).toBe('decided')
  }, 90000)
})

describe('a folder that appears while a worktree is being made', () => {
  it('is not claimed: the lane fails and the folder stays', async () => {
    const wt = temp('regatta-heat-interleave-wt-')
    hooks.afterBranchCheck = (branch) => {
      // Between the checks and git, someone makes the (empty) folder of the Codex lane.
      if (branch.endsWith('-codex')) mkdirSync(join(wt, `heat-${branch.slice('regatta/heat-'.length)}`))
    }
    const { engine, repo, id } = await decidedHeat(wt)
    hooks.afterBranchCheck = null
    const state = engine.list().find((h) => h.id === id)!
    const codex = state.lanes.find((l) => l.agent === 'codex')!
    expect(codex.error).toContain('is already there')
    expect(codex.worktree).toBeNull()
    expect(state.lanes.find((l) => l.agent === 'claude')!.error).toBeNull()

    await engine.discard(id)
    expect(readdirSync(wt).sort()).toEqual(['.regatta-trash', `heat-${id}-codex`])
    expect(sh(['worktree', 'list'], repo).trim().split('\n')).toHaveLength(2)
  }, 90000)
})
