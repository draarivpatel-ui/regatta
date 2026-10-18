// Chat mode: talk a problem through before anything runs.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Access, ChatAgent, Conversation } from '@shared/chat'
import { CHAT_AGENTS } from '@shared/chat'
import { AGENTS } from '@shared/agents'
import { useChat } from '../../store/chat'
import { useSessions } from '../../store/sessions'
import { ChatList } from './ChatList'
import { ChatHeader } from './ChatHeader'
import { ChatTranscript } from './ChatTranscript'
import { ChatComposer } from './ChatComposer'

function isActive(c: Conversation): boolean {
  return c.status === 'running' || c.pending !== null
}

export function ChatMode(): React.JSX.Element {
  const conversations = useChat((s) => s.conversations)
  const chatError = useChat((s) => s.error)
  const clearError = useChat((s) => s.clearError)
  const create = useChat((s) => s.create)
  const send = useChat((s) => s.send)
  const stop = useChat((s) => s.stop)
  const approve = useChat((s) => s.approve)
  const deny = useChat((s) => s.deny)
  const remove = useChat((s) => s.remove)
  const update = useChat((s) => s.update)
  const agents = useSessions((s) => s.agents)
  const workspace = useSessions((s) => s.workspace)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draftAgent, setDraftAgent] = useState<ChatAgent>('claude')
  const [draftModel, setDraftModel] = useState('')
  const [draftAccess, setDraftAccess] = useState<Access>('read')
  const draftInit = useRef(false)

  useEffect(() => {
    void useChat.getState().load()
  }, [])

  const installedKinds = useMemo<ChatAgent[]>(() => {
    const installed = agents.filter(
      (a) => (CHAT_AGENTS as readonly string[]).includes(a.kind) && a.installed
    )
    const kinds = installed.map((a) => a.kind as ChatAgent)
    return kinds.length > 0 ? kinds : [...CHAT_AGENTS]
  }, [agents])

  useEffect(() => {
    if (draftInit.current) return
    if (agents.length === 0) return
    draftInit.current = true
    const claudeInstalled = agents.some((a) => a.kind === 'claude' && a.installed)
    if (claudeInstalled) {
      setDraftAgent('claude')
    } else if (installedKinds.length > 0) {
      setDraftAgent(installedKinds[0]!)
    }
  }, [agents, installedKinds])

  const chats = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => !c.teammateId)
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt),
    [conversations]
  )
  const activeChats = useMemo(() => chats.filter(isActive), [chats])
  const earlierChats = useMemo(() => chats.filter((c) => !isActive(c)), [chats])

  useEffect(() => {
    if (chats.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !chats.some((c) => c.id === selectedId)) {
      setSelectedId(chats[0]!.id)
    }
  }, [chats, selectedId])

  const activeChat = selectedId ? (conversations[selectedId] ?? null) : null

  const installedFor = (agent: ChatAgent): boolean =>
    agents.some((a) => a.kind === agent && a.installed)

  const handleNew = async (): Promise<void> => {
    const created = await create({
      agent: draftAgent,
      model: draftModel,
      access: draftAccess,
      cwd: workspace?.root
    })
    if (created) setSelectedId(created.id)
  }

  const handleSend = async (text: string): Promise<void> => {
    if (activeChat) {
      await send(activeChat.id, text)
      return
    }
    const created = await create({
      agent: draftAgent,
      model: draftModel,
      access: draftAccess,
      cwd: workspace?.root
    })
    if (created) {
      setSelectedId(created.id)
      await send(created.id, text)
    }
  }

  const handleStop = (): void => {
    if (activeChat) void stop(activeChat.id)
  }

  const handleApprove = (id: string, requestId: string): void => {
    void approve(id, requestId)
  }

  const handleDeny = (id: string, requestId: string): void => {
    void deny(id, requestId)
  }

  const handleRemove = (id: string): void => {
    void remove(id)
  }

  const handleRename = async (title: string): Promise<void> => {
    if (activeChat) await update(activeChat.id, { title })
  }

  const handleUpdate = async (patch: {
    title?: string
    model?: string
    agent?: Conversation['agent']
    access?: Access
  }): Promise<void> => {
    if (activeChat) await update(activeChat.id, patch)
  }

  const headerAgent = activeChat?.agent ?? draftAgent
  void AGENTS

  return (
    <div data-testid="chat-mode" className="flex h-full min-h-0 flex-1 overflow-hidden">
      <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-line bg-chrome">
        <ChatList
          active={activeChats}
          earlier={earlierChats}
          selectedId={activeChat?.id ?? null}
          onSelect={setSelectedId}
          onNew={() => void handleNew()}
          onRemove={handleRemove}
        />
      </aside>
      <section className="flex h-full min-w-0 flex-1 flex-col bg-bg">
        <ChatHeader
          conversation={activeChat}
          agentName={AGENTS[headerAgent]?.name ?? headerAgent}
          installed={installedFor(headerAgent)}
          onRename={(title) => void handleRename(title)}
        />
        <ChatTranscript
          conversation={activeChat}
          onApprove={handleApprove}
          onDeny={handleDeny}
        />
        {chatError && (
          <div className="shrink-0 border-t border-line bg-chrome/60 px-6 py-2">
            <p
              role="alert"
              className="flex items-center justify-between gap-3 text-[12px] text-st-failed"
            >
              <span className="min-w-0 flex-1 truncate">{chatError}</span>
              <button
                type="button"
                onClick={clearError}
                aria-label="Dismiss error"
                className="shrink-0 text-muted hover:text-fg"
              >
                Dismiss
              </button>
            </p>
          </div>
        )}
        <ChatComposer
          conversation={activeChat}
          availableAgents={installedKinds}
          draftAgent={draftAgent}
          draftModel={draftModel}
          draftAccess={draftAccess}
          onDraftChange={(patch) => {
            if (patch.agent !== undefined) setDraftAgent(patch.agent)
            if (patch.model !== undefined) setDraftModel(patch.model)
            if (patch.access !== undefined) setDraftAccess(patch.access)
          }}
          onSend={handleSend}
          onStop={handleStop}
          onUpdate={handleUpdate}
        />
      </section>
    </div>
  )
}
