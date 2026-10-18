// One configured MCP server row: its command, state badge, tools, masked env, and actions.

import { useEffect, useState } from 'react'
import type { AgentToolAgent, AgentToolServer } from '@shared/agent-tools'
import { AgentBadge } from '../../../components/marks'
import { Button, cx } from '../../../components/ui'
import { Toggle } from '../Toggle'

const AGENT_NAMES: Record<AgentToolAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

function stateBadge(
  server: AgentToolServer,
  changedSinceVerified: boolean
): { label: string; className: string } {
  const isVerified = server.verified !== null && server.verified.fingerprint === server.fingerprint
  if (isVerified && server.enabled) {
    return { label: 'Turned on', className: 'text-st-idle' }
  }
  if (isVerified && server.verified) {
    const count = server.verified.tools.length
    return {
      label: `Verified with ${count} ${count === 1 ? 'tool' : 'tools'}`,
      className: 'text-st-idle'
    }
  }
  if ((server.verified !== null && server.verified.fingerprint !== server.fingerprint) || changedSinceVerified) {
    return { label: 'Changed since verified', className: 'text-st-waiting' }
  }
  return { label: 'Not verified', className: 'text-muted' }
}

export function ServerCard({
  server,
  changedSinceVerified,
  verifying,
  toggling,
  verifyError,
  verifyStderr,
  confirmingRemove,
  onVerify,
  onToggle,
  onEdit,
  onRemove,
  onConfirmRemove,
  onCancelRemove
}: {
  server: AgentToolServer
  changedSinceVerified: boolean
  verifying: boolean
  toggling: boolean
  verifyError: string | null
  verifyStderr: string | null
  confirmingRemove: boolean
  onVerify: () => void
  onToggle: (on: boolean) => void
  onEdit: () => void
  onRemove: () => void
  onConfirmRemove: () => void
  onCancelRemove: () => void
}): React.JSX.Element {
  const [showEnv, setShowEnv] = useState(false)

  useEffect(() => {
    setShowEnv(false)
  }, [server.fingerprint, server.updatedAt])

  const isVerified = server.verified !== null && server.verified.fingerprint === server.fingerprint
  const badge = stateBadge(server, changedSinceVerified)
  const commandLine = [server.command, ...server.args].join(' ')
  const envEntries = Object.entries(server.env)

  return (
    <div data-testid={`agent-tool-${server.id}`} className="rounded-lg border border-line bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-fg">{server.name}</span>
          {server.id !== server.name && (
            <span className="shrink-0 font-mono text-[11px] text-faint">({server.id})</span>
          )}
          <span data-testid={`agent-tool-state-${server.id}`} className={cx('shrink-0 text-[11.5px]', badge.className)}>
            {badge.label}
          </span>
        </div>
        <Toggle
          checked={server.enabled && isVerified}
          onChange={onToggle}
          testId={`agent-tool-toggle-${server.id}`}
          label={`Turn on ${server.name}`}
          disabled={!isVerified || verifying || toggling}
        />
      </div>

      <p className="mt-1 truncate font-mono text-[11.5px] text-muted" title={commandLine}>
        {commandLine}
      </p>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
        <span>Agents:</span>
        {server.agents.length === 0 ? (
          <span className="text-faint">None selected</span>
        ) : (
          server.agents.map((agent) => (
            <span key={agent} className="inline-flex items-center gap-1 text-fg">
              <AgentBadge kind={agent} size={14} />
              <span>{AGENT_NAMES[agent]}</span>
            </span>
          ))
        )}
      </div>

      {envEntries.length > 0 && (
        <div
          data-testid={`agent-tool-env-${server.id}`}
          className="mt-2 flex items-center gap-2 rounded-md border border-line bg-raised px-2 py-1"
        >
          <div className="min-w-0 flex-1 space-y-0.5 font-mono text-[11px] text-muted">
            {envEntries.map(([key, val]) => (
              <div key={key} className="truncate">
                {key}={showEnv ? val : '********'}
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`agent-tool-env-show-${server.id}`}
            onClick={() => setShowEnv((prev) => !prev)}
          >
            {showEnv ? 'Hide' : 'Show'}
          </Button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          variant="subtle"
          size="sm"
          data-testid={`agent-tool-verify-${server.id}`}
          onClick={onVerify}
          disabled={verifying || toggling}
        >
          {verifying ? 'Verifying' : 'Verify'}
        </Button>
        <Button variant="ghost" size="sm" data-testid={`agent-tool-edit-${server.id}`} onClick={onEdit} disabled={verifying}>
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid={`agent-tool-remove-${server.id}`}
          onClick={onRemove}
          disabled={verifying}
        >
          Remove
        </Button>
      </div>

      {confirmingRemove && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-line-strong bg-raised px-2 py-1.5">
          <span className="min-w-0 flex-1 text-[12px] text-muted">Remove {server.name}?</span>
          <Button variant="subtle" size="sm" data-testid={`agent-tool-confirm-remove-${server.id}`} onClick={onConfirmRemove}>
            Remove
          </Button>
          <Button variant="ghost" size="sm" data-testid={`agent-tool-cancel-remove-${server.id}`} onClick={onCancelRemove}>
            Keep
          </Button>
        </div>
      )}

      {verifyError && (
        <div data-testid={`agent-tool-error-${server.id}`} className="mt-2 rounded-md border border-st-failed/30 bg-raised px-2.5 py-2">
          <p className="text-[12px] text-st-failed">{verifyError}</p>
          {verifyStderr && (
            <pre className="mt-1.5 max-h-36 overflow-auto rounded border border-line bg-term p-2 font-mono text-[11px] leading-relaxed text-muted">
              {verifyStderr}
            </pre>
          )}
        </div>
      )}

      {isVerified && server.verified && (
        <div data-testid={`agent-tool-tools-${server.id}`} className="mt-2 rounded-md border border-line bg-raised px-2.5 py-2">
          <p className="text-[11.5px] font-medium text-muted">
            {server.verified.tools.length === 0
              ? 'No tools reported'
              : `${server.verified.tools.length} ${server.verified.tools.length === 1 ? 'tool' : 'tools'}`}
          </p>
          {server.verified.tools.length > 0 && (
            <div className="mt-1.5 space-y-1.5">
              {server.verified.tools.map((tool) => (
                <div key={tool.name} className="text-[12px]">
                  <span className="font-mono font-medium text-fg">{tool.name}</span>
                  {tool.description && <p className="text-[11.5px] leading-relaxed text-muted">{tool.description}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
