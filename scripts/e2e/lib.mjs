// Shared helpers for end-to-end tests that drive the real app with Playwright.
// The window renders but stays hidden (REGATTA_HIDDEN=1). Screenshots go to /tmp/regatta-e2e/<test>/.
//
// Every launch runs in a fake world, so a test never reads or writes anything real on this computer
//. One fresh folder per launch, `t.world`:
//   home/          an empty home folder with only a .gitconfig (the test identity)
//   bin/           stand-in commands for every agent CLI and service CLI, first on PATH
//   standins.log   one line per stand-in call: "<command> <arguments>" (see `t.standinCalls()`)
//   worktrees/     REGATTA_WORKTREES_DIR: where heats and crews put their git worktrees (a test can pick its own)
//   profile/       the app's user data folder, unless the test passes its own
// A test that needs the machine's real home passes `realHome: true` (only the Device test, which needs the
// real simulator list). It still gets the stand-ins, the test git config and the worktrees folder.
// A world is removed when its launch closes. REGATTA_E2E_KEEP_WORLD=1 keeps them, to look at what a run left behind.

import { _electron as electron } from 'playwright'
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { delimiter, join } from 'node:path'

export const repo = new URL('../..', import.meta.url).pathname

const standinsDir = join(repo, 'scripts', 'e2e', 'standins')

/** The command each agent runs as (src/shared/agents.ts). The world test fails if this list drifts. */
export const AGENT_COMMANDS = ['claude', 'codex', 'gemini', 'grok', 'cursor-agent', 'aider', 'opencode', 'qwen', 'amp']
/** The service CLIs that get a stand-in (src/main/services.ts). The world test fails if this list drifts. */
export const SERVICE_COMMANDS = ['gh', 'glab', 'stripe', 'wrangler', 'supabase', 'vercel']
/** Services left without a stand-in and hidden from PATH, so one row always reads "Not installed". */
export const ABSENT_COMMANDS = ['shopify']

/**
 * ssh finds "~" through the system's user database, not through HOME, so the stand-in runs it with -F
 * pointing at the fake home's own config. Only made when the real ssh is where it is on macOS and Linux.
 */
const REAL_SSH = '/usr/bin/ssh'

/**
 * Environment variables that would carry the machine's own sign-ins or folders into the app: tokens and
 * keys, config folders that redirect where a CLI looks, the ssh agent. Dropped from every launch.
 */
const DROPPED_VARS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'ZDOTDIR',
  'SSH_AUTH_SOCK',
  'GNUPGHOME'
])
const DROPPED_PATTERN = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|CREDENTIALS?)(_|$)/i

/** Copy of an environment without undefined values and without anything that carries the machine's own sign-ins. */
function scrubbedEnv(source) {
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || DROPPED_VARS.has(key) || DROPPED_PATTERN.test(key)) continue
    out[key] = value
  }
  return out
}

// Folders this process made and has not removed yet. Closing a launch removes its own; the rest go at exit.
const madeFolders = new Set()
process.on('exit', () => {
  for (const dir of madeFolders) rmSync(dir, { recursive: true, force: true })
})

function makeFolder(prefix) {
  const dir = mkdtempSync(prefix)
  madeFolders.add(dir)
  return dir
}

function removeFolder(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  madeFolders.delete(dir)
}

/** Removes a world made by `makeWorld`. A launch removes its own when it closes. */
export function removeWorld(world) {
  removeFolder(world)
}

// The test process runs git as well (it builds throwaway repositories), so it gets the same test identity
// and no system config. Each launch then replaces this with its own world's config.
const processGitDir = makeFolder('/tmp/regatta-e2e-git-')
copyFileSync(join(standinsDir, 'gitconfig'), join(processGitDir, 'gitconfig'))
process.env.GIT_CONFIG_GLOBAL = join(processGitDir, 'gitconfig')
process.env.GIT_CONFIG_NOSYSTEM = '1'

// A worktrees folder inherited from the shell that started this run is the machine's own, so it is dropped. A test that
// sets process.env.REGATTA_WORKTREES_DIR itself before it launches keeps that folder (or passes it in `env`).
delete process.env.REGATTA_WORKTREES_DIR

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The PATH the app gets: the stand-ins folder first, then the machine's own PATH. A folder on the machine's PATH
 * that holds a command in `hidden` is replaced by a copy made of links to everything else in it, so a command
 * that must stay missing is missing even when this computer has it.
 */
