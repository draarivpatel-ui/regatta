import { describe, expect, it } from 'vitest'
import { AGENTS } from '@shared/agents'
import type { Flow, FlowRun, FlowStep, StepRun } from '@shared/flows'
import type { AgentKind, DetectedAgent } from '@shared/types'
import { headlessArgs } from '../../../../main/heats/runner'
import {
  agentChoices,
  deleteBlocker,
  defaultAgent,
  formatDuration,
  formatWhen,
  HEADLESS_AGENTS,
  mergeRuns,
  noteCommand,
  normalizeSelection,
  outputLines,
  reconcileFlows,
  runHeadline,
  runView,
  settleActing,
  sortFlows,
  stepHint,
  stepRole,
  stripIpcPrefix,
  titleAfterKindChange,
  upsertRun
} from './logic'

function step(partial: Partial<FlowStep> = {}): FlowStep {
  return { id: 's1', kind: 'agent', title: 'Agent step', agent: 'claude', prompt: 'do it', command: '', ...partial }
}

function flow(partial: Partial<Flow> = {}): Flow {
  return { id: 'f1', name: 'Flow', brief: '', trigger: 'manual', isolate: false, steps: [], createdAt: 1, updatedAt: 1, ...partial }
}

function stepRun(partial: Partial<StepRun> = {}): StepRun {
  return { stepId: 's1', status: 'pending', output: '', exitCode: null, startedAt: null, endedAt: null, ...partial }
}

function run(partial: Partial<FlowRun> = {}): FlowRun {
  return {
    id: 'r1',
    flowId: 'f1',
    flowName: 'Flow',
    isolated: false,
    status: 'done',
    worktree: null,
    branch: null,
    steps: [],
    startedAt: 1000,
    endedAt: 2000,
    mergeSummary: null,
    ...partial
  }
}

function detected(installed: AgentKind[]): DetectedAgent[] {
  return (Object.keys(AGENTS) as AgentKind[]).map((kind) => ({ ...AGENTS[kind], installed: installed.includes(kind), path: installed.includes(kind) ? '/bin/x' : null, version: null }))
}

describe('the agent list', () => {
  it('is exactly the agents the headless runner can start', () => {
    for (const kind of HEADLESS_AGENTS) expect(() => headlessArgs(kind, 'task', '/tmp', false), kind).not.toThrow()
    for (const kind of Object.keys(AGENTS) as AgentKind[]) {
      if (HEADLESS_AGENTS.includes(kind)) continue
      expect(() => headlessArgs(kind, 'task', '/tmp', false), kind).toThrow()
    }
  })

  it('offers installed headless agents only, the Test Agent when it was detected, never a terminal', () => {
    const choices = agentChoices(detected(['claude', 'fake', 'shell', 'cursor']), null)
    expect(choices.map((c) => c.kind)).toEqual(['claude', 'fake'])
    expect(choices.find((c) => c.kind === 'fake')?.name).toBe('Test Agent')
  })

  it('keeps the step\'s own agent in the menu even when it is not installed, and marks it', () => {
    const choices = agentChoices(detected(['claude']), 'codex')
    expect(choices.map((c) => [c.kind, c.installed])).toEqual([
      ['claude', true],
      ['codex', false]
    ])
  })

  it('does not list an installed current agent twice', () => {
    expect(agentChoices(detected(['claude', 'codex']), 'codex').map((c) => c.kind)).toEqual(['claude', 'codex'])
  })

  it('starts new agent steps with the first installed real agent, never the Test Agent', () => {
    expect(defaultAgent(detected(['codex', 'gemini', 'fake']))).toBe('codex')
    expect(defaultAgent(detected(['fake']))).toBe('claude')
    expect(defaultAgent([])).toBe('claude')
  })
})

