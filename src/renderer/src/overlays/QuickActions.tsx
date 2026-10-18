// Quick actions (Cmd+K): search every command and place.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Bell,
  Clapperboard,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe,
  LayoutGrid,
  MessagesSquare,
  Moon,
  PanelRight,
  Play,
  Radio,
  Search,
  Settings,
  ShipWheel,
  Smartphone,
  SquareTerminal,
  Users,
  Workflow
} from 'lucide-react'
import { LAYOUTS } from '@shared/layouts'
import { Kbd, cx } from '../components/ui'
import { useSessions } from '../store/sessions'
import { useUi, type Mode, type SidePanel } from '../store/ui'
import { score } from './quick/match'

interface ActionItem {
  id: string
  group: string
  label: string
  icon: ReactNode
  hint?: string
  run: () => void
}

export function QuickActions({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const {
    setMode,
    setLayout,
    toggleSidePanel,
    openOverlay,
    setSidebarOpen,
    sidebarOpen,
    sidebarTab,
    setSidebarTab
  } = useUi()
  const agents = useSessions((s) => s.agents)
  const createSession = useSessions((s) => s.createSession)
  const pickWorkspace = useSessions((s) => s.pickWorkspace)

  const isMac = typeof window !== 'undefined' && window.regatta?.platform === 'darwin'
  const modKey = isMac ? '⌘' : 'Ctrl+'

  const actions: ActionItem[] = useMemo(() => {
    const list: ActionItem[] = []

    // Go to: Agents, Code, Chat, Flows, Video modes (Cmd+1 to Cmd+5)
    const modes: { id: Mode; label: string; key: string; icon: ReactNode }[] = [
      { id: 'agents', label: 'Agents', key: '1', icon: <Users size={15} /> },
      { id: 'code', label: 'Code', key: '2', icon: <SquareTerminal size={15} /> },
      { id: 'chat', label: 'Chat', key: '3', icon: <MessagesSquare size={15} /> },
      { id: 'flows', label: 'Flows', key: '4', icon: <Workflow size={15} /> },
      { id: 'video', label: 'Video', key: '5', icon: <Clapperboard size={15} /> }
    ]
    for (const m of modes) {
      list.push({
        id: `mode-${m.id}`,
        group: 'Go to',
        label: m.label,
        icon: m.icon,
        hint: `${modKey}${m.key}`,
        run: () => setMode(m.id)
      })
    }

    // Start: "Start <agent name>" for every installed agent including Terminal; "Start a crew…"
    const installed = agents.filter((a) => a.installed)
    for (const a of installed) {
      list.push({
        id: `start-${a.kind}`,
        group: 'Start',
        label: `Start ${a.name}`,
        icon: a.kind === 'shell' ? <SquareTerminal size={15} /> : <Play size={15} />,
        run: () => {
          setMode('code')
          void createSession(a.kind)
        }
      })
    }
    list.push({
      id: 'start-crew',
      group: 'Start',
      label: 'Start a crew…',
      icon: <Users size={15} />,
      run: () => openOverlay('launchset')
    })

    // Layout: "Layout: <label>" for every layout in LAYOUTS (calls setLayout(id))
    for (const l of LAYOUTS) {
      list.push({
        id: `layout-${l.id}`,
        group: 'Layout',
        label: `Layout: ${l.label}`,
        icon: <LayoutGrid size={15} />,
        run: () => {
          setMode('code')
          setLayout(l.id)
        }
      })
    }

    // Panels: Files, Find, Git, Preview, Thread, Flows, Device
    const panels: { id: SidePanel; label: string; icon: ReactNode; run: () => void }[] = [
      {
        id: 'files',
        label: 'Files',
        icon: <FolderTree size={15} />,
        run: () => {
          setMode('code')
          toggleSidePanel('files')
        }
      },
      {
        id: 'find',
        label: 'Find',
        icon: <Search size={15} />,
        run: () => {
          setMode('code')
          toggleSidePanel('find')
        }
      },
      {
        id: 'git',
        label: 'Git',
        icon: <GitBranch size={15} />,
        run: () => {
          setMode('code')
          toggleSidePanel('git')
        }
      },
      {
        id: 'browser',
        label: 'Preview',
        icon: <Globe size={15} />,
        run: () => {
          setMode('code')
          if (sidebarOpen && sidebarTab === 'preview') {
            setSidebarOpen(false)
          } else {
            setSidebarTab('preview')
          }
        }
      },
      {
        id: 'thread',
        label: 'Thread',
        icon: <MessagesSquare size={15} />,
        run: () => {
          setMode('code')
          toggleSidePanel('thread')
        }
      },
      {
        id: 'flows',
        label: 'Flows',
        icon: <Workflow size={15} />,
        run: () => {
          setMode('code')
          toggleSidePanel('flows')
        }
      },
      {
        id: 'simulator',
        label: 'Device',
        icon: <Smartphone size={15} />,
        run: () => {
          setMode('code')
          toggleSidePanel('simulator')
        }
      }
    ]
    for (const p of panels) {
      list.push({
        id: `panel-${p.id}`,
        group: 'Panels',
        label: p.label,
        icon: p.icon,
        run: p.run
      })
    }

    // Do: Open the inbox (Cmd+I), Broadcast (Cmd+B), Skipper, Night watch, Settings (Cmd+,), Change project folder, Show or hide the right sidebar
    list.push({
      id: 'do-inbox',
      group: 'Do',
      label: 'Open the inbox',
      icon: <Bell size={15} />,
      hint: `${modKey}I`,
      run: () => openOverlay('inbox')
    })
    list.push({
      id: 'do-broadcast',
      group: 'Do',
      label: 'Broadcast',
      icon: <Radio size={15} />,
      hint: `${modKey}B`,
      run: () => openOverlay('broadcast')
    })
    list.push({
      id: 'do-skipper',
      group: 'Do',
      label: 'Skipper: race agents or hand off a task',
      icon: <ShipWheel size={15} />,
      run: () => openOverlay('skipper')
    })
    list.push({
      id: 'do-night',
      group: 'Do',
      label: 'Night watch',
      icon: <Moon size={15} />,
      run: () => openOverlay('night')
    })
    list.push({
      id: 'do-settings',
      group: 'Do',
      label: 'Settings',
      icon: <Settings size={15} />,
      hint: `${modKey},`,
      run: () => openOverlay('settings')
    })
    list.push({
      id: 'do-workspace',
      group: 'Do',
      label: 'Change project folder',
      icon: <FolderOpen size={15} />,
      run: () => void pickWorkspace()
    })
    list.push({
      id: 'do-sidebar',
      group: 'Do',
      label: 'Show or hide the right sidebar',
      icon: <PanelRight size={15} />,
      run: () => setSidebarOpen(!sidebarOpen)
    })

    return list
  }, [
    agents,
    createSession,
    modKey,
    openOverlay,
    pickWorkspace,
    setLayout,
    setMode,
    setSidebarOpen,
    setSidebarTab,
    sidebarOpen,
    sidebarTab,
    toggleSidePanel
  ])

  const filteredItems = useMemo(() => {
    const scored: { item: ActionItem; score: number }[] = []
    for (const item of actions) {
      const s = score(query, item.label)
      if (s !== null) {
        scored.push({ item, score: s })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.map((s) => s.item)
  }, [actions, query])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.querySelector<HTMLElement>('[aria-selected="true"]')
      if (el) {
        el.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [selectedIndex])

  const runAction = (item: ActionItem): void => {
    onClose()
    item.run()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filteredItems.length > 0) {
        setSelectedIndex((prev) => (prev + 1) % filteredItems.length)
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (filteredItems.length > 0) {
        setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = filteredItems[selectedIndex]
      if (item) {
        runAction(item)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/45 pt-[12vh] backdrop-blur-[2px] animate-fade-in"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-testid="quick-actions"
        style={{ width: 580 }}
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[76vh] overflow-hidden rounded-2xl border border-line-strong bg-raised shadow-[0_30px_80px_-20px_rgba(0,0,0,0.85)] animate-dialog-in flex flex-col"
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Search size={16} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            autoFocus
            data-testid="quick-input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search actions and places…"
            className="w-full bg-transparent text-[13.5px] text-fg placeholder:text-faint outline-none"
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2" role="listbox">
          {filteredItems.length === 0 ? (
            <div className="py-8 text-center text-[12.5px] text-muted">No matches</div>
          ) : (
            filteredItems.map((item, idx) => {
              const isFirstInGroup = idx === 0 || item.group !== filteredItems[idx - 1]?.group
              const isSelected = idx === selectedIndex
              return (
                <div key={item.id}>
                  {isFirstInGroup && (
                    <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-faint">
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    data-testid="quick-item"
                    aria-selected={isSelected}
                    onClick={() => runAction(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={cx(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                      isSelected ? 'bg-hover text-fg' : 'text-fg/90 hover:bg-hover'
                    )}
                  >
                    <span className="flex w-5 shrink-0 justify-center text-muted">{item.icon}</span>
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.hint && (
                      <span className="shrink-0">
                        <Kbd>{item.hint}</Kbd>
                      </span>
                    )}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
