// One row of the Thread panel: a user bubble, plain assistant text, or a faint tool line.

import type { ThreadMessage } from '@shared/types'
import { Wrench } from 'lucide-react'
import { AssistantText } from './AssistantText'

export function ThreadItem({ message }: { message: ThreadMessage }): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div data-testid="thread-message" data-role="user" className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm border border-line-strong bg-raised px-3 py-2 text-[12.5px] whitespace-pre-wrap text-fg">
          {message.text}
        </div>
      </div>
    )
  }
  if (message.role === 'tool') {
    return (
      <div
        data-testid="thread-message"
        data-role="tool"
        title={message.text}
        className="flex items-center gap-2 rounded-lg border border-line bg-panel/80 px-2.5 py-1.5 font-mono text-[11.5px] text-muted"
      >
        <Wrench size={13} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate">{message.text}</span>
      </div>
    )
  }
  return (
    <div data-testid="thread-message" data-role="assistant" className="min-w-0">
      <AssistantText text={message.text} />
    </div>
  )
}
