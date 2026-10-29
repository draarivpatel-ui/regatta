// Types shared by the main process, the preload bridge and the renderer.

export type AgentKind =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'cursor'
  | 'aider'
  | 'opencode'
  | 'qwen'
  | 'amp'
  | 'shell'
  | 'fake'

/** How Regatta learns what an agent is doing. */
export type SignalSource = 'hooks' | 'notify' | 'output'

export interface AgentDefinition {
  kind: AgentKind
  /** Display name, for example "Claude Code". */
  name: string
  /** Short lowercase name shown in pane headers, for example "claude". */
  short: string
  /** Executable to run. Empty for the user's shell. */
  command: string
  args: string[]
  /** Two letter mark drawn in our own badge style. */
  monogram: string
  /** Badge color (hex). */
  color: string
  /** Best signal this agent offers. "output" means Regatta reads the terminal only. */
  signals: SignalSource
  /** Hidden from menus unless running tests. */
  internal?: boolean
}

export interface DetectedAgent extends AgentDefinition {
  installed: boolean
  path: string | null
  version: string | null
}

export type SessionState =
  | 'starting' // launched, nothing heard yet
  | 'working' // producing output or reported busy
  | 'waiting' // asked the user something (approval, y/n)
  | 'idle' // finished its turn, ready for a prompt
  | 'quiet' // no signal for a while; unknown, never assumed finished
  | 'done' // process exited with code 0
  | 'failed' // process exited with an error

export interface SessionStatus {
  state: SessionState
  /** Epoch ms when this state began. */
  since: number
  /** Human readable reason, for example "Claude hook: Stop". */
  reason: string
  source: 'hook' | 'output' | 'process' | 'input' | 'timer'
}

export interface SessionInfo {
  id: string
  agent: AgentKind
  title: string
  cwd: string
  command: string
  args: string[]
  createdAt: number
  pid: number | null
  status: SessionStatus
  exitCode: number | null
  signals: SignalSource
  worktree: string | null
  branch: string | null
  /** Set when the agent hit its usage limit (see docs/design/phase4.md, Relay). */
  limit: LimitInfo | null
  /** Claude Code's transcript file for this session, from its hook payloads. */
  transcriptPath: string | null
  /** The sign-in this pane runs with (an AccountInfo id); null for agents without accounts. */
  account: string | null
}

/** A sign-in for Claude Code or Codex. The computer's own sign-in has the id "<cli>:system". */
export interface AccountInfo {
  id: string
  cli: 'claude' | 'codex'
  name: string
  /** The folder used as CLAUDE_CONFIG_DIR or CODEX_HOME; null for the computer's own sign-in. */
  dir: string | null
  isDefault: boolean
  /** True when the CLI's files in that folder show a sign-in, false when not, null when unknown. */
  signedIn: boolean | null
  /** The account's email when the CLI recorded one. */
  email: string | null
}

export interface LimitInfo {
  /** The line on screen that reported the limit. */
  text: string
  /** Epoch ms when the limit resets, when the agent said. */
  resetsAt: number | null
  /** Set when the user chose to resume automatically at reset. */
  resumeScheduled: boolean
}

export interface CreateSessionOptions {
  agent: AgentKind
  cols: number
  rows: number
  cwd?: string
  title?: string
  /** Extra arguments appended after the agent's defaults. */
  args?: string[]
  /** Run in a new git worktree of the workspace, on its own branch. */
  isolate?: boolean
  /** An AccountInfo id; absent means the default sign-in for that CLI. */
  account?: string | null
}

/** Start several agents at once (a "crew"). */
export interface LaunchSetOptions {
  agents: { kind: AgentKind; count: number }[]
  isolate: boolean
  cols: number
  rows: number
}

export interface FileEntry {
  name: string
  /** Path relative to the workspace root, with forward slashes. */
  path: string
  kind: 'file' | 'dir'
  size: number | null
}

export interface FileContent {
  path: string
  /** The project folder it was read from: saving is refused once another project is open. */
  root: string
  content: string
  size: number
  /** True when the file looks binary; content is then empty. */
  binary: boolean
  /** True when the file is over the read limit; content is then empty. */
  tooLarge: boolean
}

export interface SearchQuery {
  text: string
  regex?: boolean
  caseSensitive?: boolean
  /** Maximum matches returned. Default 500. */
  limit?: number
}

export interface SearchMatch {
  path: string
  line: number
  column: number
  text: string
}

export interface SearchResult {
  matches: SearchMatch[]
  truncated: boolean
  engine: 'rg' | 'git-grep' | 'node'
}

export interface GitChange {
  path: string
  /** Two-letter porcelain status, for example " M", "??", "A ". */
  status: string
}

export interface GitStatus {
  branch: string | null
  changes: GitChange[]
}

export interface WorktreeInfo {
  path: string
  branch: string
}

/** One changed file in the Git panel, from `git status --porcelain=v1 -z`. */
export interface GitFileChange {
  path: string
  /** The old path of a rename or copy. */
  from: string | null
  /** Index letter (X): what is staged. ' ' when nothing is staged, '?' when untracked. */
  staged: string
  /** Work tree letter (Y): what is not staged yet. */
  unstaged: string
}

/** What the Git panel shows for one folder (the project, or the worktree a pane runs in). */
export interface GitOverview {
  cwd: string
  branch: string | null
  detached: boolean
  hasCommits: boolean
  /** "merge", "rebase", "cherry-pick", "revert" or "sequencer" while one is in progress, or "unknown" when the
   *  state could not be read; committing is then off. */
  busy: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileChange[]
  /**
   * Hooks a commit would run, such as "pre-commit" or "commit-msg (lint)" (the Git panel does not run
   * hooks, so it refuses to commit while any exist). Absent when git could not be asked.
   */
  hooks?: string[]
}

