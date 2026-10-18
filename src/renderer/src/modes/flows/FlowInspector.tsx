// The right column: edits the selected step (title, kind, agent, prompt or command) and removes it.

import { ArrowLeft, ArrowRight, Check, Trash2, UserCheck } from 'lucide-react'
import type { Flow, FlowStep, StepKind } from '@shared/flows'
import type { AgentKind, DetectedAgent } from '@shared/types'
import { Button, IconButton, Kbd, cx } from '../../components/ui'
import { AgentBadge } from '../../components/marks'
import { agentChoices } from './logic'

interface FlowInspectorProps {
  flow: Flow
  step: FlowStep | null
  detected: DetectedAgent[]
  onTitle: (title: string) => void
  onKind: (kind: StepKind) => void
  onAgent: (agent: AgentKind) => void
  onPrompt: (prompt: string) => void
  onCommand: (command: string) => void
  onMove: (direction: 'left' | 'right') => void
  onRemove: () => void
}

const KINDS: { kind: StepKind; label: string }[] = [
  { kind: 'agent', label: 'Agent' },
  { kind: 'check', label: 'Check' },
  { kind: 'approval', label: 'Approval' }
]

const FIELD = 'w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60'

function KindIcon({ kind, agent }: { kind: StepKind; agent: AgentKind | null }): React.JSX.Element {
  if (kind === 'agent') return agent ? <AgentBadge kind={agent} size={14} /> : <span className="inline-block h-[14px] w-[14px]" />
  return kind === 'check' ? <Check size={13} /> : <UserCheck size={13} />
}

export function FlowInspector({ flow, step, detected, onTitle, onKind, onAgent, onPrompt, onCommand, onMove, onRemove }: FlowInspectorProps): React.JSX.Element {
  if (!step) {
    return (
      <aside data-testid="flow-inspector" aria-label="Step settings" className="flex h-full min-h-[160px] items-center justify-center px-6 py-10">
        <div className="text-center">
          <p className="text-[12.5px] font-medium text-fg">No step selected</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">Pick a step in the pipeline to edit it, or add one.</p>
        </div>
      </aside>
    )
  }

  const index = flow.steps.findIndex((s) => s.id === step.id)
  const choices = agentChoices(detected, step.agent)
  const chosen = choices.find((c) => c.kind === step.agent)

  return (
    <aside data-testid="flow-inspector" data-step-id={step.id} aria-label="Step settings" className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Step {String(index + 1).padStart(2, '0')}</h2>
        <div className="flex items-center gap-0.5">
          <IconButton data-testid="flow-step-move-left" aria-label="Move step earlier" title="Move earlier" disabled={index <= 0} onClick={() => onMove('left')}>
            <ArrowLeft size={13} />
          </IconButton>
          <IconButton data-testid="flow-step-move-right" aria-label="Move step later" title="Move later" disabled={index >= flow.steps.length - 1} onClick={() => onMove('right')}>
            <ArrowRight size={13} />
          </IconButton>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        <label className="block">
          <span className="text-[12.5px] font-medium text-fg">Title</span>
          <input data-testid="flow-step-title" value={step.title} onChange={(e) => onTitle(e.target.value)} placeholder="Name this step" className={cx(FIELD, 'mt-1.5')} />
        </label>

        <div>
          <span className="text-[12.5px] font-medium text-fg">Kind</span>
          <div role="group" aria-label="Kind" data-testid="flow-step-kind" className="mt-1.5 flex rounded-lg border border-line bg-panel p-[3px]">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                data-testid={`flow-step-kind-${k.kind}`}
                aria-pressed={step.kind === k.kind}
                onClick={() => onKind(k.kind)}
                className={cx(
                  'flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-md text-[12px] transition-colors duration-150',
                  step.kind === k.kind ? 'bg-press text-fg' : 'text-muted hover:text-fg'
                )}
              >
                <KindIcon kind={k.kind} agent={k.kind === 'agent' ? step.agent : null} />
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {step.kind === 'agent' && (
          <>
            <div>
              <label htmlFor="flow-step-agent" className="text-[12.5px] font-medium text-fg">
                Agent
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                {step.agent && <AgentBadge kind={step.agent} size={22} />}
                <select
                  id="flow-step-agent"
                  data-testid="flow-step-agent"
                  value={step.agent ?? ''}
                  onChange={(e) => onAgent(e.target.value as AgentKind)}
                  className={cx(FIELD, 'min-w-0 flex-1')}
                >
                  {step.agent === null && (
                    <option value="" disabled>
                      Pick an agent
                    </option>
                  )}
                  {choices.map((c) => (
                    <option key={c.kind} value={c.kind}>
                      {c.installed ? c.name : `${c.name} (not installed)`}
                    </option>
                  ))}
                </select>
              </div>
              {chosen && !chosen.installed && (
                <p data-testid="flow-step-agent-missing" className="mt-1.5 text-[11.5px] leading-relaxed text-st-waiting">
                  {chosen.name} is not installed on this computer. Install it or pick another agent before you run the flow.
                </p>
              )}
            </div>

            <div>
              <label htmlFor="flow-step-prompt" className="text-[12.5px] font-medium text-fg">
                Prompt
              </label>
              <textarea
                id="flow-step-prompt"
                data-testid="flow-step-prompt"
                value={step.prompt}
                onChange={(e) => onPrompt(e.target.value)}
                rows={6}
                placeholder="What should this agent do?"
                className={cx(FIELD, 'mt-1.5 resize-y leading-relaxed')}
              />
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-faint">
                <Kbd>{'{{brief}}'}</Kbd> becomes the flow's brief. <Kbd>{'{{previous}}'}</Kbd> becomes what the step before this one delivered (its last 60 lines).
              </p>
            </div>
          </>
        )}

        {step.kind === 'check' && (
          <div>
            <label htmlFor="flow-step-command" className="text-[12.5px] font-medium text-fg">
              Command
            </label>
            <input
              id="flow-step-command"
              data-testid="flow-step-command"
              value={step.command}
              onChange={(e) => onCommand(e.target.value)}
              placeholder="npm test"
              spellCheck={false}
              className={cx(FIELD, 'mt-1.5 font-mono')}
            />
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-faint">
              Runs as a shell command in the project folder and passes when it finishes without an error. In an isolated run it runs in a temporary copy of the run's committed work, and a check that changes files in the project or makes a commit fails.
            </p>
          </div>
        )}

        {step.kind === 'approval' && (
          <p data-testid="flow-step-approval-note" className="rounded-lg border border-line bg-panel px-3 py-2.5 text-[12px] leading-relaxed text-muted">
            The run pauses here until you approve it or stop it. Nothing after this step starts before then.
          </p>
        )}

        <div className="border-t border-line pt-4">
          <Button variant="outline" size="sm" className="text-st-failed hover:bg-st-failed/10" data-testid="flow-step-remove" onClick={onRemove}>
            <Trash2 size={13} />
            Remove step
          </Button>
        </div>
      </div>
    </aside>
  )
}
