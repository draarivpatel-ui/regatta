// RelayService against a fake session manager: schedules, cancels and the carry-over brief.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LimitInfo, SessionInfo } from '../shared/types'
import type { SessionManager } from './sessions'
import { RelayService } from './relay-service'

interface Written {
  id: string
  text: string
  fromUser: boolean
}

/** A SessionManager stand-in: sessions in a map, writes recorded, no pty, no Electron. */
function fakeSessions(
  sessions: SessionInfo[],
  created: SessionInfo[] = [],
  emitted: (LimitInfo | null)[] = []
): SessionManager & { written: Written[]; dismissed: string[] } {
  const map = new Map(sessions.map((s) => [s.id, s]))
  const manager = {
    written: [] as Written[],
    dismissed: [] as string[],
    onUserInput: null as ((id: string) => void) | null,
    get: (id: string) => map.get(id),
    lastPrompt: (id: string) => map.get(id)?.title === 'ask-me' ? 'fix the failing auth test' : '',
    screenText: (id: string) => (map.has(id) ? 'Test Agent 1.0\n> fix the tests\nDone. 21 tests pass.' : ''),
    size: (id: string) => (map.has(id) ? { cols: 120, rows: 30 } : { cols: 100, rows: 30 }),
    write: (id: string, data: string, fromUser = true) => {
      manager.written.push({ id, text: data, fromUser })
    },
    dismissLimit: (id: string) => {
      const info = map.get(id)
      manager.dismissed.push(id)
      if (!info) return
      info.limit = null
      emitted.push(null)
    },
    create: async (opts: { agent: string; cols: number; rows: number; cwd?: string }) => {
      const info: SessionInfo = {
        id: 'new01',
        agent: opts.agent as SessionInfo['agent'],
        title: 'codex',
        cwd: opts.cwd ?? '/tmp',
        command: 'codex',
        args: [],
        createdAt: Date.now(),
        pid: 1,
        status: { state: 'starting', since: Date.now(), reason: 'launched', source: 'process' },
        exitCode: null,
        signals: 'notify',
        worktree: null,
        branch: null,
        limit: null,
        transcriptPath: null,
        account: null
      }
      map.set(info.id, info)
      created.push(info)
      // The new pane leaves "starting" a moment later, like a real agent does.
      setTimeout(() => {
        info.status = { state: 'working', since: Date.now(), reason: 'launched', source: 'process' }
      }, 20)
      return info
    }
  }
  return manager as unknown as SessionManager & { written: Written[]; dismissed: string[] }
}

function session(id: string, limit: LimitInfo | null): SessionInfo {
  return {
    id,
    agent: 'fake',
    title: 'ask-me',
    cwd: '/tmp',
    command: 'node',
    args: [],
    createdAt: 0,
    pid: 1,
    status: { state: 'waiting', since: 0, reason: 'hit its usage limit', source: 'output' },
    exitCode: null,
    signals: 'output',
    worktree: null,
    branch: null,
    limit,
    transcriptPath: null,
    account: null
  }
}

const LIMIT: LimitInfo = { text: "You've hit your usage limit.", resetsAt: 1_000_000, resumeScheduled: false }

describe('RelayService: resume at reset', () => {
  it('marks the session scheduled and types continue when the reset time comes', async () => {
    const emitted: (LimitInfo | null)[] = []
    const s = fakeSessions([session('aaa', LIMIT)], [], emitted)
    const relay = new RelayService({ sessions: s, emitLimit: (_id, limit) => emitted.push(limit) })
    relay.resumeLater('aaa')
    expect(s.get('aaa')?.limit?.resumeScheduled).toBe(true)
    expect(emitted.at(-1)?.resumeScheduled).toBe(true)

    await new Promise((done) => setTimeout(done, 150))
    expect(s.written.map((w) => w.text)).toEqual(['continue', '\r'])
    expect(s.written.every((w) => w.fromUser === false)).toBe(true)
    expect(s.get('aaa')?.limit?.resumeScheduled).toBe(false)
  })

  it('refuses to schedule without a reset time', () => {
    const s = fakeSessions([session('aaa', { text: 'usage limit reached', resetsAt: null, resumeScheduled: false })])
    const relay = new RelayService({ sessions: s, emitLimit: () => undefined })
    expect(() => relay.resumeLater('aaa')).toThrow(/did not say when its limit resets/)
  })

  it('cancels a scheduled resume and forgets a dismissed card', () => {
    const emitted: (LimitInfo | null)[] = []
    const s = fakeSessions([session('aaa', LIMIT)], [], emitted)
    const relay = new RelayService({ sessions: s, emitLimit: (_id, limit) => emitted.push(limit) })

    relay.resumeLater('aaa')
    relay.cancel('aaa')
    expect(s.get('aaa')?.limit?.resumeScheduled).toBe(false)
    expect(s.get('aaa')?.limit?.text).toBe(LIMIT.text)

    relay.cancel('aaa')
    expect(s.get('aaa')?.limit).toBeNull()
    expect(emitted.at(-1)).toBeNull()
  })

  it('cancels the schedule when the user types in the pane', async () => {
    const s = fakeSessions([session('aaa', LIMIT)])
    const relay = new RelayService({ sessions: s, emitLimit: () => undefined })
    relay.resumeLater('aaa')
    s.onUserInput?.('aaa')
    expect(s.get('aaa')?.limit?.resumeScheduled).toBe(false)
    // The card itself stays: only the waiting was cancelled.
    expect(s.dismissed).toHaveLength(0)
    await new Promise((done) => setTimeout(done, 30))
    expect(s.written).toHaveLength(0)
  })
})

