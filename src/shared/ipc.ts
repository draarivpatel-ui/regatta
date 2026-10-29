// The IPC contract. Every channel between main and renderer is declared here first.
// Runtime channel lists keep the preload bridge closed to anything not declared.

import type { CheckSpec, HeatState } from './heats'
import type { CheckpointStep, RollbackResult } from './checkpoints'
import type { Access, Conversation, ImportableSkill, NewConversation, Reasoning, Skill, Teammate } from './chat'
import type { Flow, FlowRun } from './flows'
import type { UsageSummary } from './usage'
import type { NightState, NightTask } from './nightwatch'
import type { McpState } from './mcp'
import type { AgentToolDraft, AgentToolServer, AgentToolVerifyResult } from './agent-tools'
import type { BudgetPrefs, BudgetState } from './budgets'
import type { SpotFix, SpotFixRequest } from './spotfix'
import type { NewSchedule, Schedule } from './schedules'
import type { NewTask, Task, TaskPatch } from './tasks'
import type { BoardData } from './board'
import type { DictationModelId, DictationStatus } from './dictation'
import type { NewVideo, PointNote, VideoProject } from './video'
import type {
  AccountInfo,
  EmptyTrashResult,
  LicenseNotice,
  StorageReport,
  AgentKind,
  AppInfo,
  LimitInfo,
  SimDevice,
  ThreadMessage,
  CreateSessionOptions,
  DetectedAgent,
  FileContent,
  FileEntry,
  GitCommit,
  GitDiff,
  GitOverview,
  GitStatus,
  GitWorktree,
  HostKeyScan,
  NewSshServer,
  ServiceStatus,
  SshServer,
  LaunchSetOptions,
  MemorySample,
  Prefs,
  SearchQuery,
  SearchResult,
  SessionInfo,
  SessionStatus,
  WorkspaceInfo,
  WorktreeInfo
} from './types'

