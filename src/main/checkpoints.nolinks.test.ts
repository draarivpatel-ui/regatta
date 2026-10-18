// On a file system without hard links Regatta refuses to recreate an absent file: the only fallback
// (copying into the final name) is not atomic, and a writer to the half-copied file would be overwritten.

import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    linkSync: () => {
      throw Object.assign(new Error('hard links are not supported here'), { code: 'EPERM' })
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

describe('create without hard links', () => {
  it('refuses to recreate a deleted file and says why, leaving no partial file', async () => {
    const cwd = temp('regatta-nolink-ws-')
    writeFileSync(join(cwd, 'a.txt'), 'a\n')
    writeFileSync(join(cwd, 'gone.txt'), 'was here\n')
    const c = new Checkpoints({ baseDir: () => temp('regatta-nolink-base-'), emitChanged: () => {}, log: () => {} })
    await c.stepStart('s1', 'fake', cwd, 'delete')
    unlinkSync(join(cwd, 'gone.txt'))
    await c.stepEnd('s1')

    const res = await c.rollback(c.list('s1')[0]!.id)

    const file = res.files.find((f) => f.path === 'gone.txt')!
    expect(file.action).toBe('kept')
    expect(file.note).toMatch(/no hard links/)
    expect(existsSync(join(cwd, 'gone.txt'))).toBe(false)
    expect(readdirSync(cwd).filter((n) => n.startsWith('.regatta-'))).toEqual([])
  })

  it('never replaces a file the user created in the meantime', async () => {
    const cwd = temp('regatta-nolink-ws-')
    mkdirSync(join(cwd, 'd'))
    writeFileSync(join(cwd, 'd', 'gone.txt'), 'was here\n')
    const c = new Checkpoints({ baseDir: () => temp('regatta-nolink-base-'), emitChanged: () => {}, log: () => {} })
    await c.stepStart('s1', 'fake', cwd, 'delete')
    unlinkSync(join(cwd, 'd', 'gone.txt'))
    await c.stepEnd('s1')
    writeFileSync(join(cwd, 'd', 'gone.txt'), 'the user wrote this\n')

    await c.rollback(c.list('s1')[0]!.id)

    expect(readFileSync(join(cwd, 'd', 'gone.txt'), 'utf8')).toBe('the user wrote this\n')
  })
})
