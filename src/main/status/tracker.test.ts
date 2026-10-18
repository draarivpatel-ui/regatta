import { describe, expect, it } from 'vitest'
import { StatusTracker } from './tracker'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('StatusTracker: shell', () => {
  it('goes idle at a prompt and working while a command prints', () => {
    const c = clock()
    const s = new StatusTracker('shell', 'output', { now: c.now })
    expect(s.get().state).toBe('starting')
    s.onScreen('user@host ~ % ')
    expect(s.get().state).toBe('idle')
    s.onInput('ls\r')
    c.advance(100)
    s.onOutput('file-a\r\nfile-b\r\n')
    expect(s.get().state).toBe('working')
    s.onScreen('file-a\nfile-b\nuser@host ~ % ')
    expect(s.get().state).toBe('idle')
  })
})

describe('StatusTracker: Claude Code with hooks', () => {
  it('follows hooks and catches permission prompts', () => {
    const c = clock()
    const s = new StatusTracker('claude', 'hooks', { now: c.now })
    s.onHook('SessionStart', {})
    expect(s.get().state).toBe('idle')
    s.onHook('UserPromptSubmit', {})
    expect(s.get().state).toBe('working')
    s.onScreen('Edit src/a.ts\nDo you want to proceed?\n❯ 1. Yes\n  2. No')
    expect(s.get().state).toBe('waiting')
    s.onInput('1\r')
    expect(s.get().state).toBe('working')
    s.onHook('Stop', {})
    expect(s.get().state).toBe('idle')
    expect(s.get().reason).toBe('turn finished')
  })

  it('ignores stale busy text on screen while hooks say idle', () => {
    const c = clock()
    const s = new StatusTracker('claude', 'hooks', { now: c.now })
    s.onHook('Stop', {})
    s.onScreen('✻ Thinking… (esc to interrupt)')
    expect(s.get().state).toBe('idle')
  })

  it('stays working through a long silent hook-reported turn', () => {
    const c = clock()
    const s = new StatusTracker('claude', 'hooks', { now: c.now })
    s.onHook('PreToolUse', {})
    c.advance(60_000)
    expect(s.tick()).toBeNull()
    expect(s.get().state).toBe('working')
  })

  it('maps the idle notification to idle, other notifications to waiting', () => {
    const s = new StatusTracker('claude', 'hooks')
    s.onHook('Notification', { message: 'Claude is waiting for your input' })
    expect(s.get().state).toBe('idle')
    s.onHook('Notification', { message: 'Claude needs your permission to use Bash' })
    expect(s.get().state).toBe('waiting')
    expect(s.get().reason).toContain('permission')
  })
})

describe('StatusTracker: Codex with notify', () => {
  it('uses screen busy markers and notify for the end of a turn', () => {
    const c = clock()
    const s = new StatusTracker('codex', 'notify', { now: c.now })
    s.onScreen('• Working (3s • esc to interrupt)')
    expect(s.get().state).toBe('working')
    s.onHook('notify', { type: 'agent-turn-complete' })
    expect(s.get().state).toBe('idle')
    s.onInput('fix the tests\r')
    expect(s.get().state).toBe('working')
    s.onScreen('Allow command? (y/n)')
    expect(s.get().state).toBe('waiting')
  })
})

