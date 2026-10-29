// Safety tests for checkpoints: each one reproduces a defect an outside reviewer verified with real folders, real git and real files.
// Finding numbers match the review (1 to 15); finding 16 (hooks as step boundaries) is tested in sessions.steps.test.ts.

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { CheckpointStep } from '../shared/checkpoints'
import { Checkpoints, type CheckpointsDeps } from './checkpoints'

vi.setConfig({ testTimeout: 60_000 })

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env })
}

const cleanup: string[] = []

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of cleanup) {
    try {
      chmodSync(join(dir, 'sub'), 0o755)
    } catch {
      // not every folder has one
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A workspace folder with the given files (a plain folder, not a git repository). */
function workspace(files: Record<string, string | Buffer> = { 'a.txt': 'a original\n', 'c.txt': 'c original\n' }): string {
  const dir = temp('regatta-ws-')
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

function make(extra: Partial<CheckpointsDeps> = {}, base = temp('regatta-base-')) {
  const logs: string[] = []
  const changed: string[] = []
  const c = new Checkpoints({
    baseDir: () => base,
    emitChanged: (id) => changed.push(id),
    log: (msg) => logs.push(msg),
    retryDelayMs: 1,
    ...extra
  })
  return { c, base, logs, changed }
}

async function turn(c: Checkpoints, sessionId: string, cwd: string, label: string, mutate: () => void | Promise<void>): Promise<CheckpointStep> {
  await c.stepStart(sessionId, 'fake', cwd, label)
  await mutate()
  await c.stepEnd(sessionId)
  const step = c.list(sessionId).find((s) => s.label === label)
  if (!step) throw new Error(`no step recorded for ${label}`)
  return step
}

function shadowDirOf(base: string): string {
  const dirs = readdirSync(base).filter((name) => statSync(join(base, name)).isDirectory())
  if (dirs.length !== 1) throw new Error(`expected one shadow folder, found ${dirs.length}`)
  return join(base, dirs[0]!)
}

function shadowGit(base: string, args: string[]): string {
  const dir = shadowDirOf(base)
  return git(args, dir, { ...process.env, GIT_DIR: join(dir, 'git') })
}

/** Runs `fn` with a fake `git` first on PATH. `script` receives the path of the real git. */
async function withFakeGit(script: (realGit: string) => string, fn: () => Promise<void>): Promise<void> {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const dir = temp('regatta-fakegit-')
  writeFileSync(join(dir, 'git'), script(realGit), { mode: 0o755 })
  const oldPath = process.env['PATH']
  process.env['PATH'] = `${dir}:${oldPath}`
  try {
    await fn()
  } finally {
    process.env['PATH'] = oldPath
  }
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('finding 1: absence is proven, directories and nested repositories are never deleted', () => {
  it('keeps an embedded git repository and the human work inside it', async () => {
    const cwd = workspace()
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'create nested repo', () => {
      mkdirSync(join(cwd, 'emb'))
      git(['init', '-q'], join(cwd, 'emb'))
      writeFileSync(join(cwd, 'emb', 'code.txt'), 'agent\n')
      git(['add', '.'], join(cwd, 'emb'))
      git([...IDENTITY, 'commit', '-q', '-m', 'nested'], join(cwd, 'emb'))
    })
    expect(step.files.map((f) => f.path)).toContain('emb')
    writeFileSync(join(cwd, 'emb', 'human.txt'), 'untracked human work\n')

    const res = await c.rollback(step.id)

    expect(existsSync(join(cwd, 'emb', 'human.txt'))).toBe(true)
    expect(existsSync(join(cwd, 'emb', '.git'))).toBe(true)
    expect(readFileSync(join(cwd, 'emb', 'code.txt'), 'utf8')).toBe('agent\n')
    const emb = res.files.find((f) => f.path === 'emb')
    expect(emb?.action).toBe('kept')
  })

  it('keeps a directory that now sits where a file used to be', async () => {
    const cwd = workspace({ 'a.txt': 'a original\n', 'gone.txt': 'will be deleted\n' })
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'delete gone.txt', () => unlinkSync(join(cwd, 'gone.txt')))
    mkdirSync(join(cwd, 'gone.txt'))
    writeFileSync(join(cwd, 'gone.txt', 'precious.txt'), 'human\n')

    await c.rollback(step.id)

    expect(readFileSync(join(cwd, 'gone.txt', 'precious.txt'), 'utf8')).toBe('human\n')
  })

  it('keeps an ignored file that was already there when a step removed its ignore rule (sol-loop S2)', async () => {
    const cwd = workspace({ '.gitignore': 'secret.env\n', 'secret.env': 'the only copy\n' })
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'drop the ignore rule', () => {
      writeFileSync(join(cwd, '.gitignore'), '')
      writeFileSync(join(cwd, 'made.txt'), 'agent\n')
    })
    expect(step.files.map((f) => f.path)).toContain('secret.env')

    const res = await c.rollback(step.id)

    expect(readFileSync(join(cwd, 'secret.env'), 'utf8')).toBe('the only copy\n')
    expect(res.files.find((f) => f.path === 'secret.env')?.action).toBe('kept')
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toBe('secret.env\n')
    expect(existsSync(join(cwd, 'made.txt'))).toBe(false)
  })
})

describe('finding 2: restore never follows symlinks out of the folder', () => {
  it('does not write through a parent folder that became a symlink (roll back)', async () => {
    const cwd = workspace({ 'dir/f.txt': 'orig\n' })
    const ext = temp('regatta-ext-')
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit dir/f.txt', () => writeFileSync(join(cwd, 'dir', 'f.txt'), 'agent\n'))
    writeFileSync(join(ext, 'f.txt'), 'agent\n')
    renameSync(join(cwd, 'dir'), join(cwd, 'dir-moved'))
    symlinkSync(ext, join(cwd, 'dir'))

    const res = await c.rollback(step.id)

    expect(readFileSync(join(ext, 'f.txt'), 'utf8')).toBe('agent\n')
    expect(res.files.find((f) => f.path === 'dir/f.txt')?.action).toBe('kept')
  })

  it('does not create a file through a dangling leaf symlink (roll back)', async () => {
    const cwd = workspace({ 'f.txt': 'orig\n', 'keep.txt': 'x\n' })
    const ext = temp('regatta-ext-')
    const outside = join(ext, 'created.txt')
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'delete f.txt', () => unlinkSync(join(cwd, 'f.txt')))
    symlinkSync(outside, join(cwd, 'f.txt'))

    await c.rollback(step.id)

    expect(existsSync(outside)).toBe(false)
    expect(lstatSync(join(cwd, 'f.txt')).isSymbolicLink()).toBe(true)
  })

  it('does not create a file through a dangling leaf symlink (redo)', async () => {
    const cwd = workspace({ 'keep.txt': 'x\n' })
    const ext = temp('regatta-ext-')
    const outside = join(ext, 'redo.txt')
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'create n.txt', () => writeFileSync(join(cwd, 'n.txt'), 'agent\n'))
    await c.rollback(step.id)
    expect(existsSync(join(cwd, 'n.txt'))).toBe(false)
    symlinkSync(outside, join(cwd, 'n.txt'))

    await c.redo(step.id)

    expect(existsSync(outside)).toBe(false)
  })
})

