// The night watch engine against the safety bar (docs/design/safety.md): real repositories, real
// processes, temp folders. A merge only fast-forwards the user's branch, a run worktree is removed
// only while pristine, a run branch only while it still points at the tested commit, and a folder a
// process could not be stopped in is never removed.

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AGENTS } from '../../shared/agents'
import type { CheckSpec } from '../../shared/heats'
import type { NightState, NightTask, NightTaskRun } from '../../shared/nightwatch'
import type { AgentKind, DetectedAgent } from '../../shared/types'
import { emptyTrash, listTrash } from '../heats/git-ops'
import { NightWatch as RealNightWatch } from './engine'
import type { NightWatchDeps } from './engine'
import type { RunHandle, RunOptions, RunResult } from '../heats/runner'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']
const CHECKS: CheckSpec[] = [
  { name: 'done', command: 'test -f DONE.txt', kind: 'required' },
  { name: 'guard', command: 'test -f GUARD.txt', kind: 'guard' }
]
const CART = "it('adds', () => { expect(1).toBe(1) })\nit('subtracts', () => { expect(2).toBe(2) })\n"
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

/** Programs the tests left running on purpose; every one is killed when the file is done. */
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

afterAll(async () => {
  killSleepers()
  await cleanUp()
})

/** What the fake agent does in its worktree, and how long it takes. */
interface Scenario {
  delayMs: number
  /** The exit code the agent reports. Null means it was killed by a signal. Defaults to 0. */
  exitCode?: number | null
  write?: (cwd: string) => void
  /** The agent's run ends with some of its processes still alive (the supervisor gave up on them). */
  stuck?: boolean
}

function finished(cwd: string): void {
  writeFileSync(join(cwd, 'DONE.txt'), 'done\n')
  appendFileSync(join(cwd, 'src', 'app.js'), '// changed by the agent\n')
}

/** Writes a file of its own, named after its worktree, so two runs never conflict. */
function own(cwd: string): void {
  writeFileSync(join(cwd, `${basename(cwd)}.txt`), 'mine\n')
}

const SCENARIOS: Record<string, Scenario> = {
  good: { delayMs: 60, write: finished },
  own: { delayMs: 60, write: own },
  noChange: { delayMs: 60 },
  slow: { delayMs: 30000, write: finished }
}

interface Harness {
  engine: NightWatch
  repo: string
  dataDir: string
  worktrees: string
  /** Every run the engine started, with the prompt and folder it used. */
  runs: RunOptions[]
  /** Every state the engine emitted. */
  emitted: NightState[]
  /** Every call to keepAwake, in order. */
  awake: boolean[]
  deps: NightWatchDeps
}

/** Scenarios by agent ("claude") or by numbered worktree when an agent takes two tasks ("claude-2"). */
type Plan = Record<string, Scenario>

interface HarnessOptions {
  /** Runs in the repository before the first commit, to give it more than the usual files. */
  prepare?: (repo: string) => void
  /** Runs in the repository after the first commit: what is made there is not in the commit. */
  after?: (repo: string) => void
  patch?: Partial<NightWatchDeps>
}

function makeHarness(kinds: AgentKind[], plan: Plan, options: HarnessOptions = {}): Harness {
  const repo = temp('regatta-night-safe-')
  sh(['init', '-b', 'main'], repo)
  // Merge commits use the repository user's identity.
  sh(['config', 'user.name', 'Regatta Test'], repo)
  sh(['config', 'user.email', 'test@regatta.local'], repo)
  mkdirSync(join(repo, 'test'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'test', 'cart.test.js'), CART)
  writeFileSync(join(repo, 'GUARD.txt'), 'guard\n')
  writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
  options.prepare?.(repo)
  sh(['add', '.'], repo)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], repo)
  options.after?.(repo)
  const worktrees = temp('regatta-night-safe-wt-')
  const dataDir = temp('regatta-night-safe-data-')

  const seen: Omit<Harness, 'engine' | 'deps'> = { repo, worktrees, dataDir, runs: [], emitted: [], awake: [] }
  const run = (opts: RunOptions): RunHandle => {
    seen.runs.push(opts)
    const lane = basename(opts.cwd).replace(/^night-[a-z0-9]+-/, '')
    const scenario = plan[lane] ?? plan[opts.agent] ?? { delayMs: 0 }
    const started = Date.now()
    let settle!: (result: RunResult) => void
    let closed = false
    const done = new Promise<RunResult>((resolve) => {
      settle = resolve
    })
    const finish = (result: RunResult): void => {
      if (closed) return
      closed = true
      settle(result)
    }
    opts.onActivity(`${opts.agent} is working on the task`)
    opts.onTokens(4321)
    const clock = setTimeout(() => {
      scenario.write?.(opts.cwd)
      finish({
        exitCode: 'exitCode' in scenario ? (scenario.exitCode ?? null) : 0,
        durationMs: Date.now() - started,
        tokens: 4321,
        stopped: false,
        ...(scenario.stuck ? { stuck: true } : {})
      })
    }, scenario.delayMs)
    clock.unref()
    return {
      done,
      stop: () => {
        clearTimeout(clock)
        finish({ exitCode: null, durationMs: Date.now() - started, tokens: null, stopped: true, ...(scenario.stuck ? { stuck: true } : {}) })
      }
    }
  }
  const deps: NightWatchDeps = {
    dataDir,
    root: () => repo,
    env: () => ENV,
    agents: () => detectedAgents(kinds),
    run,
    emit: (state) => seen.emitted.push(state),
    worktreesDir: () => worktrees,
    keepAwake: (on) => seen.awake.push(on),
    ...options.patch
  }
  return { ...seen, engine: new NightWatch(deps), deps }
}

function detectedAgents(kinds: AgentKind[]): DetectedAgent[] {
  return kinds.map((kind) => ({
    ...AGENTS[kind],
    installed: true,
    path: `/usr/bin/${AGENTS[kind].command}`,
    version: '1.0'
  }))
}

function task(prompt: string, agent: AgentKind = 'claude', checks: CheckSpec[] = CHECKS): Omit<NightTask, 'id' | 'createdAt'> {
  return { prompt, agent, checks }
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 60000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function runOf(harness: Harness, index = 0): NightTaskRun {
  const found = harness.engine.state().nights[0]?.runs[index]
  if (!found) throw new Error(`No run ${index}`)
  return found
}

/** Adds the tasks, starts the night now and waits until it is over. Returns the night id. */
async function runNight(harness: Harness, tasks: Omit<NightTask, 'id' | 'createdAt'>[]): Promise<string> {
  for (const t of tasks) harness.engine.addTask(t)
  const nightId = (await harness.engine.schedule('now')).nights[0]!.id
  await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
  return nightId
}

/** A finished night with one task that passed every gate. */
async function readyRun(plan: Plan = {}, options: HarnessOptions = {}, checks: CheckSpec[] = CHECKS): Promise<{ harness: Harness; nightId: string; run: NightTaskRun }> {
  const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']!, ...plan }, options)
  const nightId = await runNight(harness, [task('good task', 'claude', checks)])
  const run = runOf(harness)
  expect(run.status).toBe('ready')
  return { harness, nightId, run }
}

/** A fingerprint of a whole folder: names, file contents and link targets. */
function treeHash(root: string): string {
  const hash = createHash('sha1')
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      hash.update(`${path.slice(root.length)}|${stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? `l:${readlinkSync(path)}` : `f:${stat.size}`}\n`)
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) hash.update(readFileSync(path))
    }
  }
  walk(root)
  return hash.digest('hex')
}

/** The project's own dependencies as a real node_modules has them: a package, a hidden folder and a link inside. Returns their fingerprint. */
function withModules(repo: string): string {
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  mkdirSync(join(repo, 'node_modules', '.bin'))
  symlinkSync('../pkg/index.js', join(repo, 'node_modules', '.bin', 'pkg'))
  return treeHash(join(repo, 'node_modules'))
}

function head(repo: string): string {
  return sh(['rev-parse', 'HEAD'], repo).trim()
}

function branches(repo: string): string[] {
  return sh(['branch', '--list', 'regatta/night-*', '--format=%(refname:short)'], repo).trim().split('\n').filter(Boolean)
}