describe('StatusTracker: agents with output only', () => {
  it('does not treat the startup banner as work, then goes quiet', () => {
    const c = clock()
    const s = new StatusTracker('grok', 'output', { now: c.now, quietAfterMs: 8000 })
    s.onOutput('Welcome to the agent\r\n> ')
    expect(s.get().state).toBe('starting')
    c.advance(8000)
    s.tick()
    expect(s.get().state).toBe('quiet')
  })

  it('counts output after a submit as work and silence as quiet, never done', () => {
    const c = clock()
    const s = new StatusTracker('grok', 'output', { now: c.now, quietAfterMs: 8000 })
    s.onInput('add a test\r')
    expect(s.get().state).toBe('working')
    c.advance(1000)
    s.onOutput('Reading files...\r\n')
    expect(s.get().state).toBe('working')
    c.advance(9000)
    s.tick()
    expect(s.get().state).toBe('quiet')
    s.onScreen('Overwrite package.json? [y/N]')
    expect(s.get().state).toBe('waiting')
  })

  it('does not fall back to needs-you once a question was answered', () => {
    const s = new StatusTracker('grok', 'output')
    s.onScreen('Overwrite package.json? (y/n) ', 0)
    expect(s.get().state).toBe('waiting')
    s.onInput('y\r')
    expect(s.get().state).toBe('working')
    s.onScreen('Overwrite package.json? (y/n) y\n', 1)
    expect(s.get().state).toBe('working')
    s.onScreen('Overwrite package.json? (y/n) y\nOverwriting.\n⠋ Reading the project… (1s, esc to interrupt)', 2)
    expect(s.get().state).toBe('working')
    s.onScreen('Overwrite package.json? (y/n) y\nOverwriting.\n✓ Finished.\n> ', 3)
    expect(s.get().state).toBe('idle')
    s.onScreen('Overwrite package.json? (y/n) y\nOverwriting.\n✓ Finished.\n> \nOverwrite package.json? (y/n) ', 4)
    expect(s.get().state).toBe('waiting')
  })

  it('shows ready when the agent is back at a bare prompt after working', () => {
    const c = clock()
    const s = new StatusTracker('grok', 'output', { now: c.now })
    s.onScreen('Welcome\n> ')
    expect(s.get().state).toBe('idle')
    expect(s.get().reason).toBe('at its prompt')
    s.onInput('do it\r')
    s.onScreen('do it\n⠋ Editing files… (2s, esc to interrupt)')
    expect(s.get().state).toBe('working')
    s.onScreen('do it\n✓ Finished.\n> ')
    expect(s.get().state).toBe('idle')
  })

  it('ignores escape-only chunks such as cursor blinks', () => {
    const c = clock()
    const s = new StatusTracker('grok', 'output', { now: c.now, quietAfterMs: 8000 })
    s.onInput('go\r')
    c.advance(9000)
    s.onOutput('\x1b[?25l\x1b[?25h')
    s.tick()
    expect(s.get().state).toBe('quiet')
  })
})

describe('StatusTracker: usage limit', () => {
  it('waits with the reset label when the agent said when it resets', () => {
    const s = new StatusTracker('claude', 'output')
    s.onInput('fix the tests\r')
    expect(s.get().state).toBe('working')
    const status = s.onLimit('resets 6:30 PM')
    expect(status?.state).toBe('waiting')
    expect(s.get().reason).toBe('hit its usage limit (resets 6:30 PM)')
  })

  it('waits without a label when the agent gave no reset time', () => {
    const s = new StatusTracker('claude', 'output')
    s.onInput('fix the tests\r')
    expect(s.onLimit('')?.state).toBe('waiting')
    expect(s.get().reason).toBe('hit its usage limit')
  })

  it('keeps the pane waiting while the limit line is still on screen', () => {
    const c = clock()
    const s = new StatusTracker('claude', 'output', { now: c.now })
    // The session manager reads the screen first, then reports the limit it found.
    s.onScreen('Claude usage limit reached. Your limit will reset 3am\n> ')
    expect(s.onLimit('resets 3am')?.state).toBe('waiting')
    expect(s.get().reason).toBe('hit its usage limit (resets 3am)')
    // New output would clear a question, so the caller reports the limit again.
    s.onScreen('Claude usage limit reached. Your limit will reset 3am\nReading files\n> ')
    expect(s.onLimit('resets 3am')?.state).toBe('waiting')
    expect(s.get().reason).toBe('hit its usage limit (resets 3am)')
  })

  it('works again once the limit line scrolled away', () => {
    const s = new StatusTracker('claude', 'output')
    s.onLimit('resets 3am')
    expect(s.get().state).toBe('waiting')
    s.onScreen('Reading files… (2s, esc to interrupt)')
    expect(s.get().state).toBe('working')
  })

  it('does nothing once the process has exited', () => {
    const s = new StatusTracker('claude', 'output')
    s.onExit(0)
    expect(s.onLimit('resets 6:30 PM')).toBeNull()
    expect(s.get().state).toBe('done')
  })
})

describe('StatusTracker: exit', () => {
  it('ends as done or failed and then ignores everything', () => {
    const ok = new StatusTracker('claude', 'hooks')
    expect(ok.onExit(0).state).toBe('done')
    expect(ok.onHook('Stop', {})).toBeNull()
    const bad = new StatusTracker('codex', 'notify')
    expect(bad.onExit(1).state).toBe('failed')
    const killed = new StatusTracker('shell', 'output')
    expect(killed.onExit(null).reason).toBe('process was stopped')
  })
})