describe('finding 3: git lookup failures never become deletions', () => {
  it('restores a 33 MiB original instead of deleting the file', async () => {
    const big = Buffer.alloc(33 * 1024 * 1024, 'abcdefghij\n')
    const cwd = workspace({ 'big.dat': big, 'x.txt': 'x\n' })
    const { c } = make({ maxFileBytes: 64 * 1024 * 1024 })
    const step = await turn(c, 's1', cwd, 'shrink big.dat', () => writeFileSync(join(cwd, 'big.dat'), 'small\n'))

    const res = await c.rollback(step.id)

    expect(existsSync(join(cwd, 'big.dat'))).toBe(true)
    expect(readFileSync(join(cwd, 'big.dat')).equals(big)).toBe(true)
    expect(res.verified).toBe(true)
  })

  it('changes nothing when the historical blob is missing (roll back)', async () => {
    const cwd = workspace()
    const { c, base } = make()
    const step = await turn(c, 's1', cwd, 'edit a', () => writeFileSync(join(cwd, 'a.txt'), 'a edited\n'))
    const startBlob = execFileSync('git', ['hash-object', '--stdin'], { input: 'a original\n', encoding: 'utf8' }).trim()
    rmSync(join(shadowDirOf(base), 'git', 'objects', startBlob.slice(0, 2), startBlob.slice(2)), { force: true })

    const res = await c.rollback(step.id)

    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a edited\n')
    expect(res.verified).toBe(false)
    expect(c.list('s1')[0]?.rolledBack).toBe(false)
  })

  it('changes nothing when the historical blob is missing (redo)', async () => {
    const cwd = workspace()
    const { c, base } = make()
    const step = await turn(c, 's1', cwd, 'edit a', () => writeFileSync(join(cwd, 'a.txt'), 'a edited\n'))
    await c.rollback(step.id)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
    const endBlob = execFileSync('git', ['hash-object', '--stdin'], { input: 'a edited\n', encoding: 'utf8' }).trim()
    rmSync(join(shadowDirOf(base), 'git', 'objects', endBlob.slice(0, 2), endBlob.slice(2)), { force: true })

    const res = await c.redo(step.id)

    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
    expect(res.verified).toBe(false)
  })

  it('gives up on a hung git instead of waiting forever', async () => {
    const cwd = workspace()
    const { c } = make({ gitTimeoutMs: 400 })
    await withFakeGit(
      () => '#!/bin/sh\nsleep 30\n',
      async () => {
        const started = Date.now()
        await expect(c.stepStart('s1', 'fake', cwd, 'hang')).rejects.toThrow(/timed out/i)
        expect(Date.now() - started).toBeLessThan(10_000)
      }
    )
  })
})