/** Writes files in the user's folder and commits them on the branch checked out there. */
function commitInRoot(repo: string, files: Record<string, string>, message = 'work in the folder'): string {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content)
  sh(['add', '-A'], repo)
  sh([...IDENTITY, 'commit', '-m', message], repo)
  return head(repo)
}

/** Everything about the user's folder that a refused merge must leave exactly as it was. */
function folderState(repo: string): { head: string; status: string; mergeHead: boolean; branch: string } {
  return {
    head: head(repo),
    status: sh(['status', '--porcelain'], repo),
    mergeHead: existsSync(join(repo, '.git', 'MERGE_HEAD')),
    branch: sh(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim()
  }
}

/** The ref the run's branch was kept at, as its note says it (the folder's own keep may have taken the plain name first). */
function branchKeepRef(harness: Harness, run: NightTaskRun): string {
  void run
  const match = runOf(harness).note?.match(/Kept a copy of the run's work at (\S+) /)
  if (!match) throw new Error(`no keep note in: ${runOf(harness).note}`)
  return match[1]!
}

/** True when some keep ref under refs/regatta/discarded/ has the commit in its history. */
function keepHolds(repo: string, id: string): boolean {
  const refs = sh(['for-each-ref', '--format=%(refname)', 'refs/regatta/discarded/'], repo).split('\n').filter(Boolean)
  return refs.some((ref) => sh(['rev-list', ref], repo).split('\n').includes(id))
}

/** What a run's note and the night's notes say when its branch went and a copy of its work was kept first. */
function copyNote(run: NightTaskRun): string {
  const ref = `refs/regatta/discarded/night-${run.id}`
  return `Kept a copy of the run's work at ${ref} (restore the work with git branch night-${run.id}-restored ${ref}^1; git log ${ref} shows everything kept).`
}

/** The git command a note gives for bringing the work back, as the arguments to run it with. */
function restoreCommand(note: string): string[] {
  const match = note.match(/restore the work with git ([^;)]+);/)
  if (!match) throw new Error(`no restore command in: ${note}`)
  return match[1]!.split(' ')
}

/** The run is still ready, its worktree and branch are there, and the note says why the merge did not happen. */
function untouched(harness: Harness, index = 0): void {
  const run = runOf(harness, index)
  expect(run.status).toBe('ready')
  expect(existsSync(run.worktree!)).toBe(true)
  expect(branches(harness.repo)).toContain(run.branch)
}

describe('merging a ready run into the real folder', () => {
  it('fast-forwards when the folder has not moved, and leaves nothing behind', async () => {
    const { harness, nightId, run } = await readyRun()
    const tip = sh(['rev-parse', run.branch!], harness.repo).trim()
    const result = await harness.engine.merge(run.id)
    expect(result.summary).toMatch(/^Fast-forwarded main by 1 commit/)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(result.summary).toContain("Moved its worktree to Regatta's trash")
    expect(head(harness.repo)).toBe(tip)
    expect(sh(['rev-list', '--merges', 'HEAD'], harness.repo).trim()).toBe('')
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(sh(['log', '-1', '--format=%s'], harness.repo).trim()).toContain(`Night ${nightId}`)
    expect(sh(['log', '-1', '--format=%an'], harness.repo).trim()).toBe('Regatta')
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
    expect(existsSync(run.worktree!)).toBe(false)
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(1)
    expect(readdirSync(join(harness.worktrees, '.regatta-trash'))).toEqual([])
    expect(branches(harness.repo)).toEqual([])
    expect(runOf(harness).status).toBe('merged')
    expect(runOf(harness).note).toBe(result.summary)
    // Nobody asks whether the user's branch holds it: the work is kept anyway, for the branch and the folder.
    expect(keepHolds(harness.repo, tip)).toBe(true)
    expect(result.summary).toContain('Kept a copy')
  }, 90000)

  it('builds a merge commit away from the folder when the folder moved ahead, then fast-forwards to it', async () => {
    const { harness, nightId, run } = await readyRun()
    const tip = sh(['rev-parse', run.branch!], harness.repo).trim()
    const ahead = commitInRoot(harness.repo, { 'LATER.txt': 'later\n' })
    const result = await harness.engine.merge(run.id)
    expect(result.summary).toMatch(/^Merged into main with 1 commit/)
    const parents = sh(['rev-list', '--parents', '-n', '1', 'HEAD'], harness.repo).trim().split(' ')
    expect(parents.slice(1)).toEqual([ahead, tip])
    expect(sh(['log', '-1', '--format=%s'], harness.repo).trim()).toBe(`Merge night ${nightId} (run 0)`)
    expect(readFileSync(join(harness.repo, 'LATER.txt'), 'utf8')).toBe('later\n')
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
    expect(existsSync(join(harness.repo, '.git', 'MERGE_HEAD'))).toBe(false)
    // The merge commit was made in a scratch worktree that is gone again, and the run worktree is in the trash.
    expect(existsSync(run.worktree!)).toBe(false)
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(1)
    expect(readdirSync(join(harness.worktrees, '.regatta-trash'))).toEqual([])
    expect(branches(harness.repo)).toEqual([])
  }, 90000)

  it('refuses a folder with uncommitted changes to tracked files, and leaves it as it was', async () => {
    const { harness, run } = await readyRun()
    writeFileSync(join(harness.repo, 'GUARD.txt'), 'guard\nbeing edited\n')
    const before = folderState(harness.repo)
    await expect(harness.engine.merge(run.id)).rejects.toThrow('Commit or stash your changes first.')
    expect(folderState(harness.repo)).toEqual(before)
    expect(readFileSync(join(harness.repo, 'GUARD.txt'), 'utf8')).toBe('guard\nbeing edited\n')
    untouched(harness)
    expect(runOf(harness).note).toContain('Not merged: Commit or stash your changes first.')
    expect(runOf(harness).note).toContain('All gates passed')

    // Once the edit is out of the way, the same run merges.
    sh(['checkout', '--', 'GUARD.txt'], harness.repo)
    expect((await harness.engine.merge(run.id)).merged).toBe(true)
    expect(runOf(harness).note).not.toContain('Not merged')
  }, 90000)

  it('needs a branch checked out, and keeps everything when the folder is on a detached HEAD', async () => {
    const { harness, run } = await readyRun()
    sh(['checkout', '--detach'], harness.repo)
    const before = folderState(harness.repo)
    await expect(harness.engine.merge(run.id)).rejects.toThrow('Check out a branch before merging.')
    expect(folderState(harness.repo)).toEqual(before)
    untouched(harness)
    expect(runOf(harness).note).toContain('Not merged: Check out a branch before merging.')
    sh(['checkout', 'main'], harness.repo)
    expect((await harness.engine.merge(run.id)).merged).toBe(true)
  }, 90000)

  it('merges into the branch the folder is on when it is asked, which is not always the one the night started on', async () => {
    const { harness, run } = await readyRun()
    sh(['checkout', '-q', '-b', 'feature'], harness.repo)
    const result = await harness.engine.merge(run.id)
    expect(result.summary).toMatch(/^Fast-forwarded feature by 1 commit/)
    expect(sh(['rev-parse', 'main'], harness.repo).trim()).not.toBe(head(harness.repo))
    expect(existsSync(join(harness.repo, 'DONE.txt'))).toBe(true)
  }, 90000)

  it('refuses a conflict with the folder without ever leaving a merge there, and merges once it is gone', async () => {
    const { harness, run } = await readyRun()
    commitInRoot(harness.repo, { 'src/app.js': 'export const app = 1\n// made in the folder\n' }, 'conflicting work')
    const before = folderState(harness.repo)
    await expect(harness.engine.merge(run.id)).rejects.toThrow(/conflicts with work in main/)
    expect(folderState(harness.repo)).toEqual(before)
    expect(readFileSync(join(harness.repo, 'src', 'app.js'), 'utf8')).not.toContain('changed by the agent')
    untouched(harness)
    expect(runOf(harness).note).toContain('Not merged: The change conflicts with work in main')
    // Only the run's own worktree is registered and in the worktrees folder: the scratch tree is gone.
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(2)
    expect(readdirSync(harness.worktrees)).toEqual([basename(run.worktree!)])

    sh(['reset', '--hard', 'HEAD~1'], harness.repo)
    expect((await harness.engine.merge(run.id)).merged).toBe(true)
    expect(readFileSync(join(harness.repo, 'src', 'app.js'), 'utf8')).toContain('changed by the agent')
  }, 90000)

  it('will not overwrite an untracked file the run also adds, and keeps its bytes', async () => {
    const { harness, run } = await readyRun()
    writeFileSync(join(harness.repo, 'DONE.txt'), 'precious\n')
    const before = folderState(harness.repo)
    await expect(harness.engine.merge(run.id)).rejects.toThrow(/Merging would overwrite files.*DONE\.txt/)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('precious\n')
    expect(folderState(harness.repo)).toEqual(before)
    untouched(harness)
    expect(runOf(harness).note).toContain('DONE.txt')

    unlinkSync(join(harness.repo, 'DONE.txt'))
    expect((await harness.engine.merge(run.id)).merged).toBe(true)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
  }, 90000)

  it('will not overwrite an ignored file the run also adds, with the folder unmoved or moved ahead', async () => {
    for (const moved of [false, true]) {
      const { harness, run } = await readyRun()
      if (moved) commitInRoot(harness.repo, { 'LATER.txt': 'later\n' })
      // The user keeps a DONE.txt of their own and git is told to ignore it.
      writeFileSync(join(harness.repo, '.git', 'info', 'exclude'), 'DONE.txt\n')
      writeFileSync(join(harness.repo, 'DONE.txt'), 'precious\n')
      const before = folderState(harness.repo)
      await expect(harness.engine.merge(run.id)).rejects.toThrow(/DONE\.txt/)
      expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('precious\n')
      expect(folderState(harness.repo)).toEqual(before)
      untouched(harness)
    }
  }, 120000)

  it('merges two runs asked for at the same moment one after the other: the second is refused, then goes through on a retry', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['own']!, codex: SCENARIOS['own']! })
    const checks: CheckSpec[] = [{ name: 'ok', command: 'true', kind: 'required' }]
    await runNight(harness, [task('first', 'claude', checks), task('second', 'codex', checks)])
    const [a, b] = harness.engine.state().nights[0]!.runs
    expect([a!.status, b!.status]).toEqual(['ready', 'ready'])
    // Both were asked for while main was at the same commit; the first one moves it, so the second is refused, not guessed at.
    const results = await Promise.allSettled([harness.engine.merge(a!.id), harness.engine.merge(b!.id)])
    // Which one the repository lock lets in first is up to timing; the other one is refused.
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = results.findIndex((r) => r.status === 'rejected')
    expect(String((results[refused] as PromiseRejectedResult).reason)).toContain('moved on since the merge was asked for')
    const refusedRun = refused === 0 ? a! : b!
    expect(existsSync(join(harness.repo, `${basename(refusedRun.worktree!)}.txt`))).toBe(false)
    untouched(harness, refused)
    // Asked again, it is judged on the new state of the branch and goes through.
    expect((await harness.engine.merge(refusedRun.id)).merged).toBe(true)
    expect(existsSync(join(harness.repo, `${basename(a!.worktree!)}.txt`))).toBe(true)
    expect(existsSync(join(harness.repo, `${basename(b!.worktree!)}.txt`))).toBe(true)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(2)
    expect(branches(harness.repo)).toEqual([])
    expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
    expect(existsSync(join(harness.repo, '.git', 'MERGE_HEAD'))).toBe(false)
  }, 120000)

  it('merges the tested commit even when a replace ref redirects its contents', async () => {
    const { harness, run } = await readyRun()
    const tip = sh(['rev-parse', run.branch!], harness.repo).trim()
    // Plain git would now read the tested commit as the base commit, which has no DONE.txt.
    sh(['replace', tip, head(harness.repo)], harness.repo)
    expect((await harness.engine.merge(run.id)).merged).toBe(true)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
  }, 90000)

  it('refuses to merge or discard when the repository identity cannot be read, and recovers when it can', async () => {
    const { harness, run } = await readyRun()
    const headFile = join(harness.repo, '.git', 'HEAD')
    const saved = readFileSync(headFile, 'utf8')
    rmSync(headFile)
    await expect(harness.engine.merge(run.id)).rejects.toThrow(/Could not tell which repository/)
    await expect(harness.engine.discard(run.id)).rejects.toThrow(/Could not tell which repository/)
    writeFileSync(headFile, saved)
    untouched(harness)
    expect(runOf(harness).note).toContain('Not merged: Could not tell which repository')
    expect((await harness.engine.merge(run.id)).merged).toBe(true)
    expect(runOf(harness).note).not.toContain('Not merged')
  }, 90000)

  it('refuses a second request for the same run while one is under way, and the first still completes', async () => {
    const { harness, run } = await readyRun()
    const first = harness.engine.merge(run.id)
    await expect(harness.engine.merge(run.id)).rejects.toThrow('A merge or discard is already running for this run.')
    await expect(harness.engine.discard(run.id)).rejects.toThrow('A merge or discard is already running for this run.')
    expect((await first).merged).toBe(true)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
  }, 90000)

  it('merges a run that was ready before the night was cancelled, once everything has stopped', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['slow']! })
    harness.engine.addTask(task('quick one'))
    harness.engine.addTask(task('slow one', 'codex'))
    await harness.engine.schedule('now')
    await waitFor('the first run to be ready and the second to start', () => runOf(harness, 0).status === 'ready' && runOf(harness, 1).status === 'running')
    harness.engine.cancel()
    expect(harness.engine.state().nights[0]?.status).toBe('cancelled')
    const result = await harness.engine.merge(runOf(harness, 0).id)
    expect(result.merged).toBe(true)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    // The merge waited for the night to wind down, and winding down did not make it finished.
    expect(harness.engine.state().nights[0]?.status).toBe('cancelled')
    expect(runOf(harness, 1).status).toBe('stopped')
  }, 90000)
})

