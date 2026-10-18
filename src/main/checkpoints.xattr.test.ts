// Resource forks and extended attributes are not in the shadow repository, so a file that has any
// (outside the macOS-managed set) is kept rather than replaced or deleted. macOS only.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Checkpoints } from './checkpoints'

const mac = process.platform === 'darwin'
const dirs: string[] = []
const temp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/**
 * A tiny C program that calls setxattr directly, so any attribute name (newlines included) can be set:
 * the name is one argument. (Python on macOS has no os.setxattr, and the xattr command takes names
 * from the shell.) Compiled with the system cc into a temp folder.
 */
let setxattrTool = ''
beforeAll(() => {
  if (!mac) return
  const dir = temp('regatta-xattr-tool-')
  writeFileSync(
    join(dir, 'sx.c'),
    '#include <sys/xattr.h>\n#include <string.h>\n#include <stdio.h>\n' +
      'int main(int c, char **v) { if (c < 4) return 2; if (setxattr(v[1], v[2], v[3], strlen(v[3]), 0, 0) != 0) { perror("setxattr"); return 1; } return 0; }\n'
  )
  execFileSync('cc', [join(dir, 'sx.c'), '-o', join(dir, 'sx')])
  setxattrTool = join(dir, 'sx')
})
const setAttribute = (file: string, name: string, value = 'v'): void => void execFileSync(setxattrTool, [file, name, value])

/** Puts a fake `xattr` first on PATH for the duration of `fn`. */
async function withFakeXattr(script: string, fn: () => Promise<void>): Promise<void> {
  const shim = temp('regatta-xattr-shim-')
  writeFileSync(join(shim, 'xattr'), script, { mode: 0o755 })
  const oldPath = process.env['PATH']
  process.env['PATH'] = `${shim}:${oldPath}`
  try {
    await fn()
  } finally {
    process.env['PATH'] = oldPath
  }
}

function setup(files: Record<string, string>) {
  const cwd = temp('regatta-xattr-ws-')
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content)
  const c = new Checkpoints({ baseDir: () => temp('regatta-xattr-base-'), emitChanged: () => {}, log: () => {}, retryDelayMs: 1 })
  return { cwd, c }
}

async function turn(c: Checkpoints, cwd: string, label: string, mutate: () => void) {
  await c.stepStart('s1', 'fake', cwd, label)
  mutate()
  await c.stepEnd('s1')
  return c.list('s1').find((s) => s.label === label)!
}

const addResourceFork = (file: string): void => writeFileSync(`${file}/..namedfork/rsrc`, 'user resource data')
const NOTE = /extended attributes or a resource fork/

