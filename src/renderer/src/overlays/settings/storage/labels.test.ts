import { describe, expect, it } from 'vitest'
import { bytesLabel, changedLabel, clock, movedLabel, removalResult, removeCommand, storageBytesLabel, upToBytesLabel } from './labels'

describe('removeCommand', () => {
  it('builds the plain command', () => {
    expect(removeCommand('/work/app', '/work/app-wt/one')).toBe('git -C "/work/app" worktree remove "/work/app-wt/one"')
  })

  it('keeps spaces inside the quotes', () => {
    expect(removeCommand('/My Work/app', '/My Work/app wt/one')).toBe('git -C "/My Work/app" worktree remove "/My Work/app wt/one"')
  })

  it('escapes a double quote', () => {
    expect(removeCommand('/work/app', '/work/a"b')).toBe('git -C "/work/app" worktree remove "/work/a\\"b"')
  })

  it('escapes a dollar sign', () => {
    expect(removeCommand('/work/$HOME/app', '/work/$x')).toBe('git -C "/work/\\$HOME/app" worktree remove "/work/\\$x"')
  })

  it('escapes a backtick', () => {
    expect(removeCommand('/work/app', '/work/a`id`b')).toBe('git -C "/work/app" worktree remove "/work/a\\`id\\`b"')
  })

  it('escapes a backslash', () => {
    expect(removeCommand('/work/app', '/work/a\\b')).toBe('git -C "/work/app" worktree remove "/work/a\\\\b"')
  })

  it('escapes every special character together', () => {
    expect(removeCommand('/r', '\\"$`')).toBe('git -C "/r" worktree remove "\\\\\\"\\$\\`"')
  })
})

describe('bytesLabel', () => {
  it('says "not measured" for null', () => {
    expect(bytesLabel(null)).toBe('not measured')
  })

  it('formats a measured size', () => {
    expect(bytesLabel(84 * 1024 * 1024)).toMatch(/84(\.0)? ?MB/)
    expect(bytesLabel(0)).not.toBe('not measured')
  })
})

describe('storageBytesLabel', () => {
  it('says "not measured" only for a folder it could not read', () => {
    expect(storageBytesLabel(null)).toBe('not measured')
  })

  it('says "nothing yet" for a folder that does not exist', () => {
    expect(storageBytesLabel(0)).toBe('nothing yet')
  })

  it('formats a measured size', () => {
    expect(storageBytesLabel(84 * 1024 * 1024)).toMatch(/84(\.0)? ?MB/)
  })
})

describe('changedLabel', () => {
  const now = 1_700_000_000_000
  const ago = (seconds: number): number => now - seconds * 1000
  const MIN = 60
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it('handles a missing timestamp', () => {
    expect(changedLabel(null, now)).toBe('no change recorded')
  })

  it('says just now under a minute, and for a time slightly in the future', () => {
    expect(changedLabel(ago(10), now)).toBe('changed just now')
    expect(changedLabel(now + 5000, now)).toBe('changed just now')
  })

  it('counts minutes', () => {
    expect(changedLabel(ago(MIN), now)).toBe('changed 1 minute ago')
    expect(changedLabel(ago(5 * MIN), now)).toBe('changed 5 minutes ago')
  })

  it('counts hours', () => {
    expect(changedLabel(ago(HOUR), now)).toBe('changed 1 hour ago')
    expect(changedLabel(ago(3 * HOUR), now)).toBe('changed 3 hours ago')
  })

  it('says yesterday for one day', () => {
    expect(changedLabel(ago(DAY), now)).toBe('changed yesterday')
  })

  it('counts days', () => {
    expect(changedLabel(ago(3 * DAY), now)).toBe('changed 3 days ago')
    expect(changedLabel(ago(29 * DAY), now)).toBe('changed 29 days ago')
  })

  it('counts months', () => {
    expect(changedLabel(ago(30 * DAY), now)).toBe('changed 1 month ago')
    expect(changedLabel(ago(95 * DAY), now)).toBe('changed 3 months ago')
  })
})

describe('clock', () => {
  it('formats local time as HH:MM with zero padding', () => {
    expect(clock(new Date(2026, 9, 14, 18, 40).getTime())).toBe('18:40')
    expect(clock(new Date(2026, 9, 14, 7, 5).getTime())).toBe('07:05')
    expect(clock(new Date(2026, 9, 14, 0, 0).getTime())).toBe('00:00')
  })
})

describe('upToBytesLabel and movedLabel', () => {
  it('formats upper bound sizes and moved relative times', () => {
    expect(upToBytesLabel(null)).toBe('not measured')
    expect(upToBytesLabel(84 * 1024 * 1024)).toMatch(/^up to 84(\.0)? ?MB$/)
    const now = 1_700_000_000_000
    expect(movedLabel(new Date(now - 5000).toISOString(), now)).toBe('moved just now')
    expect(movedLabel('invalid', now)).toBe('moved at unknown time')
  })
})

describe('removalResult', () => {
  it('reports moving worktrees to trash', () => {
    expect(removalResult(1, 0)).toBe("Moved 1 worktree to Regatta's trash.")
    expect(removalResult(2, 0)).toBe("Moved 2 worktrees to Regatta's trash.")
  })

  it('mentions what was kept', () => {
    expect(removalResult(1, 1)).toBe("Moved 1 worktree to Regatta's trash. 1 was kept, its reason is shown above.")
    expect(removalResult(2, 3)).toBe("Moved 2 worktrees to Regatta's trash. 3 were kept, their reasons are shown above.")
  })

  it('says nothing was moved to trash when everything was kept', () => {
    expect(removalResult(0, 1)).toBe('Nothing was moved to trash. 1 was kept, its reason is shown above.')
    expect(removalResult(0, 2)).toBe('Nothing was moved to trash. 2 were kept, their reasons are shown above.')
  })
})
