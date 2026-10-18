// Composer for Chat mode: textarea, agent, model and mode pickers, token
// estimate, and a Send button that becomes Stop while a turn runs.

import { useEffect, useState, type KeyboardEvent } from 'react'
import type { BudgetState } from '@shared/budgets'
import type { Access, ChatAgent, Conversation, Reasoning } from '@shared/chat'
import { AGENTS } from '@shared/agents'
import { REASONING_LABEL, REASONING_LEVELS } from '@shared/chat'
import { Send, Square, ChevronDown, Check, Brain } from 'lucide-react'
import { Button, IconButton, Popover, MenuItem, cx } from '../../components/ui'
import { useAccounts } from '../../store/accounts'
import { bridge } from '../../lib/bridge'

const CLAUDE_MODELS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]

function modelOptions(agent: ChatAgent): { value: string; label: string }[] {
  if (agent === 'claude') return CLAUDE_MODELS
  return [{ value: '', label: 'Default' }]
}

function modelLabel(agent: ChatAgent, model: string): string {
  const found = modelOptions(agent).find((o) => o.value === model)
  if (found) return found.label
  return model || 'Default'
}

function reasoningOptions(agent: ChatAgent): { value: Reasoning; label: string }[] {
  const levels = REASONING_LEVELS[agent]
  // "effort" in every label, so the closed picker never reads as a second "Default" beside the model.
  return levels.map((level) => ({ value: level, label: `${REASONING_LABEL[level]} effort` }))
}

function showReasoningPicker(agent: ChatAgent): boolean {
  return REASONING_LEVELS[agent].length > 1
}

