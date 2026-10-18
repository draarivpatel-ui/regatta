// The center of Video mode: the player (a webview on the video's own page), its frame controls and the
// timeline under it, and pointing at a frame to ask for a change.
//
// The page inside the webview fits its stage to the webview's own box (resources/video/regatta-video.js),
// so this panel only has to give the webview the whole player area. It never scales anything itself.

import { useState } from 'react'
import { Crosshair, Pause, Play, SkipBack, StepBack, StepForward, Volume2, VolumeX } from 'lucide-react'
import type { VideoProject } from '@shared/video'
import { Button, IconButton, cx } from '../../components/ui'
import { StatusDot } from '../../components/marks'
import { useVideo } from '../../store/video'
import { fitRect, formatClock, formatMeta, sceneAtTime, STATUS_WORDS, videoDotState } from './common'
import { PointBox, type PointSpot } from './PointBox'
import { noticeFor } from './notice'
import { StageNotice } from './StageNotice'
import { Timeline } from './Timeline'
import { usePlayer } from './usePlayer'
import { useSize } from './useSize'

/** True for the places the user types, where Space and the arrow keys belong to the text. */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('textarea, input, select, [contenteditable="true"]') !== null
}

export function PlayerPanel({ video }: { video: VideoProject }): React.JSX.Element {
  const changeAt = useVideo((s) => s.changeAt)
  const setTab = useVideo((s) => s.setTab)
  const player = usePlayer(video)
  const { time, total, playing, muted, phase } = player

  const [region, regionSize] = useSize<HTMLDivElement>()
  const [pointing, setPointing] = useState(false)
  const [spot, setSpot] = useState<PointSpot | null>(null)
  const [note, setNote] = useState('')

  const src = `regatta-video://${video.id}/index.html?mode=player`
  const hasVideo = video.duration !== null && video.scenes.length > 0
  const usable = hasVideo && phase === 'ready'
  const notice = noticeFor(video, hasVideo, phase)
  // Where the picture is inside the area: what is left over is the black bars, which are not the frame. The page draws
  // its stage at its own size, which is the video's unless the agent changed the meta tag (a check says so).
  const picture = fitRect(regionSize, player.stage)

  const closePoint = (): void => {
    setSpot(null)
    setPointing(false)
    setNote('')
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && (pointing || spot)) {
      e.preventDefault()
      e.stopPropagation()
      closePoint()
      return
    }
    // In the note field Space and the arrows are text, not player keys.
    if (isTyping(e.target)) return
    if (e.metaKey || e.ctrlKey || e.altKey || !usable) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      e.stopPropagation()
      player.stepFrame(-1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      e.stopPropagation()
      player.stepFrame(1)
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      e.stopPropagation()
      player.toggle()
    } else if (e.key === 'Home') {
      e.preventDefault()
      player.stop()
      player.seekTo(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      player.stop()
      player.seekTo(total)
    }
  }

  // Point: pause, ask the page what is under the click, open the note box there.
  const onPointClick = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    player.stop()
    const area = region.current
    if (!area) return
    const box = area.getBoundingClientRect()
    // The page fills this area, so a spot is the same fraction of both.
    const fx = box.width > 0 ? Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) : 0.5
    const fy = box.height > 0 ? Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)) : 0.5
    const hit = await player.inspectAt(fx, fy)
    // A click in a bar is not a click on the frame.
    if (hit?.outside) return
    const px = e.clientX - box.left
    const py = e.clientY - box.top
    setSpot({
      boxX: px,
      boxY: py,
      // When the page does not answer, the spot still has real stage coordinates, from where the picture is.
      x: hit?.x ?? (picture.width > 0 ? ((px - picture.left) / picture.width) * player.stage.width : 0),
      y: hit?.y ?? (picture.height > 0 ? ((py - picture.top) / picture.height) * player.stage.height : 0),
      scene: hit?.scene ?? sceneAtTime(video.scenes, time)?.id ?? null,
      selector: hit?.selector ?? null,
      text: hit?.text ?? '',
      time
    })
    setNote('')
  }

  const sendChange = async (): Promise<void> => {
    if (!spot) return
    const wish = note.trim()
    if (wish.length === 0) return
    const request = {
      time: spot.time,
      scene: spot.scene,
      selector: spot.selector,
      text: spot.text,
      x: spot.x,
      y: spot.y,
      note: wish
    }
    closePoint()
    setTab('activity')
    await changeAt(video.id, request)
  }

  return (
    <section className="@container flex h-full min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-line px-4">
        <StatusDot state={videoDotState(video.status)} size={7} />
        <h2 className="min-w-0 truncate text-[13.5px] font-semibold tracking-[-0.01em] text-fg" data-testid="video-title-label">
          {video.title}
        </h2>
        <span className="shrink-0 rounded-full border border-line-strong px-1.5 py-px text-[11px] text-muted" data-testid="video-aspect">
          {video.aspect}
        </span>
        {video.duration !== null && (
          <span className="hidden shrink-0 text-[11px] tabular-nums text-faint @min-[520px]:inline" data-testid="video-meta">
            {formatMeta(video.duration, video.width, video.height, video.fps)}
          </span>
        )}
        <span className="hidden shrink-0 rounded-full bg-press px-1.5 py-px text-[11px] text-muted @min-[400px]:inline" data-testid="video-labs-tag">
          Labs
        </span>
        <span className="ml-auto shrink-0 text-[12px] text-muted" data-testid="video-status">
          {STATUS_WORDS[video.status]}
        </span>
      </header>

      <div
        ref={region}
        tabIndex={0}
        data-testid="video-player"
        data-phase={hasVideo ? phase : 'empty'}
        onKeyDown={onKeyDown}
        className="group relative min-h-0 flex-1 overflow-hidden bg-term outline-none"
      >
        {hasVideo && (
          // No display class on the webview: it keeps its own display:flex, or its frame collapses to 150 px.
          <webview ref={player.attach} src={src} partition="regatta-video" data-testid="video-webview" className="h-full w-full bg-term" />
        )}

        {notice && (
          <StageNotice notice={notice} overlay={hasVideo} onActivity={() => setTab('activity')} />
        )}

        {usable && !pointing && (
          // The page swallows clicks, so a click on the frame lands here and gives the player the keyboard.
          <div data-testid="video-surface" className="absolute inset-0 z-10" onClick={() => region.current?.focus()} />
        )}
        {usable && pointing && (
          // The crosshair is over the picture only. A click in a bar just keeps the keyboard in the player.
          <div data-testid="video-point-shield" className="absolute inset-0 z-10" onClick={() => region.current?.focus()}>
            <div
              data-testid="video-point-overlay"
              aria-label="Point at the frame"
              onClick={(e) => void onPointClick(e)}
              className="absolute cursor-crosshair"
              style={{ left: picture.left, top: picture.top, width: picture.width, height: picture.height }}
            />
          </div>
        )}
        {usable && pointing && !spot && (
          <p className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 whitespace-nowrap rounded-full border border-line-strong bg-raised/90 px-3 py-1 text-[11.5px] text-muted backdrop-blur">
            Click the part of the frame to change. Esc cancels.
          </p>
        )}
        {spot && (
          <PointBox
            spot={spot}
            region={regionSize}
            note={note}
            onNote={setNote}
            onSend={() => void sendChange()}
            onCancel={closePoint}
          />
        )}

        {/* The focus ring sits on top of the page, which would otherwise cover it. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-30 opacity-0 ring-2 ring-inset ring-accent/40 transition-opacity duration-150 group-focus-visible:opacity-100"
        />
      </div>

      <div data-testid="video-controls" className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-t border-line bg-chrome px-3 py-1.5">
        <IconButton
          aria-label="Back to start"
          title="Back to start (Home)"
          disabled={!usable}
          onClick={() => {
            player.stop()
            player.seekTo(0)
          }}
        >
          <SkipBack size={14} />
        </IconButton>
        <IconButton aria-label="Previous frame" title="Previous frame (Left arrow)" disabled={!usable} onClick={() => player.stepFrame(-1)}>
          <StepBack size={14} />
        </IconButton>
        <IconButton
          aria-label={playing ? 'Pause' : 'Play'}
          title="Play or pause (Space)"
          variant="subtle"
          data-testid="video-play"
          data-playing={playing ? 'true' : 'false'}
          disabled={!usable}
          onClick={player.toggle}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </IconButton>
        <IconButton aria-label="Next frame" title="Next frame (Right arrow)" disabled={!usable} onClick={() => player.stepFrame(1)}>
          <StepForward size={14} />
        </IconButton>
        <IconButton
          aria-label={muted ? 'Unmute' : 'Mute'}
          title={muted ? 'Unmute' : 'Mute'}
          data-testid="video-mute"
          active={muted}
          disabled={!usable}
          onClick={player.toggleMute}
        >
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </IconButton>
        <span
          className="ml-2 whitespace-nowrap text-[12px] tabular-nums"
          data-testid="video-time"
          data-time={time.toFixed(4)}
          data-duration={total.toFixed(2)}
        >
          <span className={usable ? 'text-fg' : 'text-faint'}>{formatClock(time)}</span>
          <span className="text-faint"> / {formatClock(total)}</span>
        </span>
        <div className="ml-auto flex items-center">
          <Button
            variant="ghost"
            size="sm"
            active={pointing}
            aria-pressed={pointing}
            title="Click a spot on the frame to ask for a change there"
            data-testid="video-point"
            disabled={!usable}
            className={cx(pointing && 'border border-accent/50 !text-accent-bright')}
            onClick={() => {
              setPointing((p) => !p)
              setSpot(null)
              setNote('')
              // So Esc works straight away.
              region.current?.focus()
            }}
          >
            <Crosshair size={13} />
            Point
          </Button>
        </div>
      </div>

      <Timeline
        video={video}
        total={total}
        time={time}
        captions={player.captions}
        enabled={hasVideo}
        onSeek={player.seekTo}
        onGrab={player.stop}
      />

      <audio ref={player.audio} className="hidden" />
    </section>
  )
}