describe('removing a run worktree', () => {
  const MODULES: CheckSpec[] = [{ name: 'modules', command: 'test -f node_modules/pkg/index.js', kind: 'required' }, ...CHECKS]

  it.skipIf(process.platform !== 'darwin')('moves a worktree that holds its own copy of node_modules to the trash, and emptying the trash removes it', async () => {
    // The project ignores `node_modules/` the way most templates do, or does not say anything about it.
    for (const [how, ignored] of [['merge', true], ['discard', false]] as const) {
      const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! }, {
        prepare: ignored ? (repo) => writeFileSync(join(repo, '.gitignore'), 'node_modules/\n') : undefined,
        after: (repo) => void withModules(repo)
      })
      await runNight(harness, [task('good task', 'claude', MODULES)])
      const run = runOf(harness)
      expect(run.status).toBe('ready')
      // The worktree has a copy of its own, a real folder and not a link, and the checks (which need it) passed there.
      const own = lstatSync(join(run.worktree!, 'node_modules'))
      expect(own.isDirectory()).toBe(true)
      expect(own.isSymbolicLink()).toBe(false)
      expect(run.checks.map((c) => [c.name, c.passed])).toEqual([['modules', true], ['done', true], ['guard', true]])
      // The copy is not the agent's work: the tested commit does not carry it.
      const files = sh(['ls-tree', '-r', '--name-only', run.branch!], harness.repo).split('\n')
      expect(files.filter((name) => name.startsWith('node_modules'))).toEqual([])

      if (how === 'merge') {
        // The folder has a real node_modules directory of its own: a commit that carried one could never fast-forward.
        expect((await harness.engine.merge(run.id)).summary).toContain('Removed 1 worktree and 0 branches.')
        expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
      } else {
        await harness.engine.discard(run.id)
      }
      expect(existsSync(run.worktree!)).toBe(false)
      expect(runOf(harness).note).not.toContain('Kept:')
      expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
      expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
      expect(branches(harness.repo)).toEqual([])
      expect(readdirSync(join(harness.worktrees, '.regatta-trash'))).toEqual([])
      expect(readFileSync(join(harness.repo, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    }
  }, 240000)

  it.skipIf(process.platform !== 'darwin')('does not take away a node_modules the agent committed itself', async () => {
    const prepare = (repo: string): void => {
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
      mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    }
    const commitsModules = (cwd: string): void => {
      finished(cwd)
      execFileSync('git', ['add', '-f', 'node_modules'], { cwd })
      execFileSync('git', [...IDENTITY, 'commit', '-q', '-m', 'the agent commits node_modules itself'], { cwd })
    }
    const { harness, run } = await readyRun({ claude: { delayMs: 60, write: commitsModules } }, { prepare })
    // What the agent committed stays committed; Regatta committed the rest on top and removed nothing.
    const files = sh(['ls-tree', '-r', '--name-only', run.branch!], harness.repo).split('\n')
    expect(files.some((name) => name.startsWith('node_modules/'))).toBe(true)
    expect(files).toContain('DONE.txt')
    expect(sh(['log', '--format=%s', `${run.base}..${run.branch}`], harness.repo).trim().split('\n')).toHaveLength(2)
    expect(sh(['diff', '--name-status', `${run.base}`, run.branch!], harness.repo)).not.toMatch(/^D/m)
  }, 90000)

  /** What a user can leave in a run worktree, which moves intact into the trash. */
  const LEFT: Record<string, { leave: (worktree: string, repo: string) => void; file: string; bytes: string }> = {
    'an edited file': {
      leave: (wt) => writeFileSync(join(wt, 'GUARD.txt'), 'edited by the user\n'),
      file: 'GUARD.txt',
      bytes: 'edited by the user\n'
    },
    'an untracked file': {
      leave: (wt) => writeFileSync(join(wt, 'MINE.txt'), 'mine\n'),
      file: 'MINE.txt',
      bytes: 'mine\n'
    },
    'an ignored file': {
      leave: (wt, repo) => {
        // Ignored by the project's own rules, so a plain status does not list it.
        writeFileSync(join(repo, '.git', 'info', 'exclude'), 'local/\n')
        mkdirSync(join(wt, 'local'))
        writeFileSync(join(wt, 'local', 'notes.txt'), 'my notes, git ignores them\n')
      },
      file: join('local', 'notes.txt'),
      bytes: 'my notes, git ignores them\n'
    }
  }

  for (const [what, left] of Object.entries(LEFT)) {
    it(`moves a worktree with ${what} in it to the trash intact, and keeps its branch until the trash is emptied (discard)`, async () => {
      const { harness, run } = await readyRun()
      left.leave(run.worktree!, harness.repo)
      await harness.engine.discard(run.id)
      expect(existsSync(run.worktree!)).toBe(false)
      const trashed = await listTrash(harness.worktrees)
      expect(trashed).toHaveLength(1)
      expect(readFileSync(join(trashed[0]!.trashPath, left.file), 'utf8')).toBe(left.bytes)
      expect(branches(harness.repo)).toEqual([run.branch])
      const after = runOf(harness)
      expect(after.status).toBe('discarded')
      expect(after.note).toContain("Moved its worktree to Regatta's trash")
      expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(2)
    }, 90000)

    it(`moves a worktree with ${what} in it to the trash intact after the change was merged`, async () => {
      const { harness, run } = await readyRun()
      left.leave(run.worktree!, harness.repo)
      const result = await harness.engine.merge(run.id)
      // The change is home; what the user left behind stays inside the trashed worktree.
      expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
      expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
      expect(result.summary).toContain("Moved its worktree to Regatta's trash")
      expect(existsSync(run.worktree!)).toBe(false)
      const trashed = await listTrash(harness.worktrees)
      expect(trashed).toHaveLength(1)
      expect(readFileSync(join(trashed[0]!.trashPath, left.file), 'utf8')).toBe(left.bytes)
      expect(branches(harness.repo)).toEqual([run.branch])
      expect(runOf(harness).status).toBe('merged')
      expect(runOf(harness).note).toBe(result.summary)
    }, 90000)
  }

  it('moves a worktree whose detached HEAD holds the only copy of a commit to the trash after keeping that commit', async () => {
    const { harness, run } = await readyRun()
    const wt = run.worktree!
    sh(['checkout', '-q', '--detach'], wt)
    writeFileSync(join(wt, 'ONLY.txt'), 'only here\n')
    sh(['add', 'ONLY.txt'], wt)
    sh([...IDENTITY, 'commit', '-q', '-m', 'work on a detached head'], wt)
    const lonely = head(wt)
    expect(sh(['branch', '--contains', lonely], harness.repo).trim()).toBe('')

    await harness.engine.discard(run.id)
    expect(existsSync(wt)).toBe(false)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    // Nothing but a keep commit holds it now, through expiry and collection.
    sh(['reflog', 'expire', '--expire=now', '--all'], harness.repo)
    sh(['gc', '--prune=now', '-q'], harness.repo)
    expect(keepHolds(harness.repo, lonely)).toBe(true)
    expect(sh(['show', `${lonely}:ONLY.txt`], harness.repo)).toBe('only here\n')
  }, 90000)

  it('moves a worktree to the trash while a program runs in it, and emptyTrash skips it until the program is gone', async () => {
    const { harness, run } = await readyRun()
    const pid = leaveSleeper(run.worktree!)
    await new Promise((resolve) => setTimeout(resolve, 300))

    await harness.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(runOf(harness).status).toBe('discarded')
    expect(runOf(harness).note).not.toContain('Kept:')
    expect(runOf(harness).note).toContain(copyNote(run))
    await expect(harness.engine.discard(run.id)).rejects.toThrow('That run has already been merged or discarded.')

    const firstEmpty = await emptyTrash(harness.worktrees)
    expect(firstEmpty.outcomes.filter((o) => o.status === 'skipped')).toHaveLength(1)
    expect(firstEmpty.outcomes[0]?.reason).toContain('in use')
    expect(firstEmpty.outcomes[0]?.reason).toContain(String(pid))
    expect(branches(harness.repo)).toEqual([run.branch])

    killSleepers()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
  }, 90000)

  it('moves the worktree of a run whose agent left a program in a session of its own to the trash, and emptyTrash skips it while in use', async () => {
    let pid = 0
    const leaves = (cwd: string): void => {
      finished(cwd)
      pid = leaveSleeper(cwd)
    }
    const { harness, run } = await readyRun({ claude: { delayMs: 60, write: leaves } })
    expect(pid).toBeGreaterThan(0)

    const result = await harness.engine.merge(run.id)
    expect(readFileSync(join(harness.repo, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(result.summary).toContain("Moved its worktree to Regatta's trash")
    expect(existsSync(run.worktree!)).toBe(false)
    expect(branches(harness.repo)).toEqual([run.branch])

    const firstEmpty = await emptyTrash(harness.worktrees)
    expect(firstEmpty.outcomes.filter((o) => o.status === 'skipped')).toHaveLength(1)
    expect(firstEmpty.outcomes[0]?.reason).toContain('in use')

    killSleepers()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    expect(runOf(harness).status).toBe('merged')
  }, 90000)
})

describe('dependencies are copied, never linked', () => {
  it.skipIf(process.platform !== 'darwin')('leaves the project\'s own node_modules as it was when an agent and a check delete and rewrite theirs', async () => {
    for (const ignored of [true, false]) {
      const wipes = (cwd: string): void => {
        finished(cwd)
        // What `npm ci` does: everything in node_modules goes and is installed again. Emptied and refilled in
        // place, the folder itself stays the copy that was made.
        for (const name of readdirSync(join(cwd, 'node_modules'))) rmSync(join(cwd, 'node_modules', name), { recursive: true, force: true })
        writeFileSync(join(cwd, 'node_modules', 'installed.js'), 'by npm ci\n')
      }
      const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: wipes }, codex: SCENARIOS['noChange']! }, {
        prepare: ignored ? (repo) => writeFileSync(join(repo, '.gitignore'), 'node_modules/\n') : undefined,
        after: (repo) => void withModules(repo)
      })
      const original = treeHash(join(harness.repo, 'node_modules'))
      // A check that does what `npm ci` and `rm -rf node_modules/` do, in whatever folder it runs: the baseline's, the run's check folder.
      const checks: CheckSpec[] = [{ name: 'done', command: 'rm -rf node_modules/ && mkdir node_modules && echo x > node_modules/y.js; test -f DONE.txt', kind: 'required' }]
      await runNight(harness, [task('good task', 'claude', checks)])
      expect(treeHash(join(harness.repo, 'node_modules'))).toBe(original)
      const run = runOf(harness)
      expect(run.status).toBe('ready')
      // The run's own copy was rewritten, and none of that is in its commit.
      expect(readFileSync(join(run.worktree!, 'node_modules', 'installed.js'), 'utf8')).toBe('by npm ci\n')
      expect(sh(['ls-tree', '-r', '--name-only', run.branch!], harness.repo).split('\n').some((name) => name.startsWith('node_modules'))).toBe(false)

      // A run with only its copy is moved to the trash, copy included; the project's own folder is still as it was.
      const result = await harness.engine.merge(run.id)
      expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
      expect(existsSync(run.worktree!)).toBe(false)
      expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
      expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
      expect(readdirSync(join(harness.worktrees, '.regatta-trash'))).toEqual([])
      expect(treeHash(join(harness.repo, 'node_modules'))).toBe(original)
    }
  }, 240000)

  it.skipIf(process.platform !== 'darwin')('preserves a run whose agent put another folder in place of its copy inside the trash, and still leaves the project\'s own alone', async () => {
    const replaces = (cwd: string): void => {
      finished(cwd)
      // `rm -rf node_modules && mkdir node_modules`: the folder is not the copy that was made any more.
      rmSync(join(cwd, 'node_modules'), { recursive: true, force: true })
      mkdirSync(join(cwd, 'node_modules'))
      writeFileSync(join(cwd, 'node_modules', 'mine.js'), 'mine\n')
    }
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: replaces }, codex: SCENARIOS['noChange']! }, {
      prepare: (repo) => writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    })
    const original = withModules(harness.repo)
    await runNight(harness, [task('good task')])
    const run = runOf(harness)
    expect(run.status).toBe('ready')
    expect(treeHash(join(harness.repo, 'node_modules'))).toBe(original)
    // Whatever stands there now moves intact into the trash on discard.
    await harness.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    const trashed = await listTrash(harness.worktrees)
    expect(trashed).toHaveLength(1)
    expect(readFileSync(join(trashed[0]!.trashPath, 'node_modules', 'mine.js'), 'utf8')).toBe('mine\n')
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(runOf(harness).note).toContain("Moved its worktree to Regatta's trash")
    expect(treeHash(join(harness.repo, 'node_modules'))).toBe(original)
  }, 90000)

  it('says on the run, and on the night once, when the dependencies could not be copied, and runs without them', async () => {
    // The project's node_modules is a link, which a copy would still lead out of the worktree: nothing is copied.
    const outside = temp('regatta-night-modules-')
    mkdirSync(join(outside, 'pkg'))
    writeFileSync(join(outside, 'pkg', 'index.js'), 'module.exports = 1\n')
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! }, {
      after: (repo) => symlinkSync(outside, join(repo, 'node_modules'), 'dir')
    })
    await runNight(harness, [task('good task')])
    const run = runOf(harness)
    const sentence = 'Dependencies were not copied into the worktree; run your install command there.'
    expect(run.status).toBe('ready')
    expect(run.note).toBe(`All gates passed. ${sentence}`)
    expect(existsSync(join(run.worktree!, 'node_modules'))).toBe(false)
    // The baseline and the check folder said it too, and it is on the night once.
    expect(harness.engine.state().nights[0]?.notes).toEqual([sentence])
    // And it is saved: a new engine shows the same.
    const next = new NightWatch(harness.deps)
    expect(next.state().nights[0]?.runs[0]?.note).toBe(`All gates passed. ${sentence}`)
    expect(next.state().nights[0]?.notes).toEqual([sentence])
    // The project's own dependencies were never touched.
    expect(readFileSync(join(outside, 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
  }, 90000)
})

