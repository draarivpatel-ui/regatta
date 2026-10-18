// Unit tests for ServerStore: validation, save, config hosts, scan, trust and test.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fingerprintForBlob, plainTestError, ServerStore, type ProcResult } from './servers'
import type { NewSshServer } from '../shared/types'

const cleanup: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

interface Call {
  cmd: string
  args: string[]
}

function makeDirs(): { dataDir: string; home: string } {
  const base = temp('regatta-servers-')
  const dataDir = join(base, 'data')
  const home = join(base, 'home')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(home, '.ssh'), { recursive: true })
  return { dataDir, home }
}

function storeWithFake(
  dataDir: string,
  home: string,
  fake: (cmd: string, args: string[]) => ProcResult,
  nowValue = 1700000000000
): { store: ServerStore; calls: Call[] } {
  const calls: Call[] = []
  const store = new ServerStore({
    dataDir,
    home,
    env: () => ({ PATH: '/usr/bin:/bin' }),
    now: () => nowValue,
    run: async (cmd, args) => {
      calls.push({ cmd, args: [...args] })
      return fake(cmd, args)
    }
  })
  return { store, calls }
}

function okResult(stdout = '', stderr = ''): ProcResult {
  return { stdout, stderr, exitCode: 0 }
}

function failResult(stderr: string, stdout = ''): ProcResult {
  return { stdout, stderr, exitCode: 1 }
}

describe('validation', () => {
  it('rejects bad names, hosts, users and ports', () => {
    const { dataDir, home } = makeDirs()
    const store = new ServerStore({ dataDir, home, env: () => ({}) })
    const base: NewSshServer = { name: 'Ok', host: 'example.com', user: null, port: null }
    expect(() => store.save({ ...base, name: '' })).toThrow('Name is required.')
    expect(() => store.save({ ...base, name: 'x'.repeat(61) })).toThrow('Name must be 60 characters or fewer.')
    expect(() => store.save({ ...base, host: '' })).toThrow('Host is required.')
    expect(() => store.save({ ...base, host: 'has space.com' })).toThrow('Host cannot contain spaces.')
    expect(() => store.save({ ...base, host: '-bad' })).toThrow('Host cannot start with a dash.')
    expect(() => store.save({ ...base, user: 'has space' })).toThrow('User cannot contain spaces.')
    expect(() => store.save({ ...base, user: 'a@b' })).toThrow('User cannot contain @.')
    expect(() => store.save({ ...base, user: '-bad' })).toThrow('User cannot start with a dash.')
    expect(() => store.save({ ...base, port: 0 })).toThrow('Port must be between 1 and 65535.')
    expect(() => store.save({ ...base, port: 70000 })).toThrow('Port must be between 1 and 65535.')
  })
})

describe('save, update and remove', () => {
  it('saves sorted by name, keeps trust when only the name changes, clears on host change', async () => {
    const { dataDir, home } = makeDirs()
    const store = new ServerStore({ dataDir, home, env: () => ({}) })
    const second = store.save({ name: 'Zulu', host: 'z.example.com', user: null, port: null })
    expect(second).toHaveLength(1)
    expect(second[0]!.id).toHaveLength(8)
    const both = store.save({ name: 'Alpha', host: 'a.example.com', user: null, port: null })
    expect(both.map((s) => s.name)).toEqual(['Alpha', 'Zulu'])

    // Fake a trusted key by scanning then trusting with a fake runner.
    const id = both.find((s) => s.name === 'Alpha')!.id
    const blob = Buffer.from('save-test-key').toString('base64')
    const fp = fingerprintForBlob(blob)
    const line = `a.example.com ssh-ed25519 ${blob}`
    // Use a store with an injected runner that shares the same files on disk.
    const { store: working } = storeWithFake(dataDir, home, (cmd) => {
      if (cmd === 'ssh') return okResult('hostname a.example.com\nport 22\n')
      if (cmd === 'ssh-keyscan') return okResult(`${line}\n`)
      return okResult(`a.example.com ssh-ed25519 ${blob}\n`)
    })
    await working.scan(id)
    const afterTrust = working.trust(id, fp)
    expect(afterTrust.find((s) => s.id === id)!.trusted).toBe(fp)
    const kh = readFileSync(join(dataDir, 'known_hosts'), 'utf8')
    expect(kh).toContain(line)

    // Renaming only keeps trust.
    const renamed = working.save({ id, name: 'Alpha 2', host: 'a.example.com', user: null, port: null })
    expect(renamed.find((s) => s.id === id)!.trusted).toBe(fp)
    expect(renamed.find((s) => s.id === id)!.name).toBe('Alpha 2')

    // Changing the host clears trust and the test result.
    const moved = working.save({ id, name: 'Alpha 2', host: 'b.example.com', user: null, port: null })
    expect(moved.find((s) => s.id === id)!.trusted).toBeNull()
    expect(moved.find((s) => s.id === id)!.lastTest).toBeNull()
  })

  it('removes the server and its lines from Regatta known_hosts', () => {
    const { dataDir, home } = makeDirs()
    const { store } = storeWithFake(dataDir, home, (cmd) => {
      if (cmd === 'ssh') return okResult('hostname gone.example.com\nport 22\n')
      if (cmd === 'ssh-keyscan') {
        const blob = Buffer.from('remove-me').toString('base64')
        return okResult(`gone.example.com ssh-ed25519 ${blob}\n`)
      }
      return okResult('')
    })
    const created = store.save({ name: 'Gone', host: 'gone.example.com', user: null, port: null })
    const id = created[0]!.id
    return store
      .scan(id)
      .then((scan) => {
        store.trust(id, scan.keys[0]!.fingerprint)
        expect(readFileSync(join(dataDir, 'known_hosts'), 'utf8')).toContain('gone.example.com')
        const after = store.remove(id)
        expect(after).toEqual([])
        const kh = existsSync(join(dataDir, 'known_hosts')) ? readFileSync(join(dataDir, 'known_hosts'), 'utf8') : ''
        expect(kh).not.toContain('gone.example.com')
      })
  })
})

