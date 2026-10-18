// Service checks run against fake CLIs (small /bin/sh scripts in a temp folder on PATH) that
// print canned text, exit with set codes, and log every argument list they were called with.
// No real CLI, no login, no logout, no token.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ServiceStatus } from '../shared/types'
import { checkServices, type ServicesDeps } from './services'

const NOW = 1_760_000_000_000
const suiteDir = mkdtempSync(join(tmpdir(), 'regatta-services-'))

afterAll(() => {
  rmSync(suiteDir, { recursive: true, force: true })
})

interface Box {
  env: Record<string, string>
  home: string
  log: string
}

/** A sandbox: a bin folder with the named fake executables, a home folder, and a call log. */
function box(services: Record<string, string>, extraEnv: Record<string, string> = {}): Box {
  const dir = mkdtempSync(join(suiteDir, 'case-'))
  const bin = join(dir, 'bin')
  const home = join(dir, 'home')
  mkdirSync(bin)
  mkdirSync(home)
  const log = join(dir, 'calls.log')
  writeFileSync(log, '', 'utf8')
  for (const [name, body] of Object.entries(services)) {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8')
    chmodSync(path, 0o755)
  }
  // The fake bin comes first; system folders are appended so scripts can use /usr/bin/env.
  return { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKELOG: log, ...extraEnv }, home, log }
}

function deps(b: Box, overrides: Partial<ServicesDeps> = {}): ServicesDeps {
  return { env: () => b.env, home: b.home, now: () => NOW, timeoutMs: 500, ...overrides }
}