describe('a merge half done in the run worktree', () => {
  it('fails the run with the sentence commitAll gives, keeps its folder and the half done merge, and a discard moves them intact to the trash', async () => {
    // A branch of the user's, and an agent that starts merging it in its folder and leaves it there.
    const startsAMerge = (cwd: string): void => {
      execFileSync('git', ['merge', '--no-commit', '--no-ff', 'topic'], { cwd, stdio: 'ignore' })
      finished(cwd)
    }
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: startsAMerge }, codex: SCENARIOS['noChange']! }, {
      after: (repo) => {
        sh(['checkout', '-q', '-b', 'topic'], repo)
        writeFileSync(join(repo, 'TOPIC.txt'), 'topic\n')
        sh(['add', 'TOPIC.txt'], repo)
        sh([...IDENTITY, 'commit', '-q', '-m', 'topic'], repo)
        sh(['checkout', '-q', 'main'], repo)
      }
    })
    await runNight(harness, [task('good task')])
    const run = runOf(harness)
    expect(run.status).toBe('failed')
    expect(run.note).toBe('A merge is in progress in this folder, so nothing was committed. Finish or abort it first.')
    expect(run.tip ?? null).toBeNull()
    // Nothing was committed, and the half done merge is exactly where the agent left it.
    expect(sh(['rev-list', '--count', `${run.base}..${run.branch}`], harness.repo).trim()).toBe('0')
    const mergeHead = execFileSync('git', ['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd: run.worktree!, encoding: 'utf8' }).trim()
    expect(existsSync(resolve(run.worktree!, mergeHead))).toBe(true)
    expect(existsSync(run.worktree!)).toBe(true)

    // Discarding it moves the folder and the half-done merge intact into the trash.
    await harness.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    const trashed = await listTrash(harness.worktrees)
    expect(trashed).toHaveLength(1)
    const trashedMergeHead = execFileSync('git', ['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd: trashed[0]!.trashPath, encoding: 'utf8' }).trim()
    expect(existsSync(resolve(trashed[0]!.trashPath, trashedMergeHead))).toBe(true)
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(runOf(harness).note).toContain("Moved its worktree to Regatta's trash")
  }, 90000)
})

describe('branches the night made', () => {
  /** The user opens the run worktree and commits on its branch. */
  function commitOnBranch(run: NightTaskRun): string {
    writeFileSync(join(run.worktree!, 'USERS.txt'), 'my own work\n')
    sh(['add', 'USERS.txt'], run.worktree!)
    sh([...IDENTITY, 'commit', '-q', '-m', 'my own commit on the run branch'], run.worktree!)
    return head(run.worktree!)
  }

  it('keeps a run branch the user committed on, after a merge of the tested commit', async () => {
    const { harness, run } = await readyRun()
    const tested = sh(['rev-parse', run.branch!], harness.repo).trim()
    const theirs = commitOnBranch(run)
    const result = await harness.engine.merge(run.id)
    // Only the tested commit went home; the user's commit is theirs and so is the branch it is on.
    expect(head(harness.repo)).toBe(tested)
    expect(existsSync(join(harness.repo, 'USERS.txt'))).toBe(false)
    expect(sh(['rev-parse', run.branch!], harness.repo).trim()).toBe(theirs)
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(existsSync(run.worktree!)).toBe(false)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(result.summary).toContain("Moved its worktree to Regatta's trash")
  }, 90000)

  it('keeps a run branch the user committed on, after a discard', async () => {
    const { harness, run } = await readyRun()
    const theirs = commitOnBranch(run)
    await harness.engine.discard(run.id)
    expect(sh(['rev-parse', run.branch!], harness.repo).trim()).toBe(theirs)
    expect(sh(['log', '-1', '--format=%s', run.branch!], harness.repo).trim()).toBe('my own commit on the run branch')
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(existsSync(run.worktree!)).toBe(false)
    expect(runOf(harness).note).toContain("Moved its worktree to Regatta's trash")
  }, 90000)

  it('parks the tested commit before it retires a discarded run, so even a commit of the user inside it survives emptyTrash and garbage collection', async () => {
    // The user commits in the run worktree while the agent is still working; Regatta's own commit comes on top of it.
    const withUsersCommit = (cwd: string): void => {
      writeFileSync(join(cwd, 'USERS.txt'), "the user's own work\n")
      execFileSync('git', ['add', 'USERS.txt'], { cwd })
      execFileSync('git', ['-c', 'user.name=The User', '-c', 'user.email=user@example.com', 'commit', '-q', '-m', 'the user commits in the run worktree'], { cwd })
      finished(cwd)
    }
    const { harness, run } = await readyRun({ claude: { delayMs: 60, write: withUsersCommit } })
    const mine = sh(['log', '--format=%H', '--author=The User', run.branch!], harness.repo).trim()
    expect(mine).toMatch(/^[0-9a-f]{40}$/)
    // The tested commit has the user's commit inside it, and only the run's branch reaches either.
    expect(run.tip).not.toBe(mine)
    sh(['merge-base', '--is-ancestor', mine, run.tip!], harness.repo)
    expect(sh(['for-each-ref', '--contains', mine, '--format=%(refname)'], harness.repo).trim()).toBe(`refs/heads/${run.branch}`)

    await harness.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    // The branch is gone, and with it its reflog; a copy of the tested commit was parked first, and the run and the night say where.
    const parked = branchKeepRef(harness, run)
    expect(sh(['rev-parse', `${parked}^1`], harness.repo).trim()).toBe(run.tip)
    const sentence = `Kept a copy of the run's work at ${parked} (restore the work with git branch night-${run.id}-restored ${parked}^1; git log ${parked} shows everything kept).`
    expect(runOf(harness).note).toContain(sentence)
    expect(harness.engine.state().nights[0]?.notes).toContain(sentence)

    // Everything git forgets by itself is forgotten now. The user's commit is still there, reachable from the parked ref.
    sh(['reflog', 'expire', '--expire=now', '--all'], harness.repo)
    sh(['gc', '--prune=now', '-q'], harness.repo)
    expect(sh(['cat-file', '-t', mine], harness.repo).trim()).toBe('commit')
    expect(sh(['for-each-ref', '--contains', mine, '--format=%(refname)'], harness.repo).trim().split('\n')).toContain(parked)
    // The command in the note, run as it stands, brings the work back: the tip is the first parent of the keep commit.
    sh(restoreCommand(runOf(harness).note), harness.repo)
    expect(sh(['show', `night-${run.id}-restored:USERS.txt`], harness.repo)).toBe("the user's own work\n")
    expect(sh(['show', `night-${run.id}-restored:DONE.txt`], harness.repo)).toBe('done\n')
  }, 90000)

  it('names the branch that restores the work with a name nobody has used, and the command works as written', async () => {
    const { harness, run } = await readyRun()
    // The plain name and the next one are taken, by branches of the user's.
    sh(['branch', `night-${run.id}-restored`], harness.repo)
    sh(['branch', `night-${run.id}-restored-2`], harness.repo)
    await harness.engine.discard(run.id)
    const parked = branchKeepRef(harness, run)
    expect(runOf(harness).note).toContain(`(restore the work with git branch night-${run.id}-restored-3 ${parked}^1; git log ${parked} shows everything kept)`)
    // A name with letters, digits and dashes only: it is safe to paste into a shell.
    const command = restoreCommand(runOf(harness).note)
    expect(command).toEqual(['branch', `night-${run.id}-restored-3`, `${parked}^1`])
    sh(command, harness.repo)
    expect(sh(['show', `night-${run.id}-restored-3:DONE.txt`], harness.repo)).toBe('done\n')
    // The user's own branches were not touched.
    expect(sh(['rev-parse', `night-${run.id}-restored`], harness.repo).trim()).toBe(head(harness.repo))
  }, 90000)

  it('keeps the folder and the branch, and says why, when no copy of the commits can be made, and finishes the job on the next discard', async () => {
    const { harness, run } = await readyRun()
    // A ref named refs/regatta blocks every ref below it, so there is nowhere to keep a copy.
    sh(['update-ref', 'refs/regatta', head(harness.repo)], harness.repo)
    await harness.engine.discard(run.id)
    expect(runOf(harness).status).toBe('discarded')
    // Nothing is retired without its keep commit: not the folder, not the branch.
    expect(existsSync(run.worktree!)).toBe(true)
    expect(branches(harness.repo)).toEqual([run.branch])
    expect(runOf(harness).note).toContain('a copy of its commits could not be made')
    expect(runOf(harness).note).not.toContain('Kept a copy')

    // The run is still the one to deal with it: once the block is gone, the same call finishes the job.
    sh(['update-ref', '-d', 'refs/regatta'], harness.repo)
    await harness.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    expect(sh(['rev-parse', `${branchKeepRef(harness, run)}^1`], harness.repo).trim()).toBe(run.tip)
    expect(runOf(harness).note).not.toContain('could not be made')
    await expect(harness.engine.discard(run.id)).rejects.toThrow('That run has already been merged or discarded.')
  }, 90000)

  it('keeps a branch it was not able to retire as the run\'s own, so a restart does not lose track of it either', async () => {
    const { harness, run } = await readyRun()
    sh(['update-ref', 'refs/regatta', head(harness.repo)], harness.repo)
    await harness.engine.discard(run.id)
    expect(branches(harness.repo)).toEqual([run.branch])
    sh(['update-ref', '-d', 'refs/regatta'], harness.repo)
    // A new engine on the same data folder finds the run still on its list and finishes the job.
    const next = new NightWatch(harness.deps)
    await next.discard(run.id)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
    expect(next.state().nights[0]?.notes).toEqual([expect.stringContaining("Moved its worktree to Regatta's trash"), copyNote(run)])
  }, 90000)

  it('moves a run that never committed to the trash, and emptyTrash deletes its branch at the commit it started from', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['noChange']!, codex: SCENARIOS['good']! })
    await runNight(harness, [task('does nothing')])
    const run = runOf(harness)
    expect(run.status).toBe('failed')
    expect(run.note).toBe('changed nothing')
    await harness.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([])
  }, 90000)
})

