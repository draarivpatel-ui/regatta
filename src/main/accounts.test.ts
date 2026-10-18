import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile, access, chmod, symlink, constants } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore } from './accounts'
import type { AccountInfo } from '../shared/types'

// Fresh folders per test, so parallel runs (other worktrees, other test files) never share them.
let TEST_HOME = ''
let TEST_DATA = ''
let TEST_ACCOUNTS = ''
let TEST_BASE = ''

function createStore(overrides: Partial<{ dataDir: string; accountsDir: string; home: string }> = {}) {
  const emitted: AccountInfo[][] = []
  const store = new AccountStore({
    dataDir: overrides.dataDir ?? TEST_DATA,
    accountsDir: overrides.accountsDir ?? TEST_ACCOUNTS,
    home: overrides.home ?? TEST_HOME,
    emit: (list) => emitted.push(list)
  })
  return { store, emitted }
}

async function setupFixture() {
  TEST_BASE = mkdtempSync(join(tmpdir(), 'regatta-accounts-'))
  TEST_HOME = join(TEST_BASE, 'home')
  TEST_DATA = join(TEST_BASE, 'data')
  TEST_ACCOUNTS = join(TEST_BASE, 'accounts')
  await mkdir(TEST_HOME, { recursive: true })
  await mkdir(TEST_DATA, { recursive: true })
  await mkdir(TEST_ACCOUNTS, { recursive: true })
}

async function teardownFixture() {
  await rm(TEST_BASE, { recursive: true, force: true })
}