describe('configHosts', () => {
  it('reads Host names, follows one Include level and skips wildcards', async () => {
    const { dataDir, home } = makeDirs()
    const sshDir = join(home, '.ssh')
    mkdirSync(join(sshDir, 'conf.d'), { recursive: true })
    writeFileSync(
      join(sshDir, 'config'),
      ['Host alpha beta', 'Host *.example.com', 'Host bad?host', 'Host !negated', 'Include conf.d/extra', ''].join('\n'),
      'utf8'
    )
    writeFileSync(join(sshDir, 'conf.d', 'extra'), ['Host gamma', 'Host *wild', ''].join('\n'), 'utf8')
    const store = new ServerStore({ dataDir, home, env: () => ({}) })
    expect(await store.configHosts()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('is empty when there is no config', async () => {
    const { dataDir, home } = makeDirs()
    const store = new ServerStore({ dataDir, home, env: () => ({}) })
    expect(await store.configHosts()).toEqual([])
  })
})

describe('fingerprints', () => {
  it('matches ssh-keygen for a fresh ed25519 key', () => {
    const dir = temp('regatta-fp-')
    const base = join(dir, 'k')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', base], { timeout: 15000 })
    const pub = readFileSync(`${base}.pub`, 'utf8').trim().split(/\s+/)
    const blob = pub[1] ?? ''
    expect(blob.length).toBeGreaterThan(0)
    const ours = fingerprintForBlob(blob)
    const listed = execFileSync('ssh-keygen', ['-lf', `${base}.pub`], { encoding: 'utf8', timeout: 15000 })
    const reported = listed.trim().split(/\s+/)[1] ?? ''
    expect(reported).toBe(ours)
  })
})

describe('scan', () => {
  const blobA = Buffer.from('scan-key-a').toString('base64')
  const blobB = Buffer.from('scan-key-b').toString('base64')

  function scanStore(dataDir: string, home: string, keygenStdout: string, keyscanStdout?: string): { store: ServerStore; id: string } {
    const store = new ServerStore({
      dataDir,
      home,
      env: () => ({}),
      run: async (cmd) => {
        if (cmd === 'ssh') return okResult('hostname real.example.com\nport 22\n')
        if (cmd === 'ssh-keyscan') return okResult(keyscanStdout ?? `real.example.com ssh-ed25519 ${blobA}\n`)
        if (cmd === 'ssh-keygen') return okResult(keygenStdout)
        return okResult('')
      }
    })
    const created = store.save({ name: 'Real', host: 'real.example.com', user: null, port: null })
    return { store, id: created[0]!.id }
  }

  it('reports match when known_hosts has the same blob', async () => {
    const { dataDir, home } = makeDirs()
    const { store, id } = scanStore(dataDir, home, `real.example.com ssh-ed25519 ${blobA}\n`)
    const result = await store.scan(id)
    expect(result.keys).toHaveLength(1)
    expect(result.knownHosts).toBe('match')
    expect(result.saved).toBe('none')
    expect(result.error).toBeNull()
  })

  it('reports mismatch when known_hosts differs', async () => {
    const { dataDir, home } = makeDirs()
    const { store, id } = scanStore(dataDir, home, `real.example.com ssh-ed25519 ${blobB}\n`)
    const result = await store.scan(id)
    expect(result.knownHosts).toBe('mismatch')
  })

  it('reports unknown when there is no entry', async () => {
    const { dataDir, home } = makeDirs()
    const { store, id } = scanStore(dataDir, home, '')
    const result = await store.scan(id)
    expect(result.knownHosts).toBe('unknown')
  })

  it('returns a no answer error when nothing is offered', async () => {
    const { dataDir, home } = makeDirs()
    const { store, id } = scanStore(dataDir, home, '', '')
    const result = await store.scan(id)
    expect(result.keys).toEqual([])
    expect(result.error).toBe('No answer from real.example.com on port 22')
  })
})

describe('trust', () => {
  it('refuses a fingerprint that was not in the latest scan', async () => {
    const { dataDir, home } = makeDirs()
    const blob = Buffer.from('trust-me').toString('base64')
    const { store, calls } = storeWithFake(dataDir, home, (cmd) => {
      if (cmd === 'ssh') return okResult('hostname t.example.com\nport 22\n')
      if (cmd === 'ssh-keyscan') return okResult(`t.example.com ssh-ed25519 ${blob}\n`)
      return okResult('')
    })
    void calls
    const created = store.save({ name: 'T', host: 't.example.com', user: null, port: null })
    const id = created[0]!.id
    expect(() => store.trust(id, 'SHA256:bogus')).toThrow('Check the key first')
    const scan = await store.scan(id)
    expect(() => store.trust(id, 'SHA256:bogus')).toThrow('not from the latest check')
    const kept = store.trust(id, scan.keys[0]!.fingerprint)
    expect(kept.find((s) => s.id === id)!.trusted).toBe(scan.keys[0]!.fingerprint)
  })
})

describe('test', () => {
  function testStore(dataDir: string, home: string, stderr: string, exitCode: number): { store: ServerStore; id: string; calls: Call[] } {
    const calls: Call[] = []
    const store = new ServerStore({
      dataDir,
      home,
      env: () => ({ PATH: '/usr/bin' }),
      now: () => 1700000000000,
      run: async (cmd, args) => {
        calls.push({ cmd, args: [...args] })
        if (cmd === 'ssh') {
          if (exitCode === 0) return okResult('', '')
          return failResult(stderr)
        }
        return okResult('')
      }
    })
    const created = store.save({ name: 'T', host: 't.example.com', user: null, port: null })
    return { store, id: created[0]!.id, calls }
  }

  it('maps stderr lines to plain messages', async () => {
    const { dataDir, home } = makeDirs()
    const cases: Array<[string, string]> = [
      ['Host key verification failed.', 'Host key not trusted yet. Check the key first.'],
      ['Permission denied (publickey).', 'Needs key sign-in; password sign-in is not supported here.'],
      ['Connection timed out during connect.', 'No answer within 8 seconds.'],
      ['Something odd happened.', 'Something odd happened.']
    ]
    for (const [stderr, expected] of cases) {
      const { store, id } = testStore(dataDir, home, stderr, 1)
      const list = await store.test(id)
      const entry = list.find((s) => s.id === id)!
      expect(entry.lastTest?.ok).toBe(false)
      expect(entry.lastTest?.message).toBe(expected)
    }
  })

  it('saves Connected on exit 0', async () => {
    const { dataDir, home } = makeDirs()
    const { store, id } = testStore(dataDir, home, '', 0)
    const list = await store.test(id)
    expect(list.find((s) => s.id === id)!.lastTest).toEqual({ ok: true, at: 1700000000000, message: 'Connected' })
  })

  it('keeps a data folder with a space in one quoted UserKnownHostsFile argument', async () => {
    const base = temp('regatta data with space-')
    const dataDir = join(base, 'data dir')
    const home = join(base, 'home')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(join(home, '.ssh'), { recursive: true })
    const { store, id, calls } = testStore(dataDir, home, '', 0)
    await store.test(id)
    const sshCall = calls.find((c) => c.cmd === 'ssh')
    expect(sshCall).toBeDefined()
    const expected = `UserKnownHostsFile="${join(home, '.ssh', 'known_hosts')}" "${join(dataDir, 'known_hosts')}"`
    expect(sshCall!.args).toContain(expected)
  })

  it('plainTestError covers the three mapped lines', () => {
    expect(plainTestError('Host key verification failed.')).toBe('Host key not trusted yet. Check the key first.')
    expect(plainTestError('Permission denied (publickey).')).toBe('Needs key sign-in; password sign-in is not supported here.')
    expect(plainTestError('ssh: connect to host x port 22: Connection refused')).toBe('No answer within 8 seconds.')
  })
})
