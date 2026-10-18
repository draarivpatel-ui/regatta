// Transcript for Agents mode: message bubbles, tool runs, running state, and approval cards.

import { useEffect, useRef } from 'react'
import type { Conversation, Teammate } from '@shared/chat'
import { Wrench } from 'lucide-react'
import { PixelAvatar } from './PixelAvatar'
import { ApprovalCard } from './ApprovalCard'
import { StatusDot } from '../../components/marks'

interface TranscriptProps {
  conversation: Conversation | null
  teammate: Teammate
}

function toolLabel(text: string): string {
  if (text.startsWith('Edit ')) {
    return `Edited ${text.slice(5)}`
  }
  return text
}

export function Transcript({
  conversation,
  teammate
}: TranscriptProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [conversation?.messages, conversation?.pending, conversation?.status])

  if (!conversation || (conversation.messages.length === 0 && !conversation.pending)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <PixelAvatar name={teammate.name} size={44} />
        <h3 className="mt-3 text-[14px] font-semibold text-fg">{teammate.name}</h3>
        <p className="mt-1 max-w-[340px] text-[12px] leading-relaxed text-muted">
          {teammate.instructions || `Ask ${teammate.name} anything. Changes to files will need your approval.`}
        </p>
        {teammate.memory && (
          <div className="mt-4 max-w-[340px] rounded-xl border border-line bg-panel/60 p-3 text-left">
            <span className="block text-[11px] font-medium text-faint">Memory notes:</span>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted line-clamp-3">
              {teammate.memory}
            </p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
      {conversation.messages.map((msg) => {
        if (msg.role === 'user') {
          return (
            <div key={msg.id} className="flex justify-end">
              <div className="max-w-[78%] rounded-2xl rounded-tr-sm border border-accent/25 bg-accent/15 px-4 py-2 text-[12.5px] text-fg whitespace-pre-wrap">
                {msg.text}
              </div>
            </div>
          )
        }

        if (msg.role === 'tool') {
          return (
            <div
              key={msg.id}
              className="flex items-center gap-2 rounded-lg border border-line bg-panel/80 px-3 py-1.5 font-mono text-[11.5px] text-muted"
            >
              <Wrench size={13} className="shrink-0 text-accent" />
              <span className="truncate">{toolLabel(msg.text)}</span>
            </div>
          )
        }

        if (msg.role === 'system') {
          return (
            <div key={msg.id} className="text-center text-[11.5px] text-faint italic py-0.5">
              {msg.text}
            </div>
          )
        }

        // Assistant message
        return (
          <div key={msg.id} className="flex items-start gap-3">
            <PixelAvatar name={teammate.name} size={28} className="mt-0.5" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-fg">{teammate.name}</span>
              </div>
              <div className="text-[12.5px] leading-relaxed text-fg whitespace-pre-wrap">
                {msg.text}
              </div>
            </div>
          </div>
        )
      })}

      {conversation.pending && (
        <ApprovalCard
          conversation={conversation}
          pending={conversation.pending}
        />
      )}

      {conversation.status === 'running' && (
        <div className="flex items-center gap-2 text-[12px] text-muted py-1">
          <StatusDot state="working" size={7} />
          <span className="animate-pulse">{teammate.name} is working…</span>
        </div>
      )}
    </div>
  )
}
