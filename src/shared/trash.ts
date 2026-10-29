// The states a Regatta trash entry is listed in, shared by the main process (git-ops.ts) and Settings > Storage
// (TrashBlock.tsx), so a reworded state can never fall through to a plain error in the renderer.
// Package: trash-4 (docs/tasks/trash-4.md, docs/design/safety.md mechanism 2).

/** An entry whose folder or `entry.json` is not the shape Regatta made: never repaired, never emptied. */
export const ALTERED_TRASH_ENTRY = 'altered, left alone'
/** The worktree was moved out of its entry: Regatta leaves it and its git records alone. */
export const MOVED_OUT_TRASH_ENTRY = 'moved out of the trash; Regatta leaves it and its git records alone'
/** A copy of the worktree the user restored elsewhere (or put back at its original path) uses its git folder now. */
export const REATTACHED_TRASH_ENTRY = 're-attached elsewhere, left alone'
/** An Empty trash that deleted this entry's worktree folder was interrupted; the next one finishes it. */
export const UNFINISHED_TRASH_ENTRY = 'unfinished; Empty trash finishes it'
