// The Activity tab: what the agent has done to the video (turns, newest first), what the checks found,
// Undo last change, and Stop while something runs.

import { Check, Square, Undo2, X } from 'lucide-react'
import type { VideoProject, VideoTurn } from '@shared/video'
import { Button, cx } from '../../components/ui'
import { StatusDot } from '../../components/marks'
import { useVideo } from '../../store/video'
import { CHECK_WORDS, formatTimeOfDay, isRunning, TURN_KIND_WORDS, TURN_STATUS_WORDS } from './common'
import { InlineError } from './InlineError'

/** The note says something the title does not only for a spot the user pointed at; the others repeat the title. */
function showsNote(turn: VideoTurn): boolean {
  return turn.kind === 'change'
}

function TurnRow({ turn }: { turn: VideoTurn }): React.JSX.Element {
  const live = turn.status === 'running'
  const tone = turn.status === 'failed' ? 'text-st-failed' : turn.status === 'done' ? 'text-st-idle' : 'text-muted'
  return (
    <li className="rounded-lg border border-line bg-panel/60 px-2.5 py-2" data-testid={`video-turn-${turn.id}`} data-status={turn.status}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-fg">{TURN_KIND_WORDS[turn.kind]}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-faint">{formatTimeOfDay(turn.startedAt)}</span>
      </div>
      {showsNote(turn) && <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{turn.note}</p>}
      <div className="mt-1 flex items-center gap-2 text-[11px]">
        <span className={cx('flex items-center gap-1.5', tone)}>
          {live && <StatusDot state="working" size={6} />}
          {TURN_STATUS_WORDS[turn.status]}
        </span>
        {turn.tokens !== null && <span className="tabular-nums text-faint">{turn.tokens} tokens</span>}
      </div>
      {(live || turn.status === 'failed') && turn.latest && (
        <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-term px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted">
          {turn.latest}
        </pre>
      )}
    </li>
  )
}

export function ActivityTab({ video }: { video: VideoProject }): React.JSX.Element {
  const undo = useVideo((s) => s.undo)
  const stopVideo = useVideo((s) => s.stop)
  const busy = isRunning(video.status) || video.renders.some((r) => r.status === 'rendering')
  const turns = [...video.turns].reverse()
  const checks = video.checks
  const pageFailed = checks.length === 1 && checks[0]!.name === 'loads' && !checks[0]!.passed && video.duration === null
  const canUndo = video.canUndo && !busy
  // The checks on record are from the run before until the checks that are under way finish.
  const stale = isRunning(video.status)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <InlineError />
      {(canUndo || busy) && (
        <div className="flex shrink-0 items-center gap-1.5">
          {busy && (
            <Button variant="outline" size="sm" data-testid="video-stop" onClick={() => void stopVideo(video.id)}>
              <Square size={13} />
              Stop
            </Button>
          )}
          {canUndo && (
            <Button variant="outline" size="sm" data-testid="video-undo" onClick={() => void undo(video.id)}>
              <Undo2 size={13} />
              Undo last change
            </Button>
          )}
        </div>
      )}

      {checks.length > 0 && (
        <section className="shrink-0" data-testid="video-checks" data-stale={stale ? 'true' : 'false'}>
          <div className="mb-1.5 flex items-baseline justify-between">
            <h3 className="text-[12px] font-medium text-muted">Checks</h3>
            {stale && (
              <span className="text-[11px] text-faint" data-testid="video-checks-stale">
                {video.status === 'checking' ? 'Checking again' : 'From before this change'}
              </span>
            )}
          </div>
          <div className={cx('rounded-lg border border-line bg-panel/60 p-2.5 transition-opacity duration-150', stale && 'opacity-50')}>
            {pageFailed ? (
              <p className="text-[11.5px] leading-relaxed text-st-failed" data-testid="video-check-detail">
                {checks[0]!.detail}
              </p>
            ) : (
              <ul className="space-y-2">
                {checks.map((check) => (
                  <li key={check.name} className="flex items-start gap-2 text-[11.5px]" data-testid={`video-check-${check.name}`} data-passed={check.passed}>
                    <span className={cx('mt-0.5 shrink-0', check.passed ? 'text-st-idle' : 'text-st-failed')}>
                      {check.passed ? <Check size={13} /> : <X size={13} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-fg">{CHECK_WORDS[check.name] ?? check.name}</span>
                      <span className="block text-[11px] leading-relaxed text-muted">{check.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      <section className="shrink-0">
        <h3 className="mb-1.5 text-[12px] font-medium text-muted">Turns</h3>
        {turns.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-faint" data-testid="video-turns-empty">
            Nothing yet. The agent&apos;s turns show up here as it works.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {turns.map((turn) => (
              <TurnRow key={turn.id} turn={turn} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
