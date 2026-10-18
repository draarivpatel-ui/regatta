// What a run card shows and offers in each state a run can be in, rendered to static markup (no browser).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Flow, FlowRun, FlowStep, StepRun } from '@shared/flows'
import { FlowRuns, RunCard, type RunCardProps } from './FlowRuns'

const steps: FlowStep[] = [
  { id: 'a', kind: 'agent', title: 'Plan it', agent: 'claude', prompt: 'plan', command: '' },
  { id: 'b', kind: 'check', title: 'Run the tests', agent: null, prompt: '', command: 'npm test' },
  { id: 'c', kind: 'approval', title: 'Review', agent: null, prompt: '', command: '' }
]

function flowOf(partial: Partial<Flow> = {}): Flow {
  return { id: 'f1', name: 'Flow', brief: '', trigger: 'manual', isolate: false, steps, createdAt: 1, updatedAt: 1, ...partial }
}

function stepRun(stepId: string, status: StepRun['status'], output = ''): StepRun {
  return { stepId, status, output, exitCode: null, startedAt: 1000, endedAt: status === 'running' || status === 'waiting' ? null : 3000 }
}

function runOf(partial: Partial<FlowRun> = {}): FlowRun {
  return {
    id: 'r1',
    flowId: 'f1',
    flowName: 'Flow',
    isolated: false,
    status: 'done',
    worktree: null,
    branch: null,
    steps: [stepRun('a', 'done'), stepRun('b', 'done'), stepRun('c', 'done')],
    startedAt: 1000,
    endedAt: 4000,
    mergeSummary: null,
    ...partial
  }
}

function card(run: FlowRun, props: Partial<RunCardProps> = {}): string {
  return renderToStaticMarkup(
    createElement(RunCard, {
      run,
      flow: flowOf(),
      latest: true,
      expanded: true,
      seenIsolated: false,
      error: undefined,
      busy: undefined,
      acting: undefined,
      onToggle: () => undefined,
      onApprove: () => undefined,
      onStop: () => undefined,
      onMerge: () => undefined,
      onDiscard: () => undefined,
      onDismissError: () => undefined,
      ...props
    })
  )
}

const held = { worktree: '/w/flow-r1', branch: 'regatta/flow-r1' }
const waitingAtC = (): FlowRun => runOf({ status: 'waiting', endedAt: null, steps: [stepRun('a', 'done'), stepRun('b', 'done'), stepRun('c', 'waiting')] })

describe('Approve and Stop on a waiting run', () => {
  it('are left to the step card while its step is in the flow', () => {
    const html = card(waitingAtC())
    expect(html).not.toContain('flow-run-approve')
    expect(html).toContain('Waiting for you at step 3: Review')
  })

  it('appear on the run card when the waiting step was removed from the flow', () => {
    const html = card(waitingAtC(), { flow: flowOf({ steps: steps.slice(0, 2) }) })
    expect(html).toContain('data-testid="flow-run-approve"')
    expect(html).toContain('data-testid="flow-run-stop"')
    expect(html).toContain('a step that was removed')
  })

  it('appear on the run card for a run that is not the latest', () => {
    expect(card(waitingAtC(), { latest: false })).toContain('data-testid="flow-run-approve"')
  })

  it('wait while one of them is on its way', () => {
    const html = card(waitingAtC(), { latest: false, acting: 'approve' })
    expect(html).toContain('Approving…')
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })

  it('give a working run a Stop in its header, and a finished one none', () => {
    const working = runOf({ status: 'running', endedAt: null, steps: [stepRun('a', 'running'), stepRun('b', 'pending'), stepRun('c', 'pending')] })
    expect(card(working)).toContain('data-testid="flow-run-stop"')
    expect(card(working, { acting: 'stop' })).toContain('Stopping…')
    expect(card(runOf())).not.toContain('flow-run-stop')
  })
})

