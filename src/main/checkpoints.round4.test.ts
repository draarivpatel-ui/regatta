// Round 4 safety tests: concurrent writers, durable operations, directions, registration and retention.

import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { CheckpointStep } from '../shared/checkpoints'
import { Checkpoints, type CheckpointsDeps } from './checkpoints'

vi.setConfig({ testTimeout: 60_000 })

const cleanup: string[] = []
const children: number[] = []

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(dir)
  return dir
}

afterAll(() => {
  for (const pid of children) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const dir of cleanup) {
    try {
      chmodSync(join(dir, 'sub'), 0o755)
    } catch {
      // not every folder has one
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

function workspace(files: Record<string, string | Buffer> = { 'a.txt': 'a original\n', 'c.txt': 'c original\n' }): string {
  const dir = temp('regatta-ws4-')
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

function make(extra: Partial<CheckpointsDeps> = {}, base = temp('regatta-base4-')) {
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

function shadowGit(base: string, args: string[]): string {
  const dir = shadowDirOf(base)
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(dir, 'git') } })
}

async function withFakeCommand(name: string, script: string, fn: () => Promise<void>): Promise<void> {
  const dir = temp('regatta-fake4-')
  writeFileSync(join(dir, name), script, { mode: 0o755 })
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

/** A detached program that keeps `file` open for appending until it is killed. */
async function holdOpenForAppend(file: string): Promise<number> {
  const child = spawn('sh', ['-c', `exec 3>>'${file}'; sleep 120`], { detached: true, stdio: 'ignore' })
  child.unref()
  children.push(child.pid!)
  await new Promise((r) => setTimeout(r, 400))
  return child.pid!
}

describe('P1-1: the final check includes the change time', () => {
  it('keeps a same-length edit whose modification time was put back during the slow part', async () => {
    const cwd = workspace()
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'agent-1\n'))
    const target = join(cwd, 'a.txt')
    const before = statSync(target)
    const dir = temp('regatta-hold4-')
    const reference = join(dir, 'reference')
    execFileSync('cp', ['-p', target, reference]) // keeps the exact modification time
    const hold = join(dir, 'hold')
    const entered = join(dir, 'entered')
    const counter = join(dir, 'count')
    writeFileSync(hold, '')
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    // The second hash of the workspace file (the one inside the write step) is held after git computed it.
    const script = `#!/bin/sh
case "$*" in *hash-object*'${cwd}'*)
  n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'
  if [ "$n" -eq 2 ] && [ -e '${hold}' ]; then
    out=$('${real}' "$@"); touch '${entered}'
    while [ -e '${hold}' ]; do sleep 0.05; done
    printf '%s\\n' "$out"; exit 0
  fi;;
esac
exec '${real}' "$@"
`
    await withFakeCommand('git', script, async () => {
      const pending = c.rollback(step.id)
      await until(() => existsSync(entered))
      writeFileSync(target, 'agent-X\n') // same length
      execFileSync('touch', ['-r', reference, target]) // modification time restored exactly
      expect(statSync(target).mtimeMs).toBe(before.mtimeMs)
      rmSync(hold)
      const res = await pending
      expect(res.files.find((f) => f.path === 'a.txt')?.action).toBe('kept')
    })
    expect(readFileSync(target, 'utf8')).toBe('agent-X\n')
  })
})

describe('P1-2: files that a program has open for writing are not replaced', () => {
  it('keeps an edited file and a deleted-by-rollback file while a program appends to it', async () => {
    const cwd = workspace({ 'a.txt': 'a original\n', 'new.txt': '' })
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit and create', () => {
      writeFileSync(join(cwd, 'a.txt'), 'a agent\n')
      writeFileSync(join(cwd, 'new.txt'), 'new agent\n')
    })
    const pid = await holdOpenForAppend(join(cwd, 'a.txt'))

    const res = await c.rollback(step.id)

    const a = res.files.find((f) => f.path === 'a.txt')!
    expect(a.action).toBe('kept')
    expect(a.note).toBe('a program has this file open')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
    expect(res.files.find((f) => f.path === 'new.txt')?.action).toBe('rewound')

    process.kill(-pid, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 200))
    const again = await c.rollback(step.id)
    expect(again.files.find((f) => f.path === 'a.txt')?.action).toBe('rewound')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
  })

  it('refuses the whole operation when the open-file check cannot run', async () => {
    const cwd = workspace()
    const { c } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    await withFakeCommand('lsof', '#!/bin/sh\necho broken >&2\nexit 2\n', async () => {
      const res = await c.rollback(step.id)
      expect(res.refused).toMatch(/which programs have these files open/)
    })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })
})

describe('P1-4: durability settings', () => {
  it('writes the fsync settings into the shadow repository config', async () => {
    const cwd = workspace()
    const { c, base } = make()
    await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    const config = readFileSync(join(shadowDirOf(base), 'git', 'config'), 'utf8')
    expect(config).toMatch(/fsync\s*=\s*objects,reference,index/)
    expect(config).toMatch(/fsyncMethod\s*=\s*fsync/i)
    expect(shadowGit(base, ['config', '--get', 'core.fsync']).trim()).toBe('objects,reference,index')
  })
})

