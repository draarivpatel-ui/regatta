// Folder questions every engine in main needs answered the same way: is another agent's folder the same
// as mine, inside it, or holding it? Symlinks are resolved for the part of each path that exists, so a
// pane running through /var/... matches a project at /private/var/... (round 2 review, finding 4).

import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * The path with every symlink resolved, up to the deepest part that exists: a folder that is not there
 * yet keeps its own shape (with its existing ancestors resolved), never throwing.
 */
export function canonical(p: string): string {
  const abs = resolve(p)
  const rest: string[] = []
  let cur = abs
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse())
    } catch {
      const up = dirname(cur)
      if (up === cur) return abs
      rest.push(cur.slice(up.length + 1))
      cur = up
    }
  }
}

/**
 * True when two folders are the same, or one is inside the other: an agent working in either one can
 * change files the other will roll back over. Paths are compared in canonical form, so a symlinked
 * folder and the real folder it points at are the same place.
 */
export function related(a: string, b: string): boolean {
  const ca = canonical(a)
  const cb = canonical(b)
  return inside(ca, cb) || inside(cb, ca)
}

/** True when `child` is `parent` or sits inside it (both already canonical absolute paths). */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}
