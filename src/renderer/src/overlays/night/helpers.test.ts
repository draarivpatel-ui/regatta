import { describe, expect, it } from 'vitest'
import { AGENTS } from '@shared/agents'
import type { Night, NightState, NightTask, NightTaskRun } from '@shared/nightwatch'
import type { AgentKind } from '@shared/types'
import { headlessArgs } from '../../../../main/heats/runner'
import {
  activeNight,
  branchLikelyThere,
  cleanError,
  compactTokens,
  customCheck,
  diffText,
  folderForRun,
  formatCheckTime,
  formatClock,
  formatNightDate,
  formatSpan,
  formatUntil,
  gitCommandIn,
  hasLeftovers,
  HEADLESS_AGENTS,
  lastLines,
  nextStart,
  nightLook,
  nightRowLine,
  nightRowTitle,
  nightSummary,
  nightTitle,
  ranLabel,
  ranText,
  runSpan,
  testTotals,
  tokensByAgent,
  tonightLine,
  worktreeLikelyThere
} from './helpers'

function run(over: Partial<NightTaskRun> = {}): NightTaskRun {
  return {
    id: 'abcd-0',
    taskId: 't0',
    prompt: 'Create DONE.txt',
    agent: 'fake',
    status: 'queued',
    worktree: null,
    branch: null,
    base: null,
    tip: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    durationMs: null,
    diff: { files: 0, added: 0, removed: 0 },
    tokens: null,
    latest: '',
    checkSpecs: [{ name: 'done', command: 'test -f DONE.txt', kind: 'required' }],
    checks: [],
    gates: [],
    tests: null,
    note: '',
    ...over
  }
}

function night(over: Partial<Night> = {}, runs: NightTaskRun[] = [run()]): Night {
  return { id: 'abcd', root: '/Users/me/code/my-app', startAt: new Date(2026, 9, 3, 1, 0).getTime(), status: 'finished', runs, finishedAt: null, ...over }
}

const at = (h: number, m: number): number => new Date(2026, 9, 3, h, m).getTime()

describe('cleanError', () => {
  it('drops the wrapper Electron adds around an error from a handler', () => {
    expect(cleanError(new Error("Error invoking remote method 'night:addTask': Error: Claude Code is not installed."))).toBe('Claude Code is not installed.')
  })

  it('drops the wrapper and the name of an error class', () => {
    expect(cleanError(new Error("Error invoking remote method 'night:merge': MergeRefused: Commit or stash your changes first. Merging needs a clean folder."))).toBe(
      'Commit or stash your changes first. Merging needs a clean folder.'
    )
  })

  it('leaves a sentence that has no wrapper alone, colon and all', () => {
    expect(cleanError(new Error('Kept: the folder had unsaved work.'))).toBe('Kept: the folder had unsaved work.')
    expect(cleanError('plain words')).toBe('plain words')
  })
})

describe('nextStart', () => {
  const noon = new Date(2026, 9, 15, 12, 0, 0).getTime()

  it('is today when the time is still ahead', () => {
    expect(nextStart('13:30', noon)).toEqual({ at: new Date(2026, 9, 15, 13, 30).getTime(), tomorrow: false })
  })

  it('is tomorrow when the time has passed, and when it is this very minute', () => {
    expect(nextStart('01:00', noon)).toEqual({ at: new Date(2026, 9, 16, 1, 0).getTime(), tomorrow: true })
    expect(nextStart('12:00', noon)?.tomorrow).toBe(true)
  })

  it('is null for an empty or impossible time', () => {
    expect(nextStart('', noon)).toBeNull()
    expect(nextStart('25:00', noon)).toBeNull()
    expect(nextStart('10:75', noon)).toBeNull()
    expect(nextStart('soon', noon)).toBeNull()
  })
})

