// The left column of Video mode: the list of videos and the New video button.

import type { VideoProject } from '@shared/video'
import { Button, cx } from '../../components/ui'
import { StatusDot } from '../../components/marks'
import { formatSeconds, STATUS_WORDS, videoDotState } from './common'

interface VideoListProps {
  videos: VideoProject[]
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}

export function VideoList({ videos, selectedId, onSelect, onNew }: VideoListProps): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[46px] shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <span className="text-[12.5px] font-semibold text-fg">Videos</span>
        <Button variant="subtle" size="sm" data-testid="video-new" onClick={onNew}>
          New video
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {videos.length === 0 ? (
          <p className="px-2 py-3 text-[12.5px] text-muted" data-testid="video-list-empty">
            No videos yet.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {videos.map((video) => {
              const selected = video.id === selectedId
              return (
                <li key={video.id}>
                  <button
                    type="button"
                    data-testid={`video-row-${video.id}`}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onSelect(video.id)}
                    className={cx(
                      'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-150',
                      'focus-visible:ring-2 focus-visible:ring-accent/50',
                      selected ? 'bg-press text-fg' : 'text-muted hover:bg-hover hover:text-fg'
                    )}
                  >
                    <span className="mt-[5px] shrink-0">
                      <StatusDot state={videoDotState(video.status)} size={7} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{video.title}</span>
                        {video.duration !== null && (
                          <span className="shrink-0 text-[11px] tabular-nums text-faint">{formatSeconds(video.duration)}</span>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                        <span data-testid={`video-state-${video.id}`}>{STATUS_WORDS[video.status]}</span>
                        <span aria-hidden>·</span>
                        <span>{video.aspect}</span>
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