export interface GitDiff {
  path: string
  staged: boolean
  /** Unified diff text. Empty when binary or too large. */
  text: string
  binary: boolean
  tooLarge: boolean
  untracked: boolean
}

export interface GitCommit {
  hash: string
  subject: string
  author: string
  /** Epoch ms. */
  at: number
}

export interface GitWorktree {
  path: string
  branch: string | null
  head: string
  /** The repository's main working folder. */
  main: boolean
  /** Created by Regatta (inside its worktrees folder). */
  regatta: boolean
}

export interface Prefs {
  notifications: boolean
  quietAfterSec: number
  confirmClosePane: boolean
  /** A theme id from src/shared/themes.ts, or "system" to follow macOS light or dark. */
  theme: string
  /** A custom accent color (#rrggbb), or null for the theme's own. */
  accent: string | null
  /** Early features, each off until turned on in Settings > Labs. */
  labs: { video: boolean; board: boolean; anywhere: boolean }
  /** True once the first-run welcome sheet was closed. */
  welcomeSeen: boolean
}

export interface MemorySample {
  id: string
  rssBytes: number
}

export interface WorkspaceInfo {
  root: string
  name: string
  recent: string[]
}

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  home: string
  hookPort: number | null
}

/** A server saved in Settings > Servers. */
export interface SshServer {
  id: string
  /** Display name, for example "Build box". */
  name: string
  /** Host name, address, or a Host alias from ~/.ssh/config. */
  host: string
  user: string | null
  port: number | null
  /** The host key fingerprint the user accepted, for example "SHA256:abc...". */
  trusted: string | null
  lastTest: { ok: boolean; at: number; message: string } | null
}

export type NewSshServer = Pick<SshServer, 'name' | 'host' | 'user' | 'port'> & { id?: string }

/** What a server offered when asked for its host keys, compared with what is already known. */
export interface HostKeyScan {
  keys: { type: string; fingerprint: string }[]
  /** Against ~/.ssh/known_hosts: every offered key known, a key differs, or no entry. */
  knownHosts: 'match' | 'mismatch' | 'unknown'
  /** Against the fingerprint saved in Regatta. */
  saved: 'match' | 'mismatch' | 'none'
  /** Why no keys came back, when none did. */
  error: string | null
}

/** A service CLI (GitHub, Stripe, ...) and whether it is signed in. Settings > Services. */
export interface ServiceStatus {
  id: 'gh' | 'glab' | 'stripe' | 'wrangler' | 'supabase' | 'vercel' | 'shopify'
  /** For example "GitHub CLI". */
  name: string
  installed: boolean
  version: string | null
  /** "unknown" when the CLI has no safe way to tell, or the check failed. */
  signedIn: 'yes' | 'no' | 'unknown'
  /** Account name or email when the CLI says it. */
  account: string | null
  /** One short line on how this was decided, for example "gh auth status" or "No status command". */
  detail: string
  checkedAt: number
}

/** One kind of data Regatta keeps, for Settings > Storage. */
export interface StorageItem {
  id: 'worktrees' | 'checkpoints' | 'conversations' | 'nights' | 'videos' | 'models' | 'accounts'
  label: string
  path: string
  /** Total size, or null when it could not be measured. */
  bytes: number | null
}

/** A worktree Regatta made that nothing uses anymore. */
export interface LeftoverWorktree {
  path: string
  /** The repository it belongs to, when git can tell. */
  repo: string | null
  branch: string | null
  bytes: number | null
  /** Newest change inside it, epoch ms. */
  changedAt: number | null
  /** True when nothing is running inside it and its identity is intact, so it can move to Regatta's trash. */
  removable: boolean
  /** Why it is kept, in a sentence for the user. Null when it is removable. */
  reason: string | null
}

/** One retired worktree inside <worktreesDir>/.regatta-trash/<entryId>/<name>. */
export interface TrashEntry {
  entryId: string
  entryPath: string
  trashPath: string
  originalPath: string
  root: string
  branch: string | null
  identity: string | null
  /** ISO timestamp from entry.json. */
  movedAt: string
  keepRef: string
  repaired: boolean
  repairError?: string | null
  /** Upper bound from `du -sk`, shown as "up to <size>". */
  bytes: number | null
  /** Program names running inside the entry right now. */
  inUse: string[]
  changedSinceMoved: 'no' | 'yes' | 'unknown'
  emptyError?: string | null
  lastEmptyError?: string | null
}

export interface EmptyTrashEntryReport {
  entryId: string
  entryPath: string
  originalPath: string
  trashPath: string
  branch: string | null
  status: 'deleted' | 'skipped' | 'error'
  reason: string | null
  keepRef?: string
  branchDeleted?: boolean
  branchParked?: string
  branchOutcome?: string | null
}

export interface EmptyTrashResult {
  report: StorageReport
  outcomes: EmptyTrashEntryReport[]
}

export interface StorageReport {
  items: StorageItem[]
  leftovers: LeftoverWorktree[]
  trash: TrashEntry[]
  scannedAt: number
}

export interface LicenseNotice {
  name: string
  version: string
  license: string
}

/** An iOS simulator from `xcrun simctl list devices available -j`. */
export interface SimDevice {
  udid: string
  name: string
  /** For example "iOS 26.0". */
  runtime: string
  state: 'Booted' | 'Shutdown' | 'Booting' | 'ShuttingDown' | string
}

/** One entry of an agent conversation, read from the CLI's own transcript. */
export interface ThreadMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
  at: number | null
}
