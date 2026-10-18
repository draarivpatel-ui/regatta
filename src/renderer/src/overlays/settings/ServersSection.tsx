// Settings > Servers: saved SSH servers, host key checks and connection tests.

import { useCallback, useEffect, useState } from 'react'
import type { HostKeyScan, SshServer } from '@shared/types'
import { bridge } from '../../lib/bridge'
import { Button } from '../../components/ui'
import { SectionTitle } from './common'
import { ServerCard } from './servers/ServerCard'
import { ServerForm, type ServerFormValues } from './servers/ServerForm'

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const EMPTY_FORM: ServerFormValues = { name: '', host: '', user: '', port: '' }

export function ServersSection(): React.JSX.Element {
  const [servers, setServers] = useState<SshServer[]>([])
  const [hosts, setHosts] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<SshServer | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [scans, setScans] = useState<Record<string, HostKeyScan>>({})
  const [scanErrors, setScanErrors] = useState<Record<string, string>>({})
  const [scanning, setScanning] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const [trustBusy, setTrustBusy] = useState<Record<string, string | null>>({})

  const load = useCallback(() => {
    setLoaded(false)
    setLoadError(null)
    void Promise.all([bridge.invoke('servers:list'), bridge.invoke('servers:configHosts')])
      .then(([list, configHosts]) => {
        setServers(list)
        setHosts(configHosts)
        setLoaded(true)
      })
      .catch((err) => {
        setLoadError(cleanError(err))
        setLoaded(true)
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openAdd = (): void => {
    setEditing(null)
    setFormError(null)
    setShowForm(true)
  }

  const openEdit = (server: SshServer): void => {
    setEditing(server)
    setFormError(null)
    setShowForm(true)
  }

  const saveForm = (values: ServerFormValues): void => {
    const name = values.name.trim()
    const host = values.host.trim()
    const user = values.user.trim() === '' ? null : values.user.trim()
    const portText = values.port.trim()
    const port = portText === '' ? null : Number(portText)
    setSaving(true)
    setFormError(null)
    void bridge
      .invoke('servers:save', { id: editing?.id, name, host, user, port })
      .then((next) => {
        setServers(next)
        setShowForm(false)
        setEditing(null)
      })
      .catch((err) => {
        setFormError(cleanError(err))
      })
      .finally(() => setSaving(false))
  }

  const removeServer = (id: string): void => {
    void bridge
      .invoke('servers:remove', id)
      .then((next) => {
        setServers(next)
        setConfirmingRemove(null)
        setScans((prev) => {
          const copy = { ...prev }
          delete copy[id]
          return copy
        })
        setScanErrors((prev) => {
          const copy = { ...prev }
          delete copy[id]
          return copy
        })
      })
      .catch((err) => {
        setScanErrors((prev) => ({ ...prev, [id]: cleanError(err) }))
      })
  }

  const scanServer = (id: string): void => {
    setScanning((prev) => ({ ...prev, [id]: true }))
    setScanErrors((prev) => {
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    void bridge
      .invoke('servers:scan', id)
      .then((result) => {
        setScans((prev) => ({ ...prev, [id]: result }))
      })
      .catch((err) => {
        setScanErrors((prev) => ({ ...prev, [id]: cleanError(err) }))
      })
      .finally(() => {
        setScanning((prev) => ({ ...prev, [id]: false }))
      })
  }

  const testServer = (id: string): void => {
    setTesting((prev) => ({ ...prev, [id]: true }))
    setScanErrors((prev) => {
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    void bridge
      .invoke('servers:test', id)
      .then((next) => {
        setServers(next)
      })
      .catch((err) => {
        setScanErrors((prev) => ({ ...prev, [id]: cleanError(err) }))
      })
      .finally(() => {
        setTesting((prev) => ({ ...prev, [id]: false }))
      })
  }

  const trustKey = (id: string, fingerprint: string): void => {
    setTrustBusy((prev) => ({ ...prev, [id]: fingerprint }))
    void bridge
      .invoke('servers:trust', id, fingerprint)
      .then((next) => {
        setServers(next)
        setScans((prev) => {
          const current = prev[id]
          if (!current) return prev
          return { ...prev, [id]: { ...current, saved: 'match' as const } }
        })
        setScanErrors((prev) => {
          const copy = { ...prev }
          delete copy[id]
          return copy
        })
      })
      .catch((err) => {
        setScanErrors((prev) => ({ ...prev, [id]: cleanError(err) }))
      })
      .finally(() => {
        setTrustBusy((prev) => ({ ...prev, [id]: null }))
      })
  }

  const formInitial: ServerFormValues = editing
    ? {
        name: editing.name,
        host: editing.host,
        user: editing.user ?? '',
        port: editing.port != null ? String(editing.port) : ''
      }
    : EMPTY_FORM

  return (
    <div className="max-w-[620px]">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <SectionTitle>Servers</SectionTitle>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            Servers you reach over SSH. Regatta checks host keys and tests connections; it does not run agents there
            yet.
          </p>
        </div>
        <Button variant="subtle" size="sm" data-testid="servers-add" onClick={openAdd}>
          Add a server
        </Button>
      </div>

      {!loaded && <p className="mt-3 text-[12.5px] text-muted">Loading servers.</p>}
      {loadError && <p className="mt-3 text-[12px] text-st-failed">{loadError}</p>}

      {showForm && (
        <ServerForm
          key={editing?.id ?? 'new'}
          initial={formInitial}
          hosts={hosts}
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

      <div className="mt-3 space-y-1.5" data-testid="servers-list">
        {servers.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            scan={scans[server.id]}
            scanError={scanErrors[server.id] ?? null}
            scanning={scanning[server.id] ?? false}
            testing={testing[server.id] ?? false}
            confirmingRemove={confirmingRemove === server.id}
            trustBusy={trustBusy[server.id] ?? null}
            onScan={() => scanServer(server.id)}
            onTest={() => testServer(server.id)}
            onEdit={() => openEdit(server)}
            onRemove={() => setConfirmingRemove(server.id)}
            onConfirmRemove={() => removeServer(server.id)}
            onCancelRemove={() => setConfirmingRemove(null)}
            onTrust={(fingerprint) => trustKey(server.id, fingerprint)}
          />
        ))}
      </div>

      {loaded && servers.length === 0 && !showForm && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted">No servers yet. Add the first one to check its key.</p>
      )}
    </div>
  )
}
