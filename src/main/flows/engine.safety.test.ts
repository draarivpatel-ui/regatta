// The flow engine's safety (docs/design/safety.md) against real
// repositories and real processes: merging into the user's branch, removing a run's worktree,
// deleting its branch, process groups, and checks in a temporary worktree. A fake agent writes the
// files; git, the shell and the programs left running are real.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '../../shared/agents'
import { noteCommand } from '../../renderer/src/modes/flows/logic'
import type { Flow, FlowRun, FlowStep } from '../../shared/flows'
import type { AgentKind, DetectedAgent } from '../../shared/types'
import { FlowEngine } from './engine'
import type { FlowEngineDeps } from './engine'
import { emptyTrash, listTrash } from '../heats/git-ops'
import { withRepoLock } from '../heats/repo-lock'
import type { RunHandle, RunOptions, RunResult } from '../heats/runner'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']
const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }
/** Every test touches git and the process table; the default five seconds is not for that. */
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

/** Programs the tests left running on purpose; every one is killed when a test ends and when the file is done. */
const sleepers: number[] = []

/** Starts a program that stays in `cwd` after the agent is gone, in a session of its own. */
function leaveSleeper(cwd: string): number {
  const child = spawn('/bin/sh', ['-c', 'exec sleep 120'], { cwd, detached: true, stdio: 'ignore' })
  child.unref()
  sleepers.push(child.pid!)
  return child.pid!
}

function killSleepers(): void {
  for (const pid of sleepers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  killSleepers()
})
afterAll(() => {
  killSleepers()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** What the fake agent does, and how long it takes. */
interface Scenario {
  delayMs: number
  exitCode?: number
  write?: (cwd: string) => void
  /** The agent's run ends with some of its processes still alive (the supervisor gave up on them). */
  stuck?: boolean
  /** How long the agent takes to wind down once it is stopped. */
  stopMs?: number
  /** Runs when the stopped agent finally ends. */
  onStopped?: (cwd: string) => void
  /** The activity line the agent reports (its output, as the next step sees it). */
  activity?: string
}

function writeDone(cwd: string): void {
  writeFileSync(join(cwd, 'DONE.txt'), 'done\n')
}

function editApp(cwd: string): void {
  writeDone(cwd)
  appendFileSync(join(cwd, 'src', 'app.js'), '// changed by the agent\n')
}

const SCENARIOS: Record<string, Scenario> = {
  writer: { delayMs: 40, write: writeDone },
  editor: { delayMs: 40, write: editApp },
  slow: { delayMs: 60000, write: writeDone },
  fail: { delayMs: 40, exitCode: 3, write: writeDone },
  stuck: { delayMs: 40, write: writeDone, stuck: true },
  /** Leaves programs behind but writes nothing, so the folder looks pristine and only the hold keeps it. */
  stuckQuiet: { delayMs: 40, stuck: true },
  stuckSlow: { delayMs: 60000, stuck: true }
}

interface Harness {
  engine: FlowEngine
  repo: string
  dataDir: string
  worktrees: string
  /** Agents whose run was stopped by the engine. */
  stopped: AgentKind[]
  /** Every run state the engine sent to the window. */
  emitted: FlowRun[]
  /** The folder and the prompt of every agent the engine started, in order. */
  cwds: string[]
  prompts: string[]
  /** The dependencies the engine was built with, for a second engine over the same data. */
  deps: FlowEngineDeps
}

function detectedAgents(kinds: AgentKind[]): DetectedAgent[] {
  return kinds.map((kind) => ({ ...AGENTS[kind], installed: true, path: `/usr/bin/${AGENTS[kind].command}`, version: '1.0' }))
}

function makeHarness(plan: Partial<Record<AgentKind, Scenario>>, patch: Partial<FlowEngineDeps> = {}): Harness {
  const repo = temp('regatta-flow-safe-')
  sh(['init', '-b', 'main'], repo)
  // Merges that need a commit use the repository user's identity.
  sh(['config', 'user.name', 'Regatta Test'], repo)
  sh(['config', 'user.email', 'test@regatta.local'], repo)
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, '.gitignore'), 'local/\nnode_modules/\n')
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
  writeFileSync(join(repo, 'README.md'), '# project\n')
  sh(['add', '.'], repo)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], repo)
  const dataDir = temp('regatta-flow-safe-data-')
  const worktrees = temp('regatta-flow-safe-wt-')

  const stopped: AgentKind[] = []
  const emitted: FlowRun[] = []
  const cwds: string[] = []
  const prompts: string[] = []
  const run = (opts: RunOptions): RunHandle => {
    cwds.push(opts.cwd)
    prompts.push(opts.prompt)
    const scenario = plan[opts.agent] ?? { delayMs: 0 }
    const started = Date.now()
    let settle!: (result: RunResult) => void
    let closed = false
    const done = new Promise<RunResult>((resolve) => {
      settle = resolve
    })
    const finish = (result: RunResult): void => {
      if (closed) return
      closed = true
      settle({ ...result, ...(scenario.stuck ? { stuck: true } : {}) })
    }
    opts.onActivity(scenario.activity ?? `${opts.agent} is working`)
    const clock = setTimeout(() => {
      // A run whose folder was taken away while a slow agent was still "working" has nothing to write in.
      try {
        scenario.write?.(opts.cwd)
      } catch {
        // Like an agent started in a folder that is gone: it ends without its files.
      }
      finish({ exitCode: scenario.exitCode ?? 0, durationMs: Date.now() - started, tokens: null, stopped: false })
    }, scenario.delayMs)
    clock.unref()
    return {
      done,
      stop: () => {
        stopped.push(opts.agent)
        clearTimeout(clock)
        const end = (): void => {
          scenario.onStopped?.(opts.cwd)
          finish({ exitCode: null, durationMs: Date.now() - started, tokens: null, stopped: true })
        }
        if (scenario.stopMs) setTimeout(end, scenario.stopMs).unref()
        else end()
      }
    }
  }
  const deps: FlowEngineDeps = {
    dataDir,
    root: () => repo,
    env: () => ENV,
    agents: () => detectedAgents(['claude', 'codex']),
    run,
    emitFlows: () => undefined,
    emitRun: (state) => emitted.push(state),
    worktreesDir: () => worktrees,
    ...patch
  }
  return { engine: new FlowEngine(deps), repo, dataDir, worktrees, stopped, emitted, cwds, prompts, deps }
}

function writerHarness(patch: Partial<FlowEngineDeps> = {}): Harness {
  return makeHarness({ claude: SCENARIOS['writer']! }, patch)
}

function agentStep(id: string, prompt = 'Plan'): FlowStep {
  return { id, kind: 'agent', title: 'Plan it', agent: 'claude', prompt, command: '' }
}

function checkStep(id: string, command: string): FlowStep {
  return { id, kind: 'check', title: 'Check it', agent: null, prompt: '', command }
}

function approvalStep(id: string): FlowStep {
  return { id, kind: 'approval', title: 'Approve it', agent: null, prompt: '', command: '' }
}

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: '',
    name: 'Ship it',
    brief: 'a brief note',
    trigger: 'manual',
    isolate: true,
    steps: [agentStep('s1'), checkStep('s2', 'test -f DONE.txt')],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 60000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function runOf(h: Harness, id: string): FlowRun {
  const found = h.engine.runs().find((r) => r.id === id)
  if (!found) throw new Error(`Run ${id} is not in the list`)
  return found
}

function notesOf(h: Harness, id: string): string {
  return (runOf(h, id).notes ?? []).join('\n')
}

/** Starts an isolated run of a flow and waits until it has ended with the status it ends in. */
async function endedRun(h: Harness, flow: Partial<Flow> = {}, status: FlowRun['status'] = 'done'): Promise<FlowRun> {
  const saved = h.engine.save(makeFlow(flow))
  const started = await h.engine.run(saved.id)
  await waitFor(`the run to be ${status}`, () => runOf(h, started.id).status === status)
  return runOf(h, started.id)
}

function head(repo: string): string {
  return sh(['rev-parse', 'HEAD'], repo).trim()
}

