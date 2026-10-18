// Card for a CLI (Claude Code or Codex) showing its saved accounts.

import { useState } from 'react'
import { Plus, ExternalLink, Trash2, Check, FolderOpen } from 'lucide-react'
import type { AccountInfo } from '@shared/types'
import { AGENTS } from '@shared/agents'
import { AgentBadge } from '../../../components/marks'
import { Button, Popover, MenuItem, MenuDivider, MenuLabel, cx } from '../../../components/ui'
import { useAccounts } from '../../../store/accounts'
import { bridge } from '../../../lib/bridge'

interface CliCardProps {
  cli: AccountInfo['cli']
  accounts: AccountInfo[]
}

export function CliCard({ cli, accounts }: CliCardProps): React.JSX.Element {
  const { add, remove, setDefault } = useAccounts()
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  const cliAccounts = accounts.filter((a) => a.cli === cli)
  const savedAccounts = cliAccounts.filter((a) => !a.id.endsWith(':system'))
  const systemAccount = cliAccounts.find((a) => a.id.endsWith(':system'))
  const defaultId = cliAccounts.find((a) => a.isDefault)?.id

  const handleAdd = async (): Promise<void> => {
    const trimmed = newName.trim()
    if (!trimmed) return
    setError('')
    try {
      const created = await add(cli, trimmed)
      if (created) {
        setNewName('')
        setAdding(false)
        // Open a pane with this account
        await bridge.invoke('session:create', {
          agent: cli,
          cols: 100,
          rows: 30,
          account: created.id
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRemove = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`Remove ${name}? Its folder, with that sign-in, is deleted from this computer.`)) return
    try {
      await remove(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleMakeDefault = async (id: string): Promise<void> => {
    try {
      await setDefault(cli, id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleOpenPane = async (accountId: string): Promise<void> => {
    try {
      await bridge.invoke('session:create', {
        agent: cli,
        cols: 100,
        rows: 30,
        account: accountId
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const def = AGENTS[cli]

  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center gap-2">
        <AgentBadge kind={cli} size={20} />
        <span className="text-[13px] font-medium">{def.name}</span>
        <span className="text-[11px] text-faint">({savedAccounts.length} saved account{savedAccounts.length !== 1 ? 's' : ''})</span>
      </div>

      {systemAccount && (
        <div
          data-testid={`account-row-${systemAccount.id}`}
          className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2"
        >
          <AgentBadge kind={cli} size={16} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-[12.5px] font-medium">Your computer sign-in</span>
              {systemAccount.isDefault && (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-st-idle">
                  <Check size={11} /> Default
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[11px] text-faint">
              Your usual sign-in, outside these saved ones
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {systemAccount.signedIn === true && (
              <span className="text-[11px] text-muted">{systemAccount.email ? `signed in as ${systemAccount.email}` : 'signed in'}</span>
            )}
            {systemAccount.signedIn === false && <span className="text-[11px] text-faint">not signed in yet</span>}
            {systemAccount.isDefault ? null : (
              <Button
                variant="ghost"
                size="sm"
                data-testid={`account-default-${systemAccount.id}`}
                onClick={() => handleMakeDefault(systemAccount.id)}
              >
                Make default
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              data-testid={`account-open-${systemAccount.id}`}
              onClick={() => handleOpenPane(systemAccount.id)}
            >
              <FolderOpen size={12} />
              Open
            </Button>
          </div>
        </div>
      )}

      {savedAccounts.map((acc) => (
        <div
          key={acc.id}
          data-testid={`account-row-${acc.id}`}
          className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2"
        >
          <AgentBadge kind={cli} size={16} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-[12.5px] font-medium">{acc.name}</span>
              {acc.isDefault && (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-st-idle">
                  <Check size={11} /> Default
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {acc.signedIn === true && (
              <span className="text-[11px] text-muted">{acc.email ? `signed in as ${acc.email}` : 'signed in'}</span>
            )}
            {acc.signedIn === false && <span className="text-[11px] text-faint">not signed in yet</span>}
            {!acc.isDefault && (
              <Button
                variant="ghost"
                size="sm"
                data-testid={`account-default-${acc.id}`}
                onClick={() => handleMakeDefault(acc.id)}
              >
                Make default
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              data-testid={`account-open-${acc.id}`}
              onClick={() => handleOpenPane(acc.id)}
            >
              <FolderOpen size={12} />
              Open
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid={`account-remove-${acc.id}`}
              onClick={() => handleRemove(acc.id, acc.name)}
              className="text-st-failed hover:bg-st-failed/10"
            >
              <Trash2 size={12} />
              Remove
            </Button>
          </div>
        </div>
      ))}

      <Popover
        align="end"
        width={320}
        button={({ toggle, open }: { toggle: () => void; open: boolean }) => (
          <Button
            variant="outline"
            size="sm"
            data-testid={`account-add-${cli}`}
            onClick={toggle}
            active={open}
            className="w-full"
          >
            <Plus size={13} />
            Add account
          </Button>
        )}
      >
        {(close: () => void) => (
          <div className="space-y-2 p-1">
            <MenuLabel>Name it so you will recognize it, for example Work</MenuLabel>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="Account name"
              autoFocus
              className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
            />
            {error && <p className="text-[11px] text-st-failed">{error}</p>}
            <div className="flex gap-1.5">
              <Button variant="subtle" size="sm" onClick={() => { setNewName(''); close(); setAdding(false); }}>
                Cancel
              </Button>
              <Button variant="accent" size="sm" onClick={handleAdd} disabled={!newName.trim() || adding} data-testid={`account-create-${cli}`}>
                {adding ? 'Creating...' : 'Create'}
              </Button>
            </div>
            <MenuDivider />
            <MenuItem icon={<ExternalLink size={13} />} label="Sign in inside the new pane" hint="Claude Code asks when it starts; for Codex, run codex login" onClick={close} />
          </div>
        )}
      </Popover>
    </div>
  )
}