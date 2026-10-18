// The New task and Edit task dialog: what to do, who does it, and the checks that decide.

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import type { CheckSpec } from '@shared/heats'
import type { Teammate } from '@shared/chat'
import type { AgentKind, DetectedAgent } from '@shared/types'
import type { NewTask, Task } from '@shared/tasks'
import { Modal } from '../../../../components/overlay'
import { Button, cx } from '../../../../components/ui'

/** The same commands the hand-off form offers, so a task reads the way a heat does. */
const PRESETS = {
  Build: 'npm run build',
  Test: 'npm test',
  Typecheck: 'npm run typecheck',
  Lint: 'npm run lint'
}

const blankCheck = (): CheckSpec => ({ name: '', command: '', kind: 'required' })

interface TaskDraft {
  title: string
  prompt: string
  kind: 'agent' | 'crew'
  agent: AgentKind
  teammateId: string
  backups: AgentKind[]
  checks: CheckSpec[]
  note: string
}

function draftOf(task: Task | null, agents: DetectedAgent[], teammates: Teammate[]): TaskDraft {
  const installed = agents.filter((agent) => agent.installed).map((agent) => agent.kind)
  if (task) {
    return {
      title: task.title,
      prompt: task.prompt,
      kind: task.assignee.kind,
      agent: task.assignee.kind === 'agent' ? task.assignee.agent : (installed[0] ?? 'claude'),
      teammateId: task.assignee.kind === 'crew' ? task.assignee.teammateId : (teammates[0]?.id ?? ''),
      backups: [...task.backups],
      checks: task.checks.map((check) => ({ ...check })),
      note: task.note
    }
  }
  return {
    title: '',
    prompt: '',
    kind: 'agent',
    agent: installed[0] ?? 'claude',
    teammateId: teammates[0]?.id ?? '',
    backups: [],
    checks: [{ name: 'test', command: PRESETS.Test, kind: 'required' }],
    note: ''
  }
}

interface TaskEditorProps {
  task: Task | null
  agents: DetectedAgent[]
  teammates: Teammate[]
  saving: boolean
  serverError: string | null
  onSave: (task: NewTask) => Promise<boolean>
  onClose: () => void
}