describe('AccountStore', () => {
  beforeEach(async () => {
    await setupFixture()
  })

  afterEach(async () => {
    await teardownFixture()
  })

  it('lists computer sign-ins first and as default', async () => {
    const { store } = createStore()
    const list = await store.list()
    const claudeSystem = list.find((a) => a.cli === 'claude' && a.id === 'claude:system')
    const codexSystem = list.find((a) => a.cli === 'codex' && a.id === 'codex:system')
    expect(claudeSystem).toBeDefined()
    expect(codexSystem).toBeDefined()
    expect(claudeSystem?.isDefault).toBe(true)
    expect(codexSystem?.isDefault).toBe(true)
    expect(claudeSystem?.dir).toBeNull()
    expect(codexSystem?.dir).toBeNull()
  })

  it('adds account: folder created with mode 0700', async () => {
    const { store } = createStore()
    const acc = await store.add('claude', 'Work')
    expect(acc.id).toBe('claude:work')
    expect(acc.name).toBe('Work')
    expect(acc.cli).toBe('claude')
    expect(acc.dir).toBe(join(TEST_ACCOUNTS, 'claude', 'work'))
    // folder exists
    await access(acc.dir!, constants.R_OK | constants.W_OK | constants.X_OK)
  })

  it('add enforces unique names per CLI ignoring case', async () => {
    const { store } = createStore()
    await store.add('claude', 'Work')
    await expect(store.add('claude', 'work')).rejects.toThrow('already exists')
    await expect(store.add('claude', 'WORK')).rejects.toThrow('already exists')
    // different CLI is fine
    const codexWork = await store.add('codex', 'Work')
    expect(codexWork.id).toBe('codex:work')
  })

  it('add reserves "Your computer sign-in"', async () => {
    const { store } = createStore()
    await expect(store.add('claude', 'Your computer sign-in')).rejects.toThrow('reserved')
  })

  it('folder clashes get -2, -3 suffix within same CLI', async () => {
    const { store } = createStore()
    await store.add('claude', 'Work')
    await store.add('claude', 'Work 2') // same CLI, similar name -> work-2
    const list = await store.list()
    const work2 = list.find((a) => a.cli === 'claude' && a.name === 'Work 2')
    expect(work2?.dir?.split('/').pop()).toBe('work-2')
  })

  it('setDefault and resolve', async () => {
    const { store } = createStore()
    const work = await store.add('claude', 'Work')
    await store.setDefault('claude', work.id)
    const list = await store.list()
    const workAfter = list.find((a) => a.id === work.id)
    const sys = list.find((a) => a.id === 'claude:system')
    expect(workAfter?.isDefault).toBe(true)
    expect(sys?.isDefault).toBe(false)
    // resolve returns the account when it exists
    expect(store.resolve('claude', work.id)).toBe(work.id)
    // resolve returns default when given account doesn't exist
    expect(store.resolve('claude', 'claude:nonexistent')).toBe(work.id)
    // resolve returns system when no default set
    await store.setDefault('claude', 'claude:system')
    expect(store.resolve('claude', null)).toBe('claude:system')
  })

  it('envFor for both CLIs and computer sign-in', async () => {
    const { store } = createStore()
    const work = await store.add('claude', 'Work')
    const codexWork = await store.add('codex', 'CodexWork')
    // computer sign-in returns empty
    expect(store.envFor('claude', 'claude:system')).toEqual({})
    expect(store.envFor('codex', 'codex:system')).toEqual({})
    // other agents return empty
    expect(store.envFor('gemini', null)).toEqual({})
    // saved accounts return proper env
    expect(store.envFor('claude', work.id)).toEqual({ CLAUDE_CONFIG_DIR: join(TEST_ACCOUNTS, 'claude', 'work') })
    expect(store.envFor('codex', codexWork.id)).toEqual({ CODEX_HOME: join(TEST_ACCOUNTS, 'codex', 'codexwork') })
  })

  it('signed-in detection from .claude.json with and without oauthAccount, unreadable', async () => {
    const { store } = createStore()
    // computer sign-in: no file -> not signed in
    let list = await store.list()
    let sysClaude = list.find((a) => a.id === 'claude:system')
    expect(sysClaude?.signedIn).toBe(false)
    expect(sysClaude?.email).toBeNull()

    // write .claude.json without oauthAccount
    await writeFile(join(TEST_HOME, '.claude.json'), JSON.stringify({}), 'utf8')
    // create new store to reload
    const { store: store2 } = createStore()
    list = await store2.list()
    sysClaude = list.find((a) => a.id === 'claude:system')
    expect(sysClaude?.signedIn).toBe(false)

    // write .claude.json with oauthAccount
    await writeFile(join(TEST_HOME, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'ada@example.com' } }), 'utf8')
    const { store: store3 } = createStore()
    list = await store3.list()
    sysClaude = list.find((a) => a.id === 'claude:system')
    expect(sysClaude?.signedIn).toBe(true)
    expect(sysClaude?.email).toBe('ada@example.com')

    // a file that cannot be parsed -> unknown
    await writeFile(join(TEST_HOME, '.claude.json'), '{ not json', 'utf8')
    const { store: store4 } = createStore()
    sysClaude = (await store4.list()).find((a) => a.id === 'claude:system')
    expect(sysClaude?.signedIn).toBeNull()

    // a saved account reads <its folder>/.claude.json
    const work = await store4.add('claude', 'Work')
    await writeFile(join(work.dir!, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com' } }), 'utf8')
    const saved = (await store4.list()).find((a) => a.id === work.id)
    expect(saved?.signedIn).toBe(true)
    expect(saved?.email).toBe('work@example.com')
  })

  it('signed-in detection from auth.json for Codex', async () => {
    const { store } = createStore()
    let list = await store.list()
    let sysCodex = list.find((a) => a.id === 'codex:system')
    expect(sysCodex?.signedIn).toBe(false)

    await mkdir(join(TEST_HOME, '.codex'), { recursive: true })
    await writeFile(join(TEST_HOME, '.codex', 'auth.json'), JSON.stringify({}), 'utf8')
    const { store: store2 } = createStore()
    list = await store2.list()
    sysCodex = list.find((a) => a.id === 'codex:system')
    expect(sysCodex?.signedIn).toBe(true)
    expect(sysCodex?.email).toBeNull()
  })

  it('a saved Codex account is signed in when <its folder>/auth.json exists, without reading it', async () => {
    const { store } = createStore()
    const work = await store.add('codex', 'Work')
    expect((await store.list()).find((a) => a.id === work.id)?.signedIn).toBe(false)
    // CODEX_HOME is the account folder itself, so the file sits directly inside it.
    const auth = join(work.dir!, 'auth.json')
    await writeFile(auth, 'not json, and never read', 'utf8')
    await chmod(auth, 0o000)
    try {
      const saved = (await store.list()).find((a) => a.id === work.id)
      expect(saved?.signedIn).toBe(true)
      expect(saved?.email).toBeNull()
    } finally {
      await chmod(auth, 0o600)
    }
  })

  it('remove refuses an account folder that links outside the accounts folder, and keeps the target', async () => {
    const { store } = createStore()
    const work = await store.add('claude', 'Work')
    const outside = join(TEST_BASE, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'keep.txt'), 'keep', 'utf8')
    await rm(work.dir!, { recursive: true, force: true })
    await symlink(outside, work.dir!)
    await expect(store.remove(work.id)).rejects.toThrow(/outside the accounts root/)
    await expect(access(join(outside, 'keep.txt'), constants.F_OK)).resolves.toBeUndefined()
  })

  it('remove works when the account folder is already gone', async () => {
    const { store } = createStore()
    const work = await store.add('claude', 'Work')
    await rm(work.dir!, { recursive: true, force: true })
    const list = await store.remove(work.id)
    expect(list.find((a) => a.id === work.id)).toBeUndefined()
  })

  it('remove deletes only folder inside root and moves default back', async () => {
    const { store } = createStore()
    const work = await store.add('claude', 'Work')
    await store.setDefault('claude', work.id)
    await store.remove(work.id)
    const list = await store.list()
    const sys = list.find((a) => a.id === 'claude:system')
    expect(sys?.isDefault).toBe(true)
    // folder should be gone
    await expect(access(work.dir!, constants.F_OK)).rejects.toThrow()
  })

  it('reload from disk preserves accounts', async () => {
    const { store } = createStore()
    const work = await store.add('claude', 'Work')
    await store.setDefault('claude', work.id)
    // create new store instance pointing to same data
    const { store: store2 } = createStore()
    const list = await store2.list()
    const work2 = list.find((a) => a.id === work.id)
    expect(work2).toBeDefined()
    expect(work2?.isDefault).toBe(true)
  })
})