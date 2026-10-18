import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, FolderOpen, Tag } from 'lucide-react'
import { useSessions } from '../../store/sessions'
import { bridge } from '../../lib/bridge'
import type { GitWorktree, DetectedAgent } from '@shared/types'
import { AgentBadge } from '../../components/marks'
import { Popover, MenuItem, MenuLabel, MenuDivider, cx } from '../../components/ui'
import { cleanError } from './errors'

interface GitWorktreesProps {
  cwd: string | null
}

export function GitWorktrees({ cwd }: GitWorktreesProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [loading, setLoading] = useState(false)
  const createSession = useSessions((s) => s.createSession)
  const agents = useSessions((s) => s.agents)

  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !cwd) return
    let wanted = true
    setLoading(true)
    bridge
      .invoke('git:worktrees', cwd)
      .then((list) => {
        if (!wanted) return
        setWorktrees(list)
        setError(null)
      })
      .catch((err) => {
        if (wanted) setError(cleanError(err, 'The worktrees could not be read'))
      })
      .finally(() => {
        if (wanted) setLoading(false)
      })
    return () => {
      wanted = false
    }
  }, [open, cwd])

  const toggle = () => setOpen((o) => !o)

  const handleOpenPane = async (worktreePath: string, agentKind: string) => {
    try {
      await createSession(agentKind as any, worktreePath)
    } catch (err) {
      console.error('Failed to create session:', err)
    }
  }

  const installedAgents = agents.filter((a) => a.installed && !a.internal)

  return (
    <details data-testid="git-worktrees" className="border-t border-line" open={open}>
      <summary
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-hover"
        onClick={(e) => {
          e.preventDefault()
          toggle()
        }}
      >
        <span className="text-[12.5px] font-medium">Worktrees</span>
        {open ? <ChevronUp size={14} className="text-muted" /> : <ChevronDown size={14} className="text-muted" />}
        <span className="ml-auto text-[11px] text-faint">{loading && worktrees.length === 0 ? 'Loading…' : `${worktrees.length} ${worktrees.length === 1 ? 'worktree' : 'worktrees'}`}</span>
      </summary>
      {open && (
        <div className="px-3 pb-3 space-y-2 max-h-[300px] overflow-auto">
          {error ? (
            <div className="py-4 text-center text-st-failed">{error}</div>
          ) : loading && worktrees.length === 0 ? (
            <div className="text-center py-4 text-faint">Loading…</div>
          ) : worktrees.length === 0 ? (
            <div className="text-center py-4 text-faint">No worktrees</div>
          ) : (
            worktrees.map((wt) => (
              <div key={wt.path} className="px-2 py-1.5 rounded-lg hover:bg-hover transition-colors">
                <div className="flex items-center gap-2">
                  <FolderOpen size={14} className="text-muted shrink-0" />
                  <span className="flex-1 truncate font-mono text-[12.5px]">{wt.path.split('/').pop() ?? wt.path}</span>
                  {wt.main && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-accent/20 text-accent rounded">main</span>}
                  {wt.regatta && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-st-idle/20 text-st-idle rounded">Regatta</span>}
                </div>
                <div className="flex items-center gap-2 ml-6 mt-1">
                  {wt.branch && (
                    <>
                      <Tag size={11} className="text-faint shrink-0" />
                      <span className="font-mono text-[11px] text-muted">{wt.branch}</span>
                    </>
                  )}
                  <span className="ml-auto">
                    <Popover
                      align="end"
                      width={200}
                      button={({ toggle, open }) => (
                        <button
                          type="button"
                          onClick={toggle}
                          className={cx(
                            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors',
                            'hover:bg-hover text-fg'
                          )}
                          aria-label="Open a pane here"
                        >
                          <FolderOpen size={12} />
                          <span>Open a pane here</span>
                          {open && <ChevronDown size={10} className="text-muted" />}
                        </button>
                      )}
                    >
                      {(close) => (
                        <div>
                          <MenuLabel>Pick an agent</MenuLabel>
                          <MenuDivider />
                          {installedAgents.map((def) => (
                            <MenuItem
                              key={def.kind}
                              icon={<AgentBadge kind={def.kind} size={14} />}
                              label={def.name}
                              onClick={() => {
                                close()
                                void handleOpenPane(wt.path, def.kind)
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </Popover>
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </details>
  )
}