describe('finding 4: the checkpoint storage is never part of a snapshot', () => {
  it('refuses to checkpoint a workspace that contains the storage folder', async () => {
    const cwd = workspace()
    const store = join(cwd, '.regatta-store')
    const { c } = make({}, store)
    await expect(c.stepStart('s1', 'fake', cwd, 'inside')).rejects.toThrow(/checkpoint storage/i)
    // Nothing was written into the storage by a snapshot of itself.
    const entries = existsSync(store) ? readdirSync(store) : []
    for (const e of entries) expect(existsSync(join(store, e, 'git', 'HEAD'))).toBe(false)
  })

  it('refuses a restore path that points into the storage', async () => {
    const parent = temp('regatta-parent-')
    const cwd = join(parent, 'ws')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'a.txt'), 'a original\n')
    const base = join(parent, 'store')
    const { c } = make({}, base)
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a edited\n'))
    // A history written for the parent folder, whose "end" snapshot lists a file inside the storage.
    const dir = shadowDirOf(base)
    const env = { ...process.env, GIT_DIR: join(dir, 'git'), GIT_INDEX_FILE: join(dir, 'fake-index') }
    const blob = git(['hash-object', '-w', '--stdin'], dir, env).trim()
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},store/marker.txt`], { env })
    const tree = git(['write-tree'], dir, env).trim()
    const commit = git([...IDENTITY, 'commit-tree', tree, '-m', 'fake end'], dir, env).trim()
    const empty = git([...IDENTITY, 'commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'fake start'], dir, env).trim()
    writeFileSync(join(base, 'marker.txt'), git(['cat-file', 'blob', blob], dir, env))
    const stepsFile = join(dir, 'steps.json')
    const stored = JSON.parse(readFileSync(stepsFile, 'utf8'))
    stored[0].cwd = parent
    stored[0].rootId = `${statSync(parent).dev}:${statSync(parent).ino}`
    stored[0].start = empty
    stored[0].end = commit
    stored[0].files = [{ path: 'store/marker.txt', added: 1, removed: 0 }]
    writeFileSync(stepsFile, JSON.stringify(stored))
    const marker = readFileSync(join(base, 'marker.txt'))
    const { c: c2 } = make({}, base)

    const res = await c2.rollback(step.id)

    expect(existsSync(join(base, 'marker.txt'))).toBe(true)
    expect(readFileSync(join(base, 'marker.txt')).equals(marker)).toBe(true)
    expect(res.files.every((f) => f.action !== 'rewound')).toBe(true)
  })
})

describe('finding 5: inherited git environment cannot break isolation', () => {
  it('does not touch the project git config when GIT_COMMON_DIR is inherited', async () => {
    const project = temp('regatta-proj-')
    git(['init', '-q', '-b', 'main'], project)
    writeFileSync(join(project, 'a.txt'), 'a original\n')
    git(['add', '.'], project)
    git([...IDENTITY, 'commit', '-q', '-m', 'initial'], project)
    const configBefore = readFileSync(join(project, '.git', 'config'))
    const { c } = make()
    const old = process.env['GIT_COMMON_DIR']
    process.env['GIT_COMMON_DIR'] = join(project, '.git')
    try {
      const step = await turn(c, 's1', project, 'edit', () => writeFileSync(join(project, 'a.txt'), 'a edited\n'))
      const res = await c.rollback(step.id)
      expect(res.verified).toBe(true)
    } finally {
      if (old === undefined) delete process.env['GIT_COMMON_DIR']
      else process.env['GIT_COMMON_DIR'] = old
    }
    expect(readFileSync(join(project, '.git', 'config')).equals(configBefore)).toBe(true)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('a original\n')
  })

  it('ignores inherited global commit signing and hooks', async () => {
    const cwd = workspace()
    const hooks = temp('regatta-hooks-')
    const marker = join(hooks, 'ran')
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction']) {
      writeFileSync(join(hooks, name), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 })
    }
    const cfgDir = temp('regatta-cfg-')
    const cfg = join(cfgDir, 'gitconfig')
    writeFileSync(cfg, `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n[core]\n\thooksPath = ${hooks}\n\tautocrlf = true\n`)
    const { c } = make()
    const old = { g: process.env['GIT_CONFIG_GLOBAL'], h: process.env['HOME'] }
    process.env['GIT_CONFIG_GLOBAL'] = cfg
    process.env['HOME'] = cfgDir
    writeFileSync(join(cfgDir, '.gitconfig'), readFileSync(cfg))
    try {
      const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a edited\n'))
      const res = await c.rollback(step.id)
      expect(res.verified).toBe(true)
    } finally {
      if (old.g === undefined) delete process.env['GIT_CONFIG_GLOBAL']
      else process.env['GIT_CONFIG_GLOBAL'] = old.g
      process.env['HOME'] = old.h
    }
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
  })
})

describe('finding 6: edits made while a roll back runs are never overwritten', () => {
  it('keeps a human edit that lands during the git lookup', async () => {
    const cwd = workspace()
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit a', () => writeFileSync(join(cwd, 'a.txt'), 'a edited by agent\n'))
    const hold = join(temp('regatta-hold-'), 'hold')
    const entered = `${hold}.entered`
    writeFileSync(hold, '')
    await withFakeGit(
      (real) =>
        `#!/bin/sh\nfor a in "$@"; do case "$a" in show|cat-file)\n  if [ -e '${hold}' ]; then touch '${entered}'; while [ -e '${hold}' ]; do sleep 0.05; done; fi;;\nesac; done\nexec '${real}' "$@"\n`,
      async () => {
        const pending = c.rollback(step.id)
        await until(() => existsSync(entered))
        writeFileSync(join(cwd, 'a.txt'), 'a edited by human\n')
        unlinkSync(hold)
        const res = await pending
        expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a edited by human\n')
        expect(res.files.find((f) => f.path === 'a.txt')?.action).toBe('kept')
      }
    )
  })

  it('refuses a roll back while another step is open in the same folder', async () => {
    const cwd = workspace()
    const { c } = make()
    const stepA = await turn(c, 'sess-a', cwd, 'edit a', () => writeFileSync(join(cwd, 'a.txt'), 'a edited\n'))
    await c.stepStart('sess-b', 'fake', cwd, 'b is working')

    const refused = await c.rollback(stepA.id)

    expect(refused.refused).toBeTruthy()
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a edited\n')
    expect(c.list('sess-a')[0]?.rolledBack).toBe(false)

    await c.stepEnd('sess-b')
    const ok = await c.rollback(stepA.id)
    expect(ok.refused).toBeUndefined()
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
  })
})

