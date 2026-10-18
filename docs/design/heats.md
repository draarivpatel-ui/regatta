# Design: Heats (agents race on one task)

A heat gives the same task to two to four agents, each in its own git worktree, then lets the
project's own checks decide which change to keep. Nothing reaches the user's branch until they merge.

## Flow

1. **Form** (in the Skipper view): task text; agents (2 to 4 checkboxes from installed agents);
   checks (detected, editable list of `name` + `command`, each marked required or guard); a setup
   step for each worktree (default: a copy-on-write clone of the project's `node_modules` if present, never a link, so nothing run in a worktree can touch the user's dependencies; where cloning is impossible the worktree gets none and a note says to install there); time limit per
   lane (default 10 minutes); "Let agents run commands without asking" (off by default).
2. **Preconditions:** the workspace is a git repository with at least one commit. Uncommitted
   changes in the user's folder are not included (warn and show the count).
3. **Baseline:** record `base = HEAD`. Create a worktree at `base`, run setup, run every check,
   store the results, remove the worktree. A required check that already passes at baseline is fine
   (the task may be a refactor); the gates compare against it.
4. **Lanes:** (a project opened as a subfolder runs its agents, baseline and checks in the same subfolder of each worktree) for each agent create worktree `heat-<id>-<agent>` on branch
   `regatta/heat-<id>-<agent>`, run setup, then run the agent headless with the task (see Runner).
   While it runs, every 2 seconds record `git diff --shortstat` against `base` (live diff), the
   last line of activity, and tokens when the agent reports them. Enforce the time limit.
5. **Lane end:** when the agent exits (or is stopped), commit everything in the lane worktree
   (`git add -A`, author "Regatta <regatta@localhost>", message "Heat <id>: <agent>") if there are
   changes (the worktree's own `node_modules` is left out), then run every check in a temporary
   worktree at the committed tip, so the lane's own folder stays exactly as committed.
6. **Decide** with the gates below once every lane has ended.
7. **Merge** (user clicks): through `mergeIntoCurrentBranch` (see `docs/design/safety.md`). The
   target branch and HEAD are captured when the user clicks; the merge refuses if they changed, if a
   merge, rebase, cherry-pick or revert is in progress, or if tracked files have uncommitted changes.
   The winner's tested commit (not its branch name) is merged: by a fast-forward when HEAD is still
   `base`, otherwise a merge commit built in a temporary detached worktree and then fast-forwarded
   into. The user's folder only ever sees `git merge --ff-only --no-overwrite-ignore`, so git
   refuses rather than overwrite an untracked or ignored file. Then every lane worktree is moved to
   Regatta's trash through `trashOwnedWorktree` (after its commits are parked at
   `refs/regatta/discarded/<heat id>/<lane>`; its branch stays checked out there until you empty the
   trash in Settings > Storage, which deletes the trashed folder, its worktree git folder, and its
   branch through `deleteOwnedBranch`).
   **Discard** asks first, then moves every lane worktree to Regatta's trash the same way.

## Gates (pure function, unit tested)

| Gate | Passes when |
|---|---|
| finished | the agent exited with code 0 before the time limit |
| changed | the lane changed at least one file |
| checks | every required check passes in the lane |
| no-regressions | every guard check that passed at baseline still passes |
| integrity | no test file was deleted, and no test file has fewer test cases or assertions than at baseline |