describe('numbers and times', () => {
  it('writes tokens compactly', () => {
    expect(compactTokens(999)).toBe('999')
    expect(compactTokens(1234)).toBe('1.2k')
    expect(compactTokens(55000)).toBe('55k')
  })

  it('writes spans and waits', () => {
    expect(formatSpan(48_000)).toBe('48 s')
    expect(formatSpan(12 * 60_000)).toBe('12 m')
    expect(formatSpan((2 * 60 + 5) * 60_000)).toBe('2 h 5 m')
    expect(formatUntil(5 * 3_600_000 + 12 * 60_000 + 30_000)).toBe('5 h 12 m')
    expect(formatUntil(12 * 60_000)).toBe('12 m')
    expect(formatUntil(20_000)).toBe('less than a minute')
    expect(formatUntil(-5_000)).toBe('less than a minute')
  })

  it('writes how long a check took', () => {
    expect(formatCheckTime(420)).toBe('0.4 s')
    expect(formatCheckTime(125_000)).toBe('2 m 5 s')
  })

  it('writes a diff with its files', () => {
    expect(diffText({ files: 2, added: 12, removed: 3 })).toBe('+12 -3 in 2 files')
    expect(diffText({ files: 1, added: 1, removed: 0 })).toBe('+1 -0 in 1 file')
  })

  it('adds up the tests of every file', () => {
    expect(testTotals(null)).toBeNull()
    expect(testTotals({})).toBeNull()
    expect(testTotals({ 'a.test.js': { cases: 2, assertions: 3 }, 'b.test.js': { cases: 1, assertions: 1 } })).toEqual({ files: 2, cases: 3, assertions: 4 })
  })

  it('sums tokens per agent and skips runs that reported none', () => {
    const runs = [run({ agent: 'claude', tokens: 20_000 }), run({ agent: 'codex', tokens: null }), run({ agent: 'claude', tokens: 35_000 }), run({ agent: 'fake', tokens: 1234 })]
    expect(tokensByAgent(runs)).toEqual([
      { agent: 'claude', tokens: 55_000 },
      { agent: 'fake', tokens: 1234 }
    ])
  })

  it('times a run live while it works and by its own duration after', () => {
    expect(runSpan(run(), 10_000)).toBeNull()
    expect(runSpan(run({ startedAt: 1_000, status: 'running' }), 49_000)).toBe('48 s')
    expect(runSpan(run({ startedAt: 1_000, endedAt: 9_000, durationMs: 7_000 }), 99_000)).toBe('7 s')
    expect(runSpan(run({ startedAt: 1_000, endedAt: 61_000 }), 99_000)).toBe('1 m')
  })
})

