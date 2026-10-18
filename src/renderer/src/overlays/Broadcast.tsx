// Broadcast: send one message to several sessions.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Radio, Users } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import type { SessionInfo } from '@shared/types'
import { Modal } from '../components/overlay'
import { AgentBadge, StatusChip } from '../components/marks'
import { Button, cx } from '../components/ui'
import { bridge } from '../lib/bridge'
import { basename } from '../lib/format'
import { useNow } from '../lib/useNow'
import { useSessions } from '../store/sessions'
import { useUi } from '../store/ui'
import { liveSessions, sendLabel, sharedFolders, sharedWarning, targetLabel } from './broadcast/select'
import { notSentLine, sentSummary } from './broadcast/result'

export function BroadcastDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const now = useNow()
  const order = useSessions((s) => s.order)
  const sessions = useSessions((s) => s.sessions)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
  const [result, setResult] = useState<{ summary: string; notSent: string } | null>(null)

  const targets = useMemo(
    () => liveSessions(order.map((id) => sessions[id]).filter((s): s is SessionInfo => Boolean(s))),
    [order, sessions]
  )
  const checked = targets.filter((s) => !unchecked.has(s.id))
  const shared = sharedFolders(checked)
  const canSend = text.trim().length > 0 && checked.length > 0 && !sending

  const send = async (): Promise<void> => {
    const message = text.trim()
    if (!message || checked.length === 0 || sending) return
    setSending(true)
    const picked = checked.map((s) => s.id)
    try {
      const sent = await bridge.invoke('session:broadcast', picked, message)
      // A picked pane that exited before the text arrived took none of it.
      const after = useSessions.getState().sessions
      const exited = picked
        .map((id) => after[id])
        .filter((s) => !s || s.status.state === 'done' || s.status.state === 'failed')
        .map((s) => ({ short: s ? AGENTS[s.agent].short : 'a pane' }))
      setResult({ summary: sentSummary(sent, picked.length), notSent: notSentLine(exited) })
      window.setTimeout(onClose, 2500)
    } catch {
      setSending(false)
    }
  }

  const latestSend = useRef(send)
  latestSend.current = send

  // Cmd+Enter sends from anywhere in the dialog, on macOS or Windows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return
      e.preventDefault()
      e.stopPropagation()
      void latestSend.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const toggle = (id: string): void =>
    setUnchecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const setAll = (on: boolean): void => setUnchecked(on ? new Set<string>() : new Set(targets.map((s) => s.id)))

  return (
    <Modal
      title="Broadcast"
      subtitle="Send one message to several sessions. Agents get it as a prompt; terminals run it as a command."
      onClose={onClose}
      testId="broadcast-dialog"
      width={560}
      footer={
        result ? (
          <Button variant="subtle" onClick={onClose} data-testid="broadcast-result-close">
            Close
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="accent" onClick={() => void send()} disabled={!canSend} data-testid="broadcast-send">
              <Radio size={13} />
              {sendLabel(checked.length)}
            </Button>
          </>
        )
      }
    >
      {result && (
        <div
          data-testid="broadcast-result"
          role="status"
          className="animate-fade-up rounded-lg border border-st-idle/40 bg-st-idle/[0.07] px-4 py-4"
        >
          <p className="flex items-center gap-2 text-[14px] font-semibold text-st-idle">
            <Check size={15} />
            {result.summary}
          </p>
          {result.notSent && <p className="mt-1.5 text-[12.5px] text-muted">{result.notSent}</p>}
        </div>
      )}

      {!result && (
        <>
      <textarea
        data-testid="broadcast-text"
        autoFocus
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What should they do?"
        className="w-full resize-none rounded-lg border border-line bg-panel px-3 py-2 text-[13px] leading-relaxed text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/50 focus:ring-2 focus:ring-accent/40"
      />

      <div className="mt-3 mb-1.5 flex items-center gap-2.5">
        <span className="text-[11.5px] font-medium text-muted">{targetLabel(targets.length)}</span>
        <button
          type="button"
          data-testid="broadcast-all"
          onClick={() => setAll(true)}
          className="ml-auto text-[11.5px] text-accent transition-colors hover:text-accent-bright"
        >
          All
        </button>
        <button
          type="button"
          data-testid="broadcast-none"
          onClick={() => setAll(false)}
          className="text-[11.5px] text-accent transition-colors hover:text-accent-bright"
        >
          None
        </button>
      </div>

      {targets.length === 0 ? (
        <p className="rounded-lg border border-line bg-panel/60 px-3 py-6 text-center text-[12px] text-faint">
          No sessions are running. Start an agent or a terminal from New pane.
        </p>
      ) : (
        <div className="max-h-[248px] overflow-y-auto rounded-lg border border-line bg-panel/60">
          {targets.map((s) => {
            const on = !unchecked.has(s.id)
            return (
              <label
                key={s.id}
                data-testid="broadcast-target"
                data-session={s.id}
                data-checked={on ? 'true' : 'false'}
                className={cx(
                  'flex cursor-pointer items-center gap-2.5 border-b border-line px-2.5 py-2 transition-colors last:border-b-0',
                  on ? 'bg-accent/[0.06]' : 'hover:bg-hover'
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(s.id)}
                  className="h-3.5 w-3.5 shrink-0 accent-accent"
                  aria-label={`Send to ${AGENTS[s.agent].name} in ${basename(s.cwd)}`}
                />
                <AgentBadge kind={s.agent} size={18} />
                <span className="shrink-0 font-mono text-[12.5px] font-medium text-fg">{AGENTS[s.agent].short}</span>
                <span className="truncate text-[11px] text-faint" title={s.cwd}>
                  {basename(s.cwd)}
                </span>
                <span className="ml-auto shrink-0">
                  <StatusChip status={s.status} now={now} />
                </span>
              </label>
            )
          })}
        </div>
      )}

      {shared.map((folder) => (
        <div
          key={folder.cwd}
          data-testid="broadcast-shared-warning"
          data-cwd={folder.cwd}
          className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-st-waiting/40 bg-st-waiting/[0.07] px-3 py-2.5 text-[12px] leading-relaxed text-st-waiting"
        >
          <span className="min-w-0 flex-1">{sharedWarning(folder)}</span>
          <button
            type="button"
            data-testid="broadcast-start-crew"
            onClick={() => useUi.getState().openOverlay('launchset')}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-st-waiting/40 px-2 py-1 text-[11.5px] font-medium transition-colors hover:bg-st-waiting/10"
          >
            <Users size={13} />
            Start a crew instead
          </button>
        </div>
      ))}
        </>
      )}
    </Modal>
  )
}
