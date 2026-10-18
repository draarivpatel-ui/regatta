# Design: Flows (multi-step pipelines)

A flow chains up to 16 steps from left to right. Each step hands its result to the next. Runs are
saved so the user can see what each step delivered.

## Steps

| Kind | What it does | Passes when |
|---|---|---|
| agent | runs an agent headless (same runner as heats) with the step's prompt | the agent exits with code 0 |
| check | runs a shell command (`/bin/sh -c`) | the command exits with code 0 |
| approval | pauses the run until the user approves or stops it | the user approves |

An agent step's prompt is a template: `{{brief}}` becomes the flow's brief and `{{previous}}` the
previous step's output (its last 60 lines of activity or command output). A step that fails stops the
run (`failed`); later steps become `skipped`.

## Where it runs

In the workspace folder by default. "Run in its own worktree" creates one worktree for the whole run
(branch `regatta/flow-<run id>`), so a run never touches the user's files until they merge it; the
run's result card then offers "Merge the run's changes" (fast-forward or merge commit, like heats)
and "Discard".

A project opened from a folder below the top of its repository works at the matching folder of the
worktree, so the files an agent writes land in the project folder when the run is merged.

A merge goes into whatever branch the folder has checked out at the moment "Merge the run's changes"
is clicked (recorded then, and checked again right before anything is written), not necessarily the
branch the run started from. When that is a different branch, or one that has moved on, the merge
brings that branch's own history along with the run's commit, and the commits the run started from
that the branch does not have yet.

The checks of an isolated run run in a temporary copy of the run's committed work, never in the run's
folder. A check that changes tracked files or commits there fails, whatever its exit code, because
its changes would not be part of what is merged. Merge and Discard move the run's folder to Regatta's
trash (`<worktreesDir>/.regatta-trash/<entry>/<name>`) instead of deleting it, and keep its branch in
place until the user empties the trash in Settings > Storage. Before the folder moves, a keep commit
under `refs/regatta/discarded/` is made that holds the run's commits (its first parent is the tip),
whoever else holds them. What is trashed or kept stays on the run with the reason (its notes). The note
for a kept copy gives a command that can be pasted into a shell as it is, with a real branch name:
`git branch flow-<run id>-restored <ref>^1` restores the work (`-2`, `-3` and so on when a branch of
that name is already in the repository or another kept copy of the run suggested it), and `git log <ref>`
shows everything kept. A folder where programs could not be stopped is held: it is not removed.

A flow cannot be deleted while a run of it is starting (counted from the moment Run flow is
clicked, because making the worktree takes as long as the user's hooks take), running or waiting, or
still holds a worktree, a branch or a held folder: the run's card, its merge and its discard hang on
the flow. Discard or merge the run first.

`git worktree add` runs the user's own post-checkout hook, and a hook that exits with an error makes
git report a failure with the worktree (and any file the hook wrote) and the branch left in place; a
checkout that fails leaves the branch. What git left is the run's: it is recorded as owned (with the
folder's identity if it can be read, otherwise the folder is kept in place), the run fails at its first
step without any agent starting, and Discard moves the folder to Regatta's trash like any other run's
folder. For the temporary folder of a check, the check fails without running and the temporary folder
is removed with `git worktree remove --force`, or held when that cannot be done.

Each worktree of an isolated run (the run's own folder, and the temporary folder of every check) gets
its own copy-on-write clone of the project's `node_modules`, never a link, so an agent or a check that
runs `npm ci` or `rm -rf node_modules` cannot reach the user's own dependencies, and agents can run the
project's tests. The clone sits at the top of the worktree, where Node finds it from any folder below.
Where cloning is impossible the folder gets none, and the run's notes say to install there.

## Recipes

Ready-made flows the user can start from (each just fills the brief placeholder and the steps):

- Build a feature: agent Claude Code "Plan how to {{brief}}. List the files to change." (read),
  agent Codex "Implement this plan: {{previous}}", check `npm test`, approval "Review the change".
- Fix a bug: agent "Find the cause of: {{brief}}", agent "Fix it and add a regression test", check
  `npm test`.
- Review a release: agent "Review the changes since the last tag for bugs and risky edits", approval.
- Launch a landing page: agent "Build a landing page: {{brief}}", check `npm run build`, approval.
- Add sign-in: agent "Plan sign-in for this app", agent "Implement it", check `npm test`, approval.

## Data (`src/shared/flows.ts`)

`Flow { id, name, brief, trigger: 'manual', isolate, steps: FlowStep[], createdAt, updatedAt }`,
`FlowStep { id, kind, title, agent, prompt, command }`,
`FlowRun { id, flowId, flowName, status: running | waiting | done | failed | stopped, worktree,
branch, isolated, steps: StepRun[], startedAt, endedAt, mergeSummary, notes }`,
`StepRun { stepId, status: pending | running | waiting | done | failed | skipped, output, exitCode,
startedAt, endedAt }`.
`isolated` is the flow's worktree switch as it was when the run started, and stays true after the
worktree and branch are gone (runs saved before the field existed read as isolated when they own a
worktree or a branch). Flows save to `<dataDir>/flows.json`, runs to `<dataDir>/flow-runs/<id>.json`
(newest 50, plus any run that still owns something).

## UI (Flows mode)

Left: "Flows" list with a new flow button. Main: the studio. Top: name, saved state, delete, and an
accent "Run flow" button. Then "The brief" (textarea), "Start from a recipe" chips, a trigger select
(Manual for now), and the pipeline: a "Start" node then step cards connected by arrows, each card
with "Step 01", a status pill, an icon for the agent or kind, the title, a one-line role ("Coding agent
· Claude Code", "Check · npm test", "Approval"), and a plus between cards to insert a step. A right
inspector edits the selected step (title, kind, agent, prompt with the two placeholders explained,
command). During a run each card shows its live status and a peek at its output; a waiting approval
step shows Approve and Stop. A run history list sits under the pipeline.