describe('finding 7: overlapping sessions are marked shared and not rolled back', () => {
  it('refuses to roll back either step', async () => {
    const cwd = workspace()
    const { c } = make()
    await c.stepStart('sess-a', 'fake', cwd, 'step a')
    await c.stepStart('sess-b', 'fake', cwd, 'step b')
    writeFileSync(join(cwd, 'file-a.txt'), 'from a\n')
    writeFileSync(join(cwd, 'file-b.txt'), 'from b\n')
    await c.stepEnd('sess-a')
    await c.stepEnd('sess-b')
    const a = c.list('sess-a')[0]!
    const b = c.list('sess-b')[0]!
    expect(a.shared).toBe(true)
    expect(b.shared).toBe(true)
    expect(a.blockedReason).toBeTruthy()

    const res = await c.rollback(a.id)

    expect(res.refused).toBeTruthy()
    expect(readFileSync(join(cwd, 'file-b.txt'), 'utf8')).toBe('from b\n')
    expect(readFileSync(join(cwd, 'file-a.txt'), 'utf8')).toBe('from a\n')
  })

  it('does not mark steps in separate folders or steps that run one after the other', async () => {
    const one = workspace()
    const two = workspace()
    const { c } = make()
    await c.stepStart('sess-a', 'fake', one, 'a')
    await c.stepStart('sess-b', 'fake', two, 'b')
    writeFileSync(join(one, 'x.txt'), 'x\n')
    writeFileSync(join(two, 'y.txt'), 'y\n')
    await c.stepEnd('sess-a')
    await c.stepEnd('sess-b')
    expect(c.list('sess-a')[0]?.shared).toBeFalsy()
    expect(c.list('sess-b')[0]?.shared).toBeFalsy()

    const first = await turn(c, 'sess-a', one, 'again', () => writeFileSync(join(one, 'x.txt'), 'x2\n'))
    const second = await turn(c, 'sess-b', one, 'after', () => writeFileSync(join(one, 'z.txt'), 'z\n'))
    expect(first.shared).toBeFalsy()
    expect(second.shared).toBeFalsy()
    const res = await c.rollback(second.id)
    expect(res.refused).toBeUndefined()
    expect(existsSync(join(one, 'z.txt'))).toBe(false)
  })
})

