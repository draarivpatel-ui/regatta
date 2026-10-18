// The box that opens next to the picked element: what should change and which agent. Checks are not
// chosen here: the result card offers "Run checks" after the user has read the changed files.

import { useEffect, useState } from 'react'
import { AGENTS } from '@shared/agents'
import { SPOTFIX_AGENTS } from '@shared/spotfix'
import type { SpotFixPick } from '@shared/spotfix'
import type { AgentKind, DetectedAgent } from '@shared/types'
import { Button, IconButton } from '../../../components/ui'
import { AgentBadge } from '../../../components/marks'

const LAST_AGENT_KEY = 'regatta.spotfix.agent'

/** The note and agent the user chose, ready to hand to the engine. */
export interface SpotFixSend {
  note: string
  agent: AgentKind
}

export interface SpotFixAnchor {
  /** Top left of the box, in pixels inside the preview stage. */
  x: number
  y: number
}

function readLastAgent(): AgentKind | null {
  try {
    const value = localStorage.getItem(LAST_AGENT_KEY)
    return value && SPOTFIX_AGENTS.includes(value as AgentKind) ? (value as AgentKind) : null
  } catch {
    return null
  }
}

function writeLastAgent(kind: AgentKind): void {
  try {
    localStorage.setItem(LAST_AGENT_KEY, kind)
  } catch {
    // A private mode that refuses storage is not worth failing the pick over.
  }
}

export interface SpotFixBoxProps {
  pick: SpotFixPick
  anchor: SpotFixAnchor
  /** Installed agents that a Spot fix can use. */
  agents: DetectedAgent[]
  /** Why main refused the last send, or empty. The note stays as it was written. */
  error?: string
  onSend: (send: SpotFixSend) => void
  onCancel: () => void
}

/** A small card anchored near the picked element. Escape or Cancel closes it. */
export function SpotFixBox({ pick, anchor, agents, error, onSend, onCancel }: SpotFixBoxProps): React.JSX.Element {
  const [note, setNote] = useState('')
  const [agent, setAgent] = useState<AgentKind>(readLastAgent() ?? agents[0]?.kind ?? 'claude')

  // Escape closes the box before the note field can swallow it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const send = (): void => {
    const text = note.trim()
    if (!text) return
    writeLastAgent(agent)
    onSend({ note: text, agent })
  }

  return (
    <div
      data-testid="spotfix-box"
      style={{ left: anchor.x, top: anchor.y }}
      className="absolute z-20 w-[300px] rounded-xl border border-line-strong bg-raised/95 p-3 shadow-[0_20px_60px_-18px_rgba(0,0,0,0.8)] backdrop-blur-xl animate-pop-in"
    >
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-fg" title={pick.selector}>
            &lt;{pick.tag}&gt;{pick.text ? ` · ${pick.text}` : ''}
          </div>
        </div>
        <IconButton onClick={onCancel} aria-label="Cancel" title="Cancel" data-testid="spotfix-cancel-x">
          <span className="text-[13px] leading-none">×</span>
        </IconButton>
      </div>

      <label className="block text-[11.5px] text-muted" htmlFor="spotfix-note">
        What should change?
      </label>
      <textarea
        id="spotfix-note"
        data-testid="spotfix-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            send()
          }
        }}
        rows={3}
        autoFocus
        placeholder="Make the button wider."
        className="mt-1 w-full resize-none rounded-md border border-line bg-term px-2 py-1.5 text-[12.5px] text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/50"
      />

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11.5px] text-muted">Agent</span>
        <div className="flex items-center gap-1.5">
          <AgentBadge kind={agent} size={16} />
          <select
            data-testid="spotfix-agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value as AgentKind)}
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-term px-1.5 text-[12px] text-fg outline-none focus:border-accent/50"
          >
            {agents.map((a) => (
              <option key={a.kind} value={a.kind}>
                {AGENTS[a.kind]?.name ?? a.kind}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p data-testid="spotfix-send-error" className="mt-2 rounded-md bg-st-failed/10 px-2 py-1.5 text-[11.5px] text-st-failed">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} data-testid="spotfix-cancel">
          Cancel
        </Button>
        <Button variant="accent" size="sm" onClick={send} disabled={!note.trim()} data-testid="spotfix-send">
          Send
        </Button>
      </div>
    </div>
  )
}
