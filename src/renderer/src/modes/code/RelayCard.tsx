import { useEffect, useRef, useState } from 'react'
import { BellRing, Forward, X } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import type { SessionInfo } from '@shared/types'
import { useSessions } from '../../store/sessions'
import { AgentBadge } from '../../components/marks'
import { Button, IconButton, MenuItem, MenuLabel, cx } from '../../components/ui'
import { bridge } from '../../lib/bridge'

/** "6:30 PM" for a reset time, the way the user's computer writes times. */
function clockTime(resetsAt: number): string {
  return new Date(resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * Shown in a pane when its agent hit its usage limit: wait for the reset, or carry the work
 * over into another agent right now.
 */
export function RelayCard({ session }: { session: SessionInfo }): React.JSX.Element | null {
  const limit = session.limit
  const agents = useSessions((s) => s.agents)
  const [menuOpen, setMenuOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (menu.current && !menu.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])
  if (!limit) return null
  const { id, agent } = session
  const name = AGENTS[agent].name
  const resetsAt = limit.resetsAt
  const resetsLabel = resetsAt !== null ? clockTime(resetsAt) : null
  const choices = agents.filter((a) => a.installed && a.kind !== 'shell')

  return (
    <div
      data-testid="relay-card"
      className="absolute inset-x-2 bottom-2 z-10 flex flex-col gap-2 rounded-lg border border-st-waiting/45 bg-raised/95 px-3 py-2 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.8)] backdrop-blur-xl animate-fade-up"
    >
      <div className="flex items-center gap-2 text-[12.5px]">
        <AgentBadge kind={agent} size={16} />
        <span className="font-medium text-fg">{name} hit its usage limit.</span>
        {resetsLabel && <span className="text-st-waiting">It resets at {resetsLabel}.</span>}
        <IconButton
          className="ml-auto"
          title="Dismiss"
          aria-label="Dismiss the limit card"
          data-testid="relay-dismiss"
          onClick={() => void bridge.invoke('relay:cancel', id)}
        >
          <X size={13} />
        </IconButton>
      </div>
      <div className="flex items-center gap-1.5">
        {resetsLabel && (
          <Button
            variant="outline"
            size="sm"
            className="border-st-waiting/45 text-st-waiting hover:bg-st-waiting/10"
            data-testid="relay-resume"
            onClick={() => void bridge.invoke(limit.resumeScheduled ? 'relay:cancel' : 'relay:resumeLater', id)}
          >
            <BellRing size={13} />
            {limit.resumeScheduled ? `Resuming at ${resetsLabel} · Cancel` : `Resume at ${resetsLabel}`}
          </Button>
        )}
        <div ref={menu} className="relative">
          <Button
            variant="outline"
            size="sm"
            className="border-st-waiting/45 text-st-waiting hover:bg-st-waiting/10"
            active={menuOpen}
            disabled={choices.length === 0}
            aria-expanded={menuOpen}
            data-testid="relay-continue"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Forward size={13} />
            Continue now in…
          </Button>
          {menuOpen && (
            <div
              data-testid="relay-continue-menu"
              className="absolute bottom-full left-0 z-30 mb-1.5 w-[240px] rounded-xl border border-line-strong bg-raised/95 p-1.5 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.75)] backdrop-blur-xl animate-pop-in"
            >
              <MenuLabel>Continue now in</MenuLabel>
              {choices.map((a) => (
                <MenuItem
                  key={a.kind}
                  icon={<AgentBadge kind={a.kind} size={16} />}
                  label={a.name}
                  hint={a.kind === agent ? 'same agent' : undefined}
                  onClick={() => {
                    setMenuOpen(false)
                    void bridge.invoke('relay:continueIn', id, a.kind)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