export function buildPath(machinePath, standinsBin, mirrorRoot, hidden) {
  const dirs = [standinsBin]
  let mirrors = 0
  for (const dir of machinePath.split(delimiter)) {
    if (!dir) continue
    if (!hidden.some((name) => existsSync(join(dir, name)))) {
      dirs.push(dir)
      continue
    }
    const mirror = join(mirrorRoot, String(mirrors++))
    mkdirSync(mirror, { recursive: true })
    for (const entry of readdirSync(dir)) {
      if (hidden.includes(entry)) continue
      try {
        symlinkSync(join(dir, entry), join(mirror, entry))
      } catch {
        // An entry that cannot be linked is left out; it was not a command anyone here needs.
      }
    }
    dirs.push(mirror)
  }
  return dirs.join(delimiter)
}

/**
 * Makes the world folder with its home, git config, stand-ins and worktrees folder, and returns its paths and the
 * environment variables that point an app at it. `launch` calls this; the world test calls it to look at the result.
 */
export function makeWorld(opts = {}) {
  const world = makeFolder('/tmp/regatta-e2e-world-')
  const home = join(world, 'home')
  const bin = join(world, 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(world, 'worktrees'), { recursive: true })
  copyFileSync(join(standinsDir, 'gitconfig'), join(home, '.gitconfig'))

  for (const script of ['agent.sh', 'service.sh', 'ssh.sh']) {
    const file = join(standinsDir, script)
    if (!isExecutable(file)) chmodSync(file, 0o755)
  }
  for (const name of AGENT_COMMANDS) symlinkSync(join(standinsDir, 'agent.sh'), join(bin, name))
  for (const name of SERVICE_COMMANDS) symlinkSync(join(standinsDir, 'service.sh'), join(bin, name))
  if (isExecutable(REAL_SSH)) symlinkSync(join(standinsDir, 'ssh.sh'), join(bin, 'ssh'))

  // Seed files a test wants in the fake home before the app starts, for example { '.claude.json': '{}' }.
  for (const [file, content] of Object.entries(opts.homeFiles ?? {})) {
    const target = join(home, file)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }

  const env = {
    // The app reads its home through three routes. os.homedir() and "~" in a shell follow HOME; Electron's
    // app.getPath('home') does not on macOS (it asks the user database) and follows CFFIXED_USER_HOME instead.
    ...(opts.realHome ? {} : { HOME: home, CFFIXED_USER_HOME: home }),
    // The accounts store's own test hook, so the computer's sign-in is read from the fake home on every launch.
    REGATTA_TEST_HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: buildPath(process.env.PATH ?? '', bin, join(world, 'path'), ABSENT_COMMANDS),
    REGATTA_WORKTREES_DIR: process.env.REGATTA_WORKTREES_DIR || join(world, 'worktrees')
  }
  return { world, home, env }
}

/**
 * Captures the window as it is on screen through the window's own capture, so
 * embedded pages keep the size they have on screen. Returns the PNG as base64,
 * or null when the capture came back empty or could not run.
 */
async function captureWindow(app, url) {
  try {
    const png = await app.evaluate(async ({ BrowserWindow }, pageUrl) => {
      // The window the test drives (its page URL), not whichever window Electron lists first.
      const wins = BrowserWindow.getAllWindows()
      const target = wins.find((w) => w.webContents.getURL() === pageUrl) ?? null
      if (!target) return null
      const image = await target.webContents.capturePage()
      if (image.isEmpty()) return null
      const data = image.toPNG()
      if (!data || data.length === 0) return null
      return data.toString('base64')
    }, url)
    if (typeof png !== 'string' || png.length === 0) return null
    return png
  } catch {
    return null
  }
}

/**
 * Launches the built app (run `npm run build` first) in a fake world and returns helpers.
 * @param {string} name test name, used for the screenshot folder
 * @param {{ cwd?: string, visible?: boolean, env?: Record<string, string>, profile?: string, executablePath?: string, realHome?: boolean, homeFiles?: Record<string, string>, welcome?: boolean }} [opts]
 *   `env` adds environment variables and wins over the world's; `profile` is the user data folder to use (made
 *   fresh inside the world when absent); `realHome` keeps the machine's real home (and nothing else real);
 *   `homeFiles` maps paths inside the fake home to the text to write there before the app starts.
 *   `welcome` shows the first-run welcome sheet (every launch otherwise starts with it already seen).
 *   `executablePath` launches a packaged app binary directly (no app-path argument) instead of the dev build.
 */
