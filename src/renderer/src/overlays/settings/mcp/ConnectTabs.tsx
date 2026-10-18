// Settings > MCP: the snippet each kind of client needs, and a Copy button with the real token.

import { useState } from 'react'
import { Copy } from 'lucide-react'
import { bridge } from '../../../lib/bridge'
import { Button, cx } from '../../../components/ui'

type Client = 'claude' | 'cursor' | 'other'

const TABS: { id: Client; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'other', label: 'Other' }
]

/** The lines for one client, with the given token (the hint on screen, the real one on the clipboard). */
export function snippetFor(client: Client, url: string, token: string): string {
  if (client === 'claude') {
    return `claude mcp add --transport http --scope user regatta ${url} --header "Authorization: Bearer ${token}"`
  }
  if (client === 'cursor') {
    return JSON.stringify({ mcpServers: { regatta: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
  }
  return `URL: ${url}\nHeader: Authorization: Bearer ${token}`
}

export function ConnectTabs({ url, hint, running }: { url: string; hint: string; running: boolean }): React.JSX.Element {
  const [client, setClient] = useState<Client>('claude')
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void bridge
      .invoke('mcp:token')
      .then((token) =>
        navigator.clipboard?.writeText(snippetFor(client, url, token)).then(
          () => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1400)
          },
          () => undefined
        )
      )
      .catch(() => undefined)
  }

  const snippet = snippetFor(client, url, hint)

  return (
    <div className="mt-1.5">
      <div className="flex gap-1" role="tablist" aria-label="Client to connect">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={client === tab.id}
            data-testid={`mcp-tab-${tab.id}`}
            onClick={() => setClient(tab.id)}
            className={cx(
              'rounded-md px-2 py-1 text-[12px] transition-colors duration-150',
              client === tab.id ? 'bg-press text-fg' : 'text-muted hover:bg-hover hover:text-fg'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mt-2 flex items-start gap-2">
        <pre
          data-testid="mcp-snippet"
          className={cx(
            'min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-panel px-2.5 py-2',
            'font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted',
            !running && 'opacity-50'
          )}
        >
          {snippet}
        </pre>
        <Button variant="subtle" size="sm" data-testid="mcp-copy" onClick={copy}>
          <Copy size={13} />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {!running && (
        <p data-testid="mcp-off-note" className="mt-1.5 text-[11.5px] text-faint">
          Turn the server on to connect a client.
        </p>
      )}
      {client === 'claude' && (
        <p data-testid="mcp-claude-note" className="mt-1.5 text-[11.5px] text-faint">
          Added it before? Run claude mcp remove regatta --scope user first.
        </p>
      )}
    </div>
  )
}