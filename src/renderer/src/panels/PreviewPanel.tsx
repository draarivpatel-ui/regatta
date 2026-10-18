// The Preview tab in the right sidebar: a small browser for the app the agents are building,
// with the Spot fix flow on top of it. and spotfix.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Crosshair, ExternalLink, Monitor, RotateCw, ServerOff, Smartphone, Tablet } from 'lucide-react'
import { bridge } from '../lib/bridge'
import { Button, IconButton } from '../components/ui'
import { PreviewStage, type PreviewApi, type PreviewFailure } from './preview/PreviewStage'
import { DEVICES, deviceWidthLabel, isWebUrl, normalizeUrl, readStoredUrl, storeUrl, type DeviceId } from './preview/devices'
import { canGoBack, canGoForward, onArrive, startTrail, type Trail } from './preview/trail'
import { isLocalUrl, SPOTFIX_AGENTS } from '@shared/spotfix'
import type { SpotFix, SpotFixPick, SpotFixRequest } from '@shared/spotfix'
import type { DetectedAgent } from '@shared/types'
import { SpotFixBox, type SpotFixSend } from './preview/spotfix/SpotFixBox'
import { SpotFixCard } from './preview/spotfix/SpotFixCard'
import { currentPreviewUrl, PickSequence } from './preview/spotfix/checkFlow'

const DEVICE_ICONS: Record<DeviceId, React.JSX.Element> = {
  desktop: <Monitor size={13} />,
  tablet: <Tablet size={13} />,
  phone: <Smartphone size={13} />
}

/** A completed pick, waiting for the user to write the note and send it. */
interface Pending {
  pick: SpotFixPick
  /** The page as it looked with the outline still on it, or null when nothing was captured. */
  before: string | null
  anchor: { x: number; y: number }
}

