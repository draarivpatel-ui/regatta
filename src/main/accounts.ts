// AccountStore: manages sign-ins for Claude Code and Codex.
// Each saved account is a folder used as CLAUDE_CONFIG_DIR or CODEX_HOME.
// The computer's own sign-in is always present as "<cli>:system" with dir: null.

import { randomUUID } from 'node:crypto'
import { access, readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { AccountInfo } from '../shared/types'

export interface AccountStoreDeps {
  dataDir: string
  accountsDir?: string
  home?: string
  emit: (list: AccountInfo[]) => void
}

interface StoredAccount {
  id: string
  cli: 'claude' | 'codex'
  name: string
  folder: string
}

interface StoredData {
  defaults: { claude?: string; codex?: string }
  accounts: StoredAccount[]
}

const ACCOUNTS_FILE = 'accounts.json'
const SYSTEM_ID_SUFFIX = ':system'
const CLAUDE_CONFIG_FILE = '.claude.json'
const CODEX_AUTH_DIR = '.codex'
const CODEX_AUTH_FILE = 'auth.json'

export class AccountStore {
  private readonly dataDir: string
  private readonly accountsRoot: string
  private readonly home: string
  private readonly emit: (list: AccountInfo[]) => void
  private data: StoredData = { defaults: {}, accounts: [] }

  constructor(deps: AccountStoreDeps) {
    this.dataDir = deps.dataDir
    this.accountsRoot = deps.accountsDir ?? join(deps.dataDir, 'accounts')
    this.home = deps.home ?? process.env.HOME ?? '/'
    this.emit = deps.emit
    this.loadSync()
  }

  private loadSync(): void {
    const file = join(this.dataDir, ACCOUNTS_FILE)
    try {
      const content = readFileSync(file, 'utf8')
      this.data = JSON.parse(content) as StoredData
    } catch {
      this.data = { defaults: {}, accounts: [] }
    }
  }

  private async load(): Promise<void> {
    const file = join(this.dataDir, ACCOUNTS_FILE)
    try {
      const content = await readFile(file, 'utf8')
      this.data = JSON.parse(content) as StoredData
    } catch {
      this.data = { defaults: {}, accounts: [] }
    }
  }

  private async save(): Promise<void> {
    const file = join(this.dataDir, ACCOUNTS_FILE)
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    await rename(tmp, file)
    this.emit(await this.list())
  }

  root(): string {
    return this.accountsRoot
  }

  /** The folder of every saved Codex sign-in (its CODEX_HOME), for reading its usage. */
  codexHomes(): string[] {
    return this.data.accounts.filter((a) => a.cli === 'codex').map((a) => join(this.root(), a.cli, a.folder))
  }

  async list(): Promise<AccountInfo[]> {
    const result: AccountInfo[] = []

    for (const cli of ['claude', 'codex'] as const) {
      result.push(await this.systemAccount(cli))
      const cliAccounts = this.data.accounts.filter((a) => a.cli === cli).sort((a, b) => a.name.localeCompare(b.name))
      for (const acc of cliAccounts) {
        result.push(await this.toAccountInfo(acc))
      }
    }
    return result
  }

  private async systemAccount(cli: 'claude' | 'codex'): Promise<AccountInfo> {
    const id = `${cli}${SYSTEM_ID_SUFFIX}`
    const isDefault = this.isDefault(cli, id)
    const { signedIn, email } = await this.detectSignIn(cli, null)
    return {
      id,
      cli,
      name: 'Your computer sign-in',
      dir: null,
      isDefault,
      signedIn,
      email
    }
  }

  private isDefault(cli: 'claude' | 'codex', id: string): boolean {
    const def = this.data.defaults[cli]
    if (!def) return id.endsWith(SYSTEM_ID_SUFFIX)
    const exists = this.data.accounts.some((a) => a.id === def) || def.endsWith(SYSTEM_ID_SUFFIX)
    return exists && def === id
  }

  private async detectSignIn(cli: 'claude' | 'codex', dir: string | null): Promise<{ signedIn: boolean | null; email: string | null }> {
    const missing = (err: unknown): { signedIn: boolean | null; email: null } => ({
      signedIn: (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null,
      email: null
    })
    if (cli === 'codex') {
      // CODEX_HOME is the account folder itself; the computer's own is ~/.codex. Only whether the
      // file exists is checked: its contents are credentials and are never read.
      const file = dir ? join(dir, CODEX_AUTH_FILE) : join(this.home, CODEX_AUTH_DIR, CODEX_AUTH_FILE)
      try {
        await access(file)
        return { signedIn: true, email: null }
      } catch (err) {
        return missing(err)
      }
    }
    let content: string
    try {
      content = await readFile(join(dir ?? this.home, CLAUDE_CONFIG_FILE), 'utf8')
    } catch (err) {
      return missing(err)
    }
    try {
      const parsed = JSON.parse(content) as { oauthAccount?: { emailAddress?: unknown } | null }
      const account = parsed.oauthAccount
      if (account && typeof account === 'object') {
        return { signedIn: true, email: typeof account.emailAddress === 'string' ? account.emailAddress : null }
      }
      return { signedIn: false, email: null }
    } catch {
      return { signedIn: null, email: null }
    }
  }

  private async toAccountInfo(acc: StoredAccount): Promise<AccountInfo> {
    const fullDir = join(this.root(), acc.cli, acc.folder)
    const isDefault = this.isDefault(acc.cli, acc.id)
    const { signedIn, email } = await this.detectSignIn(acc.cli, fullDir)
    return {
      id: acc.id,
      cli: acc.cli,
      name: acc.name,
      dir: fullDir,
      isDefault,
      signedIn,
      email
    }
  }

  private sanitizeFolder(cli: 'claude' | 'codex', name: string): string {
    let folder = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    if (!folder) folder = 'account'
    let candidate = folder
    let suffix = 2
    while (this.data.accounts.some((a) => a.cli === cli && a.folder === candidate)) {
      candidate = `${folder}-${suffix}`
      suffix++
    }
    return candidate
  }

  private ensureUniqueName(cli: 'claude' | 'codex', name: string): void {
    const lower = name.toLowerCase()
    if (lower === 'your computer sign-in') throw new Error('That name is reserved.')
    if (this.data.accounts.some((a) => a.cli === cli && a.name.toLowerCase() === lower)) {
      throw new Error('An account with that name already exists.')
    }
  }

  async add(cli: 'claude' | 'codex', name: string): Promise<AccountInfo> {
    if (name.length < 1 || name.length > 40) throw new Error('Name must be 1 to 40 characters.')
    this.ensureUniqueName(cli, name)
    const folder = this.sanitizeFolder(cli, name)
    const id = `${cli}:${folder}`
    const fullDir = join(this.root(), cli, folder)
    await mkdir(fullDir, { recursive: true, mode: 0o700 })
    const acc: StoredAccount = { id, cli, name, folder }
    this.data.accounts.push(acc)
    await this.save()
    return this.toAccountInfo(acc)
  }

  async remove(id: string): Promise<AccountInfo[]> {
    const idx = this.data.accounts.findIndex((a) => a.id === id)
    if (idx === -1) throw new Error('Account not found.')
    const acc = this.data.accounts[idx]
    if (!acc) throw new Error('Account not found.')
    if (acc.id.endsWith(SYSTEM_ID_SUFFIX)) throw new Error('Cannot remove the computer sign-in.')
    // The folder's real path (links followed) must be inside the accounts folder; one already gone is fine.
    let realDir: string | null = null
    try {
      realDir = realpathSync(join(this.root(), acc.cli, acc.folder))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    if (realDir !== null) {
      const realRoot = realpathSync(this.root())
      if (!realDir.startsWith(realRoot + sep)) throw new Error('Refusing to delete a folder outside the accounts root.')
    }
    const wasDefault = this.isDefault(acc.cli, acc.id)
    if (realDir !== null) await rm(realDir, { recursive: true, force: true })
    this.data.accounts.splice(idx, 1)
    if (wasDefault) delete this.data.defaults[acc.cli]
    await this.save()
    return this.list()
  }

  async setDefault(cli: 'claude' | 'codex', id: string): Promise<AccountInfo[]> {
    const exists = this.data.accounts.some((a) => a.id === id) || id === `${cli}${SYSTEM_ID_SUFFIX}`
    if (!exists) throw new Error('Account not found for that CLI.')
    this.data.defaults[cli] = id
    await this.save()
    return this.list()
  }

  resolve(agent: string, account: string | null): string | null {
    if (agent !== 'claude' && agent !== 'codex') return null
    const cli = agent
    if (!account) return this.data.defaults[cli] ?? `${cli}${SYSTEM_ID_SUFFIX}`
    const acc = this.data.accounts.find((a) => a.id === account)
    if (acc) return account
    if (account === `${cli}${SYSTEM_ID_SUFFIX}`) return account
    return this.data.defaults[cli] ?? `${cli}${SYSTEM_ID_SUFFIX}`
  }

  envFor(agent: string, account: string | null): Record<string, string> {
    if (agent !== 'claude' && agent !== 'codex') return {}
    const resolved = this.resolve(agent, account)
    if (!resolved || resolved.endsWith(SYSTEM_ID_SUFFIX)) return {}
    const acc = this.data.accounts.find((a) => a.id === resolved)
    if (!acc) return {}
    const fullDir = join(this.root(), acc.cli, acc.folder)
    return agent === 'claude' ? { CLAUDE_CONFIG_DIR: fullDir } : { CODEX_HOME: fullDir }
  }
}