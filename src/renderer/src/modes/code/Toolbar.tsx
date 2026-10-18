import { useState } from 'react'
import {
  BellRing,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe,
  LayoutGrid,
  MessagesSquare,
  Mic,
  Plus,
  Radio,
  Search,
  Smartphone,
  Users,
  Workflow
} from 'lucide-react'
import { AGENTS } from '@shared/agents'
import { LAYOUTS, getLayout, layoutFits, layoutFitReason, type LayoutDef, type LayoutId } from '@shared/layouts'
import { useSessions } from '../../store/sessions'
import { useUi, type Density, type SidePanel } from '../../store/ui'
import { AgentBadge } from '../../components/marks'
import { toggleDictation } from '../../dictation/controller'
import { Button, IconButton, MenuDivider, MenuItem, MenuLabel, Popover, cx } from '../../components/ui'

const PANELS: { id: SidePanel; label: string; icon: React.JSX.Element }[] = [
  { id: 'files', label: 'Files', icon: <FolderTree size={13} /> },
  { id: 'find', label: 'Find', icon: <Search size={13} /> },
  { id: 'git', label: 'Git', icon: <GitBranch size={13} /> },
  { id: 'browser', label: 'Preview', icon: <Globe size={13} /> },
  { id: 'thread', label: 'Thread', icon: <MessagesSquare size={13} /> },
  { id: 'flows', label: 'Flows', icon: <Workflow size={13} /> },
  { id: 'simulator', label: 'Device', icon: <Smartphone size={13} /> }
]

function LayoutGlyph({ layout }: { layout: LayoutDef }): React.JSX.Element {
  const cells = Array.from({ length: layout.capacity })
  return (
    <div className="flex h-[34px] w-[52px] gap-[3px]">
      <div className="grid flex-1 gap-[3px]" style={{ gridTemplateColumns: `repeat(${layout.cols}, 1fr)`, gridTemplateRows: `repeat(${layout.rows}, 1fr)` }}>
        {cells.map((_, i) => (
          <span key={i} className="rounded-[2px] bg-current opacity-35" />
        ))}
      </div>
      {layout.withPreview && <span className="w-[14px] rounded-[2px] border border-current opacity-60" />}
      {layout.sidebarPreview && (
        <span className="flex w-[14px] items-center justify-center rounded-[2px] border border-current opacity-60">
          <span className="h-[6px] w-[6px] rounded-full bg-current" />
        </span>
      )}
    </div>
  )
}

