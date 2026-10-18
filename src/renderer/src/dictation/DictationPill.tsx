// The floating pill that shows listening, transcribing, added or cancelled.

import { useEffect, useState } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import { cancelDictation, copyKept, dismissDictation, retryDictation, toggleDictation } from './controller'
import { useDictation } from './store'
import { Button } from '../components/ui'

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function DictationPill(): React.JSX.Element | null {
  const phase = useDictation((s) => s.phase)
  const startedAt = useDictation((s) => s.startedAt)
  const level = useDictation((s) => s.level)
  const message = useDictation((s) => s.message)
  const keptText = useDictation((s) => s.keptText)
  const retry = useDictation((s) => s.retry)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (phase !== 'listening') return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [phase])

  if (phase === 'idle') return null
  const clamped = Math.round(Math.min(1, Math.max(0, level)) * 100)

  return (
    <div className="fixed bottom-6 left-1/2 z-[70] -translate-x-1/2">
      <div
        data-testid="dictation-pill"
        data-state={phase}
        role="status"
        className="flex max-w-[520px] min-w-[320px] items-center gap-3 rounded-xl border border-line-strong bg-raised px-4 py-3 shadow-2xl animate-fade-up"
      >
        {phase === 'listening' && (
          <>
            <span className="h-2 w-2 shrink-0 rounded-full bg-st-failed animate-breathe" aria-hidden="true" />
            <span className="font-mono text-[12.5px] text-fg tabular-nums" data-testid="dictation-elapsed">
              {formatElapsed(now - startedAt)}
            </span>
            <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-press" title="Microphone level" aria-hidden="true">
              <span className="block h-full rounded-full bg-st-failed transition-all duration-150" style={{ width: `${clamped}%` }} />
            </span>
            <span className="text-[12.5px] text-muted">Listening</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <Button variant="subtle" size="sm" data-testid="dictation-stop" onClick={() => toggleDictation()}>
                Stop
              </Button>
              <Button variant="ghost" size="sm" data-testid="dictation-cancel" onClick={() => cancelDictation()}>
                Cancel
              </Button>
            </span>
          </>
        )}
        {phase === 'transcribing' && (
          <>
            <Loader2 size={14} className="shrink-0 animate-spin text-accent-bright" aria-hidden="true" />
            <span className="text-[12.5px] text-muted">Turning speech into text</span>
          </>
        )}
        {phase === 'added' && (
          <>
            <Check size={14} className="shrink-0 text-st-idle" aria-hidden="true" />
            <span className="shrink-0 text-[12.5px] text-fg">{message}</span>
            {keptText && (
              <>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted" title={keptText}>
                  {keptText}
                </span>
                <Button variant="subtle" size="sm" data-testid="dictation-copy" onClick={() => copyKept()} className="shrink-0">
                  <Copy size={13} />
                  Copy
                </Button>
              </>
            )}
          </>
        )}
        {phase === 'cancelled' && <span className="text-[12.5px] text-muted">Cancelled</span>}
        {phase === 'error' && (
          <>
            <span className="min-w-0 flex-1 text-[12.5px] text-st-failed">{message}</span>
            {retry && (
              <Button variant="subtle" size="sm" data-testid="dictation-retry" onClick={() => retryDictation()} className="shrink-0">
                Retry
              </Button>
            )}
            <Button variant="subtle" size="sm" data-testid="dictation-dismiss" onClick={() => dismissDictation()} className="shrink-0">
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
