// What a step card shows. The fake agent prints nothing until it ends, so no end-to-end run can watch the
// live peek; this renders the card (to static markup, no browser) for each state a run can put it in.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AGENTS } from '@shared/agents'
import type { FlowRun, FlowStep, StepRun, StepStatus } from '@shared/flows'
import type { AgentKind, DetectedAgent } from '@shared/types'
import { StepCard } from './FlowPipeline'

const detected: DetectedAgent[] = (['claude', 'codex', 'fake'] as AgentKind[]).map((kind) => ({ ...AGENTS[kind], installed: kind !== 'codex', path: '/bin/x', version: null }))

function stepOf(partial: Partial<FlowStep> = {}): FlowStep {
  return { id: 's1', kind: 'agent', title: 'Plan it', agent: 'claude', prompt: 'plan', command: '', ...partial }
}

function stepRunOf(status: StepStatus, output = ''): StepRun {
  return { stepId: 's1', status, output, exitCode: null, startedAt: 1, endedAt: null }
}

function runOf(status: FlowRun['status'], stepRun: StepRun): FlowRun {
  return { id: 'r1', flowId: 'f1', flowName: 'Flow', isolated: false, status, worktree: null, branch: null, steps: [stepRun], startedAt: 1, endedAt: null, mergeSummary: null }
}

function render(step: FlowStep, stepRun?: StepRun, run: FlowRun | null = null, selected = false, acting?: 'approve' | 'stop'): string {
  return renderToStaticMarkup(
    createElement(StepCard, { step, index: 0, stepRun, run, acting, selected, detected, onSelect: () => undefined, onApprove: () => undefined, onStop: () => undefined })
  )
}

describe('a step card', () => {
  it('shows the number, the title, the role and a pending pill before any run', () => {
    const html = render(stepOf())
    expect(html).toContain('Step 01')
    expect(html).toContain('Plan it')
    expect(html).toContain('Coding agent · Claude Code')
    expect(html).toContain('data-status="pending"')
    expect(html).toContain('data-kind="agent"')
    expect(html).not.toContain('flow-step-peek')
  })

  it('writes the role of a check and of an approval', () => {
    expect(render(stepOf({ kind: 'check', agent: null, command: 'npm test' }))).toContain('Check · npm test')
    expect(render(stepOf({ kind: 'approval', agent: null }))).toContain('>Approval<')
  })

  it('shows a two-line peek at the output while the step works', () => {
    const html = render(stepOf(), stepRunOf('running', 'alpha-1\nbeta-2\ngamma-3\ndelta-4'), runOf('running', stepRunOf('running')))
    expect(html).toContain('data-testid="flow-step-peek"')
    expect(html).toContain('gamma-3')
    expect(html).toContain('delta-4')
    expect(html).not.toContain('alpha-1')
    expect(html).not.toContain('beta-2')
    expect(html).toContain('data-status="running"')
    expect(html).toContain('working')
  })

  it('has no peek when there is no output yet, and none once the step is done', () => {
    expect(render(stepOf(), stepRunOf('running', ''))).not.toContain('flow-step-peek')
    expect(render(stepOf(), stepRunOf('done', 'finished text'))).not.toContain('flow-step-peek')
  })

  it('shows the engine\'s sentence on a failed step', () => {
    const sentence = 'The check changed tracked files, so its result does not match the committed change.'
    const html = render(stepOf({ kind: 'check', agent: null, command: 'echo x >> README.md' }), stepRunOf('failed', `some output\n${sentence}`))
    expect(html).toContain('data-testid="flow-step-detail"')
    expect(html).toContain(sentence)
    expect(html).toContain('data-status="failed"')
    expect(html).toContain('border-st-failed/40')
  })

  it('offers Approve and Stop only on a step that is waiting inside a waiting run', () => {
    const waiting = stepRunOf('waiting')
    const html = render(stepOf({ kind: 'approval', agent: null, title: 'Review' }), waiting, runOf('waiting', waiting))
    expect(html).toContain('data-testid="flow-approve"')
    expect(html).toContain('data-testid="flow-stop"')
    expect(html).toContain('needs you')
    expect(html).toContain('border-st-waiting/40')
    const done = stepRunOf('done')
    expect(render(stepOf(), done, runOf('done', done))).not.toContain('flow-approve')
    expect(render(stepOf(), stepRunOf('running'), runOf('running', stepRunOf('running')))).not.toContain('flow-approve')
    expect(render(stepOf(), waiting, runOf('stopped', waiting))).not.toContain('flow-approve')
  })

  it('turns Approve and Stop off while one of them is on its way, and says which', () => {
    const waiting = stepRunOf('waiting')
    const approval = stepOf({ kind: 'approval', agent: null, title: 'Review' })
    const idle = render(approval, waiting, runOf('waiting', waiting))
    expect(idle).not.toContain('disabled=""')
    expect(idle).toContain('>Approve<')
    const approving = render(approval, waiting, runOf('waiting', waiting), false, 'approve')
    expect(approving).toContain('Approving…')
    expect(approving.match(/disabled=""/g)).toHaveLength(2)
    const stopping = render(approval, waiting, runOf('waiting', waiting), false, 'stop')
    expect(stopping).toContain('Stopping…')
    expect(stopping.match(/disabled=""/g)).toHaveLength(2)
  })

  it('says what a step lacks and that an agent is missing', () => {
    expect(render(stepOf({ prompt: '' }))).toContain('Add a prompt')
    expect(render(stepOf({ kind: 'check', agent: null, command: '' }))).toContain('Add a command')
    expect(render(stepOf({ agent: 'codex' }))).toContain('(not installed)')
    // A hint is for a step that has not run: once it ran, the run's result is the story.
    expect(render(stepOf({ prompt: '' }), stepRunOf('done'))).not.toContain('Add a prompt')
  })

  it('marks the selected card', () => {
    expect(render(stepOf(), undefined, null, true)).toContain('data-selected="true"')
    expect(render(stepOf(), undefined, null, true)).toContain('aria-pressed="true"')
    expect(render(stepOf())).toContain('data-selected="false"')
  })
})