/** Request and response calls: renderer invokes, main answers. */
export interface InvokeChannels {
  'app:info': () => AppInfo
  'app:openExternal': (url: string) => void
  'agents:list': () => DetectedAgent[]
  'agents:rescan': () => DetectedAgent[]
  'session:create': (opts: CreateSessionOptions) => SessionInfo
  'session:list': () => SessionInfo[]
  'session:snapshot': (id: string) => string
  'session:kill': (id: string) => void
  'session:remove': (id: string) => void
  'session:restart': (id: string) => SessionInfo
  'session:broadcast': (ids: string[], text: string) => number
  /** Restarts a pane with another sign-in. */
  'session:setAccount': (id: string, account: string) => SessionInfo
  'accounts:list': () => AccountInfo[]
  'accounts:add': (cli: AccountInfo['cli'], name: string) => AccountInfo
  'accounts:remove': (id: string) => AccountInfo[]
  'accounts:setDefault': (cli: AccountInfo['cli'], id: string) => AccountInfo[]
  'launchset:start': (opts: LaunchSetOptions) => SessionInfo[]
  'workspace:get': () => WorkspaceInfo
  'workspace:pick': () => WorkspaceInfo | null
  'workspace:set': (root: string) => WorkspaceInfo
  'files:list': (dir: string) => FileEntry[]
  'files:read': (path: string) => FileContent
  'files:write': (path: string, content: string, openedIn: string) => void
  'search:run': (query: SearchQuery) => SearchResult
  'git:status': () => GitStatus | null
  /** Git panel. `cwd` null means the project folder; otherwise a folder a pane runs in. */
  'git:overview': (cwd: string | null) => GitOverview | null
  'git:diff': (cwd: string | null, path: string, staged: boolean) => GitDiff
  'git:stage': (cwd: string | null, paths: string[]) => GitOverview | null
  'git:unstage': (cwd: string | null, paths: string[]) => GitOverview | null
  /** Commits what is staged, refusing when the staged paths differ from `expected`. */
  'git:commit': (cwd: string | null, message: string, expected: string[]) => GitCommit
  'git:log': (cwd: string | null, limit: number) => GitCommit[]
  'git:worktrees': (cwd: string | null) => GitWorktree[]
  'worktree:create': (name: string) => WorktreeInfo
  'prefs:get': () => Prefs
  'prefs:set': (patch: Partial<Prefs>) => Prefs
  'heats:list': () => HeatState[]
  'heats:detectChecks': () => CheckSpec[]
  'heats:start': (opts: StartHeatOptions) => HeatState
  'heats:continue': (id: string) => void
  'heats:cancel': (id: string) => void
  'heats:merge': (id: string, laneId: string) => MergeResult
  'heats:discard': (id: string) => void
  'checkpoints:list': (sessionId: string) => CheckpointStep[]
  'checkpoints:rollback': (stepId: string) => RollbackResult
  'checkpoints:redo': (stepId: string) => RollbackResult
  'chat:list': () => Conversation[]
  'chat:create': (opts: NewConversation) => Conversation
  'chat:send': (id: string, text: string, access?: Access) => void
  'chat:stop': (id: string) => void
  'chat:approve': (id: string, requestId: string) => void
  'chat:deny': (id: string, requestId: string) => void
  'chat:delete': (id: string) => void
  'chat:update': (
    id: string,
    patch: { title?: string; model?: string; agent?: Conversation['agent']; access?: Access; account?: string | null; reasoning?: Reasoning }
  ) => Conversation
  'teammates:list': () => Teammate[]
  'teammates:save': (teammate: Omit<Teammate, 'id' | 'createdAt'> & { id?: string }) => Teammate
  'teammates:delete': (id: string) => void
  'skills:list': () => Skill[]
  'skills:save': (skill: Pick<Skill, 'name' | 'description' | 'instructions'> & { id?: string }) => Skill[]
  'skills:remove': (id: string) => Skill[]
  /** Claude Code skills on this computer (~/.claude/skills/<name>/SKILL.md) that can be copied in. */
  'skills:importable': () => ImportableSkill[]
  'skills:import': (path: string) => Skill[]
  'flows:list': () => Flow[]
  'flows:save': (flow: Flow) => Flow
  'flows:delete': (id: string) => void
  'flows:runs': () => FlowRun[]
  'flows:run': (flowId: string) => FlowRun
  'flows:stop': (runId: string) => void
  'flows:approve': (runId: string) => void
  'flows:merge': (runId: string) => MergeResult
  'flows:discard': (runId: string) => void
  'relay:resumeLater': (sessionId: string) => void
  'relay:cancel': (sessionId: string) => void
  'relay:continueIn': (sessionId: string, agent: AgentKind) => SessionInfo
  'usage:summary': () => UsageSummary
  'night:state': () => NightState
  'night:addTask': (task: Omit<NightTask, 'id' | 'createdAt'>) => NightState
  'night:removeTask': (id: string) => NightState
  'night:schedule': (startAt: number | 'now') => NightState
  'night:cancel': () => NightState
  'night:merge': (runId: string) => MergeResult
  'night:discard': (runId: string) => NightState
  'services:check': () => ServiceStatus[]
  'storage:scan': () => StorageReport
  /** Moves the chosen leftover worktrees to Regatta's trash while nothing is running inside them; any other is kept with its reason. */
  'storage:removeWorktrees': (paths: string[]) => StorageReport
  /** Permanently deletes entries in Regatta's trash and their branches, skipping any in use. */
  'storage:emptyTrash': () => EmptyTrashResult
  /** Shows a folder from the last scan in Finder. */
  'storage:reveal': (path: string) => void
  'about:licenses': () => LicenseNotice[]
  'video:list': () => VideoProject[]
  'video:create': (opts: NewVideo) => VideoProject
  'video:remove': (id: string) => void
  'video:plan': (id: string) => VideoProject
  'video:build': (id: string) => VideoProject
  'video:readPlan': (id: string) => string
  'video:savePlan': (id: string, text: string, tell: boolean) => VideoProject
  'video:changeAt': (id: string, note: PointNote) => VideoProject
  'video:undo': (id: string) => VideoProject
  'video:stop': (id: string) => void
  'video:render': (id: string) => VideoProject
  /** Shows a finished render in Finder. Only files inside a video's renders folder. */
  'video:reveal': (id: string, renderId: string) => void
  /** ffmpeg's path, or null when it is not installed. */
  'video:ffmpeg': () => string | null
  'anywhere:status': () => { enabled: boolean; trusted: boolean; shortcut: string; error: string | null }
  'anywhere:openAccessibility': () => void
  /** From the pill window: the finished recording (16 kHz mono 16-bit WAV). */
  'anywhere:deliver': (wav: Uint8Array) => { ok: boolean; app: string | null; text: string; error: string | null }
  'dictation:status': () => DictationStatus
  'dictation:download': (id: DictationModelId) => DictationStatus
  'dictation:cancelDownload': () => void
  'dictation:setModel': (id: DictationModelId) => DictationStatus
  /** 16 kHz mono 16-bit PCM WAV bytes; returns the words. */
  'dictation:transcribe': (wav: Uint8Array) => string
  /** macOS microphone access: asks when not decided yet. */
  'dictation:microphone': () => 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
  'schedules:list': () => Schedule[]
  'schedules:save': (schedule: NewSchedule) => Schedule[]
  'schedules:remove': (id: string) => Schedule[]
  'schedules:runNow': (id: string) => Schedule[]
  'tasks:list': () => Task[]
  'tasks:create': (task: NewTask) => Task[]
  'tasks:update': (id: string, patch: TaskPatch) => Task[]
  'tasks:remove': (id: string) => Task[]
  'tasks:run': (id: string) => Task[]
  'tasks:done': (id: string) => Task[]
  'tasks:tonight': (id: string) => Task[]
  'board:state': () => BoardData
  'board:archive': (id: string) => BoardData
  'board:unarchive': (id: string) => BoardData
  'board:sendBack': (id: string, note: string) => BoardData
  'mcp:state': () => McpState
  'mcp:setEnabled': (on: boolean) => McpState
  'mcp:setPort': (port: number) => McpState
  'mcp:token': () => string
  'mcp:regenerate': () => McpState
  'agentTools:list': () => AgentToolServer[]
  'agentTools:save': (draft: AgentToolDraft) => AgentToolServer[]
  'agentTools:remove': (id: string) => AgentToolServer[]
  /** Runs the server once to list its tools. */
  'agentTools:verify': (id: string) => AgentToolVerifyResult
  'agentTools:setEnabled': (id: string, on: boolean) => AgentToolServer[]
  'budgets:get': () => BudgetPrefs
  /** Sets (or with null clears) an agent's daily token budget. */
  'budgets:set': (agent: AgentKind, tokens: number | null) => BudgetPrefs
  'budgets:states': () => BudgetState[]
  'spotfix:list': () => SpotFix[]
  'spotfix:start': (req: SpotFixRequest) => SpotFix
  /** The page after the change, as a PNG data URL. */
  'spotfix:after': (id: string, png: string) => SpotFix
  'spotfix:refine': (id: string, note: string) => SpotFix
  'spotfix:undo': (id: string) => SpotFix
  'spotfix:keep': (id: string) => SpotFix
  'spotfix:stop': (id: string) => void
  'spotfix:remove': (id: string) => void
  /** A saved screenshot as a PNG data URL, or null when there is none. */
  'spotfix:image': (id: string, which: 'before' | 'after') => string | null
  'spotfix:runChecks': (id: string) => SpotFix
  'servers:list': () => SshServer[]
  /** Host aliases from ~/.ssh/config (no wildcard patterns), for suggestions. */
  'servers:configHosts': () => string[]
  'servers:save': (server: NewSshServer) => SshServer[]
  'servers:remove': (id: string) => SshServer[]
  'servers:scan': (id: string) => HostKeyScan
  'servers:trust': (id: string, fingerprint: string) => SshServer[]
  'servers:test': (id: string) => SshServer[]
  'device:list': () => SimDevice[]
  'device:boot': (udid: string) => void
  'device:shutdown': (udid: string) => void
  'device:screenshot': (udid: string) => string | null
  'device:openSimulator': () => void
  'thread:get': (sessionId: string) => ThreadMessage[]
  /** Tests only (handled when REGATTA_TEST=1): deliver a hook event to a session as an agent would. */
  'test:hook': (sessionId: string, event: string, payload: unknown) => void
}