function regattaBranches(repo: string): string[] {
  return sh(['branch', '--list', 'regatta/*', '--format=%(refname:short)'], repo)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** The refs below refs/regatta/discarded/: where the tip of a deleted run branch is parked. */
function parkedRefs(repo: string): string[] {
  return sh(['for-each-ref', '--format=%(refname)', 'refs/regatta/discarded/'], repo)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** True when some keep ref under refs/regatta/discarded/ has the commit in its history (the keep commits are made so that it does). */
function keepHolds(repo: string, id: string): boolean {
  return parkedRefs(repo).some((ref) => sh(['rev-list', ref], repo).split('\n').includes(id))
}

/** The ref the run's branch was kept at, as the note says it (the run's folder may have taken the plain name first). */
function branchKeepRef(h: Harness, runId: string): string {
  const match = notesOf(h, runId).match(/Kept a copy of the run's work at (\S+) /)
  if (!match) throw new Error(`no keep note in: ${notesOf(h, runId)}`)
  return match[1]!
}

function worktreeCount(repo: string): number {
  return sh(['worktree', 'list', '--porcelain'], repo)
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length
}

/** Commits files on the branch that is checked out in `cwd`. Returns the commit. */
function commit(cwd: string, files: Record<string, string>, message = 'work'): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(cwd, path, '..'), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  sh(['add', '-A'], cwd)
  sh([...IDENTITY, 'commit', '-m', message], cwd)
  return head(cwd)
}

/** The folder is exactly as it was: same commit, nothing half merged, nothing changed. */
function untouched(h: Harness, before: string): void {
  expect(head(h.repo)).toBe(before)
  expect(existsSync(join(h.repo, '.git', 'MERGE_HEAD'))).toBe(false)
  expect(sh(['status', '--porcelain'], h.repo).trim()).toBe('')
}

/** The run still has what it made: its worktree, its branch, and the proof of both. */
function intact(h: Harness, run: FlowRun): void {
  const now = runOf(h, run.id)
  expect(now.status).toBe('done')
  expect(now.worktree).toBe(run.worktree)
  expect(now.branch).toBe(run.branch)
  expect(existsSync(run.worktree!)).toBe(true)
  expect(regattaBranches(h.repo)).toContain(run.branch)
}

/** A fingerprint of everything in a folder: names, kinds, modes, file contents and link targets. */
function digest(folder: string): string {
  const hash = createHash('sha256')
  const walk = (dir: string, label: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      const here = `${label}/${name}`
      if (stat.isSymbolicLink()) {
        hash.update(`L ${here} -> ${readlinkSync(path)}\n`)
      } else if (stat.isDirectory()) {
        hash.update(`D ${here} ${(stat.mode & 0o777).toString(8)}\n`)
        walk(path, here)
      } else {
        hash.update(`F ${here} ${(stat.mode & 0o777).toString(8)} ${stat.size}\n`)
        hash.update(readFileSync(path))
      }
    }
  }
  walk(folder, '')
  return hash.digest('hex')
}

/**
 * Starts an isolated run whose check cannot be stopped (its group ignores every signal, as an
 * unkillable process would), stops the run, and returns the folder the engine now holds. The
 * caller kills the leftover program with `kill`.
 */
async function stuckCheck(h: Harness): Promise<{ id: string; folder: string; pidFile: string; kill: () => void }> {
  const real = process.kill.bind(process)
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (pid < 0 && signal !== 0) return true
    return real(pid, signal as NodeJS.Signals)
  }) as typeof process.kill)
  const saved = h.engine.save(makeFlow({ steps: [agentStep('s1'), checkStep('s2', 'echo $$ > shell.pid; sleep 300')] }))
  const started = await h.engine.run(saved.id)
  const folder = join(h.worktrees, `flow-${started.id}-check-2`)
  const pidFile = join(folder, 'shell.pid')
  await waitFor('the check to run', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  h.engine.stop(started.id)
  await waitFor('the run to stop', () => runOf(h, started.id).status === 'stopped')
  vi.restoreAllMocks()
  return {
    id: started.id,
    folder,
    pidFile,
    kill: () => {
      try {
        real(-pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
}

describe('merging', () => {
  it('fast-forwards when the branch has not moved, and moves the worktree to the trash', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const tip = sh(['rev-parse', run.branch!], h.repo).trim()
    const result = await h.engine.merge(run.id)
    expect(result.merged).toBe(true)
    expect(result.summary).toMatch(/^Fast-forwarded main by 1 commit \(\+1 -0 in 1 file\)\. Removed 1 worktree and 0 branches\. Kept: Moved its worktree to Regatta's trash/)
    expect(head(h.repo)).toBe(tip)
    expect(readFileSync(join(h.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(sh(['reflog', '-1', '--format=%gs'], h.repo).trim()).toMatch(/^merge [0-9a-f]+: Fast-forward$/)
    expect(readdirSync(h.worktrees)).toEqual(['.regatta-trash'])
    expect(worktreeCount(h.repo)).toBe(2)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    // Nothing is asked about who else holds the work: it is kept anyway, for the branch and for the folder.
    expect(keepHolds(h.repo, tip)).toBe(true)
    const saved = JSON.parse(readFileSync(join(h.dataDir, 'flow-runs', `${run.id}.json`), 'utf8')) as Record<string, unknown>
    expect(saved['worktree']).toBeNull()
    expect(saved['branch']).toBeNull()
    expect(saved['owned']).toBeUndefined()
    expect((await emptyTrash(h.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(worktreeCount(h.repo)).toBe(1)
    expect(regattaBranches(h.repo)).toEqual([])
  }, LONG)

  it('builds a merge commit away from the folder when the branch has moved on, then only fast-forwards to it', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const tip = sh(['rev-parse', run.branch!], h.repo).trim()
    const ahead = commit(h.repo, { 'LATER.txt': 'later\n' })
    const result = await h.engine.merge(run.id)
    expect(result.summary).toMatch(/^Merged into main with 1 commit \(\+1 -0 in 1 file\)\. Removed 1 worktree and 0 branches\. Kept: Moved its worktree to Regatta's trash/)
    const parents = sh(['rev-list', '--parents', '-n', '1', 'HEAD'], h.repo).trim().split(' ')
    expect(parents.slice(1)).toEqual([ahead, tip])
    expect(sh(['log', '-1', '--format=%s'], h.repo).trim()).toBe(`Merge flow ${run.id}`)
    expect(readFileSync(join(h.repo, 'LATER.txt'), 'utf8')).toBe('later\n')
    expect(readFileSync(join(h.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    // The folder never ran a three-way merge: its history shows only a fast-forward to the finished commit.
    const reflog = sh(['reflog', '--format=%gs'], h.repo)
    expect(reflog).not.toMatch(/Merge made by/)
    expect(sh(['reflog', '-1', '--format=%gs'], h.repo).trim()).toMatch(/^merge [0-9a-f]+: Fast-forward$/)
    expect(sh(['status', '--porcelain'], h.repo).trim()).toBe('')
    expect(readdirSync(h.worktrees)).toEqual(['.regatta-trash'])
    expect(worktreeCount(h.repo)).toBe(2)
  }, LONG)

  it('merges into the branch that was checked out when the merge was asked for', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const main = head(h.repo)
    sh(['checkout', '-q', '-b', 'topic'], h.repo)
    await h.engine.merge(run.id)
    expect(sh(['rev-parse', 'topic'], h.repo).trim()).toBe(sh(['rev-parse', 'HEAD'], h.repo).trim())
    expect(sh(['rev-parse', 'main'], h.repo).trim()).toBe(main)
    expect(readFileSync(join(h.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
  }, LONG)

  it('refuses while tracked files have changes, keeps the run, and goes through once they are put back', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const before = head(h.repo)
    writeFileSync(join(h.repo, 'README.md'), '# edited\n')
    await expect(h.engine.merge(run.id)).rejects.toThrow('Commit or stash your changes first. Merging needs a clean folder.')
    expect(head(h.repo)).toBe(before)
    expect(existsSync(join(h.repo, 'DONE.txt'))).toBe(false)
    expect(existsSync(join(h.repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(readFileSync(join(h.repo, 'README.md'), 'utf8')).toBe('# edited\n')
    intact(h, run)
    expect(runOf(h, run.id).mergeSummary).toBeNull()

    writeFileSync(join(h.repo, 'README.md'), '# project\n')
    expect((await h.engine.merge(run.id)).merged).toBe(true)
    expect(existsSync(run.worktree!)).toBe(false)
  }, LONG)

  it('refuses a detached HEAD, a merge the user has under way, and a folder it cannot read, and keeps the run', async () => {
    const h = writerHarness()
    const run = await endedRun(h)

    sh(['checkout', '-q', '--detach'], h.repo)
    const detached = head(h.repo)
    await expect(h.engine.merge(run.id)).rejects.toThrow('Check out a branch before merging.')
    expect(head(h.repo)).toBe(detached)
    intact(h, run)
    sh(['checkout', '-q', 'main'], h.repo)

    // The user's own merge, conflicted and waiting for them.
    sh(['checkout', '-q', '-b', 'topic'], h.repo)
    commit(h.repo, { 'README.md': 'topic\n' })
    sh(['checkout', '-q', 'main'], h.repo)
    commit(h.repo, { 'README.md': 'main\n' })
    expect(() => sh([...IDENTITY, 'merge', 'topic'], h.repo)).toThrow()
    const status = sh(['status', '--porcelain'], h.repo)
    const marker = readFileSync(join(h.repo, '.git', 'MERGE_HEAD'), 'utf8')
    await expect(h.engine.merge(run.id)).rejects.toThrow(/merge is already in progress/)
    expect(readFileSync(join(h.repo, '.git', 'MERGE_HEAD'), 'utf8')).toBe(marker)
    expect(sh(['status', '--porcelain'], h.repo)).toBe(status)
    intact(h, run)
    sh(['merge', '--abort'], h.repo)

    // Git cannot say whether the folder is clean.
    writeFileSync(join(h.repo, '.git', 'index'), 'this is not an index')
    await expect(h.engine.merge(run.id)).rejects.toThrow(/Could not tell whether your folder has uncommitted changes/)
    intact(h, run)
  }, LONG)

  it('moves a conflict into a scratch worktree: the folder never has a merge to abort, and nothing is left behind', async () => {
    const h = makeHarness({ claude: SCENARIOS['editor']! })
    const run = await endedRun(h)
    appendFileSync(join(h.repo, 'src', 'app.js'), '// made in the folder\n')
    sh([...IDENTITY, 'commit', '-am', 'conflicting work'], h.repo)
    const before = head(h.repo)
    await expect(h.engine.merge(run.id)).rejects.toThrow(/conflicts with work in main/)
    untouched(h, before)
    expect(readFileSync(join(h.repo, 'src', 'app.js'), 'utf8')).not.toContain('changed by the agent')
    // Only the run's own worktree is registered and only it is in the worktrees folder.
    expect(worktreeCount(h.repo)).toBe(2)
    expect(readdirSync(h.worktrees)).toEqual([`flow-${run.id}`])
    intact(h, run)
    expect(runOf(h, run.id).mergeSummary).toBeNull()

    // The user takes their commit back out (with a commit of its own); the same run then merges.
    sh([...IDENTITY, 'revert', '--no-edit', 'HEAD'], h.repo)
    expect((await h.engine.merge(run.id)).merged).toBe(true)
    expect(readFileSync(join(h.repo, 'src', 'app.js'), 'utf8')).toContain('changed by the agent')
  }, LONG)

  // A file in the folder that the merge would write over keeps its bytes, in both ways the merge can be made.
  for (const mode of ['fast-forward', 'merge commit'] as const) {
    for (const kind of ['ignored', 'untracked'] as const) {
      it(`refuses to overwrite an ${kind} file where the change would write (${mode})`, async () => {
        const h = writerHarness()
        const run = await endedRun(h)
        if (mode === 'merge commit') commit(h.repo, { 'LATER.txt': 'later\n' })
        // The user's own ignore rule, kept out of the repository's tracked files in .git/info/exclude.
        if (kind === 'ignored') appendFileSync(join(h.repo, '.git', 'info', 'exclude'), 'DONE.txt\n')
        writeFileSync(join(h.repo, 'DONE.txt'), 'precious\n')
        const before = head(h.repo)
        await expect(h.engine.merge(run.id)).rejects.toThrow(/DONE\.txt/)
        expect(readFileSync(join(h.repo, 'DONE.txt'), 'utf8')).toBe('precious\n')
        expect(head(h.repo)).toBe(before)
        expect(existsSync(join(h.repo, '.git', 'MERGE_HEAD'))).toBe(false)
        expect(worktreeCount(h.repo)).toBe(2)
        intact(h, run)

        // Once the user moves their file away, the same run merges.
        unlinkSync(join(h.repo, 'DONE.txt'))
        expect((await h.engine.merge(run.id)).merged).toBe(true)
        expect(readFileSync(join(h.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
      }, LONG)
    }
  }

  it('works for a project opened at a folder inside the repository, guarding ignored files by their place in the whole repository', async () => {
    // The agent works in the matching folder of the worktree (src), so what it writes lands in src.
    const theirs = (cwd: string): void => {
      writeDone(cwd)
      writeFileSync(join(cwd, 'cache.json'), '{"theirs":true}\n')
    }
    const h = makeHarness({ claude: { delayMs: 40, write: theirs } })
    const inner = new FlowEngine({ ...h.deps, root: () => join(h.repo, 'src') })
    const saved = inner.save(makeFlow())
    const started = await inner.run(saved.id)
    await waitFor('the run to finish', () => inner.runs().find((r) => r.id === started.id)?.status === 'done')
    appendFileSync(join(h.repo, '.git', 'info', 'exclude'), 'src/cache.json\n')
    writeFileSync(join(h.repo, 'src', 'cache.json'), '{"mine":true}\n')
    const before = head(h.repo)
    await expect(inner.merge(started.id)).rejects.toThrow(/src\/cache\.json/)
    expect(readFileSync(join(h.repo, 'src', 'cache.json'), 'utf8')).toBe('{"mine":true}\n')
    expect(head(h.repo)).toBe(before)

    unlinkSync(join(h.repo, 'src', 'cache.json'))
    expect((await inner.merge(started.id)).merged).toBe(true)
    expect(readFileSync(join(h.repo, 'src', 'cache.json'), 'utf8')).toBe('{"theirs":true}\n')
    expect(regattaBranches(h.repo)).toEqual([started.branch])
  }, LONG)

  it('merges two runs of one repository that are asked at the same moment one after the other, the second after a retry', async () => {
    const own = (cwd: string): void => writeFileSync(join(cwd, `${basename(cwd)}.txt`), 'mine\n')
    const h = makeHarness({ claude: { delayMs: 40, write: own } })
    const a = await endedRun(h, { steps: [agentStep('s1')] })
    const b = await endedRun(h, { steps: [agentStep('s1')] })
    // Both were asked for while main was at the same commit; the first one moves it, so the second is refused, not guessed at.
    const results = await Promise.allSettled([h.engine.merge(a.id), h.engine.merge(b.id)])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = results.findIndex((r) => r.status === 'rejected')
    expect(String((results[refused] as PromiseRejectedResult).reason)).toContain('moved on since the merge was asked for')
    const [refusedRun, otherRun] = refused === 0 ? [a, b] : [b, a]
    expect(existsSync(join(h.repo, `flow-${refusedRun.id}.txt`))).toBe(false)
    expect(existsSync(join(h.repo, `flow-${otherRun.id}.txt`))).toBe(true)
    intact(h, refusedRun)
    // Asked again, it is judged on the new state of the branch and goes through.
    expect((await h.engine.merge(refusedRun.id)).merged).toBe(true)
    expect(existsSync(join(h.repo, `flow-${refusedRun.id}.txt`))).toBe(true)
    expect(regattaBranches(h.repo).sort()).toEqual([a.branch, b.branch].sort())
    expect(sh(['status', '--porcelain'], h.repo).trim()).toBe('')
    expect(existsSync(join(h.repo, '.git', 'MERGE_HEAD'))).toBe(false)
  }, LONG)

  it('will not merge the same run twice, or two merges of one run at once', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const first = h.engine.merge(run.id)
    await expect(h.engine.merge(run.id)).rejects.toThrow('A merge or discard is already running for this run.')
    expect((await first).merged).toBe(true)
    await expect(h.engine.merge(run.id)).rejects.toThrow('Only isolated runs can be merged.')
  }, LONG)

  it('refuses to merge or discard when the repository identity cannot be read, and recovers when it can', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const headFile = join(h.repo, '.git', 'HEAD')
    const saved = readFileSync(headFile, 'utf8')
    rmSync(headFile)
    await expect(h.engine.merge(run.id)).rejects.toThrow(/Could not tell which repository/)
    await expect(h.engine.discard(run.id)).rejects.toThrow(/Could not tell which repository/)
    writeFileSync(headFile, saved)
    intact(h, run)
    expect((await h.engine.merge(run.id)).merged).toBe(true)
  }, LONG)

  it('brings home a run that never committed anything by saying the branch already has it, and moves what it made to the trash', async () => {
    const h = writerHarness()
    const run = await endedRun(h, { steps: [checkStep('s1', 'true')] })
    const before = head(h.repo)
    const result = await h.engine.merge(run.id)
    expect(result.summary).toMatch(/^main already had this change, so nothing was merged\. Removed 1 worktree and 0 branches\. Kept: Moved its worktree to Regatta's trash/)
    expect(head(h.repo)).toBe(before)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
  }, LONG)

  it('merges the commits an agent made itself, as the tested commit', async () => {
    const own = (cwd: string): void => {
      writeDone(cwd)
      sh(['add', '-A'], cwd)
      sh([...IDENTITY, 'commit', '-m', 'made by the agent'], cwd)
    }
    const h = makeHarness({ claude: { delayMs: 40, write: own } })
    const run = await endedRun(h)
    const result = await h.engine.merge(run.id)
    expect(result.summary).toMatch(/^Fast-forwarded main by 1 commit/)
    expect(sh(['log', '-1', '--format=%s'], h.repo).trim()).toBe('made by the agent')
    expect(existsSync(run.worktree!)).toBe(false)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
  }, LONG)
})

describe('what a run keeps instead of removing', () => {
  it('moves the worktree to the trash, preserving an edited, untracked or ignored file inside it, on merge and on discard', async () => {
    for (const how of ['merge', 'discard'] as const) {
      const h = writerHarness()
      const run = await endedRun(h)
      writeFileSync(join(run.worktree!, 'src', 'app.js'), 'export const app = 99\n')
      writeFileSync(join(run.worktree!, 'MINE.txt'), 'mine\n')
      mkdirSync(join(run.worktree!, 'local'))
      writeFileSync(join(run.worktree!, 'local', 'notes.txt'), 'git ignores my notes\n')

      if (how === 'merge') {
        const result = await h.engine.merge(run.id)
        expect(readFileSync(join(h.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
        expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
        expect(result.summary).toContain("Moved its worktree to Regatta's trash")
        await expect(h.engine.merge(run.id)).rejects.toThrow('Only isolated runs can be merged.')
      } else {
        await h.engine.discard(run.id)
      }
      expect(existsSync(run.worktree!)).toBe(false)
      const trashed = await listTrash(h.worktrees)
      expect(trashed).toHaveLength(1)
      expect(readFileSync(join(trashed[0]!.trashPath, 'src', 'app.js'), 'utf8')).toBe('export const app = 99\n')
      expect(readFileSync(join(trashed[0]!.trashPath, 'MINE.txt'), 'utf8')).toBe('mine\n')
      expect(readFileSync(join(trashed[0]!.trashPath, 'local', 'notes.txt'), 'utf8')).toBe('git ignores my notes\n')
      expect(regattaBranches(h.repo)).toEqual([run.branch])
      expect(runOf(h, run.id).worktree).toBeNull()
      expect(runOf(h, run.id).branch).toBeNull()
      expect(notesOf(h, run.id)).toContain("Moved its worktree to Regatta's trash")
    }
  }, LONG)

  it('moves a worktree with a program running inside it to the trash, and emptyTrash skips it while it is in use', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    mkdirSync(join(run.worktree!, 'deep'))
    leaveSleeper(join(run.worktree!, 'deep'))
    await new Promise((resolve) => setTimeout(resolve, 200))

    await h.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    expect(runOf(h, run.id).worktree).toBeNull()
    expect(runOf(h, run.id).branch).toBeNull()

    const first = await emptyTrash(h.worktrees)
    expect(first.outcomes.filter((o) => o.status === 'skipped')).toHaveLength(1)
    expect(first.outcomes[0]?.reason).toContain('in use')
    expect(regattaBranches(h.repo)).toEqual([run.branch])

    killSleepers()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const second = await emptyTrash(h.worktrees)
    expect(second.outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(regattaBranches(h.repo)).toEqual([])
  }, LONG)

  it('keeps the worktree and branch in place, and says why, when moving to the trash fails', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    writeFileSync(join(run.worktree!, 'MINE.txt'), 'mine\n')
    symlinkSync(temp('regatta-flow-fake-trash-'), join(h.worktrees, '.regatta-trash'))

    const result = await h.engine.merge(run.id)
    expect(readFileSync(join(h.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(result.summary).toContain('Removed 0 worktrees and 0 branches.')
    expect(result.summary).toMatch(/Kept: .*\.regatta-trash/)
    expect(existsSync(run.worktree!)).toBe(true)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    const kept = runOf(h, run.id)
    expect(kept.worktree).toBe(run.worktree)
    expect(kept.branch).toBe(run.branch)
    expect(kept.mergeSummary).toBe(result.summary)
    expect(notesOf(h, run.id)).toContain('.regatta-trash')
    await expect(h.engine.merge(run.id)).rejects.toThrow('That run was already merged.')

    // Discarding does not change its mind while the cause is there.
    await h.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(true)
    expect(regattaBranches(h.repo)).toEqual([run.branch])

    // Once the user has dealt with it, the next discard moves the worktree to the trash.
    unlinkSync(join(h.worktrees, '.regatta-trash'))
    await h.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    expect(runOf(h, run.id).worktree).toBeNull()
    expect(runOf(h, run.id).branch).toBeNull()
    expect(notesOf(h, run.id)).toContain("Moved its worktree to Regatta's trash")
    expect((await emptyTrash(h.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(regattaBranches(h.repo)).toEqual([])
  }, LONG)

  for (const how of ['merge', 'discard'] as const) {
    it(`moves the worktree to the trash and keeps a commit only its detached HEAD held, when ${how === 'merge' ? 'merging' : 'discarding'}`, async () => {
      const h = writerHarness()
      const run = await endedRun(h)
      sh(['checkout', '-q', '--detach'], run.worktree!)
      const lost = commit(run.worktree!, { 'detached.txt': 'made on a detached HEAD\n' }, 'detached work')
      sh(['checkout', '-q', run.branch!], run.worktree!)
      expect(sh(['status', '--porcelain'], run.worktree!).trim()).toBe('')

      if (how === 'merge') await h.engine.merge(run.id)
      else await h.engine.discard(run.id)
      expect(existsSync(run.worktree!)).toBe(false)
      expect((await emptyTrash(h.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
      expect(regattaBranches(h.repo)).toEqual([])
      // Nothing holds that commit but the keep commit made before the folder went, through expiry and collection.
      sh(['reflog', 'expire', '--expire=now', '--all'], h.repo)
      sh(['gc', '--prune=now', '--quiet'], h.repo)
      expect(keepHolds(h.repo, lost)).toBe(true)
      expect(sh(['show', `${lost}:detached.txt`], h.repo)).toBe('made on a detached HEAD\n')
    }, LONG)
  }

  it('moves a worktree whose detached commit only a stash and its own history held to the trash, so popping the stash and emptying the trash loses nothing', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const folder = run.worktree!
    // In the run's folder: detach, commit a file nothing else has, stash an edit of something else, switch back.
    sh(['checkout', '-q', '--detach'], folder)
    const lost = commit(folder, { 'detached.txt': 'made on a detached HEAD, and nowhere else\n' }, 'detached work')
    writeFileSync(join(folder, 'README.md'), '# edited, then stashed\n')
    sh([...IDENTITY, 'stash'], folder)
    sh(['checkout', '-q', run.branch!], folder)
    // The stash holds the commit as its parent: a check that counted it would call the commit safe.
    expect(sh(['rev-list', '-n', '1', 'refs/stash^'], h.repo).trim()).toBe(lost)
    expect(sh(['status', '--porcelain'], folder).trim()).toBe('')

    await h.engine.discard(run.id)
    expect(existsSync(folder)).toBe(false)
    expect((await emptyTrash(h.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(regattaBranches(h.repo)).toEqual([])

    // What the user does next: pops the stash, and lets git collect what nothing else holds.
    sh([...IDENTITY, 'stash', 'pop'], h.repo)
    sh(['reflog', 'expire', '--expire=now', '--all'], h.repo)
    sh(['gc', '--prune=now', '--quiet'], h.repo)
    expect(sh(['cat-file', '-t', lost], h.repo).trim()).toBe('commit')
    expect(keepHolds(h.repo, lost)).toBe(true)
    expect(sh(['show', `${lost}:detached.txt`], h.repo)).toBe('made on a detached HEAD, and nowhere else\n')
  }, LONG)

  it('moves a run worktree to the trash on discard, without ever merging, and emptying the trash removes its branch', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const before = head(h.repo)
    const tip = sh(['rev-parse', run.branch!], h.repo).trim()
    await h.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    // The run's commit is not lost with its branch or its folder: both are kept, in keep commits.
    expect(parkedRefs(h.repo).length).toBeGreaterThanOrEqual(1)
    expect(sh(['rev-parse', `${branchKeepRef(h, run.id)}^1`], h.repo).trim()).toBe(tip)
    expect(keepHolds(h.repo, tip)).toBe(true)
    expect(worktreeCount(h.repo)).toBe(2)
    expect((await emptyTrash(h.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(regattaBranches(h.repo)).toEqual([])
    expect(worktreeCount(h.repo)).toBe(1)
    untouched(h, before)
    expect(existsSync(join(h.repo, 'DONE.txt'))).toBe(false)
    expect(runOf(h, run.id).worktree).toBeNull()
    expect(runOf(h, run.id).branch).toBeNull()
  }, LONG)

  it('keeps a run branch the user moved on, and says so, after a merge and after a discard', async () => {
    for (const how of ['merge', 'discard'] as const) {
      const h = writerHarness()
      const run = await endedRun(h)
      const tip = sh(['rev-parse', run.branch!], h.repo).trim()
      // The user commits on the run's branch in the run's worktree: the folder is clean again afterwards.
      const theirs = commit(run.worktree!, { 'USERS.txt': 'my own work\n' }, "user's own commit")
      if (how === 'merge') {
        const result = await h.engine.merge(run.id)
        expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
        // Only the tested commit came home, not the user's later commit on the run branch.
        expect(head(h.repo)).toBe(tip)
        expect(existsSync(join(h.repo, 'USERS.txt'))).toBe(false)
        // The worktree went and the branch stayed: asking again says it was merged, not that it was discarded.
        await expect(h.engine.merge(run.id)).rejects.toThrow('Only isolated runs can be merged.')
      } else {
        await h.engine.discard(run.id)
      }
      expect(sh(['rev-parse', run.branch!], h.repo).trim()).toBe(theirs)
      expect(regattaBranches(h.repo)).toEqual([run.branch])
      expect(existsSync(run.worktree!)).toBe(false)
      expect(notesOf(h, run.id)).toContain(run.branch)
      expect(runOf(h, run.id).worktree).toBeNull()
    }
  }, LONG)

  it('never touches a worktree or branch someone recreated after the first discard', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    await h.engine.discard(run.id)
    expect((await emptyTrash(h.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    // The user makes a new worktree on a new branch with the very same names, then a second discard comes.
    sh(['worktree', 'add', '-b', run.branch!, run.worktree!, 'main'], h.repo)
    writeFileSync(join(run.worktree!, 'MINE.txt'), 'mine\n')
    const theirs = sh(['rev-parse', run.branch!], h.repo).trim()
    await expect(h.engine.discard(run.id)).rejects.toThrow('That run has no worktree to discard.')
    expect(readFileSync(join(run.worktree!, 'MINE.txt'), 'utf8')).toBe('mine\n')
    expect(sh(['rev-parse', run.branch!], h.repo).trim()).toBe(theirs)
  }, LONG)

  it('leaves alone a different worktree that now sits at the run path, and still brings the change home', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    // Our worktree is replaced by one of the user's own at the same path.
    sh(['worktree', 'remove', '--force', run.worktree!], h.repo)
    sh(['worktree', 'add', '-b', 'users-branch', run.worktree!, 'main'], h.repo)
    writeFileSync(join(run.worktree!, 'MINE.txt'), 'mine\n')

    const result = await h.engine.merge(run.id)
    expect(result.merged).toBe(true)
    expect(readFileSync(join(h.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(readFileSync(join(run.worktree!, 'MINE.txt'), 'utf8')).toBe('mine\n')
    expect(sh(['branch', '--list', 'users-branch'], h.repo).trim()).not.toBe('')
    expect(result.summary).toContain('is not the worktree Regatta made any more')
    // The folder is not forgotten: it stays on the run, so a later discard looks at it again.
    expect(runOf(h, run.id).worktree).toBe(run.worktree)
  }, LONG)

  it('moves a run folder whose own branch the agent left to the trash on discard, and never commits the agent work onto another branch', async () => {
    const rogue = (cwd: string): void => {
      writeDone(cwd)
      sh(['checkout', '-q', '-b', 'rogue'], cwd)
    }
    const h = makeHarness({ claude: { delayMs: 40, write: rogue } })
    const base = head(h.repo)
    const run = await endedRun(h, {}, 'failed')
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'failed'])
    expect(run.steps[1]?.output).toContain(`is not on ${run.branch} any more`)
    // Nothing of the agent's was committed anywhere, so nothing moved.
    expect(sh(['rev-parse', 'rogue'], h.repo).trim()).toBe(base)
    expect(sh(['rev-parse', run.branch!], h.repo).trim()).toBe(base)
    expect(sh(['status', '--porcelain'], run.worktree!)).toContain('?? DONE.txt')

    await h.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    const trashed = await listTrash(h.worktrees)
    expect(trashed).toHaveLength(1)
    expect(readFileSync(join(trashed[0]!.trashPath, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    expect(notesOf(h, run.id)).toContain("Moved its worktree to Regatta's trash")
  }, LONG)
})

describe('discarding keeps a copy of the run work', () => {
  it('parks the work of a stopped run, so it is still there after the reflog is expired and the repository collected', async () => {
    const h = makeHarness({ claude: { delayMs: 60000, onStopped: (cwd) => writeFileSync(join(cwd, 'LATE.txt'), 'partial work\n') } })
    const saved = h.engine.save(makeFlow())
    const started = await h.engine.run(saved.id)
    await waitFor('the agent step to run', () => runOf(h, started.id).steps[0]?.status === 'running')
    h.engine.stop(started.id)
    await waitFor('the run to stop', () => runOf(h, started.id).status === 'stopped')
    const run = runOf(h, started.id)
    // Stopping committed what the agent had written, on the run's own branch.
    const work = sh(['rev-parse', run.branch!], h.repo).trim()
    expect(sh(['log', '-1', '--format=%s', work], h.repo).trim()).toBe(`Flow run ${run.id}: Ship it`)
    expect(sh(['show', `${work}:LATE.txt`], h.repo)).toBe('partial work\n')

    await h.engine.discard(run.id)
    const parked = branchKeepRef(h, run.id)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    expect(parkedRefs(h.repo)).toContain(parked)
    // The keep commit has an empty tree and the run's tip as its first parent.
    expect(sh(['rev-parse', `${parked}^1`], h.repo).trim()).toBe(work)
    const restore = `flow-${run.id}-restored`
    const sentence = `Kept a copy of the run's work at ${parked} (restore the work with git branch ${restore} ${parked}^1). git log ${parked} shows everything kept.`
    expect(runOf(h, run.id).notes).toContain(sentence)
    // The window is told, not only the saved file.
    expect(h.emitted.at(-1)?.notes).toContain(sentence)

    expect((await emptyTrash(h.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(regattaBranches(h.repo)).toEqual([])
    // Everything git would have given back by itself is gone: the deleted branch's reflog, then every unreachable object.
    sh(['reflog', 'expire', '--expire=now', '--all'], h.repo)
    sh(['gc', '--prune=now', '--quiet'], h.repo)
    expect(sh(['cat-file', '-t', work], h.repo).trim()).toBe('commit')
    expect(sh(['rev-parse', `${parked}^1`], h.repo).trim()).toBe(work)
    expect(sh(['show', `${parked}^1:LATE.txt`], h.repo)).toBe('partial work\n')
    // Do exactly what the note says, the way the window copies it and a shell reads it. The tip is the first
    // parent of the keep commit, so the restore command gets the work back (a branch made from the ref itself
    // would hold an empty tree), and git log of the ref lists everything kept.
    const command = noteCommand(sentence)
    expect(command).toBe(`git branch ${restore} ${parked}^1`)
    execFileSync('/bin/sh', ['-c', command!], { cwd: h.repo, encoding: 'utf8', timeout: 15000 })
    expect(sh(['show', `${restore}:LATE.txt`], h.repo)).toBe('partial work\n')
    expect(sh(['log', parked, '--format=%H'], h.repo).split('\n')).toContain(work)
    // The ref itself is not the work: its tree is empty.
    expect(sh(['ls-tree', '-r', '--name-only', parked], h.repo).trim()).toBe('')
  }, LONG)

  it('parks a run whose tip is a commit the agent made itself', async () => {
    const own = (cwd: string): void => {
      writeDone(cwd)
      sh(['add', '-A'], cwd)
      sh([...IDENTITY, 'commit', '-m', "the agent's own commit"], cwd)
    }
    const h = makeHarness({ claude: { delayMs: 40, write: own } })
    const run = await endedRun(h)
    const work = sh(['rev-parse', run.branch!], h.repo).trim()
    expect(sh(['log', '-1', '--format=%s', work], h.repo).trim()).toBe("the agent's own commit")
    await h.engine.discard(run.id)
    const parked = branchKeepRef(h, run.id)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    expect(sh(['rev-parse', `${parked}^1`], h.repo).trim()).toBe(work)
    expect(sh(['show', `${parked}^1:DONE.txt`], h.repo)).toBe('done\n')
  }, LONG)

  it('parks the work of a failed run too', async () => {
    const h = makeHarness({ claude: SCENARIOS['fail']! })
    const run = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', 'true')] }, 'failed')
    const work = sh(['rev-parse', run.branch!], h.repo).trim()
    await h.engine.discard(run.id)
    const parked = branchKeepRef(h, run.id)
    expect(sh(['rev-parse', `${parked}^1`], h.repo).trim()).toBe(work)
    expect(notesOf(h, run.id)).toContain(`Kept a copy of the run's work at ${parked}`)
  }, LONG)

  it('keeps a copy even when the user branch already holds the work, and when the run never committed', async () => {
    const merged = writerHarness()
    const done = await endedRun(merged)
    const tip = sh(['rev-parse', done.branch!], merged.repo).trim()
    await merged.engine.merge(done.id)
    // Nobody asks whether the user's branch holds it: the work is kept regardless, and the branch is untouched.
    expect(keepHolds(merged.repo, tip)).toBe(true)
    expect(head(merged.repo)).toBe(tip)
    expect(notesOf(merged, done.id)).toContain('Kept a copy')

    // A run of one check changes nothing, so its branch is where the user's branch is.
    const idle = writerHarness()
    const quiet = await endedRun(idle, { steps: [checkStep('s1', 'true')] })
    const base = head(idle.repo)
    await idle.engine.discard(quiet.id)
    expect(regattaBranches(idle.repo)).toEqual([quiet.branch])
    expect(keepHolds(idle.repo, base)).toBe(true)
    expect(head(idle.repo)).toBe(base)
  }, LONG)

  it('keeps under another name when the first one is taken by a different commit, and names the copy that was made', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const work = sh(['rev-parse', run.branch!], h.repo).trim()
    const taken = `refs/regatta/discarded/flow-${run.id}`
    sh(['update-ref', taken, head(h.repo)], h.repo)
    await h.engine.discard(run.id)
    // The taken ref is not touched, and the copy was made under a name that was free.
    expect(sh(['rev-parse', taken], h.repo).trim()).toBe(head(h.repo))
    const made = branchKeepRef(h, run.id)
    expect(made).not.toBe(taken)
    expect(made.startsWith(`${taken}-`)).toBe(true)
    expect(sh(['rev-parse', `${made}^1`], h.repo).trim()).toBe(work)
  }, LONG)

  it('suggests the next free branch name when the first is taken in the repository, and the command works as written', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    sh(['branch', `flow-${run.id}-restored`, 'main'], h.repo)
    sh(['branch', `flow-${run.id}-restored-2`, 'main'], h.repo)
    await h.engine.discard(run.id)
    const parked = branchKeepRef(h, run.id)
    const sentence = `Kept a copy of the run's work at ${parked} (restore the work with git branch flow-${run.id}-restored-3 ${parked}^1). git log ${parked} shows everything kept.`
    expect(runOf(h, run.id).notes).toContain(sentence)
    execFileSync('/bin/sh', ['-c', noteCommand(sentence)!], { cwd: h.repo, encoding: 'utf8', timeout: 15000 })
    expect(sh(['show', `flow-${run.id}-restored-3:DONE.txt`], h.repo)).toBe('done\n')
    // The branches that were there are untouched.
    expect(sh(['rev-parse', `flow-${run.id}-restored`], h.repo).trim()).toBe(head(h.repo))
  }, LONG)

  it('gives each copy of one run a branch name of its own, and reads files that kept plain refs', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    // The folder is gone; the branch cannot be deleted while a lock sits on its ref, so every discard makes another copy and keeps the run.
    sh(['worktree', 'remove', '--force', run.worktree!], h.repo)
    const lock = join(h.repo, '.git', 'refs', 'heads', 'regatta', `flow-${run.id}.lock`)
    writeFileSync(lock, '')
    await h.engine.discard(run.id)
    await h.engine.discard(run.id)
    expect(runOf(h, run.id).branch).toBe(run.branch)
    const copiesOf = (r: { notes?: string[] } | undefined): string[] => (r?.notes ?? []).filter((note) => note.startsWith("Kept a copy of the run's work at"))
    const two = copiesOf(runOf(h, run.id))
    expect(two).toHaveLength(2)
    expect(two.map((note) => note.match(/git branch (\S+) /)![1])).toEqual([`flow-${run.id}-restored`, `flow-${run.id}-restored-2`])
    expect(new Set(two.map((note) => note.match(/work at (\S+) /)![1])).size).toBe(2)

    // Files from before the restore name was kept hold the plain refs; they read with the names the notes would have had.
    const file = join(h.dataDir, 'flow-runs', `${run.id}.json`)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { parked: { ref: string; restore: string }[] }
    expect(saved.parked).toHaveLength(2)
    saved.parked = saved.parked.map((entry) => entry.ref) as unknown as { ref: string; restore: string }[]
    writeFileSync(file, JSON.stringify(saved))
    const fresh = new FlowEngine(h.deps)
    unlinkSync(lock)
    await fresh.discard(run.id)
    const notes = copiesOf(fresh.runs().find((r) => r.id === run.id))
    expect(notes).toHaveLength(3)
    expect(notes.slice(0, 2)).toEqual(two)
    expect(notes[2]).toContain(`git branch flow-${run.id}-restored-3 `)
    // All three commands work, one after the other.
    for (const note of notes) execFileSync('/bin/sh', ['-c', noteCommand(note)!], { cwd: h.repo, encoding: 'utf8', timeout: 15000 })
    for (const name of ['restored', 'restored-2', 'restored-3']) expect(sh(['show', `flow-${run.id}-${name}:DONE.txt`], h.repo)).toBe('done\n')
  }, LONG)

  it('retries the branch of a run whose folder the user deleted by hand, without pruning anything for them', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const work = sh(['rev-parse', run.branch!], h.repo).trim()
    const registration = join(h.repo, '.git', 'worktrees', `flow-${run.id}`)
    rmSync(run.worktree!, { recursive: true, force: true })
    await h.engine.discard(run.id)
    // Git still lists the folder as a worktree on the branch, so the branch is kept and nothing is pruned.
    expect(existsSync(registration)).toBe(true)
    expect(runOf(h, run.id).worktree).toBeNull()
    expect(runOf(h, run.id).branch).toBe(run.branch)
    expect(notesOf(h, run.id)).toContain('checked out in a worktree')
    expect(sh(['rev-parse', run.branch!], h.repo).trim()).toBe(work)

    // The user tidies up with git itself; the next discard parks the commits and deletes the branch.
    sh(['worktree', 'prune'], h.repo)
    await h.engine.discard(run.id)
    expect(runOf(h, run.id).branch).toBeNull()
    expect(regattaBranches(h.repo)).toEqual([])
    expect(sh(['rev-parse', `${branchKeepRef(h, run.id)}^1`], h.repo).trim()).toBe(work)
  }, LONG)

  it('tries a branch it had to keep again at the next discard, and lets go of it once it is gone', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const theirs = commit(run.worktree!, { 'USERS.txt': 'my own work\n' }, "user's own commit")
    sh(['worktree', 'remove', '--force', run.worktree!], h.repo)
    await h.engine.discard(run.id)
    // The folder was already gone; the branch has the user's commit on it, so it stays, and stays ours to deal with.
    expect(existsSync(run.worktree!)).toBe(false)
    expect(runOf(h, run.id).worktree).toBeNull()
    expect(runOf(h, run.id).branch).toBe(run.branch)
    expect(notesOf(h, run.id)).toContain(`Branch ${run.branch} was kept`)
    await expect(h.engine.merge(run.id)).rejects.toThrow('That run was discarded, so there is nothing to merge.')
    await h.engine.discard(run.id)
    expect(sh(['rev-parse', run.branch!], h.repo).trim()).toBe(theirs)
    expect(runOf(h, run.id).branch).toBe(run.branch)
    expect(parkedRefs(h.repo)).toHaveLength(0)

    // The user deletes the branch themselves: the next discard has nothing left to do and lets go of it.
    sh(['update-ref', '-d', `refs/heads/${run.branch}`], h.repo)
    await h.engine.discard(run.id)
    expect(runOf(h, run.id).branch).toBeNull()
    const file = JSON.parse(readFileSync(join(h.dataDir, 'flow-runs', `${run.id}.json`), 'utf8')) as Record<string, unknown>
    expect(file['owned']).toBeUndefined()
    await expect(h.engine.discard(run.id)).rejects.toThrow('That run has no worktree to discard.')
  }, LONG)
})

describe('checks in a temporary worktree', () => {
  it('runs a check that writes files away from the run: its folder stays as the agent left it', async () => {
    const h = writerHarness()
    const run = await endedRun(h, {
      steps: [agentStep('s1'), checkStep('s2', 'echo output > coverage.txt; mkdir -p dist; echo built > dist/app.js; test -f DONE.txt && pwd')]
    })
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'done'])
    // The check ran at the committed tip: DONE.txt, which the agent had not committed, was there.
    expect(run.steps[1]?.exitCode).toBe(0)
    expect(run.steps[1]?.output).toMatch(new RegExp(`flow-${run.id}-check-2$`))
    expect(existsSync(join(run.worktree!, 'coverage.txt'))).toBe(false)
    expect(existsSync(join(run.worktree!, 'dist'))).toBe(false)
    expect(sh(['status', '--porcelain', '--ignored'], run.worktree!).trim()).toBe('')
    // The temporary worktree is gone again, and git has forgotten it.
    expect(readdirSync(h.worktrees)).toEqual([`flow-${run.id}`])
    expect(worktreeCount(h.repo)).toBe(2)
    // What the check wrote never reaches the repository either.
    await h.engine.merge(run.id)
    expect(existsSync(join(h.repo, 'coverage.txt'))).toBe(false)
    expect(existsSync(join(h.repo, 'dist'))).toBe(false)
  }, LONG)

  it('commits the work first with the run author, so the check sees the commit it is judging', async () => {
    const h = writerHarness()
    const run = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', 'git log -1 --format="%an <%ae>|%s"')] })
    // The check ran at the commit the engine made, which is the one a merge brings in.
    expect(run.steps[1]?.output).toBe(`Regatta <regatta@localhost>|Flow run ${run.id}: Ship it`)
    expect(sh(['log', '--format=%an <%ae>|%s', '-1', run.branch!], h.repo).trim()).toBe(run.steps[1]?.output)
    expect(sh(['rev-list', '--count', `main..${run.branch}`], h.repo).trim()).toBe('1')
  }, LONG)

  it('gives the check and the run each their own copy of the project node_modules, never a link', async () => {
    const h = writerHarness()
    mkdirSync(join(h.repo, 'node_modules'))
    writeFileSync(join(h.repo, 'node_modules', 'marker.txt'), 'installed\n')
    const run = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', 'cat node_modules/marker.txt && test ! -L node_modules')] })
    // The check found the tools in its own folder, which is a copy.
    expect(run.steps[1]?.output).toBe('installed')
    expect(run.steps[1]?.status).toBe('done')
    // So does the run: a real folder with its own contents, another one than the project's.
    const copy = join(run.worktree!, 'node_modules')
    expect(lstatSync(copy).isDirectory()).toBe(true)
    expect(lstatSync(copy).ino).not.toBe(lstatSync(join(h.repo, 'node_modules')).ino)
    expect(readFileSync(join(copy, 'marker.txt'), 'utf8')).toBe('installed\n')
    expect(readdirSync(h.worktrees)).toEqual([`flow-${run.id}`])
    // The repository ignores `node_modules/`; the run's commit holds no node_modules either way.
    const tip = sh(['rev-parse', run.branch!], h.repo).trim()
    expect(sh(['ls-tree', '-r', '--name-only', tip], h.repo).split('\n')).not.toContain('node_modules')
    const result = await h.engine.merge(run.id)
    expect(result.merged).toBe(true)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(readFileSync(join(h.repo, 'node_modules', 'marker.txt'), 'utf8')).toBe('installed\n')
    expect(sh(['status', '--porcelain'], h.repo).trim()).toBe('')
  }, LONG)

  it('makes one temporary worktree per check step and removes each, whether the check passes or fails', async () => {
    const h = writerHarness()
    const run = await endedRun(
      h,
      { steps: [agentStep('s1'), checkStep('s2', 'test -f DONE.txt'), checkStep('s3', 'test -f MISSING.txt'), checkStep('s4', 'true')] },
      'failed'
    )
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'done', 'failed', 'skipped'])
    expect(readdirSync(h.worktrees)).toEqual([`flow-${run.id}`])
    expect(worktreeCount(h.repo)).toBe(2)
  }, LONG)

  it('commits a stopped or failed run, so its folder is clean and a discard moves it to the trash', async () => {
    const h = makeHarness({ claude: SCENARIOS['fail']! })
    const failed = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', 'true')] }, 'failed')
    expect(failed.steps.map((s) => s.status)).toEqual(['failed', 'skipped'])
    expect(sh(['status', '--porcelain'], failed.worktree!).trim()).toBe('')
    expect(sh(['log', '--format=%an|%s', '-1', failed.branch!], h.repo).trim()).toBe(`Regatta|Flow run ${failed.id}: Ship it`)
    await h.engine.discard(failed.id)
    expect(existsSync(failed.worktree!)).toBe(false)
    expect(regattaBranches(h.repo)).toEqual([failed.branch])
  }, LONG)
})

describe('programs a run could not stop', () => {
  it('holds the folder of an agent whose programs could not be stopped: it and its branch are never removed', async () => {
    const h = makeHarness({ claude: SCENARIOS['stuck']! })
    const base = head(h.repo)
    const run = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', 'true')] }, 'failed')
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'skipped'])
    expect(run.steps[0]?.output).toContain('could not be stopped')
    expect(notesOf(h, run.id)).toContain('could not be stopped, so the folder and its branch were kept.')
    // Nothing is committed while something may still write there.
    expect(sh(['rev-parse', run.branch!], h.repo).trim()).toBe(base)
    expect(sh(['status', '--porcelain'], run.worktree!)).toContain('?? DONE.txt')

    // No amount of asking removes it: the engine does not know whether the programs are gone.
    for (let i = 0; i < 2; i++) {
      await h.engine.discard(run.id)
      expect(existsSync(run.worktree!)).toBe(true)
      expect(readFileSync(join(run.worktree!, 'DONE.txt'), 'utf8')).toBe('done\n')
      expect(regattaBranches(h.repo)).toEqual([run.branch])
      expect(runOf(h, run.id).worktree).toBe(run.worktree)
      expect(runOf(h, run.id).branch).toBe(run.branch)
    }
    untouchedMain(h, base)
  }, LONG)

  it('holds a folder that looks pristine all the same: with nothing written, only the hold keeps it', async () => {
    for (const how of ['ended', 'stopped'] as const) {
      const h = makeHarness({ claude: SCENARIOS[how === 'ended' ? 'stuckQuiet' : 'stuckSlow']! })
      const saved = h.engine.save(makeFlow({ steps: [agentStep('s1')] }))
      const started = await h.engine.run(saved.id)
      if (how === 'stopped') {
        await waitFor('the agent step to run', () => runOf(h, started.id).steps[0]?.status === 'running')
        h.engine.stop(started.id)
        await waitFor('the run to stop', () => runOf(h, started.id).status === 'stopped')
      } else {
        await waitFor('the run to fail', () => runOf(h, started.id).status === 'failed')
      }
      const run = runOf(h, started.id)
      expect(sh(['status', '--porcelain', '--ignored'], run.worktree!).trim()).toBe('')
      expect(notesOf(h, run.id)).toContain('could not be stopped')
      await h.engine.discard(run.id)
      expect(existsSync(run.worktree!)).toBe(true)
      expect(regattaBranches(h.repo)).toEqual([run.branch])
      expect(runOf(h, run.id).worktree).toBe(run.worktree)
    }
  }, LONG)

  it('holds the temporary folder of a check whose programs could not be stopped, and still moves the run itself to the trash', async () => {
    const h = writerHarness({ supervise: { killGraceMs: 100, giveUpMs: 200 } })
    const stuck = await stuckCheck(h)
    try {
      // A check folder has no branch, and the note does not say it has.
      expect(notesOf(h, stuck.id)).toContain('could not be stopped, so the folder was kept.')
      expect(notesOf(h, stuck.id)).not.toContain('branch were kept')
      // The temporary folder is held: it stays, registered, and nothing removes it.
      expect(existsSync(stuck.pidFile)).toBe(true)
      expect(worktreeCount(h.repo)).toBe(3)
      const run = runOf(h, stuck.id)
      await h.engine.discard(stuck.id)
      // The run's own folder was committed and clean, and the program was never in it, so it moves to the trash.
      expect(existsSync(run.worktree!)).toBe(false)
      expect(regattaBranches(h.repo)).toEqual([run.branch])
      expect(existsSync(stuck.pidFile)).toBe(true)
      expect(worktreeCount(h.repo)).toBe(3)
      expect((await emptyTrash(h.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
      expect(regattaBranches(h.repo)).toEqual([])
      expect(worktreeCount(h.repo)).toBe(2)
    } finally {
      stuck.kill()
    }
  }, LONG)
})

describe('stopping and discarding while a run is live', () => {
  it('waits for the agent to wind down before removing anything, then moves what the stopped run left to the trash', async () => {
    let sawFolder: boolean | null = null
    const h = makeHarness({
      claude: {
        delayMs: 60000,
        stopMs: 400,
        onStopped: (cwd) => {
          sawFolder = existsSync(cwd)
          writeFileSync(join(cwd, 'LATE.txt'), 'written while stopping\n')
        }
      }
    })
    const saved = h.engine.save(makeFlow())
    const started = await h.engine.run(saved.id)
    await waitFor('the agent step to run', () => runOf(h, started.id).steps[0]?.status === 'running')
    const worktree = runOf(h, started.id).worktree!
    await h.engine.discard(started.id)
    // The folder was still there when the agent finished writing into it.
    expect(sawFolder).toBe(true)
    expect(runOf(h, started.id).status).toBe('stopped')
    expect(existsSync(worktree)).toBe(false)
    expect(regattaBranches(h.repo)).toEqual([started.branch])
    expect(h.stopped).toEqual(['claude'])
  }, LONG)

  it('preserves what a stopped run left inside the trash when the user wrote into its folder after it ended', async () => {
    const h = makeHarness({ claude: SCENARIOS['slow']! })
    const saved = h.engine.save(makeFlow())
    const started = await h.engine.run(saved.id)
    await waitFor('the agent step to run', () => runOf(h, started.id).steps[0]?.status === 'running')
    h.engine.stop(started.id)
    await waitFor('the run to stop', () => runOf(h, started.id).status === 'stopped')
    const worktree = runOf(h, started.id).worktree!
    writeFileSync(join(worktree, 'MINE.txt'), 'mine\n')
    await h.engine.discard(started.id)
    expect(existsSync(worktree)).toBe(false)
    const trashed = await listTrash(h.worktrees)
    expect(trashed).toHaveLength(1)
    expect(readFileSync(join(trashed[0]!.trashPath, 'MINE.txt'), 'utf8')).toBe('mine\n')
    expect(regattaBranches(h.repo)).toEqual([`regatta/flow-${started.id}`])
  }, LONG)

  it('stops a check of an isolated run with every program it started, and removes its temporary folder', async () => {
    const h = writerHarness()
    const saved = h.engine.save(makeFlow({ steps: [agentStep('s1'), checkStep('s2', 'echo $$ > shell.pid; sleep 300 & echo $! > child.pid; wait')] }))
    const started = await h.engine.run(saved.id)
    const folder = (): string => join(h.worktrees, `flow-${started.id}-check-2`)
    await waitFor('the check to start its program', () => existsSync(join(folder(), 'child.pid')) && readFileSync(join(folder(), 'child.pid'), 'utf8').trim() !== '')
    const shell = Number(readFileSync(join(folder(), 'shell.pid'), 'utf8').trim())
    const child = Number(readFileSync(join(folder(), 'child.pid'), 'utf8').trim())
    h.engine.stop(started.id)
    await waitFor('the run to stop', () => runOf(h, started.id).status === 'stopped')
    expect(alive(shell)).toBe(false)
    expect(alive(child)).toBe(false)
    expect(existsSync(folder())).toBe(false)
    expect(readdirSync(h.worktrees)).toEqual([`flow-${started.id}`])
    expect(worktreeCount(h.repo)).toBe(2)
    // What the agent wrote before the stop is committed on the run's branch; the run folder is clean.
    expect(sh(['status', '--porcelain'], runOf(h, started.id).worktree!).trim()).toBe('')
    await h.engine.discard(started.id)
    expect(regattaBranches(h.repo)).toEqual([`regatta/flow-${started.id}`])
  }, LONG)

  it('stops a check in a plain run with every program it started', async () => {
    const h = writerHarness()
    const saved = h.engine.save(makeFlow({ isolate: false, steps: [checkStep('s1', 'echo $$ > shell.pid; sleep 300 & echo $! > child.pid; wait')] }))
    const started = await h.engine.run(saved.id)
    await waitFor('the check to start its program', () => existsSync(join(h.repo, 'child.pid')) && readFileSync(join(h.repo, 'child.pid'), 'utf8').trim() !== '')
    const shell = Number(readFileSync(join(h.repo, 'shell.pid'), 'utf8').trim())
    const child = Number(readFileSync(join(h.repo, 'child.pid'), 'utf8').trim())
    expect(alive(child)).toBe(true)
    h.engine.stop(started.id)
    await waitFor('the run to stop', () => runOf(h, started.id).status === 'stopped')
    expect(alive(shell)).toBe(false)
    expect(alive(child)).toBe(false)
  }, LONG)

  it('ends the programs a passing check left running in the background', async () => {
    const h = writerHarness()
    const saved = h.engine.save(makeFlow({ isolate: false, steps: [checkStep('s1', 'sleep 300 & echo $! > bg.pid')] }))
    const started = await h.engine.run(saved.id)
    await waitFor('the run to finish', () => runOf(h, started.id).status === 'done')
    const pid = Number(readFileSync(join(h.repo, 'bg.pid'), 'utf8').trim())
    expect(alive(pid)).toBe(false)
  }, LONG)
})

describe('a run in the user folder', () => {
  it('never commits, branches or makes worktrees: only its programs are supervised', async () => {
    const h = writerHarness()
    const before = head(h.repo)
    const saved = h.engine.save(makeFlow({ isolate: false }))
    const started = await h.engine.run(saved.id)
    await waitFor('the run to finish', () => runOf(h, started.id).status === 'done')
    expect(head(h.repo)).toBe(before)
    expect(sh(['branch', '--list'], h.repo).trim()).toBe('* main')
    expect(existsSync(join(h.repo, '.git', 'worktrees'))).toBe(false)
    expect(readdirSync(h.worktrees)).toEqual([])
    // The agent wrote into the user's own folder, as a plain run always did.
    expect(readFileSync(join(h.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(sh(['status', '--porcelain'], h.repo).trim()).toBe('?? DONE.txt')
    const run = runOf(h, started.id)
    expect(run.worktree).toBeNull()
    expect(run.branch).toBeNull()
    await expect(h.engine.merge(run.id)).rejects.toThrow('Only isolated runs can be merged.')
    await expect(h.engine.discard(run.id)).rejects.toThrow('That run has no worktree to discard.')
  }, LONG)

  it('fails the run and says so when the agent leaves programs that could not be stopped', async () => {
    const h = makeHarness({ claude: SCENARIOS['stuck']! })
    const saved = h.engine.save(makeFlow({ isolate: false, steps: [agentStep('s1'), checkStep('s2', 'true')] }))
    const started = await h.engine.run(saved.id)
    await waitFor('the run to fail', () => runOf(h, started.id).status === 'failed')
    const run = runOf(h, started.id)
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'skipped'])
    expect(run.steps[0]?.output).toContain('could not be stopped')
    expect(notesOf(h, started.id)).toContain('They may still change files in your folder')
  }, LONG)
})

describe('what a run owns survives a restart, and nothing else is touched', () => {
  it('merges and discards runs after the app restarted, from the proof saved with each run', async () => {
    const h = writerHarness()
    const first = await endedRun(h)
    const second = await endedRun(h)
    const fresh = new FlowEngine(h.deps)
    expect(fresh.runs().find((r) => r.id === first.id)?.worktree).toBe(first.worktree)
    const result = await fresh.merge(first.id)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(readFileSync(join(h.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    await fresh.discard(second.id)
    expect(existsSync(second.worktree!)).toBe(false)
    expect(regattaBranches(h.repo).sort()).toEqual([first.branch, second.branch].sort())
  }, LONG)

  it('will not merge or remove a run it has no proof for, and leaves its folder and branch alone', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    // A run file from a version that did not keep the proof.
    const file = join(h.dataDir, 'flow-runs', `${run.id}.json`)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(saved['owned']).toBeTruthy()
    delete saved['owned']
    writeFileSync(file, JSON.stringify(saved))
    const fresh = new FlowEngine(h.deps)
    const before = head(h.repo)
    await expect(fresh.merge(run.id)).rejects.toThrow(/no record of the worktree this run made/)
    await expect(fresh.discard(run.id)).rejects.toThrow(/no record of the worktree this run made/)
    expect(head(h.repo)).toBe(before)
    expect(existsSync(run.worktree!)).toBe(true)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
  }, LONG)

  it('loads a run that was live when the app quit as stopped and keeps what it owns', async () => {
    const h = makeHarness({ claude: SCENARIOS['slow']! })
    const saved = h.engine.save(makeFlow())
    const started = await h.engine.run(saved.id)
    await waitFor('the agent step to run', () => runOf(h, started.id).steps[0]?.status === 'running')
    const fresh = new FlowEngine(h.deps)
    const loaded = fresh.runs().find((r) => r.id === started.id)!
    expect(loaded.status).toBe('stopped')
    expect(loaded.worktree).toBe(started.worktree)
    // It is the quit run's own folder: movable to the trash.
    await fresh.discard(started.id)
    expect(existsSync(started.worktree!)).toBe(false)
    expect(regattaBranches(h.repo)).toEqual([started.branch])
  }, LONG)

  it('picks another run id when the first one clashes with an existing branch or folder, and never touches them', async () => {
    const ids = ['aaaa', 'aaaa', 'bbbb', 'cccc']
    const h = writerHarness({ newId: () => ids.shift() ?? 'zzzz' })
    // Someone else's branch and folder under the first name.
    sh(['branch', 'regatta/flow-aaaa', 'main'], h.repo)
    mkdirSync(join(h.worktrees, 'flow-aaaa'))
    writeFileSync(join(h.worktrees, 'flow-aaaa', 'MINE.txt'), 'mine\n')
    const run = await endedRun(h)
    expect(run.id).toBe('bbbb')
    await h.engine.merge(run.id)
    expect(readFileSync(join(h.worktrees, 'flow-aaaa', 'MINE.txt'), 'utf8')).toBe('mine\n')
    expect(regattaBranches(h.repo).sort()).toEqual(['regatta/flow-aaaa', run.branch!].sort())
  }, LONG)

  it('does not take an existing empty folder that has the name of the run', async () => {
    const h = writerHarness({ newId: () => 'dddd' })
    mkdirSync(join(h.worktrees, 'flow-dddd'))
    const saved = h.engine.save(makeFlow())
    await expect(h.engine.run(saved.id)).rejects.toThrow('Could not find a free name for this run. Try again.')
    expect(readdirSync(join(h.worktrees, 'flow-dddd'))).toEqual([])
    expect(worktreeCount(h.repo)).toBe(1)
    expect(regattaBranches(h.repo)).toEqual([])
  }, LONG)
})

describe('forgetting old runs', () => {
  it('never forgets a run that still owns a worktree or a branch, however many runs come after it', async () => {
    const h = writerHarness()
    const owner = await endedRun(h)
    const plain = h.engine.save(makeFlow({ isolate: false, steps: [] }))
    for (let i = 0; i < 51; i++) await h.engine.run(plain.id)
    // The newest 50 are kept, and the old run that still owns something with them.
    expect(h.engine.runs()).toHaveLength(51)
    expect(h.engine.runs().some((r) => r.id === owner.id)).toBe(true)
    expect(existsSync(join(h.dataDir, 'flow-runs', `${owner.id}.json`))).toBe(true)
    expect(existsSync(owner.worktree!)).toBe(true)

    // A restart does not forget it either, and it can still be merged or discarded.
    const fresh = new FlowEngine(h.deps)
    expect(fresh.runs().find((r) => r.id === owner.id)?.worktree).toBe(owner.worktree)
    await fresh.discard(owner.id)
    expect(existsSync(owner.worktree!)).toBe(false)
    expect(regattaBranches(h.repo)).toEqual([owner.branch])
    // Once it owns nothing, it is an old run like any other.
    expect(fresh.runs().some((r) => r.id === owner.id)).toBe(false)
    expect(existsSync(join(h.dataDir, 'flow-runs', `${owner.id}.json`))).toBe(false)
  }, LONG)

  it('never forgets a run that is still waiting for an approval', async () => {
    const h = writerHarness()
    const waitingFlow = h.engine.save(makeFlow({ isolate: false, steps: [approvalStep('s1')] }))
    const waiting = await h.engine.run(waitingFlow.id)
    await waitFor('the run to wait', () => runOf(h, waiting.id).status === 'waiting')
    const plain = h.engine.save(makeFlow({ isolate: false, steps: [] }))
    for (let i = 0; i < 55; i++) await h.engine.run(plain.id)
    expect(runOf(h, waiting.id).status).toBe('waiting')
    expect(existsSync(join(h.dataDir, 'flow-runs', `${waiting.id}.json`))).toBe(true)
    h.engine.approve(waiting.id)
    // It finishes as the run it was; being older than the newest 50 it is then forgotten like any old run.
    await waitFor('the run to finish', () => h.emitted.some((r) => r.id === waiting.id && r.status === 'done'))
    expect(h.engine.runs().some((r) => r.id === waiting.id)).toBe(false)
  }, LONG)

  it('never forgets a run that holds a folder', async () => {
    const h = makeHarness({ claude: SCENARIOS['stuckQuiet']! })
    const stuck = await endedRun(h, { steps: [agentStep('s1')] }, 'failed')
    const plain = h.engine.save(makeFlow({ isolate: false, steps: [] }))
    for (let i = 0; i < 51; i++) await h.engine.run(plain.id)
    expect(new FlowEngine(h.deps).runs().some((r) => r.id === stuck.id)).toBe(true)
  }, LONG)
})

describe('a project opened below the top of the repository', () => {
  /** A harness whose engine works on <repo>/pkg, which holds a tracked package.json. */
  function packageHarness(plan: Partial<Record<AgentKind, Scenario>>): { h: Harness; inner: FlowEngine } {
    const h = makeHarness(plan)
    commit(h.repo, { 'pkg/package.json': '{"name":"pkg"}\n' }, 'add pkg')
    return { h, inner: new FlowEngine({ ...h.deps, root: () => join(h.repo, 'pkg') }) }
  }

  it('works in the matching folder of the worktree, and the merged files land in the project folder', async () => {
    const { h, inner } = packageHarness({ claude: SCENARIOS['writer']! })
    const saved = inner.save(makeFlow({ steps: [agentStep('s1'), checkStep('s2', 'test -f package.json && test -f DONE.txt && pwd')] }))
    const started = await inner.run(saved.id)
    await waitFor('the run to finish', () => inner.runs().find((r) => r.id === started.id)?.status === 'done')
    const run = inner.runs().find((r) => r.id === started.id)!
    // The run's worktree is the top of the repository (what Storage lists); the agent and the check work below it.
    expect(run.worktree).toBe(join(h.worktrees, `flow-${run.id}`))
    expect(h.cwds).toEqual([join(run.worktree!, 'pkg')])
    expect(run.steps[1]?.status).toBe('done')
    expect(run.steps[1]?.output).toMatch(new RegExp(`flow-${run.id}-check-2/pkg$`))

    await inner.merge(run.id)
    expect(readFileSync(join(h.repo, 'pkg', 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(existsSync(join(h.repo, 'DONE.txt'))).toBe(false)
    expect(sh(['status', '--porcelain'], h.repo).trim()).toBe('')
  }, LONG)

  it('makes the project folder in the worktree when the commit does not have it yet', async () => {
    const h = writerHarness()
    mkdirSync(join(h.repo, 'fresh'))
    const inner = new FlowEngine({ ...h.deps, root: () => join(h.repo, 'fresh') })
    const saved = inner.save(makeFlow())
    const started = await inner.run(saved.id)
    await waitFor('the run to finish', () => inner.runs().find((r) => r.id === started.id)?.status === 'done')
    const run = inner.runs().find((r) => r.id === started.id)!
    expect(h.cwds).toEqual([join(run.worktree!, 'fresh')])
    await inner.merge(run.id)
    expect(readFileSync(join(h.repo, 'fresh', 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(existsSync(join(h.repo, 'DONE.txt'))).toBe(false)
  }, LONG)
})

describe('a check that changes what it was judging', () => {
  it('fails a check that rewrites tracked files even when it exits 0, and merges nothing of the rewrite', async () => {
    const h = writerHarness()
    const run = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', "echo '// fixed' >> src/app.js")] }, 'failed')
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'failed'])
    expect(run.steps[1]?.exitCode).toBe(0)
    expect(run.steps[1]?.output).toContain('The check changed tracked files, so its result does not match the committed change.')
    // The run's commit holds no rewrite, and neither does its folder.
    expect(sh(['show', `${run.branch}:src/app.js`], h.repo)).toBe('export const app = 1\n')
    expect(sh(['status', '--porcelain'], run.worktree!).trim()).toBe('')
    expect(readdirSync(h.worktrees)).toEqual([`flow-${run.id}`])
    await expect(h.engine.merge(run.id)).rejects.toThrow('Only a finished run can be merged.')
  }, LONG)

  it('fails a check that stages or commits in its folder, and the run branch does not move', async () => {
    const h = writerHarness()
    const committing = 'test -f DONE.txt && echo x > extra.txt && git add extra.txt && git -c user.name=C -c user.email=c@c commit -q -m "from a check"'
    const run = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', committing)] }, 'failed')
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'failed'])
    expect(run.steps[1]?.exitCode).toBe(0)
    expect(run.steps[1]?.output).toContain('The check committed in its folder')
    expect(sh(['rev-list', '--count', `main..${run.branch}`], h.repo).trim()).toBe('1')
    expect(existsSync(join(run.worktree!, 'extra.txt'))).toBe(false)

    const staging = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', 'echo x > extra.txt && git add extra.txt')] }, 'failed')
    expect(staging.steps[1]?.output).toContain('The check changed tracked files')
  }, LONG)

  it('does not blame a check for files that already show as changed in a fresh checkout', async () => {
    const h = writerHarness()
    // A filter that does not round trip: whatever git checks out of odd.txt shows as changed at once.
    sh(['config', 'filter.odd.clean', 'cat; echo cleaned'], h.repo)
    sh(['config', 'filter.odd.smudge', 'cat'], h.repo)
    commit(h.repo, { '.gitattributes': 'odd.txt filter=odd\n', 'odd.txt': 'a\n' }, 'add a file with a filter that does not round trip')
    const fine = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', 'git status --porcelain --untracked-files=no')] })
    expect(fine.steps[1]?.output).toBe(' M odd.txt')
    expect(fine.steps[1]?.status).toBe('done')
    // A real change on top of it is still found.
    const changed = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', 'echo x >> README.md')] }, 'failed')
    expect(changed.steps[1]?.output).toContain('The check changed tracked files')
  }, LONG)

  /** A repository where a file shows as changed in every fresh checkout: its filter does not round trip. */
  function withOddFile(h: Harness): void {
    sh(['config', 'filter.odd.clean', 'cat; echo cleaned'], h.repo)
    sh(['config', 'filter.odd.smudge', 'cat'], h.repo)
    commit(h.repo, { '.gitattributes': 'odd.txt filter=odd\n', 'odd.txt': 'a\n' }, 'add a file with a filter that does not round trip')
  }
  const STATUS = 'git status --porcelain --untracked-files=no'
  const SENTENCE = 'The check changed tracked files, so its result does not match the committed change.'

  it('finds a further edit of a file that already shows as changed in a fresh checkout, though its status label stays the same', async () => {
    const h = writerHarness()
    withOddFile(h)
    const run = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', `${STATUS} && echo fix >> odd.txt && ${STATUS}`)] }, 'failed')
    // The label was " M odd.txt" before and after, and the check exited 0: only the bytes tell.
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'failed'])
    expect(run.steps[1]?.exitCode).toBe(0)
    expect(run.steps[1]?.output).toContain(' M odd.txt\n M odd.txt')
    expect(run.steps[1]?.output).toContain(SENTENCE)
    // The committed result lacks the fix, and the run is not called done.
    expect(sh(['show', `${run.branch}:odd.txt`], h.repo)).not.toContain('fix')
    await expect(h.engine.merge(run.id)).rejects.toThrow('Only a finished run can be merged.')
  }, LONG)

  it('finds a rewrite that keeps the size of a file that already shows as changed', async () => {
    const h = writerHarness()
    withOddFile(h)
    const upper = 'tr a-z A-Z < odd.txt > odd.up && cat odd.up > odd.txt && rm odd.up'
    const run = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', `${upper} && ${STATUS}`)] }, 'failed')
    expect(run.steps[1]?.output).toContain(' M odd.txt')
    expect(run.steps[1]?.output).toContain(SENTENCE)
  }, LONG)

  it('finds an edit the check hid from git status', async () => {
    const h = writerHarness()
    const hide = `git update-index --assume-unchanged README.md && echo hidden >> README.md && ${STATUS}`
    const run = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', hide)] }, 'failed')
    // git said nothing about it; the output is the sentence alone.
    expect(run.steps[1]?.exitCode).toBe(0)
    expect(run.steps[1]?.output).toBe(SENTENCE)
  }, LONG)

  it('finds a tracked file the check made unreadable', async () => {
    const h = writerHarness()
    const run = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', 'chmod 000 README.md')] }, 'failed')
    expect(run.steps[1]?.output).toBe(SENTENCE)
    expect(readdirSync(h.worktrees)).toEqual([`flow-${run.id}`])
  }, LONG)

  it('finds an edit of a file in a repository that was clean, and leaves a check that only reads alone', async () => {
    const h = writerHarness()
    const edits = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', 'echo fixed >> README.md')] }, 'failed')
    expect(edits.steps[1]?.output).toBe(SENTENCE)
    const reads = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', `cat README.md && ${STATUS} && git diff --stat && git ls-files -s`)] })
    expect(reads.steps[1]?.status).toBe('done')
  }, LONG)

  it('says the branch moved when the user commits on it while a check runs, and keeps their commit', async () => {
    const h = writerHarness()
    const saved = h.engine.save(makeFlow({ steps: [agentStep('s1'), checkStep('s2', 'echo $$ > shell.pid; while [ ! -f go.txt ]; do sleep 0.05; done')] }))
    const started = await h.engine.run(saved.id)
    const folder = join(h.worktrees, `flow-${started.id}-check-2`)
    await waitFor('the check to run', () => existsSync(join(folder, 'shell.pid')) && readFileSync(join(folder, 'shell.pid'), 'utf8').trim() !== '')
    const run = runOf(h, started.id)
    const theirs = commit(run.worktree!, { 'USERS.txt': 'mine\n' }, "user's own commit")
    writeFileSync(join(folder, 'go.txt'), 'go\n')
    await waitFor('the run to fail', () => runOf(h, started.id).status === 'failed')
    expect(runOf(h, started.id).steps[1]?.output).toContain("The run's branch moved while the check ran")
    expect(sh(['rev-parse', run.branch!], h.repo).trim()).toBe(theirs)
  }, LONG)
})

describe('the folder of a run is not always the one it made', () => {
  it('keeps the run folder on the run when another worktree sits there, and looks at it again at the next discard', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const work = sh(['rev-parse', run.branch!], h.repo).trim()
    sh(['worktree', 'remove', '--force', run.worktree!], h.repo)
    sh(['worktree', 'add', '-b', 'users-branch', run.worktree!, 'main'], h.repo)
    writeFileSync(join(run.worktree!, 'MINE.txt'), 'mine\n')

    await h.engine.discard(run.id)
    // Left alone, and still the run's to look at: the reason says why.
    expect(readFileSync(join(run.worktree!, 'MINE.txt'), 'utf8')).toBe('mine\n')
    expect(runOf(h, run.id).worktree).toBe(run.worktree)
    expect(notesOf(h, run.id)).toContain('is not the worktree Regatta made any more')
    expect(h.engine.busyPaths()).toContain(run.worktree)
    // The run's branch is judged on its own: its commit is parked before it goes.
    expect(runOf(h, run.id).branch).toBeNull()
    expect(sh(['rev-parse', `refs/regatta/discarded/flow-${run.id}^1`], h.repo).trim()).toBe(work)

    // The user's worktree goes: the next discard finds nothing at the path, lets go, and the reason is gone.
    sh(['worktree', 'remove', '--force', run.worktree!], h.repo)
    await h.engine.discard(run.id)
    expect(runOf(h, run.id).worktree).toBeNull()
    expect(notesOf(h, run.id)).not.toContain('is not the worktree Regatta made any more')
    expect(h.engine.busyPaths()).toEqual([])
  }, LONG)

  it('still knows its folder when the identity it recorded is in the older form from before a reboot', async () => {
    const h = writerHarness()
    const run = await endedRun(h)
    const file = join(h.dataDir, 'flow-runs', `${run.id}.json`)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { owned: { identity: string } }
    const form = saved.owned.identity.match(/^(.*)\|i(\d+)\|(.+)$/)
    expect(form).not.toBeNull()
    // The same folder, recorded as earlier versions did: with a device number the volume does not have now.
    saved.owned.identity = `${form![1]}|12345:${form![2]}|${form![3]}`
    writeFileSync(file, JSON.stringify(saved))
    const fresh = new FlowEngine(h.deps)
    await fresh.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
  }, LONG)

  it('will not run an agent in a folder that is not the worktree the run made', async () => {
    const h = writerHarness()
    const saved = h.engine.save(makeFlow({ steps: [agentStep('s1'), approvalStep('s2'), agentStep('s3')] }))
    const started = await h.engine.run(saved.id)
    await waitFor('the run to wait', () => runOf(h, started.id).status === 'waiting')
    const run = runOf(h, started.id)
    // While it waits, the folder is replaced by one of the user's own at the same path.
    sh(['worktree', 'remove', '--force', run.worktree!], h.repo)
    sh(['worktree', 'add', '-b', 'users-branch', run.worktree!, 'main'], h.repo)
    writeFileSync(join(run.worktree!, 'MINE.txt'), 'mine\n')
    const theirs = sh(['rev-parse', 'users-branch'], h.repo).trim()

    h.engine.approve(started.id)
    await waitFor('the run to fail', () => runOf(h, started.id).status === 'failed')
    const after = runOf(h, started.id)
    expect(after.steps.map((s) => s.status)).toEqual(['done', 'done', 'failed'])
    expect(after.steps[2]?.output).toContain('is not the worktree Regatta made any more')
    // The second agent never started, and nothing was written to or committed in the user's folder.
    expect(h.cwds).toHaveLength(1)
    expect(existsSync(join(run.worktree!, 'DONE.txt'))).toBe(false)
    expect(readFileSync(join(run.worktree!, 'MINE.txt'), 'utf8')).toBe('mine\n')
    expect(sh(['rev-parse', 'users-branch'], h.repo).trim()).toBe(theirs)
    expect(sh(['status', '--porcelain'], run.worktree!).trim()).toBe('?? MINE.txt')
  }, LONG)
})

describe('a folder with a git operation half done in it', () => {
  it('will not commit into it: the step fails, nothing is committed, and a discard moves the folder to the trash', async () => {
    const half = (cwd: string): void => {
      writeDone(cwd)
      const gitDir = sh(['rev-parse', '--absolute-git-dir'], cwd).trim()
      writeFileSync(join(gitDir, 'MERGE_HEAD'), `${sh(['rev-parse', 'HEAD'], cwd).trim()}\n`)
    }
    const h = makeHarness({ claude: { delayMs: 40, write: half } })
    const base = head(h.repo)
    const run = await endedRun(h, {}, 'failed')
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'failed'])
    expect(run.steps[1]?.output).toBe("A merge is in progress in the run's folder, so its work was not committed.")
    expect(sh(['rev-parse', run.branch!], h.repo).trim()).toBe(base)
    expect(notesOf(h, run.id)).toContain('A merge is in progress')
    expect(sh(['status', '--porcelain'], run.worktree!)).toContain('?? DONE.txt')
    await h.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    const trashed = await listTrash(h.worktrees)
    expect(trashed).toHaveLength(1)
    expect(readFileSync(join(trashed[0]!.trashPath, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(regattaBranches(h.repo)).toEqual([run.branch])
  }, LONG)
})

describe('folders the engine owns or holds', () => {
  it('lists the run folder, a check folder while it exists, and nothing once everything is gone', async () => {
    const h = writerHarness()
    expect(h.engine.busyPaths()).toEqual([])
    const saved = h.engine.save(makeFlow({ steps: [agentStep('s1'), checkStep('s2', 'echo started > started.txt; sleep 300')] }))
    const started = await h.engine.run(saved.id)
    const folder = join(h.worktrees, `flow-${started.id}-check-2`)
    await waitFor('the check to run', () => existsSync(join(folder, 'started.txt')))
    const run = runOf(h, started.id)
    expect(h.engine.busyPaths().sort()).toEqual([run.worktree, folder].sort())

    h.engine.stop(started.id)
    await waitFor('the run to stop', () => runOf(h, started.id).status === 'stopped')
    // The check folder is taken away again; the run folder stays until it is merged or discarded.
    expect(h.engine.busyPaths()).toEqual([run.worktree])
    await h.engine.discard(started.id)
    expect(h.engine.busyPaths()).toEqual([])
  }, LONG)

  it('remembers a held run folder across a restart, and lets go of it once the folder is gone', async () => {
    const h = makeHarness({ claude: SCENARIOS['stuckQuiet']! })
    const run = await endedRun(h, { steps: [agentStep('s1')] }, 'failed')
    expect(h.engine.busyPaths()).toEqual([run.worktree])

    const fresh = new FlowEngine(h.deps)
    expect(fresh.busyPaths()).toEqual([run.worktree])
    expect((fresh.runs().find((r) => r.id === run.id)?.notes ?? []).join('\n')).toContain('could not be stopped')
    // Clean and idle, it would be removable; the held folder is not, in this session or the next.
    await fresh.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(true)
    expect(fresh.busyPaths()).toEqual([run.worktree])

    // The user removes it themselves: nothing is left to hold, and the next discard finishes the job.
    sh(['worktree', 'remove', '--force', run.worktree!], h.repo)
    expect(fresh.busyPaths().filter((path) => path !== run.worktree)).toEqual([])
    await fresh.discard(run.id)
    expect(fresh.runs().find((r) => r.id === run.id)?.worktree).toBeNull()
    expect(fresh.busyPaths()).toEqual([])
    expect((fresh.runs().find((r) => r.id === run.id)?.notes ?? []).join('\n')).not.toContain('could not be stopped')
  }, LONG)

  it('remembers a held check folder across a restart', async () => {
    const h = writerHarness({ supervise: { killGraceMs: 100, giveUpMs: 200 } })
    const stuck = await stuckCheck(h)
    try {
      await h.engine.discard(stuck.id)
      expect(h.engine.busyPaths()).toEqual([stuck.folder])

      const fresh = new FlowEngine(h.deps)
      expect(fresh.busyPaths()).toEqual([stuck.folder])
      // The run owns nothing else, but it is not forgotten while it holds this.
      const held = fresh.runs().find((r) => r.id === stuck.id)
      expect(held?.worktree).toBeNull()
      expect((held?.notes ?? []).join('\n')).toContain('could not be stopped, so the folder was kept.')
      const more = fresh.save(makeFlow({ isolate: false, steps: [] }))
      for (let i = 0; i < 51; i++) await fresh.run(more.id)
      expect(fresh.runs().some((r) => r.id === stuck.id)).toBe(true)

      // Once the program is gone and the folder is removed, nothing is held and the run is an old run like any other.
      stuck.kill()
      sh(['worktree', 'remove', '--force', stuck.folder], h.repo)
      expect(fresh.busyPaths()).toEqual([])
    } finally {
      stuck.kill()
    }
  }, LONG)
})

describe('what an agent said reaches the next step as it was said', () => {
  it('passes the output of a step into the next prompt without reading $ patterns in it', async () => {
    const h = makeHarness({ claude: { delayMs: 20, activity: "it's $' and $& and $` and $$ and $1 done" } })
    const saved = h.engine.save(makeFlow({ isolate: false, brief: 'cost $& total', steps: [agentStep('s1', 'Plan {{brief}}'), agentStep('s2', 'Previous said: {{previous}}')] }))
    const started = await h.engine.run(saved.id)
    await waitFor('the run to finish', () => runOf(h, started.id).status === 'done')
    expect(h.prompts).toEqual(['Plan cost $& total', "Previous said: it's $' and $& and $` and $$ and $1 done"])
  }, LONG)
})

describe('dependencies are copied into a worktree, never linked', () => {
  /** A project with a package.json, a lockfile that needs no download, and a node_modules worth protecting. Returns its fingerprint. */
  function withModules(h: Harness): string {
    commit(
      h.repo,
      {
        'package.json': '{"name":"probe","version":"1.0.0","private":true}\n',
        'package-lock.json': '{"name":"probe","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"probe","version":"1.0.0"}}}\n'
      },
      'add package files'
    )
    const modules = join(h.repo, 'node_modules')
    mkdirSync(join(modules, 'dep', 'lib'), { recursive: true })
    mkdirSync(join(modules, '.bin'))
    writeFileSync(join(modules, 'dep', 'index.js'), 'module.exports = "dep"\n')
    writeFileSync(join(modules, 'dep', 'lib', 'a.js'), 'exports.a = 1\n')
    writeFileSync(join(modules, '.bin', 'tool'), '#!/bin/sh\necho tool\n', { mode: 0o755 })
    symlinkSync('index.js', join(modules, 'dep', 'link.js'))
    return digest(modules)
  }

  /** What a careless script does to node_modules, each with a test that it really happened in the folder it ran in. */
  function harms(): { name: string; command: string; proof: string }[] {
    // npm runs with a home of its own, so it reads and writes nothing of the real one.
    const home = temp('regatta-flow-home-')
    return [
      { name: 'rm -rf node_modules', command: 'rm -rf node_modules', proof: 'test ! -e node_modules' },
      {
        name: 'npm ci',
        command: `HOME='${home}' npm_config_cache='${home}/cache' npm ci --offline --no-audit --no-fund --ignore-scripts`,
        proof: 'test ! -e node_modules/dep'
      },
      {
        name: 'a write through node_modules',
        command: 'echo changed > node_modules/dep/index.js && rm -rf node_modules/dep/lib && rm node_modules/.bin/tool',
        proof: 'test ! -e node_modules/dep/lib'
      }
    ]
  }

  for (const harm of harms()) {
    it(`a check that runs ${harm.name} leaves the project's own node_modules as it was`, async () => {
      const h = writerHarness()
      const before = withModules(h)
      const run = await endedRun(h, { steps: [agentStep('s1'), checkStep('s2', `${harm.command} && ${harm.proof}`)] })
      // The check did what it did, in its own copy.
      expect(run.steps[1]?.status).toBe('done')
      expect(lstatSync(join(h.repo, 'node_modules')).isSymbolicLink()).toBe(false)
      expect(digest(join(h.repo, 'node_modules'))).toBe(before)
    }, LONG)

    it(`an agent that runs ${harm.name} in an isolated run leaves the project's own node_modules as it was`, async () => {
      const proofs: (number | null)[] = []
      const careless = (cwd: string): void => {
        execFileSync('/bin/sh', ['-c', harm.command], { cwd, stdio: 'ignore' })
        proofs.push(spawnSync('/bin/sh', ['-c', harm.proof], { cwd }).status)
      }
      const h = makeHarness({ claude: { delayMs: 40, write: careless } })
      const before = withModules(h)
      const run = await endedRun(h, { steps: [agentStep('s1')] })
      // It did what it did, in the run's own copy.
      expect(proofs).toEqual([0])
      expect(digest(join(h.repo, 'node_modules'))).toBe(before)

      // npm ci empties the folder it keeps (it does not make a new one), so the copy is still the copy
      // and the worktree can still be moved to the trash; so can one whose copy was deleted outright.
      await h.engine.discard(run.id)
      expect(existsSync(run.worktree!)).toBe(false)
      expect(digest(join(h.repo, 'node_modules'))).toBe(before)
    }, LONG)
  }

  it('moves a run worktree that holds only its own copy of the dependencies to the trash, on merge and on discard', async () => {
    for (const how of ['merge', 'discard'] as const) {
      const h = writerHarness()
      const before = withModules(h)
      const run = await endedRun(h)
      expect(lstatSync(join(run.worktree!, 'node_modules')).isDirectory()).toBe(true)
      // Whatever happens inside the copy is the worktree's own business.
      writeFileSync(join(run.worktree!, 'node_modules', 'dep', 'index.js'), 'module.exports = "changed in the copy"\n')
      if (how === 'merge') {
        const result = await h.engine.merge(run.id)
        expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
      } else {
        await h.engine.discard(run.id)
      }
      expect(existsSync(run.worktree!)).toBe(false)
      expect(readdirSync(h.worktrees)).toEqual(['.regatta-trash'])
      expect((await emptyTrash(h.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
      expect(regattaBranches(h.repo)).toEqual([])
      expect(readdirSync(join(h.worktrees, '.regatta-trash'))).toEqual([])
      expect(digest(join(h.repo, 'node_modules'))).toBe(before)
    }
  }, LONG)

  it('does not commit the copy when the repository does not ignore node_modules, and still moves the worktree to the trash', async () => {
    const h = writerHarness()
    // The repository stops ignoring it: git would add the whole copy with everything else.
    commit(h.repo, { '.gitignore': 'local/\n' }, 'stop ignoring node_modules')
    const before = withModules(h)
    const run = await endedRun(h)
    const tip = sh(['rev-parse', run.branch!], h.repo).trim()
    expect(sh(['ls-tree', '-r', '--name-only', tip], h.repo).split('\n').filter((name) => name.startsWith('node_modules'))).toEqual([])
    expect(readFileSync(join(run.worktree!, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = "dep"\n')
    const result = await h.engine.merge(run.id)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(existsSync(run.worktree!)).toBe(false)
    expect(digest(join(h.repo, 'node_modules'))).toBe(before)
  }, LONG)

  it('preserves a run worktree whose node_modules was replaced inside the trash', async () => {
    const h = writerHarness()
    withModules(h)
    const run = await endedRun(h)
    // Someone replaces the copy with a folder of their own (npm ci does just that).
    rmSync(join(run.worktree!, 'node_modules'), { recursive: true })
    mkdirSync(join(run.worktree!, 'node_modules', 'theirs'), { recursive: true })
    writeFileSync(join(run.worktree!, 'node_modules', 'theirs', 'index.js'), 'mine\n')
    await h.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    const trashed = await listTrash(h.worktrees)
    expect(trashed).toHaveLength(1)
    expect(notesOf(h, run.id)).toContain("Moved its worktree to Regatta's trash")
    expect(readFileSync(join(trashed[0]!.trashPath, 'node_modules', 'theirs', 'index.js'), 'utf8')).toBe('mine\n')
  }, LONG)

  it('says so in the notes, and goes on without, when the dependencies cannot be copied', async () => {
    const h = writerHarness()
    // A node_modules that is itself a link: a copy of it would still lead out of the worktree.
    const elsewhere = temp('regatta-flow-modules-')
    writeFileSync(join(elsewhere, 'marker.txt'), 'x\n')
    symlinkSync(elsewhere, join(h.repo, 'node_modules'), 'dir')
    const run = await endedRun(h)
    expect(existsSync(join(run.worktree!, 'node_modules'))).toBe(false)
    expect(notesOf(h, run.id)).toContain('Dependencies were not copied into the worktree; run your install command there.')
    expect(readFileSync(join(elsewhere, 'marker.txt'), 'utf8')).toBe('x\n')
    await h.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
  }, LONG)

  it('puts the copy where Node finds it from a project folder below the top: at the top of the worktree', async () => {
    const h = makeHarness({ claude: SCENARIOS['writer']! })
    commit(h.repo, { 'pkg/package.json': '{"name":"pkg","version":"1.0.0","private":true,"scripts":{"test":"mytool"}}\n' }, 'add pkg')
    mkdirSync(join(h.repo, 'pkg', 'node_modules', 'fake-dep'), { recursive: true })
    mkdirSync(join(h.repo, 'pkg', 'node_modules', '.bin'))
    writeFileSync(join(h.repo, 'pkg', 'node_modules', 'fake-dep', 'index.js'), 'module.exports = "from the copy"\n')
    writeFileSync(join(h.repo, 'pkg', 'node_modules', '.bin', 'mytool'), '#!/bin/sh\necho "tool ran from the copy"\n', { mode: 0o755 })
    const before = digest(join(h.repo, 'pkg', 'node_modules'))
    const inner = new FlowEngine({ ...h.deps, root: () => join(h.repo, 'pkg') })
    const resolves = `'${process.execPath}' -e "console.log(require('fake-dep'))"`
    const home = temp('regatta-flow-home-')
    const npmTest = `HOME='${home}' npm_config_cache='${home}/cache' npm test --offline --no-audit --no-fund`
    const saved = inner.save(makeFlow({ steps: [agentStep('s1'), checkStep('s2', resolves), checkStep('s3', npmTest)] }))
    const started = await inner.run(saved.id)
    await waitFor('the run to finish', () => inner.runs().find((r) => r.id === started.id)?.status === 'done')
    const run = inner.runs().find((r) => r.id === started.id)!
    // The check ran in pkg and found the dependency by walking up to the copy at the top, and npm test its tool.
    expect(run.steps[1]?.output).toBe('from the copy')
    expect(run.steps[2]?.status).toBe('done')
    expect(run.steps[2]?.output).toContain('tool ran from the copy')
    expect(existsSync(join(run.worktree!, 'node_modules', 'fake-dep'))).toBe(true)
    expect(existsSync(join(run.worktree!, 'pkg', 'node_modules'))).toBe(false)
    // Where the shared exemption looks, so the worktree can still be removed.
    await inner.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(digest(join(h.repo, 'pkg', 'node_modules'))).toBe(before)
  }, LONG)
})

/** What deleting a flow says while one of its runs is starting, running or still holds something. */
const REFUSAL = 'This flow has a run that is still running or still holds a worktree; discard or merge it first.'

/**
 * A post-checkout hook in the repository: git runs it in each new worktree once it has checked it out
 * (the user's own hook, as git-lfs installs one). A failing one makes `git worktree add` report an
 * error with the worktree and the branch in place.
 */
function hook(repo: string, body: string): void {
  const file = join(repo, '.git', 'hooks', 'post-checkout')
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

describe('deleting a flow', () => {
  it('refuses while a run of the flow is running or waiting, and deletes it once the run is over', async () => {
    const h = writerHarness()
    const flow = h.engine.save(makeFlow({ isolate: false, steps: [approvalStep('s1')] }))
    const started = await h.engine.run(flow.id)
    await waitFor('the run to wait', () => runOf(h, started.id).status === 'waiting')
    expect(() => h.engine.remove(flow.id)).toThrow(REFUSAL)
    expect(h.engine.list().map((f) => f.id)).toContain(flow.id)
    const kept = JSON.parse(readFileSync(join(h.dataDir, 'flows.json'), 'utf8')) as Flow[]
    expect(kept.map((f) => f.id)).toContain(flow.id)

    h.engine.approve(started.id)
    await waitFor('the run to finish', () => runOf(h, started.id).status === 'done')
    h.engine.remove(flow.id)
    expect(h.engine.list().map((f) => f.id)).not.toContain(flow.id)
    expect((JSON.parse(readFileSync(join(h.dataDir, 'flows.json'), 'utf8')) as Flow[]).map((f) => f.id)).not.toContain(flow.id)
  }, LONG)

  it('refuses while a run still has its worktree and branch, and deletes the flow after a merge or a discard', async () => {
    for (const how of ['merge', 'discard'] as const) {
      const h = writerHarness()
      const flow = h.engine.save(makeFlow())
      const started = await h.engine.run(flow.id)
      await waitFor('the run to finish', () => runOf(h, started.id).status === 'done')
      expect(() => h.engine.remove(flow.id)).toThrow(REFUSAL)
      if (how === 'merge') await h.engine.merge(started.id)
      else await h.engine.discard(started.id)
      h.engine.remove(flow.id)
      expect(h.engine.list().map((f) => f.id)).not.toContain(flow.id)
    }
  }, LONG)

  it('refuses while a run holds a folder, and while a run only has its branch left', async () => {
    const stuck = makeHarness({ claude: SCENARIOS['stuckQuiet']! })
    const flow = stuck.engine.save(makeFlow({ steps: [agentStep('s1')] }))
    const started = await stuck.engine.run(flow.id)
    await waitFor('the run to fail', () => runOf(stuck, started.id).status === 'failed')
    expect(() => stuck.engine.remove(flow.id)).toThrow(REFUSAL)
    // Still refused after a restart: what the run holds was saved with it.
    expect(() => new FlowEngine(stuck.deps).remove(flow.id)).toThrow(REFUSAL)
    // Only when the folder is gone is there nothing left to hold.
    sh(['worktree', 'remove', '--force', runOf(stuck, started.id).worktree!], stuck.repo)
    await stuck.engine.discard(started.id)
    stuck.engine.remove(flow.id)

    const moved = writerHarness()
    const other = moved.engine.save(makeFlow())
    const run = await moved.engine.run(other.id)
    await waitFor('the run to finish', () => runOf(moved, run.id).status === 'done')
    commit(runOf(moved, run.id).worktree!, { 'USERS.txt': 'mine\n' }, "user's own commit")
    sh(['worktree', 'remove', '--force', runOf(moved, run.id).worktree!], moved.repo)
    await moved.engine.discard(run.id)
    // The folder was already gone; the branch had a commit of the user's and stays, so the run still owns something.
    expect(runOf(moved, run.id).worktree).toBeNull()
    expect(runOf(moved, run.id).branch).not.toBeNull()
    expect(() => moved.engine.remove(other.id)).toThrow(REFUSAL)
  }, LONG)

  it('refuses while only a held check folder is left, though the run owns nothing else, and deletes the flow once it is gone', async () => {
    const h = writerHarness({ supervise: { killGraceMs: 100, giveUpMs: 200 } })
    const stuck = await stuckCheck(h)
    try {
      await h.engine.discard(stuck.id)
      // The run's own folder and branch went; the temporary folder of the check is all it still holds.
      const run = runOf(h, stuck.id)
      expect(run.worktree).toBeNull()
      expect(run.branch).toBeNull()
      expect(h.engine.busyPaths()).toEqual([stuck.folder])
      expect(() => h.engine.remove(run.flowId)).toThrow(REFUSAL)
      expect(h.engine.list().map((f) => f.id)).toContain(run.flowId)

      stuck.kill()
      sh(['worktree', 'remove', '--force', stuck.folder], h.repo)
      h.engine.remove(run.flowId)
      expect(h.engine.list().map((f) => f.id)).not.toContain(run.flowId)
    } finally {
      stuck.kill()
    }
  }, LONG)

  it('refuses while a run of the flow is still starting, though git has not finished making its worktree and no run is listed yet', async () => {
    const h = writerHarness()
    const flow = h.engine.save(makeFlow())
    // The user's hook takes a while: git is busy making the worktree, and the run is not registered until it is done.
    const begun = join(temp('regatta-flow-hook-'), 'begun')
    hook(h.repo, `touch "${begun}"\nsleep 1.5`)
    const pending = h.engine.run(flow.id)
    await waitFor('the hook to start', () => existsSync(begun))
    expect(h.engine.runs()).toHaveLength(0)
    expect(() => h.engine.remove(flow.id)).toThrow(REFUSAL)
    expect(h.engine.list().map((f) => f.id)).toContain(flow.id)
    expect((JSON.parse(readFileSync(join(h.dataDir, 'flows.json'), 'utf8')) as Flow[]).map((f) => f.id)).toContain(flow.id)

    const started = await pending
    expect(started.flowId).toBe(flow.id)
    expect(h.engine.list().map((f) => f.id)).toContain(flow.id)
    // Registered now: the live run is what keeps the flow, and then the worktree and branch it owns.
    expect(() => h.engine.remove(flow.id)).toThrow(REFUSAL)
    await waitFor('the run to finish', () => runOf(h, started.id).status === 'done')
    expect(() => h.engine.remove(flow.id)).toThrow(REFUSAL)
    await h.engine.discard(started.id)
    h.engine.remove(flow.id)
    expect(h.engine.list().map((f) => f.id)).not.toContain(flow.id)
  }, LONG)

  it('counts every run that is starting: one that fails to start does not clear the others', async () => {
    let installed = true
    const h = writerHarness({ agents: () => (installed ? detectedAgents(['claude', 'codex']) : []) })
    const flow = h.engine.save(makeFlow())
    const begun = join(temp('regatta-flow-hook-'), 'begun')
    hook(h.repo, `touch "${begun}"\nsleep 1.5`)
    const pending = h.engine.run(flow.id)
    await waitFor('the hook to start', () => existsSync(begun))
    // A second start of the same flow fails at once; the first is still making its worktree.
    installed = false
    await expect(h.engine.run(flow.id)).rejects.toThrow('Not installed')
    installed = true
    expect(() => h.engine.remove(flow.id)).toThrow(REFUSAL)
    const started = await pending
    await waitFor('the run to finish', () => runOf(h, started.id).status === 'done')
    await h.engine.discard(started.id)
    h.engine.remove(flow.id)
    expect(h.engine.list()).toEqual([])
  }, LONG)

  it('counts every run that is starting, and lets go of the count when a run fails to start', async () => {
    const notARepo = temp('regatta-flow-not-a-repo-')
    const h = writerHarness({ root: () => notARepo })
    const flow = h.engine.save(makeFlow())
    // Fails after the first await, in the middle of starting.
    await expect(h.engine.run(flow.id)).rejects.toThrow('Isolated runs need a git repository with at least one commit.')
    h.engine.remove(flow.id)
    expect(h.engine.list().map((f) => f.id)).not.toContain(flow.id)

    // Fails before any await.
    const missing = h.engine.save(makeFlow({ steps: [{ ...agentStep('s1'), agent: 'gemini' }] }))
    await expect(h.engine.run(missing.id)).rejects.toThrow('Not installed')
    h.engine.remove(missing.id)
    expect(h.engine.list()).toEqual([])
  }, LONG)

  it('does not mind runs of other flows, or a flow that is not there', async () => {
    const h = writerHarness()
    const busy = h.engine.save(makeFlow({ name: 'Busy', isolate: false, steps: [approvalStep('s1')] }))
    const quiet = h.engine.save(makeFlow({ name: 'Quiet', isolate: false, steps: [] }))
    const started = await h.engine.run(busy.id)
    await waitFor('the run to wait', () => runOf(h, started.id).status === 'waiting')
    h.engine.remove(quiet.id)
    expect(h.engine.list().map((f) => f.id)).toEqual([busy.id])
    expect(() => h.engine.remove('nosuchflow')).not.toThrow()
    h.engine.stop(started.id)
  }, LONG)
})

describe('what kind of run it is', () => {
  it('records from the flow, when the run starts, whether it is isolated, and keeps saying so after its worktree is gone', async () => {
    const h = writerHarness()
    const isolatedFlow = h.engine.save(makeFlow({ isolate: true }))
    const plainFlow = h.engine.save(makeFlow({ isolate: false, steps: [] }))
    const isolated = await h.engine.run(isolatedFlow.id)
    const plain = await h.engine.run(plainFlow.id)
    // In the first state handed back, in what is saved, and in what the window is sent.
    expect(isolated.isolated).toBe(true)
    expect(plain.isolated).toBe(false)
    expect(h.emitted.find((r) => r.id === isolated.id)?.isolated).toBe(true)
    expect(h.emitted.find((r) => r.id === plain.id)?.isolated).toBe(false)
    await waitFor('the runs to finish', () => runOf(h, isolated.id).status === 'done' && runOf(h, plain.id).status === 'done')
    expect((JSON.parse(readFileSync(join(h.dataDir, 'flow-runs', `${isolated.id}.json`), 'utf8')) as FlowRun).isolated).toBe(true)

    await h.engine.merge(isolated.id)
    expect(runOf(h, isolated.id).worktree).toBeNull()
    expect(runOf(h, isolated.id).isolated).toBe(true)
    expect(new FlowEngine(h.deps).runs().find((r) => r.id === isolated.id)?.isolated).toBe(true)
  }, LONG)

  it('reads a run saved before the field existed as isolated only when it owns a worktree or a branch', async () => {
    const h = writerHarness()
    const owner = await endedRun(h)
    const plainFlow = h.engine.save(makeFlow({ isolate: false, steps: [] }))
    const plain = await h.engine.run(plainFlow.id)
    await waitFor('the plain run to finish', () => runOf(h, plain.id).status === 'done')
    const released = await endedRun(h)
    await h.engine.discard(released.id)
    // A run of a version that kept no record of what it owns, whose folder has gone and whose branch has not.
    const branchOnly = await endedRun(h)
    for (const id of [owner.id, plain.id, released.id, branchOnly.id]) {
      const file = join(h.dataDir, 'flow-runs', `${id}.json`)
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      delete saved['isolated']
      if (id === branchOnly.id) {
        delete saved['owned']
        saved['worktree'] = null
      }
      writeFileSync(file, JSON.stringify(saved))
    }
    const fresh = new FlowEngine(h.deps)
    const read = (id: string): boolean | undefined => fresh.runs().find((r) => r.id === id)?.isolated
    expect(read(owner.id)).toBe(true)
    expect(read(branchOnly.id)).toBe(true)
    expect(read(plain.id)).toBe(false)
    // Nothing is left of it to say, so an old file of this kind reads as not isolated.
    expect(read(released.id)).toBe(false)
  }, LONG)
})

describe('a git that stops after it has made something', () => {
  /** What the file of a run says it owns (never shown to the window). */
  function ownedOf(h: Harness, runId: string): { identity: string | null; branch: string; worktree: string } | undefined {
    const file = JSON.parse(readFileSync(join(h.dataDir, 'flow-runs', `${runId}.json`), 'utf8')) as { owned?: { identity: string | null; branch: string; worktree: string } }
    return file.owned
  }

  it('keeps the folder and the branch of a run when a hook fails after the checkout, and a discard moves the folder to the trash', async () => {
    const h = writerHarness()
    hook(h.repo, 'echo "written by the hook" > HOOK.txt\necho "the hook said no" >&2\nexit 1')
    const base = head(h.repo)
    const flow = h.engine.save(makeFlow())
    const started = await h.engine.run(flow.id)
    await waitFor('the run to fail', () => runOf(h, started.id).status === 'failed')
    const run = runOf(h, started.id)
    const folder = join(h.worktrees, `flow-${run.id}`)

    // Git left the folder, filled, and the branch. They are the run's: recorded, listed, and no agent ever started.
    expect(h.cwds).toEqual([])
    expect(run.isolated).toBe(true)
    expect(run.worktree).toBe(folder)
    expect(run.branch).toBe(`regatta/flow-${run.id}`)
    expect(readFileSync(join(folder, 'HOOK.txt'), 'utf8')).toBe('written by the hook\n')
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    expect(worktreeCount(h.repo)).toBe(2)
    expect(h.engine.busyPaths()).toEqual([folder])
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'skipped'])
    expect(run.steps[0]!.output).toContain(`Git stopped while it was making ${folder} (the hook said no), so the run was not started.`)
    expect(run.steps[0]!.output).toContain(`so the run was not started. The folder and its branch ${run.branch} were kept as git left them`)
    expect(notesOf(h, run.id)).toContain('so the run was not started.')
    expect(ownedOf(h, run.id)?.identity).toMatch(/^.+\|i\d+\|[\d.e+-]+$/)
    expect(ownedOf(h, run.id)?.branch).toBe(run.branch)
    // The flow is spoken for as long as the run owns anything.
    expect(() => h.engine.remove(flow.id)).toThrow(REFUSAL)
    // Nothing of the user's changed.
    expect(head(h.repo)).toBe(base)
    expect(sh(['status', '--porcelain'], h.repo).trim()).toBe('')

    // A restart knows it too.
    const next = new FlowEngine(h.deps)
    const again = next.runs().find((r) => r.id === run.id)
    expect(again?.worktree).toBe(folder)
    expect(again?.branch).toBe(run.branch)
    expect(next.busyPaths()).toEqual([folder])

    // Discard moves the folder (with the file the hook wrote) into Regatta's trash and keeps a copy of the commits.
    await next.discard(run.id)
    expect(existsSync(folder)).toBe(false)
    const trashed = await listTrash(h.worktrees)
    expect(trashed).toHaveLength(1)
    expect(readFileSync(join(trashed[0]!.trashPath, 'HOOK.txt'), 'utf8')).toBe('written by the hook\n')
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    expect(next.busyPaths()).toEqual([])
    const ref = (next.runs().find((r) => r.id === run.id)?.notes ?? []).join('\n').match(/Kept a copy of the run's work at (\S+) /)?.[1]
    expect(ref).toBe(`refs/regatta/discarded/flow-${run.id}`)
    expect(sh(['rev-parse', `${ref}^1`], h.repo).trim()).toBe(base)
    // Nothing owns anything now, so the flow can go.
    next.remove(flow.id)
    expect(next.list()).toEqual([])
    expect((await emptyTrash(h.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(regattaBranches(h.repo)).toEqual([])
    expect(worktreeCount(h.repo)).toBe(1)
  }, LONG)

  it('keeps a folder it cannot tell is the one git made, and never removes it', async () => {
    const h = writerHarness()
    // The hook takes the link to the repository out of the folder, so nothing proves what the folder is.
    hook(h.repo, 'rm -f .git\necho "written by the hook" > HOOK.txt\nexit 1')
    const flow = h.engine.save(makeFlow())
    const started = await h.engine.run(flow.id)
    await waitFor('the run to fail', () => runOf(h, started.id).status === 'failed')
    const run = runOf(h, started.id)
    const folder = join(h.worktrees, `flow-${run.id}`)

    expect(h.cwds).toEqual([])
    expect(run.worktree).toBe(folder)
    expect(run.branch).toBe(`regatta/flow-${run.id}`)
    expect(h.engine.busyPaths()).toEqual([folder])
    expect(ownedOf(h, run.id)?.identity).toBeNull()
    expect(notesOf(h, run.id)).toContain('Regatta cannot tell whether the folder is the one git made, so it will not be removed.')

    // Discarding keeps it, and the branch, however often it is asked and whoever asks.
    await new FlowEngine(h.deps).discard(run.id)
    await h.engine.discard(run.id)
    expect(readFileSync(join(folder, 'HOOK.txt'), 'utf8')).toBe('written by the hook\n')
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    expect(parkedRefs(h.repo)).toEqual([])
    expect(notesOf(h, run.id)).toContain('cannot tell whether it is the worktree it made')
    expect(runOf(h, run.id).worktree).toBe(folder)
    expect(runOf(h, run.id).branch).toBe(run.branch)
  }, LONG)

  it('records the branch git made when the checkout failed and took the folder away again, so a discard keeps its commits and deletes it', async () => {
    const h = writerHarness()
    // A filter that has to run and cannot: git's checkout of the new worktree stops, takes the folder away, and leaves the branch.
    commit(h.repo, { '.gitattributes': '*.md filter=broken\n' })
    sh(['config', 'filter.broken.smudge', 'false'], h.repo)
    sh(['config', 'filter.broken.required', 'true'], h.repo)
    const base = head(h.repo)
    const flow = h.engine.save(makeFlow())
    const started = await h.engine.run(flow.id)
    await waitFor('the run to fail', () => runOf(h, started.id).status === 'failed')
    const run = runOf(h, started.id)
    const folder = join(h.worktrees, `flow-${run.id}`)

    expect(h.cwds).toEqual([])
    expect(existsSync(folder)).toBe(false)
    expect(run.worktree).toBeNull()
    expect(run.branch).toBe(`regatta/flow-${run.id}`)
    expect(regattaBranches(h.repo)).toEqual([run.branch])
    expect(sh(['rev-parse', run.branch!], h.repo).trim()).toBe(base)
    expect(h.engine.busyPaths()).toEqual([])
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'skipped'])
    expect(notesOf(h, run.id)).toContain(`The folder is gone, and the branch ${run.branch} that git made was kept`)
    // It still owns the branch, so the flow stays.
    expect(() => h.engine.remove(flow.id)).toThrow(REFUSAL)

    // After a restart the branch is still the run's, and a discard keeps its commits and deletes it.
    const next = new FlowEngine(h.deps)
    expect(next.runs().find((r) => r.id === run.id)?.branch).toBe(run.branch)
    await next.discard(run.id)
    expect(regattaBranches(h.repo)).toEqual([])
    expect(next.busyPaths()).toEqual([])
    const ref = (next.runs().find((r) => r.id === run.id)?.notes ?? []).join('\n').match(/Kept a copy of the run's work at (\S+) /)?.[1]
    expect(ref).toBe(`refs/regatta/discarded/flow-${run.id}`)
    expect(sh(['rev-parse', `${ref}^1`], h.repo).trim()).toBe(base)
    next.remove(flow.id)
    expect(next.list()).toEqual([])
  }, LONG)

  it('takes away the temporary folder git left when a hook fails while making a check folder, and the check fails without running', async () => {
    const h = writerHarness()
    const flow = h.engine.save(makeFlow({ steps: [agentStep('s1'), approvalStep('s2'), checkStep('s3', 'test -f DONE.txt')] }))
    const started = await h.engine.run(flow.id)
    await waitFor('the run to wait', () => runOf(h, started.id).status === 'waiting')
    // The run's own folder is made; only the folder of the check meets the failing hook.
    hook(h.repo, 'case "$PWD" in *-check-*) echo "written by the hook" > HOOK.txt; exit 1;; esac')
    h.engine.approve(started.id)
    await waitFor('the run to fail', () => runOf(h, started.id).status === 'failed')
    const run = runOf(h, started.id)

    expect(run.steps.map((s) => s.status)).toEqual(['done', 'done', 'failed'])
    expect(run.steps[2]!.output).toContain('Git stopped while it was making the temporary folder for the check (')
    expect(run.steps[2]!.output).toContain('so the check did not run.')
    // The temporary folder is a copy of ours: gone from the disk and from git, not left registered.
    expect(existsSync(join(h.worktrees, `flow-${run.id}-check-3`))).toBe(false)
    expect(readdirSync(h.worktrees)).toEqual([`flow-${run.id}`])
    expect(worktreeCount(h.repo)).toBe(2)
    expect(h.engine.busyPaths()).toEqual([run.worktree])
    // The run's own folder is as for any failed run: committed, and a discard moves it to the trash.
    await h.engine.discard(run.id)
    expect(readdirSync(h.worktrees)).toEqual(['.regatta-trash'])
    expect((await emptyTrash(h.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(regattaBranches(h.repo)).toEqual([])
    expect(worktreeCount(h.repo)).toBe(1)
  }, LONG)

  it('holds a temporary folder it cannot tell is the one git made, and says so', async () => {
    const h = writerHarness()
    const flow = h.engine.save(makeFlow({ steps: [agentStep('s1'), approvalStep('s2'), checkStep('s3', 'test -f DONE.txt')] }))
    const started = await h.engine.run(flow.id)
    await waitFor('the run to wait', () => runOf(h, started.id).status === 'waiting')
    hook(h.repo, 'case "$PWD" in *-check-*) rm -f .git; echo "written by the hook" > HOOK.txt; exit 1;; esac')
    h.engine.approve(started.id)
    await waitFor('the run to fail', () => runOf(h, started.id).status === 'failed')
    const run = runOf(h, started.id)
    const folder = join(h.worktrees, `flow-${run.id}-check-3`)

    expect(run.steps[2]!.status).toBe('failed')
    expect(readFileSync(join(folder, 'HOOK.txt'), 'utf8')).toBe('written by the hook\n')
    expect(h.engine.busyPaths().sort()).toEqual([run.worktree, folder].sort())
    expect(notesOf(h, run.id)).toContain('cannot tell whether it is the worktree it made')
    // Held across a restart as well, and the flow stays while anything is held.
    expect(new FlowEngine(h.deps).busyPaths().sort()).toEqual([run.worktree, folder].sort())
    expect(() => h.engine.remove(flow.id)).toThrow(REFUSAL)
  }, LONG)
})

describe('the app quits', () => {
  it('starts nothing new: no step, no check folder, no check process, no commit, and what is saved stays as it was', async () => {
    const h = makeHarness({ claude: { delayMs: 400, write: writeDone } })
    const base = head(h.repo)
    const saved = h.engine.save(makeFlow({ steps: [agentStep('s1'), checkStep('s2', 'echo started > started.txt'), agentStep('s3')] }))
    const started = await h.engine.run(saved.id)
    await waitFor('the agent step to run', () => runOf(h, started.id).steps[0]?.status === 'running')
    const run = runOf(h, started.id)
    const file = join(h.dataDir, 'flow-runs', `${started.id}.json`)
    const savedBefore = readFileSync(file, 'utf8')
    const emittedBefore = h.emitted.length

    // Synchronous, and again changes nothing.
    expect(h.engine.quit()).toBeUndefined()
    expect(h.engine.quit()).toBeUndefined()

    // The agent ends as the quit stops it would; the engine has every reason to go on, and does not.
    await waitFor('the agent to finish', () => existsSync(join(run.worktree!, 'DONE.txt')))
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(h.cwds).toHaveLength(1)
    expect(readdirSync(h.worktrees)).toEqual([`flow-${started.id}`])
    expect(existsSync(join(run.worktree!, 'started.txt'))).toBe(false)
    expect(sh(['rev-parse', run.branch!], h.repo).trim()).toBe(base)
    expect(sh(['status', '--porcelain'], run.worktree!)).toContain('?? DONE.txt')
    // What is saved, and what the window was told, stays as it was.
    expect(readFileSync(file, 'utf8')).toBe(savedBefore)
    expect(h.emitted).toHaveLength(emittedBefore)
    expect(runOf(h, started.id).status).toBe('running')

    // The next start loads it as stopped, like any run a quit interrupted.
    const fresh = new FlowEngine(h.deps)
    expect(fresh.runs().find((r) => r.id === started.id)?.status).toBe('stopped')
  }, LONG)

  it('makes no end-of-run commit, so the work stays uncommitted for the next start to find', async () => {
    const h = makeHarness({ claude: { delayMs: 300, write: writeDone } })
    const base = head(h.repo)
    const saved = h.engine.save(makeFlow({ steps: [agentStep('s1')] }))
    const started = await h.engine.run(saved.id)
    await waitFor('the agent step to run', () => runOf(h, started.id).steps[0]?.status === 'running')
    const run = runOf(h, started.id)
    h.engine.quit()
    await waitFor('the agent to finish', () => existsSync(join(run.worktree!, 'DONE.txt')))
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(sh(['rev-parse', run.branch!], h.repo).trim()).toBe(base)
    expect(sh(['status', '--porcelain'], run.worktree!)).toContain('?? DONE.txt')
    expect(runOf(h, started.id).status).toBe('running')
  }, LONG)

  it('starts no check process in a plain run', async () => {
    const h = makeHarness({ claude: { delayMs: 300 } })
    const saved = h.engine.save(makeFlow({ isolate: false, steps: [agentStep('s1'), checkStep('s2', 'echo started > started.txt')] }))
    const started = await h.engine.run(saved.id)
    await waitFor('the agent step to run', () => runOf(h, started.id).steps[0]?.status === 'running')
    h.engine.quit()
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(existsSync(join(h.repo, 'started.txt'))).toBe(false)
    expect(runOf(h, started.id).steps.map((step) => step.status)).toEqual(['running', 'pending'])
  }, LONG)

  it('makes no check folder for a step that was waiting for the repository when the quit came', async () => {
    const h = makeHarness({ claude: { delayMs: 300, write: writeDone } })
    const base = head(h.repo)
    const saved = h.engine.save(makeFlow())
    const started = await h.engine.run(saved.id)
    await waitFor('the agent step to run', () => runOf(h, started.id).steps[0]?.status === 'running')
    const run = runOf(h, started.id)
    // The repository is busy with something else when the agent ends.
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const busy = withRepoLock(h.repo, () => gate)
    // The step committed the work and now waits to make its check folder.
    await waitFor('the work to be committed', () => sh(['rev-parse', run.branch!], h.repo).trim() !== base)
    h.engine.quit()
    open()
    await busy
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(readdirSync(h.worktrees)).toEqual([`flow-${started.id}`])
    expect(worktreeCount(h.repo)).toBe(2)
    expect(h.engine.busyPaths()).toEqual([run.worktree])
  }, LONG)

  it('refuses new runs, merges and discards, but lets a merge that is under way finish and be saved', async () => {
    const h = writerHarness()
    const first = await endedRun(h)
    const second = await endedRun(h)
    const merging = h.engine.merge(first.id)
    h.engine.quit()
    const refusal = 'Regatta is quitting, so nothing new was started.'
    await expect(h.engine.merge(second.id)).rejects.toThrow(refusal)
    await expect(h.engine.discard(second.id)).rejects.toThrow(refusal)
    const flow = h.engine.save(makeFlow())
    await expect(h.engine.run(flow.id)).rejects.toThrow(refusal)
    // A plain run too: it needs no worktree, so nothing else would have stopped it.
    const plain = h.engine.save(makeFlow({ isolate: false, steps: [] }))
    const known = h.engine.runs().length
    await expect(h.engine.run(plain.id)).rejects.toThrow(refusal)
    expect(h.engine.runs()).toHaveLength(known)
    intact(h, second)

    const result = await merging
    expect(result.merged).toBe(true)
    const file = JSON.parse(readFileSync(join(h.dataDir, 'flow-runs', `${first.id}.json`), 'utf8')) as { mergeSummary: string }
    expect(file.mergeSummary).toBe(result.summary)
  }, LONG)

  it('still saves a hold: a folder whose programs could not be stopped is not forgotten because the app was quitting', async () => {
    const h = makeHarness({ claude: SCENARIOS['stuckSlow']! })
    const saved = h.engine.save(makeFlow({ steps: [agentStep('s1')] }))
    const started = await h.engine.run(saved.id)
    await waitFor('the agent step to run', () => runOf(h, started.id).steps[0]?.status === 'running')
    const run = runOf(h, started.id)
    h.engine.quit()
    // The quit stops the agent; some of its programs cannot be stopped.
    h.engine.stop(started.id)
    await waitFor('the hold to be saved', () => {
      const file = JSON.parse(readFileSync(join(h.dataDir, 'flow-runs', `${started.id}.json`), 'utf8')) as { held?: Record<string, string> }
      return Object.keys(file.held ?? {}).length === 1
    })
    const fresh = new FlowEngine(h.deps)
    expect(fresh.busyPaths()).toEqual([run.worktree])
    expect(fresh.runs().find((r) => r.id === started.id)?.status).toBe('stopped')
  }, LONG)
})

/** The user's branch is where it was and holds no run files. */
function untouchedMain(h: Harness, before: string): void {
  expect(head(h.repo)).toBe(before)
  expect(existsSync(join(h.repo, 'DONE.txt'))).toBe(false)
}