describe('finding 9: lifecycle events are not lost', () => {
  it('a stepEnd that arrives during a stepStart still ends the step', async () => {
    const cwd = workspace()
    const { c } = make()
    const start = c.stepStart('s1', 'fake', cwd, 'quick')
    const end = c.stepEnd('s1')
    await Promise.all([start, end])
    writeFileSync(join(cwd, 'a.txt'), 'changed after the step\n')

    await c.stepEnd('s1')

    expect(c.list('s1')).toHaveLength(0)
  })

  it('a failed end stays failed: the next turn starts from its own baseline and never absorbs the gap', async () => {
    const cwd = workspace()
    const { c, base, logs } = make()
    await c.stepStart('s1', 'fake', cwd, 'locked')
    writeFileSync(join(cwd, 'a.txt'), 'a edited by agent\n')
    const lock = join(shadowDirOf(base), 'index.lock')
    writeFileSync(lock, '')

    await expect(c.stepEnd('s1')).rejects.toThrow()
    expect(logs.length).toBeGreaterThan(0)
    const failedRecord = c.list('s1').find((s) => s.failed)
    expect(failedRecord).toBeTruthy()
    expect(failedRecord?.blockedReason).toBeTruthy()

    // The human works while the lock is still there, then it clears.
    writeFileSync(join(cwd, 'c.txt'), 'c edited by human\n')
    unlinkSync(lock)
    await c.stepEnd('s1') // nothing is open any more: a no-op, not a late completion
    expect(c.list('s1').filter((s) => !s.failed)).toHaveLength(0)

    const next = await turn(c, 's1', cwd, 'next turn', () => writeFileSync(join(cwd, 'b.txt'), 'b by agent\n'))
    expect(next.files.map((f) => f.path)).toEqual(['b.txt'])
    const res = await c.rollback(next.id)
    expect(res.refused).toBeUndefined()
    expect(readFileSync(join(cwd, 'c.txt'), 'utf8')).toBe('c edited by human\n')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a edited by agent\n')

    const refused = await c.rollback(failedRecord!.id)
    expect(refused.refused).toBeTruthy()
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a edited by agent\n')
  })

  it('records a failed start as unprotected, keeps the folder registered, and blocks conflicting restores', async () => {
    const cwd = workspace()
    const { c, base, logs } = make()
    await turn(c, 's1', cwd, 'first', () => writeFileSync(join(cwd, 'a.txt'), 'one\n'))
    const lock = join(shadowDirOf(base), 'index.lock')
    writeFileSync(lock, '')

    await expect(c.stepStart('s1', 'fake', cwd, 'second')).rejects.toThrow()

    expect(logs.length).toBeGreaterThan(0)
    const rec = c.list('s1').find((s) => s.label === 'second')
    expect(rec?.unprotected).toBeTruthy()
    expect(rec?.blockedReason).toMatch(/not protected/)
    unlinkSync(lock)

    // The first agent is still running unprotected: another session's work in the folder cannot be rolled back.
    const other = await turn(c, 's2', cwd, 'other', () => writeFileSync(join(cwd, 'b.txt'), 'b\n'))
    expect(other.shared).toBe(true)
    const refused = await c.rollback(other.id)
    expect(refused.refused).toBeTruthy()
    expect(existsSync(join(cwd, 'b.txt'))).toBe(true)

    await c.stepEnd('s1')
    const closed = c.list('s1').find((s) => s.label === 'second')
    expect(closed?.unprotected).toBeTruthy()
    expect((await c.rollback(closed!.id)).refused).toBeTruthy()
  })
})

