import { describe, expect, it } from 'vitest'
import { buildBrief, detectLimit, formatResetTime } from './relay'

/** A fixed moment in local time: 10:00 PM on Wednesday 14 October 2026. */
const NOW = new Date(2026, 9, 14, 22, 0, 0, 0).getTime()
const HOUR = 3_600_000
const MINUTE = 60_000

describe('detectLimit: messages an agent prints', () => {
  it('reads a plain usage limit reached message', () => {
    const found = detectLimit('starting up\nusage limit reached\n', NOW)
    expect(found?.resetsAt).toBeNull()
    expect(found?.text).toBe('usage limit reached')
    expect(found?.resumeScheduled).toBe(false)
  })

  it('reads "you have hit your usage limit"', () => {
    const found = detectLimit("You've hit your usage limit.", NOW)
    expect(found?.text).toBe("You've hit your usage limit.")
  })

  it('reads a session limit', () => {
    expect(detectLimit("You've hit your session limit.", NOW)?.text).toBe("You've hit your session limit.")
  })

  it('reads a five hour limit', () => {
    expect(detectLimit('Claude 5-hour limit reached ∙ upgrade for more', NOW)?.text).toBe('Claude 5-hour limit reached ∙ upgrade for more')
  })

  it('reads a rate limit error', () => {
    expect(detectLimit('API Error: 429 rate limit exceeded, please try again later', NOW)?.text).toBe(
      'API Error: 429 rate limit exceeded, please try again later'
    )
  })

  it('reads "your limit will reset"', () => {
    expect(detectLimit('Your limit will reset at 6:30pm', NOW)?.text).toBe('Your limit will reset at 6:30pm')
  })

  it('reads a limit message buried under a prompt and a spinner', () => {
    const screen = [
      'Test Agent 1.0  (no AI, for trying Regatta)',
      '',
      '> fix the tests',
      '⠋ Running the tests... (0s, esc to interrupt)',
      'Done. 21 tests pass.',
      '',
      "You've hit your usage limit. It resets 11:58pm",
      '> '
    ].join('\n')
    const found = detectLimit(screen, NOW)
    expect(found?.text).toBe("You've hit your usage limit. It resets 11:58pm")
    expect(found?.resetsAt).toBe(NOW + 1 * HOUR + 58 * MINUTE)
  })

  it('reads a two line message, with the reset on the line under it', () => {
    const screen = ['Some earlier output', "You've hit your usage limit.", 'Try again at 3am.'].join('\n')
    const found = detectLimit(screen, NOW)
    expect(found?.text).toBe("You've hit your usage limit.")
    expect(found?.resetsAt).toBe(new Date(2026, 9, 15, 3, 0, 0, 0).getTime())
  })

  it('ignores a limit message that scrolled off the bottom twelve lines', () => {
    const screen = ['usage limit reached', ...Array.from({ length: 14 }, (_, i) => `line ${i}`)].join('\n')
    expect(detectLimit(screen, NOW)).toBeNull()
  })
})

describe('detectLimit: lines that are not a limit', () => {
  it('ignores rate limiting as a topic', () => {
    expect(detectLimit('add rate limiting to the API', NOW)).toBeNull()
  })

  it('ignores prose about limits', () => {
    expect(detectLimit('the session limit is configurable in settings.ts', NOW)).toBeNull()
    expect(detectLimit('raise the limit to 100 requests per minute', NOW)).toBeNull()
  })

  it('ignores a plain screen with no limit at all', () => {
    expect(detectLimit('Test Agent 1.0\n> fix the tests\nDone.', NOW)).toBeNull()
  })
})