export interface StartHeatOptions {
  mode?: 'race' | 'handoff'
  /** Lead followed by backups, one to four attempts. */
  order?: AgentKind[]
  attemptLimitMin?: number
  overallLimitMin?: number | null
  askBeforeNext?: boolean
  task: string
  agents: AgentKind[]
  checks: CheckSpec[]
  /** Shell command run in each new worktree before the agent starts. Empty means copy node_modules when present. */
  setup: string
  timeLimitMin: number
  /** Let agents run commands without asking (inside their own worktree). */
  allowCommands: boolean
}

export interface MergeResult {
  merged: boolean
  /** For example "Fast-forwarded main by 1 commit (+10 -1 in 1 file). Removed 3 worktrees and 2 branches." */
  summary: string
}

/** Fire and forget messages from renderer to main. */
export interface SendChannels {
  'session:write': (id: string, data: string) => void
  'session:resize': (id: string, cols: number, rows: number) => void
}

/** Commands the application menu sends to the renderer. */
export type AppCommand =
  | 'settings'
  | 'new-pane'
  | 'crew'
  | 'close-pane'
  | 'quick'
  | 'inbox'
  | 'broadcast'
  | 'find'
  | 'maximize'
  | 'next-pane'
  | 'previous-pane'
  | 'dictate'