export function TaskEditor({ task, agents, teammates, saving, serverError, onSave, onClose }: TaskEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState<TaskDraft>(() => draftOf(task, agents, teammates))
  const [localError, setLocalError] = useState<string | null>(null)

  const set = (patch: Partial<TaskDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }))
    setLocalError(null)
  }

  const installed = agents.filter((agent) => agent.installed)
  const lead = draft.kind === 'agent' ? draft.agent : (teammates.find((mate) => mate.id === draft.teammateId)?.agent ?? null)
  const backupChoices = installed.filter((agent) => agent.kind !== lead).map((agent) => agent.kind)
  const agentChoices = installed.length > 0
    ? installed.map((agent) => ({ kind: agent.kind, name: agent.name }))
    : [{ kind: draft.agent, name: AGENTS[draft.agent]?.name ?? draft.agent }]
  const patchCheck = (index: number, patch: Partial<CheckSpec>): void =>
    set({ checks: draft.checks.map((check, i) => (i === index ? { ...check, ...patch } : check)) })

  const handleSave = async (): Promise<void> => {
    if (!draft.title.trim()) {
      setLocalError('Give the task a title.')
      return
    }
    if (!draft.prompt.trim()) {
      setLocalError('Write what the task is for.')
      return
    }
    if (draft.kind === 'crew' && !draft.teammateId) {
      setLocalError('Pick a crew member.')
      return
    }
    if (draft.kind === 'agent' && !lead) {
      setLocalError('Pick an agent Regatta knows.')
      return
    }
    if (draft.checks.some((check) => !check.name.trim() || !check.command.trim())) {
      setLocalError('Give each check a name and a command.')
      return
    }
    const ok = await onSave({
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      assignee: draft.kind === 'agent' ? { kind: 'agent', agent: draft.agent } : { kind: 'crew', teammateId: draft.teammateId },
      backups: draft.backups.filter((kind) => kind !== lead).slice(0, 3),
      checks: draft.checks.map((check) => ({ name: check.name.trim(), command: check.command.trim(), kind: check.kind })),
      note: draft.note.trim()
    })
    if (ok) onClose()
  }

  const error = localError ?? serverError

  return (
    <Modal
      title={task ? `Edit ${task.title}` : 'New task'}
      subtitle="A task is handed to an agent or a crew member, and comes back for you to review."
      onClose={onClose}
      testId="tasks-editor"
      width={560}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="accent" size="sm" data-testid="tasks-save" disabled={saving} onClick={() => void handleSave()}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 pt-1">
        <div>
          <label htmlFor="tasks-title" className="block text-[12px] font-medium text-fg">
            Title
          </label>
          <input
            id="tasks-title"
            data-testid="tasks-title"
            type="text"
            autoFocus
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Fix the flaky checkout test"
            maxLength={120}
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
          />
        </div>

        <div>
          <label htmlFor="tasks-prompt" className="block text-[12px] font-medium text-fg">
            What the agent is told
          </label>
          <textarea
            id="tasks-prompt"
            data-testid="tasks-prompt"
            rows={3}
            value={draft.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            placeholder="Make the checkout test stop failing, then run the whole suite."
            maxLength={4000}
            className="mt-1.5 w-full resize-none rounded-lg border border-line-strong bg-panel px-3 py-2 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
          />
        </div>

        <div>
          <span className="block text-[12px] font-medium text-fg">Who does the work</span>
          <div className="mt-1.5 flex gap-1.5">
            {(
              [
                { kind: 'agent', label: 'An agent' },
                { kind: 'crew', label: 'A crew member' }
              ] as const
            ).map((opt) => (
              <button
                key={opt.kind}
                type="button"
                data-testid={`tasks-assignee-${opt.kind}`}
                aria-pressed={draft.kind === opt.kind}
                onClick={() => set({ kind: opt.kind })}
                className={cx(
                  'rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors duration-150',
                  draft.kind === opt.kind
                    ? 'border-accent/50 bg-accent/[0.12] text-fg'
                    : 'border-line-strong bg-panel text-muted hover:text-fg'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {draft.kind === 'agent' ? (
            <select
              data-testid="tasks-agent"
              aria-label="Agent"
              value={draft.agent}
              onChange={(e) => set({ agent: e.target.value as AgentKind })}
              className="mt-2 w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
            >
              {agentChoices.map((agent) => (
                <option key={agent.kind} value={agent.kind}>
                  {agent.name}
                </option>
              ))}
            </select>
          ) : (
            <select
              data-testid="tasks-teammate"
              aria-label="Crew member"
              value={draft.teammateId}
              onChange={(e) => set({ teammateId: e.target.value })}
              className="mt-2 w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
            >
              {teammates.length === 0 && <option value="">No crew members yet</option>}
              {teammates.map((mate) => (
                <option key={mate.id} value={mate.id}>
                  {mate.name}
                </option>
              ))}
            </select>
          )}
          {draft.kind === 'crew' && teammates.length === 0 && (
            <p className="mt-1.5 text-[11.5px] text-muted">Add a crew member in Agents mode first.</p>
          )}
        </div>

        <div>
          <span className="block text-[12px] font-medium text-fg">Backups</span>
          <p className="mt-0.5 text-[11.5px] text-faint">
            These agents continue the same work when {lead ? (AGENTS[lead]?.name ?? lead) : 'the lead'} leaves the checks failing.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {backupChoices.length === 0 && <p className="text-[11.5px] text-faint">No other agent is installed, so this runs solo.</p>}
            {backupChoices.map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-[12px] text-fg">
                <input
                  type="checkbox"
                  data-testid="tasks-backup"
                  data-agent={kind}
                  checked={draft.backups.includes(kind)}
                  disabled={!draft.backups.includes(kind) && draft.backups.length >= 3}
                  onChange={() =>
                    set({ backups: draft.backups.includes(kind) ? draft.backups.filter((b) => b !== kind) : [...draft.backups, kind] })
                  }
                  className="accent-accent"
                />
                {AGENTS[kind]?.name ?? kind}
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-[11.5px] text-faint">
            {draft.backups.length + 1} {draft.backups.length === 0 ? 'attempt' : 'attempts in all'}, 15 minutes each.
          </p>
        </div>

        <div>
          <span className="block text-[12px] font-medium text-fg">Checks</span>
          <p className="mt-0.5 text-[11.5px] text-faint">Every check must pass before a task comes back for review.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(PRESETS).map(([name, command]) => (
              <Button
                key={name}
                size="sm"
                variant="subtle"
                data-testid="tasks-check-preset"
                onClick={() =>
                  set({
                    checks: [
                      ...draft.checks.filter((check) => check.name || check.command),
                      { name: name.toLowerCase(), command, kind: 'required' }
                    ]
                  })
                }
              >
                {name}
              </Button>
            ))}
            <Button size="sm" variant="subtle" data-testid="tasks-check-add" onClick={() => set({ checks: [...draft.checks, blankCheck()] })}>
              <Plus size={13} />
              Command
            </Button>
          </div>
          <div className="mt-2 space-y-2">
            {draft.checks.map((check, index) => (
              <div key={index} data-testid="tasks-check-row" className="flex gap-2">
                <input
                  data-testid="tasks-check-name"
                  value={check.name}
                  onChange={(e) => patchCheck(index, { name: e.target.value })}
                  aria-label={`Check ${index + 1} name`}
                  placeholder="name"
                  className="h-8 w-28 min-w-0 rounded-md border border-line bg-panel px-2.5 text-[12.5px] text-fg outline-none focus:border-accent/50"
                />
                <input
                  data-testid="tasks-check-command"
                  value={check.command}
                  onChange={(e) => patchCheck(index, { command: e.target.value })}
                  aria-label={`Check ${index + 1} command`}
                  placeholder="command"
                  className="h-8 min-w-0 flex-1 rounded-md border border-line bg-panel px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
                />
                <select
                  data-testid="tasks-check-kind"
                  value={check.kind}
                  onChange={(e) => patchCheck(index, { kind: e.target.value as CheckSpec['kind'] })}
                  aria-label={`Check ${index + 1} kind`}
                  className="h-8 min-w-0 rounded-md border border-line bg-panel px-2 text-[12px] text-fg outline-none focus:border-accent/50"
                >
                  <option value="required">Required</option>
                  <option value="guard">Guard</option>
                </select>
                <button
                  type="button"
                  data-testid="tasks-check-remove"
                  onClick={() => set({ checks: draft.checks.filter((_, i) => i !== index) })}
                  aria-label={`Remove check ${index + 1}`}
                  className="rounded p-1 text-muted hover:bg-hover"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="tasks-note" className="block text-[12px] font-medium text-fg">
            Note
          </label>
          <input
            id="tasks-note"
            data-testid="tasks-note"
            type="text"
            value={draft.note}
            onChange={(e) => set({ note: e.target.value })}
            placeholder="Something to remember when it comes back"
            maxLength={200}
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
          />
        </div>

        {error && (
          <p role="alert" data-testid="tasks-editor-error" className="text-[12px] text-st-failed">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