describe('finding 10: a partial restore leaves a usable state', () => {
  it('records the partial state, lets a retry finish it and redo reverse it', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const cwd = workspace({ 'a.txt': 'a original\n', 'sub/b.txt': 'b original\n' })
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit a, delete b', () => {
      writeFileSync(join(cwd, 'a.txt'), 'a agent\n')
      unlinkSync(join(cwd, 'sub', 'b.txt'))
    })
    chmodSync(join(cwd, 'sub'), 0o555)

    const first = await c.rollback(step.id)

    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
    expect(existsSync(join(cwd, 'sub', 'b.txt'))).toBe(false)
    expect(first.verified).toBe(false)
    expect(first.files.find((f) => f.path === 'a.txt')?.action).toBe('rewound')
    expect(first.files.find((f) => f.path === 'sub/b.txt')?.action).toBe('kept')
    const mid = c.list('s1')[0]!
    expect(mid.rolledBack).toBe(true)
    expect(mid.partial).toBe(true)

    // Redo can reverse what was applied.
    const undone = await c.redo(step.id)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
    expect(undone.files.find((f) => f.path === 'a.txt')?.action).toBe('restored')

    // Roll back again after the folder is writable: the retry completes.
    chmodSync(join(cwd, 'sub'), 0o755)
    const retry = await c.rollback(step.id)
    expect(retry.verified).toBe(true)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
    expect(readFileSync(join(cwd, 'sub', 'b.txt'), 'utf8')).toBe('b original\n')
    expect(c.list('s1')[0]?.partial).toBeFalsy()
  })
})

describe('finding 11: duplicate requests are no-ops', () => {
  it('keeps redo information when a roll back is requested twice', async () => {
    const cwd = workspace()
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit a', () => {
      writeFileSync(join(cwd, 'a.txt'), 'a agent\n')
      writeFileSync(join(cwd, 'new.txt'), 'new agent\n')
    })

    await Promise.all([c.rollback(step.id), c.rollback(step.id)])
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')

    const redo = await c.redo(step.id)
    expect(redo.files.filter((f) => f.action === 'restored')).toHaveLength(2)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
    expect(readFileSync(join(cwd, 'new.txt'), 'utf8')).toBe('new agent\n')

    const again = await Promise.all([c.redo(step.id), c.redo(step.id)])
    expect(again.every((r) => r.files.every((f) => f.action !== 'restored'))).toBe(true)
    expect(again.every((r) => r.refused)).toBe(true)
  })
})

describe('finding 12: history persistence is validated and crash safe', () => {
  it('recovers from a truncated steps.json using the backup and says so', async () => {
    const cwd = workspace()
    const { c, base } = make()
    await turn(c, 's1', cwd, 'one', () => writeFileSync(join(cwd, 'a.txt'), '1\n'))
    await turn(c, 's1', cwd, 'two', () => writeFileSync(join(cwd, 'a.txt'), '2\n'))
    const stepsFile = join(shadowDirOf(base), 'steps.json')
    truncateSync(stepsFile, 20)

    const { c: again, logs } = make({}, base)
    const steps = again.list('s1')

    expect(steps.length).toBeGreaterThanOrEqual(1)
    expect(logs.some((l) => /steps\.json/.test(l))).toBe(true)
  })

  it('reports unreadable history and drops invalid records', async () => {
    const cwd = workspace()
    const { c, base } = make()
    await turn(c, 's1', cwd, 'one', () => writeFileSync(join(cwd, 'a.txt'), '1\n'))
    const stepsFile = join(shadowDirOf(base), 'steps.json')
    const stored = JSON.parse(readFileSync(stepsFile, 'utf8'))
    stored[0].files = [{ path: '../escape.txt', added: 1, removed: 0 }]
    stored.push({ id: 5 })
    writeFileSync(stepsFile, JSON.stringify(stored))

    const { c: again, logs } = make({}, base)

    expect(again.list('s1')).toHaveLength(0)
    expect(logs.length).toBeGreaterThan(0)
  })

  it('writes the history atomically and reports a failed save', async () => {
    const cwd = workspace()
    const { c, base, logs } = make()
    await turn(c, 's1', cwd, 'one', () => writeFileSync(join(cwd, 'a.txt'), '1\n'))
    const dir = shadowDirOf(base)
    expect(readdirSync(dir).some((n) => n.endsWith('.tmp'))).toBe(false)
    rmSync(join(dir, 'steps.json'))
    mkdirSync(join(dir, 'steps.json'))

    await turn(c, 's1', cwd, 'two', () => writeFileSync(join(cwd, 'a.txt'), '2\n'))

    expect(logs.some((l) => /steps\.json|history/i.test(l))).toBe(true)
  })
})

