// One structural git operation at a time per repository: worktree creation, merges and cleanup.

import { realpathSync } from 'node:fs'
import { gitCommonDir } from './git-ops'

const queues = new Map<string, Promise<void>>()

/**
 * The name a repository is locked under: its canonical git common dir, so the repository root, a
 * folder inside it and every linked worktree of it all share one lock. Fails closed: when the
 * identity cannot be read this throws, because falling back to the folder itself would give the
 * same repository two locks and let two operations run at once.
 */
export async function repoLockKey(folder: string): Promise<string> {
  let dir: string
  try {
    dir = await gitCommonDir(folder)
  } catch (err) {
    throw new Error(`Could not tell which repository ${folder} belongs to, so nothing was done. ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    // The native form gives the folder's own spelling, so "Repo" and "repo" on a case-insensitive volume are one lock.
    return realpathSync.native(dir)
  } catch (err) {
    throw new Error(`Could not resolve the repository folder of ${folder}, so nothing was done. ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Runs `task` after every earlier task for the same repository settled. A failure never blocks the
 * next task. Rejects without running `task` when the repository identity cannot be read.
 */
export async function withRepoLock<T>(folder: string, task: () => Promise<T>): Promise<T> {
  const key = await repoLockKey(folder)
  const run = (queues.get(key) ?? Promise.resolve()).then(task)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}
