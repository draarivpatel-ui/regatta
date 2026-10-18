// Chat transcript: user bubbles, plain assistant text with code spans and
// fenced blocks, faint tool lines, centered system notes.

import { useEffect, useRef, useState } from 'react'
import type { Conversation } from '@shared/chat'
import { Wrench } from 'lucide-react'
import { StatusDot } from '../../components/marks'
import { ChatWriteRequest } from './ChatWriteRequest'

function toolLabel(text: string): string {
  if (text.startsWith('Edit ')) {
    return `Edited ${text.slice(5)}`
  }
  return text
}

function InlineCode({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(`[^`\n]+`)/g)
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          <code
            key={i}
            className="rounded border border-line bg-panel px-1 py-px font-mono text-[11.5px] text-fg"
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

function AssistantText({ text }: { text: string }): React.JSX.Element {
  const blocks: { code: boolean; lang: string; body: string }[] = []
  const fence = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)(?:```|$)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) {
      blocks.push({ code: false, lang: '', body: text.slice(last, match.index) })
    }
    blocks.push({ code: true, lang: match[1] ?? '', body: match[2] ?? '' })
    last = match.index + match[0].length
    if (match[0].length === 0) break
  }
  if (last < text.length) blocks.push({ code: false, lang: '', body: text.slice(last) })
  if (blocks.length === 0) blocks.push({ code: false, lang: '', body: text })

  return (
    <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg">
      {blocks.map((b, i) =>
        b.code ? (
          <pre
            key={i}
            className="my-2 overflow-x-auto rounded-lg border border-line bg-panel p-2.5 font-mono text-[11.5px] leading-relaxed text-fg"
          >
            {b.body.replace(/\n$/, '')}
          </pre>
        ) : (
          <span key={i}>
            <InlineCode text={b.body} />
          </span>
        )
      )}
    </div>
  )
}

export function ChatTranscript({
  conversation,
  onApprove,
  onDeny
}: {
  conversation: Conversation | null
  onApprove: (id: string, requestId: string) => void
  onDeny: (id: string, requestId: string) => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)

  const id = conversation?.id ?? null
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setStuck(false)
  }, [id])

  useEffect(() => {
    if (stuck) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conversation?.messages, conversation?.pending, conversation?.status, stuck])

  if (!conversation || (conversation.messages.length === 0 && !conversation.pending)) {
    return (
      <div
        ref={scrollRef}
        data-testid="chat-transcript"
        className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-8 text-center"
      >
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">
          Talk it through first
        </h2>
        <p className="mt-1.5 max-w-[360px] text-[12.5px] leading-relaxed text-muted">
          Ask anything, or describe what to change. In Ask first mode the agent reads and asks
          before editing anything.
        </p>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      data-testid="chat-transcript"
      onScroll={(e) => {
        const el = e.currentTarget
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        setStuck(!nearBottom)
      }}
      className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4"
    >
      {conversation.messages.map((msg) => {
        if (msg.role === 'user') {
          return (
            <div key={msg.id} className="flex justify-end">
              <div className="max-w-[78%] rounded-2xl rounded-tr-sm border border-line-strong bg-raised px-4 py-2 text-[12.5px] whitespace-pre-wrap text-fg">
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
              <Wrench size={13} className="shrink-0 text-faint" />
              <span className="truncate">{toolLabel(msg.text)}</span>
            </div>
          )
        }
        if (msg.role === 'system') {
          return (
            <div key={msg.id} className="py-0.5 text-center text-[11.5px] text-faint italic">
              {msg.text}
            </div>
          )
        }
        return (
          <div key={msg.id} className="min-w-0">
            <AssistantText text={msg.text} />
          </div>
        )
      })}

      {conversation.pending && (
        <ChatWriteRequest
          conversation={conversation}
          pending={conversation.pending}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      )}

      {conversation.status === 'running' && (
        <div className="flex items-center gap-2 py-1 text-[12px] text-muted">
          <StatusDot state="working" size={7} />
          <span className="animate-pulse">working</span>
        </div>
      )}
    </div>
  )
}