describe('checks run away from the run worktree', () => {
  it('a check that writes a file never touches the run worktree, and no temporary worktree is left', async () => {
    const checks: CheckSpec[] = [
      { name: 'done', command: 'echo output > coverage.txt; test -f DONE.txt', kind: 'required' },
      { name: 'guard', command: 'test -f GUARD.txt', kind: 'guard' }
    ]
    const { harness, nightId, run } = await readyRun({}, {}, checks)
    expect(existsSync(join(run.worktree!, 'coverage.txt'))).toBe(false)
    expect(sh(['status', '--porcelain', '--ignored'], run.worktree!).trim()).toBe('')
    // The baseline and the folder checks ran in are gone; only the run worktree is left.
    expect(readdirSync(harness.worktrees)).toEqual([`night-${nightId}-claude`])
    expect(sh(['worktree', 'list'], harness.repo).trim().split('\n')).toHaveLength(2)
    // And a merge moves the run worktree to the trash.
    expect((await harness.engine.merge(run.id)).summary).toContain('Removed 1 worktree and 0 branches.')
    expect(existsSync(run.worktree!)).toBe(false)
  }, 90000)

  it('a check that edits a tracked file fails the checks gate, and the run worktree stays as committed', async () => {
    const checks: CheckSpec[] = [{ name: 'done', command: "echo '// edited by the check' >> src/app.js; test -f DONE.txt", kind: 'required' }]
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! })
    await runNight(harness, [task('good task', 'claude', checks)])
    const run = runOf(harness)
    expect(run.status).toBe('failed')
    expect(run.gates.find((g) => g.id === 'checks')).toMatchObject({ passed: false, detail: expect.stringContaining('a check changed tracked files') })
    expect(run.note).toContain('a check changed tracked files')
    expect(readFileSync(join(run.worktree!, 'src', 'app.js'), 'utf8')).not.toContain('edited by the check')
    expect(sh(['status', '--porcelain'], run.worktree!).trim()).toBe('')
  }, 90000)

  it('a check that commits on its own fails the checks gate', async () => {
    const checks: CheckSpec[] = [{ name: 'done', command: 'git -c user.name=x -c user.email=x@y commit -q --allow-empty -m sneaky; test -f DONE.txt', kind: 'required' }]
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! })
    await runNight(harness, [task('good task', 'claude', checks)])
    const run = runOf(harness)
    expect(run.status).toBe('failed')
    expect(run.note).toContain('a check changed tracked files')
    expect(sh(['log', '--format=%s', run.branch!], harness.repo)).not.toContain('sneaky')
  }, 90000)
})

