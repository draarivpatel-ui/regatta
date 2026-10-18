import { describe, expect, it } from 'vitest'
import { countTests, decide, duplicateNames, evaluateGates, isTestFile, type CheckSpec, type CheckResult, type LaneState } from './heats'

const checks: CheckSpec[] = [
  { name: 'test', command: 'npm test', kind: 'required' },
  { name: 'lint', command: 'npm run lint', kind: 'guard' }
]
const ok = (name: string): CheckResult => ({ name, passed: true, exitCode: 0, durationMs: 10, outputTail: '' })
const bad = (name: string): CheckResult => ({ name, passed: false, exitCode: 1, durationMs: 10, outputTail: '' })
const baseline = [bad('test'), ok('lint')]
const baseTests = { 'test/cart.test.js': { cases: 3, assertions: 5 } }

function lane(over: Partial<LaneState> = {}): Pick<LaneState, 'exitCode' | 'timedOut' | 'diff' | 'checks' | 'tests'> {
  return {
    exitCode: 0,
    timedOut: false,
    diff: { files: 1, added: 10, removed: 1 },
    checks: [ok('test'), ok('lint')],
    tests: { 'test/cart.test.js': { cases: 3, assertions: 5 } },
    ...over
  }
}
const allPassed = (g: { passed: boolean }[]): boolean => g.every((x) => x.passed)
const names = (a: string): string => ({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' })[a] ?? a

describe('test file rules', () => {
  it('recognizes common test file names', () => {
    for (const p of ['test/a.js', 'src/__tests__/b.ts', 'a.test.ts', 'b.spec.tsx', 'pkg/c_test.go', 'tests/test_d.py', 'spec/e.rb'])
      expect(isTestFile(p)).toBe(true)
    for (const p of ['src/testing.ts', 'latest.ts', 'contest/a.ts']) expect(isTestFile(p)).toBe(false)
  })
  it('counts cases and assertions', () => {
    expect(countTests("it('a', () => { expect(1).toBe(1) })\ntest('b', () => { expect(2) })")).toEqual({ cases: 2, assertions: 2 })
    expect(countTests('def test_one():\n    assert x\n')).toEqual({ cases: 1, assertions: 1 })
  })
})

describe('gates', () => {
  it('passes a clean lane', () => {
    expect(allPassed(evaluateGates(lane(), checks, baseline, baseTests))).toBe(true)
  })
  it('fails finished on timeout or bad exit', () => {
    expect(evaluateGates(lane({ timedOut: true }), checks, baseline, baseTests)[0]).toMatchObject({ passed: false, detail: 'ran out of time' })
    expect(evaluateGates(lane({ exitCode: 2 }), checks, baseline, baseTests)[0]!.passed).toBe(false)
  })
  it('fails changed when nothing changed', () => {
    expect(evaluateGates(lane({ diff: { files: 0, added: 0, removed: 0 } }), checks, baseline, baseTests)[1]!.passed).toBe(false)
  })
  it('fails checks when a required check fails', () => {
    expect(evaluateGates(lane({ checks: [bad('test'), ok('lint')] }), checks, baseline, baseTests)[2]).toMatchObject({ passed: false, detail: 'failing: test' })
  })
  it('fails checks when two checks share a name, even if one of them passes', () => {
    const twins: CheckSpec[] = [
      { name: 'test', command: 'npm test', kind: 'required' },
      { name: 'test', command: 'npm run slow', kind: 'required' }
    ]
    const gates = evaluateGates(lane({ checks: [ok('test'), bad('test')] }), twins, baseline, baseTests)
    expect(gates[2]).toMatchObject({ passed: false, detail: 'check names repeat: test' })
    expect(duplicateNames(twins)).toEqual(['test'])
    expect(duplicateNames(checks)).toEqual([])
  })
  it('fails no-regressions only for guards that passed at baseline', () => {
    expect(evaluateGates(lane({ checks: [ok('test'), bad('lint')] }), checks, baseline, baseTests)[3]).toMatchObject({ passed: false, detail: 'broke: lint' })
    const lintWasBroken = [bad('test'), bad('lint')]
    expect(evaluateGates(lane({ checks: [ok('test'), bad('lint')] }), checks, lintWasBroken, baseTests)[3]!.passed).toBe(true)
  })
  it('fails integrity when tests are deleted or weakened', () => {
    expect(evaluateGates(lane({ tests: {} }), checks, baseline, baseTests)[4]).toMatchObject({ passed: false, detail: 'deleted test/cart.test.js' })
    expect(evaluateGates(lane({ tests: { 'test/cart.test.js': { cases: 2, assertions: 5 } } }), checks, baseline, baseTests)[4]!.passed).toBe(false)
    expect(evaluateGates(lane({ tests: { 'test/cart.test.js': { cases: 3, assertions: 4 } } }), checks, baseline, baseTests)[4]!.passed).toBe(false)
    expect(evaluateGates(lane({ tests: { 'test/cart.test.js': { cases: 4, assertions: 9 } } }), checks, baseline, baseTests)[4]!.passed).toBe(true)
  })
})

describe('decision', () => {
  const pass = evaluateGates(lane(), checks, baseline, baseTests)
  const fail = evaluateGates(lane({ checks: [bad('test'), ok('lint')] }), checks, baseline, baseTests)

  it('picks the fastest lane outside the tie band', () => {
    const d = decide(
      [
        { id: 'a', agent: 'claude', durationMs: 28000, gates: pass },
        { id: 'b', agent: 'codex', durationMs: 46000, gates: pass }
      ],
      names
    )
    expect(d.kind).toBe('winner')
    expect(d.laneIds).toEqual(['a'])
    expect(d.note).toBe('Claude Code wins: every gate passed and it finished in 28 s, outside the 20% band of Codex (46 s).')
  })

  it('calls a tie inside the 20% band', () => {
    const d = decide(
      [
        { id: 'a', agent: 'claude', durationMs: 30000, gates: pass },
        { id: 'b', agent: 'codex', durationMs: 35000, gates: pass },
        { id: 'c', agent: 'gemini', durationMs: 60000, gates: pass }
      ],
      names
    )
    expect(d.kind).toBe('tie')
    expect(d.laneIds).toEqual(['a', 'b'])
  })

  it('ignores lanes that failed a gate', () => {
    const d = decide(
      [
        { id: 'a', agent: 'claude', durationMs: 10000, gates: fail },
        { id: 'b', agent: 'codex', durationMs: 50000, gates: pass }
      ],
      names
    )
    expect(d).toMatchObject({ kind: 'winner', laneIds: ['b'] })
  })

  it('reports why when nobody passed', () => {
    const d = decide([{ id: 'a', agent: 'claude', durationMs: 10000, gates: fail }], names)
    expect(d.kind).toBe('none')
    expect(d.note).toBe('No lane passed every gate. Claude Code: failing: test.')
  })

  it('names repeated agents by their label in every kind of note', () => {
    const win = decide(
      [
        { id: 'claude-1', agent: 'claude', label: 'Claude Code 1', durationMs: 10000, gates: fail },
        { id: 'claude-2', agent: 'claude', label: 'Claude Code 2', durationMs: 50000, gates: pass },
        { id: 'codex-3', agent: 'codex', durationMs: 90000, gates: pass }
      ],
      names
    )
    expect(win).toMatchObject({ kind: 'winner', laneIds: ['claude-2'] })
    expect(win.note).toBe('Claude Code 2 wins: every gate passed and it finished in 50 s, outside the 20% band of Codex (90 s).')

    const tie = decide(
      [
        { id: 'claude-1', agent: 'claude', label: 'Claude Code 1', durationMs: 30000, gates: pass },
        { id: 'claude-2', agent: 'claude', label: 'Claude Code 2', durationMs: 31000, gates: pass }
      ],
      names
    )
    expect(tie.kind).toBe('tie')
    expect(tie.note).toContain('Claude Code 1 (30 s), Claude Code 2 (31 s)')

    const none = decide(
      [
        { id: 'claude-1', agent: 'claude', label: 'Claude Code 1', durationMs: 1000, gates: fail },
        { id: 'claude-2', agent: 'claude', label: 'Claude Code 2', durationMs: 1000, gates: fail }
      ],
      names
    )
    expect(none.note).toBe('No lane passed every gate. Claude Code 1: failing: test; Claude Code 2: failing: test.')
  })
})
