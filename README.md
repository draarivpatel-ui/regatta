# Regatta

Regatta is a free, open-source (MIT) desktop app for macOS that runs several AI coding agents at the
same time. It opens the agent CLIs you already have, installed and signed in your own way, in real
terminals side by side, shows which one needs you, and helps you keep only the work that passes your
own checks. It is for developers who want two or more agents working at once without losing track of
them or overwriting their own repository. Regatta adds no AI service and no extra charge: the agents use
your accounts. It is built on Electron 44 and was tested on macOS 27 on Apple silicon; Electron 44
runs on macOS 13 and later, but older macOS versions have not been tried.

> Status: early (version 0.1.0). The features that change your repository (Heats, Checkpoints, Night
> watch, Flows, and Spot fix) are marked Beta. Read [Safety](#safety) before using them on work you
> care about.

## Walkthrough Video

<video src="docs/demo-720p.mp4" controls preload="metadata" width="100%"></video>

[Download 1080p60 Walkthrough & Release v0.1.0 on GitHub](https://github.com/draarivpatel-ui/regatta/releases/tag/v0.1.0)

## Features

Grouped the way the app is used. Names are the ones on screen. The first time Regatta
opens, a three-step welcome shows which agent CLIs were found, how pane status works, and how
to start. It shows once; Settings > General can show it again.

### Code with agents

- Pane grid: up to 16 agents in real terminals, each with a live status. An agent that gives no
  signal is shown as quiet or with limited status, never guessed as done.
- Layouts: pick 1 to 16 panes from a picture, or a pair of panes beside the Preview. Layouts that
  cannot fit stay listed with the reason. Start a crew, several agents at once, each in its own git
  worktree if you like.
- Inbox: every session across projects, the ones that need you first. Click a row to jump to it.
- Fleet: a sidebar showing what every agent is doing, most urgent first.
- Broadcast: one prompt or command to several panes at once; it reports how many received it.
- Preview: a browser for the app you are building, beside the panes, with its own storage.
- Simulator: list, boot, and screenshot iOS simulators, and open the full Simulator. Needs Xcode.
- Files, Find, and the Git panel: read and edit files, search the project, and see a diff, stage,
  and commit. The Git panel never runs your git hooks and never contacts a remote.
- Crew: long-lived agents with a role, instructions, skills, and memory; they ask before editing.
- Chat: plan in conversation with files and images as context, with model, effort, and access
  pickers. Conversations are kept. Edits wait for your approval unless you grant write access.

### Trust the result

- Heats (Beta): two to four agents race on the same task in separate worktrees; your own tests, type
  checks, and linters pick the winner; nothing merges until you click.
- Checkpoints (Beta): every agent turn is recorded so you can roll back exactly what it changed,
  keeping anything you edited since.
- Spot fix (Beta): point at something in the Preview and say what should change; Claude Code edits
  your project with file tools only, you see before and after, and Undo rolls it back exactly. Your
  checks run only when you click Run checks.
- Skipper hand-off and Solo: give a goal and checks, pick who leads and which agents may help.
  Agents take turns, each in its own worktree and branch; when one fails, the next continues with
  the evidence. Solo is a hand-off with one attempt and no backup. Nothing merges until you click.

### Run unattended

- Night watch (Beta): queue tasks for the night; each runs alone in a copy, counts as ready only if
  checks pass, never touches your branch, and leaves a morning report.
- Flows (Beta): up to 16 steps that hand their result along, with approval steps that wait for you.
  Runs are saved.
- Schedules: run a crew member's prompt or a flow on a timer while Regatta is open.
- Tasks: a tracked outcome handed to an agent or a crew member that comes back for your review.
  Running one starts a hand-off with the assignee leading and the backups following; only you mark
  it done. A task can join tonight's night watch.
- Board (Labs, off by default): one board with columns for waiting, running, to review, and done.
  Cards follow real runs, and only you move a card to Done.

### Cost and limits

- Usage: tokens per agent from each CLI's own records, with estimates labeled and live limits where
  the CLI reports them.
- Budgets and loop guard: a daily token budget per agent, measured from what each CLI reports.
  Background runs past their budget do not start, or stop when they pass it; Chat and panes only warn.
  A run whose agent fails the same command the same way three times is stopped, with the evidence.
- Relay: at a usage limit, resume at the reset or continue now in another agent with a brief built
  from your last prompt and the folder's git status and diff.
- Accounts: several sign-ins per CLI, a default, and a choice per pane or conversation.

### Voice

- Dictation: a shortcut starts and stops dictation; the words land in the composer or terminal as a
  draft, never sent or run until you do it. Uses a local whisper.cpp model; audio is not kept.
- Dictate anywhere (Labs, off by default): types dictation into the app in front of you, never into
  a password field and never with Return. Needs microphone and Accessibility permission.

### Video

- Video (Labs, off by default): an agent writes a short launch video in code from the project's own
  look; preview it scene by scene and render an MP4 locally.

### Connect and extend

- MCP server: other tools can see the project, the panes and their output, the crew, heats, and
  schedules, run a schedule, and search the project, over a local endpoint protected by a per-install
  token. Off until you turn it on.
- Agent tools: add a command you trust as an MCP server for Claude Code and Codex; Regatta runs it
  once to show its tools before you turn it on.
- Skills: reusable instructions that are included whenever a skill is assigned to a crew member.
- Service CLIs: one place to check the sign-in status of service CLIs you use.
- Servers (SSH): save a server, verify its host key fingerprint, and test the connection.
- Themes: ten themes with matching terminal colors, and a custom accent that keeps text readable.

## Safety

Regatta works on your own repositories, so the engines that write to them (Heats, Checkpoints, Night
watch, Flows, the Git panel, and Settings > Storage) are held to one rule, written in
`docs/design/safety.md`: ordinary use, including your own git commands and edits while Regatta works,
must never lose work that git cannot give back. When Regatta is unsure, it keeps things and tells you
why. A leftover branch, a leftover worktree, or a refused merge is fine; silently losing a commit or
overwriting an uncommitted change is not. Each of these engines is tested against real git
repositories and real processes, with tests written to try to make it lose work.

To keep that promise, Regatta does these things:

- Before it moves a worktree into its trash or deletes a branch, it keeps every commit it could be
  the last holder of under `refs/regatta/discarded/`. Nothing committed is dropped.
- A finished lane worktree is never deleted by Regatta. It is moved, whole and unchanged,
  into Regatta's trash (`.regatta-trash` inside its worktrees folder) in one step. Programs still
  writing there keep writing into it, git keeps knowing it, and its branch stays. Only you delete
  it, with Empty trash in Settings > Storage, which lists each entry and skips folders a program
  is using.
- It merges only the tested commit, and only when your branch and commit have not moved since you
  asked, no merge or rebase is in progress, and you have no uncommitted tracked changes. Otherwise
  it refuses and says why.
- The Git panel never runs your hooks and never contacts a remote. In a repository with commit hooks
  it refuses to commit and tells you to use a terminal. Regatta's own automatic git calls run
  sandboxed: they never run your hooks or filters and never fetch.
- Checkpoints record each agent turn, so a rollback restores exactly what that step changed and keeps
  anything you edited afterward.

### Restoring kept work

Whenever Regatta keeps a copy, the note in the app gives the exact commands to run. In general, to
restore the work as a branch:

```
git branch <new-name> refs/regatta/discarded/<name>^1
```

and to see everything that was kept under that ref:

```
git log refs/regatta/discarded/<name>
```

Anything kept is also listed, with its reason, in Settings > Storage. Regatta's trash lives
there too: each entry shows its original path, branch, size, and when it was moved, and Empty
trash is the only way anything there is deleted.

### Known limitations

From the threat model and the safety tests. Where Regatta is unsure it keeps things, so most of
these mean "you clean this up yourself", never "your work is gone".

Everywhere:

- Not defended: deliberately changing Regatta's own refs (`refs/regatta/*`, `refs/heads/regatta/*`),
  its data files, or its temporary worktrees while it works; `refs/replace` objects; symbolic refs
  aimed into Regatta's namespace; a process id being reused during the few seconds Regatta waits for
  a process to stop; and sub-second races between a check and the git command right after it where
  git has no atomic form.
- Programs that detach themselves on purpose can outlive a stop or a quit. Their folder still moves
  to Regatta's trash, and they keep writing into it there; Empty trash skips it while they run.
- macOS only. Checks for programs using a folder rely on macOS `lsof`. Linux and Windows are not
  supported.

Heats, Night watch, and Flows:

- They work from committed content. Uncommitted changes in your folder are not copied into a lane.
- Each worktree gets its own copy-on-write clone of your `node_modules`. Edits you make inside that
  provided copy go to the trash with the worktree and are deleted when you empty the trash. When the copy cannot be made (not an APFS
  volume, or a `node_modules` that links outside the project, as `npm link` does), install
  dependencies in the worktree yourself.
- The merge commit is built away from your folder without running your hooks and is not signed. The
  fast-forward into your folder then runs your post-merge hook, as any `git merge` would. Creating a
  worktree runs your post-checkout hook, as `git worktree add` does. If a hook fails and leaves files
  behind, the worktree moves to Regatta's trash with everything in it, never deleted blindly.
- Regatta's trash grows until you empty it in Settings > Storage. Lane worktrees are never
  deleted automatically. A worktree that cannot be moved into the trash, for example one on
  another volume, stays where it is, with the reason.
- In a repository with a clean or process filter such as Git LFS, Regatta does not commit files
  that filter covers: a lane, night task, flow, or hand-off whose changes include such files stops
  and says why. Changes to other files are committed as usual.
- A repository whose git filter or config hook has `=` or a line break in its name is refused by the
  features that run git for you, because git's `-c` setting cannot switch such a filter off.
- Heats do not resume after a restart. Night watch marks a night missed if Regatta was closed when it
  was due and puts its tasks back in the queue. Interrupted Flows reload as stopped.
- Plain (not isolated) Flows run directly in your folder. Worktree isolation is not a security
  sandbox: agents and checks have your permissions.

Checkpoints:

- Bounded history, not a backup: by default the newest 200 steps per workspace.
- Git's ignore rules apply. Dependency and build folders are always left out, as are files over the
  default 50 MiB limit.
- Steps that overlap in time in one folder are never rolled back. Turn boundaries for agents without
  reliable hooks are inferred from terminal status, so an inferred boundary may be imprecise.
- Files you edited after a step, files a program may be writing, and files with extended attributes
  or a resource fork (other than the ones macOS adds itself) are kept, not rolled back.
- Recreating a missing regular file needs hard-link support, and rollback and redo refuse when their
  journal cannot be flushed to disk.

Git panel:

- It never runs git hooks and never fetches. In a partial clone, fetch missing files from a terminal.
- Binary diffs and diffs over 1 MB are not shown. Commits have a time limit; after a timeout, check
  the history before trying again, because the commit may already exist.
- Reads skip fsmonitor, external diffs, text conversion, and signature checks. Clean filters and your
  commit-signing program run as they do in a terminal.
- Commits refuse when a merge, rebase, cherry-pick, or revert is in progress, and when staged changes
  reach outside the folder you opened.

Spot fix (Beta):

- It edits your project folder directly, not a separate worktree, so your running app updates. Each agent
  round and each check pass is a checkpoint step, and Undo rolls them back newest first.
- Only Claude Code is offered, in restricted mode with only file tools (no shell, no MCP servers), and it
  cannot read `.env` files or write under `.git`, `.husky`, `.claude`, build and dependency folders, or
  Regatta's own Spot fix folder. Other agent CLIs cannot be held to file-only tools.
- Checkpoints' rules apply: other ignored files and files over 50 MiB are not recorded and are not
  reverted by Undo.
- Do not edit the same files while a round or a check pass runs. Edits you make after a round are kept by
  Undo, which then stops before older rounds that touched them.
- Checks never run on their own. When you click Run checks and confirm, they run in your project folder
  with your permissions, including any code or config the agent changed (the card lists those files).
- A round interrupted by a crash or a forced quit reloads as stopped, and Undo stops at it.

Dictate anywhere (Labs):

- Needs microphone and Accessibility permission and a local whisper.cpp model.
- Types into the app in front after transcription, which may differ from the app you started in. It
  refuses password fields and Regatta itself. Control characters become spaces and Return is never
  pressed, but an interrupted delivery can leave partial text, so review the field before retrying.

## Privacy

Nothing about your repositories leaves your Mac. Regatta has no account, runs no server on the
internet, and has no telemetry or analytics; there is no code that reports usage or errors anywhere.

What does talk to the network, and why:

- The agent CLIs themselves reach their own services. That is your CLIs and your sign-ins, not
  Regatta.
- Dictation can make one download, the whisper.cpp speech model, the first time you use it. Audio is
  turned into text locally and not kept.
- Two small servers listen on this Mac only (127.0.0.1): the receiver for agent status hooks, and
  Regatta's MCP endpoint, which is off until you turn it on. Both need a per-install token.
- The Preview pane and the Video renderer load whatever address you open or build.
- Settings > Servers connects to a server you add when you scan its host key or test it, and
  Settings > Services runs your service CLIs (for example `gh auth status`), which ask their services.
- An agent tool you verify runs the command you gave, which may use the network.

Regatta reads what the CLIs record on your Mac, and what they print, to show status and usage.

## Install and build

Requirements:

- macOS on Apple silicon. Tested on macOS 27; Electron 44 supports macOS 13 and later, but older
  versions have not been tried.
- Node.js 22.12 or newer (the minimum that Electron 44 and the build tools require) and npm.
- The agent CLIs you want to use, installed and signed in the usual way, plus git.
- Optional: Xcode for the Simulator panel, whisper.cpp (`brew install whisper-cpp`) for dictation,
  and ffmpeg (`brew install ffmpeg`) for video.

From a clone of the repository:

```
npm ci          # install dependencies and download the Electron binary
npm run dev     # run the app in development mode
npm run build   # bundle the app into out/
npm run start   # run the bundled app from out/
npm run dist    # build an ad-hoc signed arm64 DMG and zip in dist/
```

The `npm run dist` output is ad-hoc signed, not signed with an Apple Developer ID, and not
notarized, because the project has no paid Apple developer account. An app you build on your own Mac
opens normally. A copy someone downloaded carries the quarantine flag, so open it the first time with
right click then Open, or clear the flag with `xattr -dr com.apple.quarantine /Applications/Regatta.app`.
See `docs/PACKAGING.md`.

## Tests

```
npm test            # unit tests (vitest)
npm run typecheck   # TypeScript type check
npm run check       # type check plus unit tests
npm run e2e         # end-to-end tests: builds the app, then drives it with Playwright
```

The end-to-end tests run Regatta against a fake home folder and stand-in agent CLIs, so they never read
your real sign-ins or start a real agent.

## Documentation

- [docs/SPEC.md](docs/SPEC.md): what the product does, mode by mode.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): main process, preload bridge, renderer.
- [docs/DESIGN.md](docs/DESIGN.md): visual design and wording rules.
- [docs/design/safety.md](docs/design/safety.md): the safety rules for engines that touch repositories.
- [docs/PACKAGING.md](docs/PACKAGING.md): how the macOS app is built and opened.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The safety bar for the repository-touching engines is
[docs/design/safety.md](docs/design/safety.md); changes that merge into, delete from, or clean up a
user's repository need extra care and tests against real git.

## License

MIT. See [LICENSE](LICENSE). The licenses of the open-source packages bundled into the app are listed
under Settings > About.