describe('what the user writes into a run worktree while its checks run', () => {
  it('moves intact into the trash when the run is merged', async () => {
    // A check that behaves like the user: it drops a file into the run worktree whose result it is judging.
    const checks: CheckSpec[] = [{ name: 'done', command: 'if [ -f DONE.txt ]; then echo mine > "${PWD%-check}/USERS.txt"; fi; test -f DONE.txt', kind: 'required' }]
    const { harness, run } = await readyRun({}, {}, checks)
    expect(readFileSync(join(run.worktree!, 'USERS.txt'), 'utf8')).toBe('mine\n')
    const result = await harness.engine.merge(run.id)
    expect(result.summary).toContain("Moved its worktree to Regatta's trash")
    expect(existsSync(run.worktree!)).toBe(false)
    const trashed = await listTrash(harness.worktrees)
    expect(trashed).toHaveLength(1)
    expect(readFileSync(join(trashed[0]!.trashPath, 'USERS.txt'), 'utf8')).toBe('mine\n')
    expect(branches(harness.repo)).toEqual([run.branch])
  }, 90000)
})

describe('an agent that leaves programs the stop cannot end', () => {
  it('holds its folder and branch for good: neither a merge of another run nor a discard removes them', async () => {
    // It changed nothing, so its folder would be pristine and removable: only the hold keeps it.
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, stuck: true }, codex: SCENARIOS['good']! })
    await runNight(harness, [task('leaves a mess'), task('clean one', 'codex')])
    const stuck = runOf(harness, 0)
    const fine = runOf(harness, 1)
    expect(stuck.status).toBe('failed')
    expect(stuck.note).toContain('could not be stopped')
    expect(stuck.note).toContain(stuck.worktree!)
    expect(fine.status).toBe('ready')

    const result = await harness.engine.merge(fine.id)
    expect(result.summary).toContain('Removed 1 worktree and 0 branches.')
    expect(existsSync(stuck.worktree!)).toBe(true)
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(branches(harness.repo)).toEqual([stuck.branch])

    // Discarding does not change its mind, however often it is asked: whatever could still be using the folder is not under it.
    for (let attempt = 0; attempt < 2; attempt++) {
      await harness.engine.discard(stuck.id)
      expect(existsSync(stuck.worktree!)).toBe(true)
      expect(branches(harness.repo)).toEqual([stuck.branch])
      expect(runOf(harness, 0).status).toBe('discarded')
      expect(runOf(harness, 0).note).toContain('Kept:')
    }
    expect(sh(['worktree', 'list'], harness.repo)).toContain(stuck.worktree!)
  }, 90000)
})

