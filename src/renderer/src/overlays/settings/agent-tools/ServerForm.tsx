// Form for adding or editing an MCP server for agents.

import { useState } from 'react'
import { AGENT_TOOL_AGENTS, type AgentToolAgent, type AgentToolDraft } from '@shared/agent-tools'
import { AgentBadge } from '../../../components/marks'
import { Button } from '../../../components/ui'

export interface ServerFormValues {
  name: string
  command: string
  argsText: string
  envText: string
  agents: AgentToolAgent[]
}

const AGENT_LABELS: Record<AgentToolAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

function parseEnvText(text: string): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {}
  const lines = text.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq <= 0) {
      return { env: {}, error: `Environment line "${line}" must be in NAME=value format.` }
    }
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { env: {}, error: `Invalid environment variable name "${key}".` }
    }
    env[key] = value
  }
  return { env, error: null }
}

function parseArgsText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0)
}

export function ServerForm({
  initial,
  editingId,
  saving,
  error,
  onSave,
  onCancel
}: {
  initial: ServerFormValues
  editingId: string | null
  saving: boolean
  error: string | null
  onSave: (draft: AgentToolDraft) => void
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState(initial.name)
  const [command, setCommand] = useState(initial.command)
  const [argsText, setArgsText] = useState(initial.argsText)
  const [envText, setEnvText] = useState(initial.envText)
  const [agents, setAgents] = useState<AgentToolAgent[]>(initial.agents)
  const [localError, setLocalError] = useState<string | null>(null)

  const toggleAgent = (agent: AgentToolAgent): void => {
    setAgents((prev) =>
      prev.includes(agent) ? prev.filter((a) => a !== agent) : AGENT_TOOL_AGENTS.filter((a) => a === agent || prev.includes(a))
    )
  }

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    setLocalError(null)
    const parsedEnv = parseEnvText(envText)
    if (parsedEnv.error) {
      setLocalError(parsedEnv.error)
      return
    }
    const draft: AgentToolDraft = {
      ...(editingId ? { id: editingId } : {}),
      name: name.trim(),
      command: command.trim(),
      args: parseArgsText(argsText),
      env: parsedEnv.env,
      agents
    }
    onSave(draft)
  }

  const displayError = localError ?? error

  return (
    <form
      data-testid="agent-tools-form"
      className="mt-3 rounded-lg border border-line bg-panel px-3 py-3"
      onSubmit={handleSubmit}
    >
      <div className="grid grid-cols-2 gap-2.5">
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <span className="text-[12px] text-muted">Name</span>
          <input
            data-testid="agent-tools-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="notes-mcp"
            maxLength={40}
            className="h-8 rounded-md border border-line-strong bg-raised px-2 font-mono text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent"
          />
        </label>
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <span className="text-[12px] text-muted">Command</span>
          <input
            data-testid="agent-tools-command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="node"
            className="h-8 rounded-md border border-line-strong bg-raised px-2 font-mono text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent"
          />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-[12px] text-muted">Arguments (one per line)</span>
          <textarea
            data-testid="agent-tools-args"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            rows={3}
            placeholder="/path/to/server.mjs"
            className="rounded-md border border-line-strong bg-raised px-2 py-1.5 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent"
          />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-[12px] text-muted">Environment (one NAME=value per line)</span>
          <textarea
            data-testid="agent-tools-env"
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            rows={2}
            placeholder="API_KEY=secret"
            className="rounded-md border border-line-strong bg-raised px-2 py-1.5 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent"
          />
        </label>
      </div>

      <div className="mt-2.5">
        <span className="text-[12px] text-muted">Agents that get this server</span>
        <div className="mt-1.5 flex items-center gap-4">
          {AGENT_TOOL_AGENTS.map((agent) => (
            <label key={agent} className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-fg">
              <input
                type="checkbox"
                data-testid={`agent-tools-agent-${agent}`}
                checked={agents.includes(agent)}
                onChange={() => toggleAgent(agent)}
                className="h-3.5 w-3.5 accent-accent"
              />
              <AgentBadge kind={agent} size={16} />
              <span>{AGENT_LABELS[agent]}</span>
            </label>
          ))}
        </div>
      </div>

      {displayError && (
        <p data-testid="agent-tools-form-error" className="mt-2 text-[12px] text-st-failed">
          {displayError}
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" data-testid="agent-tools-cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="accent" size="sm" data-testid="agent-tools-save" type="submit" disabled={saving}>
          {saving ? 'Saving' : 'Save'}
        </Button>
      </div>
    </form>
  )
}