Test files: paths matching `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, or inside `test/`,
`tests/`, `__tests__/`, `spec/`. Test cases: occurrences of `it(`, `test(`, `def test_`, `func Test`.
Assertions: `expect(`, `assert`. Counting is done on the file text at `base` and in the lane.

**Decision:** eligible lanes pass every gate. None eligible: "No lane passed every gate" with each
lane's first failed gate. Otherwise sort eligible lanes by agent time. If the second fastest
finished within 20% of the fastest, it is a tie between every lane inside that band and the user
picks; otherwise the fastest wins. The decision note says why, for example "Claude Code wins:
every gate passed and it finished in 28 s, outside the 20% band of Codex (46 s)."

## Runner (headless agents)

`runAgent({ agent, prompt, cwd, env, allowCommands, signal })` streams lines and resolves with
`{ exitCode, durationMs, tokens }`.

| Agent | Command |
|---|---|
| Claude Code | `claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits` (`bypassPermissions` when commands are allowed). Tokens from the final `result` event's usage. |
| Codex | `codex exec --json -s workspace-write <prompt>` (add `--approve-for-me` when commands are allowed). Tokens from token count events. |
| Grok | `grok --cwd <dir> <prompt>` (add `--always-approve` when commands are allowed). |
| OpenCode | `opencode run --dir <dir> <prompt>` (add `--auto` when commands are allowed). |
| Gemini CLI | `gemini -p <prompt> --approval-mode auto_edit` (`yolo` when commands are allowed). |
| Test agent | `node scripts/fake-agent.mjs --headless` with the task on stdin; behavior set by `REGATTA_FAKE_SCENARIO` (`good`, `slow`, `no-change`, `delete-tests`, `fail`, `break-guard`). |

Adapters live in one table so a new agent is one entry. Every child gets stdin from `/dev/null`
unless it reads the prompt from stdin, and every child is killed when the heat is cancelled.

## Data (`src/shared/heats.ts`)

`HeatState { id, task, root, base, createdAt, status, checks, baseline, lanes, decision }`,
`LaneState { id, agent, worktree, branch, phase, startedAt, endedAt, exitCode, durationMs, timedOut,
diff: { files, added, removed }, tokens, latest, checks, gates, error }`,
`Decision { kind: 'winner' | 'tie' | 'none', laneIds, note }`.
Phases: queued, preparing, running, checking, done. Heat status: baseline, racing, decided, merged,
cancelled, error.

## UI (Skipper view, Heat tab)

A header with the task and status badge ("Racing · 3 lanes", "Decided · 3 lanes · 48 s"); the
baseline line ("Baseline on a1b2c3d: test failing (3) · typecheck passing · lint passing"); a lane
table (position, agent, phase, elapsed, live diff +/-, tokens, one dot per check, latest activity);
when decided, a result card (winner or tie or none, the note, and "Merge <agent>'s change" with a
preview line such as "Fast-forward main by 1 commit, +10 -1 in 1 file. 3 worktrees will move to
Regatta's trash."); and a gate scorecard per lane on expand.

## Hand off (Skipper's lead and backup)

The same engine runs a **hand-off**: agents take turns, each continuing from the previous attempt's
result. `HeatState.mode` is `'race'` (above) or `'handoff'`.

**Rule: no agent ever writes to a folder it did not create.** Every attempt is a race lane of its own,
in a fresh worktree, so a folder the user may have touched is never handed to another agent. (Three review rounds of a shared-worktree design each found a new way a comparison of the folder could
miss user work; this rule removes the hand-over instead of guarding it.)

- **Form** (Skipper view, "Hand off" tab): the goal; checks (detected ones plus presets build, test,
  typecheck, lint, or a command); who leads, chosen by a preference: Balanced, Quality or Speed.
  Regatta suggests an order from rules (a fixed ranking per preference, adjusted by this project's
  history: an agent that won or finished hand-offs here moves up, one that failed moves down) and
  the user can reorder. "Agents Skipper may use": every installed agent, or only the ones picked.
  Attempts: 1 to 4 (one per agent in order). A time limit per attempt (default 15 minutes) and
  overall (none, 30, 60 or 120 minutes). "Ask me before each new attempt" (off by default).
- **Run:** baseline as for a race. Attempt 1 is a lane exactly like a race lane: its own worktree and
  branch (`regatta/heat-<id>-a1`) at `base`. When it ends: commit, run the checks, evaluate the gates.
  Every gate passes: done, that attempt is the winner. Otherwise, if attempts remain:
  - If the user changed attempt N's worktree while it waited, commit those changes there first
    (commitAll, "Your changes after attempt N"). Whatever a commit cannot save (ignored files, index
    flags, nested repositories) stays in attempt N's worktree, which no agent writes to again; when
    the heat is merged or discarded, it moves to Regatta's trash with everything in it intact.
  - Attempt N+1 is a new lane: a new worktree and branch (`regatta/heat-<id>-a<N+1>`) at attempt N's
    latest commit. The agent gets the goal plus the evidence, all read from commits (never from a live
    folder): which gates failed and why, the failing checks' last 40 lines, `git diff --stat` from
    `base` to attempt N's commit, and the previous agent's last 20 lines.
  - With "Ask me", the heat waits (`status: 'waiting'`) for Continue or Stop before creating the next
    lane. No attempts left: decided with no winner, keeping the evidence.
  Each attempt is a `LaneState` (in order) with `attempt` numbers.
- **Merge** the winning attempt's tested tip exactly as a race winner (its history holds the earlier
  attempts). **Discard** moves every attempt's lane worktree to Regatta's trash through the race lane
  path, with keep commits.
- **Solo:** a hand-off with one attempt and no backup. Tasks use it.

## Tasks (Agents mode > Automate > Tasks)

A task is a tracked outcome handed to an agent or a crew member that comes back for review.

- `Task { id, title, prompt, assignee: { kind: 'agent', agent } | { kind: 'crew', teammateId },
  backups: AgentKind[], checks, status, heatId, createdBy: 'you' | 'mcp' | 'crew', createdAt,
  updatedAt, note }`. Status: `todo`, `running`, `review` (a winner is waiting), `failed`,
  `stopped`, `done`.
- **Run** starts a hand-off heat: the assignee's agent leads (a crew member's instructions and
  skills are put before the prompt), backups follow. The task follows its heat: racing or waiting
  is running; decided with a winner is review; decided with none is failed; cancelled is stopped;
  merged is done. **Mark done** without merging is allowed (only a person marks a task done).
- **Add to tonight** puts the task in Night watch's queue (same prompt, agent and checks).
- MCP clients and crew members may create tasks (`createdBy`), which wait in To do; they never start
  one.
