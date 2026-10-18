// The Render tab: Render MP4, progress while it runs, and the finished files with Show in Finder.

import { FolderOpen, Square } from 'lucide-react'
import type { VideoProject, VideoRender } from '@shared/video'
import { Button, cx } from '../../components/ui'
import { useVideo } from '../../store/video'
import { formatBytes, formatLoudness, formatMeta, formatTimeOfDay, isRunning } from './common'
import { InlineError } from './InlineError'

function RenderRow({ video, render }: { video: VideoProject; render: VideoRender }): React.JSX.Element {
  const reveal = useVideo((s) => s.reveal)
  const loudness = formatLoudness(render.loudness)
  return (
    <li className="rounded-lg border border-line bg-panel/60 px-2.5 py-2" data-testid={`video-render-${render.id}`} data-status={render.status}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg" title={render.path}>
          {render.path.split('/').pop()}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-faint">{formatTimeOfDay(render.startedAt)}</span>
      </div>
      {render.status === 'done' ? (
        <div className="mt-1.5 flex items-center gap-2.5 text-[11px] text-muted">
          {render.sizeBytes !== null && <span className="tabular-nums">{formatBytes(render.sizeBytes)}</span>}
          {loudness && <span className="tabular-nums">{loudness}</span>}
          <Button variant="ghost" size="sm" className="ml-auto" data-testid="video-reveal" onClick={() => void reveal(video.id, render.id)}>
            <FolderOpen size={13} />
            Show in Finder
          </Button>
        </div>
      ) : (
        <p className={cx('mt-1 text-[11.5px] leading-relaxed', render.status === 'failed' ? 'text-st-failed' : 'text-muted')}>
          {render.note || render.status}
        </p>
      )}
    </li>
  )
}

export function RenderTab({ video }: { video: VideoProject }): React.JSX.Element {
  const ffmpeg = useVideo((s) => s.ffmpeg)
  const render = useVideo((s) => s.render)
  const stopVideo = useVideo((s) => s.stop)
  const active = video.renders.find((r) => r.status === 'rendering') ?? null
  const finished = video.renders.filter((r) => r.status !== 'rendering')
  const ready = video.status === 'ready'
  const canRender = ready && typeof ffmpeg === 'string' && !isRunning(video.status) && !active
  const percent = active ? Math.round(active.progress * 100) : 0

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <InlineError />

      <section className="shrink-0 rounded-lg border border-line bg-panel/60 p-3">
        <p className="text-[12.5px] font-medium text-fg">Render an MP4</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">Draws every frame on this computer and saves one MP4 file.</p>
        {video.duration !== null && (
          <p className="mt-1 text-[11px] tabular-nums text-faint" data-testid="video-render-meta">
            {formatMeta(video.duration, video.width, video.height, video.fps)}
          </p>
        )}
        <Button
          variant="accent"
          size="md"
          className="mt-3 w-full justify-center"
          data-testid="video-render"
          disabled={!canRender}
          onClick={() => void render(video.id)}
        >
          Render MP4
        </Button>
        {!ready && (
          <p className="mt-2 text-[11px] leading-relaxed text-faint" data-testid="video-render-hint">
            Rendering turns on when the video is Ready.
          </p>
        )}
        {ffmpeg === null && (
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted" data-testid="video-ffmpeg-hint">
            Rendering needs ffmpeg. Install it with Homebrew: <span className="font-mono text-fg">brew install ffmpeg</span>
          </p>
        )}
      </section>

      {active && (
        <section className="shrink-0 rounded-lg border border-line bg-panel/60 p-3" data-testid="video-render-active">
          <div className="flex items-center justify-between text-[11.5px] text-muted">
            <span>Rendering</span>
            <span className="tabular-nums" data-testid="video-render-progress">
              {percent}%
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-press" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${percent}%` }} />
          </div>
          <Button variant="outline" size="sm" className="mt-2.5" data-testid="video-render-stop" onClick={() => void stopVideo(video.id)}>
            <Square size={13} />
            Stop
          </Button>
        </section>
      )}

      <section className="shrink-0">
        <h3 className="mb-1.5 text-[12px] font-medium text-muted">Finished files</h3>
        {finished.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-faint" data-testid="video-renders-empty">
            Nothing rendered yet. Finished files show up here.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {finished.map((r) => (
              <RenderRow key={r.id} video={video} render={r} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