describe('the Tonight row and the night rows', () => {
  const idle: NightState = { queue: [], nights: [], keepingAwake: false }
  const task = (id: string): NightTask => ({ id, prompt: 'p', agent: 'fake', checks: [], createdAt: 0 })

  it('says what is queued, when it starts, or that it runs', () => {
    expect(tonightLine(null)).toBe('No tasks queued')
    expect(tonightLine(idle)).toBe('No tasks queued')
    expect(tonightLine({ ...idle, queue: [task('a')] })).toBe('1 task queued')
    expect(tonightLine({ ...idle, queue: [task('a'), task('b'), task('c')] })).toBe('3 tasks queued')
    expect(tonightLine({ ...idle, nights: [night({ status: 'scheduled', startAt: at(1, 0) })] })).toBe(`Starts at ${formatClock(at(1, 0))}`)
    expect(tonightLine({ ...idle, queue: [task('a')], nights: [night({ status: 'running' })], keepingAwake: true })).toBe('Running now')
  })

  it('finds the night that is scheduled or running, and none once they are over', () => {
    expect(activeNight(null)).toBeNull()
    expect(activeNight({ ...idle, nights: [night({ status: 'finished' }), night({ id: 'old', status: 'cancelled' })] })).toBeNull()
    expect(activeNight({ ...idle, nights: [night({ id: 'new', status: 'running' }), night({ status: 'finished' })] })?.id).toBe('new')
  })

  it('adds the time to a night\'s title only when another night has the same date', () => {
    const morning = night({ id: 'a', startAt: new Date(2026, 9, 3, 1, 0).getTime() })
    const evening = night({ id: 'b', startAt: new Date(2026, 9, 3, 22, 30).getTime() })
    const nextDay = night({ id: 'c', startAt: new Date(2026, 9, 4, 1, 0).getTime() })
    expect(nightRowTitle(nextDay, [evening, morning, nextDay])).toBe(formatNightDate(nextDay.startAt))
    expect(nightRowTitle(morning, [evening, morning, nextDay])).toBe(`${formatNightDate(morning.startAt)} \u00B7 ${formatClock(morning.startAt)}`)
    expect(nightRowTitle(evening, [evening, morning, nextDay])).toBe(`${formatNightDate(evening.startAt)} \u00B7 ${formatClock(evening.startAt)}`)
    expect(nightRowTitle(morning, [morning])).toBe(formatNightDate(morning.startAt))
  })

  it('counts tasks and ready tasks', () => {
    expect(nightRowLine(night({}, [run({ status: 'ready' }), run({ id: 'abcd-1', status: 'failed' }), run({ id: 'abcd-2', status: 'ready' })]))).toBe('3 tasks, 2 ready')
    expect(nightRowLine(night({}, [run({ status: 'failed' })]))).toBe('1 task, 0 ready')
  })

  it('colors a night: finished is green only when something is ready', () => {
    expect(nightLook(night({ status: 'scheduled' })).label).toBe('Scheduled')
    expect(nightLook(night({ status: 'running' })).label).toBe('Running')
    expect(nightLook(night({ status: 'cancelled' })).label).toBe('Cancelled')
    expect(nightLook(night({ status: 'finished' }, [run({ status: 'ready' })])).dot).toBe('bg-st-idle')
    expect(nightLook(night({ status: 'finished' }, [run({ status: 'failed' })])).dot).toBe('bg-st-quiet')
    expect(nightLook(night({ status: 'cancelled' }, [run({ status: 'ready' })])).dot).toBe('bg-st-quiet')
  })
})

describe('nightSummary', () => {
  const started = at(1, 10)
  const ended = at(3, 42)
  const ran = (over: Partial<NightTaskRun>): NightTaskRun => run({ startedAt: started, endedAt: started + 1000, ...over })

  it('reads like the card: ready of all, the failed note in brackets, then when it ran', () => {
    const runs = [ran({ status: 'ready' }), ran({ id: 'abcd-1', status: 'ready' }), ran({ id: 'abcd-2', status: 'failed', note: 'failing: done' })]
    expect(nightSummary(night({ finishedAt: ended }, runs))).toBe(`2 of 3 ready · 1 failed (failing: done) · ran ${formatClock(started)} to ${formatClock(ended)}`)
  })

  it('leaves the notes out when more than one run failed', () => {
    const runs = [ran({ status: 'failed', note: 'one' }), ran({ id: 'abcd-1', status: 'failed', note: 'two' })]
    expect(nightSummary(night({ finishedAt: ended }, runs))).toBe(`0 of 2 ready · 2 failed · ran ${formatClock(started)} to ${formatClock(ended)}`)
  })

  it('counts what the morning did, so the numbers still add up', () => {
    const runs = [ran({ status: 'merged' }), ran({ id: 'abcd-1', status: 'discarded' }), ran({ id: 'abcd-2', status: 'stopped' }), ran({ id: 'abcd-3', status: 'ready' })]
    expect(nightSummary(night({ finishedAt: ended }, runs))).toBe(
      `1 of 4 ready · 1 stopped · 1 merged · 1 discarded · ran ${formatClock(started)} to ${formatClock(ended)}`
    )
  })

  it('cuts a very long note so the line stays a line', () => {
    const long = 'x'.repeat(400)
    const text = nightSummary(night({ finishedAt: ended }, [ran({ status: 'failed', note: long })]))
    expect(text.length).toBeLessThan(260)
    expect(text).toContain('...)')
  })

  it('says when a night waits, runs, or never started', () => {
    expect(nightSummary(night({ status: 'scheduled', startAt: at(1, 0) }, [run(), run({ id: 'abcd-1' })]))).toBe(`2 tasks · starts at ${formatClock(at(1, 0))}`)
    expect(nightSummary(night({ status: 'running' }, [ran({ status: 'running' })]))).toBe(`0 of 1 ready · running since ${formatClock(started)}`)
    expect(nightSummary(night({ status: 'running' }, [run()]))).toBe('0 of 1 ready · starting up')
    expect(nightSummary(night({ status: 'cancelled', finishedAt: at(0, 30) }, [run()]))).toBe('1 task · cancelled before it started')
    expect(nightSummary(night({ status: 'finished', finishedAt: at(0, 30) }, [run({ status: 'failed', note: 'The baseline could not be prepared' })]))).toBe(
      '0 of 1 ready · 1 failed (The baseline could not be prepared) · no task started'
    )
  })

  it('titles a night with its date and project folder', () => {
    expect(nightTitle(night())).toMatch(/· my-app$/)
  })

  it('writes the Ran fact', () => {
    expect(ranText(night({ status: 'finished', finishedAt: ended }, [ran({ status: 'ready' })]), at(9, 0))).toBe(`${formatClock(started)} to ${formatClock(ended)}`)
    expect(ranText(night({ status: 'running' }, [ran({ status: 'running' })]), started + 12 * 60_000)).toBe('running for 12 m')
    expect(ranText(night({ status: 'cancelled' }, [run()]), at(9, 0))).toBe('did not start')
    expect(ranText(night({ status: 'scheduled', startAt: at(1, 0) }), at(0, 0))).toBe(formatClock(at(1, 0)))
    expect(ranLabel(night({ status: 'scheduled' }))).toBe('Starts')
    expect(ranLabel(night({ status: 'finished' }))).toBe('Ran')
  })
})

