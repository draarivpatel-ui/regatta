// One Services row: name, version, a state pill, and (for a CLI that is signed out or not
// installed) a faint hint with the command the user would run themselves. Regatta never runs it.

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { ServiceStatus } from '@shared/types'
import { INSTALL_COMMAND, LOGIN_COMMAND } from './login'

const PILL_BASE = 'inline-flex h-[20px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium whitespace-nowrap'

function Pill({ row }: { row: ServiceStatus }): React.JSX.Element {
  if (!row.installed) {
    return <span className={`${PILL_BASE} border border-line text-faint`}>Not installed</span>
  }
  if (row.signedIn === 'yes') {
    return (
      <span className={`${PILL_BASE} max-w-[260px] border border-st-idle/40 bg-st-idle/10 text-st-idle`}>
        <span>Signed in</span>
        {row.account && <span className="truncate font-normal opacity-80">{row.account}</span>}
      </span>
    )
  }
  if (row.signedIn === 'no') {
    return <span className={`${PILL_BASE} border border-line-strong bg-press text-muted`}>Signed out</span>
  }
  return (
    <span title={row.detail} className={`${PILL_BASE} border border-line text-faint`}>
      Unknown
    </span>
  )
}

/** A copyable command the user runs themselves: how to sign in, or how to install a missing CLI. Nothing is run here. */
function Hint({ id, command, variant = 'login' }: { id: ServiceStatus['id']; command: string; variant?: 'login' | 'install' }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    try {
      void navigator.clipboard
        ?.writeText(command)
        .then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
        .catch(() => undefined)
    } catch {
      // No clipboard here; the text is selectable anyway.
    }
  }
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-faint" data-testid={`services-hint-${id}`} data-kind={variant}>
      {variant === 'install' ? (
        <span>Install it:</span>
      ) : (
        <span>Run</span>
      )}
      <code className="rounded border border-line bg-term px-1.5 py-px font-mono text-[10.5px]">{command}</code>
      {variant === 'login' && <span>in a terminal</span>}
      <button
        type="button"
        aria-label={`Copy ${command}`}
        data-testid={`services-copy-${id}`}
        onClick={copy}
        className="no-drag rounded p-0.5 transition-colors duration-150 hover:bg-hover hover:text-muted"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
      {copied && <span>copied</span>}
    </p>
  )
}

export function ServiceRow({ row }: { row: ServiceStatus }): React.JSX.Element {
  // A missing CLI gets the install command; an installed one that is signed out gets the sign-in
  // command. Unknown means Regatta could not tell, so it does not guess that a login is needed.
  const installHint = !row.installed ? INSTALL_COMMAND[row.id] : undefined
  const loginHint = row.installed && row.signedIn === 'no' ? LOGIN_COMMAND[row.id] : undefined
  return (
    <div
      data-testid={`services-row-${row.id}`}
      data-signed-in={row.signedIn}
      data-installed={row.installed ? 'yes' : 'no'}
      className="rounded-lg border border-line bg-panel px-3 py-2"
    >
      <div className="flex items-center gap-3">
        <span className="w-[130px] shrink-0 truncate text-[12.5px] font-medium">{row.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{row.version ?? ''}</span>
        <Pill row={row} />
      </div>
      {installHint ? (
        <Hint id={row.id} command={installHint} variant="install" />
      ) : loginHint ? (
        <Hint id={row.id} command={loginHint} />
      ) : null}
    </div>
  )
}