describe('steps', () => {
  it('says what a step still needs before it can be saved', () => {
    expect(stepHint(step())).toBeNull()
    expect(stepHint(step({ prompt: '   ' }))).toBe('Add a prompt')
    expect(stepHint(step({ agent: null }))).toBe('Pick an agent')
    expect(stepHint(step({ kind: 'check', agent: null, command: '' }))).toBe('Add a command')
    expect(stepHint(step({ kind: 'check', agent: null, command: 'npm test' }))).toBeNull()
    expect(stepHint(step({ kind: 'approval', agent: null, prompt: '' }))).toBeNull()
  })

  it('writes the one-line role as the design says', () => {
    const all = detected(['claude'])
    expect(stepRole(step(), all)).toEqual({ text: 'Coding agent · Claude Code', warn: false })
    expect(stepRole(step({ kind: 'check', agent: null, command: ' npm test ' }), all)).toEqual({ text: 'Check · npm test', warn: false })
    expect(stepRole(step({ kind: 'approval', agent: null }), all)).toEqual({ text: 'Approval', warn: false })
  })

  it('warns when an agent is missing or a check has no command', () => {
    expect(stepRole(step({ agent: 'codex' }), detected(['claude']))).toEqual({ text: 'Coding agent · Codex (not installed)', warn: true })
    expect(stepRole(step({ kind: 'check', agent: null, command: '' }), [])).toEqual({ text: 'Check · no command yet', warn: true })
    expect(stepRole(step({ agent: null }), [])).toEqual({ text: 'Coding agent · none picked', warn: true })
  })

  it('renames a step with the kind only while nobody renamed it', () => {
    expect(titleAfterKindChange('Agent step', 'agent', 'check')).toBe('Check step')
    expect(titleAfterKindChange('Approval step', 'approval', 'agent')).toBe('Agent step')
    expect(titleAfterKindChange('Plan it', 'agent', 'check')).toBe('Plan it')
    expect(titleAfterKindChange('Agent step', 'check', 'approval')).toBe('Agent step')
  })

  it('takes the last lines of an output, treating a carriage return as a line break', () => {
    expect(outputLines('one\ntwo\nthree\n', 2)).toEqual(['two', 'three'])
    expect(outputLines('spin 1\rspin 2\rspin 3', 2)).toEqual(['spin 2', 'spin 3'])
    expect(outputLines('\n\n  \n', 2)).toEqual([])
    expect(outputLines('only', 2)).toEqual(['only'])
  })
})

