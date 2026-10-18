// Chat list: new chat button, active conversations first, then earlier ones.

import { Plus, X } from 'lucide-react'
import type { Conversation } from '@shared/chat'
import { Button, cx } from '../../components/ui'

function dotClass(c: Conversation): string {
  if (c.pending) return 'bg-st-waiting'
  if (c.status === 'running') return 'bg-st-working animate-breathe'
  if (c.status === 'error') return 'bg-st-failed'
  return 'bg-st-idle'
}

function Row({
  conversation,
  selected,
  onSelect,
  onRemove
}: {
  conversation: Conversation
  selected: boolean
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="chat-row"
      data-status={conversation.status}
      data-agent={conversation.agent}
      onClick={() => onSelect(conversation.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(conversation.id)
        }
      }}
      className={cx(
        'group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors duration-150',
        selected ? 'bg-press text-fg' : 'text-muted hover:bg-hover hover:text-fg'
      )}
    >
      <span
        aria-hidden="true"
        className={cx('h-[7px] w-[7px] shrink-0 rounded-full', dotClass(conversation))}
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">
        {conversation.title}
      </span>
      <button
        type="button"
        aria-label="Remove chat"
        title="Remove chat"
        onClick={(e) => {
          e.stopPropagation()
          onRemove(conversation.id)
        }}
        className="shrink-0 rounded p-0.5 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-st-failed focus:opacity-100"
      >
        <X size={13} />
      </button>
    </div>
  )
}

export function ChatList({
  active,
  earlier,
  selectedId,
  onSelect,
  onNew,
  onRemove
}: {
  active: Conversation[]
  earlier: Conversation[]
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h1 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Chats</h1>
        <Button variant="subtle" size="sm" data-testid="chat-new" onClick={onNew}>
          <Plus size={13} strokeWidth={2.4} />
          New chat
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {active.length === 0 && earlier.length === 0 ? (
          <div className="px-2 py-6 text-center">
            <p className="text-[12.5px] font-medium text-fg">No chats yet</p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              Start a new chat to talk through a change before it runs.
            </p>
          </div>
        ) : (
          <>
            {active.length > 0 && (
              <div>
                <p className="px-2 pt-1 pb-1 text-[11px] font-medium text-faint">Active</p>
                <div className="space-y-0.5">
                  {active.map((c) => (
                    <Row
                      key={c.id}
                      conversation={c}
                      selected={c.id === selectedId}
                      onSelect={onSelect}
                      onRemove={onRemove}
                    />
                  ))}
                </div>
              </div>
            )}
            {earlier.length > 0 && (
              <div className={active.length > 0 ? 'mt-3' : undefined}>
                <p className="px-2 pt-1 pb-1 text-[11px] font-medium text-faint">Earlier</p>
                <div className="space-y-0.5">
                  {earlier.map((c) => (
                    <Row
                      key={c.id}
                      conversation={c}
                      selected={c.id === selectedId}
                      onSelect={onSelect}
                      onRemove={onRemove}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
