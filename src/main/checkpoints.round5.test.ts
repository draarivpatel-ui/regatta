// Round 5: the open-writer check must cover the symlink branch, odd names, writable mappings and lsof failures.

import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

function make(extra: Partial<CheckpointsDeps> = {}) {
  const c = new Checkpoints({ baseDir: () => temp('regatta-base5-'), emitChanged: () => {}, log: () => {}, retryDelayMs: 1, ...extra })
  return { c }
}

async function turn(c: Checkpoints, cwd: string, label: string, mutate: () => void | Promise<void>): Promise<CheckpointStep> {
  await c.stepStart('s1', 'fake', cwd, label)
  await mutate()
  await c.stepEnd('s1')
  const step = c.list('s1').find((s) => s.label === label)
  if (!step) throw new Error(`no step recorded for ${label}`)
  return step
}

async function withFakeCommand(name: string, script: string, fn: () => Promise<void>): Promise<void> {
  const dir = temp('regatta-fake5-')
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
  const child = spawn('sh', ['-c', `exec 3>>"$1"; sleep 120`, 'sh', file], { detached: true, stdio: 'ignore' })
  child.unref()
  children.push(child.pid!)
  await new Promise((r) => setTimeout(r, 400))
  return child.pid!
}

/** A workspace where `lnk` (or the given name) was a symlink that the step replaced with a regular file. */
async function symlinkReplaced(name: string) {
  const cwd = temp('regatta-ws5-')
  writeFileSync(join(cwd, 'target.txt'), 'target\n')
  writeFileSync(join(cwd, 'other.txt'), 'other original\n')
  symlinkSync('target.txt', join(cwd, name))
  const { c } = make()
  const step = await turn(c, cwd, 'replace link', () => {
    unlinkSync(join(cwd, name))
    writeFileSync(join(cwd, name), 'plain file\n')
    writeFileSync(join(cwd, 'other.txt'), 'other agent\n') // a second file, so the check covers a batch
  })
  return { cwd, c, step }
}

describe('A: the symlink branch checks for writers too', () => {
  it('keeps a file that a program opened after planning, before the link replaces it', async () => {
    const { cwd, c, step } = await symlinkReplaced('lnk')
    const target = join(cwd, 'lnk')
    const dir = temp('regatta-hold5-')
    const hold = join(dir, 'hold')
    const entered = join(dir, 'entered')
    const counter = join(dir, 'count')
    writeFileSync(hold, '')
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    // Hashes of workspace files: 1 and 2 are the planning checks of lnk and other.txt, 3 is lnk inside the
    // write step. The third is held after git computed it, so the writer opens after the content was read.
    const script = `#!/bin/sh
case "$*" in *hash-object*'${cwd}'*)
  n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'
  if [ "$n" -eq 3 ] && [ -e '${hold}' ]; then
    out=$('${real}' "$@"); touch '${entered}'
    while [ -e '${hold}' ]; do sleep 0.05; done
    printf '%s\\n' "$out"; exit 0
  fi;;
esac
exec '${real}' "$@"
`
    let pid = 0
    await withFakeCommand('git', script, async () => {
      const pending = c.rollback(step.id)
      await until(() => existsSync(entered))
      pid = await holdOpenForAppend(target)
      rmSync(hold)
      const res = await pending
      const file = res.files.find((f) => f.path === 'lnk')!
      expect(file.action).toBe('kept')
      expect(file.note).toBe('a program has this file open')
    })
    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('plain file\n')

    process.kill(-pid, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 200))
    const retry = await c.rollback(step.id)
    expect(retry.verified).toBe(true)
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
  })

  it('finds a writer on a file whose name contains a newline', async () => {
    const { cwd, c, step } = await symlinkReplaced('l\nnk')
    const pid = await holdOpenForAppend(join(cwd, 'l\nnk'))

    const res = await c.rollback(step.id)

    const file = res.files.find((f) => f.path === 'l\nnk')!
    expect(file.action).toBe('kept')
    expect(file.note).toBe('a program has this file open')
    expect(lstatSync(join(cwd, 'l\nnk')).isSymbolicLink()).toBe(false)
    process.kill(-pid, 'SIGKILL')
  })
})

