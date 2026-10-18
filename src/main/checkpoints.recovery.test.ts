// Round 3 safety tests for checkpoints: durable operations, unprotected steps, boundaries and operational failures.

import { execFileSync } from 'node:child_process'
import {
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
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { CheckpointStep } from '../shared/checkpoints'
import { Checkpoints, type CheckpointsDeps } from './checkpoints'

vi.setConfig({ testTimeout: 60_000 })

const cleanup: string[] = []

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

function workspace(files: Record<string, string | Buffer> = { 'a.txt': 'a original\n', 'c.txt': 'c original\n' }): string {
  const dir = temp('regatta-ws3-')
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

function make(extra: Partial<CheckpointsDeps> = {}, base = temp('regatta-base3-')) {
  const logs: string[] = []
  const c = new Checkpoints({ baseDir: () => base, emitChanged: () => {}, log: (m) => logs.push(m), retryDelayMs: 1, ...extra })
  return { c, base, logs }
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

/** A real repository with one commit, so that a snapshot of the outer folder can still be taken. */
function makeRepoIn(dir: string): void {
  const id = ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false']
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', [...id, 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir })
}

async function withFakeGit(script: (realGit: string) => string, fn: () => Promise<void>): Promise<void> {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const dir = temp('regatta-fakegit3-')
  writeFileSync(join(dir, 'git'), script(realGit), { mode: 0o755 })
  const oldPath = process.env['PATH']
  process.env['PATH'] = `${dir}:${oldPath}`
  try {
    await fn()
  } finally {
    process.env['PATH'] = oldPath
  }
}

/**
 * A git shim that fails `hash-object` calls on files inside `ws`: every call when `failFrom` is 0,
 * otherwise the call numbered `failFrom` (counting calls on workspace files, starting at 1).
 */
function failingHash(ws: string, counter: string, failFrom: number, only?: string) {
  return (real: string) =>
    [
      '#!/bin/sh',
      'for a in "$@"; do case "$a" in hash-object) HASH=1;; esac; done',
      `if [ -n "$HASH" ]; then case "$*" in *'${ws}'*${only ? `'${only}'*` : ''})`,
      `  n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'`,
      failFrom === 0
        ? "  echo 'fatal: simulated hash failure' >&2; exit 128;;"
        : `  if [ "$n" -eq ${failFrom} ]; then echo 'fatal: simulated hash failure' >&2; exit 128; fi;;`,
      'esac; fi',
      `exec '${real}' "$@"`,
      ''
    ].join('\n')
}

describe('finding 3: operations are journaled and recoverable', () => {
  it('refuses to start when the operation cannot be recorded', async () => {
    const cwd = workspace()
    const { c, base } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    mkdirSync(join(shadowDirOf(base), 'op.json.tmp'))

    const res = await c.rollback(step.id)

    expect(res.refused).toMatch(/record this operation/)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
    expect(c.list('s1')[0]?.rolledBack).toBe(false)
  })

  it('recovers an interrupted rollback after a restart so redo works', async () => {
    const cwd = workspace()
    const { c, base } = make()
    const step = await turn(c, 's1', cwd, 'edit and create', () => {
      writeFileSync(join(cwd, 'a.txt'), 'a agent\n')
      writeFileSync(join(cwd, 'new.txt'), 'new agent\n')
    })
    // What a crash right after the deletion leaves behind: the files are rewound, the history is not,
    // and the operation record written before the first change is still on disk.
    const dir = shadowDirOf(base)
    writeFileSync(join(cwd, 'a.txt'), 'a original\n')
    unlinkSync(join(cwd, 'new.txt'))
    writeFileSync(
      join(dir, 'op.json'),
      JSON.stringify({ v: 1, kind: 'rollback', stepId: step.id, opId: 'abc', paths: ['a.txt', 'new.txt'], rewoundBefore: [], pre: step.start, startedAt: 1 })
    )

    const { c: after } = make({}, base)
    const recovered = after.list('s1')[0]!
    expect(recovered.rolledBack).toBe(true)
    expect(recovered.partial).toBe(true)
    expect(existsSync(join(dir, 'op.json'))).toBe(false)

    const redo = await after.redo(step.id)
    expect(redo.files.every((f) => f.action === 'restored')).toBe(true)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
    expect(readFileSync(join(cwd, 'new.txt'), 'utf8')).toBe('new agent\n')
    expect(after.list('s1')[0]?.rolledBack).toBe(false)
  })

  it('a rollback that was recorded but never started can still be rolled back after recovery', async () => {
    const cwd = workspace()
    const { c, base } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    writeFileSync(
      join(shadowDirOf(base), 'op.json'),
      JSON.stringify({ v: 1, kind: 'rollback', stepId: step.id, opId: 'abc', paths: ['a.txt'], rewoundBefore: [], pre: step.start, startedAt: 1 })
    )
    const { c: after } = make({}, base)
    const res = await after.rollback(step.id)
    expect(res.files.find((f) => f.path === 'a.txt')?.action).toBe('rewound')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
    expect(res.verified).toBe(true)
    expect(after.list('s1')[0]?.partial).toBeFalsy()
  })

  it('does not report success when the history cannot be saved, and recovers on the next start', async () => {
    const cwd = workspace()
    const { c, base } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    const dir = shadowDirOf(base)
    mkdirSync(join(dir, 'steps.json.tmp'))

    const res = await c.rollback(step.id)

    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
    expect(res.verified).toBe(false)
    expect(res.summary).toMatch(/history could not be saved/)
    expect(existsSync(join(dir, 'op.json'))).toBe(true)

    rmSync(join(dir, 'steps.json.tmp'), { recursive: true })
    const { c: after } = make({}, base)
    expect(after.list('s1')[0]?.rolledBack).toBe(true)
    await after.redo(step.id)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })
})

describe('a journal that could not be cleared blocks other steps until recovery', () => {
  it('refuses to change another step while an earlier operation is not recorded', async () => {
    const cwd = workspace()
    const { c, base } = make()
    const one = await turn(c, 's1', cwd, 'one', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    const two = await turn(c, 's1', cwd, 'two', () => writeFileSync(join(cwd, 'c.txt'), 'c agent\n'))
    const dir = shadowDirOf(base)
    mkdirSync(join(dir, 'steps.json.tmp'))
    await c.rollback(one.id) // history save fails: the journal stays
    rmSync(join(dir, 'steps.json.tmp'), { recursive: true })
    expect(existsSync(join(dir, 'op.json'))).toBe(true)

    const res = await c.rollback(two.id)

    expect(res.refused).toMatch(/Restart Regatta/)
    expect(readFileSync(join(cwd, 'c.txt'), 'utf8')).toBe('c agent\n')
  })
})

describe('finding 4: unprotected turns', () => {
  it('records a turn marked unprotected, offers no rollback, and keeps the folder blocked until it ends', async () => {
    const cwd = workspace()
    const { c } = make()
    await c.stepStart('s1', 'fake', cwd, 'slow start')
    c.markUnprotected('s1', 'the opening snapshot was still running after 30 seconds')
    writeFileSync(join(cwd, 'a.txt'), 'a agent\n')

    const during = c.list('s1').find((s) => s.label === 'slow start')
    expect(during?.unprotected).toMatch(/30 seconds/)
    expect(during?.blockedReason).toMatch(/This turn is not protected/)

    // Another session finishes a step in the same folder while the first is still running.
    const other = await turn(c, 's2', cwd, 'other', () => writeFileSync(join(cwd, 'b.txt'), 'b\n'))
    expect(other.shared).toBe(true)
    expect((await c.rollback(other.id)).refused).toBeTruthy()

    await c.stepEnd('s1')
    const done = c.list('s1').find((s) => s.label === 'slow start')!
    expect(done.unprotected).toBeTruthy()
    const res = await c.rollback(done.id)
    expect(res.refused).toMatch(/not protected/)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })
})

describe('finding 7: nested repositories', () => {
  it('keeps a tracked file inside a folder that became its own repository', async () => {
    const cwd = workspace({ 'a.txt': 'a\n', 'nested/file.txt': 'orig\n' })
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit nested', () => writeFileSync(join(cwd, 'nested', 'file.txt'), 'agent\n'))
    makeRepoIn(join(cwd, 'nested'))

    const res = await c.rollback(step.id)

    expect(readFileSync(join(cwd, 'nested', 'file.txt'), 'utf8')).toBe('agent\n')
    expect(res.files.find((f) => f.path === 'nested/file.txt')?.action).toBe('kept')
    expect(res.files.find((f) => f.path === 'nested/file.txt')?.note).toMatch(/nested git repository/)
  })

  it('keeps a deleted file when its folder became a repository', async () => {
    const cwd = workspace({ 'a.txt': 'a\n', 'nested/file.txt': 'orig\n' })
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'delete nested', () => unlinkSync(join(cwd, 'nested', 'file.txt')))
    makeRepoIn(join(cwd, 'nested'))
    await c.rollback(step.id)
    expect(existsSync(join(cwd, 'nested', 'file.txt'))).toBe(false)
  })
})

describe('finding 9: symlink targets are raw bytes', () => {
  it('restores and redoes a symlink whose target is not UTF-8', async () => {
    const cwd = workspace({ 'a.txt': 'a\n' })
    const target = Buffer.from([0x66, 0xff, 0xfe, 0x2f, 0x78])
    try {
      symlinkSync(target as unknown as string, join(cwd, 'lnk'))
    } catch {
      return // this file system refuses such targets
    }
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'replace link', () => {
      unlinkSync(join(cwd, 'lnk'))
      writeFileSync(join(cwd, 'lnk'), 'plain\n')
    })

    const res = await c.rollback(step.id)

    expect(res.verified).toBe(true)
    expect(readlinkSync(join(cwd, 'lnk'), { encoding: 'buffer' }).equals(target)).toBe(true)
    await c.redo(step.id)
    expect(readFileSync(join(cwd, 'lnk'), 'utf8')).toBe('plain\n')
    const back = await c.rollback(step.id)
    expect(back.verified).toBe(true)
    expect(readlinkSync(join(cwd, 'lnk'), { encoding: 'buffer' }).equals(target)).toBe(true)
  })
})

describe('finding 10: operational failures are not user edits', () => {
  it('a git failure while writing leaves the step retryable, not "already rolled back"', async () => {
    const cwd = workspace()
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    const counter = join(temp('regatta-cnt-'), 'n')

    await withFakeGit(failingHash(cwd, counter, 2), async () => {
      const res = await c.rollback(step.id)
      const file = res.files.find((f) => f.path === 'a.txt')!
      expect(file.action).toBe('kept')
      expect(file.error).toBe(true)
      expect(file.note).not.toMatch(/you edited/)
      expect(res.verified).toBe(false)
    })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
    expect(c.list('s1')[0]?.rolledBack).toBe(false)

    const retry = await c.rollback(step.id)
    expect(retry.verified).toBe(true)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
  })

  it('a read-back failure makes the operation partial and retryable', async () => {
    const cwd = workspace()
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    const counter = join(temp('regatta-cnt-'), 'n')

    await withFakeGit(failingHash(cwd, counter, 3), async () => {
      const res = await c.rollback(step.id)
      expect(res.verified).toBe(false)
      expect(res.summary).toMatch(/could not be confirmed/)
    })
    const mid = c.list('s1')[0]!
    expect(mid.rolledBack).toBe(true)
    expect(mid.partial).toBe(true)

    const retry = await c.rollback(step.id)
    expect(retry.verified).toBe(true)
    expect(retry.files.find((f) => f.path === 'a.txt')?.action).toBe('rewound')
    expect(c.list('s1')[0]?.partial).toBeFalsy()
  })

  it('a hash failure while planning refuses the whole operation and changes nothing', async () => {
    const cwd = workspace()
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => {
      writeFileSync(join(cwd, 'a.txt'), 'a agent\n')
      writeFileSync(join(cwd, 'c.txt'), 'c agent\n')
    })
    const counter = join(temp('regatta-cnt-'), 'n')
    await withFakeGit(failingHash(cwd, counter, 0), async () => {
      const res = await c.rollback(step.id)
      expect(res.refused).toMatch(/Nothing was changed/)
    })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
    expect(readFileSync(join(cwd, 'c.txt'), 'utf8')).toBe('c agent\n')
  })
})

describe('finding 1: the workspace root keeps its identity', () => {
  it('refuses when the folder was replaced by another one at the same path', async () => {
    const parent = temp('regatta-parent3-')
    const cwd = join(parent, 'ws')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'a.txt'), 'a original\n')
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    renameSync(cwd, join(parent, 'ws-old'))
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'a.txt'), 'a agent\n')

    const res = await c.rollback(step.id)

    expect(res.refused).toMatch(/not the one this step was recorded in/)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })

  it('refuses when the folder became a symlink to another folder', async () => {
    const parent = temp('regatta-parent3-')
    const cwd = join(parent, 'ws')
    const other = join(parent, 'other')
    mkdirSync(cwd)
    mkdirSync(other)
    writeFileSync(join(cwd, 'a.txt'), 'a original\n')
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    writeFileSync(join(other, 'a.txt'), 'a agent\n')
    renameSync(cwd, join(parent, 'ws-old'))
    symlinkSync(other, cwd)

    const res = await c.rollback(step.id)

    expect(res.refused).toBeTruthy()
    expect(readFileSync(join(other, 'a.txt'), 'utf8')).toBe('a agent\n')
    expect(lstatSync(cwd).isSymbolicLink()).toBe(true)
  })
})

