// Account picker in the pane header for Claude Code and Codex panes.

import { useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import type { SessionInfo } from '@shared/types'
import { AGENTS } from '@shared/agents'
import { useAccounts } from '../../store/accounts'
import { bridge } from '../../lib/bridge'
import { Popover, MenuItem, cx } from '../../components/ui'

interface AccountPickerProps {
  session: SessionInfo
}

export function AccountPicker({ session }: AccountPickerProps): React.JSX.Element | null {
  if (session.agent !== 'claude' && session.agent !== 'codex') return null

  const { accounts } = useAccounts()
  const [confirming, setConfirming] = useState<string | null>(null)

  const cliAccounts = accounts.filter((a) => a.cli === session.agent)
  const currentAccount = cliAccounts.find((a) => a.id === session.account) ?? cliAccounts.find((a) => a.isDefault)
  const isWorking = session.status.state === 'working'

  const handlePick = async (accountId: string): Promise<void> => {
    if (isWorking && accountId !== session.account) {
      setConfirming(accountId)
      return
    }
    await switchAccount(accountId)
  }

  const handleConfirm = async (): Promise<void> => {
    if (confirming) {
      await switchAccount(confirming)
      setConfirming(null)
    }
  }

  const switchAccount = async (accountId: string): Promise<void> => {
    try {
      await bridge.invoke('session:setAccount', session.id, accountId)
    } catch (err) {
      console.error('Failed to switch account:', err)
    }
  }

  return (
    <Popover
      align="end"
      width={200}
      button={({ toggle, open }: { toggle: () => void; open: boolean }) => (
        <button
          type="button"
          onClick={toggle}
          data-testid="pane-account"
          className={cx(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium',
            'bg-panel/60 border border-line hover:bg-hover transition-colors duration-150',
            confirming && 'opacity-50',
            open && 'bg-hover'
          )}
          title="Switch account"
        >
          <span className="truncate max-w-[120px]">{currentAccount?.name ?? 'Account'}</span>
          <ChevronDown size={11} className={open ? 'rotate-180' : ''} />
        </button>
      )}
    >
      {(close: () => void) => (
        <div>
          {cliAccounts.map((acc) => (
            <MenuItem
              key={acc.id}
              label={<span className="truncate">{acc.name}</span>}
              hint={acc.isDefault ? 'Default' : acc.id === session.account && !acc.isDefault ? 'current' : undefined}
              icon={acc.isDefault ? <Check size={12} className="text-accent" /> : undefined}
              onClick={() => { handlePick(acc.id); close(); }}
              disabled={confirming !== null && confirming !== acc.id}
            />
          ))}
          {confirming && (
            <div className="border-t border-line p-2">
              <p className="text-[12px] text-muted mb-2">
                Restart this pane with {cliAccounts.find((a) => a.id === confirming)?.name}?
              </p>
              <div className="flex gap-1.5 justify-end">
                <button
                  type="button"
                  onClick={() => { setConfirming(null); close(); }}
                  className="rounded-md px-2 py-1 text-[12px] text-muted hover:text-fg hover:bg-hover"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => { handleConfirm(); close(); }}
                  className="rounded-md px-2 py-1 text-[12px] font-medium text-accent-ink bg-accent hover:bg-accent-bright"
                >
                  Restart
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Popover>
  )
}