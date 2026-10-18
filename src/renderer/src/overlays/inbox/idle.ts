// Which panes "Close idle" removes: the ones ready for a prompt (idle) or already done.
// Waiting, working, quiet and failed panes stay. Pure so it can be unit tested.

import type { SessionInfo, SessionState } from '@shared/types'

const CLOSABLE: SessionState[] = ['idle', 'done']

export function idleOrDone(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.filter((s) => CLOSABLE.includes(s.status.state))
}
