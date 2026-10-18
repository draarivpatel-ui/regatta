// Finding the project's checks and running them, against real folders in /tmp.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { detectChecks, hasMakeTest, packageManager, readScripts, runCheck, runChecks, runShell, scriptCommand, tail } from './checks'
import type { CheckSpec } from '../../shared/heats'

const dirs: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-heat-checks-'))
  dirs.push(dir)
  return dir
}

function write(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content)
}

const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('packageManager', () => {
  it('is npm when the project has no lockfile', () => {
    expect(packageManager(temp())).toBe('npm')
  })

  it('follows the lockfile in the project', () => {
    for (const [lock, expected] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['bun.lockb', 'bun']
    ] as const) {
      const dir = temp()
      write(dir, lock, '')
      expect(packageManager(dir)).toBe(expected)
    }
  })
})

describe('scriptCommand', () => {
  it('runs the test script plainly and the rest the way each manager expects', () => {
    expect(scriptCommand('npm', 'test')).toBe('npm test')
    expect(scriptCommand('npm', 'typecheck')).toBe('npm run typecheck')
    expect(scriptCommand('bun', 'test')).toBe('bun run test')
    expect(scriptCommand('bun', 'lint')).toBe('bun run lint')
    expect(scriptCommand('pnpm', 'test')).toBe('pnpm test')
    expect(scriptCommand('pnpm', 'build')).toBe('pnpm build')
    expect(scriptCommand('yarn', 'test')).toBe('yarn test')
    expect(scriptCommand('yarn', 'build')).toBe('yarn build')
  })
})

