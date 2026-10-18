import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '@shared/types'
import { liveSessions, sendLabel, sharedFolders, sharedWarning, targetLabel } from './select'

function session(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    agent: 'claude',
    title: 'claude',
    cwd: '/work/regatta',
    command: 'claude',
    args: [],
    createdAt: 0,
    pid: 1,
    status: { state: 'idle', since: 0, reason: 'ready', source: 'output' },
    exitCode: null,
    signals: 'hooks',
    worktree: null,
    branch: null,
    limit: null,
    transcriptPath: null,
    account: null,
    ...over
  }
}

describe('liveSessions', () => {
  it('keeps sessions that are still running', () => {
    const all = [
      session({ id: 'a' }),
      session({ id: 'b', status: { state: 'done', since: 0, reason: 'exited', source: 'process' } }),
      session({ id: 'c', status: { state: 'failed', since: 0, reason: 'exited with code 3', source: 'process' } })
    ]
    expect(liveSessions(all).map((s) => s.id)).toEqual(['a'])
  })
})

describe('sharedFolders', () => {
  it('finds a folder two non-shell sessions share', () => {
    const all = [
      session({ id: 'a' }),
      session({ id: 'b' }),
      session({ id: 'c', agent: 'claude', cwd: '/work/other' })
    ]
    const folders = sharedFolders(all)
    expect(folders).toHaveLength(1)
    expect(folders[0]!.name).toBe('regatta')
    expect(folders[0]!.sessions.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('never counts shells, and never reports a folder used once', () => {
    const all = [session({ id: 'a', agent: 'shell' }), session({ id: 'b', agent: 'shell' }), session({ id: 'c', agent: 'shell' })]
    expect(sharedFolders(all)).toEqual([])
    expect(sharedFolders([session({ id: 'solo' })])).toEqual([])
  })

  it('reports the busiest folder first', () => {
    const all = [
      session({ id: 'x1', cwd: '/work/x' }),
      session({ id: 'x2', cwd: '/work/x' }),
      session({ id: 'y1', cwd: '/work/y' }),
      session({ id: 'y2', cwd: '/work/y' }),
      session({ id: 'y3', cwd: '/work/y' })
    ]
    expect(sharedFolders(all).map((f) => f.name)).toEqual(['y', 'x'])
  })
})

describe('sharedWarning', () => {
  it('names the folder and offers worktrees', () => {
    const [folder] = sharedFolders([session({ id: 'a' }), session({ id: 'b' })])
    expect(sharedWarning(folder!)).toBe(
      '2 agents share regatta, so they may edit the same files. A crew with worktrees keeps them apart.'
    )
  })
})

describe('labels', () => {
  it('counts sessions in the send button', () => {
    expect(sendLabel(0)).toBe('Send to 0 sessions')
    expect(sendLabel(1)).toBe('Send to 1 session')
    expect(sendLabel(3)).toBe('Send to 3 sessions')
  })

  it('counts live sessions in the heading', () => {
    expect(targetLabel(1)).toBe('1 live session')
    expect(targetLabel(2)).toBe('2 live sessions')
  })
})
