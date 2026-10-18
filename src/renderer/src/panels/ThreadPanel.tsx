// Thread view beside the panes: the focused agent's conversation from its own transcript.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadMessage } from '@shared/types'
import { RefreshCw } from 'lucide-react'
import { bridge } from '../lib/bridge'
import { useSessions } from '../store/sessions'
import { AgentBadge } from '../components/marks'
import { IconButton } from '../components/ui'
import { ThreadItem } from './thread/ThreadItem'

const REFRESH_MS = 3000

export function ThreadPanel(): React.JSX.Element {
  const focusedId = useSessions((s) => s.focusedId)
  const sessions = useSessions((s) => s.sessions)
  const session = focusedId ? sessions[focusedId] : undefined
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [stuck, setStuck] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (id: string) => {
    try {
      setMessages(await bridge.invoke('thread:get', id))
    } catch {
      setMessages([])
    }
  }, [])

  useEffect(() => {
    if (!focusedId) {
      setMessages([])
      setStuck(false)
      return
    }
    setStuck(false)
    void load(focusedId)
    const timer = setInterval(() => void load(focusedId), REFRESH_MS)
    return () => clearInterval(timer)
  }, [focusedId, load])

  useEffect(() => {
    if (stuck) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, stuck])

  if (!focusedId || !session) {
    return (
      <div data-testid="thread-panel" className="flex h-full flex-col items-center justify-center p-6 text-center">
        <p data-testid="thread-empty" className="text-[12.5px] leading-relaxed text-muted">
          Focus a pane to see its conversation.
        </p>
      </div>
    )
  }

  return (
    <div data-testid="thread-panel" className="flex h-full min-h-0 flex-col">
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-line px-3">
        <AgentBadge kind={session.agent} size={18} />
        <span data-testid="thread-title" title={session.title} className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium text-fg">
          {session.title}
        </span>
        <IconButton
          data-testid="thread-refresh"
          onClick={() => void load(focusedId)}
          title="Refresh conversation"
          aria-label="Refresh conversation"
        >
          <RefreshCw size={14} />
        </IconButton>
      </div>
      <div
        ref={scrollRef}
        data-testid="thread-list"
        onScroll={(e) => {
          const el = e.currentTarget
          setStuck(el.scrollHeight - el.scrollTop - el.clientHeight > 80)
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
      >
        {messages.length === 0 ? (
          <p data-testid="thread-no-transcript" className="text-[12.5px] leading-relaxed text-muted">
            This agent does not keep a transcript Regatta can read yet. Claude Code does.
          </p>
        ) : (
          messages.map((m, i) => <ThreadItem key={`${m.at ?? 'no-at'}-${i}`} message={m} />)
        )}
      </div>
    </div>
  )
}