/** Events pushed from main to renderer. */
export interface EventChannels {
  'app:command': { command: AppCommand }
  'session:created': SessionInfo
  'session:data': { id: string; data: string }
  'session:status': { id: string; status: SessionStatus }
  'session:exit': { id: string; exitCode: number | null }
  'session:removed': { id: string }
  'session:memory': MemorySample[]
  'session:focus': { id: string }
  'workspace:changed': WorkspaceInfo
  'prefs:changed': Prefs
  'heats:update': HeatState
  'checkpoints:changed': { sessionId: string }
  'chat:changed': Conversation
  'chat:removed': { id: string }
  'teammates:changed': Teammate[]
  'skills:changed': Skill[]
  'mcp:changed': McpState
  'agentTools:changed': AgentToolServer[]
  'budgets:changed': BudgetState[]
  'spotfix:changed': SpotFix
  'schedules:changed': Schedule[]
  'tasks:changed': Task[]
  'dictation:changed': DictationStatus
  /** To the pill window: start, stop (and transcribe) or cancel. */
  'anywhere:toggle': { action: 'start' | 'stop' | 'cancel' }
  'video:changed': VideoProject
  'accounts:changed': AccountInfo[]
  'video:removed': { id: string }
  'flows:changed': Flow[]
  'flows:run-update': FlowRun
  'session:limit': { id: string; limit: LimitInfo | null }
  'night:update': NightState
}

