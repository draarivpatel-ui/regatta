// Unit tests for the pure helpers behind the Spot fix card: which files every round touched, which of
// them define the checks about to run, which rounds cannot be undone, and the current preview URL.
// Renderer test files run in the node environment (vitest.config.ts).

import { describe, expect, it } from 'vitest'
import type { CheckSpec } from '@shared/heats'
import type { SpotFix } from '@shared/spotfix'
import {
  canStopSpotFix,
  changedFilesAcrossRounds,
  checkCommandsOf,
  checkDefinitionConflicts,
  currentPreviewUrl,
  detectedChecksFor,
  PickSequence,
  runsChangedCode,
  unfinishedRounds
} from './checkFlow'

function spec(name: string, command: string): CheckSpec {
  return { name, command, kind: 'required' }
}

function fix(overrides: Partial<SpotFix> = {}): SpotFix {
  return {
    id: 'x',
    cwd: '/tmp/project',
    agent: 'fake',
    pick: { url: 'http://localhost:1/', selector: 'h1', text: '', tag: 'h1', rect: { x: 0, y: 0, width: 1, height: 1 } },
    status: 'review',
    rounds: [],
    latest: '',
    hasBefore: false,
    hasAfter: false,
    undo: null,
    undoNote: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('changedFilesAcrossRounds', () => {
  it('unions every round and lets the newest numbers win per path', () => {
    const f = fix({
      rounds: [
        { note: 'a', stepId: '1', completed: true, startedAt: 0, endedAt: 1, files: [{ path: 'src/app.js', added: 3, removed: 1 }], checks: [] },
        { note: 'b', stepId: '2', completed: true, startedAt: 2, endedAt: 3, files: [{ path: 'src/app.js', added: 5, removed: 2 }, { path: 'x.txt', added: 1, removed: 0 }], checks: [] }
      ]
    })
    const byPath = new Map(changedFilesAcrossRounds(f).map((x) => [x.path, x]))
    expect(byPath.get('src/app.js')).toEqual({ path: 'src/app.js', added: 5, removed: 2 })
    expect(byPath.get('x.txt')?.path).toBe('x.txt')
  })
})

describe('unfinishedRounds', () => {
  // Finding 3 (round 2): a round that finished with no edits is not a crash; only one that never got
  // through checkpoints.end is.
  it('lists rounds that never completed their checkpoint end, one-based', () => {
    const f = fix({
      rounds: [
        { note: 'a', stepId: '1', completed: true, startedAt: 0, endedAt: 1, files: [], checks: [] },
        { note: 'b', stepId: null, completed: false, startedAt: 2, endedAt: null, files: [], checks: [] }
      ]
    })
    expect(unfinishedRounds(f)).toEqual([2])
  })

  it('does not flag a completed round whose empty step was dropped', () => {
    const f = fix({
      rounds: [{ note: 'a', stepId: null, completed: true, startedAt: 0, endedAt: 1, files: [], checks: [] }]
    })
    expect(unfinishedRounds(f)).toEqual([])
  })

  // Finding 2 (round 3): a round whose checkpoint start failed never launched, so it does not block Undo.
  it('does not flag a round that never launched because its checkpoint start failed', () => {
    const f = fix({
      rounds: [
        { note: 'a', stepId: '1', launched: true, completed: true, startedAt: 0, endedAt: 1, files: [], checks: [] },
        { note: 'b', stepId: null, launched: false, completed: false, startedAt: 2, endedAt: 3, files: [], checks: [] }
      ]
    })
    expect(unfinishedRounds(f)).toEqual([])
  })
})

describe('checkDefinitionConflicts', () => {
  // Finding 1: a round that edited the file that defines the checks must cost a second click.
  it('flags the manifest a test or typecheck command reads', () => {
    const specs = [spec('test', 'npm test'), spec('typecheck', 'npm run typecheck')]
    expect(checkDefinitionConflicts(specs, ['package.json', 'README.md'])).toEqual(['package.json'])
  })

  it('flags a test file when the command runs a test runner', () => {
    const specs = [spec('test', 'npm test')]
    expect(checkDefinitionConflicts(specs, ['src/app.test.js'])).toEqual(['src/app.test.js'])
  })

  it('flags a file the command names directly by path', () => {
    const specs = [spec('lint', 'eslint --config config/lint.json src')]
    expect(checkDefinitionConflicts(specs, ['config/lint.json'])).toEqual(['config/lint.json'])
  })

  // Finding 6 (round 3): config changes are flagged for typecheck and lint checks too, not only tests.
  it('flags linter, typecheck and bundler config files even when no test runner is in the checks', () => {
    const lintSpecs = [spec('lint', 'npm run lint')]
    expect(checkDefinitionConflicts(lintSpecs, ['eslint.config.js', '.eslintrc.json', 'src/app.js'])).toEqual([
      '.eslintrc.json',
      'eslint.config.js'
    ])
    const typecheckSpecs = [spec('typecheck', 'npm run typecheck')]
    expect(checkDefinitionConflicts(typecheckSpecs, ['tsconfig.node.json', 'vite.config.ts', 'tailwind.config.js', 'src/app.ts'])).toEqual([
      'tailwind.config.js',
      'tsconfig.node.json',
      'vite.config.ts'
    ])
  })

  it('says nothing when the command does not read the touched file', () => {
    const specs = [spec('typecheck', 'npm run typecheck')]
    expect(checkDefinitionConflicts(specs, ['src/app.js'])).toEqual([])
  })

  it('says nothing when there are no checks to run', () => {
    expect(checkDefinitionConflicts([], ['package.json'])).toEqual([])
  })
})

describe('canStopSpotFix and detectedChecksFor (finding 4, round 3)', () => {
  it('keeps the Stop button active both while the agent runs and while checks run', () => {
    expect(canStopSpotFix('running')).toBe(true)
    expect(canStopSpotFix('checking')).toBe(true)
    expect(canStopSpotFix('review')).toBe(false)
    expect(canStopSpotFix('stopped')).toBe(false)
    expect(canStopSpotFix('kept')).toBe(false)
    expect(canStopSpotFix('undone')).toBe(false)
    expect(canStopSpotFix('error')).toBe(false)
  })

  it('reads check availability for the record own folder from the latest record list', () => {
    const stale = fix({ id: 'fix-1', cwd: '/proj-a', detectedChecks: [spec('lint', 'npm run lint')] })
    const refreshed = fix({ id: 'fix-1', cwd: '/proj-a', detectedChecks: [spec('test', 'npm test'), spec('lint', 'npm run lint')] })
    const other = fix({ id: 'fix-2', cwd: '/proj-b', detectedChecks: [] })
    expect(detectedChecksFor(stale, [other, refreshed])).toEqual([spec('test', 'npm test'), spec('lint', 'npm run lint')])
    expect(detectedChecksFor(stale)).toEqual([spec('lint', 'npm run lint')])
  })
})

describe('checkCommandsOf', () => {
  it('prints the exact command beside each name', () => {
    expect(checkCommandsOf([spec('test', 'npm test'), spec('lint', 'npm run lint')])).toEqual(['test: npm test', 'lint: npm run lint'])
  })
})

describe('runsChangedCode', () => {
  // Finding 2 (round 2): the second click is owed whenever any round changed a file at all, not only when
  // the changed file happens to define the checks.
  it('is true as soon as one round touched a file', () => {
    const f = fix({
      rounds: [
        { note: 'a', stepId: '1', completed: true, startedAt: 0, endedAt: 1, files: [{ path: 'src/app.js', added: 1, removed: 0 }], checks: [] }
      ]
    })
    expect(runsChangedCode(f)).toBe(true)
  })

  it('is false when every finished round changed nothing', () => {
    const f = fix({
      rounds: [
        { note: 'a', stepId: null, completed: true, startedAt: 0, endedAt: 1, files: [], checks: [] },
        { note: 'b', stepId: null, completed: true, startedAt: 2, endedAt: 3, files: [], checks: [] }
      ]
    })
    expect(runsChangedCode(f)).toBe(false)
  })
})

describe('PickSequence', () => {
  // Finding 7 (round 2): a pick that lands after its page navigated away must not open the note box.
  it('keeps the outstanding pick current until it is cancelled', () => {
    const picks = new PickSequence()
    const token = picks.start()
    expect(picks.current(token)).toBe(true)
    picks.cancel()
    expect(picks.current(token)).toBe(false)
  })

  it('drops an older pick when a newer one was started', () => {
    const picks = new PickSequence()
    const first = picks.start()
    const second = picks.start()
    expect(picks.current(first)).toBe(false)
    expect(picks.current(second)).toBe(true)
  })
})

describe('currentPreviewUrl', () => {
  // Finding 10: the local check follows the page after navigation, not the first src.
  it('reports the trail current entry, not the initial src', () => {
    expect(currentPreviewUrl('http://localhost:3000', ['http://localhost:3000', 'https://example.com'], 1)).toBe('https://example.com')
    expect(currentPreviewUrl('http://localhost:3000', ['http://localhost:3000'], 0)).toBe('http://localhost:3000')
  })

  it('falls back to the src when the trail has no entry yet', () => {
    expect(currentPreviewUrl('http://localhost:3000', [], 0)).toBe('http://localhost:3000')
  })
})
