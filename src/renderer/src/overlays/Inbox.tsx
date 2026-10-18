// Inbox: every session, most urgent first.

import { useState } from 'react'
import { SlideOver } from '../components/overlay'
import { AGENTS } from '@shared/agents'
import type { SessionInfo, SessionState } from '@shared/types'
import { useSessions } from '../store/sessions'
import { useUi } from '../store/ui'
import { useNow } from '../lib/useNow'
import { basename } from '../lib/format'
import { AgentBadge, StatusChip, StatusDot } from '../components/marks'
import { Button } from '../components/ui'
import { idleOrDone } from './inbox/idle'

interface Section {
  title: string
  states: SessionState[]
  dot: SessionState
}

// Ordered most urgent first. A section shows only when it has rows.
const SECTIONS: Section[] = [
  { title: 'Waiting on you', states: ['waiting'], dot: 'waiting' },
  { title: 'Failed', states: ['failed'], dot: 'failed' },
  { title: 'Quiet', states: ['quiet'], dot: 'quiet' },
  { title: 'Working', states: ['working', 'starting'], dot: 'working' },
  { title: 'Ready for a prompt', states: ['idle'], dot: 'idle' },
  { title: 'Exited', states: ['done'], dot: 'done' }
]

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function InboxRow({ s, now }: { s: SessionInfo; now: number }): React.JSX.Element {
  const open = (): void => {
    const ui = useUi.getState()
    ui.setMode('code')
    useSessions.getState().focus(s.id)
    // If another pane is maximized, this one is not visible, so maximize it in its place.
    if (ui.maximizedId && ui.maximizedId !== s.id) ui.toggleMaximize(s.id)
    ui.openOverlay(null)
  }
  return (
    <div
      data-testid="inbox-row"
      data-session={s.id}
      data-state={s.status.state}
      className="flex items-start gap-2.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-hover"
    >
      <AgentBadge kind={s.agent} size={20} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-medium text-fg">{AGENTS[s.agent].name}</span>
          <span className="truncate text-[11px] text-faint">{basename(s.cwd)}</span>
          <span className="ml-auto shrink-0">
            <StatusChip status={s.status} now={now} />
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11.5px] text-muted" title={s.status.reason}>
          {s.status.reason}
        </p>
        <div className="mt-1.5">
          <Button variant="subtle" size="sm" data-testid="inbox-open" onClick={open}>
            Open
          </Button>
        </div>
      </div>
    </div>
  )
}

export function InboxPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const now = useNow()
  const order = useSessions((s) => s.order)
  const byId = useSessions((s) => s.sessions)
  const sessions = order.map((id) => byId[id]).filter((s): s is SessionInfo => Boolean(s))
  const folders = new Set(sessions.map((s) => s.cwd)).size
  const finished = sessions.filter((s) => s.status.state === 'done' || s.status.state === 'failed')
  const closable = idleOrDone(sessions)
  const [confirmIdle, setConfirmIdle] = useState(false)

  const closeFinished = (): void => {
    for (const s of finished) void useSessions.getState().removeSession(s.id)
  }

  const closeIdle = (): void => {
    for (const s of closable) void useSessions.getState().removeSession(s.id)
    setConfirmIdle(false)
  }

  const header = (
    <div className="flex items-center gap-2 border-b border-line px-5 py-2.5" data-testid="inbox-close-idle-bar">
      {confirmIdle ? (
        <>
          <span className="flex-1 text-[12.5px] text-muted">Close {plural(closable.length, 'finished pane', 'finished panes')}?</span>
          <Button variant="accent" size="sm" data-testid="inbox-close-idle-confirm" onClick={closeIdle}>
            Close
          </Button>
          <Button variant="ghost" size="sm" data-testid="inbox-close-idle-cancel" onClick={() => setConfirmIdle(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span className="flex-1 text-[11.5px] text-faint">
            {closable.length === 0 ? 'No idle or finished panes to close' : `${plural(closable.length, 'pane', 'panes')} ready to close`}
          </span>
          <Button variant="subtle" size="sm" data-testid="inbox-close-idle" disabled={closable.length === 0} onClick={() => setConfirmIdle(true)}>
            Close idle
          </Button>
        </>
      )}
    </div>
  )

  return (
    <SlideOver
      title="Inbox"
      subtitle={`${plural(sessions.length, 'session', 'sessions')} across ${plural(folders, 'folder', 'folders')}, most urgent first`}
      onClose={onClose}
      testId="inbox-panel"
      footer={
        <Button variant="subtle" size="sm" data-testid="inbox-close-finished" disabled={finished.length === 0} onClick={closeFinished}>
          Close finished ({finished.length})
        </Button>
      }
    >
      {header}
      {sessions.length === 0 ? (
        <p className="px-5 py-8 text-center text-[12.5px] text-muted">Nothing needs you right now.</p>
      ) : (
        <div className="px-2 py-2">
          {SECTIONS.map((section) => {
            const rows = sessions.filter((s) => section.states.includes(s.status.state))
            if (rows.length === 0) return null
            return (
              <div key={section.title} className="mb-1">
                <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[11.5px] font-medium text-muted">
                  <StatusDot state={section.dot} size={6} />
                  {section.title}
                  <span className="text-faint">{rows.length}</span>
                </div>
                {rows.map((s) => (
                  <InboxRow key={s.id} s={s} now={now} />
                ))}
              </div>
            )
          })}
        </div>
      )}
    </SlideOver>
  )
}
