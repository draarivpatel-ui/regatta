// The page itself: one Electron webview inside the device frame, with a loading bar above it.

import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import type { NativeImage, WebviewTag } from 'electron'
import { cx } from '../../components/ui'
import { DEVICES, type DeviceId } from './devices'
import type { SpotFixPick } from '@shared/spotfix'
import { CANCEL_PICKER_SOURCE, PICKER_SOURCE, REMOVE_OUTLINE_SOURCE } from './spotfix/picker'

export interface PreviewFailure {
  /** The address that would not load, for the message under the toolbar. */
  url: string
}

/** What the toolbar buttons and the Spot fix flow need from the page. */
export interface PreviewApi {
  back(): void
  forward(): void
  reload(): void
  /** Runs the picker in the page; resolves with the picked element (url included), or null when cancelled. */
  injectPicker(): Promise<SpotFixPick | null>
  /** Aborts a picker that is waiting, without leaving an outline behind. */
  cancelPicker(): void
  /** A PNG data URL of the visible page, or null when the capture came back empty. */
  capturePage(): Promise<string | null>
  /** Removes the outline left by a pick. */
  removeOutline(): void
  /** Reloads, waits for the page to settle, then captures the "after" image; null when nothing was captured. */
  reloadAndCapture(): Promise<string | null>
  /** The webview element's box in viewport coordinates, so the note box can anchor near the pick. */
  bounds(): { left: number; top: number; width: number; height: number } | null
}

/** Reads the page as a PNG data URL, or null when the capture comes back empty or fails. */
async function grab(view: WebviewTag): Promise<string | null> {
  try {
    const image: NativeImage = await view.capturePage()
    if (image.isEmpty()) return null
    const url = image.toDataURL()
    return url.startsWith('data:image/png;base64,') && url.length > 'data:image/png;base64,'.length ? url : null
  } catch {
    return null
  }
}

/** Resolves when the webview finishes loading, or after the timeout so a stall cannot hang the flow. */
function waitForStopLoading(view: WebviewTag, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      view.removeEventListener('did-stop-loading', done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    view.addEventListener('did-stop-loading', done)
  })
}

/** Waits `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Back and Forward ask the page to move through its own history. The webview element's own
 * goBack and canGoBack report nothing here, even after the page follows a link.
 */
function step(view: WebviewTag | null, where: 'back' | 'forward'): void {
  if (view) void view.executeJavaScript(`history.${where}()`)
}

export interface PreviewStageProps {
  src: string
  device: DeviceId
  loading: boolean
  ref?: Ref<PreviewApi>
  onNavigate: (url: string) => void
  onLoading: (loading: boolean) => void
  onFailure: (failure: PreviewFailure | null) => void
}

/** The webview events carry fields of their own, which the DOM types do not describe. */
interface NavigateEvent extends Event {
  url: string
}

interface FailEvent extends Event {
  errorCode: number
  validatedURL: string
  isMainFrame: boolean
}

/** An aborted load (code -3) happens on every redirect and every reload. It is not a failure. */
const ABORTED = -3

export function PreviewStage({
  src,
  device,
  loading,
  ref,
  onNavigate,
  onLoading,
  onFailure
}: PreviewStageProps): React.JSX.Element {
  const view = useRef<WebviewTag | null>(null)

  // The listeners are attached once. They call the newest callbacks through this ref,
  // so they never read a stale prop.
  const latest = useRef({ onNavigate, onLoading, onFailure })
  latest.current = { onNavigate, onLoading, onFailure }

  useEffect(() => {
    const element = view.current
    if (!element) return

    const navigate = (event: Event): void => {
      latest.current.onNavigate((event as NavigateEvent).url)
    }
    const fail = (event: Event): void => {
      const detail = event as FailEvent
      if (detail.errorCode === ABORTED) return
      if (detail.isMainFrame === false) return
      latest.current.onFailure({ url: detail.validatedURL || element.getURL() })
    }

    const listeners: [string, EventListener][] = [
      ['did-navigate', navigate],
      ['did-navigate-in-page', navigate],
      ['did-start-loading', () => latest.current.onLoading(true)],
      ['did-stop-loading', () => latest.current.onLoading(false)],
      ['did-fail-load', fail]
    ]
    for (const [name, listener] of listeners) element.addEventListener(name, listener)
    return () => {
      for (const [name, listener] of listeners) element.removeEventListener(name, listener)
    }
  }, [])

  useImperativeHandle(
    ref,
    (): PreviewApi => ({
      back: () => step(view.current, 'back'),
      forward: () => step(view.current, 'forward'),
      reload: () => view.current?.reload(),

      injectPicker: async () => {
        const element = view.current
        if (!element) return null
        const picked = (await element.executeJavaScript(PICKER_SOURCE)) as Omit<SpotFixPick, 'url'> | null
        if (!picked) return null
        return { ...picked, url: element.getURL() }
      },

      cancelPicker: () => {
        void view.current?.executeJavaScript(CANCEL_PICKER_SOURCE)
      },

      capturePage: async () => {
        const element = view.current
        if (!element) return null
        return grab(element)
      },

      removeOutline: () => {
        void view.current?.executeJavaScript(REMOVE_OUTLINE_SOURCE)
      },

      reloadAndCapture: async () => {
        const element = view.current
        if (!element) return null
        element.reload()
        await waitForStopLoading(element, 20_000)
        // A short rest lets the freshly loaded frame paint before it is captured.
        await sleep(800)
        return grab(element)
      },

      bounds: () => {
        const element = view.current
        if (!element) return null
        const r = element.getBoundingClientRect()
        return { left: r.left, top: r.top, width: r.width, height: r.height }
      }
    }),
    []
  )

  const width = DEVICES.find((d) => d.id === device)?.width ?? null

  return (
    <div className="relative min-h-0 flex-1">
      <div
        className={cx(
          'pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px] bg-line transition-opacity duration-150',
          loading ? 'opacity-100' : 'opacity-0'
        )}
        data-testid="preview-loading"
        data-loading={loading ? 'yes' : 'no'}
      >
        <div className="h-full w-full bg-accent animate-pulse" />
      </div>

      <div className="flex h-full overflow-auto p-2">
        <div
          className={cx(
            'mx-auto h-full shrink-0 overflow-hidden',
            width === null ? 'w-full' : 'rounded-[10px] ring-1 ring-line'
          )}
        >
          <webview
            ref={view}
            src={src}
            partition="persist:regatta-preview"
            data-testid="preview-webview"
            className="block h-full w-full bg-term"
            style={width === null ? undefined : { width }}
          />
        </div>
      </div>
    </div>
  )
}