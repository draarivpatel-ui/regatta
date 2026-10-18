// The fake world itself: every launch gets its own empty home, stand-in
// commands, a test git config and a worktrees folder, so no test reads or writes anything real.
// This test checks the world from the inside, the way the app and its shells see it.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { ABSENT_COMMANDS, AGENT_COMMANDS, SERVICE_COMMANDS, buildPath, launch, makeWorld, removeWorld, repo } from './lib.mjs'

/** Where `name` would be found on a PATH string, or null. Mirrors how a shell looks commands up. */
function lookup(name, pathString) {
  for (const dir of pathString.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not in this folder
    }
  }
  return null
}

export default async function world() {
  const realHome = process.env.HOME
  // Planted in this process's environment before the launch: the world has to keep them out of the app.
  process.env.SUPABASE_ACCESS_TOKEN = 'e2e-planted-token'
  process.env.CLAUDE_CONFIG_DIR = '/nonexistent/e2e-planted-claude-config'
  let t
  try {
    t = await launch('world', {
      homeFiles: { '.ssh/config': 'Host regatta-e2e-alias\n  HostName 192.0.2.7\n  Port 2222\n' }
    })
  } finally {
    delete process.env.SUPABASE_ACCESS_TOKEN
    delete process.env.CLAUDE_CONFIG_DIR
  }
  const { win } = t
  const mainEnv = (name) => t.app.evaluate((_electron, key) => process.env[key] ?? null, name)

  await t.step('the app is given the fake home in every way it can ask', async () => {
    const fromElectron = await t.app.evaluate(({ app }) => app.getPath('home'))
    const fromNode = await t.app.evaluate(() => process.getBuiltinModule('node:os').homedir())
    const fromBridge = (await win.evaluate(() => window.regatta.invoke('app:info'))).home
    t.check('app.getPath("home") is the fake home', fromElectron === t.home, fromElectron)
    t.check('os.homedir() is the fake home', fromNode === t.home, fromNode)
    t.check('the renderer is told the fake home', fromBridge === t.home, fromBridge)
    t.check('the fake home is inside the world folder', t.home === join(t.world, 'home'), t.home)
    t.check('none of them is the real home', ![fromElectron, fromNode, fromBridge].includes(realHome), String(realHome))
    t.check('HOME and CFFIXED_USER_HOME both point at it', (await mainEnv('HOME')) === t.home && (await mainEnv('CFFIXED_USER_HOME')) === t.home)
  })

  await t.step('a shell pane sees the fake home too', async () => {
    await t.startAgent('Terminal')
    await win.waitForTimeout(1000)
    // The word "~" only expands at the start of a word, so the marker goes before it with a space between.
    await t.typeInto(0, 'echo HOMEIS ~')
    await win.waitForTimeout(1200)
    const text = await t.textOf(0)
    t.check('"~" in the shell is the fake home', text.includes(`HOMEIS ${t.home}`), text.slice(-200))
    await t.shot('01-shell-home')
  })

  await t.step('git sees only the test config', async () => {
    const git = (args) =>
      t.app.evaluate((_electron, a) => process.getBuiltinModule('node:child_process').execFileSync('git', a, { encoding: 'utf8' }), args)
    const listing = (await git(['config', '--global', '--list', '--show-origin'])).trim().split('\n')
    const origins = new Set(listing.map((line) => line.split('\t')[0]))
    t.check('every global setting comes from the .gitconfig in the fake home', origins.size === 1 && origins.has(`file:${t.home}/.gitconfig`), [...origins].join(', '))
    t.check('the identity is the test identity', listing.some((l) => l.endsWith('user.email=test@example.com')) && listing.some((l) => l.endsWith('user.name=Regatta Test')))
    t.check('no hooks or signing are configured globally', !listing.some((l) => /hookspath|gpgsign|signingkey/i.test(l)), listing.join(' | '))
    t.check('the system config is switched off', (await mainEnv('GIT_CONFIG_NOSYSTEM')) === '1')
    // The test process runs git as well (it makes throwaway repos), so it has a config of its own too.
    const own = execFileSync('git', ['config', '--global', '--get', 'user.email'], { encoding: 'utf8' }).trim()
    t.check('the test process uses the test identity too', own === 'test@example.com', own)
  })

  await t.step('every agent CLI is a stand-in', async () => {
    const list = await win.evaluate(() => window.regatta.invoke('agents:list'))
    const clis = list.filter((a) => a.kind !== 'shell' && a.kind !== 'fake')
    const commands = clis.map((a) => a.command).sort()
    t.check('the agents Regatta knows are exactly the ones with a stand-in', JSON.stringify(commands) === JSON.stringify([...AGENT_COMMANDS].sort()), commands.join(', '))
    for (const agent of clis) {
      const here = agent.path === join(t.world, 'bin', agent.command)
      t.check(`${agent.command} is a stand-in from the world`, agent.installed && here && agent.version === '0.0.0 (e2e stand-in)', `${agent.path} ${agent.version}`)
    }
    const calls = t.standinCalls()
    for (const command of AGENT_COMMANDS) t.check(`the log shows "${command} --version"`, calls.includes(`${command} --version`), `${calls.length} calls`)
  })

  await t.step('every service CLI is a stand-in, and one is missing on purpose', async () => {
    const rows = await win.evaluate(() => window.regatta.invoke('services:check'))
    const ids = rows.map((r) => r.id).sort()
    t.check('the services Regatta checks are exactly the ones set up here', JSON.stringify(ids) === JSON.stringify([...SERVICE_COMMANDS, ...ABSENT_COMMANDS].sort()), ids.join(', '))
    for (const row of rows) {
      const wantInstalled = SERVICE_COMMANDS.includes(row.id)
      t.check(`${row.id} is ${wantInstalled ? 'installed' : 'not installed'}`, row.installed === wantInstalled && (!wantInstalled || row.version === '0.0.0'), `${row.installed} ${row.version}`)
    }
    const supabase = rows.find((r) => r.id === 'supabase')
    t.check('a token planted in this process never reached the app', supabase?.signedIn === 'unknown' && (await mainEnv('SUPABASE_ACCESS_TOKEN')) === null, supabase?.detail)
    t.check('nor did a planted config folder', (await mainEnv('CLAUDE_CONFIG_DIR')) === null)
    t.check('no Shopify command exists in the stand-ins folder', !existsSync(join(t.world, 'bin', 'shopify')))
  })

  await t.step('the stand-ins answer the way the services expect', async () => {
    const env = { ...process.env, HOME: t.home }
    const run = (command, args) => {
      try {
        return { code: 0, out: execFileSync(join(t.world, 'bin', command), args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
      } catch (err) {
        return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
      }
    }
    const version = run('stripe', ['version'])
    t.check('stripe version prints a version and exits 0', version.code === 0 && version.out.includes('0.0.0'), version.out.trim())
    const status = run('gh', ['auth', 'status'])
    t.check('gh auth status says not signed in and exits 1', status.code === 1 && status.out.includes('not signed in'), `${status.code} ${status.out.trim()}`)
    const odd = run('vercel', ['--version', '--extra'])
    t.check('a version flag with more words is not a version request', odd.code === 1, `${odd.code}`)
    const calls = t.standinCalls()
    t.check('those three calls are in the log', calls.includes('stripe version') && calls.includes('gh auth status') && calls.includes('vercel --version --extra'))
    const agent = run('codex', ['--version'])
    t.check('an agent stand-in prints its version', agent.code === 0 && agent.out.trim() === '0.0.0 (e2e stand-in)', agent.out.trim())
  })

  await t.step('ssh reads the config in the fake home, not the real one', async () => {
    const env = { ...process.env, HOME: t.home }
    const out = execFileSync(join(t.world, 'bin', 'ssh'), ['-G', 'regatta-e2e-alias'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    t.check('the alias comes from ~/.ssh/config in the fake home', /^hostname 192\.0\.2\.7$/m.test(out) && /^port 2222$/m.test(out), out.split('\n').slice(0, 3).join(' | '))
    t.check('the call is in the log', t.standinCalls().includes('ssh -G regatta-e2e-alias'))
  })

  await t.step('checkpoints are written into the fake home', async () => {
    await t.startAgent('Test Agent')
    await t.typeInto(1, 'add a login form')
    await t.waitForState(1, 'working', 6000)
    await t.waitForState(1, 'idle', 9000)
    const root = realpathSync(repo)
    const key = createHash('sha1').update(root).digest('hex').slice(0, 12)
    const folder = join(t.home, '.regatta', 'checkpoints', key)
    t.check('this project has a checkpoint folder in the fake home', existsSync(folder), folder)
    t.check('it is the only project there', readdirSync(join(t.home, '.regatta', 'checkpoints')).join() === key, readdirSync(join(t.home, '.regatta', 'checkpoints')).join())
    await t.shot('02-checkpoints')
  })

  await t.step('worktrees go to the world folder', async () => {
    t.check('REGATTA_WORKTREES_DIR is the worktrees folder of the world', (await mainEnv('REGATTA_WORKTREES_DIR')) === join(t.world, 'worktrees'))
    t.check('PATH starts with the stand-ins folder', ((await mainEnv('PATH')) ?? '').startsWith(`${join(t.world, 'bin')}${delimiter}`))
  })

  await t.step('a command can be hidden from a PATH that has it', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'regatta-e2e-world-test-'))
    try {
      const machine = join(scratch, 'machine-bin')
      mkdirSync(machine)
      for (const name of ['shopify', 'keepme']) {
        writeFileSync(join(machine, name), '#!/bin/sh\nexit 0\n')
        chmodSync(join(machine, name), 0o755)
      }
      const standins = join(scratch, 'standins')
      mkdirSync(standins)
      const path = buildPath(`${machine}${delimiter}/usr/bin`, standins, join(scratch, 'mirrors'), ['shopify'])
      t.check('the stand-ins folder comes first', path.split(delimiter)[0] === standins)
      t.check('the hidden command is gone', lookup('shopify', path) === null, String(lookup('shopify', path)))
      t.check('its neighbours are still found', lookup('keepme', path) !== null)
      t.check('a folder without it is left as it was', path.split(delimiter).includes('/usr/bin'))
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  await t.step('a test can keep its own worktrees folder, but one from the shell is ignored', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'regatta-e2e-world-test-'))
    try {
      const own = join(scratch, 'own-worktrees')
      process.env.REGATTA_WORKTREES_DIR = own
      const made = makeWorld()
      delete process.env.REGATTA_WORKTREES_DIR
      try {
        t.check('a folder set by the test wins over the world one', made.env.REGATTA_WORKTREES_DIR === own, made.env.REGATTA_WORKTREES_DIR)
      } finally {
        removeWorld(made.world)
      }
      // A child process that starts with a worktrees folder in its environment, as a developer's shell might have.
      const libUrl = new URL('./lib.mjs', import.meta.url).href
      const seen = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(libUrl)}); console.log(String(process.env.REGATTA_WORKTREES_DIR))`], {
        env: { ...process.env, REGATTA_WORKTREES_DIR: join(scratch, 'from-the-shell') },
        encoding: 'utf8'
      }).trim()
      t.check('a worktrees folder inherited from the shell is dropped', seen === 'undefined', seen)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  await t.step('realHome keeps only the real home', async () => {
    const real = makeWorld({ realHome: true })
    try {
      t.check('HOME is left alone', !('HOME' in real.env) && !('CFFIXED_USER_HOME' in real.env))
      t.check('PATH still starts with the stand-ins', real.env.PATH.startsWith(`${join(real.world, 'bin')}${delimiter}`))
      t.check('the test git config still applies', real.env.GIT_CONFIG_GLOBAL === join(real.world, 'home', '.gitconfig') && real.env.GIT_CONFIG_NOSYSTEM === '1')
      t.check('the accounts store still reads the fake home', real.env.REGATTA_TEST_HOME === join(real.world, 'home'))
      t.check('the worktrees folder is still the world one', real.env.REGATTA_WORKTREES_DIR === join(real.world, 'worktrees'))
    } finally {
      removeWorld(real.world)
    }
  })

  return t.close()
}
