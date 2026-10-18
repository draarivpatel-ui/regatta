// Pure helpers for Flows mode. No React and no bridge, so every one of them runs in a unit test.

import type { CSSProperties } from 'react'
import { AGENTS } from '@shared/agents'
import type { Flow, FlowRun, FlowStep, StepKind, StepStatus } from '@shared/flows'
import type { AgentKind, DetectedAgent, SessionState } from '@shared/types'

/** Thin scrollbars in the theme's line color for the columns of Flows mode (the default ones are bright on navy). */
export const SCROLLBAR: CSSProperties = { scrollbarWidth: 'thin', scrollbarColor: 'var(--color-line-strong) transparent' }

/**
 * The agents the headless runner can start, in menu order. It mirrors `headlessArgs` in
 * src/main/heats/runner.ts (a unit test keeps the two from drifting apart). The Test Agent only shows up
 * when the app detected it, which is in tests.
 */
export const HEADLESS_AGENTS: AgentKind[] = ['claude', 'codex', 'gemini', 'grok', 'opencode', 'fake']

export const DEFAULT_FLOW_NAME = 'Untitled flow'

/** The title a new step gets, and the one a step gets back when its kind changes before anyone renamed it. */
export const DEFAULT_TITLES: Record<StepKind, string> = {
  agent: 'Agent step',
  check: 'Check step',
  approval: 'Approval step'
}

/**
 * What the engine told the window, without Electron's wrapper: "Error invoking remote method 'x': " and then the
 * name of the error class, which is "Error" for most and "MergeRefused" or "Quitting" for the engine's own.
 * Only one such name is removed, so a sentence that starts with git's own "fatal: " keeps it.
 */
export function stripIpcPrefix(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (?:[A-Z][A-Za-z0-9]*: )?/, '')
}

// Agents

export interface AgentChoice {
  kind: AgentKind
  name: string
  installed: boolean
}

/**
 * The agents a step can pick: the installed ones that can run headless, plus the step's current agent
 * even when it is not installed (a recipe may ask for one this computer lacks), so the menu always
 * shows what the step really has.
 */
export function agentChoices(detected: DetectedAgent[], current: AgentKind | null): AgentChoice[] {
  const installed = (kind: AgentKind): boolean => detected.some((a) => a.kind === kind && a.installed)
  const kinds = HEADLESS_AGENTS.filter((kind) => installed(kind) || kind === current)
  return kinds.map((kind) => ({ kind, name: AGENTS[kind].name, installed: installed(kind) }))
}

/** The agent a new agent step starts with: the first installed real agent (never the Test Agent), else Claude Code. */
export function defaultAgent(detected: DetectedAgent[]): AgentKind {
  const found = HEADLESS_AGENTS.find((kind) => kind !== 'fake' && detected.some((a) => a.kind === kind && a.installed))
  return found ?? 'claude'
}

/** A step that cannot be saved yet, in a few words for its card. Null when it is complete. */
export function stepHint(step: FlowStep): string | null {
  if (step.kind === 'agent') {
    if (step.agent === null) return 'Pick an agent'
    if (step.prompt.trim().length === 0) return 'Add a prompt'
  }
  if (step.kind === 'check' && step.command.trim().length === 0) return 'Add a command'
  return null
}

/** The one-line role under a step's title: "Coding agent · Claude Code", "Check · npm test", "Approval". */
export function stepRole(step: FlowStep, detected: DetectedAgent[]): { text: string; warn: boolean } {
  if (step.kind === 'approval') return { text: 'Approval', warn: false }
  if (step.kind === 'check') {
    const command = step.command.trim()
    return { text: command ? `Check · ${command}` : 'Check · no command yet', warn: command.length === 0 }
  }
  if (step.agent === null) return { text: 'Coding agent · none picked', warn: true }
  const name = AGENTS[step.agent].name
  const installed = detected.some((a) => a.kind === step.agent && a.installed)
  return installed ? { text: `Coding agent · ${name}`, warn: false } : { text: `Coding agent · ${name} (not installed)`, warn: true }
}

/** The title a step should have after its kind changed: a title nobody edited follows the kind. */
export function titleAfterKindChange(title: string, from: StepKind, to: StepKind): string {
  return title === DEFAULT_TITLES[from] ? DEFAULT_TITLES[to] : title
}

// Status words and colors