describe('what a run offers', () => {
  it('offers merge and discard for a finished isolated run', () => {
    const view = runView(run({ worktree: '/w/flow-a', branch: 'regatta/flow-a' }), true)
    expect(view).toMatchObject({ live: false, held: true, merged: false, discarded: false, canMerge: true, canDiscard: true })
  })

  it('offers only discard for an isolated run that failed or was stopped', () => {
    for (const status of ['failed', 'stopped'] as const) {
      const view = runView(run({ status, worktree: '/w/flow-a', branch: 'regatta/flow-a' }), true)
      expect(view.canMerge, status).toBe(false)
      expect(view.canDiscard, status).toBe(true)
    }
  })

  it('offers nothing while the run is live, and nothing for a plain run', () => {
    expect(runView(run({ status: 'running', worktree: '/w', branch: 'b' }), true)).toMatchObject({ live: true, canMerge: false, canDiscard: false })
    expect(runView(run({ status: 'waiting', worktree: '/w', branch: 'b' }), true)).toMatchObject({ live: true, canMerge: false, canDiscard: false })
    expect(runView(run(), false)).toMatchObject({ held: false, merged: false, discarded: false, canMerge: false, canDiscard: false })
  })

  it('reads a merged run from its summary, and does not offer a second merge', () => {
    const view = runView(run({ mergeSummary: 'Fast-forwarded main by 1 commit (+1 -0 in 1 file).', worktree: '/w', branch: 'b' }), true)
    expect(view.merged).toBe(true)
    expect(view.canMerge).toBe(false)
    expect(runView(run({ mergeSummary: 'Merged.' }), true).canDiscard).toBe(false)
  })

  it('knows a discarded run from what this window saw of it, or from the parked copy in its notes', () => {
    expect(runView(run(), true).discarded).toBe(true)
    const parked = run({ notes: ["Kept a copy of the run's work at refs/regatta/discarded/flow-a (restore it with git branch <name> refs/regatta/discarded/flow-a)."] })
    expect(runView(parked, false).discarded).toBe(true)
    expect(runView(run({ mergeSummary: 'Merged.' }), true).discarded).toBe(false)
  })

  it('needs both a worktree and a branch to merge', () => {
    expect(runView(run({ worktree: '/w', branch: null }), true).canMerge).toBe(false)
    expect(runView(run({ worktree: null, branch: 'b' }), true).canMerge).toBe(false)
    expect(runView(run({ worktree: null, branch: 'b' }), true).canDiscard).toBe(true)
  })

  it('writes a headline for every state', () => {
    const steps = [stepRun({ stepId: 'a', status: 'done' }), stepRun({ stepId: 'b', status: 'pending' }), stepRun({ stepId: 'c', status: 'pending' })]
    const title = (id: string): string => ({ a: 'Plan', b: 'Check it', c: 'Review' })[id] ?? id
    const withStatus = (status: FlowRun['status'], mid: StepRun['status'], last: StepRun['status'] = 'pending'): FlowRun =>
      run({ status, steps: [steps[0]!, { ...steps[1]!, status: mid }, { ...steps[2]!, status: last }] })
    expect(runHeadline(withStatus('running', 'running'), title)).toBe('Working on step 2: Check it')
    expect(runHeadline(withStatus('waiting', 'done', 'waiting'), title)).toBe('Waiting for you at step 3: Review')
    expect(runHeadline(withStatus('failed', 'failed', 'skipped'), title)).toBe('Failed at step 2: Check it')
    expect(runHeadline(withStatus('stopped', 'skipped', 'skipped'), title)).toBe('Stopped at step 2: Check it')
    expect(runHeadline(withStatus('done', 'done', 'done'), title)).toBe('All 3 steps passed')
    expect(runHeadline(run({ status: 'done', steps: [steps[0]!] }), title)).toBe('The step passed')
    expect(runHeadline(run({ status: 'failed', steps: [steps[0]!] }), title)).toBe('Failed after its last step')
  })
})

describe('pending approves and stops', () => {
  const waitingAt = (stepId: string): FlowRun =>
    run({ status: 'waiting', steps: [stepRun({ stepId: 'a', status: stepId === 'a' ? 'waiting' : 'done' }), stepRun({ stepId: 'b', status: stepId === 'b' ? 'waiting' : 'pending' })] })

  it('keeps a pending approve while the run still waits at the same step', () => {
    const acting = { r1: { kind: 'approve' as const, stepId: 'a' } }
    expect(settleActing(acting, waitingAt('a'))).toBe(acting)
  })

  it('drops a pending approve once the run waits at another step, or does not wait', () => {
    const acting = { r1: { kind: 'approve' as const, stepId: 'a' } }
    expect(settleActing(acting, waitingAt('b'))).toEqual({})
    expect(settleActing(acting, run({ status: 'running', steps: [stepRun({ stepId: 'a', status: 'done' })] }))).toEqual({})
    expect(settleActing(acting, run({ status: 'done' }))).toEqual({})
  })

  it('keeps a pending stop until the run is over, whatever step it is on', () => {
    const acting = { r1: { kind: 'stop' as const, stepId: null } }
    expect(settleActing(acting, waitingAt('b'))).toBe(acting)
    expect(settleActing(acting, run({ status: 'running' }))).toBe(acting)
    expect(settleActing(acting, run({ status: 'stopped' }))).toEqual({})
  })

  it('leaves other runs and runs without a pending action alone', () => {
    const acting = { other: { kind: 'stop' as const, stepId: null } }
    expect(settleActing(acting, run({ status: 'done' }))).toBe(acting)
    expect(settleActing({}, run())).toEqual({})
  })
})

