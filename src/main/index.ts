// Electron main process entry: window, services and IPC wiring.

import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell, systemPreferences } from 'electron'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import type { EventChannels, InvokeChannels, SendChannels } from '../shared/ipc'
import type { DetectedAgent, SessionStatus } from '../shared/types'
import { detectAgents } from './agents'
import { cleanEnv, findOnPath, loadShellEnv, stripRepoRoutingFromProcess } from './env'
import { listDir, readFile, writeFile } from './files'
import { createWorktree, gitStatus, worktreesDir } from './git'
import { detectChecks, runChecks } from './heats/checks'
import { stopAllGroups } from './heats/procgroup'
import { setGitOpsHooksSandbox } from './heats/git-ops'
import { gitCommit, gitDiff, gitLog, gitOverview, gitStage, gitUnstage, gitWorktrees, setHooksSandbox } from './gitview'
import { ServerStore } from './servers'
import { AccountStore } from './accounts'
import { AgentToolStore } from './agent-tools'
import { BudgetGuard } from './budgets'
import { SpotFixEngine } from './spotfix'
import { related } from './paths'
import { emptyStorageTrash, licenseNotices, removeWorktrees, scanStorage, type StorageDeps } from './storage'
import type { StorageReport } from '../shared/types'
import type { RunOptions } from './heats/runner'
import { SkillStore } from './skills'
import { McpBridge } from './mcp/bridge'
import { regattaTools } from './mcp/tools'
import { ScheduleEngine } from './schedules'
import { scheduleTools } from './mcp/schedule-tools'
import { TaskStore } from './tasks'
import { BoardStore } from './board'
import { taskTools } from './mcp/task-tools'
import { Dictation } from './dictation'
import { Anywhere } from './anywhere'
import { VideoEngine } from './video/engine'
import { handleVideoProtocol, registerVideoScheme } from './video/protocol'
import { renderJobFromArgv, runRenderJob } from './video/render-child'
import { checkServices } from './services'
import { HookServer } from './hooks'
import { MemoryMonitor } from './memory'
import { buildMenu } from './menu'
import { Checkpoints } from './checkpoints'
import { HeatEngine } from './heats/engine'
import { runAgent } from './heats/runner'
import { ChatEngine } from './chat/engine'
import { FlowEngine } from './flows/engine'
import { readUsage } from './usage'
import { RelayService } from './relay-service'
import { NightWatch } from './nightwatch/engine'
import { bootDevice, listDevices, openSimulator, screenshotDevice, shutdownDevice } from './device'
import { readThread } from './thread'
import { Notifier } from './notifier'
import { runSearch } from './search'
import { SessionManager } from './sessions'
import { SettingsStore } from './settings'

// Git variables that point at one repository (GIT_DIR, GIT_WORK_TREE and the rest) must never reach the git,
// agents and checks Regatta starts, or they would read and change a different folder than the one shown.
stripRepoRoutingFromProcess()

const isTest = process.env['REGATTA_TEST'] === '1'
// Tests record from Chromium's fake microphone (a tone) and never see a permission prompt.
if (isTest) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}
if (process.env['REGATTA_USER_DATA']) app.setPath('userData', process.env['REGATTA_USER_DATA'])
// A render process (see src/main/video/render-child.ts) renders one video and exits; it never opens
// the app window.
/** The folders an engine reports as owned or held (`busyPaths()`), or none when it has no such report. */
function busyPathsOf(engine: object): string[] {
  const report = (engine as { busyPaths?: () => string[] }).busyPaths
  return typeof report === 'function' ? report.call(engine) : []
}

/** Tells an engine to start no new work, when it can be told. */
function quitEngine(engine: object): Promise<void> {
  const quit = (engine as { quit?: () => Promise<void> | void }).quit
  if (typeof quit !== 'function') return Promise.resolve()
  // Some engines finish closing after their agents stop (Spot fix ends its open checkpoint steps then).
  return Promise.resolve(quit.call(engine)).then(() => undefined)
}

const renderJobFile = renderJobFromArgv(process.argv)
if (!renderJobFile) registerVideoScheme()

