# Design: Checkpoints (roll back one agent step)

Every agent step leaves a checkpoint. Rolling a step back restores exactly the files that step
changed, keeps anything the user edited since, and never touches the project's own HEAD, index or
branches. Redo puts the step's version back.

## Storage

A private shadow repository per workspace at `~/.regatta/checkpoints/<sha1(workspace path) first 12>/`.
All commands run with `GIT_DIR=<shadow>/git`, `GIT_WORK_TREE=<session cwd>` and
`GIT_INDEX_FILE=<shadow>/index`, so the project's `.git` is never read or written. The project's
`.gitignore` rules still apply. `snapshot(label)` is `git add -A` then
`git commit --allow-empty --no-verify -m <label>` and returns the commit sha.

## Steps

A step is one turn of one session.

- Agents with hooks (Claude Code): start on `UserPromptSubmit` (the payload's prompt becomes the step
  label), end on `Stop`.
- Other agents: start when the user presses Enter in the pane, end when the status leaves `working`.
- On start: `start = snapshot("step start")`. On end: `end = snapshot("step end")`, then
  `files = git diff --numstat start end` (renames count as delete plus add). Steps with no files are
  dropped.
- `Step { id, sessionId, agent, label, startedAt, endedAt, start, end, files: { path, added, removed }[] }`,
  kept in memory and in `<shadow>/steps.json` (last 200 per workspace).

## Roll back

For each file in the step:

| Current content | Action |
|---|---|
| equals the content at `end` (or both absent) | write the content at `start` (delete if it did not exist): "rewound" |
| differs from `end` | leave it: "kept: you edited it since" |

Before writing, take `pre = snapshot("before roll back")` so nothing is ever lost. After writing,
read every rewound file back and compare bytes; any mismatch is reported. The result lists each file
with its action and line counts. **Redo** applies the same rule in reverse (content at `start` goes
back to `end`) for the files that were rewound.

## IPC

`checkpoints:list (sessionId) -> Step[]`, `checkpoints:rollback (stepId) -> RollbackResult`,
`checkpoints:redo (stepId) -> RollbackResult`, event `checkpoints:changed { sessionId }`.

## UI

Pane menu item "Checkpoints…" opens a slide-over for that pane: steps newest first (label, time,
files and +/- totals). "Roll back" opens a confirmation listing what will be rewound and what will
be kept; the result card shows "Rewound 3 of 4 files +21 -25", each file with a "rewound" or
"kept: you edited it since" badge, a note that HEAD, the index and branches were not touched, and a
Redo button.