describe('detectLimit: reset times', () => {
  /** A moment earlier in the day, so a reset time later today is still today. */
  const MORNING = new Date(2026, 9, 14, 9, 0, 0, 0).getTime()

  it('reads a 12 hour clock time with minutes', () => {
    expect(detectLimit('usage limit reached. resets 6:30pm', MORNING)?.resetsAt).toBe(new Date(2026, 9, 14, 18, 30, 0, 0).getTime())
  })

  it('reads a 24 hour clock time', () => {
    expect(detectLimit('usage limit reached. resets at 18:30', MORNING)?.resetsAt).toBe(new Date(2026, 9, 14, 18, 30, 0, 0).getTime())
  })

  it('reads a bare hour on the 12 hour clock', () => {
    expect(detectLimit('usage limit reached. resets 11pm', NOW)?.resetsAt).toBe(new Date(2026, 9, 14, 23, 0, 0, 0).getTime())
  })

  it('treats a bare hour with no am or pm as a count, not a time', () => {
    expect(detectLimit('usage limit reached. try again 5 times', NOW)?.resetsAt).toBeNull()
  })

  it('reads midnight as the next midnight', () => {
    expect(detectLimit('usage limit reached. resets 12am', NOW)?.resetsAt).toBe(new Date(2026, 9, 15, 0, 0, 0, 0).getTime())
  })

  it('reads midday as the next midday', () => {
    expect(detectLimit('usage limit reached. resets 12pm', NOW)?.resetsAt).toBe(new Date(2026, 9, 15, 12, 0, 0, 0).getTime())
  })

  it('rolls a clock time that already passed to tomorrow', () => {
    // Now is 10 PM, so 3am is tomorrow morning.
    const resetsAt = detectLimit('usage limit reached. resets 3am', NOW)?.resetsAt
    expect(resetsAt).toBe(new Date(2026, 9, 15, 3, 0, 0, 0).getTime())
    expect(resetsAt! > NOW).toBe(true)
  })

  it('keeps a clock time later tonight as today', () => {
    expect(detectLimit('usage limit reached. resets 11:58pm', NOW)?.resetsAt).toBe(new Date(2026, 9, 14, 23, 58, 0, 0).getTime())
  })

  it('reads "try again in 2 hours 10 minutes"', () => {
    expect(detectLimit('rate limit exceeded. try again in 2 hours 10 minutes', NOW)?.resetsAt).toBe(NOW + 2 * HOUR + 10 * MINUTE)
  })

  it('reads "in 1h 59m"', () => {
    expect(detectLimit('usage limit reached, try again in 1h 59m', NOW)?.resetsAt).toBe(NOW + 1 * HOUR + 59 * MINUTE)
  })

  it('reads a wait of whole hours or minutes', () => {
    expect(detectLimit('usage limit reached. resets in 3 hours', NOW)?.resetsAt).toBe(NOW + 3 * HOUR)
    expect(detectLimit('usage limit reached. resets in 45 minutes', NOW)?.resetsAt).toBe(NOW + 45 * MINUTE)
  })

  it('does not invent a reset out of the size of the limit', () => {
    expect(detectLimit('5-hour limit reached', NOW)?.resetsAt).toBeNull()
  })
})

describe('formatResetTime', () => {
  it('writes a wall clock time', () => {
    expect(formatResetTime(new Date(2026, 9, 14, 18, 30).getTime())).toContain('6:30')
    expect(formatResetTime(new Date(2026, 9, 14, 0, 5).getTime())).toContain('12:05')
  })
})

describe('buildBrief', () => {
  it('carries the last prompt, the git records and the end of the screen', () => {
    const brief = buildBrief({
      agentName: 'Claude Code',
      lastPrompt: 'fix the failing auth test',
      gitStatus: ' M src/auth.ts\n?? notes.md',
      diffStat: ' src/auth.ts | 12 +++++---\n 1 file changed',
      screenTail: ['one', 'two', 'three'].join('\n')
    })
    expect(brief).toBe(
      [
        'Continuing work that Claude Code started. It stopped at its usage limit.',
        '',
        'What the user asked last:',
        'fix the failing auth test',
        '',
        'Files changed so far (git status):',
        ' M src/auth.ts',
        '?? notes.md',
        '',
        ' src/auth.ts | 12 +++++---',
        ' 1 file changed',
        '',
        'The end of its screen:',
        'one',
        'two',
        'three',
        '',
        'Carry on from here.'
      ].join('\n')
    )
  })

  it('skips every section that is empty', () => {
    const brief = buildBrief({ agentName: 'Codex', lastPrompt: '', gitStatus: '', diffStat: '', screenTail: '\n\n  \n' })
    expect(brief).toBe('Continuing work that Codex started. It stopped at its usage limit.\n\nCarry on from here.')
  })

  it('leaves the limit message out of the screen tail', () => {
    const brief = buildBrief({
      agentName: 'Claude Code',
      lastPrompt: 'go',
      gitStatus: '',
      diffStat: '',
      screenTail: ['reading files', "You've hit your usage limit. It resets 3am", '21 tests pass.'].join('\n')
    })
    expect(brief).toContain('The end of its screen:\nreading files\n21 tests pass.')
    expect(brief).not.toContain('resets 3am')
  })

  it('keeps only the last forty lines of screen', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`)
    const brief = buildBrief({ agentName: 'Codex', lastPrompt: 'go', gitStatus: '', diffStat: '', screenTail: lines.join('\n') })
    expect(brief).toContain('line 59')
    expect(brief).not.toContain('line 19\n')
    expect(brief).toContain('line 20\n')
  })
})
