// The floating pill for dictating into any app (Labs). It lives in its own small window that never
// takes focus, so the app in front keeps the caret.

import { useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { DICTATION_MAX_MS } from '@shared/dictation'
import { bridge } from '../lib/bridge'
import { recordAudio, type ActiveRecording } from '../dictation/recorder'
import { MIC_OPEN_TIMEOUT_MS, MIC_OPEN_TIMEOUT_MESSAGE } from '../dictation/controller'
import { Button } from '../components/ui'

type PillState = 'idle' | 'permission' | 'listening' | 'transcribing' | 'added' | 'cancelled' | 'error'

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function AnywherePill(): React.JSX.Element | null {
  const [state, setState] = useState<PillState>('idle')
  const [message, setMessage] = useState('')
  const [level, setLevel] = useState(0)
  const [canRetry, setCanRetry] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const recording = useRef<ActiveRecording | null>(null)
  const autoStop = useRef<number | null>(null)
  const opening = useRef(false)
  const startedAt = useRef(0)

  const clearAutoStop = (): void => {
    if (autoStop.current !== null) {
      window.clearTimeout(autoStop.current)
      autoStop.current = null
    }
  }

  const dropRecording = (): void => {
    const held = recording.current
    recording.current = null
    if (held) held.cancel()
  }

  const reset = (): void => {
    clearAutoStop()
    dropRecording()
    opening.current = false
    setCanRetry(false)
    setLevel(0)
    setState('idle')
  }

  const start = (): void => {
    if (recording.current || opening.current) return
    clearAutoStop()
    opening.current = true
    let timedOut = false
    const openTimer = window.setTimeout(() => {
      timedOut = true
      opening.current = false
      setLevel(0)
      setCanRetry(true)
      setMessage(MIC_OPEN_TIMEOUT_MESSAGE)
      setState('error')
    }, MIC_OPEN_TIMEOUT_MS)
    recordAudio((lvl) => {
      if (!timedOut) setLevel(lvl)
    })
      .then((rec) => {
        window.clearTimeout(openTimer)
        opening.current = false
        if (timedOut) {
          // It opened too late to be used: give the microphone straight back.
          rec.cancel()
          return
        }
        recording.current = rec
        startedAt.current = Date.now()
        setNow(startedAt.current)
        setCanRetry(false)
        setState('listening')
        autoStop.current = window.setTimeout(() => void stop(), DICTATION_MAX_MS)
      })
      .catch(() => {
        window.clearTimeout(openTimer)
        opening.current = false
        if (timedOut) return
        setLevel(0)
        setCanRetry(false)
        setMessage('Regatta could not open the microphone.')
        setState('error')
      })
  }

  const stop = async (): Promise<void> => {
    const held = recording.current
    recording.current = null
    clearAutoStop()
    if (!held) return
    setCanRetry(false)
    setLevel(0)
    setState('transcribing')
    let wav: Uint8Array
    try {
      wav = await held.stop()
    } catch {
      setMessage('Regatta could not read the recording.')
      setState('error')
      return
    }
    try {
      const result = await bridge.invoke('anywhere:deliver', wav)
      if (result.ok) {
        setMessage(result.app ? `Added in ${result.app}` : 'Added')
        setState('added')
      } else {
        setMessage(result.error ?? 'Dictation failed. Try again.')
        setState('error')
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Dictation failed. Try again.')
      setState('error')
    }
  }

  const cancel = (): void => {
    dropRecording()
    clearAutoStop()
    setLevel(0)
    setState('cancelled')
  }

  const openAccessibility = (): void => {
    void bridge.invoke('anywhere:openAccessibility').catch(() => undefined)
  }

  // React to the shortcut presses main forwards here.
  useEffect(() => {
    const off = bridge.on('anywhere:toggle', (event) => {
      if (event.action === 'start') start()
      else if (event.action === 'stop') void stop()
      else cancel()
    })
    return off
  }, [])

  // Each time the window becomes visible, decide whether it needs Accessibility or is ready.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void bridge
          .invoke('anywhere:status')
          .then((status) => {
            if (!status.trusted) {
              setMessage('Needs Accessibility access')
              setState('permission')
            } else if (state === 'permission') {
              setState('idle')
            }
          })
          .catch(() => undefined)
      } else {
        reset()
      }
    }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [state])

  useEffect(() => {
    if (state !== 'listening') return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [state])

  useEffect(() => () => clearAutoStop(), [])

  if (state === 'idle') return null
  const clamped = Math.round(Math.min(1, Math.max(0, level)) * 100)

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent p-2">
      <div
        data-testid="anywhere-pill"
        data-state={state}
        role="status"
        aria-live="polite"
        className="flex w-full items-center gap-3 rounded-full border border-line-strong bg-raised px-4 py-2.5 shadow-2xl animate-fade-up"
      >
        {state === 'permission' && (
          <>
            <span className="h-2 w-2 shrink-0 rounded-full bg-st-waiting" aria-hidden="true" />
            <span
              className="min-w-0 flex-1 truncate text-[12.5px] text-fg"
              title="Regatta needs Accessibility permission to type into other apps."
            >
              {message}
            </span>
            <Button variant="subtle" size="sm" data-testid="anywhere-open-settings" onClick={openAccessibility} className="shrink-0">
              Open Settings
            </Button>
          </>
        )}
        {state === 'listening' && (
          <>
            <span className="h-2 w-2 shrink-0 rounded-full bg-st-failed animate-breathe" aria-hidden="true" />
            <span className="font-mono text-[12.5px] text-fg tabular-nums" data-testid="anywhere-elapsed">
              {formatElapsed(now - startedAt.current)}
            </span>
            <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-press" title="Microphone level" aria-hidden="true">
              <span className="block h-full rounded-full bg-st-failed transition-all duration-150" style={{ width: `${clamped}%` }} />
            </span>
            <span className="ml-auto shrink-0 text-[12.5px] text-muted">Listening</span>
          </>
        )}
        {state === 'transcribing' && (
          <>
            <Loader2 size={14} className="shrink-0 animate-spin text-accent-bright" aria-hidden="true" />
            <span className="text-[12.5px] text-muted">Turning speech into text</span>
          </>
        )}
        {state === 'added' && (
          <>
            <Check size={14} className="shrink-0 text-st-idle" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg" title={message}>
              {message}
            </span>
          </>
        )}
        {state === 'cancelled' && <span className="text-[12.5px] text-muted">Cancelled</span>}
        {state === 'error' && (
          <>
            <span className="min-w-0 flex-1 text-[12.5px] text-st-failed" title={message}>
              {message}
            </span>
            {canRetry && (
              <Button variant="subtle" size="sm" data-testid="anywhere-retry" onClick={() => start()} className="shrink-0">
                Retry
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