describe('readScripts', () => {
  it('reads the scripts and survives a broken package.json', () => {
    const dir = temp()
    expect(readScripts(dir)).toEqual({})
    write(dir, 'package.json', '{ not json')
    expect(readScripts(dir)).toEqual({})
    write(dir, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest', bad: 3 } }))
    expect(readScripts(dir)).toEqual({ test: 'vitest' })
  })
})

describe('detectChecks', () => {
  it('is empty in a folder with nothing to run', () => {
    expect(detectChecks(temp())).toEqual([])
  })

  it('takes the package.json scripts, test required and the rest guards', () => {
    const dir = temp()
    write(dir, 'package.json', JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .' } }))
    expect(detectChecks(dir)).toEqual([
      { name: 'test', command: 'npm test', kind: 'required' },
      { name: 'typecheck', command: 'npm run typecheck', kind: 'guard' },
      { name: 'lint', command: 'npm run lint', kind: 'guard' }
    ])
  })

  it('uses the package manager of the lockfile', () => {
    const dir = temp()
    write(dir, 'package.json', JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build' } }))
    write(dir, 'pnpm-lock.yaml', '')
    expect(detectChecks(dir).map((c) => c.command)).toEqual(['pnpm test', 'pnpm build'])
  })

  it('finds the other languages', () => {
    const dir = temp()
    write(dir, 'pyproject.toml', '[project]\nname = "x"\n')
    write(dir, 'go.mod', 'module x\n')
    write(dir, 'Cargo.toml', '[package]\nname = "x"\n')
    write(dir, 'Makefile', '.PHONY: build\ntest:\n\tgo test ./...\n')
    expect(detectChecks(dir)).toEqual([
      { name: 'pytest', command: 'pytest', kind: 'required' },
      { name: 'go test', command: 'go test ./...', kind: 'required' },
      { name: 'cargo test', command: 'cargo test', kind: 'required' },
      { name: 'make test', command: 'make test', kind: 'required' }
    ])
  })

  it('finds pytest from pytest.ini and ignores a Makefile without a test target', () => {
    const dir = temp()
    write(dir, 'pytest.ini', '[pytest]\n')
    write(dir, 'Makefile', '.PHONY: build\nbuild:\n\techo build\ntest-other:\n\techo other\n')
    expect(hasMakeTest(dir)).toBe(false)
    expect(detectChecks(dir)).toEqual([{ name: 'pytest', command: 'pytest', kind: 'required' }])
  })

  it('sees a test target with leading spaces', () => {
    const dir = temp()
    write(dir, 'Makefile', 'test:\n\techo hi\n')
    expect(hasMakeTest(dir)).toBe(true)
  })
})

describe('tail', () => {
  it('keeps the last lines and drops the empty end', () => {
    expect(tail('1\n2\n3\n')).toBe('1\n2\n3')
    const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
    const kept = tail(long).split('\n')
    expect(kept).toHaveLength(40)
    expect(kept[0]).toBe('line 21')
    expect(kept[39]).toBe('line 60')
  })
})

describe('runCheck', () => {
  const done: CheckSpec = { name: 'done', command: 'test -f DONE.txt', kind: 'required' }
  const guard: CheckSpec = { name: 'guard', command: 'test -f GUARD.txt', kind: 'guard' }

  it('passes and fails with the exit code of the command', async () => {
    const dir = temp()
    write(dir, 'GUARD.txt', 'guard\n')
    const failing = await runCheck(done, dir, ENV)
    expect(failing.passed).toBe(false)
    expect(failing.exitCode).toBe(1)
    expect(failing.name).toBe('done')
    write(dir, 'DONE.txt', 'done\n')
    const passing = await runCheck(done, dir, ENV)
    expect(passing.passed).toBe(true)
    expect(passing.exitCode).toBe(0)
    expect(passing.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('runs in the folder it is given with the environment it is given', async () => {
    const dir = temp()
    write(dir, 'marker.txt', 'here\n')
    const spec: CheckSpec = { name: 'where', command: 'test -f marker.txt && test "$REGATTA_TEST_ENV" = yes', kind: 'required' }
    expect((await runCheck(spec, dir, { ...ENV, REGATTA_TEST_ENV: 'yes' })).passed).toBe(true)
    expect((await runCheck(spec, dir, ENV)).passed).toBe(false)
  })

  it('keeps only the last lines of a noisy check', async () => {
    const dir = temp()
    const spec: CheckSpec = { name: 'noisy', command: 'i=1; while [ $i -le 60 ]; do echo "line $i"; i=$((i+1)); done', kind: 'guard' }
    const result = await runCheck(spec, dir, ENV)
    expect(result.outputTail.split('\n')).toHaveLength(40)
    expect(result.outputTail.endsWith('line 60')).toBe(true)
  })

  it('reports a command that cannot start as a failure with no exit code', async () => {
    const dir = temp()
    const spec: CheckSpec = { name: 'gone', command: 'definitely-not-a-command-9f2c', kind: 'required' }
    const result = await runCheck(spec, dir, ENV)
    expect(result.passed).toBe(false)
    expect(result.exitCode).toBe(127)
  })
})

describe('runChecks', () => {
  it('runs every check in order even when one fails', async () => {
    const dir = temp()
    write(dir, 'GUARD.txt', 'guard\n')
    const results = await runChecks(
      [
        { name: 'done', command: 'test -f DONE.txt', kind: 'required' },
        { name: 'guard', command: 'test -f GUARD.txt', kind: 'guard' }
      ],
      dir,
      ENV
    )
    expect(results.map((r) => [r.name, r.passed])).toEqual([
      ['done', false],
      ['guard', true]
    ])
  }, 30000)
})

/** True while a process with this id is running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // A process that died but is not reaped yet still answers signal 0; it is not running.
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return stat !== '' && !stat.startsWith('Z')
  } catch {
    return false
  }
}

async function gone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const started = Date.now()
  while (alive(pid)) {
    if (Date.now() - started > timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

function pidIn(dir: string): number {
  return Number(readFileSync(join(dir, 'child.pid'), 'utf8').trim())
}

describe('stopping a command', () => {
  it('leaves no child alive after a timeout', async () => {
    const dir = temp()
    const result = await runShell('sleep 300 & echo $! > child.pid; wait', { cwd: dir, env: ENV, timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull()
    const pid = pidIn(dir)
    expect(await gone(pid)).toBe(true)
  }, 30000)

  it('kills a child that ignores SIGTERM after the grace period, and only then resolves', async () => {
    const dir = temp()
    const started = Date.now()
    const result = await runShell('trap "" TERM; sleep 300 & echo $! > child.pid; wait', { cwd: dir, env: ENV, timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000)
    expect(await gone(pidIn(dir), 2000)).toBe(true)
  }, 30000)

  it('stops a check and its children when the caller cancels', async () => {
    const dir = temp()
    const controller = new AbortController()
    const spec: CheckSpec = { name: 'slow', command: 'sleep 300 & echo $! > child.pid; wait', kind: 'required' }
    const running = runCheck(spec, dir, ENV, { signal: controller.signal })
    for (let i = 0; i < 200 && !(existsSync(join(dir, 'child.pid')) && readFileSync(join(dir, 'child.pid'), 'utf8').trim()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const pid = pidIn(dir)
    expect(alive(pid)).toBe(true)
    controller.abort()
    const result = await running
    expect(result.passed).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(await gone(pid)).toBe(true)
  }, 30000)

  it('does not start a command that was cancelled before it began, and skips the rest of the checks', async () => {
    const dir = temp()
    const controller = new AbortController()
    controller.abort()
    const results = await runChecks(
      [
        { name: 'a', command: 'echo a > a.txt', kind: 'required' },
        { name: 'b', command: 'echo b > b.txt', kind: 'required' }
      ],
      dir,
      ENV,
      { signal: controller.signal }
    )
    expect(results).toEqual([])
    expect(existsSync(join(dir, 'a.txt'))).toBe(false)
  })

  it('stops a background job a finished command left behind', async () => {
    const dir = temp()
    const result = await runShell('sleep 300 & echo $! > child.pid; exit 0', { cwd: dir, env: ENV })
    expect(result.code).toBe(0)
    expect(await gone(pidIn(dir))).toBe(true)
  }, 30000)

  it('keeps the output and the exit code of a normal command', async () => {
    const dir = temp()
    const result = await runShell('echo out; echo err 1>&2; exit 3', { cwd: dir, env: ENV })
    expect(result.code).toBe(3)
    expect(result.output).toContain('out')
    expect(result.output).toContain('err')
    expect(result.timedOut).toBeUndefined()
  })

  it('keeps escalating when the shell dies on SIGTERM but a descendant ignores it, and settles only when the group is gone', async () => {
    const dir = temp()
    const controller = new AbortController()
    // The shell leaves on SIGTERM and closes its output; the child keeps running and ignores SIGTERM.
    // The child writes its pid only once it ignores SIGTERM, so the test never stops it too early.
    const running = runShell(`(trap "" TERM; exec sh -c 'echo $$ > child.pid; exec sleep 300') >/dev/null 2>&1 & wait`, {
      cwd: dir,
      env: ENV,
      signal: controller.signal
    })
    for (let i = 0; i < 400 && !(existsSync(join(dir, 'child.pid')) && readFileSync(join(dir, 'child.pid'), 'utf8').trim()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const pid = pidIn(dir)
    expect(alive(pid)).toBe(true)
    const started = Date.now()
    controller.abort()
    const result = await running
    expect(result.cancelled).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000)
    // Right now, not eventually: nothing of the command may be left when it resolves.
    expect(alive(pid)).toBe(false)
  }, 30000)
})

describe('a command that cannot be stopped', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is reported as stuck by runShell and runCheck, never as cleanly finished', async () => {
    const dir = temp()
    const real = process.kill.bind(process)
    // The command's group ignores every signal sent to it, as an unkillable process would.
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0 && signal !== 0) return true
      return real(pid, signal as NodeJS.Signals)
    }) as typeof process.kill)
    const controller = new AbortController()
    const running = runCheck({ name: 'hang', command: 'echo $$ > shell.pid; sleep 300', kind: 'required' }, dir, ENV, {
      signal: controller.signal,
      supervise: { killGraceMs: 100, giveUpMs: 200 }
    })
    for (let i = 0; i < 400 && !(existsSync(join(dir, 'shell.pid')) && readFileSync(join(dir, 'shell.pid'), 'utf8').trim()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const pid = Number(readFileSync(join(dir, 'shell.pid'), 'utf8').trim())
    controller.abort()
    const result = await running
    expect(result.stuck).toBe(true)
    expect(result.passed).toBe(false)
    vi.restoreAllMocks()
    real(-pid, 'SIGKILL')

    // A command that stops normally says nothing about being stuck.
    const fine = await runShell('true', { cwd: dir, env: ENV })
    expect(fine.stuck).toBeUndefined()
  }, 30000)
})
