import { describe, expect, it } from 'vitest'
import type { SessionInfo, SessionState } from '@shared/types'
import { idleOrDone } from './idle'

function session(id: string, state: SessionState): SessionInfo {
  return {
    id,
    agent: 'claude',
    title: id,
    cwd: '/work/regatta',
    command: 'claude',
    args: [],
    createdAt: 0,
    pid: 1,
    status: { state, since: 0, reason: state, source: 'output' },
    exitCode: null,
    signals: 'hooks',
    worktree: null,
    branch: null,
    limit: null,
    transcriptPath: null,
    account: null
  }
}

describe('idleOrDone (Inbox "Close idle")', () => {
  it('keeps only ready (idle) and finished (done) panes', () => {
    const all = [
      session('ready', 'idle'),
      session('finished', 'done'),
      session('needs-you', 'waiting'),
      session('working', 'working'),
      session('starting', 'starting'),
      session('silent', 'quiet'),
      session('crashed', 'failed')
    ]
    expect(idleOrDone(all).map((s) => s.id)).toEqual(['ready', 'finished'])
  })

  it('returns nothing when every pane still needs attention', () => {
    const all = [session('a', 'waiting'), session('b', 'working'), session('c', 'quiet'), session('d', 'failed')]
    expect(idleOrDone(all)).toEqual([])
  })

  it('a failed pane is not "finished": it stays so the user can read why', () => {
    const all = [session('ok', 'done'), session('bad', 'failed')]
    expect(idleOrDone(all).map((s) => s.id)).toEqual(['ok'])
  })
})