describe.runIf(mac)('extended attributes and resource forks', () => {
  it('keeps an edited file that got a resource fork afterwards', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    addResourceFork(join(cwd, 'a.txt'))

    const res = await c.rollback(step.id)

    const file = res.files[0]!
    expect(file.action).toBe('kept')
    expect(file.note).toMatch(NOTE)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
    expect(execFileSync('xattr', [join(cwd, 'a.txt')], { encoding: 'utf8' })).toContain('com.apple.ResourceFork')
  })

  it('keeps a step-created file that got a resource fork, instead of deleting it', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a\n' })
    const step = await turn(c, cwd, 'create', () => writeFileSync(join(cwd, 'new.txt'), 'new agent\n'))
    addResourceFork(join(cwd, 'new.txt'))

    const res = await c.rollback(step.id)

    expect(res.files.find((f) => f.path === 'new.txt')?.action).toBe('kept')
    expect(existsSync(join(cwd, 'new.txt'))).toBe(true)
    expect(readFileSync(`${join(cwd, 'new.txt')}/..namedfork/rsrc`, 'utf8')).toBe('user resource data')
  })

  it('keeps the file on redo too', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    expect((await c.rollback(step.id)).verified).toBe(true)
    addResourceFork(join(cwd, 'a.txt'))

    const res = await c.redo(step.id)

    expect(res.files[0]?.action).toBe('kept')
    expect(res.files[0]?.note).toMatch(NOTE)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
    expect(readFileSync(`${join(cwd, 'a.txt')}/..namedfork/rsrc`, 'utf8')).toBe('user resource data')
  })

  it('keeps a file with a user extended attribute', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    execFileSync('xattr', ['-w', 'user.note', 'x', join(cwd, 'a.txt')])

    const res = await c.rollback(step.id)

    expect(res.files[0]?.action).toBe('kept')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })

  it('rolls back a file that only carries the two attributes macOS manages itself', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    setAttribute(join(cwd, 'a.txt'), 'com.apple.lastuseddate#PS', 'x')
    expect(execFileSync('xattr', [join(cwd, 'a.txt')], { encoding: 'utf8' })).toContain('com.apple.provenance')

    const res = await c.rollback(step.id)

    expect(res.files[0]?.action).toBe('rewound')
    expect(res.verified).toBe(true)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
  })

  it('keeps a file with a real com.apple.quarantine attribute', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    setAttribute(join(cwd, 'a.txt'), 'com.apple.quarantine', '0081;00000000;test;')

    const res = await c.rollback(step.id)

    expect(res.files[0]?.action).toBe('kept')
    expect(res.files[0]?.note).toMatch(NOTE)
    expect(execFileSync('xattr', [join(cwd, 'a.txt')], { encoding: 'utf8' })).toContain('com.apple.quarantine')
  })

  it('keeps a file whose listing contains com.apple.macl', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    // The system may refuse to let a program set a real macl, so the listing is simulated.
    await withFakeXattr('#!/bin/sh\ncase "$1" in -p) exit 0;; esac\nprintf "com.apple.provenance\\ncom.apple.macl\\n"\n', async () => {
      const res = await c.rollback(step.id)
      expect(res.files[0]?.action).toBe('kept')
      expect(res.files[0]?.note).toMatch(NOTE)
    })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })

  it('keeps a file with an attribute whose name is a newline', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    setAttribute(join(cwd, 'a.txt'), '\n', 'user data')

    const res = await c.rollback(step.id)

    expect(res.files[0]?.action).toBe('kept')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })

  it('keeps a file whose one attribute is named like two ignored names joined by a newline', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    setAttribute(join(cwd, 'a.txt'), 'com.apple.provenance\ncom.apple.lastuseddate#PS', 'user data')

    const res = await c.rollback(step.id)

    expect(res.files[0]?.action).toBe('kept')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })

  it('keeps that file too when the real ignored attributes are present as well', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    setAttribute(join(cwd, 'a.txt'), 'com.apple.lastuseddate#PS', 'real')
    setAttribute(join(cwd, 'a.txt'), 'com.apple.provenance\ncom.apple.lastuseddate#PS', 'user data')

    const res = await c.rollback(step.id)

    expect(res.files[0]?.action).toBe('kept')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })

  it('keeps a file when the listing repeats a name', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    await withFakeXattr('#!/bin/sh\ncase "$1" in -p) exit 0;; esac\nprintf "com.apple.provenance\\ncom.apple.provenance\\n"\n', async () => {
      const res = await c.rollback(step.id)
      expect(res.files[0]?.action).toBe('kept')
    })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })

  it('keeps a file when a listing contains a blank line', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    await withFakeXattr('#!/bin/sh\ncase "$1" in -p) exit 0;; esac\nprintf "com.apple.provenance\\n\\n"\n', async () => {
      const res = await c.rollback(step.id)
      expect(res.files[0]?.action).toBe('kept')
    })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })

  it('keeps a file when an ignored name cannot be read back under exactly that name', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    await withFakeXattr('#!/bin/sh\ncase "$1" in -p) exit 1;; esac\nprintf "com.apple.provenance\\n"\n', async () => {
      const res = await c.rollback(step.id)
      expect(res.files[0]?.action).toBe('kept')
    })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })

  it('keeps the file when its attributes cannot be read', async () => {
    const { cwd, c } = setup({ 'a.txt': 'a original\n' })
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    const shim = temp('regatta-xattr-shim-')
    writeFileSync(join(shim, 'xattr'), '#!/bin/sh\necho broken >&2\nexit 1\n', { mode: 0o755 })
    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shim}:${oldPath}`
    try {
      const res = await c.rollback(step.id)
      expect(res.files[0]?.action).toBe('kept')
      expect(res.files[0]?.note).toMatch(/could not be read/)
    } finally {
      process.env['PATH'] = oldPath
    }
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
  })
})
void mkdirSync