describe('RelayService: continue in another agent', () => {
  it('refuses the plain shell', async () => {
    const s = fakeSessions([session('aaa', LIMIT)])
    const relay = new RelayService({ sessions: s, emitLimit: () => undefined })
    await expect(relay.continueIn('aaa', 'shell')).rejects.toThrow(/not the Terminal/)
  })

  it('builds the brief, opens a new pane and clears the old limit', async () => {
    const created: SessionInfo[] = []
    const emitted: (LimitInfo | null)[] = []
    const s = fakeSessions([session('aaa', LIMIT)], created, emitted)
    const relay = new RelayService({ sessions: s, emitLimit: (_id, limit) => emitted.push(limit) })

    const info = await relay.continueIn('aaa', 'codex')
    expect(info.id).toBe('new01')
    expect(info.agent).toBe('codex')
    expect(created[0]?.cwd).toBe('/tmp')
    // The old pane forgets its limit, so its card goes away.
    expect(s.get('aaa')?.limit).toBeNull()
    expect(emitted.at(-1)).toBeNull()

    await new Promise((done) => setTimeout(done, 150))
    const typed = s.written.map((w) => w.text).join('')
    expect(typed).toContain('Continuing work that Test Agent started. It stopped at its usage limit.')
    expect(typed).toContain('What the user asked last:\nfix the failing auth test')
    expect(typed).toContain('The end of its screen:\nTest Agent 1.0')
    expect(typed).toContain('Carry on from here.')
    expect(typed.endsWith('\r')).toBe(true)
  })

  it('ignores inherited git routing variables when reading status and diff for the brief', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'regatta-relay-repo-'))
    const decoy = mkdtempSync(join(tmpdir(), 'regatta-relay-decoy-'))
    const savedDir = process.env['GIT_DIR']
    const savedTree = process.env['GIT_WORK_TREE']
    try {
      for (const dir of [repo, decoy]) {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
        writeFileSync(join(dir, 'base.txt'), 'one\n')
        execFileSync('git', ['add', 'base.txt'], { cwd: dir })
        execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: dir })
      }
      writeFileSync(join(repo, 'base.txt'), 'two\n')
      writeFileSync(join(repo, 'session-file.txt'), 'real work\n')
      writeFileSync(join(decoy, 'decoy-file.txt'), 'wrong repo\n')

      process.env['GIT_DIR'] = join(decoy, '.git')
      process.env['GIT_WORK_TREE'] = decoy

      const from = { ...session('aaa', LIMIT), cwd: repo }
      const s = fakeSessions([from])
      const relay = new RelayService({ sessions: s, emitLimit: () => undefined })
      await relay.continueIn('aaa', 'codex')
      await new Promise((done) => setTimeout(done, 150))
      const typed = s.written.map((w) => w.text).join('')
      expect(typed).toContain('session-file.txt')
      expect(typed).toContain('base.txt')
      expect(typed).not.toContain('decoy-file.txt')
    } finally {
      if (savedDir === undefined) delete process.env['GIT_DIR']
      else process.env['GIT_DIR'] = savedDir
      if (savedTree === undefined) delete process.env['GIT_WORK_TREE']
      else process.env['GIT_WORK_TREE'] = savedTree
      rmSync(repo, { recursive: true, force: true })
      rmSync(decoy, { recursive: true, force: true })
    }
  })
})