describe('gitCommandIn', () => {
  it('takes the command out of the line the engine writes for a parked copy', () => {
    const line =
      "Kept a copy of the run's work at refs/regatta/discarded/night-abcd-0 (restore the work with git branch night-abcd-0-restored refs/regatta/discarded/night-abcd-0^1; git log refs/regatta/discarded/night-abcd-0 shows everything kept)."
    // The first parent of the keep commit is the work; the remark after the semicolon is not part of the command.
    expect(gitCommandIn(line)).toBe('git branch night-abcd-0-restored refs/regatta/discarded/night-abcd-0^1')
  })

  it('finds no command in a line that only mentions git', () => {
    expect(gitCommandIn('Dependencies were not copied into the worktree; run your install command there.')).toBeNull()
    expect(gitCommandIn('Could not look at your folder, so nothing was merged. git status warned: something')).toBeNull()
    expect(gitCommandIn('The merge stopped: git merge failed: conflicts in a.txt')).toBeNull()
    expect(gitCommandIn('Your git folder is fine.')).toBeNull()
  })
})

describe('customCheck', () => {
  it('is a required check named after its command', () => {
    expect(customCheck('  test -f DONE.txt ', [])).toEqual({ name: 'test -f DONE.txt', command: 'test -f DONE.txt', kind: 'required' })
  })

  it('shortens a long name but keeps the whole command', () => {
    const command = `npm run lint -- ${'--rule x '.repeat(10)}`.trim()
    const spec = customCheck(command, [])
    expect(spec.name.length).toBeLessThanOrEqual(40)
    expect(spec.name.endsWith('...')).toBe(true)
    expect(spec.command).toBe(command)
  })

  it('never takes a name the task already has: results are matched by name', () => {
    expect(customCheck('test', ['test']).name).toBe('test (2)')
    expect(customCheck('test', ['test', 'test (2)']).name).toBe('test (3)')
  })
})

