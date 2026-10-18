// Tests for how SessionManager drives checkpoint steps: the opening snapshot comes before submitted input
// reaches the agent (finding 8), and Claude Code steps follow hook events, not status changes (finding 16).

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DetectedAgent } from '../shared/types'

interface FakePty {
  pid: number
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  onData: (cb: (d: string) => void) => void
  onExit: (cb: (e: { exitCode: number; signal: number }) => void) => void
}

const ptys: FakePty[] = []

vi.mock('@lydell/node-pty', () => ({
  spawn: vi.fn(() => {
    const pty: FakePty = {
      pid: 4242,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: () => {},
      onExit: () => {}
    }
    ptys.push(pty)
    return pty
  })
}))

const { SessionManager } = await import('./sessions')

function agent(kind: DetectedAgent['kind'], signals: DetectedAgent['signals']): DetectedAgent {
  return {
    kind,
    name: kind,
    short: kind,
    command: kind,
    args: [],
    monogram: kind.slice(0, 2).toUpperCase(),
    color: '#000000',
    signals,
    installed: true,
    path: `/bin/${kind}`,
    version: null
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const managers: InstanceType<typeof SessionManager>[] = []

function setup(a: DetectedAgent, start: (...args: unknown[]) => Promise<void> | void, stepCeilingMs?: number) {
  const calls: string[] = []
  const steps = {
    start: vi.fn((...args: unknown[]) => {
      calls.push('start')
      return start(...args)
    }),
    end: vi.fn(() => {
      calls.push('end')
    }),
    relabel: vi.fn(),
    unprotected: vi.fn()
  }
  const manager = new SessionManager({
    env: () => ({}),
    agents: () => [a],
    hooks: { claudeSettings: () => '{}', codexArgs: () => [] } as never,
    workspaceRoot: () => '/tmp',
    emit: () => {},
    quietAfterSec: () => 60,
    createWorktree: async () => {
      throw new Error('not used')
    },
    steps,
    ...(stepCeilingMs ? { stepCeilingMs } : {})
  })
  managers.push(manager)
  return { manager, steps, calls }
}

afterEach(() => {
  for (const m of managers.splice(0)) m.disposeAll()
  ptys.length = 0
})

const flush = () => new Promise((r) => setTimeout(r, 10))

describe('finding 8: the opening snapshot comes before submitted input', () => {
  it('holds Enter back until the step start has finished', async () => {
    const gate = deferred()
    const { manager, steps } = setup(agent('gemini', 'output'), () => gate.promise)
    const info = await manager.create({ agent: 'gemini', cols: 80, rows: 24 })
    const pty = ptys[0]!

    manager.write(info.id, 'build it')
    expect(pty.write).toHaveBeenCalledWith('build it')
    manager.write(info.id, '\r')
    manager.write(info.id, 'more')
    await flush()

    expect(steps.start).toHaveBeenCalledTimes(1)
    expect(steps.start.mock.calls[0]?.[3]).toBe('build it')
    expect(pty.write).not.toHaveBeenCalledWith('\r')
    expect(pty.write).not.toHaveBeenCalledWith('more')

    gate.resolve()
    await flush()

    expect(pty.write.mock.calls.map((c) => c[0])).toEqual(['build it', '\r', 'more'])
    expect(steps.start).toHaveBeenCalledTimes(1)
  })

  it('still delivers the input if the snapshot fails', async () => {
    const gate = deferred()
    const { manager } = setup(agent('gemini', 'output'), () => gate.promise)
    const info = await manager.create({ agent: 'gemini', cols: 80, rows: 24 })
    manager.write(info.id, 'go')
    manager.write(info.id, '\r')
    gate.reject(new Error('index.lock'))
    await flush()
    expect(ptys[0]!.write).toHaveBeenCalledWith('\r')
  })

  it('types ordinary keys straight through without waiting', async () => {
    const gate = deferred()
    const { manager, steps } = setup(agent('gemini', 'output'), () => gate.promise)
    const info = await manager.create({ agent: 'gemini', cols: 80, rows: 24 })
    manager.write(info.id, 'a')
    manager.write(info.id, 'b')
    expect(ptys[0]!.write).toHaveBeenCalledTimes(2)
    expect(steps.start).not.toHaveBeenCalled()
  })
})

describe('finding 16: Claude Code steps follow hooks, not status changes', () => {
  it('keeps a permission prompt inside one step and ends it on Stop', async () => {
    const { manager, steps } = setup(agent('claude', 'hooks'), () => {})
    const info = await manager.create({ agent: 'claude', cols: 80, rows: 24 })

    manager.onHook(info.id, 'UserPromptSubmit', { prompt: 'refactor the parser' })
    await flush()
    expect(steps.start).toHaveBeenCalledTimes(1)
    expect(steps.start.mock.calls[0]?.[3]).toBe('refactor the parser')

    manager.onHook(info.id, 'Notification', { message: 'Claude needs your permission to use Bash' })
    expect(manager.get(info.id)?.status.state).toBe('waiting')
    manager.onHook(info.id, 'PreToolUse', {})
    expect(manager.get(info.id)?.status.state).toBe('working')
    manager.onHook(info.id, 'PostToolUse', {})
    await flush()
    expect(steps.start).toHaveBeenCalledTimes(1)
    expect(steps.end).not.toHaveBeenCalled()

    manager.onHook(info.id, 'Stop', {})
    await flush()
    expect(steps.end).toHaveBeenCalledTimes(1)

    manager.onHook(info.id, 'UserPromptSubmit', { prompt: 'next' })
    await flush()
    expect(steps.start).toHaveBeenCalledTimes(2)
  })

  it('opens the step on Enter before the prompt is delivered, then adopts the hook label', async () => {
    const gate = deferred()
    const { manager, steps } = setup(agent('claude', 'hooks'), () => gate.promise)
    const info = await manager.create({ agent: 'claude', cols: 80, rows: 24 })
    const pty = ptys[0]!

    manager.write(info.id, 'fix the bug')
    manager.write(info.id, '\r')
    await flush()
    expect(steps.start).toHaveBeenCalledTimes(1)
    expect(pty.write).not.toHaveBeenCalledWith('\r')
    gate.resolve()
    await flush()
    expect(pty.write).toHaveBeenCalledWith('\r')

    manager.onHook(info.id, 'UserPromptSubmit', { prompt: 'fix the bug please' })
    await flush()
    expect(steps.start).toHaveBeenCalledTimes(1)
    expect(steps.relabel).toHaveBeenCalledWith(info.id, 'fix the bug please')
  })

  it('does not open a step for a slash command', async () => {
    const { manager, steps } = setup(agent('claude', 'hooks'), () => {})
    const info = await manager.create({ agent: 'claude', cols: 80, rows: 24 })
    manager.onHook(info.id, 'SessionStart', {})
    manager.write(info.id, '/help')
    manager.write(info.id, '\r')
    await flush()
    expect(steps.start).not.toHaveBeenCalled()
    expect(ptys[0]!.write).toHaveBeenCalledWith('\r')
  })

  it('keeps status-based steps for other agents', async () => {
    const { manager, steps } = setup(agent('gemini', 'output'), () => {})
    const info = await manager.create({ agent: 'gemini', cols: 80, rows: 24 })
    manager.write(info.id, 'x')
    manager.write(info.id, '\r')
    await flush()
    expect(steps.start).toHaveBeenCalledTimes(1)
    expect(manager.get(info.id)?.status.state).toBe('working')
  })
})

describe('finding 4: a slow opening snapshot does not hold the terminal forever', () => {
  it('releases Enter after the ceiling and records the step as unprotected', async () => {
    const never = deferred()
    const { manager, steps } = setup(agent('gemini', 'output'), () => never.promise, 60)
    const info = await manager.create({ agent: 'gemini', cols: 80, rows: 24 })
    manager.write(info.id, 'go')
    manager.write(info.id, '\r')
    await flush()
    expect(ptys[0]!.write).not.toHaveBeenCalledWith('\r')

    await new Promise((r) => setTimeout(r, 120))

    expect(ptys[0]!.write).toHaveBeenCalledWith('\r')
    expect(steps.unprotected).toHaveBeenCalledTimes(1)
    expect(steps.unprotected.mock.calls[0]?.[1]).toMatch(/still running/)
    expect(steps.end).not.toHaveBeenCalled()
  })

  it('does not mark a step unprotected when the snapshot finishes in time', async () => {
    const { manager, steps } = setup(agent('gemini', 'output'), () => {}, 200)
    const info = await manager.create({ agent: 'gemini', cols: 80, rows: 24 })
    manager.write(info.id, 'go')
    manager.write(info.id, '\r')
    await new Promise((r) => setTimeout(r, 300))
    expect(steps.unprotected).not.toHaveBeenCalled()
    expect(ptys[0]!.write).toHaveBeenCalledWith('\r')
  })
})

describe('finding 6: Claude uses status boundaries until its first hook, and no timer ends a turn', () => {
  it('opens a step on Enter before any hook has arrived, and never ends it by timer', async () => {
    vi.useFakeTimers()
    try {
      const { manager, steps } = setup(agent('claude', 'hooks'), () => {})
      const info = await manager.create({ agent: 'claude', cols: 80, rows: 24 })
      manager.write(info.id, 'refactor')
      manager.write(info.id, '\r')
      await vi.advanceTimersByTimeAsync(5)
      expect(steps.start).toHaveBeenCalledTimes(1)
      // Past the old 15 second fallback timer, well inside the quiet limit.
      await vi.advanceTimersByTimeAsync(40_000)
      expect(manager.get(info.id)?.status.state).toBe('working')
      expect(steps.end).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('after the first hook, the hooks decide: a working turn stays one step', async () => {
    vi.useFakeTimers()
    try {
      const { manager, steps } = setup(agent('claude', 'hooks'), () => {})
      const info = await manager.create({ agent: 'claude', cols: 80, rows: 24 })
      manager.onHook(info.id, 'SessionStart', {})
      manager.onHook(info.id, 'UserPromptSubmit', { prompt: 'work' })
      await vi.advanceTimersByTimeAsync(40_000)
      expect(steps.start).toHaveBeenCalledTimes(1)
      expect(steps.end).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('findings 13 and 14: queued input is cancelled by removal and by Ctrl-C', () => {
  it('does not open a checkpoint for a queued submit after the session was removed', async () => {
    const gate = deferred()
    const { manager, steps } = setup(agent('gemini', 'output'), () => gate.promise)
    const info = await manager.create({ agent: 'gemini', cols: 80, rows: 24 })
    manager.write(info.id, 'one')
    manager.write(info.id, '\r')
    manager.write(info.id, 'two')
    manager.write(info.id, '\r')
    await flush()
    expect(steps.start).toHaveBeenCalledTimes(1)

    manager.remove(info.id)
    gate.resolve()
    await flush()

    expect(steps.start).toHaveBeenCalledTimes(1)
    expect(steps.end).toHaveBeenCalledTimes(1)
    expect(ptys[0]!.write).not.toHaveBeenCalledWith('\r')
  })

  it('lets Ctrl-C through at once and cancels the pending submit', async () => {
    const gate = deferred()
    const { manager, steps } = setup(agent('gemini', 'output'), () => gate.promise)
    const info = await manager.create({ agent: 'gemini', cols: 80, rows: 24 })
    manager.write(info.id, 'oops')
    manager.write(info.id, '\r')
    manager.write(info.id, 'after')
    await flush()
    expect(ptys[0]!.write).not.toHaveBeenCalledWith('\r')

    manager.write(info.id, '\x03')
    expect(ptys[0]!.write).toHaveBeenCalledWith('\x03')

    gate.resolve()
    await flush()

    const written = ptys[0]!.write.mock.calls.map((c) => c[0])
    expect(written).toEqual(['oops', '\x03'])
    // The unused checkpoint is closed.
    expect(steps.end).toHaveBeenCalledTimes(1)
  })
})

describe('menu keys after the hooks are known', () => {
  it('does not open a step for an Enter that is not a prompt; the awaited hook does', async () => {
    const { manager, steps } = setup(agent('claude', 'hooks'), () => {})
    const info = await manager.create({ agent: 'claude', cols: 80, rows: 24 })
    manager.onHook(info.id, 'SessionStart', {})
    manager.write(info.id, '\x1b[B')
    manager.write(info.id, '\r')
    await flush()
    expect(steps.start).not.toHaveBeenCalled()
    expect(ptys[0]!.write).toHaveBeenCalledWith('\r')

    await manager.onHook(info.id, 'UserPromptSubmit', { prompt: 'real prompt' })
    expect(steps.start).toHaveBeenCalledTimes(1)
    expect(steps.start.mock.calls[0]?.[3]).toBe('real prompt')
  })
})

describe('the first hook waits for a baseline that an Enter already started', () => {
  it('holds the UserPromptSubmit answer until the opening snapshot exists', async () => {
    const gate = deferred()
    const { manager, steps } = setup(agent('claude', 'hooks'), () => gate.promise)
    const info = await manager.create({ agent: 'claude', cols: 80, rows: 24 })
    manager.write(info.id, 'build it')
    manager.write(info.id, '\r') // no hook seen yet: the output-based path starts the step
    await flush()
    expect(steps.start).toHaveBeenCalledTimes(1)

    let answered = false
    const answer = Promise.resolve(manager.onHook(info.id, 'UserPromptSubmit', { prompt: 'build it please' })).then(() => {
      answered = true
    })
    await flush()
    expect(answered).toBe(false)
    expect(steps.relabel).toHaveBeenCalledWith(info.id, 'build it please')
    expect(steps.start).toHaveBeenCalledTimes(1)

    gate.resolve()
    await answer
    expect(answered).toBe(true)
  })
})