export const INVOKE_CHANNELS = [
  'app:info',
  'app:openExternal',
  'agents:list',
  'agents:rescan',
  'session:create',
  'session:list',
  'session:snapshot',
  'session:kill',
  'session:remove',
  'session:restart',
  'session:broadcast',
  'session:setAccount',
  'accounts:list',
  'accounts:add',
  'accounts:remove',
  'accounts:setDefault',
  'launchset:start',
  'workspace:get',
  'workspace:pick',
  'workspace:set',
  'files:list',
  'files:read',
  'files:write',
  'search:run',
  'git:status',
  'git:overview',
  'git:diff',
  'git:stage',
  'git:unstage',
  'git:commit',
  'git:log',
  'git:worktrees',
  'worktree:create',
  'prefs:get',
  'prefs:set',
  'heats:list',
  'heats:detectChecks',
  'heats:start',
  'heats:continue',
  'heats:cancel',
  'heats:merge',
  'heats:discard',
  'checkpoints:list',
  'checkpoints:rollback',
  'checkpoints:redo',
  'chat:list',
  'chat:create',
  'chat:send',
  'chat:stop',
  'chat:approve',
  'chat:deny',
  'chat:delete',
  'chat:update',
  'teammates:list',
  'teammates:save',
  'teammates:delete',
  'skills:list',
  'skills:save',
  'skills:remove',
  'skills:importable',
  'skills:import',
  'flows:list',
  'flows:save',
  'flows:delete',
  'flows:runs',
  'flows:run',
  'flows:stop',
  'flows:approve',
  'flows:merge',
  'flows:discard',
  'relay:resumeLater',
  'relay:cancel',
  'relay:continueIn',
  'usage:summary',
  'night:state',
  'night:addTask',
  'night:removeTask',
  'night:schedule',
  'night:cancel',
  'night:merge',
  'night:discard',
  'services:check',
  'storage:scan',
  'storage:removeWorktrees',
  'storage:emptyTrash',
  'storage:reveal',
  'about:licenses',
  'video:list',
  'video:create',
  'video:remove',
  'video:plan',
  'video:build',
  'video:readPlan',
  'video:savePlan',
  'video:changeAt',
  'video:undo',
  'video:stop',
  'video:render',
  'video:reveal',
  'video:ffmpeg',
  'anywhere:status',
  'anywhere:openAccessibility',
  'anywhere:deliver',
  'dictation:status',
  'dictation:download',
  'dictation:cancelDownload',
  'dictation:setModel',
  'dictation:transcribe',
  'dictation:microphone',
  'schedules:list',
  'schedules:save',
  'schedules:remove',
  'schedules:runNow',
  'tasks:list',
  'tasks:create',
  'tasks:update',
  'tasks:remove',
  'tasks:run',
  'tasks:done',
  'tasks:tonight',
  'board:state',
  'board:archive',
  'board:unarchive',
  'board:sendBack',
  'mcp:state',
  'mcp:setEnabled',
  'mcp:setPort',
  'mcp:token',
  'mcp:regenerate',
  'agentTools:list',
  'agentTools:save',
  'agentTools:remove',
  'agentTools:verify',
  'agentTools:setEnabled',
  'budgets:get',
  'budgets:set',
  'budgets:states',
  'spotfix:list',
  'spotfix:start',
  'spotfix:after',
  'spotfix:refine',
  'spotfix:undo',
  'spotfix:keep',
  'spotfix:stop',
  'spotfix:remove',
  'spotfix:image',
  'spotfix:runChecks',
  'servers:list',
  'servers:configHosts',
  'servers:save',
  'servers:remove',
  'servers:scan',
  'servers:trust',
  'servers:test',
  'device:list',
  'device:boot',
  'device:shutdown',
  'device:screenshot',
  'device:openSimulator',
  'thread:get',
  'test:hook'
] as const satisfies readonly (keyof InvokeChannels)[]

export const SEND_CHANNELS = ['session:write', 'session:resize'] as const satisfies readonly (keyof SendChannels)[]

export const EVENT_CHANNELS = [
  'app:command',
  'session:created',
  'session:data',
  'session:status',
  'session:exit',
  'session:removed',
  'session:memory',
  'session:focus',
  'workspace:changed',
  'prefs:changed',
  'heats:update',
  'checkpoints:changed',
  'chat:changed',
  'chat:removed',
  'teammates:changed',
  'skills:changed',
  'mcp:changed',
  'agentTools:changed',
  'budgets:changed',
  'spotfix:changed',
  'schedules:changed',
  'tasks:changed',
  'dictation:changed',
  'anywhere:toggle',
  'video:changed',
  'accounts:changed',
  'video:removed',
  'flows:changed',
  'flows:run-update',
  'session:limit',
  'night:update'
] as const satisfies readonly (keyof EventChannels)[]

/** The API the preload script exposes as window.regatta. */
export interface RegattaBridge {
  invoke<K extends keyof InvokeChannels>(
    channel: K,
    ...args: Parameters<InvokeChannels[K]>
  ): Promise<Awaited<ReturnType<InvokeChannels[K]>>>
  send<K extends keyof SendChannels>(channel: K, ...args: Parameters<SendChannels[K]>): void
  on<K extends keyof EventChannels>(channel: K, listener: (payload: EventChannels[K]) => void): () => void
  platform: NodeJS.Platform
}