describe('run lists', () => {
  it('keeps runs newest first and replaces a run by its id', () => {
    const a = run({ id: 'a', startedAt: 10 })
    const b = run({ id: 'b', startedAt: 20 })
    expect(upsertRun([a], b).map((r) => r.id)).toEqual(['b', 'a'])
    const again = upsertRun([b, a], { ...a, status: 'failed' })
    expect(again.map((r) => r.id)).toEqual(['b', 'a'])
    expect(again[1]?.status).toBe('failed')
  })

  it('keeps what the window already knows when the engine lists the same run', () => {
    const known = run({ id: 'a', status: 'done' })
    const merged = mergeRuns([known], [run({ id: 'a', status: 'running' }), run({ id: 'c', startedAt: 5 })])
    expect(merged.find((r) => r.id === 'a')?.status).toBe('done')
    expect(merged.map((r) => r.id).sort()).toEqual(['a', 'c'])
  })

  it('will not delete a flow with a live run or a run that still holds a worktree', () => {
    expect(deleteBlocker([])).toBeNull()
    expect(deleteBlocker([run()])).toBeNull()
    expect(deleteBlocker([run({ status: 'running' })])).toMatch(/is running/)
    expect(deleteBlocker([run({ worktree: '/w', branch: 'b' })])).toMatch(/A run of this flow still has its own worktree/)
    expect(deleteBlocker([run({ branch: 'b' }), run({ id: 'r2', worktree: '/w' })])).toMatch(/2 runs of this flow still have/)
  })
})

describe('notes', () => {
  it('copies only the git command out of the parked copy sentence, as the engine wrote it', () => {
    const note = "Kept a copy of the run's work at refs/regatta/discarded/flow-abcd (restore it with git branch <name> refs/regatta/discarded/flow-abcd)."
    expect(noteCommand(note)).toBe('git branch <name> refs/regatta/discarded/flow-abcd')
  })

  it('keeps whatever the engine puts after the ref, so a changed wording needs no change here', () => {
    const note = "Kept a copy of the run's work at refs/regatta/discarded/flow-abcd (restore the work with git branch <name> refs/regatta/discarded/flow-abcd^1)."
    expect(noteCommand(note)).toBe('git branch <name> refs/regatta/discarded/flow-abcd^1')
  })

  it('does not fill in the placeholder: which commit to restore, and the name, are not the window\'s to choose', () => {
    expect(noteCommand('Restore it with git branch <name> HEAD.')).toBe('git branch <name> HEAD')
  })

  it('offers no command for sentences that only mention git', () => {
    expect(noteCommand('Branch regatta/flow-abcd was kept: it is checked out in a worktree.')).toBeNull()
    expect(noteCommand('The folder could not be checked: git status warned: bad object')).toBeNull()
    expect(noteCommand('The merge stopped: git merge failed: conflicts in a.txt')).toBeNull()
    expect(noteCommand('Nothing to copy here.')).toBeNull()
  })

  it('drops a closing period from a command that ends a sentence', () => {
    expect(noteCommand('Remove it yourself with git worktree remove /tmp/flow-a.')).toBe('git worktree remove /tmp/flow-a')
  })
})