let win: BrowserWindow | null = null
let shellEnv: Record<string, string> = cleanEnv(process.env)
let agents: DetectedAgent[] = []
/** Set once main is ready; prefs changes turn Dictate anywhere's shortcut on or off. */
let anywhereRef: Anywhere | null = null

function send<K extends keyof EventChannels>(channel: K, payload: EventChannels[K]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function handle<K extends keyof InvokeChannels>(
  channel: K,
  fn: (...args: Parameters<InvokeChannels[K]>) => ReturnType<InvokeChannels[K]> | Promise<ReturnType<InvokeChannels[K]>>
): void {
  ipcMain.handle(channel, (_event, ...args) => fn(...(args as Parameters<InvokeChannels[K]>)))
}

function listen<K extends keyof SendChannels>(channel: K, fn: (...args: Parameters<SendChannels[K]>) => void): void {
  ipcMain.on(channel, (_event, ...args) => fn(...(args as Parameters<SendChannels[K]>)))
}

/** Tests run with REGATTA_HIDDEN=1: the window still renders (and can be screenshotted) but never appears. */
const hidden = process.env['REGATTA_HIDDEN'] === '1'

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#0b0e13',
    title: 'Regatta',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 17 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: !hidden
    }
  })
  if (!hidden) win.once('ready-to-show', () => win?.show())
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

