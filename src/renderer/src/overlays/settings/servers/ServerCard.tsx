// One saved server: its target, key state, test result and actions.

import { useState } from 'react'
import { Copy } from 'lucide-react'
import type { HostKeyScan, SshServer } from '@shared/types'
import { Button, cx } from '../../../components/ui'
import { ago } from '../../../lib/format'
import { useNow } from '../../../lib/useNow'

export function displayTarget(server: SshServer): string {
  const base = server.port != null ? `${server.host}:${server.port}` : server.host
  return server.user ? `${server.user}@${base}` : base
}

function keyState(server: SshServer, scan: HostKeyScan | undefined): { label: string; className: string } {
  if (scan && (scan.saved === 'mismatch' || scan.knownHosts === 'mismatch')) {
    return { label: 'Key changed', className: 'text-st-failed' }
  }
  if (server.trusted) {
    return { label: 'Key trusted', className: 'text-st-idle' }
  }
  return { label: 'Key not checked', className: 'text-muted' }
}

function knownHostsText(scan: HostKeyScan): string {
  if (scan.knownHosts === 'match') return 'Matches what is in ~/.ssh/known_hosts.'
  if (scan.knownHosts === 'mismatch') return 'Differs from what is in ~/.ssh/known_hosts.'
  return 'No entry in ~/.ssh/known_hosts.'
}

export function ServerCard({
  server,
  scan,
  scanError,
  scanning,
  testing,
  confirmingRemove,
  trustBusy,
  onScan,
  onTest,
  onEdit,
  onRemove,
  onConfirmRemove,
  onCancelRemove,
  onTrust
}: {
  server: SshServer
  scan: HostKeyScan | undefined
  scanError: string | null
  scanning: boolean
  testing: boolean
  confirmingRemove: boolean
  trustBusy: string | null
  onScan: () => void
  onTest: () => void
  onEdit: () => void
  onRemove: () => void
  onConfirmRemove: () => void
  onCancelRemove: () => void
  onTrust: (fingerprint: string) => void
}): React.JSX.Element {
  const now = useNow()
  const state = keyState(server, scan)
  const [copied, setCopied] = useState<string | null>(null)

  const copy = (fingerprint: string): void => {
    void navigator.clipboard?.writeText(fingerprint).then(
      () => {
        setCopied(fingerprint)
        window.setTimeout(() => setCopied((cur) => (cur === fingerprint ? null : cur)), 1200)
      },
      () => undefined
    )
  }

  return (
    <div data-testid={`servers-row-${server.id}`} className="rounded-lg border border-line bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="truncate text-[12.5px] font-medium">{server.name}</span>
        <span className={cx('shrink-0 text-[11.5px]', state.className)}>{state.label}</span>
      </div>
      <p className="mt-1 truncate font-mono text-[11.5px] text-muted">{displayTarget(server)}</p>
      {server.lastTest && (
        <p data-testid={`servers-lasttest-${server.id}`} className="mt-1 text-[11.5px] text-faint">
          {server.lastTest.ok ? 'Connected' : `Failed: ${server.lastTest.message}`} {ago(server.lastTest.at, now)} ago
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button variant="subtle" size="sm" data-testid={`servers-scan-${server.id}`} onClick={onScan} disabled={scanning || testing}>
          {scanning ? 'Checking' : 'Check key'}
        </Button>
        <Button variant="subtle" size="sm" data-testid={`servers-test-${server.id}`} onClick={onTest} disabled={scanning || testing}>
          {testing ? 'Testing' : 'Test connection'}
        </Button>
        <Button variant="ghost" size="sm" data-testid={`servers-edit-${server.id}`} onClick={onEdit}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" data-testid={`servers-remove-${server.id}`} onClick={onRemove}>
          Remove
        </Button>
      </div>

      {confirmingRemove && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-line-strong bg-raised px-2 py-1.5">
          <span className="min-w-0 flex-1 text-[12px] text-muted">Remove this server</span>
          <Button variant="subtle" size="sm" data-testid={`servers-confirm-remove-${server.id}`} onClick={onConfirmRemove}>
            Remove
          </Button>
          <Button variant="ghost" size="sm" data-testid={`servers-cancel-remove-${server.id}`} onClick={onCancelRemove}>
            Keep
          </Button>
        </div>
      )}

      {scanError && (
        <p data-testid={`servers-scan-error-${server.id}`} className="mt-2 text-[12px] leading-relaxed text-st-failed">
          {scanError}
        </p>
      )}

      {scan && !scanError && (
        <div className="mt-2 rounded-md border border-line bg-raised px-2.5 py-2">
          {scan.error ? (
            <p data-testid={`servers-scan-error-${server.id}`} className="text-[12px] leading-relaxed text-muted">
              {scan.error}
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                {scan.keys.map((key) => (
                  <div key={key.fingerprint} className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] text-fg">{key.type}</p>
                      <p className="truncate font-mono text-[11.5px] text-muted">{key.fingerprint}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Copy ${key.type} fingerprint`}
                      data-testid={`servers-copy-${server.id}`}
                      onClick={() => copy(key.fingerprint)}
                    >
                      <Copy size={13} />
                      {copied === key.fingerprint ? 'Copied' : 'Copy'}
                    </Button>
                    <Button
                      variant="subtle"
                      size="sm"
                      data-testid="servers-trust"
                      data-fingerprint={key.fingerprint}
                      onClick={() => onTrust(key.fingerprint)}
                      disabled={trustBusy !== null}
                    >
                      {trustBusy === key.fingerprint ? 'Trusting' : 'Trust this key'}
                    </Button>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11.5px] text-muted">{knownHostsText(scan)}</p>
              <p className="mt-1 text-[11.5px] text-faint">
                Compare this fingerprint with the one your server&apos;s provider shows before you trust it.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
