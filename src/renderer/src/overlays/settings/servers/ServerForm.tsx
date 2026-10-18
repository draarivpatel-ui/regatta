// Form for adding or editing an SSH server.

import { useState } from 'react'
import { Button } from '../../../components/ui'

export interface ServerFormValues {
  name: string
  host: string
  user: string
  port: string
}

export function ServerForm({
  initial,
  hosts,
  saving,
  error,
  onSave,
  onCancel
}: {
  initial: ServerFormValues
  hosts: string[]
  saving: boolean
  error: string | null
  onSave: (values: ServerFormValues) => void
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState(initial.name)
  const [host, setHost] = useState(initial.host)
  const [user, setUser] = useState(initial.user)
  const [port, setPort] = useState(initial.port)

  return (
    <form
      data-testid="servers-form"
      className="mt-3 rounded-lg border border-line bg-panel px-3 py-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSave({ name, host, user, port })
      }}
    >
      <div className="grid grid-cols-2 gap-2.5">
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <span className="text-[12px] text-muted">Name</span>
          <input
            data-testid="servers-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Build box"
            maxLength={60}
            className="h-8 rounded-md border border-line-strong bg-raised px-2 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent"
          />
        </label>
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <span className="text-[12px] text-muted">Host</span>
          <input
            data-testid="servers-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="build.example.com"
            list="servers-host-suggestions"
            className="h-8 rounded-md border border-line-strong bg-raised px-2 font-mono text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent"
          />
          <datalist id="servers-host-suggestions">
            {hosts.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-muted">User (optional)</span>
          <input
            data-testid="servers-user"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="deploy"
            className="h-8 rounded-md border border-line-strong bg-raised px-2 font-mono text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-muted">Port (optional)</span>
          <input
            data-testid="servers-port"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="22"
            inputMode="numeric"
            className="h-8 rounded-md border border-line-strong bg-raised px-2 font-mono text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent"
          />
        </label>
      </div>
      {error && (
        <p data-testid="servers-form-error" className="mt-2 text-[12px] text-st-failed">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" data-testid="servers-cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="accent" size="sm" data-testid="servers-save" type="submit" disabled={saving}>
          {saving ? 'Saving' : 'Save'}
        </Button>
      </div>
    </form>
  )
}