describe('what is left of a run', () => {
  it('has its worktree until it is merged or discarded, unless something was kept', () => {
    expect(worktreeLikelyThere(run({ worktree: null }))).toBe(false)
    expect(worktreeLikelyThere(run({ worktree: '/w/a', status: 'ready' }))).toBe(true)
    expect(worktreeLikelyThere(run({ worktree: '/w/a', status: 'failed' }))).toBe(true)
    expect(worktreeLikelyThere(run({ worktree: '/w/a', status: 'merged', note: 'Merged. Removed 1 worktree and 1 branch.' }))).toBe(false)
    expect(worktreeLikelyThere(run({ worktree: '/w/a', status: 'discarded', note: 'Kept: /w/a was kept: it has unsaved work.' }))).toBe(true)
  })

  it('may be discarded again only when something was kept', () => {
    expect(hasLeftovers(run({ status: 'discarded', note: 'Kept: /w/a was kept.' }))).toBe(true)
    expect(hasLeftovers(run({ status: 'merged', note: 'Merged.' }))).toBe(false)
    expect(hasLeftovers(run({ status: 'ready', note: 'Kept: something' }))).toBe(false)
  })
})

describe('branchLikelyThere', () => {
  it('is there until the run is merged or discarded, unless something was kept', () => {
    expect(branchLikelyThere(run({ branch: null }))).toBe(false)
    expect(branchLikelyThere(run({ branch: 'regatta/night-abcd-fake', status: 'ready' }))).toBe(true)
    expect(branchLikelyThere(run({ branch: 'regatta/night-abcd-fake', status: 'failed', worktree: '/w/a' }))).toBe(true)
    expect(branchLikelyThere(run({ branch: 'regatta/night-abcd-fake', status: 'merged', worktree: '/w/a', note: 'Merged.' }))).toBe(false)
    expect(branchLikelyThere(run({ branch: 'regatta/night-abcd-fake', status: 'discarded', worktree: null, note: 'Kept: the branch moved on.' }))).toBe(true)
  })
})

describe('lastLines', () => {
  it('keeps the last lines that have words in them', () => {
    expect(lastLines('one\n\ntwo\nthree\n', 2)).toBe('two\nthree')
    expect(lastLines('', 10)).toBe('')
    expect(lastLines('only', 10)).toBe('only')
  })

  it('shows a line as a terminal would: what follows the last carriage return', () => {
    expect(lastLines('\u280b Reading (0s)\r\u2819 Reading (0s)\r\u2839 Reading (1s)', 10)).toBe('\u2839 Reading (1s)')
    // A Windows line ending is not a redraw.
    expect(lastLines('start\r\nnext line', 10)).toBe('start\nnext line')
    expect(lastLines('a\rb\r\nc', 10)).toBe('b\nc')
  })
})

describe('folderForRun', () => {
  it('opens the worktree when the project is the top of its repository, or the top is not known', () => {
    expect(folderForRun('/w/night-abcd-fake', '/Users/me/app', '/Users/me/app')).toBe('/w/night-abcd-fake')
    expect(folderForRun('/w/night-abcd-fake', '/Users/me/app', null)).toBe('/w/night-abcd-fake')
  })

  it('opens the matching folder of the worktree for a project below the top of its repository', () => {
    expect(folderForRun('/w/night-abcd-fake', '/Users/me/mono/packages/app', '/Users/me/mono')).toBe('/w/night-abcd-fake/packages/app')
    expect(folderForRun('/w/night-abcd-fake/', '/Users/me/mono/app/', '/Users/me/mono/')).toBe('/w/night-abcd-fake/app')
  })

  it('opens the worktree when the project is not under the top as written (a link such as /var and /private/var)', () => {
    expect(folderForRun('/w/night-abcd-fake', '/var/folders/x/app', '/private/var/folders/x/app')).toBe('/w/night-abcd-fake')
    expect(folderForRun('/w/night-abcd-fake', '/Users/me/mono-two/app', '/Users/me/mono')).toBe('/w/night-abcd-fake')
  })
})

describe('the agents a night can use', () => {
  const kinds = Object.keys(AGENTS) as AgentKind[]

  it('are exactly the ones the headless runner can start', () => {
    for (const kind of kinds) {
      const runs = (): string[] => headlessArgs(kind, 'task', '/tmp/x', false)
      if (HEADLESS_AGENTS.includes(kind)) expect(runs, kind).not.toThrow()
      else expect(runs, kind).toThrow()
    }
  })
})
