// Tests that need to watch or break the file system calls Checkpoints makes: folder syncs and disk errors.

import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// Real git runs in every test; a loaded machine can take well over vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 })

interface Ctl {
  events: string[]
  fds: Map<number, string>
  /** Make the nth lstat of this exact path fail with EIO (1 based, counting from when it was set). */
  fault: { path: string; at: number; seen: number } | null
}
const ctl = vi.hoisted(() => ({ events: [], fds: new Map(), fault: null }) as Ctl)

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const c = ctl
  return {
    ...real,
    openSync: (path: string, flags?: string, mode?: number) => {
      const fd = real.openSync(path, flags as string, mode)
      if (flags === 'r') c.fds.set(fd, String(path))
      return fd
    },
    fsyncSync: (fd: number) => {
      const p = c.fds.get(fd)
      if (p) c.events.push(`fsync:${p}`)
      return real.fsyncSync(fd)
    },
    closeSync: (fd: number) => {
      c.fds.delete(fd)
      return real.closeSync(fd)
    },
    renameSync: (a: string, b: string) => {
      c.events.push(`rename:${b}`)
      return real.renameSync(a, b)
    },
    unlinkSync: (p: string) => {
      c.events.push(`unlink:${p}`)
      return real.unlinkSync(p)
    },
    lstatSync: (p: string, ...rest: unknown[]) => {
      if (c.fault && String(p) === c.fault.path) {
        c.fault.seen++
        if (c.fault.seen === c.fault.at) throw Object.assign(new Error('EIO: i/o error, lstat'), { code: 'EIO' })
      }
      return (real.lstatSync as (...a: unknown[]) => unknown)(p, ...rest)
    }
  }
})

const { Checkpoints } = await import('./checkpoints')

const dirs: string[] = []
const temp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function setup(files: Record<string, string>) {
  const cwd = temp('regatta-fsmock-ws-')
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content)
  const base = temp('regatta-fsmock-base-')
  const c = new Checkpoints({ baseDir: () => base, emitChanged: () => {}, log: () => {}, retryDelayMs: 1 })
  return { cwd, base, c }
}

describe('P1-4: the operation record is flushed, folder included, before any workspace file is touched', () => {
  it('syncs the shadow folder after writing op.json and before the first change to the workspace', async () => {
    const { cwd, base, c } = setup({ 'a.txt': 'a original\n' })
    await c.stepStart('s1', 'fake', cwd, 'edit')
    writeFileSync(join(cwd, 'a.txt'), 'a agent\n')
    await c.stepEnd('s1')
    const step = c.list('s1')[0]!
    ctl.events.length = 0

    await c.rollback(step.id)

    const shadow = join(base, readdirSyncOne(base))
    const journalAt = ctl.events.indexOf(`rename:${join(shadow, 'op.json')}`)
    const syncedAfter = ctl.events.findIndex((e, i) => i > journalAt && e === `fsync:${shadow}`)
    const firstWorkspaceChange = ctl.events.findIndex((e) => e.startsWith('rename:') && e.startsWith(`rename:${cwd}`))
    expect(journalAt).toBeGreaterThanOrEqual(0)
    expect(syncedAfter).toBeGreaterThan(journalAt)
    expect(firstWorkspaceChange).toBeGreaterThan(syncedAfter)
    // The folder is synced again after the record is removed and after the history is replaced.
    const tail = ctl.events.slice(firstWorkspaceChange)
    expect(tail.filter((e) => e === `fsync:${shadow}`).length).toBeGreaterThanOrEqual(2)
  })
})