/** Argument lists the fake scripts were called with, for example ["gh --version"]. */
function calls(b: Box): string[] {
  return readFileSync(b.log, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

function byId(list: ServiceStatus[], id: ServiceStatus['id']): ServiceStatus {
  const found = list.find((s) => s.id === id)
  if (!found) throw new Error(`no row for ${id}`)
  return found
}

// Canned fakes. Each logs "$0-name $*" so a test can assert exactly how it was called.
const GH_SIGNED_IN = `echo "gh $*" >> "$FAKELOG"
case "$*" in
  "--version") echo "gh version 2.62.0 (2024-11-01)"; exit 0 ;;
  "auth status") echo "  Logged in to github.com account example-user (keyring)" >&2; exit 0 ;;
esac
exit 1`

const GH_SIGNED_OUT = `echo "gh $*" >> "$FAKELOG"
case "$*" in
  "--version") echo "gh version 2.62.0 (2024-11-01)"; exit 0 ;;
  "auth status") echo "not logged in to any hosts" >&2; exit 4 ;;
esac
exit 1`

const GLAB_OK = `echo "glab $*" >> "$FAKELOG"
case "$*" in
  "--version") echo "glab version 1.80.4"; exit 0 ;;
  "auth status") echo "Logged in to gitlab.com"; exit 0 ;;
esac
exit 1`

const GLAB_FAILS = `echo "glab $*" >> "$FAKELOG"
case "$*" in
  "--version") echo "glab version 1.80.4"; exit 0 ;;
  "auth status") echo "could not authenticate you" >&2; exit 1 ;;
esac
exit 1`

const STRIPE_TWO_ACCOUNTS = `echo "stripe $*" >> "$FAKELOG"
case "$*" in
  "version") echo "1.44.0"; exit 0 ;;
  "login list") echo "Available accounts:"; echo "work-account"; echo "personal-account"; exit 0 ;;
esac
exit 1`

const STRIPE_NONE = `echo "stripe $*" >> "$FAKELOG"
case "$*" in
  "version") echo "1.44.0"; exit 0 ;;
  "login list") echo "Available accounts:"; exit 0 ;;
esac
exit 1`

const STRIPE_FAILS = `echo "stripe $*" >> "$FAKELOG"
case "$*" in
  "version") echo "1.44.0"; exit 0 ;;
  "login list") echo "something went wrong" >&2; exit 3 ;;
esac
exit 1`

const WRANGLER_EMAIL = `echo "wrangler $*" >> "$FAKELOG"
case "$*" in
  "--version") echo "4.42.0"; exit 0 ;;
  "whoami --json") echo '{"success":true,"operation":"whoami","result":{"accounts":[{"account":{"id":"a1","name":"Work","email":"dev@example.com"}}]}}'; exit 0 ;;
esac
exit 1`

const WRANGLER_NOT_LOGGED_IN = `echo "wrangler $*" >> "$FAKELOG"
case "$*" in
  "--version") echo "4.42.0"; exit 0 ;;
  "whoami --json") echo "not authenticated" >&2; exit 1 ;;
esac
exit 1`

const SUPABASE = `echo "supabase $*" >> "$FAKELOG"
case "$*" in
  "--version") echo "2.19.0"; exit 0 ;;
esac
exit 1`

const VERCEL_OK = `echo "vercel $*" >> "$FAKELOG"
case "$*" in
  "--version") echo "Vercel CLI 54.3.0"; exit 0 ;;
  "whoami --non-interactive") echo "Vercel CLI 54.3.0"; echo ""; echo "example-dev"; exit 0 ;;
esac
exit 1`

// "exec" so the timeout signal lands on sleep itself.
const VERCEL_HANGS = `echo "vercel $*" >> "$FAKELOG"
case "$*" in
  "--version") echo "Vercel CLI 54.3.0"; exit 0 ;;
  "whoami --non-interactive") exec sleep 30 ;;
esac
exit 1`

const SHOPIFY = `echo "shopify $*" >> "$FAKELOG"
case "$*" in
  "version") echo "3.74.2"; exit 0 ;;
esac
exit 1`

const ALL_IDS: ServiceStatus['id'][] = ['gh', 'glab', 'stripe', 'wrangler', 'supabase', 'vercel', 'shopify']

describe('checkServices', () => {
  it('lists all seven in order when nothing is installed, and runs nothing', async () => {
    const b = box({})
    const list = await checkServices(deps(b))
    expect(list.map((s) => s.id)).toEqual(ALL_IDS)
    for (const row of list) {
      expect(row.installed).toBe(false)
      expect(row.signedIn).toBe('unknown')
      expect(row.version).toBeNull()
      expect(row.detail).toBe('Not installed')
      expect(row.checkedAt).toBe(NOW)
    }
    expect(calls(b)).toEqual([])
  })

  it('reads gh signed in, account from a stderr line', async () => {
    const b = box({ gh: GH_SIGNED_IN })
    const list = await checkServices(deps(b))
    const gh = byId(list, 'gh')
    expect(gh).toMatchObject({
      name: 'GitHub CLI',
      installed: true,
      version: '2.62.0',
      signedIn: 'yes',
      account: 'example-user',
      detail: 'gh auth status'
    })
  })

  it('reads gh signed out from a non-zero exit', async () => {
    const b = box({ gh: GH_SIGNED_OUT })
    const gh = byId(await checkServices(deps(b)), 'gh')
    expect(gh.installed).toBe(true)
    expect(gh.signedIn).toBe('no')
    expect(gh.account).toBeNull()
    expect(gh.detail).toBe('gh auth status')
  })

  it('treats glab non-zero as unknown and glab exit zero as signed in', async () => {
    const failing = byId(await checkServices(deps(box({ glab: GLAB_FAILS }))), 'glab')
    expect(failing.signedIn).toBe('unknown')
    expect(failing.detail).toBe('glab auth status')
    expect(failing.version).toBe('1.80.4')
    const ok = byId(await checkServices(deps(box({ glab: GLAB_OK }))), 'glab')
    expect(ok.signedIn).toBe('yes')
  })

  it('reads stripe accounts, its absence, and a failure as unknown', async () => {
    const withAccounts = byId(await checkServices(deps(box({ stripe: STRIPE_TWO_ACCOUNTS }))), 'stripe')
    expect(withAccounts.signedIn).toBe('yes')
    expect(withAccounts.account).toBe('work-account')
    expect(withAccounts.version).toBe('1.44.0')
    expect(withAccounts.detail).toBe('stripe login list')

    const none = byId(await checkServices(deps(box({ stripe: STRIPE_NONE }))), 'stripe')
    expect(none.signedIn).toBe('no')

    const broken = byId(await checkServices(deps(box({ stripe: STRIPE_FAILS }))), 'stripe')
    expect(broken.signedIn).toBe('unknown')
  })

  it('reads the wrangler account from an email field anywhere in the JSON', async () => {
    const wrangler = byId(await checkServices(deps(box({ wrangler: WRANGLER_EMAIL }))), 'wrangler')
    expect(wrangler.installed).toBe(true)
    expect(wrangler.version).toBe('4.42.0')
    expect(wrangler.signedIn).toBe('yes')
    expect(wrangler.account).toBe('dev@example.com')
    expect(wrangler.detail).toBe('wrangler whoami --json')

    const off = byId(await checkServices(deps(box({ wrangler: WRANGLER_NOT_LOGGED_IN }))), 'wrangler')
    expect(off.signedIn).toBe('no')
  })

  it('takes the vercel account from the last non-empty stdout line', async () => {
    const vercel = byId(await checkServices(deps(box({ vercel: VERCEL_OK }))), 'vercel')
    expect(vercel.signedIn).toBe('yes')
    expect(vercel.account).toBe('example-dev')
    expect(vercel.version).toBe('54.3.0')
    expect(vercel.detail).toBe('vercel whoami --non-interactive')

    const b = box({ vercel: `echo "vercel $*" >> "$FAKELOG"
case "$*" in
  "--version") echo "Vercel CLI 54.3.0"; exit 0 ;;
  "whoami --non-interactive") echo "not signed in" >&2; exit 1 ;;
esac
exit 1` })
    const off = byId(await checkServices(deps(b)), 'vercel')
    expect(off.signedIn).toBe('no')
  })

  it('checks supabase by env var and by file, and the command is only ever --version', async () => {
    const byVar = box({ supabase: SUPABASE }, { SUPABASE_ACCESS_TOKEN: 'a-set-token' })
    const envRow = byId(await checkServices(deps(byVar)), 'supabase')
    expect(envRow.signedIn).toBe('yes')
    expect(envRow.detail).toBe('SUPABASE_ACCESS_TOKEN is set')

    const byFile = box({ supabase: SUPABASE })
    mkdirSync(join(byFile.home, '.supabase'), { recursive: true })
    writeFileSync(join(byFile.home, '.supabase', 'access-token'), 'placeholder', 'utf8')
    const fileRow = byId(await checkServices(deps(byFile)), 'supabase')
    expect(fileRow.signedIn).toBe('yes')
    expect(fileRow.detail).toBe('~/.supabase/access-token exists')

    const none = box({ supabase: SUPABASE })
    const noneRow = byId(await checkServices(deps(none)), 'supabase')
    expect(noneRow.signedIn).toBe('unknown')
    expect(noneRow.detail).toBe('No SUPABASE_ACCESS_TOKEN or ~/.supabase/access-token')
    expect(calls(byVar)).toEqual(['supabase --version'])
    expect(calls(byFile)).toEqual(['supabase --version'])
    expect(calls(none)).toEqual(['supabase --version'])
  })

  it('reports shopify always unknown with no status command', async () => {
    const shopify = byId(await checkServices(deps(box({ shopify: SHOPIFY }))), 'shopify')
    expect(shopify.installed).toBe(true)
    expect(shopify.version).toBe('3.74.2')
    expect(shopify.signedIn).toBe('unknown')
    expect(shopify.detail).toBe('No status command')
  })

  it('gives unknown for a script that hangs past the timeout, and leaves the others alone', async () => {
    const b = box({ gh: GH_SIGNED_IN, vercel: VERCEL_HANGS })
    const list = await checkServices(deps(b))
    const vercel = byId(list, 'vercel')
    expect(vercel.installed).toBe(true)
    expect(vercel.version).toBe('54.3.0')
    expect(vercel.signedIn).toBe('unknown')
    expect(vercel.detail).toBe('vercel whoami --non-interactive')
    expect(byId(list, 'gh').signedIn).toBe('yes')
  })

  it('never runs a login or logout command, only the documented checks', async () => {
    const b = box({
      gh: GH_SIGNED_IN,
      glab: GLAB_OK,
      stripe: STRIPE_TWO_ACCOUNTS,
      wrangler: WRANGLER_EMAIL,
      supabase: SUPABASE,
      vercel: VERCEL_OK,
      shopify: SHOPIFY
    })
    const list = await checkServices(deps(b))
    expect(list.map((s) => s.id)).toEqual(ALL_IDS)
    expect(list.every((s) => s.checkedAt === NOW)).toBe(true)
    expect([...calls(b)].sort()).toEqual(
      [
        'gh --version',
        'gh auth status',
        'glab --version',
        'glab auth status',
        'shopify version',
        'stripe login list',
        'stripe version',
        'supabase --version',
        'vercel --version',
        'vercel whoami --non-interactive',
        'wrangler --version',
        'wrangler whoami --json'
      ].sort()
    )
    for (const line of calls(b)) {
      // "stripe login list" is the documented read-only list command; nothing else may say login.
      expect(line).not.toMatch(/\blogout\b/)
      if (line !== 'stripe login list') expect(line).not.toMatch(/\blogin\b/)
    }
    expect(byId(list, 'gh')).toMatchObject({ signedIn: 'yes', account: 'example-user' })
    expect(byId(list, 'stripe')).toMatchObject({ signedIn: 'yes', account: 'work-account' })
    expect(byId(list, 'wrangler')).toMatchObject({ signedIn: 'yes', account: 'dev@example.com' })
    expect(byId(list, 'vercel')).toMatchObject({ signedIn: 'yes', account: 'example-dev' })
    expect(byId(list, 'supabase').signedIn).toBe('unknown')
    expect(byId(list, 'shopify').signedIn).toBe('unknown')
  })

  it('passes GH_PROMPT_DISABLED and NO_COLOR and keeps the environment from deps', async () => {
    const b = box({
      gh: `echo "gh $*" >> "$FAKELOG"
env > "$FAKELOG.env"
case "$*" in
  "--version") echo "gh version 2.62.0"; exit 0 ;;
  "auth status") exit 4 ;;
esac
exit 1`
    })
    await checkServices(deps(b))
    const text = readFileSync(`${b.log}.env`, 'utf8')
    expect(text).toContain('GH_PROMPT_DISABLED=1')
    expect(text).toContain('NO_COLOR=1')
    expect(text).toContain(b.env['PATH'] ?? 'missing-path')
  })
})
