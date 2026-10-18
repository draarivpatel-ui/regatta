import { Globe, Ship } from 'lucide-react'
import type { SessionInfo, SessionState } from '@shared/types'
import { useSessions } from '../../store/sessions'
import { useUi } from '../../store/ui'
import { useNow } from '../../lib/useNow'
import { STATE_COLOR, ago, basename } from '../../lib/format'
import { AgentBadge, StatusDot } from '../../components/marks'
import { IconButton, cx } from '../../components/ui'
import { AGENTS } from '@shared/agents'
import { PreviewPanel } from '../../panels/PreviewPanel'

const GROUPS: { title: string; states: SessionState[]; empty?: string }[] = [
  { title: 'Waiting on you', states: ['waiting'] },
  { title: 'Working', states: ['working', 'starting'] },
  { title: 'Quiet', states: ['quiet'] },
  { title: 'Ready for a prompt', states: ['idle'] },
  { title: 'Finished', states: ['done', 'failed'] }
]

function FleetRow({ s, now }: { s: SessionInfo; now: number }): React.JSX.Element {
  const focus = useSessions((st) => st.focus)
  const focused = useSessions((st) => st.focusedId === s.id)
  const name = AGENTS[s.agent].name
  const cwd = basename(s.cwd)
  return (
    <button
      type="button"
      data-testid="fleet-row"
      onClick={() => focus(s.id)}
      className={cx(
        'flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-hover',
        focused && 'bg-hover'
      )}
    >
      <AgentBadge kind={s.agent} size={20} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-fg" title={name}>{name}</span>
          <span className="ml-auto shrink-0 text-[11px] text-faint">{ago(s.status.since, now)}</span>
        </span>
        <span className="mt-0.5 block truncate text-[11.5px]" style={{ color: STATE_COLOR[s.status.state] }} title={s.status.reason}>
          {s.status.reason}
        </span>
        <span className="block truncate text-[11px] text-faint" title={cwd}>{cwd}</span>
      </span>
    </button>
  )
}

export function FleetSidebar(): React.JSX.Element {
  const now = useNow()
  const order = useSessions((s) => s.order)
  const byId = useSessions((s) => s.sessions)
  const sessions = order.map((id) => byId[id]).filter((s): s is SessionInfo => Boolean(s))
  const workspace = useSessions((s) => s.workspace)
  const { sidebarTab, setSidebarTab, setSidebarOpen, sidebarOpen } = useUi()
  const projects = new Set(sessions.map((s) => s.cwd)).size
  const agentsIn = `${sessions.length === 1 ? '1 agent' : `${sessions.length} agents`} in ${projects <= 1 ? (workspace?.name ?? '1 folder') : `${projects} folders`}`

  return (
    <aside className={cx('flex w-[300px] min-w-0 shrink flex-col overflow-hidden border-l border-line bg-chrome', !sidebarOpen && 'hidden')} data-testid="fleet-sidebar">
      <div className="flex h-[46px] items-center gap-1 px-2.5">
        <div className="flex rounded-lg border border-line bg-panel p-[3px]">
          {(
            [
              ['preview', 'Preview', <Globe key="g" size={13} />],
              ['fleet', 'Fleet', <Ship key="s" size={13} />]
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSidebarTab(id)}
              className={cx(
                'flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors',
                sidebarTab === id ? 'bg-press text-fg' : 'text-muted hover:text-fg'
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
        <IconButton className="ml-auto" onClick={() => setSidebarOpen(false)} title="Hide sidebar" aria-label="Hide sidebar">
          <span className="text-[15px] leading-none">›</span>
        </IconButton>
      </div>

      {sidebarTab === 'fleet' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mx-2.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel">
            <div className="truncate border-b border-line px-3 py-2.5 text-[12.5px] font-medium" title={agentsIn}>
              {agentsIn}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
              {sessions.length === 0 && (
                <p className="px-2 py-6 text-center text-[12px] text-faint" data-testid="fleet-empty">No agents yet. Start one from New pane.</p>
              )}
              {GROUPS.map((g) => {
                const rows = sessions.filter((s) => g.states.includes(s.status.state))
                if (rows.length === 0) return null
                return (
                  <div key={g.title} className="mb-1.5">
                    <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11.5px] font-medium text-muted">
                      <StatusDot state={g.states[0]!} size={6} />
                      {g.title}
                      <span className="text-faint">{rows.length}</span>
                    </div>
                    {rows.map((s) => (
                      <FleetRow key={s.id} s={s} now={now} />
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
          <p className="px-4 py-3 text-[11px] leading-relaxed text-faint">
            Status comes from each tool's own events where it offers them, otherwise from what its screen shows. An agent that goes silent is marked quiet, not finished.
          </p>
        </div>
      ) : (
        <div className="m-2.5 mt-0 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel" data-testid="preview-tab">
          <PreviewPanel />
        </div>
      )}
    </aside>
  )
}
