// Composer for Agents mode.
// Placeholder "Ask <name>…", input with data-testid="crew-input",
// and "<Agent name> · reads first, asks before editing" under the input.

import { useState, type KeyboardEvent } from 'react'
import type { Teammate } from '@shared/chat'
import { AGENTS } from '@shared/agents'
import { Send, Square } from 'lucide-react'
import { Button, IconButton } from '../../components/ui'

interface ComposerProps {
  teammate: Teammate
  isRunning: boolean
  onSend: (text: string) => Promise<void>
  onStop: () => void
}

export function Composer({
  teammate,
  isRunning,
  onSend,
  onStop
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const agentName = AGENTS[teammate.agent]?.name ?? teammate.agent

  const handleSend = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || isRunning) return
    setText('')
    await onSend(trimmed)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  return (
    <div className="border-t border-line bg-chrome/50 p-4">
      <div className="rounded-xl border border-line-strong bg-panel p-2.5 transition-colors focus-within:border-accent/60 shadow-sm">
        <textarea
          data-testid="crew-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Ask ${teammate.name}…`}
          rows={2}
          className="w-full bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint resize-none leading-relaxed"
        />

        <div className="mt-2 flex items-center justify-between border-t border-line/60 pt-2">
          <p className="text-[11.5px] text-faint select-none">
            {agentName} · reads first, asks before editing
          </p>

          <div className="flex items-center gap-1.5">
            {isRunning ? (
              <Button
                variant="subtle"
                size="sm"
                onClick={onStop}
                className="gap-1 text-st-waiting"
              >
                <Square size={11} fill="currentColor" />
                Stop
              </Button>
            ) : (
              <IconButton
                variant="accent"
                size="sm"
                onClick={() => void handleSend()}
                disabled={!text.trim()}
                title="Send"
                aria-label="Send"
              >
                <Send size={13} />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
