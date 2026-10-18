// Chat header: title (click to rename) and the agent with its install state.

import { useEffect, useState } from 'react'
import type { Conversation } from '@shared/chat'
import { AgentBadge } from '../../components/marks'

export function ChatHeader({
  conversation,
  agentName,
  installed,
  onRename
}: {
  conversation: Conversation | null
  agentName: string
  installed: boolean
  onRename: (title: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conversation?.title ?? 'New chat')

  useEffect(() => {
    setEditing(false)
    setDraft(conversation?.title ?? 'New chat')
  }, [conversation?.id, conversation?.title])

  const save = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (conversation && next && next !== conversation.title) onRename(next)
    else setDraft(conversation?.title ?? 'New chat')
  }

  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-chrome/60 px-6 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {editing ? (
          <input
            data-testid="chat-title-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') {
                setEditing(false)
                setDraft(conversation?.title ?? 'New chat')
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-line-strong bg-panel px-2 py-1 text-[14px] font-semibold text-fg outline-none focus:border-accent/60"
          />
        ) : (
          <button
            type="button"
            data-testid="chat-title"
            title="Click to rename"
            onClick={() => conversation && setEditing(true)}
            className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold tracking-[-0.01em] text-fg"
          >
            {conversation?.title ?? 'New chat'}
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {conversation && <AgentBadge kind={conversation.agent} size={18} />}
        <span className="text-[12px] text-muted">{agentName}</span>
        {installed && <span className="text-[11.5px] font-medium text-st-idle">found</span>}
      </div>
    </header>
  )
}