describe('the flow list', () => {
  const old = flow({ id: 'old', createdAt: 1 })
  const fresh = flow({ id: 'fresh', createdAt: 9 })

  it('lists the newest flow first', () => {
    expect(sortFlows([old, fresh]).map((f) => f.id)).toEqual(['fresh', 'old'])
  })

  it('keeps a flow with unsaved edits when the engine sends its list, and takes the engine copy of the rest', () => {
    const typing = flow({ id: 'f1', brief: 'typed just now' })
    const quiet = flow({ id: 'f2', brief: 'old local' })
    const engine = [flow({ id: 'f1', brief: 'older save' }), flow({ id: 'f2', brief: 'engine copy' })]
    const out = reconcileFlows([typing, quiet], engine, new Set(['f1']), new Set(['f1', 'f2']))
    expect(out.find((f) => f.id === 'f1')?.brief).toBe('typed just now')
    expect(out.find((f) => f.id === 'f2')?.brief).toBe('engine copy')
  })

  it('keeps a new flow the engine has never seen, and drops one it had and no longer has', () => {
    const brandNew = flow({ id: 'new' })
    const deleted = flow({ id: 'gone' })
    const out = reconcileFlows([brandNew, deleted], [], new Set(), new Set(['gone']))
    expect(out.map((f) => f.id)).toEqual(['new'])
  })

  it('keeps a deleted-looking flow that still has unsaved edits', () => {
    const out = reconcileFlows([flow({ id: 'gone' })], [], new Set(['gone']), new Set(['gone']))
    expect(out.map((f) => f.id)).toEqual(['gone'])
  })

  it('adds flows only the engine has', () => {
    expect(reconcileFlows([], [flow({ id: 'x' })], new Set(), new Set()).map((f) => f.id)).toEqual(['x'])
  })

  it('keeps the selection that still exists, otherwise the newest flow and its first step', () => {
    const withSteps = flow({ id: 'fresh', createdAt: 9, steps: [step({ id: 'a' }), step({ id: 'b' })] })
    expect(normalizeSelection([old, withSteps], 'fresh', 'b')).toEqual({ selectedFlowId: 'fresh', selectedStepId: 'b' })
    expect(normalizeSelection([old, withSteps], 'fresh', 'removed')).toEqual({ selectedFlowId: 'fresh', selectedStepId: null })
    expect(normalizeSelection([old, withSteps], 'missing', 'b')).toEqual({ selectedFlowId: 'fresh', selectedStepId: 'a' })
    expect(normalizeSelection([], 'missing', null)).toEqual({ selectedFlowId: null, selectedStepId: null })
  })
})

describe('words and times', () => {
  it('strips the Electron wrapper from an engine sentence', () => {
    expect(stripIpcPrefix(new Error("Error invoking remote method 'flows:merge': Error: Only a finished run can be merged."))).toBe('Only a finished run can be merged.')
    expect(stripIpcPrefix(new Error("Error invoking remote method 'flows:run': Regatta is quitting, so nothing new was started."))).toBe('Regatta is quitting, so nothing new was started.')
    expect(stripIpcPrefix(new Error('A flow needs a name.'))).toBe('A flow needs a name.')
    expect(stripIpcPrefix('plain text')).toBe('plain text')
  })

  it('also drops the name of the engine\'s own error classes', () => {
    expect(stripIpcPrefix(new Error("Error invoking remote method 'flows:merge': MergeRefused: Commit or stash your changes first. Merging needs a clean folder."))).toBe('Commit or stash your changes first. Merging needs a clean folder.')
    expect(stripIpcPrefix(new Error("Error invoking remote method 'flows:run': Quitting: Regatta is quitting, so nothing new was started."))).toBe('Regatta is quitting, so nothing new was started.')
  })

  it('removes one name only, so git\'s own words and sentences with a colon stay whole', () => {
    expect(stripIpcPrefix(new Error("Error invoking remote method 'flows:run': Error: Not installed: Codex."))).toBe('Not installed: Codex.')
    expect(stripIpcPrefix(new Error("Error invoking remote method 'flows:merge': Error: fatal: not a git repository"))).toBe('fatal: not a git repository')
  })

  it('formats durations like the rest of the app', () => {
    expect(formatDuration(0)).toBe('0 s')
    expect(formatDuration(8400)).toBe('8 s')
    expect(formatDuration(72_000)).toBe('1 m 12 s')
    expect(formatDuration(3_900_000)).toBe('1 h 5 m')
    expect(formatDuration(-5)).toBe('0 s')
  })

  it('says Today for today and the date for another day', () => {
    const noon = new Date(2026, 9, 15, 12, 0).getTime()
    expect(formatWhen(noon, noon + 60_000)).toMatch(/^Today, /)
    const other = formatWhen(noon, noon + 3 * 86_400_000)
    expect(other).not.toMatch(/^Today/)
    expect(other).toMatch(/15/)
  })
})
