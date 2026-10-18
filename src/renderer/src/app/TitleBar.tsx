// The title bar: logo and workspace toggle, the five modes, and the right-side controls.
//
// The three groups sit in a grid, so they never overlap: the mode tabs take the middle column and the
// two outer columns get an equal share, which keeps the tabs centered in the window at every width.
// Below 1180 px the tabs keep their icons and drop their words, which is the first thing to give way,
// so every control stays whole and inside the bar from the minimum window width (960 px) up.

import { useEffect, useState } from 'react'
import {
  Bell,
  Clapperboard,
  Ellipsis,
  MessagesSquare,
  Moon,
  PanelLeft,
  PanelRight,
  Search,
  ShipWheel,
  SquareKanban,
  SquareTerminal,
  Users,
  Workflow,
  type LucideIcon
} from 'lucide-react'
import type { Prefs } from '@shared/types'
import { bridge } from '../lib/bridge'
import { useSessions } from '../store/sessions'
import { useUi, type Mode } from '../store/ui'
import { Logo } from '../components/marks'
import { Button, IconButton, Kbd, cx } from '../components/ui'

const MODES: { id: Mode; label: string; key: string; icon: LucideIcon; lab?: 'board' }[] = [
  { id: 'agents', label: 'Agents', key: '1', icon: Users },
  { id: 'code', label: 'Code', key: '2', icon: SquareTerminal },
  { id: 'chat', label: 'Chat', key: '3', icon: MessagesSquare },
  { id: 'flows', label: 'Flows', key: '4', icon: Workflow },
  { id: 'video', label: 'Video', key: '5', icon: Clapperboard },
  { id: 'board', label: 'Board', key: '6', icon: SquareKanban, lab: 'board' }
]

export function TitleBar(): React.JSX.Element {
  const { mode, setMode, sidebarOpen, setSidebarOpen, openOverlay, overlay } = useUi()
  const workspace = useSessions((s) => s.workspace)
  const waiting = useSessions((s) => Object.values(s.sessions).filter((x) => x.status.state === 'waiting').length)
  const isMac = window.regatta.platform === 'darwin'

  // The Board tab shows only once its Labs switch is on.
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  useEffect(() => {
    let alive = true
    void bridge
      .invoke('prefs:get')
      .then((next) => alive && setPrefs(next))
      .catch(() => undefined)
    const off = bridge.on('prefs:changed', (next) => alive && setPrefs(next))
    return () => {
      alive = false
      off()
    }
  }, [])
  const visibleModes = MODES.filter((m) => !m.lab || prefs?.labs[m.lab])

  return (
    <header
      data-testid="title-bar"
      className="drag grid h-[50px] shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-line bg-chrome"
    >
      <div className="flex items-center gap-2" style={{ paddingLeft: isMac ? 84 : 12 }}>
        <Logo size={22} />
        <span className="text-[14px] font-semibold tracking-[-0.01em]">Regatta</span>
        <IconButton className="ml-1" title="Workspace sidebar" aria-label="Toggle workspace sidebar">
          <PanelLeft size={15} />
        </IconButton>
      </div>

      <nav className="no-drag flex items-center gap-0.5 rounded-[10px] border border-line bg-panel p-[3px]" aria-label="Modes">
        {visibleModes.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            data-testid={`mode-${m.id}`}
            title={`${m.label} (⌘${m.key})`}
            aria-label={m.label}
            className={cx(
              'relative flex h-[28px] w-8 items-center justify-center rounded-[7px] text-[12.5px] font-medium transition-all duration-200',
              'min-[1180px]:w-auto min-[1180px]:min-w-[76px] min-[1180px]:gap-1.5 min-[1180px]:px-3',
              mode === m.id
                ? 'bg-accent/[0.13] text-accent-bright shadow-[inset_0_0_0_1px_rgba(45,212,191,0.32)]'
                : 'text-muted hover:text-fg hover:bg-hover'
            )}
          >
            <m.icon size={14} />
            <span className="hidden min-[1180px]:inline">{m.label}</span>
          </button>
        ))}
      </nav>

      <div className="flex min-w-max items-center justify-end gap-1.5 pr-3">
        <IconButton
          title="Night watch: queue tasks to run while you are away"
          active={overlay === 'night'}
          onClick={() => openOverlay('night')}
          data-testid="night-button"
          aria-label="Night watch"
        >
          <Moon size={14} />
        </IconButton>
        <Button
          variant="outline"
          size="sm"
          title="Skipper: race agents on a task or hand it off, and get back checked work"
          className="gap-1.5"
          active={overlay === 'skipper'}
          onClick={() => openOverlay('skipper')}
          data-testid="skipper-button"
        >
          <ShipWheel size={14} className="text-accent" />
          Skipper
        </Button>
        <button
          type="button"
          onClick={() => openOverlay('quick')}
          className="no-drag flex h-7 w-[150px] items-center gap-2 rounded-md border border-line bg-panel px-2 text-[12px] text-faint transition-colors hover:border-line-strong hover:text-muted"
        >
          <Search size={13} />
          <span className="flex-1 text-left">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
        <IconButton title="More" aria-label="More">
          <Ellipsis size={16} />
        </IconButton>
        <span
          className="no-drag flex h-[26px] w-[26px] items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-fg"
          title={workspace?.root ?? ''}
        >
          {(workspace?.name ?? 'R').slice(0, 1).toUpperCase()}
        </span>
        <IconButton title="Inbox" aria-label="Inbox" onClick={() => openOverlay('inbox')} className="relative">
          <Bell size={15} />
          {waiting > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-st-waiting px-1 text-[9.5px] font-bold text-black">
              {waiting}
            </span>
          )}
        </IconButton>
        <IconButton
          title={sidebarOpen ? 'Hide the right sidebar' : 'Show the right sidebar'}
          aria-label="Toggle right sidebar"
          active={sidebarOpen}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <PanelRight size={15} />
        </IconButton>
      </div>
    </header>
  )
}