describe('findings 11 and 12: records and garbage', () => {
  it('keeps only the newest failed records', async () => {
    const cwd = workspace()
    const { c, base } = make({ maxFailedRecords: 2 })
    for (let i = 0; i < 4; i++) {
      await c.stepStart('s1', 'fake', cwd, `t${i}`)
      writeFileSync(join(cwd, 'a.txt'), `${i}\n`)
      const lock = join(shadowDirOf(base), 'index.lock')
      writeFileSync(lock, '')
      await expect(c.stepEnd('s1')).rejects.toThrow()
      unlinkSync(lock)
    }
    await turn(c, 's1', cwd, 'good', () => writeFileSync(join(cwd, 'b.txt'), 'b\n'))
    const labels = c.list('s1').map((s) => s.label)
    expect(labels).toContain('good')
    expect(labels.filter((l) => l.startsWith('t'))).toHaveLength(2)
  })

  it('counts dropped snapshots across restarts and cleans up when the count is reached', async () => {
    const cwd = workspace()
    const first = make({ gcAfterDrops: 3 })
    await turn(first.c, 's1', cwd, 'e1', () => {}).catch(() => undefined)
    const dir = shadowDirOf(first.base)
    expect(readFileSync(join(dir, 'garbage.txt'), 'utf8')).toBe('1')
    const second = make({ gcAfterDrops: 3 }, first.base)
    await second.c.stepStart('s1', 'fake', cwd, 'e2')
    await second.c.stepEnd('s1')
    expect(readFileSync(join(dir, 'garbage.txt'), 'utf8')).toBe('2')
    await second.c.stepStart('s1', 'fake', cwd, 'e3')
    await second.c.stepEnd('s1')
    expect(readFileSync(join(dir, 'garbage.txt'), 'utf8')).toBe('0')
  })
})