describe('finding 13: retention and size budget', () => {
  it('keeps only the newest steps and lets old snapshots be pruned', async () => {
    const cwd = workspace()
    const { c, base } = make({ maxSteps: 2, gcAfterDrops: 1 })
    const first = await turn(c, 's1', cwd, 't1', () => writeFileSync(join(cwd, 'a.txt'), '1\n'))
    await turn(c, 's1', cwd, 't2', () => writeFileSync(join(cwd, 'a.txt'), '2\n'))
    await turn(c, 's1', cwd, 't3', () => writeFileSync(join(cwd, 'a.txt'), '3\n'))
    await turn(c, 's1', cwd, 't4', () => writeFileSync(join(cwd, 'a.txt'), '4\n'))

    expect(c.list('s1').map((s) => s.label).sort()).toEqual(['t3', 't4'])
    expect(() => shadowGit(base, ['cat-file', '-e', first.start])).toThrow()
    expect(() => shadowGit(base, ['cat-file', '-e', first.end])).toThrow()
    const newest = c.list('s1')[0]!
    expect(() => shadowGit(base, ['cat-file', '-e', newest.start])).not.toThrow()
  })

  it('skips big files and build folders and records the skip', async () => {
    const cwd = workspace()
    const { c } = make({ maxFileBytes: 1024 })
    writeFileSync(join(cwd, 'grow.txt'), 'small\n')
    const step = await turn(c, 's1', cwd, 'big stuff', () => {
      writeFileSync(join(cwd, 'big.bin'), Buffer.alloc(4096, 1))
      writeFileSync(join(cwd, 'grow.txt'), 'g'.repeat(4096))
      writeFileSync(join(cwd, 'small.txt'), 'ok\n')
      mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(cwd, 'node_modules', 'pkg', 'index.js'), 'dep\n')
      mkdirSync(join(cwd, 'dist'))
      writeFileSync(join(cwd, 'dist', 'out.js'), 'built\n')
    })

    const paths = step.files.map((f) => f.path)
    expect(paths).toContain('small.txt')
    expect(paths).not.toContain('big.bin')
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false)
    expect(paths.some((p) => p.startsWith('dist'))).toBe(false)
    expect(step.skipped?.some((s) => s.path === 'big.bin')).toBe(true)
    expect(step.skipped?.some((s) => s.path === 'node_modules/')).toBe(true)

    await c.rollback(step.id)
    // Files Regatta did not snapshot are never touched.
    expect(readFileSync(join(cwd, 'big.bin')).length).toBe(4096)
    expect(readFileSync(join(cwd, 'grow.txt'), 'utf8')).toBe('g'.repeat(4096))
    expect(existsSync(join(cwd, 'small.txt'))).toBe(false)
  })
})

describe('finding 14: raw bytes are stored', () => {
  it('rolls back a CRLF file even when .gitattributes asks for normalization', async () => {
    const cwd = workspace({ '.gitattributes': '*.txt text eol=lf\n', 'crlf.txt': 'a\r\nb\r\n' })
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit crlf', () => writeFileSync(join(cwd, 'crlf.txt'), 'x\r\ny\r\n'))

    const res = await c.rollback(step.id)

    expect(res.files.find((f) => f.path === 'crlf.txt')?.action).toBe('rewound')
    expect(readFileSync(join(cwd, 'crlf.txt')).equals(Buffer.from('a\r\nb\r\n'))).toBe(true)
    expect(res.verified).toBe(true)
  })
})

