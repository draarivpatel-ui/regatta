// The timeline under the player: a ruler in seconds, the scene strip (one block per scene, as wide as
// its share of the length, with its thumbnail), the captions, and a playhead you can drag.

import { useMemo } from 'react'
import type { VideoProject } from '@shared/video'
import { cx, Kbd } from '../../components/ui'
import { formatClock, formatSeconds, formatTick, rulerStep, rulerTicks, sceneAtTime } from './common'
import type { RuntimeCaption } from './usePlayer'
import { useSize } from './useSize'

interface TimelineProps {
  video: VideoProject
  total: number
  time: number
  /** Null while the page has not said what its captions are: nothing is claimed about them then. */
  captions: RuntimeCaption[] | null
  /** False until there is a built video to move through. */
  enabled: boolean
  onSeek: (t: number) => void
  /** Called when the user takes hold of the timeline, so playback stops. */
  onGrab: () => void
}

export function Timeline(props: TimelineProps): React.JSX.Element {
  // Two components, so the size the strip measures belongs to the strip's own element for as long as it exists.
  return props.enabled ? <Strip {...props} /> : <Placeholder />
}

/** Before there is a video: one calm box, and nothing that could be dragged. */
function Placeholder(): React.JSX.Element {
  return (
    <div data-testid="video-timeline" className="shrink-0 border-t border-line bg-chrome p-3">
      <div className="flex h-[58px] items-center justify-center rounded-lg bg-panel outline outline-1 -outline-offset-1 outline-line-strong">
        <p className="px-3 text-center text-[11.5px] text-faint" data-testid="video-timeline-empty">
          The scenes show up here once the video is built.
        </p>
      </div>
    </div>
  )
}

function Strip({ video, total, time, captions, onSeek, onGrab }: TimelineProps): React.JSX.Element {
  const [rows, { width }] = useSize<HTMLDivElement>()
  const percent = (t: number): number => (total > 0 ? Math.max(0, Math.min(100, (t / total) * 100)) : 0)
  const active = sceneAtTime(video.scenes, time)
  // A wide frame fills its block like a film strip. A tall or square one is shown whole, or the strip would show
  // a band across its middle that no longer looks like anything.
  const wide = video.width / video.height >= 1.2

  const ticks = useMemo(() => rulerTicks(total, rulerStep(total, width)), [total, width])

  const seekFromPointer = (e: React.PointerEvent): void => {
    const box = rows.current?.getBoundingClientRect()
    if (!box || box.width <= 0 || total <= 0) return
    onSeek(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * total)
  }
  const grab = (e: React.PointerEvent): void => {
    onGrab()
    e.currentTarget.setPointerCapture(e.pointerId)
    seekFromPointer(e)
  }
  const drag = (e: React.PointerEvent): void => {
    if (e.buttons === 1) seekFromPointer(e)
  }

  return (
    <div data-testid="video-timeline" className="shrink-0 border-t border-line bg-chrome px-3 pb-2 pt-2.5">
      <div ref={rows} className="relative select-none">
        <div data-testid="video-ruler" className="relative h-6 cursor-pointer" onPointerDown={grab} onPointerMove={drag}>
          {ticks.map((s) => (
            <span
              key={s}
              className="pointer-events-none absolute top-0 -translate-x-1/2 text-[11px] leading-[14px] tabular-nums text-faint"
              style={{ left: `${percent(s)}%` }}
            >
              {formatTick(s)}
            </span>
          ))}
        </div>

        <div className="relative flex h-[58px] overflow-hidden rounded-lg bg-panel outline outline-1 -outline-offset-1 outline-line-strong">
          {video.scenes.map((scene) => {
            const thumb = video.thumbnails[scene.id]
            const here = active?.id === scene.id
            return (
              <button
                type="button"
                key={scene.id}
                data-testid={`video-scene-${scene.id}`}
                data-active={here ? 'true' : undefined}
                aria-label={`${scene.title}, starts at ${formatClock(scene.start)}`}
                aria-current={here ? 'true' : undefined}
                onClick={() => {
                  onGrab()
                  onSeek(scene.start)
                }}
                className="group @container relative h-full shrink-0 overflow-hidden border-r border-line bg-raised text-left outline-none last:border-r-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                style={{ width: `${(scene.duration / total) * 100}%` }}
              >
                {thumb && (
                  <img
                    src={`regatta-video://${video.id}/${thumb}`}
                    alt=""
                    draggable={false}
                    className={cx(
                      'pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-150 group-hover:opacity-90',
                      wide ? 'object-cover' : 'object-contain'
                    )}
                  />
                )}
                <span className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/80 via-black/20 to-transparent" />
                <span className="pointer-events-none absolute inset-x-0 top-0 flex items-baseline gap-1.5 px-1.5 pt-1">
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-fg">{scene.title}</span>
                  <span className="hidden shrink-0 text-[11px] tabular-nums text-muted @min-[88px]:inline">{formatSeconds(scene.duration)}</span>
                </span>
                {here && <span className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-accent/60" />}
              </button>
            )
          })}
        </div>

        <div data-testid="video-captions" className="relative mt-1.5 h-5 cursor-pointer rounded-md bg-panel" onPointerDown={grab} onPointerMove={drag}>
          {captions !== null && captions.length === 0 && (
            <span className="pointer-events-none absolute inset-0 flex items-center px-2 text-[11px] text-faint">No captions</span>
          )}
          {(captions ?? []).map((c, i) => (
            <span
              key={`${c.start}-${i}`}
              title={c.text}
              className="pointer-events-none absolute bottom-0.5 top-0.5 truncate rounded-sm bg-press px-1.5 text-[11px] leading-4 text-muted"
              style={{
                left: `${percent(c.start)}%`,
                width: `${Math.max(0, percent(Math.min(c.end, total)) - percent(c.start))}%`
              }}
            >
              {c.text}
            </span>
          ))}
        </div>

        <div
          aria-hidden
          data-testid="video-playhead"
          data-percent={percent(time).toFixed(2)}
          className="pointer-events-none absolute bottom-0 top-[13px] z-10 w-px -translate-x-1/2 bg-accent"
          style={{ left: `${percent(time)}%` }}
        />
        <div
          aria-hidden
          data-testid="video-playhead-handle"
          className="absolute top-[13px] z-10 h-[11px] w-3.5 -translate-x-1/2 cursor-ew-resize bg-accent [clip-path:polygon(0_0,100%_0,50%_100%)]"
          style={{ left: `${percent(time)}%` }}
          onPointerDown={grab}
          onPointerMove={drag}
        />
      </div>
      <p data-testid="video-hints" className="mt-2 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-faint">
        <Kbd>Space</Kbd> play <Kbd>←</Kbd> <Kbd>→</Kbd> one frame
        <span className="ml-1 hidden @min-[440px]:inline">Click a scene to jump to it.</span>
      </p>
    </div>
  )
}