describe('merge, discard and what is left of a run', () => {
  it('offers both for a finished isolated run, with the branch named', () => {
    const html = card(runOf(held), { seenIsolated: true })
    expect(html).toContain("Merge the run&#x27;s changes")
    expect(html).toContain('data-testid="flow-discard"')
    expect(html).toContain('regatta/flow-r1')
    expect(html).toContain('Not merged yet')
  })

  it('offers only Discard for a run that did not finish, and says why', () => {
    const html = card(runOf({ ...held, status: 'failed', steps: [stepRun('a', 'done'), stepRun('b', 'failed', 'boom'), stepRun('c', 'skipped')] }), { seenIsolated: true })
    expect(html).toContain('data-testid="flow-discard"')
    expect(html).not.toContain('data-testid="flow-merge"')
    expect(html).toContain('did not finish')
  })

  it('shows the engine\'s summary after a merge and no buttons', () => {
    const html = card(runOf({ mergeSummary: 'Fast-forwarded main by 1 commit (+2 -0 in 2 files). Removed 1 worktree and 1 branch.' }), { seenIsolated: true })
    expect(html).toContain('data-testid="flow-merge-summary"')
    expect(html).toContain('Fast-forwarded main by 1 commit')
    expect(html).not.toContain('flow-merge"')
    expect(html).not.toContain('flow-discard')
    expect(html).toContain('>Merged<')
  })

  it('says Discarded for an isolated run whose worktree is gone, and offers nothing', () => {
    const html = card(runOf(), { seenIsolated: true })
    expect(html).toContain('data-testid="flow-discarded"')
    expect(html).not.toContain('data-testid="flow-discard"')
  })

  it('turns both buttons off while a merge or discard is under way', () => {
    const merging = card(runOf(held), { seenIsolated: true, busy: 'merge' })
    expect(merging).toContain('Merging…')
    expect(merging.match(/disabled=""/g)).toHaveLength(2)
    expect(card(runOf(held), { seenIsolated: true, busy: 'discard' })).toContain('Discarding…')
  })

  it('shows a refusal under the buttons and keeps the buttons', () => {
    const html = card(runOf(held), { seenIsolated: true, error: 'Commit or stash your changes first. Merging needs a clean folder.' })
    expect(html).toContain('data-testid="flow-run-error"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Commit or stash your changes first. Merging needs a clean folder.')
    expect(html).toContain('data-testid="flow-merge"')
    expect(html).toContain('data-testid="flow-discard"')
  })

  it('lists the notes and gives only the git one a Copy command button, with the command the engine wrote', () => {
    const notes = ["Kept a copy of the run's work at refs/regatta/discarded/flow-r1 (restore it with git branch <name> refs/regatta/discarded/flow-r1).", 'Branch regatta/flow-r1 was kept: it is checked out in a worktree.']
    const html = card(runOf({ notes }))
    expect(html.match(/data-testid="flow-note"/g)).toHaveLength(2)
    expect(html.match(/data-testid="flow-note-copy"/g)).toHaveLength(1)
    expect(html).toContain('data-command="git branch &lt;name&gt; refs/regatta/discarded/flow-r1"')
  })
})

describe('what each step delivered', () => {
  it('opens a failed step\'s output at once, so the sentence is the first thing read', () => {
    const run = runOf({ status: 'failed', steps: [stepRun('a', 'done', 'plan text'), stepRun('b', 'failed', 'one\nThe check changed tracked files, so its result does not match the committed change.'), stepRun('c', 'skipped')] })
    const html = card(run)
    expect(html).toContain('data-testid="flow-run-step-detail"')
    expect(html).toContain('The check changed tracked files')
    expect(html).toContain('Hide output')
  })

  it('keeps a finished step\'s output closed behind Show output', () => {
    const html = card(runOf({ steps: [stepRun('a', 'done', 'plan text here'), stepRun('b', 'done'), stepRun('c', 'done')] }))
    expect(html).toContain('Show output')
    expect(html).not.toContain('plan text here')
  })

  it('opens the output of the step right before one that waits for you, since that is what to review', () => {
    const run = runOf({ status: 'waiting', endedAt: null, steps: [stepRun('a', 'done', 'plan text'), stepRun('b', 'done', 'all tests pass'), stepRun('c', 'waiting')] })
    const html = card(run)
    expect(html).toContain('all tests pass')
    expect(html).not.toContain('plan text')
  })

  it('has no output toggle for an approval or a step with nothing saved', () => {
    const html = card(runOf({ steps: [stepRun('a', 'done'), stepRun('b', 'done'), stepRun('c', 'done', 'Approved')] }))
    expect(html).not.toContain('Show output')
  })
})

describe('the list of runs', () => {
  const many = (n: number): FlowRun[] => Array.from({ length: n }, (_, i) => runOf({ id: `r${i}`, startedAt: 1000 - i }))
  const list = (runs: FlowRun[]): string =>
    renderToStaticMarkup(
      createElement(FlowRuns, {
        flow: flowOf(),
        runs,
        isolatedSeen: {},
        runErrors: {},
        busyRuns: {},
        acting: {},
        onApprove: () => undefined,
        onStop: () => undefined,
        onMerge: () => undefined,
        onDiscard: () => undefined,
        onDismissError: () => undefined
      })
    )

  it('says so when there are no runs yet', () => {
    expect(list([])).toContain('data-testid="flow-runs-empty"')
  })

  it('opens the latest run and lists the earlier ones closed', () => {
    const html = list(many(3))
    expect(html.match(/data-testid="flow-run-card"/g)).toHaveLength(3)
    expect(html.match(/data-latest="true"/g)).toHaveLength(1)
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1)
    expect(html).toContain('Earlier runs')
  })

  it('shows five earlier runs and offers the rest, in the right plural', () => {
    expect(list(many(7))).toContain('Show 1 older run<')
    expect(list(many(8))).toContain('Show 2 older runs<')
    expect(list(many(6))).not.toContain('older run')
  })
})
