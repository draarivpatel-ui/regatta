// The render process's own cleanup: run with electron mocked, since only `app.exit` is reached here.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const exit = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ app: { exit }, BrowserWindow: class {}, screen: {} }))

const { finish, runFfmpeg } = await import('./render-child')

const dir = mkdtempSync(join(tmpdir(), 'regatta-render-child-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('render process cleanup', () => {
  it('stops a running ffmpeg measurement or mastering pass when the render is stopped (sol-loop S9)', async () => {
    const pidFile = join(dir, 'pid')
    // Stands in for ffmpeg: says its pid, then runs far longer than the test.
    const run = runFfmpeg('/bin/sh', ['-c', `echo $$ > '${pidFile}'; exec sleep 30`])
    let pid = 0
    await vi.waitFor(() => {
      pid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(pid).toBeGreaterThan(0)
    })
    expect(alive(pid)).toBe(true)

    finish(1)

    const ended = await Promise.race([run, new Promise<'still running'>((done) => setTimeout(() => done('still running'), 3000))])
    expect(ended).not.toBe('still running')
    expect(alive(pid)).toBe(false)
    expect(exit).toHaveBeenCalledWith(1)
  })
})