describe('the folders the night is busy with', () => {
  it('lists the baseline, the run worktree and the check worktree while they exist, and only what it still owns afterwards', async () => {
    // Checks that take a moment, so each folder can be seen while it exists.
    const slow: CheckSpec[] = [{ name: 'slow', command: 'sleep 2; test -f DONE.txt', kind: 'required' }]
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! })
    expect(harness.engine.busyPaths()).toEqual([])
    harness.engine.addTask(task('good task', 'claude', slow))
    const id = (await harness.engine.schedule('now')).nights[0]!.id
    const base = join(harness.worktrees, `night-${id}-base`)
    const wt = join(harness.worktrees, `night-${id}-claude`)

    // The baseline is made first, and is the night's while its checks run.
    await waitFor('the baseline to be listed', () => harness.engine.busyPaths().includes(base))
    expect(existsSync(base)).toBe(true)
    expect(harness.engine.busyPaths()).toEqual([base])
    // Then the run's own folder, and next to it the one its checks run in.
    await waitFor('the check worktree to be listed', () => harness.engine.busyPaths().includes(`${wt}-check`))
    expect(existsSync(`${wt}-check`)).toBe(true)
    expect([...harness.engine.busyPaths()].sort()).toEqual([wt, `${wt}-check`].sort())

    // When it is over, the baseline and the check folder are gone from the disk and from the list. The run's folder is what is left.
    await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
    expect(harness.engine.busyPaths()).toEqual([wt])
    expect(readdirSync(harness.worktrees)).toEqual([`night-${id}-claude`])
    // Merged, the run's folder is moved to the trash, and nothing is left busy.
    await harness.engine.merge(runOf(harness).id)
    expect(harness.engine.busyPaths()).toEqual([])
  }, 90000)

  it('keeps listing a folder it holds or keeps for as long as it does', async () => {
    // A stuck agent that changed nothing: its folder is held for good, though it holds nothing and could otherwise go.
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, stuck: true }, codex: SCENARIOS['good']! })
    await runNight(harness, [task('leaves a mess'), task('clean one', 'codex')])
    const stuck = runOf(harness, 0)
    const fine = runOf(harness, 1)
    expect([...harness.engine.busyPaths()].sort()).toEqual([stuck.worktree!, fine.worktree!].sort())
    await harness.engine.merge(fine.id)
    expect(harness.engine.busyPaths()).toEqual([stuck.worktree])
    await harness.engine.discard(stuck.id)
    expect(existsSync(stuck.worktree!)).toBe(true)
    expect(harness.engine.busyPaths()).toEqual([stuck.worktree])
  }, 90000)

  it('lists a worktree it kept because it could not be moved to the trash, until a later discard moves it', async () => {
    const { harness, run } = await readyRun()
    sh(['update-ref', 'refs/regatta', head(harness.repo)], harness.repo)
    await harness.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(true)
    expect(harness.engine.busyPaths()).toEqual([run.worktree])
    sh(['update-ref', '-d', 'refs/regatta'], harness.repo)
    await harness.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    expect(harness.engine.busyPaths()).toEqual([])
  }, 90000)

  it('lists the folders of every night, not only the latest', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    await runNight(harness, [task('first night')])
    await runNight(harness, [task('second night', 'codex')])
    const [latest, earlier] = harness.engine.state().nights
    expect([...harness.engine.busyPaths()].sort()).toEqual([earlier!.runs[0]!.worktree!, latest!.runs[0]!.worktree!].sort())
  }, 90000)
})

