// Approval card for a write request in Chat mode.

import type { Conversation, WriteRequest } from '@shared/chat'
import { AlertTriangle } from 'lucide-react'
import { Button } from '../../components/ui'
import { basename } from '../../lib/format'
import { useChat } from '../../store/chat'

export function ChatWriteRequest({
  conversation,
  pending,
  onApprove,
  onDeny
}: {
  conversation: Conversation
  pending: WriteRequest
  onApprove: (id: string, requestId: string) => void
  onDeny: (id: string, requestId: string) => void
}): React.JSX.Element {
  const folder = basename(conversation.cwd) || conversation.cwd || '.'

  const handleApprove = (): void => {
    if (!pending.id) return
    if (onApprove.length >= 2) {
      onApprove(conversation.id, pending.id)
      return
    }
    void useChat.getState().approve(conversation.id, pending.id)
  }

  const handleDeny = (): void => {
    if (!pending.id) return
    if (onDeny.length >= 2) {
      onDeny(conversation.id, pending.id)
      return
    }
    void useChat.getState().deny(conversation.id, pending.id)
  }

  return (
    <div
      data-testid="chat-write-request"
      data-request-id={pending.id}
      className="my-3 space-y-3 rounded-xl border border-st-waiting/40 bg-st-waiting/[0.08] p-4"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-st-waiting/50 bg-st-waiting/20 px-2.5 py-0.5 text-[11px] font-medium text-st-waiting">
          <AlertTriangle size={12} />
          Workspace write
        </span>
        <span className="truncate font-mono text-[12px] text-muted">Target: {folder}</span>
      </div>

      <p className="text-[12.5px] leading-relaxed text-fg">{pending.summary}</p>

      <details className="group text-[12px]">
        <summary className="cursor-pointer font-medium text-muted select-none transition-colors hover:text-fg">
          Review the exact request
        </summary>
        <div className="mt-2 rounded-lg border border-line bg-panel p-2.5 font-mono text-[11.5px] whitespace-pre-wrap text-fg">
          {pending.request}
        </div>
      </details>

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="accent"
          size="sm"
          data-testid="chat-approve"
          onClick={handleApprove}
        >
          Approve workspace edits
        </Button>
        <Button variant="subtle" size="sm" data-testid="chat-deny" onClick={handleDeny}>
          Deny
        </Button>
      </div>
    </div>
  )
}
