// The player's engine for Video mode: it drives the video's own page inside the webview one frame at
// a time (RegattaVideo.seekSync), runs the clock while it plays, and keeps the music in step.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import type { VideoProject } from '@shared/video'
import { isRunning } from './common'
import type { PlayerPhase } from './notice'

export interface RuntimeCaption {
  start: number
  end: number
  text: string
}

interface RuntimeMeta {
  duration: number
  fps: number
  /** The size the page itself draws its stage at (its regatta-video meta tag). */
  width: number
  height: number
  captions: RuntimeCaption[]
}

/** What the runtime says is under a point on the frame, in stage coordinates. */
export interface PointHit {
  /** True when the spot is outside the stage (in a bar): there is nothing there to point at. */
  outside: boolean
  selector: string | null
  text: string
  scene: string | null
  x: number
  y: number
}

export interface Player {
  /** Hand this to the webview's ref. The player starts listening the moment the element exists. */
  attach: (el: WebviewTag | null) => void
  audio: React.RefObject<HTMLAudioElement | null>
  phase: PlayerPhase
  /** The captions the page declares, or null while the page has not said (never loaded, or still loading). */
  captions: RuntimeCaption[] | null
  /** The size of the stage the page draws: its own, once it has said, else the video's. The picture is this shape. */
  stage: { width: number; height: number }
  /** The length the player plays to: the one stored with the video, else the page's own. */
  total: number
  time: number
  playing: boolean
  muted: boolean
  toggle: () => void
  stop: () => void
  seekTo: (t: number) => void
  /** One frame forward (1) or back (-1), landing on a whole frame. */
  stepFrame: (dir: number) => void
  toggleMute: () => void
  /** Asks the page what is drawn at a spot given as fractions of the player (0 to 1 across and down). */
  inspectAt: (fx: number, fy: number) => Promise<PointHit | null>
}