describe('finding 15: file types and modes are restored', () => {
  it('restores a symlink that the agent replaced with a regular file', async () => {
    const cwd = workspace({ 'target.txt': 'target\n' })
    symlinkSync('target.txt', join(cwd, 'lnk'))
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'replace link', () => {
      unlinkSync(join(cwd, 'lnk'))
      writeFileSync(join(cwd, 'lnk'), 'plain file\n')
    })

    const res = await c.rollback(step.id)

    expect(lstatSync(join(cwd, 'lnk')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(cwd, 'lnk'))).toBe('target.txt')
    expect(res.verified).toBe(true)

    await c.redo(step.id)
    expect(lstatSync(join(cwd, 'lnk')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(cwd, 'lnk'), 'utf8')).toBe('plain file\n')
  })

  it('reverts a changed executable bit and restores a deleted executable', async () => {
    const cwd = workspace({ 'run.sh': '#!/bin/sh\necho hi\n', 'tool.sh': '#!/bin/sh\necho tool\n' })
    chmodSync(join(cwd, 'tool.sh'), 0o755)
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'chmod and delete', () => {
      chmodSync(join(cwd, 'run.sh'), 0o755)
      unlinkSync(join(cwd, 'tool.sh'))
    })
    expect(step.files.map((f) => f.path).sort()).toEqual(['run.sh', 'tool.sh'])

    const res = await c.rollback(step.id)

    expect(statSync(join(cwd, 'run.sh')).mode & 0o111).toBe(0)
    expect(statSync(join(cwd, 'tool.sh')).mode & 0o100).not.toBe(0)
    expect(res.verified).toBe(true)

    await c.redo(step.id)
    expect(statSync(join(cwd, 'run.sh')).mode & 0o100).not.toBe(0)
    expect(existsSync(join(cwd, 'tool.sh'))).toBe(false)
  })
})

describe('behaviour that must keep working', () => {
  it('round-trips odd names, binaries and ignore rules inside a git worktree without touching it', async () => {
    const main = temp('regatta-main-')
    git(['init', '-q', '-b', 'main'], main)
    writeFileSync(join(main, 'seed.txt'), 'seed\n')
    git(['add', '.'], main)
    git([...IDENTITY, 'commit', '-q', '-m', 'seed'], main)
    const cwd = join(temp('regatta-wt-'), 'wt')
    git(['worktree', 'add', '-q', '-b', 'feature', cwd], main)
    writeFileSync(join(cwd, '.gitignore'), 'ignored.log\n')
    const names = ['sp ace.txt', 'tab\there.txt', 'new\nline.txt', 'üñí.txt', 'quo"te.txt', '-dash.txt', 'we*ird[1].txt']
    for (const n of names) writeFileSync(join(cwd, n), `${n} original\n`)
    const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    writeFileSync(join(cwd, 'bin.dat'), bin)
    mkdirSync(join(cwd, 'sub'))
    writeFileSync(join(cwd, 'sub', 'x.txt'), 'x\n')
    symlinkSync('sub', join(cwd, 'linkdir'))
    const pointer = readFileSync(join(cwd, '.git'))
    const headBefore = git(['rev-parse', 'HEAD'], cwd).trim()
    const statusBefore = git(['status', '--porcelain'], cwd)
    const { c } = make()

    const step = await turn(c, 's1', cwd, 'edit everything', () => {
      for (const n of names) writeFileSync(join(cwd, n), `${n} edited\n`)
      writeFileSync(join(cwd, 'bin.dat'), Buffer.from(bin).reverse())
      writeFileSync(join(cwd, 'sub', 'x.txt'), 'x edited\n')
      writeFileSync(join(cwd, 'ignored.log'), 'noise\n')
    })

    const paths = step.files.map((f) => f.path)
    for (const n of names) expect(paths).toContain(n)
    expect(paths).toContain('bin.dat')
    expect(paths).toContain('sub/x.txt')
    expect(paths).not.toContain('ignored.log')
    expect(paths.some((p) => p.startsWith('linkdir'))).toBe(false)

    const res = await c.rollback(step.id)
    expect(res.verified).toBe(true)
    for (const n of names) expect(readFileSync(join(cwd, n), 'utf8')).toBe(`${n} original\n`)
    expect(readFileSync(join(cwd, 'bin.dat')).equals(bin)).toBe(true)
    expect(readFileSync(join(cwd, 'sub', 'x.txt'), 'utf8')).toBe('x\n')
    expect(readFileSync(join(cwd, 'ignored.log'), 'utf8')).toBe('noise\n')

    await c.redo(step.id)
    for (const n of names) expect(readFileSync(join(cwd, n), 'utf8')).toBe(`${n} edited\n`)

    expect(readFileSync(join(cwd, '.git')).equals(pointer)).toBe(true)
    expect(git(['rev-parse', 'HEAD'], cwd).trim()).toBe(headBefore)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim()).toBe('feature')
    expect(git(['status', '--porcelain'], cwd)).toBe(statusBefore)
    expect(git(['branch', '--list'], main)).toContain('feature')
  })
})
