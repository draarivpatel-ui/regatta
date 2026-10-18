// Approval card for a write request in Agents mode.

import type { Conversation, WriteRequest } from '@shared/chat'
import { AlertTriangle } from 'lucide-react'
import { Button } from '../../components/ui'
import { basename } from '../../lib/format'
import { useChat } from '../../store/chat'

interface ApprovalCardProps {
  conversation: Conversation
  pending: WriteRequest
}

export function ApprovalCard({
  conversation,
  pending
}: ApprovalCardProps): React.JSX.Element {
  const folder = basename(conversation.cwd) || conversation.cwd

  const handleApprove = (): void => {
    if (!pending.id) return
    void useChat.getState().approve(conversation.id, pending.id)
  }

  const handleDeny = (): void => {
    if (!pending.id) return
    void useChat.getState().deny(conversation.id, pending.id)
  }

  return (
    <div
      data-testid="crew-write-request"
      data-request-id={pending.id}
      className="my-3 rounded-xl border border-st-waiting/40 bg-st-waiting/[0.08] p-4 space-y-3"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-st-waiting/50 bg-st-waiting/20 px-2.5 py-0.5 text-[11px] font-medium text-st-waiting">
          <AlertTriangle size={12} />
          Workspace write
        </span>
        <span className="text-[12px] font-mono text-muted truncate">
          Target: {folder}
        </span>
      </div>

      <p className="text-[12.5px] leading-relaxed text-fg">
        This reruns the request with permission to edit files here. The agent picks the individual edits during that run.
      </p>

      <details className="text-[12px] group">
        <summary className="cursor-pointer font-medium text-muted hover:text-fg select-none transition-colors">
          Review the exact request
        </summary>
        <div className="mt-2 rounded-lg border border-line bg-panel p-2.5 font-mono text-[11.5px] text-fg whitespace-pre-wrap">
          {pending.request}
        </div>
      </details>

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="accent"
          size="sm"
          data-testid="crew-approve"
          onClick={handleApprove}
        >
          Approve workspace edits
        </Button>
        <Button
          variant="subtle"
          size="sm"
          data-testid="crew-deny"
          onClick={handleDeny}
        >
          Deny
        </Button>
      </div>
    </div>
  )
}