export function usePlayer(video: VideoProject): Player {
  const el = useRef<WebviewTag | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const ready = useRef(false)
  const timeRef = useRef(0)
  const clock = useRef({ base: 0, wall: 0 })
  const raf = useRef<number | null>(null)
  const duration = useRef(0)
  const loadToken = useRef(0)
  const storedDuration = useRef<number | null>(video.duration)
  storedDuration.current = video.duration

  const [phase, setPhase] = useState<PlayerPhase>('loading')
  const [runtime, setRuntime] = useState<RuntimeMeta | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)

  const total = video.duration ?? runtime?.duration ?? 0
  duration.current = total > 0 ? total : duration.current

  const callSeek = useCallback((t: number): void => {
    const node = el.current
    if (!node || !ready.current) return
    void node.executeJavaScript(`window.RegattaVideo && RegattaVideo.seekSync(${t})`).catch(() => undefined)
  }, [])

  const setTimeBoth = useCallback((t: number): void => {
    timeRef.current = t
    setTime(t)
    const a = audio.current
    if (a && Number.isFinite(t) && a.src && Math.abs(a.currentTime - t) > 0.3) a.currentTime = t
  }, [])

  const stop = useCallback((): void => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    raf.current = null
    setPlaying(false)
    audio.current?.pause()
  }, [])

  const tick = useCallback((): void => {
    const { base, wall } = clock.current
    const t = base + (performance.now() - wall) / 1000
    const cap = duration.current
    if (t >= cap) {
      setTimeBoth(cap)
      callSeek(cap)
      stop()
      return
    }
    setTimeBoth(t)
    callSeek(t)
    raf.current = requestAnimationFrame(tick)
  }, [callSeek, setTimeBoth, stop])

  const play = useCallback((): void => {
    if (!ready.current || duration.current <= 0) return
    const from = timeRef.current >= duration.current - 0.01 ? 0 : timeRef.current
    setTimeBoth(from)
    clock.current = { base: from, wall: performance.now() }
    setPlaying(true)
    const a = audio.current
    if (a && a.src) {
      a.currentTime = from
      void a.play().catch(() => undefined)
    }
    raf.current = requestAnimationFrame(tick)
  }, [setTimeBoth, tick])

  const toggle = useCallback((): void => {
    if (raf.current !== null) stop()
    else play()
  }, [play, stop])

  const seekTo = useCallback(
    (t: number): void => {
      const clamped = Math.max(0, Math.min(Number.isFinite(t) ? t : 0, duration.current))
      setTimeBoth(clamped)
      callSeek(clamped)
    },
    [callSeek, setTimeBoth]
  )

  const stepFrame = useCallback(
    (dir: number): void => {
      stop()
      const fps = video.fps || 30
      // From the nearest whole frame, so a run of steps lands on exact frames and the clock reads them.
      seekTo((Math.round(timeRef.current * fps) + dir) / fps)
    },
    [seekTo, stop, video.fps]
  )

  const toggleMute = useCallback((): void => setMuted((m) => !m), [])

  // Reads the composition once its page is up, puts the page back where the playhead is, and gets the music.
  const init = useCallback(
    async (node: WebviewTag): Promise<void> => {
      const mine = ++loadToken.current
      const current = (): boolean => el.current === node && mine === loadToken.current
      ready.current = false
      setPhase('loading')
      try {
        await node.executeJavaScript('window.RegattaVideo.ready.then(function(){return true})')
        if (!current()) return
        const meta = (await node.executeJavaScript(
          '({duration: RegattaVideo.duration, fps: RegattaVideo.fps, width: RegattaVideo.width, height: RegattaVideo.height, captions: RegattaVideo.captions})'
        )) as RuntimeMeta
        if (!current()) return
        setRuntime(meta)
        duration.current = storedDuration.current ?? meta.duration
        ready.current = true
        const at = Math.max(0, Math.min(timeRef.current, duration.current))
        setTimeBoth(at)
        await node.executeJavaScript(`RegattaVideo.seek(${at})`)
        if (!current()) return
        setPhase('ready')
        const wav = (await node.executeJavaScript('RegattaVideo.renderAudio()')) as string | null
        if (!current()) return
        const a = audio.current
        if (a) {
          if (wav) a.src = `data:audio/wav;base64,${wav}`
          else {
            a.removeAttribute('src')
            a.load()
          }
        }
      } catch {
        if (!current()) return
        ready.current = false
        setPhase('error')
      }
    },
    [setTimeBoth]
  )

  // The listeners go on in the same breath as the element, so a page that loads fast is not missed.
  const attach = useCallback(
    (node: WebviewTag | null): void => {
      cleanup.current?.()
      cleanup.current = null
      el.current = node
      ready.current = false
      if (!node) return
      // A new page is on its way. Whatever the last one said ("ready", "error") is not about this one.
      setPhase('loading')
      const onStop = (): void => void init(node)
      const onFail = (event: Event): void => {
        const info = event as Event & { errorCode?: number; isMainFrame?: boolean }
        // -3 is a load that was cancelled by the next one (a reload); that is not a failure.
        if (info.isMainFrame === false || info.errorCode === -3) return
        loadToken.current++
        ready.current = false
        setPhase('error')
      }
      node.addEventListener('did-stop-loading', onStop)
      node.addEventListener('did-fail-load', onFail)
      node.addEventListener('render-process-gone', onFail)
      cleanup.current = () => {
        loadToken.current++
        node.removeEventListener('did-stop-loading', onStop)
        node.removeEventListener('did-fail-load', onFail)
        node.removeEventListener('render-process-gone', onFail)
      }
    },
    [init]
  )

  // A finished turn rewrote the page: reload it. The playhead stays where it was, so a change made at a
  // spot can be looked at right away.
  const running = isRunning(video.status)
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !running) {
      stop()
      ready.current = false
      if (el.current) setPhase('loading')
      try {
        el.current?.reload()
      } catch {
        // A page that never finished loading has nothing to reload; its own load will read the new files.
      }
    }
    wasRunning.current = running
  }, [running, stop])

  useEffect(() => () => stop(), [stop])

  // The music follows the mute switch.
  useEffect(() => {
    if (audio.current) audio.current.muted = muted
  }, [muted])

  const inspectAt = useCallback(async (fx: number, fy: number): Promise<PointHit | null> => {
    const node = el.current
    if (!node || !ready.current) return null
    try {
      return (await node.executeJavaScript(
        `(function(){
          var rv=window.RegattaVideo; if(!rv) return null;
          var stage=document.getElementById('stage')||document.body;
          var r=stage.getBoundingClientRect();
          var sc=(r.width/(rv.width||1))||1;
          var sx=((${fx})*window.innerWidth-r.left)/sc, sy=((${fy})*window.innerHeight-r.top)/sc;
          if(sx<0||sy<0||sx>rv.width||sy>rv.height) return {outside:true,selector:null,text:'',scene:null,x:sx,y:sy};
          var h=rv.inspect(sx,sy);
          return {outside:false,selector:h?h.selector:null,text:h?h.text:'',scene:h?h.scene:null,x:sx,y:sy};
        })()`
      )) as PointHit | null
    } catch {
      return null
    }
  }, [])

  return {
    attach,
    audio,
    phase,
    captions: runtime ? runtime.captions : null,
    stage: runtime && runtime.width > 0 && runtime.height > 0 ? { width: runtime.width, height: runtime.height } : { width: video.width, height: video.height },
    total,
    time,
    playing,
    muted,
    toggle,
    stop,
    seekTo,
    stepFrame,
    toggleMute,
    inspectAt
  }
}