/** Which agent state color and dot a step status borrows. */
export function stepTone(status: StepStatus): SessionState {
  switch (status) {
    case 'running':
      return 'working'
    case 'waiting':
      return 'waiting'
    case 'done':
      return 'idle'
    case 'failed':
      return 'failed'
    default:
      return 'quiet'
  }
}

export function runTone(status: FlowRun['status']): SessionState {
  switch (status) {
    case 'running':
      return 'working'
    case 'waiting':
      return 'waiting'
    case 'done':
      return 'idle'
    case 'failed':
      return 'failed'
    default:
      return 'quiet'
  }
}

export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'pending',
  running: 'working',
  waiting: 'needs you',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped'
}

export const RUN_STATUS_LABEL: Record<FlowRun['status'], string> = {
  running: 'working',
  waiting: 'needs you',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped'
}

/** The last `count` non-empty lines of a step's output. A bare carriage return counts as a line break, like a terminal's. */
export function outputLines(output: string, count: number): string[] {
  return output
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-count)
}

// Runs

export function isLive(run: FlowRun): boolean {
  return run.status === 'running' || run.status === 'waiting'
}

export interface RunView {
  live: boolean
  /** The run still has a worktree or a branch of its own, so there is something to merge or discard. */
  held: boolean
  merged: boolean
  /** An isolated run whose worktree and branch are gone and that was not merged. */
  discarded: boolean
  canMerge: boolean
  canDiscard: boolean
}

/**
 * What the window may offer for a run, from the run itself. `seenIsolated` is what this window saw of
 * the run earlier (a run record has no flag of its own: once its worktree and branch are released they
 * are null, the same as for a run that was never isolated).
 */
export function runView(run: FlowRun, seenIsolated: boolean): RunView {
  const live = isLive(run)
  const held = run.worktree !== null || run.branch !== null
  const merged = run.mergeSummary !== null
  const parked = (run.notes ?? []).some((note) => note.includes('refs/regatta/discarded/'))
  return {
    live,
    held,
    merged,
    discarded: !held && !merged && (seenIsolated || parked),
    canMerge: run.status === 'done' && run.worktree !== null && run.branch !== null && !merged,
    canDiscard: held && !live
  }
}

/** A sentence for the top of a run's card. `titleOf` gives a step's title from its id. */
export function runHeadline(run: FlowRun, titleOf: (stepId: string) => string): string {
  const total = run.steps.length
  const at = (status: StepStatus): number => run.steps.findIndex((s) => s.status === status)
  const named = (index: number): string => `step ${index + 1}: ${titleOf(run.steps[index]!.stepId)}`
  switch (run.status) {
    case 'running': {
      const i = at('running')
      return i >= 0 ? `Working on ${named(i)}` : 'Starting up'
    }
    case 'waiting': {
      const i = at('waiting')
      return i >= 0 ? `Waiting for you at ${named(i)}` : 'Waiting for you'
    }
    case 'done':
      return total === 1 ? 'The step passed' : `All ${total} steps passed`
    case 'failed': {
      const i = at('failed')
      return i >= 0 ? `Failed at ${named(i)}` : 'Failed after its last step'
    }
    case 'stopped': {
      const i = run.steps.findIndex((s) => s.status === 'skipped')
      return i >= 0 ? `Stopped at ${named(i)}` : 'Stopped'
    }
  }
}

/** Newest first. A stable sort, so equal start times keep the order they came in. */
export function sortRuns(runs: FlowRun[]): FlowRun[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt)
}

/** Replaces the run with the same id or adds it, newest first. */
export function upsertRun(runs: FlowRun[], run: FlowRun): FlowRun[] {
  const at = runs.findIndex((r) => r.id === run.id)
  if (at < 0) return sortRuns([run, ...runs])
  const next = runs.slice()
  next[at] = run
  return next
}

/** What the window knows plus what the engine listed: a run already known keeps its newer state. */
export function mergeRuns(known: FlowRun[], listed: FlowRun[]): FlowRun[] {
  const have = new Set(known.map((r) => r.id))
  return sortRuns([...known, ...listed.filter((r) => !have.has(r.id))])
}

/** An Approve or Stop that was sent and has not shown up in the run yet. */
export interface Acting {
  kind: 'approve' | 'stop'
  /** For an approve: the step that was waiting. The approve is over when the run waits somewhere else, or no longer waits. */
  stepId: string | null
}