export function ChatComposer({
  conversation,
  availableAgents,
  draftAgent,
  draftModel,
  draftAccess,
  onDraftChange,
  onSend,
  onStop,
  onUpdate
}: {
  conversation: Conversation | null
  availableAgents: ChatAgent[]
  draftAgent: ChatAgent
  draftModel: string
  draftAccess: Access
  onDraftChange: (patch: { agent?: ChatAgent; model?: string; access?: Access }) => void
  onSend: (text: string) => Promise<void>
  onStop: () => void
  onUpdate: (patch: {
    title?: string
    model?: string
    agent?: Conversation['agent']
    access?: Access
    account?: string | null
    reasoning?: Reasoning
  }) => Promise<void>
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [budgetStates, setBudgetStates] = useState<BudgetState[]>([])
  const { accounts } = useAccounts()

  const currentAgent = conversation?.agent ?? draftAgent
  const currentModel = conversation?.model ?? draftModel
  const currentAccess = conversation?.access ?? draftAccess
  const currentAccount = conversation?.account ?? null
  const isRunning = conversation?.status === 'running'

  const cliAccounts = accounts.filter((a) => a.cli === currentAgent)
  const defaultAccount = cliAccounts.find((a) => a.isDefault)
  const activeAccount = cliAccounts.find((a) => a.id === currentAccount) ?? defaultAccount

  useEffect(() => {
    let alive = true
    void bridge
      .invoke('budgets:states')
      .then((next) => {
        if (alive) setBudgetStates(next)
      })
      .catch(() => undefined)
    const off = bridge.on('budgets:changed', (next) => {
      if (alive) setBudgetStates(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [currentAgent])

  useEffect(() => {
    if (!isRunning) setSending(false)
  }, [isRunning])

  const handleSend = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || isRunning || sending) return
    setSending(true)
    setText('')
    try {
      await onSend(trimmed)
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const pickAgent = (agent: ChatAgent): void => {
    if (conversation) void onUpdate({ agent })
    else onDraftChange({ agent, model: '' })
  }

  const pickModel = (model: string): void => {
    if (conversation) void onUpdate({ model })
    else onDraftChange({ model })
  }

  const pickAccess = (access: Access): void => {
    if (conversation) void onUpdate({ access })
    else onDraftChange({ access })
  }

  const pickAccount = (accountId: string | null): void => {
    if (conversation) void onUpdate({ account: accountId })
  }

  const overBudget = budgetStates.some((s) => s.agent === currentAgent && s.level === 'over')
  const tokenEstimate = Math.floor(text.length / 4)
  const selectClass =
    'h-7 max-w-[150px] truncate rounded-md border border-transparent bg-transparent px-1.5 text-[12px] text-muted outline-none transition-colors duration-150 hover:border-line-strong hover:text-fg focus:border-accent/60'

  return (
    <div className="shrink-0 border-t border-line bg-chrome/50 p-4">
      {overBudget && (
        <p data-testid="chat-budget-warning" className="mb-2 text-[12px] text-st-waiting">
          Past today&apos;s budget for {AGENTS[currentAgent]?.name ?? currentAgent}. Turns still run.
        </p>
      )}
      <div className="rounded-xl border border-line-strong bg-panel p-2.5 shadow-sm transition-colors focus-within:border-accent/60">
        <textarea
          data-testid="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask anything, or describe what to change"
          rows={2}
          className="w-full resize-none bg-transparent text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-faint"
        />
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-line/60 pt-2">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <select
              data-testid="chat-agent"
              aria-label="Agent"
              value={currentAgent}
              onChange={(e) => pickAgent(e.target.value as ChatAgent)}
              className={selectClass}
            >
              {availableAgents.map((kind) => (
                <option key={kind} value={kind}>
                  {AGENTS[kind]?.name ?? kind}
                </option>
              ))}
            </select>
            {(currentAgent === 'claude' || currentAgent === 'codex') && cliAccounts.length > 0 && (
              <Popover
                align="start"
                width={200}
                button={({ toggle, open }: { toggle: () => void; open: boolean }) => (
                  <button
                    type="button"
                    onClick={toggle}
                    data-testid="chat-account"
                    className={cx(
                      'inline-flex items-center gap-1.5 h-7 max-w-[150px] truncate rounded-md px-1.5 text-[12px] font-medium',
                      'bg-panel/60 border border-line hover:bg-hover transition-colors duration-150',
                      open && 'border-accent/60 bg-hover'
                    )}
                    title="Switch account"
                  >
                    <span className="truncate">{activeAccount?.name ?? 'Account'}</span>
                    <ChevronDown size={11} className={open ? 'rotate-180' : ''} />
                  </button>
                )}
              >
                {(close: () => void) => (
                  <div>
                    {cliAccounts.map((acc) => (
                      <MenuItem
                        key={acc.id}
                        label={acc.name}
                        hint={acc.isDefault ? 'Default' : acc.id === currentAccount && !acc.isDefault ? 'current' : undefined}
                        icon={acc.isDefault ? <Check size={12} className="text-accent" /> : undefined}
                        onClick={() => { pickAccount(acc.id); close(); }}
                      />
                    ))}
                    <MenuItem
                      label="Default (computer sign-in)"
                      hint={!currentAccount ? 'Default' : undefined}
                      icon={!currentAccount ? <Check size={12} className="text-accent" /> : undefined}
                      onClick={() => { pickAccount(null); close(); }}
                    />
                  </div>
                )}
              </Popover>
            )}
            <select
              data-testid="chat-model"
              aria-label="Model"
              value={modelOptions(currentAgent).some((o) => o.value === currentModel) ? currentModel : ''}
              onChange={(e) => pickModel(e.target.value)}
              title={modelLabel(currentAgent, currentModel)}
              className={selectClass}
            >
              {modelOptions(currentAgent).map((o) => (
                <option key={o.label} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {showReasoningPicker(currentAgent) && (
              <select
                data-testid="chat-reasoning"
                aria-label="Reasoning"
                value={reasoningOptions(currentAgent).some((o) => o.value === (conversation?.reasoning ?? '')) ? (conversation?.reasoning ?? '') : ''}
                onChange={(e) => {
                  if (conversation) void onUpdate({ reasoning: e.target.value as Reasoning })
                }}
                className={selectClass}
              >
                {reasoningOptions(currentAgent).map((o) => (
                  <option key={o.label} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            <select
              data-testid="chat-mode-picker"
              aria-label="Mode"
              value={currentAccess}
              onChange={(e) => pickAccess(e.target.value as Access)}
              className={selectClass}
            >
              <option value="read">Ask first</option>
              <option value="write">Edit directly</option>
            </select>
            <span className="ml-1 hidden shrink-0 text-[11px] text-faint sm:inline">
              ~{tokenEstimate} tokens
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] text-faint sm:hidden">~{tokenEstimate} tokens</span>
            {isRunning ? (
              <Button
                variant="subtle"
                size="sm"
                data-testid="chat-send"
                onClick={onStop}
                className="gap-1 text-st-waiting"
              >
                <Square size={11} fill="currentColor" />
                Stop
              </Button>
            ) : (
              <IconButton
                variant="accent"
                size="sm"
                data-testid="chat-send"
                onClick={() => void handleSend()}
                disabled={!text.trim()}
                title="Send"
                aria-label="Send"
              >
                <Send size={13} />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