describe('P2-5: disk errors are not conflicts', () => {
  it('refuses the whole operation when a path cannot be read while planning', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n', 'c.txt': 'c original\n' })
    await c.stepStart('s1', 'fake', cwd, 'edit')
    writeFileSync(join(cwd, 'a.txt'), 'a agent\n')
    writeFileSync(join(cwd, 'c.txt'), 'c agent\n')
    await c.stepEnd('s1')
    ctl.fault = { path: join(cwd, 'a.txt'), at: 1, seen: 0 }

    const res = await c.rollback(c.list('s1')[0]!.id)
    ctl.fault = null

    expect(res.refused).toMatch(/Nothing was changed/)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
    expect(readFileSync(join(cwd, 'c.txt'), 'utf8')).toBe('c agent\n')
    expect(c.list('s1')[0]?.rolledBack).toBe(false)
  })

  it('makes the step partial and retryable when the error happens while applying', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n', 'c.txt': 'c original\n' })
    await c.stepStart('s1', 'fake', cwd, 'edit')
    writeFileSync(join(cwd, 'a.txt'), 'a agent\n')
    writeFileSync(join(cwd, 'c.txt'), 'c agent\n')
    await c.stepEnd('s1')
    const step = c.list('s1')[0]!
    // lstat calls on a.txt: 1 planning gate, 2 planning hash check, 3 open-writer check (planning),
    // 4 the gate inside the write step.
    ctl.fault = { path: join(cwd, 'a.txt'), at: 4, seen: 0 }

    const res = await c.rollback(step.id)
    ctl.fault = null

    const a = res.files.find((f) => f.path === 'a.txt')!
    expect(a.error).toBe(true)
    expect(a.note).not.toMatch(/you edited/)
    expect(res.files.find((f) => f.path === 'c.txt')?.action).toBe('rewound')
    expect(res.verified).toBe(false)
    expect(c.list('s1')[0]).toMatchObject({ rolledBack: true, partial: true, partialDirection: 'rollback' })

    const retry = await c.rollback(step.id)
    expect(retry.verified).toBe(true)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
    expect(c.list('s1')[0]?.partial).toBeFalsy()
  })
})

describe('P2-D: a disk error at the final check is a failure, not a kept file', () => {
  it('records a partial, retryable result when the last gate cannot read the file', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n', 'c.txt': 'c original\n' })
    await c.stepStart('s1', 'fake', cwd, 'edit')
    writeFileSync(join(cwd, 'a.txt'), 'a agent\n')
    writeFileSync(join(cwd, 'c.txt'), 'c agent\n')
    await c.stepEnd('s1')
    const step = c.list('s1')[0]!
    // 5 the hash check inside the write step, 6 its open-writer check, 7 the final gate.
    ctl.fault = { path: join(cwd, 'a.txt'), at: 7, seen: 0 }

    const res = await c.rollback(step.id)
    ctl.fault = null

    const a = res.files.find((f) => f.path === 'a.txt')!
    expect(a.error).toBe(true)
    expect(a.note).toMatch(/could not be written/)
    expect(res.files.find((f) => f.path === 'c.txt')?.action).toBe('rewound')
    expect(res.verified).toBe(false)
    expect(c.list('s1')[0]).toMatchObject({ rolledBack: true, partial: true, partialDirection: 'rollback' })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')

    const retry = await c.rollback(step.id)
    expect(retry.verified).toBe(true)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
  })
})

describe('P2-2: a failed roll back that changed nothing stays retryable', () => {
  it('keeps the partial state and direction when the only file hits a disk error at the final gate', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    await c.stepStart('s1', 'fake', cwd, 'edit')
    writeFileSync(join(cwd, 'a.txt'), 'a agent\n')
    await c.stepEnd('s1')
    const step = c.list('s1')[0]!
    ctl.fault = { path: join(cwd, 'a.txt'), at: 7, seen: 0 }

    const res = await c.rollback(step.id)
    ctl.fault = null

    expect(res.files[0]?.error).toBe(true)
    expect(res.summary).toMatch(/use Retry/)
    expect(res.direction).toBe('rollback')
    expect(c.list('s1')[0]).toMatchObject({ rolledBack: false, partial: true, partialDirection: 'rollback' })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')

    const retry = await c.rollback(step.id)
    expect(retry.verified).toBe(true)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
    expect(c.list('s1')[0]).toMatchObject({ rolledBack: true })
    expect(c.list('s1')[0]?.partial).toBeFalsy()
  })
})

function readdirSyncOne(base: string): string {
  return readdirSync(base)[0]!
}
