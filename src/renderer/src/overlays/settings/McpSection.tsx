// Settings > MCP: turn Regatta's own MCP server on, and give other tools the token they need.

import { useCallback, useEffect, useState } from 'react'
import type { McpState } from '@shared/mcp'
import { bridge } from '../../lib/bridge'
import { Button } from '../../components/ui'
import { Toggle } from './Toggle'
import { SectionTitle } from './common'
import { ConnectTabs } from './mcp/ConnectTabs'
import { TokenRow } from './mcp/TokenRow'

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function McpSection(): React.JSX.Element {
  const [state, setState] = useState<McpState | null>(null)
  const [portText, setPortText] = useState('')
  const [portError, setPortError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void bridge
      .invoke('mcp:state')
      .then((next) => {
        setState(next)
        setPortText(String(next.port))
        setPortError(null)
      })
      .catch(() => setState(null))
  }, [])

  useEffect(() => {
    load()
    return bridge.on('mcp:changed', setState)
  }, [load])

  const toggle = (on: boolean): void => {
    setBusy(true)
    void bridge
      .invoke('mcp:setEnabled', on)
      .then(setState)
      .catch((err) => setPortError(cleanError(err)))
      .finally(() => setBusy(false))
  }

  const applyPort = (): void => {
    const wanted = Number(portText)
    setBusy(true)
    void bridge
      .invoke('mcp:setPort', wanted)
      .then((next) => {
        setState(next)
        setPortText(String(next.port))
        setPortError(null)
      })
      .catch((err) => setPortError(cleanError(err)))
      .finally(() => setBusy(false))
  }

  const enabled = state?.enabled ?? false
  const url = state?.url ?? ''
  const status = state?.error ? state.error : state?.running ? `On at ${url}` : 'Off'

  return (
    <div className="max-w-[620px]">
      <SectionTitle>MCP</SectionTitle>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        Let other tools on this computer use Regatta.
      </p>

      <div className="mt-5 rounded-lg border border-line bg-panel px-3 py-2.5" data-testid="mcp-server">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium">Regatta&apos;s MCP server</p>
            <p
              data-testid="mcp-status"
              className={`mt-0.5 text-[12px] ${state?.error ? 'text-st-failed' : 'text-muted'}`}
            >
              {state ? status : 'Reading settings'}
            </p>
          </div>
          <Toggle
            checked={enabled}
            onChange={toggle}
            testId="mcp-toggle"
            label="Regatta's MCP server"
            disabled={state === null || busy}
          />
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <label className="flex items-center gap-2 text-[12px] text-muted" htmlFor="mcp-port">
            Port
          </label>
          <input
            id="mcp-port"
            data-testid="mcp-port"
            value={portText}
            inputMode="numeric"
            onChange={(e) => setPortText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyPort()
            }}
            className="h-7 w-[92px] rounded-md border border-line-strong bg-raised px-2 font-mono text-[12px] text-fg outline-none focus:border-accent"
          />
          <Button
            variant="subtle"
            size="sm"
            data-testid="mcp-port-apply"
            onClick={applyPort}
            disabled={busy || portText === '' || Number(portText) === state?.port}
          >
            Apply
          </Button>
        </div>
        {portError && (
          <p data-testid="mcp-port-error" className="mt-1.5 text-[12px] text-st-failed">
            {portError}
          </p>
        )}
      </div>

      <div className="mt-5">
        <p className="text-[13px] font-medium">Connect a client</p>
        <ConnectTabs url={url} hint={state?.tokenHint ?? ''} running={Boolean(state?.running)} />
      </div>

      <div className="mt-5">
        <p className="text-[13px] font-medium">Tools</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="mcp-tools">
          {(state?.tools ?? []).map((tool) => (
            <span
              key={tool.name}
              data-testid="mcp-tool"
              title={tool.description}
              className="rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-[11.5px] text-muted"
            >
              {tool.name}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <TokenRow
          hint={state?.tokenHint ?? ''}
          onRegenerate={() => {
            setBusy(true)
            void bridge
              .invoke('mcp:regenerate')
              .then(setState)
              .catch((err) => setPortError(cleanError(err)))
              .finally(() => setBusy(false))
          }}
        />
      </div>
    </div>
  )
}