/** Main's reason for refusing a call, as one line for the card or the note box. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function PreviewPanel(): React.JSX.Element {
  const [src, setSrc] = useState(readStoredUrl)
  const [text, setText] = useState(src)
  const [device, setDevice] = useState<DeviceId>('desktop')
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<PreviewFailure | null>(null)
  const [history, setHistory] = useState<Trail>(() => startTrail(src))
  const page = useRef<PreviewApi>(null)
  const field = useRef<HTMLInputElement>(null)

  // Spot fix state. The list mirrors main; the active record is the one shown in the card.
  const [fixes, setFixes] = useState<SpotFix[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  /** Bumped by a navigation or a cancel: a pick that lands after that belongs to a page that is gone. */
  const picksRef = useRef<PickSequence | null>(null)
  const picks = (picksRef.current ??= new PickSequence())
  /** Main's reason for refusing this note, shown in the box so the text is not lost. */
  const [sendError, setSendError] = useState('')
  /** Main's reason for refusing a card action, shown in the card. */
  const [cardError, setCardError] = useState('')
  const [agents, setAgents] = useState<DetectedAgent[]>([])
  const stageWrap = useRef<HTMLDivElement>(null)
  const capturedFor = useRef<Set<string>>(new Set())

  const active = activeId ? (fixes.find((f) => f.id === activeId) ?? null) : null

  // A long address scrolls to its end. Show the start of it instead when the page moved on its own.
  useEffect(() => {
    const input = field.current
    if (input && document.activeElement !== input) input.setSelectionRange(0, 0)
  }, [text])

  /** Loads an address. The same address again reloads, so Enter always does something. */
  const load = useCallback((next: string) => {
    const url = normalizeUrl(next)
    if (url === '') return
    setText(url)
    setFailure(null)
    if (url === src) {
      page.current?.reload()
      return
    }
    setSrc(url)
    storeUrl(url)
  }, [src])

  const reload = useCallback(() => {
    setFailure(null)
    page.current?.reload()
  }, [])

  /** The page moved on its own (a link, Back, Forward): follow it in the URL field. */
  const onNavigate = useCallback(
    (url: string) => {
      setText(url)
      setFailure(null)
      setHistory((trail) => onArrive(trail, url))
      storeUrl(url)
      // A waiting pick and an open note box describe the page that is gone: the element is not there any
      // more, and a before shot taken now would show the new page (finding 7, round 2).
      picks.cancel()
      if (picking) page.current?.cancelPicker()
      setPicking(false)
      setPending(null)
      setSendError('')
    },
    [picking]
  )

  // Keep the Spot fix list in step with main.
  useEffect(() => {
    let live = true
    void bridge
      .invoke('spotfix:list')
      .then((list) => {
        if (live) setFixes(list)
      })
      .catch(() => undefined)
    const off = bridge.on('spotfix:changed', (fix) => {
      setFixes((cur) => {
        const i = cur.findIndex((f) => f.id === fix.id)
        if (i === -1) return [fix, ...cur]
        const next = cur.slice()
        next[i] = fix
        return next
      })
    })
    return () => {
      live = false
      off()
    }
  }, [])

  /** When a round reaches review, reload the page, capture the after and hand it to main. */
  useEffect(() => {
    if (!active || active.status !== 'review') return
    const last = active.rounds[active.rounds.length - 1]
    const sig = `${active.id}:${active.rounds.length}:${last?.endedAt ?? 0}`
    if (capturedFor.current.has(sig)) return
    capturedFor.current.add(sig)
    void (async () => {
      const view = page.current
      if (!view) return
      try {
        const png = await view.reloadAndCapture()
        if (png) await bridge.invoke('spotfix:after', active.id, png)
      } catch {
        // The page may have moved on; the next review transition retries.
      }
    })()
  }, [active])

  const loadSpotFixContext = useCallback(async () => {
    try {
      const list = await bridge.invoke('agents:list')
      setAgents(list.filter((a) => a.installed && SPOTFIX_AGENTS.includes(a.kind)))
    } catch {
      // Keep whatever list was there before.
    }
  }, [])

  /** Places the box near the picked element, inside the preview stage. */
  const computeAnchor = useCallback((pick: SpotFixPick): { x: number; y: number } => {
    const b = page.current?.bounds()
    const wrap = stageWrap.current?.getBoundingClientRect()
    if (!b || !wrap) return { x: 12, y: 12 }
    const rawX = b.left - wrap.left + pick.rect.x
    const rawY = b.top - wrap.top + pick.rect.y + pick.rect.height + 8
    const x = Math.max(8, Math.min(rawX, Math.max(8, wrap.width - 308)))
    const y = Math.max(8, Math.min(rawY, Math.max(8, wrap.height - 40)))
    return { x, y }
  }, [])

  const startPick = useCallback(async () => {
    const view = page.current
    if (!view) return
    // A new pick replaces the current review view, so drop any open card (it would otherwise cover the box).
    const token = picks.start()
    setActiveId(null)
    setPending(null)
    setSendError('')
    setPicking(true)
    void loadSpotFixContext()
    try {
      const pick = await view.injectPicker()
      // The page moved while this was waiting: the element it named is not on the new page.
      if (!picks.current(token)) return
      setPicking(false)
      if (!pick) return
      const before = await view.capturePage()
      if (!picks.current(token)) return
      view.removeOutline()
      setPending({ pick, before, anchor: computeAnchor(pick) })
    } catch {
      // A navigation throws the waiting script away; that same navigation already cleared the flow.
      if (picks.current(token)) setPicking(false)
    }
  }, [computeAnchor, loadSpotFixContext, picks])

  const stopPick = useCallback(() => {
    picks.cancel()
    page.current?.cancelPicker()
    setPicking(false)
  }, [picks])

  const onSpotFixButton = useCallback(() => {
    if (picking) stopPick()
    else void startPick()
  }, [picking, startPick, stopPick])

  const send = useCallback(
    async (s: SpotFixSend) => {
      if (!pending) return
      const req: SpotFixRequest = { pick: pending.pick, note: s.note, agent: s.agent, before: pending.before }
      try {
        const fix = await bridge.invoke('spotfix:start', req)
        setPending(null)
        setSendError('')
        setActiveId(fix.id)
      } catch (err: unknown) {
        // Main refused the start (another agent works here, the agent went away). The note stays written
        // so it can be sent again once the folder is free (finding 7, round 2).
        setSendError(messageOf(err))
      }
    },
    [pending]
  )

  const runOn = useCallback(
    (fn: (id: string) => Promise<unknown>) => {
      if (!active) return
      fn(active.id).catch((err: unknown) => {
        // A refused keep, undo, refine, stop or remove says why in main's words; the card shows it.
        setCardError(messageOf(err))
      })
    },
    [active]
  )

  // Anything that really arrived from main means the record moved on; the refusal is no longer current.
  useEffect(() => {
    setCardError('')
  }, [activeId, active?.updatedAt])

  const web = isWebUrl(src)
  const local = isLocalUrl(currentPreviewUrl(src, history.urls, history.at))

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="preview-panel">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <IconButton onClick={() => page.current?.back()} disabled={!canGoBack(history)} aria-label="Back" title="Back" data-testid="preview-back">
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton onClick={() => page.current?.forward()} disabled={!canGoForward(history)} aria-label="Forward" title="Forward" data-testid="preview-forward">
          <ArrowRight size={14} />
        </IconButton>
        <IconButton onClick={reload} aria-label="Reload" title="Reload" data-testid="preview-reload-button">
          <RotateCw size={14} />
        </IconButton>
        <input
          ref={field}
          data-testid="preview-url"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            load(text)
          }}
          placeholder="http://localhost:3000"
          aria-label="Preview address"
          spellCheck={false}
          autoComplete="off"
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-term px-2 font-mono text-[11.5px] text-fg outline-none transition-colors duration-150 placeholder:text-faint focus:border-accent/50"
        />
        <IconButton
          onClick={() => void bridge.invoke('app:openExternal', src)}
          disabled={!web}
          aria-label="Open in your browser"
          title={web ? 'Open in your browser' : 'Only http and https pages open outside Regatta'}
          data-testid="preview-open"
        >
          <ExternalLink size={14} />
        </IconButton>
        <Button
          size="sm"
          variant={picking ? 'accent' : 'subtle'}
          disabled={!local}
          onClick={onSpotFixButton}
          title={local ? 'Point at something in your app to fix it' : 'Spot fix works on your app running on this computer (localhost).'}
          data-testid="preview-spotfix"
          className="h-[26px] shrink-0 px-2 text-[11.5px]"
        >
          <Crosshair size={13} />
          Spot fix
        </Button>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5">
        {DEVICES.map((d) => (
          <Button
            key={d.id}
            size="sm"
            variant="subtle"
            active={device === d.id}
            onClick={() => setDevice(d.id)}
            title={`${d.label}: ${deviceWidthLabel(d.id).toLowerCase()}`}
            data-testid={`preview-device-${d.id}`}
            className="h-[26px] gap-1 px-2 text-[11.5px]"
          >
            {DEVICE_ICONS[d.id]}
            {d.label}
          </Button>
        ))}
      </div>

      <div ref={stageWrap} className="relative flex min-h-0 flex-1 flex-col">
        <PreviewStage
          ref={page}
          src={src}
          device={device}
          loading={loading}
          onNavigate={onNavigate}
          onLoading={setLoading}
          onFailure={setFailure}
        />

        {failure && (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-panel/95 px-5 text-center backdrop-blur-[2px] animate-fade-in"
            data-testid="preview-error"
          >
            <ServerOff size={20} className="text-faint" />
            <p className="max-w-[240px] text-[12.5px] leading-relaxed text-muted">
              Nothing is running at <span className="font-mono text-fg">{failure.url}</span> yet. Start your dev server,
              then reload.
            </p>
            <Button variant="subtle" size="sm" onClick={reload} data-testid="preview-error-reload">
              <RotateCw size={13} />
              Reload
            </Button>
          </div>
        )}

        {pending && (
          <SpotFixBox
            pick={pending.pick}
            anchor={pending.anchor}
            agents={agents}
            error={sendError}
            onSend={(s) => void send(s)}
            onCancel={() => {
              setPending(null)
              setSendError('')
            }}
          />
        )}

        {active && (
          <SpotFixCard
            fix={active}
            error={cardError}
            onKeep={() => runOn((id) => bridge.invoke('spotfix:keep', id))}
            onUndo={() => runOn((id) => bridge.invoke('spotfix:undo', id))}
            onRefine={(note) => runOn((id) => bridge.invoke('spotfix:refine', id, note))}
            onStop={() => runOn((id) => bridge.invoke('spotfix:stop', id))}
            onRemove={() => {
              runOn((id) => bridge.invoke('spotfix:remove', id))
              setActiveId(null)
            }}
            onClose={() => setActiveId(null)}
          />
        )}
      </div>
    </div>
  )
}