describe('B: writable memory mappings count as busy', () => {
  it('keeps a file that a running program mapped writable and then closed', async () => {
    try {
      execFileSync('python3', ['--version'], { stdio: 'ignore' })
    } catch {
      return
    }
    const cwd = temp('regatta-ws5-')
    writeFileSync(join(cwd, 'm.txt'), 'original content\n')
    const { c } = make()
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'm.txt'), 'agent content!!\n'))
    // Maps the file writable straight through libc and closes every descriptor, so only the mapping is left.
    const code = [
      'import ctypes,os,sys,time',
      'libc=ctypes.CDLL(None)',
      'libc.mmap.restype=ctypes.c_void_p',
      'libc.mmap.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_long]',
      'fd=os.open(sys.argv[1],os.O_RDWR)',
      'libc.mmap(None,4096,3,1,fd,0)',
      'os.close(fd)',
      'print("ready",flush=True)',
      'time.sleep(120)'
    ].join('\n')
    const child = spawn('python3', ['-c', code, join(cwd, 'm.txt')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    child.unref()
    children.push(child.pid!)
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()))

    const res = await c.rollback(step.id)

    const file = res.files.find((f) => f.path === 'm.txt')!
    expect(file.action).toBe('kept')
    expect(file.note).toBe('a program has this file open')
    expect(readFileSync(join(cwd, 'm.txt'), 'utf8')).toBe('agent content!!\n')
    process.kill(-child.pid!, 'SIGKILL')
  })
})

describe('C: an lsof answer that is not complete and clean refuses the operation', () => {
  async function refusedWith(script: string): Promise<void> {
    const cwd = temp('regatta-ws5-')
    writeFileSync(join(cwd, 'a.txt'), 'a original\n')
    const { c } = make()
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    const pid = await holdOpenForAppend(join(cwd, 'a.txt')) // a real writer the shim fails to report
    await withFakeCommand('lsof', script, async () => {
      const res = await c.rollback(step.id)
      expect(res.refused).toMatch(/which programs have these files open/)
    })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a agent\n')
    process.kill(-pid, 'SIGKILL')
  }

  it('exit 1 with an error on stderr', () => refusedWith("#!/bin/sh\necho 'lsof: something broke' >&2\nexit 1\n"))
  it('exit 1 with text that is not a listing', () => refusedWith("#!/bin/sh\necho 'lsof: something broke'\nexit 1\n"))
  it('a listing that is cut off', () => refusedWith("#!/bin/sh\nprintf 'p123\\nf3\\naw'\nexit 0\n"))
  it('a listing with a stderr warning', () => refusedWith("#!/bin/sh\nprintf 'p123\\nf3\\naw\\n'\necho warn >&2\nexit 0\n"))
  it('death by a signal', () => refusedWith('#!/bin/sh\nkill -9 $$\n'))
  it('another exit code', () => refusedWith('#!/bin/sh\nexit 3\n'))

  it('a clean "nothing open" answer (empty output, exit 1) lets the roll back go ahead', async () => {
    const cwd = temp('regatta-ws5-')
    writeFileSync(join(cwd, 'a.txt'), 'a original\n')
    const { c } = make()
    const step = await turn(c, cwd, 'edit', () => writeFileSync(join(cwd, 'a.txt'), 'a agent\n'))
    await withFakeCommand('lsof', '#!/bin/sh\nexit 1\n', async () => {
      const res = await c.rollback(step.id)
      expect(res.refused).toBeUndefined()
      expect(res.verified).toBe(true)
    })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
  })
})
void mkdirSync
void readdirSync
void statSync
