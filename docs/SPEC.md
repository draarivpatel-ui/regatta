# Regatta: product spec

Regatta is a free, open-source desktop app (macOS first, then Windows and Linux) for people who run
several AI coding agents at once. It runs the agent CLIs the user already has (Claude Code, Codex,
Gemini CLI, Grok, Cursor Agent, OpenCode, Copilot CLI, Kimi CLI, Qwen Code, Amp, Aider, or a plain
shell) in real terminals, side by side, and makes three things easy: seeing which agent needs you,
sending work to many agents, and keeping only the work that passes your checks.

Regatta never calls an AI service itself and never adds a markup. The agents use the user's own
accounts and subscriptions.

## Window

- Title bar: logo and name, a workspace sidebar toggle, five mode tabs in the middle (Agents, Code,
  Chat, Flows, Video), and on the right: Skipper, Search (Cmd+K), a menu, the workspace avatar,
  the Inbox bell with a count of agents waiting on you, and the right sidebar toggle.
- Cmd+1 to Cmd+5 switch modes. Every mode stays alive in the background.

## Code mode (phase 1)

- **Toolbar:** pane count and layout menu; Inbox button (amber with a count when something
  waits); a group of panel toggles (Files, Find, Preview, Thread, Flows, Device); Dictate, Broadcast,
  and the accent "New pane" button.
- **Status strip** under the toolbar: counts per state ("1 needs you · 2 working · 1 quiet") and
  total memory used by agents.
- **Grid:** 1 to 16 panes. Layouts: Two + preview, Single, Side by side, Four, Six, Nine, Twelve,
  Sixteen. Until the user picks a layout, the grid grows with the number of panes. Layouts that
  would make panes too small at the current window size are shown dimmed. Text size: Auto,
  Comfortable, Compact, Dense.
- **Pane:** header with agent badge, short name, status chip (state and time in it), a "basic
  signals" note for agents that only offer their screen, the folder name; actions: menu (copy
  everything shown, clear, restart, stop the process, close), maximize, add a pane, close. Body is a
  real terminal. A pane that needs you gets an amber border and glow. A finished pane shows a small
  bar with Restart and Close.
- **Fleet sidebar** (right): every agent grouped by "Waiting on you", "Working", "Quiet",
  "Ready for a prompt", "Finished", with the reason and how long ago; clicking focuses the pane.
  Its other tab is **Preview**: a small browser for the app being built (URL bar, back, forward,
  reload, Desktop / Tablet / Phone sizes).
- **Inbox:** slides in from the right. Every session, most urgent first, with the reason, the
  folder and an Open button that jumps to the pane. "Close finished" removes ended panes.
- **Broadcast:** a dialog with a message box and a checkbox per live session. Agents receive it as a
  prompt, shells as a command. If two or more chosen agents share one folder, a note warns they may
  edit the same files and suggests a crew with worktrees. The send button says how many sessions it
  will reach. Cmd+Enter sends.
- **New pane menu:** every installed agent with its version, Terminal, the agents not found on this
  computer (dimmed), "Start a crew…", "Change project folder".
- **Start a crew:** pick agents and how many of each, optionally isolate each one in its own git
  worktree and branch so they cannot overwrite each other, then start them all.
- **Files:** a tree of the project with a filter box; opening a file shows it in an editor with
  save (Cmd+S). Hidden heavy folders (.git, node_modules) are skipped.
- **Find:** search the whole project (ripgrep when available), results grouped by file with line
  numbers; clicking opens the file at that line.
- **Quick actions (Cmd+K):** one searchable list of every command: switch mode, start any agent,
  pick a layout, open Inbox, Broadcast, Settings, panels, change folder.
- **Settings:** sections General, Appearance, Agents, Skills, Plugins, MCP, Usage, Notifications,
  Dictation, Remote, Storage, Labs, Account. Phase 1 makes General, Appearance, Agents and
  Notifications real; the rest explain what is coming.
- **Notifications:** when an agent starts needing you, or finishes, while Regatta is in the
  background, a desktop notification says which one and why; clicking it opens that pane.
- **Shortcuts:** Cmd+K quick actions, Cmd+B broadcast, Cmd+I inbox, Cmd+, settings, Cmd+T new pane
  menu, Cmd+W close the focused pane, Cmd+Enter maximize or restore, Cmd+[ and Cmd+] previous and
  next pane, Cmd+Shift+F find.

## Phase 2: trust the result

- **Heats:** two to four agents take the same task, each in its own worktree. Regatta first runs
  the project's checks on the untouched code (the baseline). Each lane shows agent, phase, time,
  live diff size, tokens where reported, and check results. Gates decide the winner: finished,
  changed something, required checks pass, no regressions against the baseline, and integrity (a
  lane that deletes or weakens tests is disqualified). Ties go to the faster lane. One click merges
  the winner and cleans up the other worktrees and branches.
- **Checkpoints:** before every agent step Regatta records the files the step will touch. Rolling
  back a step restores exactly those files, keeps anything the user edited since, and never moves
  HEAD, the index or branches. Redo is available right after.
- **Skipper:** describe a task; Skipper suggests which agent should lead and which backs it up
  (based on what the task involves and the user's preference for balance, quality or speed), runs
  the checks after each attempt, and hands the work to the backup if the leader gets stuck.
- **Approvals:** agent requests to write files or run commands appear as cards; nothing changes
  until approved.

## Phase 3: more ways to work

- **Agents mode:** long-lived crew members with a name, instructions, skills and memory. Chat with
  them; their write requests come as approval cards.
- **Chat mode:** conversations through Claude Code or Codex in headless mode, with account, model,
  reasoning and mode pickers.
- **Flows mode:** a brief, ready-made recipes, a trigger, and a left-to-right pipeline of up to 16
  steps (agent steps, check steps, approval steps) with an inspector; runs are saved.

## Phase 4: cost and limits

- **Budgets and usage:** per-agent usage from each CLI's own reports, daily budgets that stop a
  run before it overspends, and a loop guard that stops a run repeating the same failing step.
- **Relay:** when an agent hits its usage limit, offer to wait for the reset or continue now in
  another agent with a written brief of the work so far.
- **Accounts:** several sign-ins per CLI (work, personal), a default, and a choice per pane.
- **Night watch:** queue tasks for the night; each runs in its own worktree, counts as ready only if
  checks pass, is never pushed, and comes with a morning report.

## Phase 5

Dictation (speak into a pane or composer, never auto-sent), Video (an agent builds a launch video in
code), an MCP server so other tools can drive Regatta, remote SSH, themes, then a full polish pass.
