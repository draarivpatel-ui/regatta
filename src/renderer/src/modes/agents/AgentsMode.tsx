// Agents mode: crew members with instructions and memory.
// Every turn reads first; changes to files need the user's approval.

import { useEffect, useRef, useState } from 'react'
import type { Teammate } from '@shared/chat'
import { CalendarClock, ListChecks, MoreHorizontal, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useChat } from '../../store/chat'
import { useSessions } from '../../store/sessions'
import { Button, IconButton, MenuItem, Popover, cx } from '../../components/ui'
import { PixelAvatar } from './PixelAvatar'
import { CrewModal } from './CrewModal'
import { Transcript } from './Transcript'
import { Composer } from './Composer'
import { SchedulesView } from './automate/SchedulesView'
import { TasksView } from './automate/TasksView'

export function AgentsMode(): React.JSX.Element {
  const conversations = useChat((s) => s.conversations)
  const teammates = useChat((s) => s.teammates)
  const create = useChat((s) => s.create)
  const send = useChat((s) => s.send)
  const stop = useChat((s) => s.stop)
  const remove = useChat((s) => s.remove)
  const saveTeammate = useChat((s) => s.saveTeammate)
  const deleteTeammate = useChat((s) => s.deleteTeammate)
  const workspace = useSessions((s) => s.workspace)

  const [selectedTeammateId, setSelectedTeammateId] = useState<string | null>(null)
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingTeammate, setEditingTeammate] = useState<Teammate | null>(null)
  // Tasks or Schedules replace the crew view while chosen in the Automate list.
  const [automate, setAutomate] = useState<'tasks' | 'schedules' | null>(null)

  // Load chats and teammates on first mount
  useEffect(() => {
    void useChat.getState().load()
  }, [])

  // Auto-select first teammate if none selected
  useEffect(() => {
    if (teammates.length > 0) {
      if (!selectedTeammateId || !teammates.some((t) => t.id === selectedTeammateId)) {
        setSelectedTeammateId(teammates[0]!.id)
      }
    } else {
      setSelectedTeammateId(null)
    }
  }, [teammates, selectedTeammateId])

  const selectedTeammate = teammates.find((t) => t.id === selectedTeammateId) ?? null

  // Chats belonging to the current crew member
  const currentChats = selectedTeammate
    ? Object.values(conversations)
        .filter((c) => c.teammateId === selectedTeammate.id)
        .sort((a, b) => a.createdAt - b.createdAt)
    : []

  // Ensure selected teammate has at least one initial conversation
  const createdInitialFor = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!selectedTeammate) return
    if (createdInitialFor.current.has(selectedTeammate.id)) return
    const existing = Object.values(conversations).filter((c) => c.teammateId === selectedTeammate.id)
    if (existing.length === 0) {
      createdInitialFor.current.add(selectedTeammate.id)
      void create({
        teammateId: selectedTeammate.id,
        agent: selectedTeammate.agent,
        access: 'read',
        cwd: workspace?.root
      })
    }
  }, [selectedTeammate?.id, conversations, create, workspace?.root])

  const activeChat =
    currentChats.find((c) => c.id === selectedChatId) ??
    currentChats[currentChats.length - 1] ??
    null

  const handleNewChat = async (): Promise<void> => {
    if (!selectedTeammate) return
    const created = await create({
      teammateId: selectedTeammate.id,
      agent: selectedTeammate.agent,
      access: 'read',
      cwd: workspace?.root
    })
    if (created) {
      setSelectedChatId(created.id)
    }
  }

  const handleSend = async (text: string): Promise<void> => {
    if (!selectedTeammate) return
    let chatId = activeChat?.id
    if (!chatId) {
      const created = await create({
        teammateId: selectedTeammate.id,
        agent: selectedTeammate.agent,
        access: 'read',
        cwd: workspace?.root
      })
      if (created) {
        chatId = created.id
        setSelectedChatId(chatId)
      }
    }
    if (chatId) {
      await send(chatId, text, 'read')
    }
  }

  const handleDeleteTeammate = async (id: string): Promise<void> => {
    await deleteTeammate(id)
    if (selectedTeammateId === id) {
      const remaining = teammates.filter((t) => t.id !== id)
      setSelectedTeammateId(remaining[0]?.id ?? null)
    }
  }

  return (
    <div data-testid="agents-mode" className="flex flex-1 min-h-0 h-full overflow-hidden">
      {/* Left sidebar: Crew list (280px) */}
      <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-line bg-chrome">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h1 className="text-[14px] font-semibold text-fg tracking-[-0.01em]">Crew</h1>
          <Button
            variant="subtle"
            size="sm"
            data-testid="crew-new"
            onClick={() => {
              setEditingTeammate(null)
              setModalOpen(true)
            }}
          >
            <Plus size={13} strokeWidth={2.4} />
            New crew member
          </Button>
        </div>

        {teammates.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-panel text-accent">
              <Users size={20} />
            </div>
            <h3 className="text-[13px] font-medium text-fg">No crew members</h3>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              Crew members are teammates with instructions and memory. Every turn reads first; changes to files need your approval.
            </p>
            <div className="mt-4">
              <Button
                variant="accent"
                size="sm"
                onClick={() => {
                  setEditingTeammate(null)
                  setModalOpen(true)
                }}
              >
                <Plus size={13} strokeWidth={2.4} />
                New crew member
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {teammates.map((t) => {
              const isSelected = t.id === selectedTeammateId
              return (
                <button
                  key={t.id}
                  type="button"
                  data-testid="crew-card"
                  data-selected={isSelected ? 'true' : 'false'}
                  onClick={() => {
                    setSelectedTeammateId(t.id)
                    setSelectedChatId(null)
                    setAutomate(null)
                  }}
                  className={cx(
                    'flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition-all duration-150',
                    isSelected
                      ? 'bg-raised border border-line-strong shadow-md text-fg'
                      : 'hover:bg-hover text-muted hover:text-fg border border-transparent'
                  )}
                >
                  <PixelAvatar name={t.name} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className={cx('text-[12.5px] font-medium truncate', isSelected ? 'text-fg' : 'text-fg/90')}>
                      {t.name}
                    </p>
                    <p className="text-[11.5px] text-muted truncate mt-0.5">
                      {t.role || 'Crew member'}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        <div className="shrink-0 border-t border-line p-2">
          <p className="px-2 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">Automate</p>
          {(
            [
              { id: 'tasks', label: 'Tasks', icon: <ListChecks size={14} /> },
              { id: 'schedules', label: 'Schedules', icon: <CalendarClock size={14} /> }
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`automate-${item.id}`}
              aria-current={automate === item.id ? 'true' : undefined}
              onClick={() => setAutomate(item.id)}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-150',
                automate === item.id ? 'bg-press text-fg' : 'text-muted hover:bg-hover hover:text-fg'
              )}
            >
              <span className={cx('flex w-5 justify-center', automate === item.id ? 'text-accent-bright' : 'text-faint')}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      </aside>

      {/* Right panel: Active teammate header, tabs, transcript, composer */}
      <section className="flex flex-1 flex-col min-w-0 h-full bg-bg">
        {automate === 'schedules' ? (
          <SchedulesView />
        ) : automate === 'tasks' ? (
          <TasksView />
        ) : selectedTeammate ? (
          <>
            {/* Header: avatar, name, role and menu */}
            <header className="flex items-center justify-between border-b border-line bg-chrome/60 px-6 py-3 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <PixelAvatar name={selectedTeammate.name} size={36} />
                <div className="min-w-0">
                  <h2 className="text-[14px] font-semibold text-fg tracking-[-0.01em] truncate">
                    {selectedTeammate.name}
                  </h2>
                  <p className="text-[11.5px] text-muted truncate">
                    {selectedTeammate.role || 'Crew member'}
                  </p>
                </div>
              </div>

              <Popover
                align="end"
                width={180}
                button={({ open, toggle }) => (
                  <IconButton
                    active={open}
                    onClick={toggle}
                    title="Crew member options"
                    aria-label="Crew member options"
                  >
                    <MoreHorizontal size={15} />
                  </IconButton>
                )}
              >
                {(close) => (
                  <div>
                    <MenuItem
                      icon={<Pencil size={13} />}
                      label="Edit"
                      onClick={() => {
                        close()
                        setEditingTeammate(selectedTeammate)
                        setModalOpen(true)
                      }}
                    />
                    <MenuItem
                      danger
                      icon={<Trash2 size={13} />}
                      label="Delete"
                      onClick={() => {
                        close()
                        void handleDeleteTeammate(selectedTeammate.id)
                      }}
                    />
                  </div>
                )}
              </Popover>
            </header>

            {/* Tabs for teammate's conversations */}
            <div className="flex items-center gap-1 border-b border-line bg-panel/30 px-4 pt-1.5 shrink-0 overflow-x-auto">
              {currentChats.map((c) => {
                const isActive = (activeChat?.id ?? currentChats[0]?.id) === c.id
                return (
                  <div
                    key={c.id}
                    className={cx(
                      'group flex items-center gap-2 rounded-t-lg border-t border-x px-3 py-1.5 text-[12px] font-medium transition-colors cursor-pointer',
                      isActive
                        ? 'border-line-strong bg-bg text-fg -mb-px pb-2 shadow-sm'
                        : 'border-transparent text-muted hover:text-fg hover:bg-hover'
                    )}
                    onClick={() => setSelectedChatId(c.id)}
                  >
                    <span className="truncate max-w-[130px]">{c.title}</span>
                    {currentChats.length > 1 && (
                      <button
                        type="button"
                        aria-label="Close conversation"
                        className="opacity-0 group-hover:opacity-100 hover:text-st-failed rounded p-0.5 text-muted transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation()
                          void remove(c.id)
                        }}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                )
              })}

              <button
                type="button"
                data-testid="crew-new-chat"
                onClick={() => void handleNewChat()}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:text-fg hover:bg-hover transition-colors ml-0.5 mb-1"
                title="New conversation"
                aria-label="New conversation"
              >
                <Plus size={14} />
              </button>
            </div>

            {/* Transcript */}
            <Transcript
              conversation={activeChat}
              teammate={selectedTeammate}
            />

            {/* Composer */}
            <Composer
              teammate={selectedTeammate}
              isRunning={activeChat?.status === 'running'}
              onSend={handleSend}
              onStop={() => {
                if (activeChat) void stop(activeChat.id)
              }}
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-panel text-faint">
              <Users size={24} />
            </div>
            <h2 className="text-[15px] font-semibold text-fg">No crew member selected</h2>
            <p className="mt-1.5 max-w-[320px] text-[12.5px] leading-relaxed text-muted">
              Select a crew member on the left or create a new one to begin.
            </p>
          </div>
        )}
      </section>

      {/* New or Edit Crew Member Modal */}
      {modalOpen && (
        <CrewModal
          initialTeammate={editingTeammate}
          onClose={() => {
            setModalOpen(false)
            setEditingTeammate(null)
          }}
          onSave={async (fields) => {
            const saved = await saveTeammate(fields)
            if (saved) {
              setSelectedTeammateId(saved.id)
            }
          }}
        />
      )}
    </div>
  )
}
