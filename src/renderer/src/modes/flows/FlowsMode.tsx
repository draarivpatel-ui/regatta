// Flows mode: build a pipeline of agent, check and approval steps, run it, approve it, then merge or discard
// what it did. The engine is src/main/flows/engine.ts.

import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, Plus, Workflow, X } from 'lucide-react'
import { useFlows } from '../../store/flows'
import { useSessions } from '../../store/sessions'
import { Button, IconButton } from '../../components/ui'
import { ConfirmDialog } from './ConfirmDialog'
import { FlowBrief } from './FlowBrief'
import { FlowHeader } from './FlowHeader'
import { FlowInspector } from './FlowInspector'
import { FlowList } from './FlowList'
import { FlowPipeline } from './FlowPipeline'
import { FlowRuns } from './FlowRuns'
import { defaultAgent, deleteBlocker, isLive, SCROLLBAR, sortFlows } from './logic'

/** What the open confirm dialog is asking. */
type Question = { kind: 'delete' } | { kind: 'recipe'; recipeId: string } | { kind: 'discard'; runId: string }

export function FlowsMode(): React.JSX.Element {
  const loaded = useFlows((s) => s.loaded)
  const flows = useFlows((s) => s.flows)
  const runs = useFlows((s) => s.runs)
  const selectedFlowId = useFlows((s) => s.selectedFlowId)
  const selectedStepId = useFlows((s) => s.selectedStepId)
  const saveStates = useFlows((s) => s.saveStates)
  const saveErrors = useFlows((s) => s.saveErrors)
  const notices = useFlows((s) => s.notices)
  const starting = useFlows((s) => s.starting)
  const runErrors = useFlows((s) => s.runErrors)
  const busyRuns = useFlows((s) => s.busyRuns)
  const acting = useFlows((s) => s.acting)
  const isolatedSeen = useFlows((s) => s.isolatedSeen)
  const detected = useSessions((s) => s.agents)

  const briefRef = useRef<HTMLTextAreaElement>(null)
  const [question, setQuestion] = useState<Question | null>(null)

  useEffect(() => {
    void useFlows.getState().load()
  }, [])

  const sorted = useMemo(() => sortFlows(flows), [flows])
  const flow = flows.find((f) => f.id === selectedFlowId) ?? null
  const flowRuns = useMemo(() => runs.filter((r) => r.flowId === selectedFlowId), [runs, selectedFlowId])
  const latest = flowRuns[0] ?? null
  const step = flow?.steps.find((s) => s.id === selectedStepId) ?? null
  const notice = flow ? notices[flow.id] : undefined
  const running = flowRuns.some(isLive)
  const act = useFlows.getState

  const close = (): void => setQuestion(null)

  const newFlow = (): void => {
    act().newFlow()
  }

  const applyRecipe = (recipeId: string): void => {
    act().applyRecipe(recipeId)
    // Recipe steps wait for a brief, so the cursor goes there when there is none yet.
    if (flow && flow.brief.trim().length === 0) briefRef.current?.focus()
  }

  const dialog = (): React.JSX.Element | null => {
    if (!question || !flow) return null
    if (question.kind === 'delete') {
      const blocker = deleteBlocker(flowRuns)
      if (blocker) return <ConfirmDialog testId="flow-delete-dialog" title="This flow cannot be deleted yet" body={blocker} onCancel={close} />
      return (
        <ConfirmDialog
          testId="flow-delete-dialog"
          title="Delete this flow?"
          body={`"${flow.name}" and its steps will be removed. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onCancel={close}
          onConfirm={() => {
            close()
            void act().deleteFlow(flow.id)
          }}
        />
      )
    }
    if (question.kind === 'recipe') {
      return (
        <ConfirmDialog
          testId="flow-recipe-dialog"
          title="Replace the steps with this recipe?"
          body="This flow has steps already. The recipe's steps take their place."
          confirmLabel="Replace steps"
          onCancel={close}
          onConfirm={() => {
            close()
            applyRecipe(question.recipeId)
          }}
        />
      )
    }
    return (
      <ConfirmDialog
        testId="flow-discard-dialog"
        title="Discard this run?"
        body="Its worktree is removed only when nothing in it is unsaved; a copy of its commits stays in the repository."
        confirmLabel="Discard"
        danger
        onCancel={close}
        onConfirm={() => {
          close()
          void act().discardRun(question.runId)
        }}
      />
    )
  }

  return (
    <div data-testid="flows-mode" className="flex h-full min-h-0 flex-1 overflow-hidden">
      <FlowList loaded={loaded} flows={sorted} runs={runs} selectedId={selectedFlowId} onSelect={(id) => act().selectFlow(id)} onNew={newFlow} />
      <section className="flex h-full min-w-0 flex-1 flex-col bg-bg">
        {!flow ? (
          // Nothing is drawn until the first list has come back, so a saved flow never flashes the empty state.
          <div data-testid="flows-empty" className={`flex flex-1 items-center justify-center px-8${loaded ? '' : ' invisible'}`}>
            <div className="max-w-[380px] text-center">
              <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] border border-line bg-panel text-accent">
                <Workflow size={18} />
              </span>
              <h2 className="mt-4 text-[16px] font-semibold tracking-[-0.01em] text-fg">Build your first flow</h2>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
                A flow chains agents, checks and approvals into one run and keeps what each step delivered. Start from a recipe or add the steps yourself.
              </p>
              <Button variant="accent" className="mt-4" data-testid="flow-new-empty" onClick={newFlow}>
                <Plus size={13} strokeWidth={2.4} />
                New flow
              </Button>
            </div>
          </div>
        ) : (
          <>
            <FlowHeader
              flow={flow}
              saveState={saveStates[flow.id]}
              saveError={saveErrors[flow.id]}
              onRename={(name) => act().renameFlow(name)}
              onDelete={() => setQuestion({ kind: 'delete' })}
              onRun={() => void act().runFlow(flow.id)}
              runDisabled={flow.steps.length === 0 || running || starting[flow.id] === true}
            />
            {notice && (
              <div
                data-testid="flow-notice"
                role="alert"
                className="flex shrink-0 items-start gap-2 border-b border-line bg-st-failed/[0.06] px-6 py-2 text-[12px] leading-relaxed text-st-failed"
              >
                <CircleAlert size={13} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1 select-text">{notice}</span>
                <IconButton aria-label="Dismiss" title="Dismiss" className="-my-1 h-6 w-6" onClick={() => act().dismissNotice(flow.id)}>
                  <X size={12} />
                </IconButton>
              </div>
            )}
            {/*
              Wide (the studio is at least 860 px): the brief, pipeline and runs scroll in one column and the
              inspector is a column of its own. Narrower: one column scrolls, with the inspector right under the pipeline.
              (The container cannot restyle itself, so this outer box always scrolls; in the wide layout nothing overflows it.)
            */}
            <div className="@container min-h-0 flex-1 overflow-y-auto" style={SCROLLBAR}>
              <div className="flex min-h-full flex-col @[860px]:h-full @[860px]:flex-row">
                <div className="contents @[860px]:flex @[860px]:min-h-0 @[860px]:min-w-0 @[860px]:flex-1 @[860px]:flex-col @[860px]:overflow-y-auto" style={SCROLLBAR}>
                  <div className="order-1">
                    <FlowBrief
                      flow={flow}
                      briefRef={briefRef}
                      onBrief={(brief) => act().setBrief(brief)}
                      onRecipe={(recipeId) => (flow.steps.length > 0 ? setQuestion({ kind: 'recipe', recipeId }) : applyRecipe(recipeId))}
                      onIsolate={(isolate) => act().setIsolate(isolate)}
                    />
                  </div>
                  <div className="order-2">
                    <FlowPipeline
                      flow={flow}
                      run={latest}
                      selectedStepId={selectedStepId}
                      acting={acting}
                      detected={detected}
                      onSelectStep={(id) => act().selectStep(id)}
                      onAddStep={(afterId) => act().addStep(afterId, 'agent', defaultAgent(detected))}
                      onApprove={(runId) => void act().approveRun(runId)}
                      onStop={(runId) => void act().stopRun(runId)}
                    />
                  </div>
                  <div className="order-4">
                    <FlowRuns
                      flow={flow}
                      runs={flowRuns}
                      isolatedSeen={isolatedSeen}
                      runErrors={runErrors}
                      busyRuns={busyRuns}
                      acting={acting}
                      onApprove={(runId) => void act().approveRun(runId)}
                      onStop={(runId) => void act().stopRun(runId)}
                      onMerge={(runId) => void act().mergeRun(runId)}
                      onDiscard={(runId) => setQuestion({ kind: 'discard', runId })}
                      onDismissError={(runId) => act().dismissRunError(runId)}
                    />
                  </div>
                </div>
                <div
                  className="order-3 max-h-[380px] shrink-0 overflow-y-auto border-b border-line bg-chrome @[860px]:order-none @[860px]:max-h-none @[860px]:w-[320px] @[860px]:border-b-0 @[860px]:border-l"
                  style={SCROLLBAR}
                >
                  <FlowInspector
                    flow={flow}
                    step={step}
                    detected={detected}
                    onTitle={(title) => step && act().updateStep(step.id, { title })}
                    onKind={(kind) => step && act().setStepKind(step.id, kind, defaultAgent(detected))}
                    onAgent={(agent) => step && act().updateStep(step.id, { agent })}
                    onPrompt={(prompt) => step && act().updateStep(step.id, { prompt })}
                    onCommand={(command) => step && act().updateStep(step.id, { command })}
                    onMove={(direction) => step && act().moveStep(step.id, direction)}
                    onRemove={() => step && act().removeStep(step.id)}
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </section>
      {dialog()}
    </div>
  )
}