if (renderJobFile) runRenderJob(renderJobFile)
else app.whenReady().then(async () => {
  const settings = new SettingsStore(app.getPath('userData'))
  const defaultRoot = process.env['REGATTA_CWD'] || app.getPath('home')
  if (process.env['REGATTA_CWD']) settings.setWorkspace(process.env['REGATTA_CWD'])
  const root = (): string => settings.workspace(defaultRoot).root

  shellEnv = await loadShellEnv()
  agents = await detectAgents(shellEnv, { includeFake: isTest, appPath: app.getAppPath() })

  let sessions: SessionManager | null = null
  const hooks = new HookServer((id, event, payload) => sessions?.onHook(id, event, payload))
  await hooks.start()

  const lastStatus = new Map<string, SessionStatus>()
  const notifier = new Notifier({
    prefs: () => settings.prefs(),
    session: (id) => sessions?.get(id),
    windowFocused: () => Boolean(win && !win.isDestroyed() && win.isFocused()),
    focusSession: (id) => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      send('session:focus', { id })
    }
  })

  // Every event goes to the window; status changes also go to the notifier.
  const emit = <K extends keyof EventChannels>(channel: K, payload: EventChannels[K]): void => {
    send(channel, payload)
    if (channel === 'session:status') {
      const { id, status } = payload as EventChannels['session:status']
      notifier.onStatus(id, status, lastStatus.get(id) ?? null)
      lastStatus.set(id, status)
    }
    if (channel === 'session:removed') lastStatus.delete((payload as EventChannels['session:removed']).id)
  }

  const checkpoints = new Checkpoints({
    emitChanged: (sessionId) => send('checkpoints:changed', { sessionId }),
    log: (message) => console.error(`[checkpoints] ${message}`)
  })

  const accounts = new AccountStore({
    dataDir: app.getPath('userData'),
    accountsDir: process.env['REGATTA_ACCOUNTS_DIR'] || undefined,
    // Tests point the computer's own sign-in at a temp folder, so they never read the real one.
    home: isTest ? process.env['REGATTA_TEST_HOME'] || undefined : undefined,
    emit: (list) => send('accounts:changed', list)
  })
  const agentTools = new AgentToolStore({
    dataDir: app.getPath('userData'),
    env: () => shellEnv,
    root,
    version: app.getVersion(),
    emit: (list) => send('agentTools:changed', list)
  })
  // Two ways to start a headless agent. `runWithAccount` is the plain one: the default sign-in of each CLI,
  // no agent tools, no budget. Spot fix uses it behind the budget guard only, because it must not get MCP servers.
  // `runHeadless` (defined below, once the budget guard exists) is the full one for heats, flows, night watch
  // and video: the budget guard around a run that also gets the agent tools that are on.
  const runWithAccount = (opts: RunOptions): ReturnType<typeof runAgent> =>
    runAgent({ ...opts, env: { ...opts.env, ...accounts.envFor(opts.agent, null) } })
  sessions = new SessionManager({
    extraArgs: (agent) => agentTools.argsFor(agent),
    accounts: { resolve: (agent, account) => accounts.resolve(agent, account), envFor: (agent, account) => accounts.envFor(agent, account) },
    env: () => shellEnv,
    agents: () => agents,
    hooks,
    workspaceRoot: root,
    emit,
    quietAfterSec: () => settings.prefs().quietAfterSec,
    createWorktree: (name) => createWorktree(root(), name),
    steps: {
      // The step start is awaited by the session before it delivers submitted input, so it must settle
      // either way. Failures are logged and kept as failed steps in the history by the checkpoint store.
      start: (id, agent, cwd, label) =>
        checkpoints.stepStart(id, agent, cwd, label).catch((err) => console.error('[checkpoints] step start failed:', err)),
      end: (id) => checkpoints.stepEnd(id).catch((err) => console.error('[checkpoints] step end failed:', err)),
      relabel: (id, label) => checkpoints.relabelStep(id, label),
      unprotected: (id, reason) => checkpoints.markUnprotected(id, reason)
    }
  })
  const s = sessions

  // The budget guard needs the sessions (for Usage), so it comes after them, and before every engine that runs
  // agents headless. Usage is read lazily, when a run starts or states are asked for.
  const budgets = new BudgetGuard({
    dataDir: app.getPath('userData'),
    usage: () => readUsage({ sessions: () => s.list(), home: () => app.getPath('home'), codexHomes: () => accounts.codexHomes() }),
    agentName: (agent) => agents.find((a) => a.kind === agent)?.name ?? agent,
    emit: (states) => send('budgets:changed', states)
  })
  const runHeadless = budgets.wrap((opts) =>
    runWithAccount({ ...opts, baseArgs: [...opts.baseArgs, ...agentTools.argsFor(opts.agent)] })
  )

  // Tasks are built after the heats engine (they need night, chat and skills), so the engine reaches them
  // through this reference: a task rides the status of the heat it is running.
  let tasksRef: TaskStore | null = null
  const heats = new HeatEngine({
    // Keeps each project's hand-off history (who won or failed here), which orders Skipper's suggestions.
    dataDir: app.getPath('userData'),
    root,
    env: () => shellEnv,
    agents: () => agents,
    run: runHeadless,
    emit: (heat) => {
      send('heats:update', heat)
      tasksRef?.onHeat(heat)
    }
  })

  const skills = new SkillStore({
    dataDir: app.getPath('userData'),
    home: app.getPath('home'),
    emit: (list) => send('skills:changed', list)
  })
  const chat = new ChatEngine({
    skills: () => skills.list(),
    accountEnv: (agent, account) => accounts.envFor(agent, account),
    extraArgs: (agent) => agentTools.argsFor(agent),
    dataDir: app.getPath('userData'),
    root,
    env: () => shellEnv,
    agents: () => agents,
    emit: (conversation) => send('chat:changed', conversation),
    emitRemoved: (id) => send('chat:removed', { id }),
    emitTeammates: (list) => send('teammates:changed', list)
  })

  const flows = new FlowEngine({
    dataDir: app.getPath('userData'),
    root,
    env: () => shellEnv,
    agents: () => agents,
    run: runHeadless,
    emitFlows: (list) => send('flows:changed', list),
    emitRun: (run) => send('flows:run-update', run)
  })

  let awakeId: number | null = null
  const night = new NightWatch({
    dataDir: app.getPath('userData'),
    root,
    env: () => shellEnv,
    agents: () => agents,
    run: runHeadless,
    emit: (state) => send('night:update', state),
    keepAwake: (on) => {
      if (on && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension')
      if (!on && awakeId !== null) {
        powerSaveBlocker.stop(awakeId)
        awakeId = null
      }
    }
  })

  const spotfix = new SpotFixEngine({
    dataDir: app.getPath('userData'),
    root,
    env: () => shellEnv,
    agents: () => agents,
    // The budget applies, agent tools do not: a Spot fix must not get MCP servers.
    run: budgets.wrap(runWithAccount),
    checkpoints: {
      start: (id, agent, cwd, label) => checkpoints.stepStart(id, agent, cwd, label),
      end: (id) => checkpoints.stepEnd(id),
      list: (id) => checkpoints.list(id),
      rollback: (stepId) => checkpoints.rollback(stepId)
    },
    detectChecks: (cwd) => detectChecks(cwd),
    runChecks: (specs, cwd, env, opts) => runChecks(specs, cwd, env, opts),
    emit: (fix) => send('spotfix:changed', fix),
    // A Spot fix refuses to start while another agent may be changing the same folder: a pane there that is
    // working, waiting or quiet, a running Chat turn there, or a flow run that works in the project itself.
    // Folders are compared canonically (realpath, same/inside/holding), so a pane in a subfolder of the
    // project, or the same folder reached through a symlink, counts too.
    othersWorking: (cwd) => {
      const names: string[] = []
      for (const x of s.list()) {
        const busy = ['starting', 'working', 'waiting', 'quiet'].includes(x.status.state)
        if (busy && related(x.cwd, cwd)) names.push(x.title)
      }
      for (const c of chat.list()) if (c.status === 'running' && related(c.cwd, cwd)) names.push(`Chat: ${c.title}`)
      for (const r of flows.runs()) {
        if (!r.isolated && (r.status === 'running' || r.status === 'waiting') && related(root(), cwd)) names.push(`Flow: ${r.flowName}`)
      }
      return [...new Set(names)]
    }
  })

  const memory = new MemoryMonitor({
    sessions: () => s.list().map((x) => ({ id: x.id, pid: x.pid })),
    emit: (samples) => send('session:memory', samples)
  })
  memory.start()

  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, home: app.getPath('home'), hookPort: hooks.port }))
  handle('app:openExternal', async (url) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
  handle('agents:list', () => agents)
  handle('agents:rescan', async () => {
    agents = await detectAgents(shellEnv, { includeFake: isTest, appPath: app.getAppPath() })
    return agents
  })
  handle('session:create', (opts) => s.create(opts))
  handle('session:list', () => s.list())
  handle('session:snapshot', (id) => s.snapshot(id))
  handle('session:kill', (id) => s.kill(id))
  handle('session:remove', (id) => s.remove(id))
  handle('session:restart', (id) => s.restart(id))
  handle('session:broadcast', (ids, text) => s.broadcast(ids, text))
  handle('session:setAccount', (id, account) => s.setAccount(id, account))
  handle('accounts:list', async () => accounts.list())
  handle('accounts:add', async (cli, name) => accounts.add(cli, name))
  handle('accounts:remove', async (id) => accounts.remove(id))
  handle('accounts:setDefault', async (cli, id) => accounts.setDefault(cli, id))
  handle('launchset:start', (opts) => s.launchSet(opts))
  handle('workspace:get', () => settings.workspace(defaultRoot))
  handle('workspace:set', (next) => {
    settings.setWorkspace(next)
    const ws = settings.workspace(defaultRoot)
    send('workspace:changed', ws)
    return ws
  })
  handle('workspace:pick', async () => {
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a project folder' })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    settings.setWorkspace(result.filePaths[0])
    const ws = settings.workspace(defaultRoot)
    send('workspace:changed', ws)
    return ws
  })
  handle('files:list', (dir) => listDir(root(), dir))
  handle('files:read', (path) => readFile(root(), path))
  handle('files:write', (path, content, openedIn) => writeFile(root(), path, content, openedIn))
  handle('search:run', (query) => runSearch(root(), query, shellEnv))
  handle('git:status', () => gitStatus(root()))
  // The Git panel opens the project folder or a folder a pane runs in (its worktree), nothing else.
  const gitCwd = (cwd: string | null): string => {
    if (!cwd) return root()
    const target = resolve(cwd)
    if (target === resolve(root()) || s.list().some((x) => resolve(x.cwd) === target)) return target
    throw new Error('The Git panel only opens the project folder or a folder a pane runs in')
  }
  // The Git panel and git-ops run git with this empty folder as its hooks folder, so a hook added
  // while git runs can never run during preservation, removal or Git panel operations.
  const emptyHooks = join(app.getPath('userData'), 'git-empty-hooks')
  setHooksSandbox(emptyHooks)
  setGitOpsHooksSandbox(emptyHooks)
  handle('git:overview', (cwd) => gitOverview(gitCwd(cwd)))
  handle('git:diff', (cwd, path, staged) => gitDiff(gitCwd(cwd), path, staged))
  handle('git:stage', async (cwd, paths) => {
    const dir = gitCwd(cwd)
    await gitStage(dir, paths)
    return gitOverview(dir)
  })
  handle('git:unstage', async (cwd, paths) => {
    const dir = gitCwd(cwd)
    await gitUnstage(dir, paths)
    return gitOverview(dir)
  })
  handle('git:commit', (cwd, message, expected) => gitCommit(gitCwd(cwd), message, expected))
  handle('git:log', (cwd, limit) => gitLog(gitCwd(cwd), limit))
  handle('git:worktrees', (cwd) => gitWorktrees(gitCwd(cwd)))
  handle('worktree:create', (name) => createWorktree(root(), name))
  handle('prefs:get', () => settings.prefs())
  handle('prefs:set', (patch) => {
    const prefs = settings.setPrefs(patch)
    anywhereRef?.apply(prefs)
    send('prefs:changed', prefs)
    return prefs
  })
  handle('heats:list', () => heats.list())
  handle('heats:detectChecks', () => heats.detectChecks())
  handle('heats:start', (opts) => heats.start(opts))
  handle('heats:cancel', (id) => heats.cancel(id))
  handle('heats:merge', (id, laneId) => heats.merge(id, laneId))
  handle('heats:discard', (id) => heats.discard(id))
  handle('heats:continue', (id) => heats.continue(id))
  handle('checkpoints:list', (sessionId) => checkpoints.list(sessionId))
  handle('checkpoints:rollback', (stepId) => checkpoints.rollback(stepId))
  handle('checkpoints:redo', (stepId) => checkpoints.redo(stepId))
  handle('chat:list', () => chat.list())
  handle('chat:create', (opts) => chat.create(opts))
  handle('chat:send', (id, text, access) => chat.send(id, text, access))
  handle('chat:stop', (id) => chat.stop(id))
  handle('chat:approve', (id, requestId) => chat.approve(id, requestId))
  handle('chat:deny', (id, requestId) => chat.deny(id, requestId))
  handle('chat:delete', (id) => chat.remove(id))
  handle('chat:update', (id, patch) => chat.update(id, patch))
  handle('teammates:list', () => chat.teammates())
  handle('teammates:save', (teammate) => chat.saveTeammate(teammate))
  handle('teammates:delete', (id) => chat.deleteTeammate(id))
  handle('skills:list', () => skills.list())
  handle('skills:save', (skill) => skills.save(skill))
  handle('skills:remove', (id) => skills.remove(id))
  handle('skills:importable', () => skills.importable())
  handle('skills:import', (path) => skills.import(path))
  handle('flows:list', () => flows.list())
  handle('flows:save', (flow) => flows.save(flow))
  handle('flows:delete', (id) => flows.remove(id))
  handle('flows:runs', () => flows.runs())
  handle('flows:run', (flowId) => flows.run(flowId))
  handle('flows:stop', (runId) => flows.stop(runId))
  handle('flows:approve', (runId) => flows.approve(runId))
  handle('flows:merge', (runId) => flows.merge(runId))
  handle('flows:discard', (runId) => flows.discard(runId))
  const relay = new RelayService({ sessions: s, emitLimit: (id, limit) => send('session:limit', { id, limit }) })
  handle('relay:resumeLater', (id) => relay.resumeLater(id))
  handle('relay:cancel', (id) => relay.cancel(id))
  handle('relay:continueIn', (id, agent) => relay.continueIn(id, agent))
  handle('usage:summary', () => readUsage({ sessions: () => s.list(), home: () => app.getPath('home'), codexHomes: () => accounts.codexHomes() }))
  handle('night:state', () => night.state())
  handle('night:addTask', (task) => night.addTask(task))
  handle('night:removeTask', (id) => night.removeTask(id))
  handle('night:schedule', (startAt) => night.schedule(startAt))
  handle('night:cancel', () => night.cancel())
  handle('night:merge', (runId) => night.merge(runId))
  handle('night:discard', (runId) => night.discard(runId))
  handle('services:check', () => checkServices({ env: () => shellEnv, home: app.getPath('home') }))
  const storageDeps: StorageDeps = {
    dataDir: app.getPath('userData'),
    worktreesDir: worktreesDir(),
    checkpointsDir: join(app.getPath('home'), '.regatta', 'checkpoints'),
    accountsDir: accounts.root(),
    inUse: () =>
      [
        // A pane's folder, not only the worktree it was made with: one opened from the Git panel, or
        // restarted, runs in a worktree without that field.
        ...s.list().flatMap((x) => [x.worktree, x.cwd]),
        ...heats.list().flatMap((h) => h.lanes.map((l) => l.worktree)),
        ...night.state().nights.flatMap((n) => n.runs.map((r) => r.worktree)),
        ...flows.runs().map((r) => r.worktree),
        // Every folder an engine owns or holds right now, temporary ones included (baselines, checks).
        ...[heats, night, flows, spotfix].flatMap((engine) => busyPathsOf(engine))
      ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  }
  let lastScan: StorageReport | null = null
  handle('storage:scan', async () => (lastScan = await scanStorage(storageDeps)))
  handle('storage:removeWorktrees', async (paths) => (lastScan = await removeWorktrees(storageDeps, paths)))
  handle('storage:emptyTrash', async () => {
    const res = await emptyStorageTrash(storageDeps)
    lastScan = res.report
    return res
  })
  handle('storage:reveal', (path) => {
    const known =
      lastScan &&
      [
        ...lastScan.items.map((i) => i.path),
        ...lastScan.leftovers.map((l) => l.path),
        ...lastScan.trash.flatMap((t) => [t.trashPath, t.entryPath, t.originalPath])
      ].includes(path)
    if (!known) throw new Error('Scan again first.')
    shell.showItemInFolder(path)
  })
  handle('about:licenses', () => licenseNotices(app.getAppPath()))
  const videoResources = app.isPackaged ? join(process.resourcesPath, 'video') : join(app.getAppPath(), 'resources', 'video')
  const video = new VideoEngine({
    dataDir: app.getPath('userData'),
    resourcesDir: videoResources,
    root,
    env: () => shellEnv,
    agents: () => agents,
    run: runHeadless,
    spawnRender: (jobFile) => {
      // The same app binary in render mode; in development the app folder comes first.
      // sRGB on the command line: set at runtime it does not reach the browser process, and frames came out
      // in the display's P3 colors now and then (pure red read as 234,51,35).
      const flags = [`--regatta-render=${jobFile}`, '--force-color-profile=srgb']
      const args = app.isPackaged ? flags : [app.getAppPath(), ...flags]
      const env = { ...cleanEnv(process.env) }
      delete env['ELECTRON_RUN_AS_NODE']
      const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      // Chromium can be chatty on stderr; reading it keeps the pipe from filling up and blocking the render.
      child.stderr?.resume()
      const done = new Promise<number | null>((resolve) => {
        child.once('close', (code) => resolve(code))
        child.once('error', () => resolve(null))
      })
      return {
        done,
        stop: () => {
          if (child.exitCode === null) child.kill('SIGTERM')
        },
        output: (fn) => {
          let buffer = ''
          child.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) if (line.trim()) fn(line)
          })
        }
      }
    },
    emit: (v) => send('video:changed', v),
    emitRemoved: (id) => send('video:removed', { id })
  })
  handleVideoProtocol((id) => video.folderOf(id), videoResources)
  handle('video:list', () => video.list())
  handle('video:create', (opts) => video.create(opts))
  handle('video:remove', (id) => video.remove(id))
  handle('video:plan', (id) => video.plan(id))
  handle('video:build', (id) => video.build(id))
  handle('video:readPlan', (id) => video.readPlan(id))
  handle('video:savePlan', (id, text, tell) => video.savePlan(id, text, tell))
  handle('video:changeAt', (id, note) => video.changeAt(id, note))
  handle('video:undo', (id) => video.undo(id))
  handle('video:stop', (id) => video.stop(id))
  handle('video:render', (id) => video.render(id))
  handle('video:reveal', (id, renderId) => {
    const folder = video.folderOf(id)
    const file = video.list().find((v) => v.id === id)?.renders.find((r) => r.id === renderId)?.path
    if (!folder || !file) throw new Error('That render no longer exists.')
    const target = resolve(folder, file)
    if (!target.startsWith(resolve(folder, 'renders') + '/')) throw new Error('Only finished renders can be shown.')
    shell.showItemInFolder(target)
  })
  handle('video:ffmpeg', () => findOnPath('ffmpeg', shellEnv))
  const dictation = new Dictation({
    dataDir: app.getPath('userData'),
    env: () => shellEnv,
    emit: (status) => send('dictation:changed', status)
  })
  handle('dictation:status', () => dictation.status())
  handle('dictation:download', (id) => dictation.download(id))
  handle('dictation:cancelDownload', () => dictation.cancelDownload())
  handle('dictation:setModel', (id) => dictation.setModel(id))
  handle('dictation:transcribe', (wav) => dictation.transcribe(wav))
  const anywhere = (anywhereRef = new Anywhere({
    dictation,
    preload: join(__dirname, '../preload/index.js'),
    load: (w, query) => {
      if (process.env['ELECTRON_RENDERER_URL']) void w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${new URLSearchParams(query)}`)
      else void w.loadFile(join(__dirname, '../renderer/index.html'), { query })
    }
  }))
  anywhere.apply(settings.prefs())
  handle('anywhere:status', () => anywhere.status())
  handle('anywhere:openAccessibility', () => anywhere.openAccessibility())
  handle('anywhere:deliver', (wav) => anywhere.deliver(wav))
  handle('dictation:microphone', async () => {
    if (isTest) return 'granted'
    if (process.platform !== 'darwin') return 'unknown'
    const now = systemPreferences.getMediaAccessStatus('microphone')
    if (now !== 'not-determined') return now
    return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied'
  })
  const schedules = new ScheduleEngine({
    dataDir: app.getPath('userData'),
    runCrew: async (teammateId, prompt) => {
      const mate = chat.teammates().find((t) => t.id === teammateId)
      if (!mate) throw new Error('That crew member no longer exists.')
      const conversation = chat.create({ agent: mate.agent, teammateId })
      // The turn runs on; its reply lands in the crew member's conversation.
      void chat.send(conversation.id, prompt).catch(() => undefined)
      return { conversationId: conversation.id }
    },
    runFlow: async (flowId) => ({ flowRunId: (await flows.run(flowId)).id }),
    emit: (list) => send('schedules:changed', list)
  })
  schedules.start()
  handle('schedules:list', () => schedules.list())
  handle('schedules:save', (schedule) => schedules.save(schedule))
  handle('schedules:remove', (id) => schedules.remove(id))
  handle('schedules:runNow', (id) => schedules.runNow(id))
  const tasks = new TaskStore({
    dataDir: app.getPath('userData'),
    startHeat: (opts) => heats.start(opts),
    night: { addTask: (task) => night.addTask(task) },
    teammates: () => chat.teammates(),
    skills: () => skills.list(),
    emit: (list) => send('tasks:changed', list)
  })
  tasksRef = tasks
  handle('tasks:list', () => tasks.list())
  handle('tasks:create', (task) => tasks.create(task, 'you'))
  handle('tasks:update', (id, patch) => tasks.update(id, patch))
  handle('tasks:remove', (id) => tasks.remove(id))
  handle('tasks:run', (id) => tasks.run(id))
  handle('tasks:done', (id) => tasks.markDone(id))
  handle('tasks:tonight', (id) => tasks.addToTonight(id))
  const board = new BoardStore({
    dataDir: app.getPath('userData'),
    emit: () => undefined
  })
  handle('board:state', () => board.list())
  handle('board:archive', (id) => board.archive(id))
  handle('board:unarchive', (id) => board.unarchive(id))
  handle('board:sendBack', (id, note) => board.sendBack(id, note))
  const mcpTools = [
    ...regattaTools({
      workspace: () => settings.workspace(defaultRoot),
      gitStatus: () => gitStatus(root()),
      sessions: () => s.list(),
      output: (id) => s.snapshot(id),
      crew: () => chat.teammates(),
      search: (query) => runSearch(root(), query, shellEnv),
      heats: () => heats.list()
    }),
    ...scheduleTools(schedules),
    ...taskTools(tasks)
  ]
  const mcp = new McpBridge({
    dataDir: app.getPath('userData'),
    tools: () => mcpTools,
    version: app.getVersion(),
    emit: (state) => send('mcp:changed', state)
  })
  void mcp.init()
  handle('mcp:state', () => mcp.state())
  handle('mcp:setEnabled', (on) => mcp.setEnabled(on))
  handle('mcp:setPort', (port) => mcp.setPort(port))
  handle('mcp:token', () => mcp.token())
  handle('mcp:regenerate', () => mcp.regenerate())
  handle('agentTools:list', () => agentTools.list())
  handle('agentTools:save', (draft) => agentTools.save(draft))
  handle('agentTools:remove', (id) => agentTools.remove(id))
  handle('agentTools:verify', (id) => agentTools.verify(id))
  handle('agentTools:setEnabled', (id, on) => agentTools.setEnabled(id, on))
  handle('budgets:get', () => budgets.prefs())
  handle('budgets:set', (agent, tokens) => budgets.set(agent, tokens))
  handle('budgets:states', () => budgets.states())
  handle('spotfix:list', () => spotfix.list())
  handle('spotfix:start', (req) => spotfix.start(req))
  handle('spotfix:after', (id, png) => spotfix.after(id, png))
  handle('spotfix:refine', (id, note) => spotfix.refine(id, note))
  handle('spotfix:undo', (id) => spotfix.undo(id))
  handle('spotfix:keep', (id) => spotfix.keep(id))
  handle('spotfix:stop', (id) => spotfix.stop(id))
  handle('spotfix:remove', (id) => spotfix.remove(id))
  handle('spotfix:image', (id, which) => spotfix.image(id, which))
  handle('spotfix:runChecks', (id) => spotfix.runChecks(id))
  const servers = new ServerStore({ dataDir: app.getPath('userData'), home: app.getPath('home'), env: () => shellEnv })
  handle('servers:list', () => servers.list())
  handle('servers:configHosts', () => servers.configHosts())
  handle('servers:save', (server) => servers.save(server))
  handle('servers:remove', (id) => servers.remove(id))
  handle('servers:scan', (id) => servers.scan(id))
  handle('servers:trust', (id, fingerprint) => servers.trust(id, fingerprint))
  handle('servers:test', (id) => servers.test(id))
  handle('device:list', () => listDevices())
  handle('device:boot', (udid) => bootDevice(udid))
  handle('device:shutdown', (udid) => shutdownDevice(udid))
  handle('device:screenshot', (udid) => screenshotDevice(udid))
  handle('device:openSimulator', () => openSimulator())
  handle('thread:get', async (sessionId) => {
    const info = s.get(sessionId)
    return info ? readThread(info, app.getPath('home')) : []
  })
  if (isTest) handle('test:hook', (id, event, payload) => s.onHook(id, event, payload))
  buildMenu((command) => send('app:command', { command }))
  listen('session:write', (id, data) => s.write(id, data))
  listen('session:resize', (id, cols, rows) => s.resize(id, cols, rows))

  // 'running' while engines and their process groups are being stopped; every quit request in that time
  // is held, or a second Cmd+Q would end the app before the groups are gone. 'done' lets the last one through.
  let shutdown: 'none' | 'running' | 'done' = 'none'
  app.on('before-quit', (event) => {
    if (shutdown === 'done') return
    event.preventDefault()
    if (shutdown === 'running') return
    shutdown = 'running'
    anywhereRef?.dispose()
    schedules.stop()
    void mcp.stop()
    memory.stop()
    agentTools.dispose()
    s.disposeAll()
    hooks.stop()
    // First the engines stop starting new work (a check begun now would outlive the app). Then their
    // agents and checks, which run in their own process groups, are stopped (SIGTERM, then SIGKILL after
    // 2 seconds), and the app quits once they are gone, or after 6 seconds at most.
    const closing = Promise.allSettled([heats, night, flows, spotfix, chat, video].map((engine) => quitEngine(engine)))
    const settled = Promise.all([closing, stopAllGroups(2000).catch(() => null)])
    const limit = new Promise((done) => setTimeout(done, 6000))
    void Promise.race([settled, limit]).finally(() => {
      shutdown = 'done'
      app.quit()
    })
  })

  createWindow()
})

if (!renderJobFile) app.on('window-all-closed', () => app.quit())
