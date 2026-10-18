// Pure rules behind the Broadcast dialog: who can receive a message, and which folders collide.

import { basename } from '../../lib/format'
import type { SessionInfo } from '@shared/types'

/** Sessions still running. Ended sessions cannot receive anything. */
export function liveSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.filter((s) => s.status.state !== 'done' && s.status.state !== 'failed')
}

export interface SharedFolder {
  cwd: string
  /** Last path part, shown in the note. */
  name: string
  sessions: SessionInfo[]
}

/**
 * Non-shell sessions that share a folder, so they may edit the same files.
 * Shells run commands rather than edits, so they never count.
 */
export function sharedFolders(sessions: SessionInfo[]): SharedFolder[] {
  const byCwd = new Map<string, SessionInfo[]>()
  for (const s of sessions) {
    if (s.agent === 'shell') continue
    const list = byCwd.get(s.cwd)
    if (list) list.push(s)
    else byCwd.set(s.cwd, [s])
  }
  const out: SharedFolder[] = []
  for (const [cwd, list] of byCwd) {
    if (list.length < 2) continue
    out.push({ cwd, name: basename(cwd), sessions: list })
  }
  return out.sort((a, b) => b.sessions.length - a.sessions.length || a.cwd.localeCompare(b.cwd))
}

/** The note under a shared folder, for example "2 agents share regatta, so they may edit the same files." */
export function sharedWarning(folder: SharedFolder): string {
  return `${folder.sessions.length} agents share ${folder.name}, so they may edit the same files. A crew with worktrees keeps them apart.`
}

/** The send button label, for example "Send to 3 sessions". */
export function sendLabel(count: number): string {
  return count === 1 ? 'Send to 1 session' : `Send to ${count} sessions`
}

/** Summary of what is checked, for the list heading, for example "3 live sessions". */
export function targetLabel(count: number): string {
  return count === 1 ? '1 live session' : `${count} live sessions`
}
