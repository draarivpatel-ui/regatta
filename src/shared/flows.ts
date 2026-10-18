// Flows: up to 16 steps that hand their result along. See docs/design/flows.md.

import type { AgentKind } from './types'

export const MAX_STEPS = 16

export type StepKind = 'agent' | 'check' | 'approval'

export interface FlowStep {
  id: string
  kind: StepKind
  title: string
  /** For agent steps. */
  agent: AgentKind | null
  /** For agent steps: a template that may use {{brief}} and {{previous}}. */
  prompt: string
  /** For check steps: a shell command. */
  command: string
}

export interface Flow {
  id: string
  name: string
  brief: string
  trigger: 'manual'
  /** Run in its own worktree so the user's files are untouched until merged. */
  isolate: boolean
  steps: FlowStep[]
  createdAt: number
  updatedAt: number
}

export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped'

export interface StepRun {
  stepId: string
  status: StepStatus
  /** Last lines of the step's activity or command output. */
  output: string
  exitCode: number | null
  startedAt: number | null
  endedAt: number | null
}

export interface FlowRun {
  id: string
  flowId: string
  flowName: string
  /** True for a run made in its own worktree: the flow's `isolate` when the run started. It stays true after the worktree and branch are gone. */
  isolated: boolean
  status: 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
  worktree: string | null
  branch: string | null
  steps: StepRun[]
  startedAt: number
  endedAt: number | null
  mergeSummary: string | null
  /** What the engine kept and why (a worktree or branch it could not safely remove, a held folder). */
  notes?: string[]
}

/**
 * Fills {{brief}} and {{previous}} in a step prompt. Pure, unit tested. The values go in exactly as
 * they are (a replacer function, so "$&" or "$'" in a brief or in an agent's output stay text), and in
 * one pass, so a placeholder inside the brief is not filled a second time.
 */
export function fillPrompt(template: string, brief: string, previous: string): string {
  return template.replace(/\{\{\s*(brief|previous)\s*\}\}/g, (_match, name: string) => (name === 'brief' ? brief : previous))
}

/** Ready-made flows. Step ids are filled in when a recipe is applied. */
export const RECIPES: { id: string; name: string; steps: Omit<FlowStep, 'id'>[] }[] = [
  {
    id: 'feature',
    name: 'Build a feature',
    steps: [
      { kind: 'agent', title: 'Plan it', agent: 'claude', prompt: 'Plan how to {{brief}}. List the files to change and why. Do not edit anything.', command: '' },
      { kind: 'agent', title: 'Build it', agent: 'codex', prompt: 'Implement this plan:\n{{previous}}', command: '' },
      { kind: 'check', title: 'Run the tests', agent: null, prompt: '', command: 'npm test' },
      { kind: 'approval', title: 'Review the change', agent: null, prompt: '', command: '' }
    ]
  },
  {
    id: 'bug',
    name: 'Fix a bug',
    steps: [
      { kind: 'agent', title: 'Find the cause', agent: 'claude', prompt: 'Find the cause of this bug: {{brief}}. Explain it. Do not edit anything.', command: '' },
      { kind: 'agent', title: 'Fix it', agent: 'claude', prompt: 'Fix this bug and add a regression test. What we know:\n{{previous}}', command: '' },
      { kind: 'check', title: 'Run the tests', agent: null, prompt: '', command: 'npm test' }
    ]
  },
  {
    id: 'release',
    name: 'Review a release',
    steps: [
      { kind: 'agent', title: 'Review the changes', agent: 'codex', prompt: 'Review the changes since the last tag for bugs and risky edits. {{brief}}', command: '' },
      { kind: 'approval', title: 'Decide', agent: null, prompt: '', command: '' }
    ]
  },
  {
    id: 'landing',
    name: 'Launch a landing page',
    steps: [
      { kind: 'agent', title: 'Build the page', agent: 'claude', prompt: 'Build a landing page: {{brief}}', command: '' },
      { kind: 'check', title: 'Build the site', agent: null, prompt: '', command: 'npm run build' },
      { kind: 'approval', title: 'Look it over', agent: null, prompt: '', command: '' }
    ]
  },
  {
    id: 'signin',
    name: 'Add sign-in',
    steps: [
      { kind: 'agent', title: 'Plan sign-in', agent: 'claude', prompt: 'Plan sign-in for this app. {{brief}} Do not edit anything.', command: '' },
      { kind: 'agent', title: 'Implement it', agent: 'codex', prompt: 'Implement sign-in following this plan:\n{{previous}}', command: '' },
      { kind: 'check', title: 'Run the tests', agent: null, prompt: '', command: 'npm test' },
      { kind: 'approval', title: 'Review', agent: null, prompt: '', command: '' }
    ]
  }
]
