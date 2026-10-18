// Small formatters for the Storage section.

import { formatBytes } from '../../../lib/bytes'

/** "1.2 GB", "84 MB", or "not measured" when a folder could not be read. */
export function bytesLabel(bytes: number | null): string {
  return bytes === null ? 'not measured' : formatBytes(bytes)
}

/**
 * The size line for a folder Regatta keeps: a folder that does not exist yet (0 bytes) reads
 * "nothing yet", one that exists but could not be read (null) still reads "not measured".
 */
export function storageBytesLabel(bytes: number | null): string {
  if (bytes === null) return 'not measured'
  if (bytes === 0) return 'nothing yet'
  return formatBytes(bytes)
}

/** "18:40" in local time. */
export function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "changed 3 days ago", "changed today", "changed just now", or "no change recorded". */
export function changedLabel(at: number | null, now: number): string {
  if (at === null) return 'no change recorded'
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return 'changed just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `changed ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `changed ${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'changed yesterday'
  if (days < 30) return `changed ${days} days ago`
  const months = Math.floor(days / 30)
  return `changed ${months} month${months === 1 ? '' : 's'} ago`
}

/** Strips the Electron IPC wrapper off a thrown error, leaving the message the user should read. */
export function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/**
 * The command a user can run themselves to remove one worktree. Regatta never runs it.
 * Inside double quotes the shell still interprets backslash, double quote, dollar and backtick,
 * so those four get a backslash.
 */
export function removeCommand(repo: string, path: string): string {
  const quote = (value: string): string => `"${value.replace(/[\\"$`]/g, '\\$&')}"`
  return `git -C ${quote(repo)} worktree remove ${quote(path)}`
}

/** "up to 84 MB", or "not measured" when du could not read the folder. */
export function upToBytesLabel(bytes: number | null): string {
  return bytes === null ? 'not measured' : `up to ${formatBytes(bytes)}`
}

/** "moved 3 days ago", "moved just now", or the raw timestamp when it cannot be parsed. */
export function movedLabel(iso: string, now: number): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'moved at unknown time'
  return changedLabel(ms, now).replace(/^changed /, 'moved ')
}

/** One line telling what moving leftovers to trash did: how many folders moved and how many were kept in place. */
export function removalResult(moved: number, kept: number): string {
  const worktrees = (n: number): string => `${n} ${n === 1 ? 'worktree' : 'worktrees'}`
  const head = moved === 0 ? 'Nothing was moved to trash.' : `Moved ${worktrees(moved)} to Regatta's trash.`
  if (kept === 0) return head
  const tail = kept === 1 ? '1 was kept, its reason is shown above.' : `${kept} were kept, their reasons are shown above.`
  return `${head} ${tail}`
}
