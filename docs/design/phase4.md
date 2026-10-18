# Design: phase 4 (cost and limits)

Five features that keep agents productive and inside the user's limits. All local: Regatta reads what
each CLI already records on this computer and never calls a provider's API itself.

## 1. Relay (keep going when an agent hits its usage limit)

- **Detect:** the status engine watches each pane's screen for usage limit messages, for example
  "usage limit reached", "You've hit your session limit", "rate limit exceeded", with an optional reset
  time ("resets 6:30pm", "try again in 2h 10m"). The session goes to `waiting` with the reason
  "Hit its usage limit (resets 6:30 PM)".
- **Card** in the pane: "Claude Code hit its usage limit. It resets at 6:30 PM." with two choices:
  - "Resume at 6:30 PM": when the time comes, type `continue` and Enter into the pane (a timer that
    survives the pane being hidden; cancelled if the user types in the pane first).
  - "Continue now in <other agent>": open a new pane with the chosen agent in the same folder and send
    a carry-over brief built from records, not from a model: the last prompt the user sent, the files
    changed since the session started (`git status` and `git diff --stat`), and the last 40 lines of
    the pane's screen. The brief ends with "Carry on from here."
- Shown in the Inbox like any other waiting session.

## 2. Accounts (several sign-ins per CLI)

- Claude Code reads `CLAUDE_CONFIG_DIR`, Codex reads `CODEX_HOME`. An account is a folder under
  `~/.regatta/accounts/<cli>/<name>/` used as that variable. "Your computer sign-in" is the default
  folder (variable unset).
- Settings > Agents lists accounts per CLI with "Add account" (name it, then a pane opens running the
  CLI with that folder so the user signs in the CLI's own way), "Make default", and "Remove".
- The pane header shows an account picker for agents with accounts; switching restarts the pane with
  the chosen account. New panes use the default.

## 3. Usage

- Claude Code records each session in `~/.claude/projects/<folder>/<session>.jsonl`; Codex in
  `~/.codex/sessions/**/rollout-*.jsonl`. Regatta reads the files for sessions it started (from hook
  payloads' `transcript_path`, headless results, and Codex session ids) and adds up input and output
  tokens per agent per day. Codex files also carry live rate limits (percent of the 5-hour and weekly
  windows used, and reset times): the newest one is shown as "Live limits from Codex".
- Settings > Usage: this month per agent (runs, tokens measured, a small daily bar chart), and live
  limits where reported. Agents that report nothing say "Not reported by this CLI".

## 4. Budgets and the loop guard

- A daily token budget per agent (off by default). Headless runs (heat lanes, flow steps, Skipper,
  Night watch) that would pass the budget are stopped before their next turn, with the reason shown.
  Chat turns and panes are warned, never blocked.
- Loop guard: a headless run that repeats the same failing check, or the same failing command line, 3
  times in a row is stopped with the evidence ("Stopped: npm test failed the same way 3 times").

## 5. Night watch (overnight queue)

- A queue of tasks (prompt, agent, checks). "Start tonight at" a time, or "Start now".
- Each task runs alone in its own worktree as one heat lane (same runner, same gates). A task is
  "ready" only if every gate passes; failed tasks keep their evidence. Nothing is ever pushed or merged
  automatically, and the user's own branch is never touched.
- While it runs, Regatta keeps the Mac awake (only on power), and the window can be closed to the menu
  bar but the app must stay open.
- Morning report: per night, each task's result, time, diff size and checks, with "Merge" (as in heats),
  "Open in a pane" (a pane in that worktree) and "Discard".

## 6. Schedules

Run a flow or a crew member's prompt every N hours or daily at a time while the app is open. Results
land in the flow's run history or the crew member's conversation.