describe('the night as a whole', () => {
  it('a cancelled night stays cancelled while it winds down, and lets the computer sleep', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['slow']!, codex: SCENARIOS['slow']! })
    harness.engine.addTask(task('slow one'))
    harness.engine.addTask(task('slow two', 'codex'))
    await harness.engine.schedule('now')
    await waitFor('the first agent to start', () => harness.runs.length === 1)
    harness.engine.cancel()

    // A discard of the stopped run waits for the night to finish stopping what it started.
    await harness.engine.discard(runOf(harness, 0).id)
    const night = harness.engine.state().nights[0]!
    expect(night.status).toBe('cancelled')
    expect(night.finishedAt).not.toBeNull()
    expect(runOf(harness, 0).status).toBe('discarded')
    // The second task never started, and is stopped like the first: nothing is left waiting in a night that is over.
    expect(runOf(harness, 1).status).toBe('stopped')
    expect(runOf(harness, 1).note).toBe('Cancelled')
    await harness.engine.discard(runOf(harness, 1).id)
    expect(runOf(harness, 1).status).toBe('discarded')
    expect(harness.runs).toHaveLength(1)
    expect(harness.awake.filter((on) => on)).toHaveLength(1)
    expect(harness.awake[harness.awake.length - 1]).toBe(false)
    expect(harness.engine.state().keepingAwake).toBe(false)
    expect(harness.emitted[harness.emitted.length - 1]?.nights[0]?.status).toBe('cancelled')
    // The stopped agent's worktree moved to the trash, and emptying the trash removes it and its branch.
    expect(readdirSync(harness.worktrees)).toEqual(['.regatta-trash'])
    expect((await emptyTrash(harness.worktrees)).outcomes.filter((o) => o.status === 'deleted')).toHaveLength(1)
    expect(readdirSync(join(harness.worktrees, '.regatta-trash'))).toEqual([])
    expect(branches(harness.repo)).toEqual([])
  }, 90000)

  it('refuses to discard a run that has not finished', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['slow']!, codex: SCENARIOS['slow']! })
    harness.engine.addTask(task('slow one'))
    harness.engine.addTask(task('slow two', 'codex'))
    await harness.engine.schedule('now')
    await waitFor('the first agent to start', () => harness.runs.length === 1)
    await expect(harness.engine.discard(runOf(harness, 0).id)).rejects.toThrow('has not finished')
    await expect(harness.engine.discard(runOf(harness, 1).id)).rejects.toThrow('has not finished')
    await expect(harness.engine.merge(runOf(harness, 0).id)).rejects.toThrow('This night has not finished yet.')
    expect(existsSync(runOf(harness, 0).worktree!)).toBe(true)
    harness.engine.cancel()
    await harness.engine.discard(runOf(harness, 0).id)
  }, 90000)

  it('has nothing to discard in a night that has not started, or one that was cancelled before it did', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    harness.engine.addTask(task('later'))
    const runId = (await harness.engine.schedule(Date.now() + 60000)).nights[0]!.runs[0]!.id
    await expect(harness.engine.discard(runId)).rejects.toThrow('That night has not started yet. Cancel the night instead.')
    await expect(harness.engine.merge(runId)).rejects.toThrow('This night has not finished yet.')
    harness.engine.cancel()
    expect(harness.engine.state().nights[0]?.status).toBe('cancelled')
    await expect(harness.engine.discard(runId)).rejects.toThrow('That run never started, so there is nothing to discard.')
    await expect(harness.engine.merge(runId)).rejects.toThrow('Only a ready run can be merged.')
    expect(harness.runs).toHaveLength(0)
    expect(readdirSync(harness.worktrees)).toEqual([])
  }, 60000)

  it('makes its worktrees in the Regatta folder and never inside the project', async () => {
    const folder = temp('regatta-night-default-')
    const saved = process.env['REGATTA_WORKTREES_DIR']
    process.env['REGATTA_WORKTREES_DIR'] = folder
    try {
      const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['noChange']! }, { patch: { worktreesDir: undefined } })
      await runNight(harness, [task('good task')])
      const run = runOf(harness)
      expect(run.status).toBe('ready')
      expect(run.worktree!.startsWith(folder)).toBe(true)
      expect(readdirSync(harness.repo).filter((name) => name.startsWith('night-'))).toEqual([])
      expect(sh(['status', '--porcelain'], harness.repo).trim()).toBe('')
    } finally {
      if (saved === undefined) delete process.env['REGATTA_WORKTREES_DIR']
      else process.env['REGATTA_WORKTREES_DIR'] = saved
    }
  }, 90000)

  it('makes one night when it is asked for twice at the same moment', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    harness.engine.addTask(task('good task'))
    const results = await Promise.allSettled([harness.engine.schedule('now'), harness.engine.schedule('now')])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refusal = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(refusal.reason)).toContain('A night is already scheduled or running.')
    expect(harness.engine.state().nights).toHaveLength(1)
    await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished')
    expect(harness.runs).toHaveLength(1)
  }, 90000)

  it('judges every task against the baseline of its own checks', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: { delayMs: 60, write: (cwd) => { finished(cwd); unlinkSync(join(cwd, 'OTHER.txt')) } } }, {
      prepare: (repo) => writeFileSync(join(repo, 'OTHER.txt'), 'other\n')
    })
    const other: CheckSpec[] = [
      { name: 'done', command: 'test -f DONE.txt', kind: 'required' },
      { name: 'other', command: 'test -f OTHER.txt', kind: 'guard' }
    ]
    await runNight(harness, [task('first task'), task('second task', 'codex', other)])
    expect(runOf(harness, 0).status).toBe('ready')
    // The second task has a guard the first one does not, and it passed on untouched code, so breaking it counts.
    expect(runOf(harness, 1).status).toBe('failed')
    expect(runOf(harness, 1).note).toBe('broke: other')
  }, 90000)

  it('does not let an agent that was killed by a signal count as finished', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: finished, exitCode: null }, codex: SCENARIOS['noChange']! })
    await runNight(harness, [task('crashes')])
    const run = runOf(harness)
    expect(run.status).toBe('failed')
    expect(run.gates.find((g) => g.id === 'finished')).toMatchObject({ passed: false, detail: 'exited with code none' })
  }, 90000)

  it('stops an agent that runs out of time and says so', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['slow']!, codex: SCENARIOS['noChange']! }, { patch: { runLimitMs: 300 } })
    await runNight(harness, [task('takes too long')])
    const run = runOf(harness)
    expect(run.status).toBe('failed')
    expect(run.exitCode).toBeNull()
    expect(run.gates[0]).toEqual({ id: 'finished', passed: false, detail: 'ran out of time' })
    expect(run.note).toBe('ran out of time')
  }, 90000)

  it('fails a run whose agent moved the worktree off its branch, and preserves the agent\'s work in the trash', async () => {
    const leaves = (cwd: string): void => {
      finished(cwd)
      execFileSync('git', ['checkout', '-q', '--detach'], { cwd })
    }
    const harness = makeHarness(['claude', 'codex'], { claude: { delayMs: 60, write: leaves }, codex: SCENARIOS['noChange']! })
    await runNight(harness, [task('wanders off')])
    const run = runOf(harness)
    expect(run.status).toBe('failed')
    expect(run.note).toBe('The run left its branch, so its result cannot be scored.')
    await harness.engine.discard(run.id)
    expect(existsSync(run.worktree!)).toBe(false)
    const trashed = await listTrash(harness.worktrees)
    expect(trashed).toHaveLength(1)
    expect(readFileSync(join(trashed[0]!.trashPath, 'DONE.txt'), 'utf8')).toBe('done\n')
    expect(branches(harness.repo)).toEqual([run.branch])
  }, 90000)

  it('fails a run whose branch or folder is already taken, and never deletes what it did not make', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['good']!, codex: SCENARIOS['good']! })
    harness.engine.addTask(task('first task'))
    harness.engine.addTask(task('second task', 'codex'))
    const id = (await harness.engine.schedule(Date.now() + 1500)).nights[0]!.id
    // Someone makes a branch with the first run's name and a folder with the second run's name before the night starts.
    sh(['branch', `regatta/night-${id}-claude`], harness.repo)
    mkdirSync(join(harness.worktrees, `night-${id}-codex`))
    await waitFor('the night to finish', () => harness.engine.state().nights[0]?.status === 'finished', 90000)
    const [first, second] = harness.engine.state().nights[0]!.runs
    // The folder that was already there is not the night's, so it is not on the list of what the night is busy with.
    expect(harness.engine.busyPaths()).toEqual([])
    expect(first!.status).toBe('failed')
    expect(first!.note).toContain('already exists, so it was left alone')
    expect(first!.worktree).toBeNull()
    expect(second!.status).toBe('failed')
    expect(second!.note).toContain('is already there, so it was left alone')

    await harness.engine.discard(first!.id)
    await harness.engine.discard(second!.id)
    expect(sh(['branch', '--list', `regatta/night-${id}-claude`], harness.repo).trim()).not.toBe('')
    expect(readdirSync(harness.worktrees)).toEqual([`night-${id}-codex`])
  }, 120000)

  it('has its state on disk while it runs, so a quit in the middle loads as a cancelled night', async () => {
    const harness = makeHarness(['claude', 'codex'], { claude: SCENARIOS['slow']!, codex: SCENARIOS['slow']! })
    harness.engine.addTask(task('slow one'))
    harness.engine.addTask(task('slow two', 'codex'))
    await harness.engine.schedule('now')
    const file = join(harness.dataDir, 'nightwatch.json')
    await waitFor('the state on disk to show the run with its worktree', () => {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as NightState
      return saved.nights[0]?.status === 'running' && saved.nights[0]?.runs[0]?.status === 'running' && Boolean(saved.nights[0]?.runs[0]?.worktree)
    })
    // The app quits here. The next one starts from what was saved.
    const next = new NightWatch({ ...harness.deps, run: () => { throw new Error('not used') }, emit: () => undefined, keepAwake: () => undefined })
    const night = next.state().nights[0]!
    expect(night.status).toBe('cancelled')
    expect(night.runs[0]?.status).toBe('stopped')
    expect(night.runs[0]?.note).toBe('Cancelled on app quit')
    // The task that had not started is stopped too: nothing is left waiting in a night that is over.
    expect(night.runs[1]?.status).toBe('stopped')
    expect(night.runs[1]?.note).toBe('Cancelled on app quit')
    expect(night.runs[0]?.worktree).toContain('night-')
    expect(night.finishedAt).not.toBeNull()
    harness.engine.cancel()
    await harness.engine.discard(runOf(harness).id)
  }, 90000)
})
