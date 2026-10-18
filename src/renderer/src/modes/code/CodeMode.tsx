import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { getLayout, gridFor, layoutForCount } from '@shared/layouts'
import type { SessionState } from '@shared/types'
import { useSessions } from '../../store/sessions'
import { DENSITY_FONT, useUi } from '../../store/ui'
import { STATE_COLOR, STATE_LABEL } from '../../lib/format'
import { setTerminalFontSize } from '../../terminal/registry'
import { AgentBadge, Logo, StatusDot } from '../../components/marks'
import { Button } from '../../components/ui'
import { SidePanel } from '../../panels/SidePanel'
import { MemoryReadout } from '../../components/MemoryReadout'
import { Pane } from './Pane'
import { Toolbar } from './Toolbar'

const STRIP_ORDER: SessionState[] = ['waiting', 'working', 'starting', 'quiet', 'idle', 'done', 'failed']

function StatusStrip(): React.JSX.Element {
  const counts = useSessions((s) => {
    const c: Partial<Record<SessionState, number>> = {}
    for (const x of Object.values(s.sessions)) c[x.status.state] = (c[x.status.state] ?? 0) + 1
    return JSON.stringify(c)
  })
  const parsed = JSON.parse(counts) as Partial<Record<SessionState, number>>
  const items = STRIP_ORDER.filter((st) => parsed[st])
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-3 border-b border-line px-4 text-[11.5px] text-muted" data-testid="status-strip">
      {items.length === 0 && <span className="text-faint">No agents running</span>}
      {items.map((st, i) => (
        <span key={st} className="flex items-center gap-1.5">
          {i > 0 && <span className="-ml-1.5 mr-0.5 text-faint">·</span>}
          <StatusDot state={st} size={6} />
          <span style={{ color: STATE_COLOR[st] }}>{parsed[st]}</span> {STATE_LABEL[st]}
        </span>
      ))}
      <span className="ml-auto">
        <MemoryReadout />
      </span>
    </div>
  )
}

function EmptyState(): React.JSX.Element {
  const agents = useSessions((s) => s.agents)
  const workspace = useSessions((s) => s.workspace)
  const createSession = useSessions((s) => s.createSession)
  const pickWorkspace = useSessions((s) => s.pickWorkspace)
  const installed = agents.filter((a) => a.installed)
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto p-8" data-testid="empty-area">
      <div
        className="m-auto w-[460px] max-w-full shrink-0 rounded-2xl border border-line bg-panel/70 p-7 text-center shadow-2xl animate-fade-up"
        data-testid="empty-card"
      >
        <div className="mx-auto mb-4 flex justify-center">
          <Logo size={40} />
        </div>
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Launch your first agent</h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          Each agent runs in its own real terminal, side by side. Regatta watches them all and tells you which one needs you.
        </p>
        <div className="mt-5 grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
          {installed.map((a) => (
            <button
              key={a.kind}
              type="button"
              data-testid={`start-${a.kind}`}
              onClick={() => void createSession(a.kind)}
              className="flex items-center gap-2.5 rounded-xl border border-line bg-raised px-3 py-2.5 text-left transition-all hover:-translate-y-px hover:border-accent/40 hover:bg-hover"
            >
              <AgentBadge kind={a.kind} size={22} />
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium">{a.name}</span>
                <span className="block truncate text-[11px] text-faint">{a.version ?? (a.kind === 'shell' ? 'your shell' : '')}</span>
              </span>
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mx-auto mt-4" onClick={() => void pickWorkspace()}>
          <FolderOpen size={13} />
          <span className="max-w-[300px] truncate">{workspace?.root ?? 'Choose a project folder'}</span>
        </Button>
      </div>
    </div>
  )
}

export function CodeMode(): React.JSX.Element {
  const order = useSessions((s) => s.order)
  const sessions = useSessions((s) => s.sessions)
  const focusedId = useSessions((s) => s.focusedId)
  const { layoutId, layoutPinned, setLayout, maximizedId, density, sidePanel } = useUi()
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridSize, setGridSize] = useState({ width: 1000, height: 700 })

  // Until the user picks a layout, grow it to hold every pane.
  useEffect(() => {
    if (!layoutPinned) setLayout(layoutForCount(Math.max(order.length, 1)).id, false)
    else if (order.length > getLayout(layoutId).capacity) setLayout(layoutForCount(order.length).id, false)
  }, [order.length, layoutPinned, layoutId, setLayout])

  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setGridSize({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = getLayout(layoutId)
  const visible = maximizedId && sessions[maximizedId] ? [maximizedId] : order.slice(0, layout.capacity)
  const grid = maximizedId ? { cols: 1, rows: 1 } : gridFor(layout, visible.length)

  useEffect(() => {
    const autoSize = layout.capacity >= 9 ? 11.5 : layout.capacity >= 6 ? 12 : 12.5
    setTerminalFontSize(density === 'auto' ? autoSize : DENSITY_FONT[density])
  }, [density, layout.capacity])

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Toolbar gridSize={gridSize} />
      <StatusStrip />
      <div ref={gridRef} className="relative flex min-h-0 flex-1 gap-2 p-2.5">
        {sidePanel && sidePanel !== 'browser' && <SidePanel panel={sidePanel} />}
        {order.length === 0 ? (
          <EmptyState />
        ) : (
          <div
            data-testid="pane-grid"
            data-layout={layoutId}
            data-maximized={maximizedId ?? ''}
            className="grid min-h-0 flex-1 gap-2"
            style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))` }}
          >
            {visible.map((id) => sessions[id] && <Pane key={id} session={sessions[id]!} focused={focusedId === id} />)}
          </div>
        )}
        {order.length > visible.length && !maximizedId && (
          <div className="absolute right-5 bottom-4 rounded-full border border-line-strong bg-raised px-3 py-1 text-[11.5px] text-muted shadow-lg">
            {order.length - visible.length} more in the Fleet list. Pick a bigger layout to see them.
          </div>
        )}
      </div>
    </div>
  )
}
