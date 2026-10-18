// Settings > Agent tools: give Claude Code and Codex tools from an MCP server the user trusts.

import { useCallback, useEffect, useState } from 'react'
import { AGENT_TOOL_AGENTS, type AgentToolDraft, type AgentToolServer } from '@shared/agent-tools'
import { bridge } from '../../lib/bridge'
import { Button } from '../../components/ui'
import { SectionTitle } from './common'
import { ServerCard } from './agent-tools/ServerCard'
import { ServerForm, type ServerFormValues } from './agent-tools/ServerForm'

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const EMPTY_FORM: ServerFormValues = {
  name: '',
  command: '',
  argsText: '',
  envText: '',
  agents: [...AGENT_TOOL_AGENTS]
}

// Tracks servers that were verified in this session so editing their command, args or env shows "Changed since verified".
const verifiedHistory = new Set<string>()

export function AgentToolsSection(): React.JSX.Element {
  const [servers, setServers] = useState<AgentToolServer[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<AgentToolServer | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState<Record<string, boolean>>({})
  const [toggling, setToggling] = useState<Record<string, boolean>>({})
  const [verifyErrors, setVerifyErrors] = useState<Record<string, string>>({})
  const [verifyStderrs, setVerifyStderrs] = useState<Record<string, string>>({})
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const [changedIds, setChangedIds] = useState<Record<string, boolean>>({})

  const syncList = useCallback((next: AgentToolServer[]) => {
    const updates: Record<string, boolean> = {}
    for (const s of next) {
      if (s.verified && s.verified.fingerprint === s.fingerprint) {
        verifiedHistory.add(s.id)
        updates[s.id] = false
      } else if (verifiedHistory.has(s.id)) {
        updates[s.id] = true
      }
    }
    setChangedIds((prev) => ({ ...prev, ...updates }))
    setServers(next)
  }, [])

  useEffect(() => {
    void bridge
      .invoke('agentTools:list')
      .then((list) => {
        syncList(list)
        setLoaded(true)
      })
      .catch((err) => {
        setLoadError(cleanError(err))
        setLoaded(true)
      })
    return bridge.on('agentTools:changed', syncList)
  }, [syncList])

  const openAdd = (): void => {
    setEditing(null)
    setFormError(null)
    setShowForm(true)
  }

  const openEdit = (server: AgentToolServer): void => {
    setEditing(server)
    setFormError(null)
    setShowForm(true)
  }

  const saveForm = (draft: AgentToolDraft): void => {
    const wasVerified = editing !== null && (editing.verified !== null || verifiedHistory.has(editing.id))
    const prevId = editing?.id ?? null
    setSaving(true)
    setFormError(null)
    void bridge
      .invoke('agentTools:save', draft)
      .then((next) => {
        if (wasVerified && prevId) {
          const updated = next.find((s) => s.id === prevId)
          if (updated && !updated.verified) {
            verifiedHistory.add(prevId)
            setChangedIds((prev) => ({ ...prev, [prevId]: true }))
          }
        }
        syncList(next)
        setShowForm(false)
        setEditing(null)
      })
      .catch((err) => {
        setFormError(cleanError(err))
      })
      .finally(() => setSaving(false))
  }

  const verifyServer = (id: string): void => {
    setVerifying((prev) => ({ ...prev, [id]: true }))
    setVerifyErrors((prev) => {
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    setVerifyStderrs((prev) => {
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    void bridge
      .invoke('agentTools:verify', id)
      .then((res) => {
        if (res.ok) {
          verifiedHistory.add(id)
          setChangedIds((prev) => ({ ...prev, [id]: false }))
          setServers((prev) => prev.map((s) => (s.id === id ? res.server : s)))
        } else {
          if (res.server) {
            const updated = res.server
            setServers((prev) => prev.map((s) => (s.id === id ? updated : s)))
          }
          setVerifyErrors((prev) => ({ ...prev, [id]: res.error }))
          if (res.stderr) setVerifyStderrs((prev) => ({ ...prev, [id]: res.stderr }))
        }
      })
      .catch((err) => {
        setVerifyErrors((prev) => ({ ...prev, [id]: cleanError(err) }))
      })
      .finally(() => {
        setVerifying((prev) => ({ ...prev, [id]: false }))
      })
  }

  const toggleServer = (id: string, on: boolean): void => {
    setToggling((prev) => ({ ...prev, [id]: true }))
    setVerifyErrors((prev) => {
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    void bridge
      .invoke('agentTools:setEnabled', id, on)
      .then((next) => {
        syncList(next)
      })
      .catch((err) => {
        setVerifyErrors((prev) => ({ ...prev, [id]: cleanError(err) }))
      })
      .finally(() => {
        setToggling((prev) => ({ ...prev, [id]: false }))
      })
  }

  const removeServer = (id: string): void => {
    void bridge
      .invoke('agentTools:remove', id)
      .then((next) => {
        verifiedHistory.delete(id)
        setChangedIds((prev) => {
          const copy = { ...prev }
          delete copy[id]
          return copy
        })
        setConfirmingRemove(null)
        setServers(next)
      })
      .catch((err) => {
        setVerifyErrors((prev) => ({ ...prev, [id]: cleanError(err) }))
      })
  }

  const formInitial: ServerFormValues = editing
    ? {
        name: editing.name,
        command: editing.command,
        argsText: editing.args.join('\n'),
        envText: Object.entries(editing.env)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n'),
        agents: editing.agents
      }
    : EMPTY_FORM

  return (
    <div className="max-w-[620px]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <SectionTitle>Agent tools</SectionTitle>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            Give your agents extra tools from an MCP server you trust. Regatta runs the command only when you press
            Verify, and shows its tools before you turn it on.
          </p>
          <p className="mt-1 text-[11.5px] text-faint">
            Turned-on servers are given to Claude Code and Codex in panes, Chat and headless runs.
          </p>
        </div>
        <Button variant="subtle" size="sm" data-testid="agent-tools-add" onClick={openAdd}>
          Add server
        </Button>
      </div>

      {!loaded && <p className="mt-3 text-[12.5px] text-muted">Loading servers.</p>}
      {loadError && <p className="mt-3 text-[12px] text-st-failed">{loadError}</p>}

      {showForm && (
        <ServerForm
          key={editing?.id ?? 'new'}
          initial={formInitial}
          editingId={editing?.id ?? null}
          saving={saving}
          error={formError}
          onSave={saveForm}
          onCancel={() => {
            setShowForm(false)
            setEditing(null)
            setFormError(null)
          }}
        />
      )}

      <div className="mt-3 space-y-2" data-testid="agent-tools-list">
        {servers.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            changedSinceVerified={Boolean(changedIds[server.id])}
            verifying={Boolean(verifying[server.id])}
            toggling={Boolean(toggling[server.id])}
            verifyError={verifyErrors[server.id] ?? null}
            verifyStderr={verifyStderrs[server.id] ?? null}
            confirmingRemove={confirmingRemove === server.id}
            onVerify={() => verifyServer(server.id)}
            onToggle={(on) => toggleServer(server.id, on)}
            onEdit={() => openEdit(server)}
            onRemove={() => setConfirmingRemove(server.id)}
            onConfirmRemove={() => removeServer(server.id)}
            onCancelRemove={() => setConfirmingRemove(null)}
          />
        ))}
      </div>

      {loaded && servers.length === 0 && !showForm && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
          No MCP servers added yet. Add a server to verify its tools.
        </p>
      )}
    </div>
  )
}