describe('P2-6: retry continues the unfinished direction', () => {
  it('keeps "redo" as the direction of a partly finished redo, also after a restart', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const cwd = workspace({ 'a.txt': 'a original\n' })
    const { c, base } = make()
    const step = await turn(c, 's1', cwd, 'edit and create', () => {
      writeFileSync(join(cwd, 'a.txt'), 'a agent\n')
      mkdirSync(join(cwd, 'sub'))
      writeFileSync(join(cwd, 'sub', 'new.txt'), 'new agent\n')
    })
    const rolled = await c.rollback(step.id)
    expect(rolled.direction).toBe('rollback')
    chmodSync(join(cwd, 'sub'), 0o555)

    const partial = await c.redo(step.id)

    expect(partial.direction).toBe('redo')
    expect(partial.verified).toBe(false)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
    expect(existsSync(join(cwd, 'sub', 'new.txt'))).toBe(false)
    const mid = c.list('s1')[0]!
    expect(mid.partial).toBe(true)
    expect(mid.partialDirection).toBe('redo')

    const { c: after } = make({}, base)
    expect(after.list('s1')[0]?.partialDirection).toBe('redo')

    chmodSync(join(cwd, 'sub'), 0o755)
    const done = await after.redo(step.id)
    expect(done.verified).toBe(true)
    expect(done.files.every((f) => f.action === 'restored')).toBe(true)
    expect(readFileSync(join(cwd, 'sub', 'new.txt'), 'utf8')).toBe('new agent\n')
    expect(after.list('s1')[0]?.partial).toBeFalsy()
    expect(after.list('s1')[0]?.rolledBack).toBe(false)
  })

  it('records the direction after a recovered interrupted redo', async () => {
    const cwd = workspace()
    const { c, base } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    await c.rollback(step.id)
    writeFileSync(
      join(shadowDirOf(base), 'op.json'),
      JSON.stringify({ v: 1, kind: 'redo', stepId: step.id, opId: 'x', paths: ['a.txt'], rewoundBefore: ['a.txt'], pre: step.start, startedAt: 1 })
    )
    const { c: after } = make({}, base)
    expect(after.list('s1')[0]).toMatchObject({ rolledBack: true, partial: true, partialDirection: 'redo' })
  })
})

describe('P2-7: records without a folder identity are not restorable', () => {
  it('refuses an older record and says why', async () => {
    const cwd = workspace()
    const { c, base } = make()
    const step = await turn(c, 's1', cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    const file = join(shadowDirOf(base), 'steps.json')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    delete stored[0].rootId
    writeFileSync(file, JSON.stringify(stored))
    const { c: after } = make({}, base)

    const res = await after.rollback(step.id)

    expect(res.refused).toMatch(/older version/)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })
})

describe('P2-8: a step that cannot be registered is shown as not protected', () => {
  it('shows the reason, and keeps the folder registered so a nested step cannot be rolled back', async () => {
    const parent = workspace({ 'p.txt': 'p\n' })
    const child = join(parent, 'child')
    mkdirSync(child)
    writeFileSync(join(child, 'x.txt'), 'x\n')
    const { c } = make({}, join(parent, '.store'))

    await expect(c.stepStart('s1', 'fake', parent, 'inside')).rejects.toThrow(/checkpoint storage/)

    const notice = c.list('s1')[0]!
    expect(notice.unprotected).toMatch(/checkpoint storage/)
    expect(notice.blockedReason).toMatch(/This turn is not protected/)
    expect(notice.id.startsWith('notice-')).toBe(true)

    const other = await turn(c, 's2', child, 'nested work', () => writeFileSync(join(child, 'x.txt'), 'x2\n'))
    expect(other.shared).toBe(true)
    expect((await c.rollback(other.id)).refused).toBeTruthy()

    await c.stepEnd('s1')
    const later = await turn(c, 's2', child, 'after', () => writeFileSync(join(child, 'x.txt'), 'x3\n'))
    expect(later.shared).toBeFalsy()
  })

  it('shows a notice when the folder cannot be read at all', async () => {
    const { c } = make()
    await expect(c.stepStart('s1', 'fake', join(tmpdir(), 'regatta-missing-folder-xyz'), 'gone')).rejects.toThrow()
    expect(c.list('s1')[0]?.unprotected).toMatch(/cannot be read/)
  })
})

describe('P2-9: failed records are pruned as they are created', () => {
  it('keeps the newest two failed records and frees the snapshots of the others', async () => {
    const cwd = workspace()
    const { c, base } = make({ maxFailedRecords: 2 })
    for (let i = 0; i < 4; i++) {
      await c.stepStart('s1', 'fake', cwd, `t${i}`)
      writeFileSync(join(cwd, 'a.txt'), `${i}\n`)
      const lock = join(shadowDirOf(base), 'index.lock')
      writeFileSync(lock, '')
      await expect(c.stepEnd('s1')).rejects.toThrow()
      rmSync(lock)
    }
    expect(c.list('s1').filter((s) => s.failed)).toHaveLength(2)
    await until(() => {
      const ids = new Set(shadowGit(base, ['for-each-ref', '--format=%(refname)', 'refs/regatta/s/']).split('\n').filter(Boolean).map((r) => r.split('/')[3]))
      return ids.size <= 2
    })
  })
})
