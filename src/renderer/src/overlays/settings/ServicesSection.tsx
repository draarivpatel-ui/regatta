// Settings > Services: which service CLIs are on this computer and whether each is signed in,
// read by asking each CLI in a way that changes nothing.

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ServiceStatus } from '@shared/types'
import { bridge } from '../../lib/bridge'
import { Button } from '../../components/ui'
import { ServiceRow } from './services/ServiceRow'

/** "18:42" in local time, same style as the Usage section. */
function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function ServicesSection(): React.JSX.Element {
  const [rows, setRows] = useState<ServiceStatus[] | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(true)

  const load = useCallback(() => {
    setBusy(true)
    void bridge
      .invoke('services:check')
      .then((list) => {
        setRows(list)
        setCheckedAt(Date.now())
      })
      .catch(() => setRows((prev) => prev ?? []))
      .finally(() => setBusy(false))
  }, [])

  // The first check runs when the section opens.
  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="max-w-[620px]">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold tracking-[-0.01em]">Services</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            Service CLIs on this computer and whether they are signed in. Regatta only looks; it never signs in for you.
          </p>
        </div>
        <Button variant="subtle" size="sm" data-testid="services-check" onClick={load} disabled={busy}>
          <RefreshCw size={13} className={busy ? 'animate-spin' : undefined} />
          {busy ? 'Checking' : 'Check again'}
        </Button>
      </div>

      {busy && rows === null && (
        <p className="mt-3 text-[12.5px] text-faint" data-testid="services-loading">
          Checking the service CLIs on this computer
        </p>
      )}

      {rows && (
        <div className="mt-3 space-y-1.5" data-testid="services-rows">
          {rows.map((row) => (
            <ServiceRow key={row.id} row={row} />
          ))}
        </div>
      )}

      {checkedAt !== null && (
        <p className="mt-3 text-[11.5px] text-faint" data-testid="services-checked">
          Checked {clock(checkedAt)}
        </p>
      )}
    </div>
  )
}
