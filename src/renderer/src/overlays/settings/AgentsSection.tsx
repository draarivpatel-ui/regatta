// Settings > Agents: the CLIs found on this computer, and sign-ins per CLI.

import { useState } from 'react'
import { bridge } from '../../lib/bridge'
import { useSessions } from '../../store/sessions'
import { useAccounts } from '../../store/accounts'
import { AgentBadge } from '../../components/marks'
import { Button } from '../../components/ui'
import { SectionTitle } from './common'
import { CliCard } from './agents/CliCard'

export function AgentsSection(): React.JSX.Element {
  const agents = useSessions((s) => s.agents)
  const { accounts, load } = useAccounts()
  const [scanning, setScanning] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const rescan = (): void => {
    setScanning(true)
    void bridge
      .invoke('agents:rescan')
      .then((next) => {
        useSessions.setState({ agents: next })
      })
      .finally(() => setScanning(false))
  }

  if (!loaded) {
    load()
    setLoaded(true)
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <SectionTitle>Agents</SectionTitle>
            <p className="mt-1 text-[12.5px] text-muted">CLIs found on this computer.</p>
          </div>
          <Button variant="subtle" size="sm" data-testid="settings-rescan" onClick={rescan} disabled={scanning}>
            {scanning ? 'Scanning' : 'Scan again'}
          </Button>
        </div>
        <div className="mt-3 space-y-1.5">
          {agents.map((a) => (
            <div
              key={a.kind}
              data-testid="settings-agent-row"
              className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2"
            >
              <AgentBadge kind={a.kind} size={20} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[12.5px] font-medium">{a.name}</span>
                  <span className="shrink-0 text-[11px] text-faint">{a.version ?? (a.installed ? (a.kind === 'shell' ? 'your shell' : 'Found') : 'Not found')}</span>
                </div>
                {a.path && <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{a.path}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionTitle>Your sign-ins</SectionTitle>
        <p className="mt-1 text-[12.5px] text-muted">Saved sign-ins for Claude Code and Codex. Each gets its own config folder.</p>
        <CliCard cli="claude" accounts={accounts} />
        <CliCard cli="codex" accounts={accounts} />
      </div>
    </div>
  )
}