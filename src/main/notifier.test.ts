import { describe, expect, it, vi } from 'vitest'
import { Notifier } from './notifier'
import type { SessionInfo, SessionStatus } from '../shared/types'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    agent: 'claude',
    title: 'Claude',
    cwd: '/home/user/my-project',
    command: 'claude',
    args: [],
    createdAt: 1_000_000,
    pid: 123,
    status: { state: 'starting', since: 1_000_000, reason: 'launched', source: 'process' },
    exitCode: null,
    signals: 'hooks',
    worktree: null,
    branch: null,
    limit: null,
    transcriptPath: null,
    account: null,
    ...overrides
  }
}

function makeDeps(
  session: SessionInfo,
  opts: { notifications?: boolean; windowFocused?: boolean; now?: () => number } = {}
) {
  const c = opts.now ? clock(1_000_000) : null
  return {
    prefs: () => ({ notifications: opts.notifications ?? true }),
    session: (id: string) => (id === session.id ? session : undefined),
    windowFocused: () => opts.windowFocused ?? false,
    focusSession: vi.fn(),
    now: opts.now ?? Date.now
  }
}

describe('Notifier', () => {
  it('waiting notifies once with correct title and body', () => {
    const c = clock()
    const session = makeSession()
    const deps = makeDeps(session, { now: c.now })
    const factory = vi.fn((opts) => ({ show: vi.fn(), onclick: opts.onClick }))
    const notifier = new Notifier(deps, factory)

    const status: SessionStatus = { state: 'waiting', since: c.now(), reason: 'needs approval', source: 'hook' }
    notifier.onStatus('s1', status, null)

    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Claude Code needs you',
        body: 'needs approval'
      })
    )
  })

  it('repeated waiting within 10 seconds does not notify again', () => {
    const c = clock()
    const session = makeSession()
    const deps = makeDeps(session, { now: c.now })
    const factory = vi.fn((opts) => ({ show: vi.fn(), onclick: opts.onClick }))
    const notifier = new Notifier(deps, factory)

    const status: SessionStatus = { state: 'waiting', since: c.now(), reason: 'needs approval', source: 'hook' }
    notifier.onStatus('s1', status, null)
    c.advance(5000)
    notifier.onStatus('s1', { ...status, since: c.now() }, status)

    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('waiting notifies again after 10 seconds', () => {
    const c = clock()
    const session = makeSession()
    const deps = makeDeps(session, { now: c.now })
    const factory = vi.fn((opts) => ({ show: vi.fn(), onclick: opts.onClick }))
    const notifier = new Notifier(deps, factory)

    const status: SessionStatus = { state: 'waiting', since: c.now(), reason: 'needs approval', source: 'hook' }
    notifier.onStatus('s1', status, null)
    c.advance(11_000)
    notifier.onStatus('s1', { ...status, since: c.now() }, status)

    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('short working turn does not notify on idle', () => {
    const c = clock()
    const session = makeSession()
    const deps = makeDeps(session, { now: c.now })
    const factory = vi.fn((opts) => ({ show: vi.fn(), onclick: opts.onClick }))
    const notifier = new Notifier(deps, factory)

    // working for 15 seconds
    notifier.onStatus('s1', { state: 'working', since: c.now(), reason: 'working', source: 'output' }, null)
    c.advance(15_000)
    // idle
    notifier.onStatus('s1', { state: 'idle', since: c.now(), reason: 'turn finished', source: 'hook' }, { state: 'working', since: c.now() - 15_000, reason: 'working', source: 'output' })

    expect(factory).not.toHaveBeenCalled()
  })

  it('25 second working turn notifies on idle', () => {
    const c = clock()
    const session = makeSession()
    const deps = makeDeps(session, { now: c.now })
    const factory = vi.fn((opts) => ({ show: vi.fn(), onclick: opts.onClick }))
    const notifier = new Notifier(deps, factory)

    // working for 25 seconds
    notifier.onStatus('s1', { state: 'working', since: c.now(), reason: 'working', source: 'output' }, null)
    c.advance(25_000)
    // idle
    notifier.onStatus('s1', { state: 'idle', since: c.now(), reason: 'turn finished', source: 'hook' }, { state: 'working', since: c.now() - 25_000, reason: 'working', source: 'output' })

    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Claude Code is ready',
        body: 'Finished its turn in my-project.'
      })
    )
  })

  it('focused window suppresses notification', () => {
    const c = clock()
    const session = makeSession()
    const deps = makeDeps(session, { windowFocused: true, now: c.now })
    const factory = vi.fn((opts) => ({ show: vi.fn(), onclick: opts.onClick }))
    const notifier = new Notifier(deps, factory)

    const status: SessionStatus = { state: 'waiting', since: c.now(), reason: 'needs approval', source: 'hook' }
    notifier.onStatus('s1', status, null)

    expect(factory).not.toHaveBeenCalled()
  })

  it('disabled notifications pref suppresses notification', () => {
    const c = clock()
    const session = makeSession()
    const deps = makeDeps(session, { notifications: false, now: c.now })
    const factory = vi.fn((opts) => ({ show: vi.fn(), onclick: opts.onClick }))
    const notifier = new Notifier(deps, factory)

    const status: SessionStatus = { state: 'waiting', since: c.now(), reason: 'needs approval', source: 'hook' }
    notifier.onStatus('s1', status, null)

    expect(factory).not.toHaveBeenCalled()
  })

  it('failed state notifies with correct title and body', () => {
    const c = clock()
    const session = makeSession()
    const deps = makeDeps(session, { now: c.now })
    const factory = vi.fn((opts) => ({ show: vi.fn(), onclick: opts.onClick }))
    const notifier = new Notifier(deps, factory)

    const status: SessionStatus = { state: 'failed', since: c.now(), reason: 'exited with code 1', source: 'process' }
    notifier.onStatus('s1', status, { state: 'working', since: c.now() - 1000, reason: 'working', source: 'output' })

    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Claude Code stopped',
        body: 'exited with code 1'
      })
    )
  })

  it('clicking notification calls focusSession', () => {
    const c = clock()
    const session = makeSession()
    const deps = makeDeps(session, { now: c.now })
    const showFn = vi.fn()
    const factory = vi.fn((opts) => ({ show: showFn, onclick: opts.onClick }))
    const notifier = new Notifier(deps, factory)

    const status: SessionStatus = { state: 'waiting', since: c.now(), reason: 'needs approval', source: 'hook' }
    notifier.onStatus('s1', status, null)

    // Get the onclick handler from the factory call
    const calls = factory.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const clickHandler = calls[0]![0].onClick
    clickHandler()

    expect(deps.focusSession).toHaveBeenCalledWith('s1')
  })

  it('uses agent name from AGENTS for different agent kinds', () => {
    const c = clock()
    const session = makeSession({ agent: 'codex' })
    const deps = makeDeps(session, { now: c.now })
    const factory = vi.fn((opts) => ({ show: vi.fn(), onclick: opts.onClick }))
    const notifier = new Notifier(deps, factory)

    const status: SessionStatus = { state: 'waiting', since: c.now(), reason: 'needs approval', source: 'hook' }
    notifier.onStatus('s1', status, null)

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Codex needs you',
        body: 'needs approval'
      })
    )
  })

  it('does not notify for other state transitions', () => {
    const c = clock()
    const session = makeSession()
    const deps = makeDeps(session, { now: c.now })
    const factory = vi.fn((opts) => ({ show: vi.fn(), onclick: opts.onClick }))
    const notifier = new Notifier(deps, factory)

    // starting -> working
    notifier.onStatus('s1', { state: 'working', since: c.now(), reason: 'working', source: 'output' }, { state: 'starting', since: c.now(), reason: 'launched', source: 'process' })
    // working -> quiet
    c.advance(10_000)
    notifier.onStatus('s1', { state: 'quiet', since: c.now(), reason: 'no output for 10 s', source: 'timer' }, { state: 'working', since: c.now() - 10_000, reason: 'working', source: 'output' })
    // quiet -> working
    notifier.onStatus('s1', { state: 'working', since: c.now(), reason: 'printing output', source: 'output' }, { state: 'quiet', since: c.now() - 1000, reason: 'no output for 10 s', source: 'timer' })
    // idle -> starting (restart)
    notifier.onStatus('s1', { state: 'starting', since: c.now(), reason: 'launched', source: 'process' }, { state: 'idle', since: c.now() - 1000, reason: 'turn finished', source: 'hook' })

    expect(factory).not.toHaveBeenCalled()
  })
})