/** Drops the pending Approve or Stop of a run once the run's new state shows it took effect. */
export function settleActing(acting: Record<string, Acting>, run: FlowRun): Record<string, Acting> {
  const entry = acting[run.id]
  if (!entry) return acting
  const waitingAt = run.steps.find((s) => s.status === 'waiting')?.stepId ?? null
  const over = !isLive(run) || (entry.kind === 'approve' && (run.status !== 'waiting' || waitingAt !== entry.stepId))
  if (!over) return acting
  const next = { ...acting }
  delete next[run.id]
  return next
}

/** Why a flow cannot be deleted right now, as a sentence, or null when it can. */
export function deleteBlocker(runs: FlowRun[]): string | null {
  if (runs.some(isLive)) return 'This flow is running. Stop the run, or wait for it to finish, then delete the flow.'
  const held = runs.filter((r) => r.worktree !== null || r.branch !== null).length
  if (held > 0) {
    const what = held === 1 ? 'A run of this flow still has' : `${held} runs of this flow still have`
    return `${what} its own worktree and branch. Merge or discard ${held === 1 ? 'it' : 'them'} first, so nothing is left behind. If Regatta kept one because something in it is unsaved or in use, the run's notes say why.`
  }
  return null
}

// Notes

/**
 * The git command inside a run note, exactly as the engine wrote it, or null. The window never builds a command
 * itself (which commit to restore is the engine's to say, and it has changed before): it only finds the one the
 * note gives, for example "git branch <name> refs/regatta/discarded/flow-abcd". Only commands someone would run
 * count. A git error quoted in a sentence ("git merge failed: conflicts") does not: an argument never ends in a colon.
 */
export function noteCommand(note: string): string | null {
  const match = /\bgit\s+(?:branch|worktree|update-ref|checkout|switch|merge|cherry-pick|reset|restore|stash|tag|rm|clean|show|log|diff)\b[^()]*[^()\s.]/.exec(note)
  if (!match) return null
  return /:(?:\s|$)/.test(match[0]) ? null : match[0]
}

// Flows

export function sortFlows(flows: Flow[]): Flow[] {
  return [...flows].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}

export function flowSummary(flow: Flow): string {
  const n = flow.steps.length
  return `${n} step${n === 1 ? '' : 's'}`
}

/**
 * The list the window shows after the engine sent its list. A flow with edits that are not saved yet
 * (`busy`) keeps its local copy, so a save that finishes late never rolls a newer edit back. A flow the
 * engine does not have is kept when it never reached the engine (a new one) or has unsaved edits, and
 * dropped when the engine had it before (it was deleted).
 */
export function reconcileFlows(local: Flow[], engine: Flow[], busy: ReadonlySet<string>, known: ReadonlySet<string>): Flow[] {
  const mine = new Map(local.map((flow) => [flow.id, flow]))
  const out = engine.map((flow) => (busy.has(flow.id) ? (mine.get(flow.id) ?? flow) : flow))
  const theirs = new Set(engine.map((flow) => flow.id))
  for (const flow of local) {
    if (!theirs.has(flow.id) && (busy.has(flow.id) || !known.has(flow.id))) out.push(flow)
  }
  return out
}

/** The flow and step to show selected after the list changed: keep what still exists, else the newest flow's first step. */
export function normalizeSelection(
  flows: Flow[],
  flowId: string | null,
  stepId: string | null
): { selectedFlowId: string | null; selectedStepId: string | null } {
  const flow = flows.find((f) => f.id === flowId) ?? sortFlows(flows)[0] ?? null
  if (!flow) return { selectedFlowId: null, selectedStepId: null }
  if (flow.id !== flowId) return { selectedFlowId: flow.id, selectedStepId: flow.steps[0]?.id ?? null }
  return { selectedFlowId: flow.id, selectedStepId: flow.steps.some((s) => s.id === stepId) ? stepId : null }
}

// Times

/** "Today, 10:42 AM" for today, "Oct 14, 3:05 PM" for another day. */
export function formatWhen(timestamp: number, now: number): string {
  const when = new Date(timestamp)
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (when.toDateString() === new Date(now).toDateString()) return `Today, ${time}`
  return `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

export function formatDay(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** "8 s", "1 m 12 s", "1 h 5 m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} m ${seconds % 60} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`
}