export async function launch(name, opts = {}) {
  const shots = `/tmp/regatta-e2e/${name}`
  mkdirSync(shots, { recursive: true })
  const { world, home, env: worldEnv } = makeWorld(opts)
  const profile = opts.profile ?? join(world, 'profile')
  mkdirSync(profile, { recursive: true })
  // The welcome sheet shows on first run. Every test starts past it, unless it asks to see it.
  // A reused profile keeps its own stored choice and is never reseeded.
  const settingsFile = join(profile, 'regatta-settings.json')
  if (!existsSync(settingsFile)) {
    writeFileSync(settingsFile, JSON.stringify({ prefs: { welcomeSeen: opts.welcome === true ? false : true } }))
  }
  const env = scrubbedEnv(process.env)
  Object.assign(env, worldEnv, {
    REGATTA_TEST: '1',
    REGATTA_CWD: opts.cwd ?? repo,
    REGATTA_SKIP_LOGIN_ENV: '1',
    REGATTA_USER_DATA: profile,
    REGATTA_HIDDEN: opts.visible ? '0' : '1',
    ...(opts.env ?? {})
  })
  const keepWorld = process.env.REGATTA_E2E_KEEP_WORLD === '1'
  // Generous limits: a fresh Electron copy (every new worktree has one) is security-scanned by macOS on its
  // first launch, which can take well over 30 seconds while several apps start at once.
  const launchOptions = opts.executablePath
    ? { executablePath: opts.executablePath, args: [], cwd: repo, env, timeout: 120000 }
    : { args: ['.'], cwd: repo, env, timeout: 120000 }
  const app = await electron.launch(launchOptions)
  const win = await app.firstWindow({ timeout: 120000 })
  win.on('pageerror', (e) => console.log(`  [${name}] PAGE ERROR: ${e.message}`))
  await win.waitForSelector('[data-testid=new-pane-button], [data-testid=start-fake]', { timeout: 20000 })
  await win.waitForTimeout(300)

  // A fake world starts with an empty checkpoint store, and the app snapshots the whole project folder before it passes the
  // first message of a session on. For this repository that took about 2.1 s here, against 0.13 s once a store has it, and
  // a loaded machine has stretched it past a test's 5 s wait. So the first state wait of each launch gets this much more.
  let firstStepAllowanceMs = 10000

  const results = []
  const t = {
    app,
    win,
    shots,
    /** The user data folder this run uses. */
    profile,
    /** The fake world's folder (see the top of this file). */
    world,
    /** The fake home folder, `<world>/home`. With `realHome` the app's own home is the real one and this folder only backs the accounts store. */
    home,
    /** Every stand-in call so far, one string per call: "<command> <arguments>". */
    standinCalls() {
      try {
        return readFileSync(join(world, 'standins.log'), 'utf8').split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
    /** Records a check. */
    check(label, ok, detail = '') {
      results.push({ label, ok: Boolean(ok) })
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
    },
    async shot(file) {
      const path = `${shots}/${file}.png`
      const png = await captureWindow(app, win.url())
      if (png) {
        writeFileSync(path, Buffer.from(png, 'base64'))
        return
      }
      console.log(`  [${name}] capturePage came back empty, falling back to page.screenshot for ${file}`)
      await win.screenshot({ path })
    },
    /** Starts an agent from the New pane menu by its menu label, for example "Test Agent" or "Terminal". */
    async startAgent(label) {
      const before = await win.locator('[data-testid=pane]').count()
      await win.click('[data-testid=new-pane-button]')
      await win.locator('[data-testid=new-pane-menu] button', { hasText: label }).first().click()
      await win.waitForFunction((n) => document.querySelectorAll('[data-testid=pane]').length === n, before + 1, { timeout: 10000 })
      await win.waitForTimeout(300)
    },
    pane(i) {
      return win.locator('[data-testid=pane]').nth(i)
    },
    async sessionId(i) {
      return t.pane(i).getAttribute('data-session')
    },
    async stateOf(i) {
      return t.pane(i).getAttribute('data-state')
    },
    async waitForState(i, state, timeout = 8000) {
      const extra = firstStepAllowanceMs
      firstStepAllowanceMs = 0
      await win.waitForFunction(
        ([idx, st]) => document.querySelectorAll('[data-testid=pane]')[idx]?.getAttribute('data-state') === st,
        [i, state],
        { timeout: timeout + extra }
      )
    },
    async typeInto(i, text) {
      await t.pane(i).locator('.xterm').click()
      await win.keyboard.type(text)
      await win.keyboard.press('Enter')
    },
    /** Plain text currently in pane i. */
    async textOf(i) {
      return win.evaluate((id) => window.__regattaText(id), await t.sessionId(i))
    },
    /** Runs a step; a thrown error becomes a failed check instead of stopping the test. */
    async step(label, fn) {
      try {
        await fn()
      } catch (err) {
        t.check(label, false, String(err.message).split('\n')[0])
        await t.shot(`error-${label.replace(/\W+/g, '-').slice(0, 40)}`).catch(() => undefined)
      }
    },
    async close() {
      await app.close().catch(() => undefined)
      // The world goes with the app. REGATTA_E2E_KEEP_WORLD=1 keeps it, to look at what a run left behind.
      if (keepWorld) {
        madeFolders.delete(world)
        console.log(`  [${name}] world kept at ${world}`)
      } else removeFolder(world)
      return results
    }
  }
  return t
}