function LayoutMenu({ gridSize }: { gridSize: { width: number; height: number } }): React.JSX.Element {
  const { layoutId, setLayout, setSidebarTab, density, setDensity } = useUi()
  const count = useSessions((s) => s.order.length)
  const current = getLayout(layoutId)
  // A layout too big for the window stays selectable, but while it is hovered or focused the
  // menu says why it does not fit.
  const [focusedLayout, setFocusedLayout] = useState<LayoutId | null>(null)
  const shown = focusedLayout ? getLayout(focusedLayout) : null
  const reason = shown && !layoutFits(shown, gridSize.width, gridSize.height) ? layoutFitReason(shown, gridSize.width, gridSize.height) : null
  return (
    <Popover
      width={318}
      testId="layout-menu"
      button={({ open, toggle }) => (
        <Button variant="subtle" size="sm" onClick={toggle} active={open} data-testid="layout-button">
          <LayoutGrid size={13} className="text-muted" />
          {count === 1 ? '1 pane' : `${count} panes`}
        </Button>
      )}
    >
      {(close) => (
        <div className="p-1">
          <MenuLabel>Layout</MenuLabel>
          <div className="grid grid-cols-4 gap-1.5 px-1 pb-2">
            {LAYOUTS.map((l) => {
              const fits = layoutFits(l, gridSize.width, gridSize.height)
              const on = l.id === layoutId
              return (
                <button
                  key={l.id}
                  type="button"
                  data-testid={`layout-${l.id}`}
                  title={fits ? l.hint : `${l.hint}. Too small at this window size`}
                  onFocus={() => setFocusedLayout(l.id)}
                  onBlur={() => setFocusedLayout(null)}
                  onMouseEnter={() => setFocusedLayout(l.id)}
                  onMouseLeave={() => setFocusedLayout(null)}
                  onClick={() => {
                    setLayout(l.id)
                    // A layout that pairs the panes with the sidebar preview opens that tab too.
                    if (l.sidebarPreview) setSidebarTab('preview')
                    close()
                  }}
                  className={cx(
                    'flex flex-col items-center gap-1.5 rounded-lg border px-1 pt-2 pb-1.5 transition-colors',
                    on ? 'border-accent/50 bg-accent/10 text-accent-bright' : 'border-line text-muted hover:bg-hover hover:text-fg',
                    !fits && !on && 'opacity-45'
                  )}
                >
                  <LayoutGlyph layout={l} />
                  <span className="text-[10.5px] leading-tight">{l.label}</span>
                </button>
              )
            })}
          </div>
          <p
            data-testid="layout-fit-reason"
            className={cx('min-h-[16px] px-2 pb-1 text-[11px] leading-snug text-faint transition-colors', !reason && 'invisible')}
          >
            {reason ?? current.hint}
          </p>
          <MenuLabel>Text size</MenuLabel>
          <div className="mx-1 mb-1 grid grid-cols-4 rounded-lg border border-line bg-panel p-0.5">
            {(['auto', 'comfortable', 'compact', 'dense'] as Density[]).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDensity(d)}
                className={cx(
                  'h-6 rounded-md text-[11px] capitalize transition-colors',
                  density === d ? 'bg-press text-fg' : 'text-muted hover:text-fg'
                )}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}
    </Popover>
  )
}

export function NewPaneMenu({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const agents = useSessions((s) => s.agents)
  const createSession = useSessions((s) => s.createSession)
  const workspace = useSessions((s) => s.workspace)
  const pickWorkspace = useSessions((s) => s.pickWorkspace)
  const installed = agents.filter((a) => a.installed && a.kind !== 'shell')
  const missing = agents.filter((a) => !a.installed)
  const shell = agents.find((a) => a.kind === 'shell')
  return (
    <Popover
      align="end"
      width={290}
      testId="new-pane-menu"
      button={({ open, toggle }) =>
        compact ? (
          <IconButton onClick={toggle} active={open} title="Add a pane" aria-label="Add a pane" data-testid="pane-new-button">
            <Plus size={14} />
          </IconButton>
        ) : (
          <Button variant="accent" size="sm" onClick={toggle} data-testid="new-pane-button">
            <Plus size={14} strokeWidth={2.4} />
            New pane
          </Button>
        )
      }
    >
      {(close) => (
        <div>
          <MenuLabel>Start an agent in {workspace?.name ?? 'this folder'}</MenuLabel>
          {installed.map((a) => (
            <MenuItem
              key={a.kind}
              icon={<AgentBadge kind={a.kind} size={18} />}
              label={a.name}
              hint={a.version ? a.version.replace(/^[^\d]*/, '').slice(0, 14) : undefined}
              onClick={() => {
                close()
                void createSession(a.kind)
              }}
            />
          ))}
          {shell && (
            <MenuItem
              icon={<AgentBadge kind="shell" size={18} />}
              label="Terminal"
              hint="your shell"
              onClick={() => {
                close()
                void createSession('shell')
              }}
            />
          )}
          {missing.length > 0 && (
            <>
              <MenuDivider />
              <MenuLabel>Not found on this computer</MenuLabel>
              <div className="flex flex-wrap gap-1 px-2 pb-1.5">
                {missing.map((a) => (
                  <span key={a.kind} className="inline-flex items-center gap-1 rounded-md bg-panel px-1.5 py-0.5 text-[11px] text-faint" title={`Install "${a.command}" to use ${a.name}`}>
                    <AgentBadge kind={a.kind} size={13} />
                    {AGENTS[a.kind].name}
                  </span>
                ))}
              </div>
            </>
          )}
          <MenuDivider />
          <MenuItem
            icon={<Users size={14} />}
            label="Start a crew…"
            hint="several at once"
            onClick={() => {
              close()
              useUi.getState().openOverlay('launchset')
            }}
          />
          <MenuItem
            icon={<FolderOpen size={14} />}
            label="Change project folder"
            hint={workspace?.name}
            onClick={() => {
              close()
              void pickWorkspace()
            }}
          />
        </div>
      )}
    </Popover>
  )
}

export function Toolbar({ gridSize }: { gridSize: { width: number; height: number } }): React.JSX.Element {
  const { sidePanel, toggleSidePanel, openOverlay, sidebarOpen, sidebarTab, setSidebarTab, setSidebarOpen } = useUi()
  const previewOn = sidebarOpen && sidebarTab === 'preview'
  const onPanel = (id: SidePanel): void => {
    if (id !== 'browser') return toggleSidePanel(id)
    if (previewOn) setSidebarOpen(false)
    else setSidebarTab('preview')
  }
  const waiting = useSessions((s) => Object.values(s.sessions).filter((x) => x.status.state === 'waiting').length)
  const live = useSessions((s) => Object.values(s.sessions).filter((x) => x.status.state !== 'done' && x.status.state !== 'failed').length)
  const w = gridSize.width
  // First the panel tabs lose their words, then at the very narrowest the gaps tighten and the
  // divider goes, so the row never clips a control at the 960px minimum window width.
  const showTabLabels = w >= 1080
  const tight = w < 760
  return (
    <div className={cx('@container flex h-[46px] shrink-0 items-center px-3', tight ? 'gap-1' : 'gap-2')} data-testid="code-toolbar">
      <LayoutMenu gridSize={gridSize} />
      <Button
        variant="subtle"
        size="sm"
        onClick={() => openOverlay('inbox')}
        data-testid="inbox-button"
        className={cx(waiting > 0 && 'border-st-waiting/40 text-st-waiting')}
      >
        <BellRing size={13} />
        Inbox
        {waiting > 0 && <span className="rounded-full bg-st-waiting px-1.5 text-[10px] font-bold text-black">{waiting}</span>}
      </Button>
      {!tight && <div className="mx-1 h-5 w-px bg-line" />}
      <div className="flex items-center gap-0.5 rounded-lg border border-line bg-panel p-[3px]" role="group" aria-label="Show beside the panes">
        {PANELS.map((p) => (
          <Button
            key={p.id}
            size="sm"
            data-testid={`panel-${p.id}`}
            active={p.id === 'browser' ? previewOn : sidePanel === p.id}
            onClick={() => onPanel(p.id)}
            className="h-[26px]"
            {...(showTabLabels ? {} : { title: p.label, 'aria-label': p.label })}
          >
            {p.icon}
            {showTabLabels && p.label}
          </Button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="subtle"
          size="sm"
          title="Dictate into the focused pane (Cmd+Shift+Space)"
          aria-label="Dictate"
          data-testid="dictate-button"
          onClick={() => toggleDictation()}
        >
          <Mic size={13} />
          <span className="@max-[720px]:hidden">Dictate</span>
        </Button>
        <Button
          variant="subtle"
          size="sm"
          title="Broadcast"
          aria-label="Broadcast"
          onClick={() => openOverlay('broadcast')}
          disabled={live < 1}
          data-testid="broadcast-button"
        >
          <Radio size={13} />
          <span className="@max-[720px]:hidden">Broadcast</span>
        </Button>
        <NewPaneMenu />
      </div>
    </div>
  )
}
