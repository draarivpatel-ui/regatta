import { useEffect, useRef, useState } from 'react'
import { ClipboardCopy, Ellipsis, Eraser, History, Maximize2, Minimize2, RotateCcw, Square, X } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import type { BudgetState } from '@shared/budgets'
import type { SessionInfo } from '@shared/types'
import { useSessions } from '../../store/sessions'
import { useUi } from '../../store/ui'
import { useNow } from '../../lib/useNow'
import { basename } from '../../lib/format'
import { AgentBadge, StatusChip } from '../../components/marks'
import { IconButton, MenuDivider, MenuItem, Popover, cx } from '../../components/ui'
import { bridge } from '../../lib/bridge'
import { attachTerminal, clearTerminal, detachTerminal, fitTerminal, focusTerminal, terminalText } from '../../terminal/registry'
import { NewPaneMenu } from './Toolbar'
import { RelayCard } from './RelayCard'
import { AccountPicker } from './AccountPicker'

export function Pane({ session, focused }: { session: SessionInfo; focused: boolean }): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  const now = useNow()
  const { focus, removeSession, restartSession } = useSessions()
  const { maximizedId, toggleMaximize } = useUi()
  const [budgetStates, setBudgetStates] = useState<BudgetState[]>([])
  const { id, status } = session
  const waiting = status.state === 'waiting'
  const ended = status.state === 'done' || status.state === 'failed'
  const overBudget = budgetStates.some((s) => s.agent === session.agent && s.level === 'over')

  useEffect(() => {
    let alive = true
    void bridge
      .invoke('budgets:states')
      .then((next) => {
        if (alive) setBudgetStates(next)
      })
      .catch(() => undefined)
    const off = bridge.on('budgets:changed', (next) => {
      if (alive) setBudgetStates(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [session.agent])

  useEffect(() => {
    const el = body.current
    if (!el) return
    attachTerminal(id, el)
    const ro = new ResizeObserver(() => fitTerminal(id))
    ro.observe(el)
    return () => {
      ro.disconnect()
      detachTerminal(id, el)
    }
  }, [id])

  useEffect(() => {
    if (focused) focusTerminal(id)
  }, [focused, id])

  return (
    <section
      data-testid="pane"
      data-session={id}
      data-state={status.state}
      data-focused={focused ? 'true' : 'false'}
      onMouseDown={() => focus(id)}
      className={cx(
        '@container group relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[11px] border bg-term transition-[border-color,box-shadow] duration-200 animate-fade-up',
        waiting
          ? 'border-st-waiting/55 shadow-[0_0_0_1px_rgba(251,191,36,0.18),0_0_28px_-10px_rgba(251,191,36,0.55)]'
          : focused
            ? 'border-accent/45 shadow-[0_0_0_1px_rgba(45,212,191,0.12)]'
            : 'border-line hover:border-line-strong'
      )}
    >
      <header
        className={cx(
          'flex h-[38px] shrink-0 items-center gap-2 border-b px-2.5',
          waiting ? 'border-st-waiting/25 bg-st-waiting/[0.05]' : 'border-line bg-panel/60'
        )}
      >
        <AgentBadge kind={session.agent} size={18} />
        <span className="shrink-0 whitespace-nowrap font-mono text-[12.5px] font-medium text-fg">{session.title}</span>
        <StatusChip status={status} now={now} />
        {overBudget && (
          <span
            data-testid={`pane-budget-${id}`}
            className="shrink-0 rounded-full border border-st-waiting/40 bg-st-waiting/10 px-2 py-0.5 text-[10.5px] font-medium text-st-waiting"
          >
            Over budget
          </span>
        )}
        {(session.agent === 'claude' || session.agent === 'codex') && <AccountPicker session={session} />}
        {session.signals === 'output' && session.agent !== 'shell' && (
          <span className="hidden shrink-0 whitespace-nowrap text-[10.5px] text-faint @[40rem]:inline" title="This agent offers no status events, so Regatta reads its screen.">
            basic signals
          </span>
        )}
        <span className="ml-1 hidden min-w-0 truncate text-[11px] text-faint @[30rem]:inline" title={session.cwd}>
          {basename(session.cwd)}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
          <Popover
            align="end"
            width={220}
            button={({ toggle, open }) => (
              <IconButton onClick={toggle} active={open} title="More" aria-label="Pane actions">
                <Ellipsis size={15} />
              </IconButton>
            )}
          >
            {(close) => (
              <div>
                <MenuItem
                  icon={<ClipboardCopy size={14} />}
                  label="Copy everything shown"
                  onClick={() => {
                    void navigator.clipboard.writeText(terminalText(id))
                    close()
                  }}
                />
                <MenuItem
                  icon={<Eraser size={14} />}
                  label="Clear the screen"
                  onClick={() => {
                    clearTerminal(id)
                    close()
                  }}
                />
                {session.agent !== 'shell' && (
                  <MenuItem
                    icon={<History size={14} />}
                    label="Checkpoints…"
                    hint="roll back a step"
                    onClick={() => {
                      close()
                      useUi.getState().openCheckpoints(id)
                    }}
                  />
                )}
                <MenuItem
                  icon={<RotateCcw size={14} />}
                  label={`Restart ${AGENTS[session.agent].name}`}
                  onClick={() => {
                    close()
                    void restartSession(id)
                  }}
                />
                {!ended && (
                  <MenuItem
                    icon={<Square size={13} />}
                    label="Stop the process"
                    onClick={() => {
                      close()
                      void bridge.invoke('session:kill', id)
                    }}
                  />
                )}
                <MenuDivider />
                <MenuItem
                  icon={<X size={14} />}
                  label="Close pane"
                  danger
                  onClick={() => {
                    close()
                    void removeSession(id)
                  }}
                />
              </div>
            )}
          </Popover>
          <IconButton
            onClick={() => toggleMaximize(id)}
            title={maximizedId === id ? 'Restore' : 'Maximize'}
            aria-label={maximizedId === id ? 'Restore pane' : 'Maximize pane'}
          >
            {maximizedId === id ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </IconButton>
          <SmallNewPane />
          <IconButton onClick={() => void removeSession(id)} title="Close pane" aria-label="Close pane">
            <X size={14} />
          </IconButton>
        </div>
      </header>
      <div ref={body} className="relative min-h-0 flex-1" />
      {session.limit && <RelayCard session={session} />}
      {ended && (
        <div className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-lg border border-line-strong bg-raised/95 px-3 py-2 text-[12px] shadow-xl backdrop-blur animate-fade-up">
          <span className="text-muted">
            {AGENTS[session.agent].name} {status.state === 'done' ? 'finished' : 'stopped'} ({status.reason}).
          </span>
          <button type="button" className="ml-auto font-medium text-accent hover:text-accent-bright" onClick={() => void restartSession(id)}>
            Restart
          </button>
          <button type="button" className="text-muted hover:text-fg" onClick={() => void removeSession(id)}>
            Close
          </button>
        </div>
      )}
    </section>
  )
}

function SmallNewPane(): React.JSX.Element {
  return <NewPaneMenu compact />
}
