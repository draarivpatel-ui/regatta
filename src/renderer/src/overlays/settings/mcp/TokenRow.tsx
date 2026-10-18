// Settings > MCP: the token row, showing the whole token on request and asking before making a new one.

import { useState } from 'react'
import { bridge } from '../../../lib/bridge'
import { Button } from '../../../components/ui'

export function TokenRow({ hint, onRegenerate }: { hint: string; onRegenerate: () => void }): React.JSX.Element {
  const [shown, setShown] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  const toggleShow = (): void => {
    if (shown !== null) {
      setShown(null)
      return
    }
    void bridge
      .invoke('mcp:token')
      .then(setShown)
      .catch(() => setShown(null))
  }

  return (
    <div>
      <p className="text-[13px] font-medium">Token</p>
      <div className="mt-1.5 flex items-center gap-2">
        <span data-testid="mcp-token" className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">
          {shown ?? hint}
        </span>
        <Button variant="subtle" size="sm" data-testid="mcp-show" onClick={toggleShow}>
          {shown === null ? 'Show' : 'Hide'}
        </Button>
        <Button variant="ghost" size="sm" data-testid="mcp-regenerate" onClick={() => setAsking(true)}>
          Make a new token
        </Button>
      </div>
      <p className="mt-1.5 text-[11.5px] text-faint">
        Every request carries this token. Keep it on this computer, and do not paste it into a chat.
      </p>

      {asking && (
        <div
          data-testid="mcp-regenerate-confirm"
          className="mt-2 flex items-center gap-2 rounded-md border border-line-strong bg-raised px-2 py-1.5"
        >
          <span className="min-w-0 flex-1 text-[12px] text-muted">
            Apps using the current token will stop working until you update them.
          </span>
          <Button
            variant="subtle"
            size="sm"
            data-testid="mcp-regenerate-yes"
            onClick={() => {
              setAsking(false)
              setShown(null)
              onRegenerate()
            }}
          >
            Make a new token
          </Button>
          <Button variant="ghost" size="sm" data-testid="mcp-regenerate-no" onClick={() => setAsking(false)}>
            Keep
          </Button>
        </div>
      )}
    </div>
  )
}