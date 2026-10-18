// The New video dialog: title, what it should show, aspect and agent. Create makes the video and
// starts its plan turn.

import { useEffect, useMemo, useState } from 'react'
import type { DetectedAgent } from '@shared/types'
import type { NewVideo, VideoAgent, VideoAspect } from '@shared/video'
import { VIDEO_SIZES } from '@shared/video'
import { AGENTS } from '@shared/agents'
import { Button } from '../../components/ui'
import { Modal } from '../../components/overlay'
import { useVideo } from '../../store/video'

const ASPECTS: VideoAspect[] = ['16:9', '9:16', '1:1']

/** The agents that can take a video turn, in the order they were detected. */
function videoAgents(agents: DetectedAgent[]): DetectedAgent[] {
  const allowed = new Set<string>(['claude', 'codex', 'fake'])
  return agents.filter((a) => allowed.has(a.kind) && a.installed)
}

export function NewVideoDialog({ agents, onClose }: { agents: DetectedAgent[]; onClose: () => void }): React.JSX.Element {
  const create = useVideo((s) => s.create)
  const plan = useVideo((s) => s.plan)
  const setTab = useVideo((s) => s.setTab)
  const error = useVideo((s) => s.error)
  const clearError = useVideo((s) => s.clearError)
  const options = useMemo(() => videoAgents(agents), [agents])
  const first = options.find((a) => a.kind === 'claude' || a.kind === 'codex' || a.kind === 'fake')
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [aspect, setAspect] = useState<VideoAspect>('16:9')
  const [agent, setAgent] = useState<VideoAgent>((first?.kind as VideoAgent) ?? 'fake')
  const [busy, setBusy] = useState(false)

  // An old error from somewhere else on the screen is not about this dialog.
  useEffect(() => {
    clearError()
  }, [clearError])

  const canCreate = title.trim().length > 0 && brief.trim().length > 0 && options.length > 0 && !busy

  const submit = async (): Promise<void> => {
    if (!canCreate) return
    setBusy(true)
    clearError()
    const request: NewVideo = { title: title.trim(), brief: brief.trim(), aspect, agent }
    const video = await create(request)
    setBusy(false)
    // A video that could not be made keeps the dialog open, with the reason in it.
    if (!video) return
    // The plan turn runs as long as the agent takes; the new video is already on screen, so the dialog
    // does not wait for it.
    setTab('plan')
    onClose()
    void plan(video.id)
  }

  const field =
    'w-full rounded-lg border border-line-strong bg-panel px-2.5 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/40'
  const size = VIDEO_SIZES[aspect]

  return (
    <Modal
      title="New video"
      subtitle="An agent writes it in code, then Regatta previews every frame."
      onClose={onClose}
      testId="video-new-dialog"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" size="sm" data-testid="video-create" disabled={!canCreate} onClick={() => void submit()}>
            {busy ? 'Starting…' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label htmlFor="video-title" className="text-[12px] font-medium text-muted">
            Title
          </label>
          <input
            id="video-title"
            data-testid="video-title"
            className={`${field} mt-1`}
            value={title}
            maxLength={80}
            placeholder="Regatta launch clip"
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="video-brief" className="text-[12px] font-medium text-muted">
            What should it show?
          </label>
          <textarea
            id="video-brief"
            data-testid="video-brief"
            className={`${field} mt-1 min-h-[72px] resize-y`}
            value={brief}
            maxLength={2000}
            placeholder="Panes side by side, then the checks, then the name."
            onChange={(e) => setBrief(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <div>
            <span className="text-[12px] font-medium text-muted">Aspect</span>
            <div className="mt-1 flex gap-1" role="group" aria-label="Aspect">
              {ASPECTS.map((a) => (
                <Button key={a} size="sm" active={a === aspect} aria-pressed={a === aspect} data-testid={`video-aspect-${a.replace(':', 'x')}`} onClick={() => setAspect(a)}>
                  {a}
                </Button>
              ))}
            </div>
            <p className="mt-1 text-[11px] tabular-nums text-faint" data-testid="video-aspect-size">
              {size.width}×{size.height}, 30 fps
            </p>
          </div>
          <div>
            <span className="text-[12px] font-medium text-muted">Agent</span>
            {options.length === 0 ? (
              <p className="mt-1 text-[12px] text-st-failed" data-testid="video-no-agent">
                No agent for video is installed.
              </p>
            ) : (
              <div className="mt-1 flex gap-1" role="group" aria-label="Agent">
                {options.map((a) => (
                  <Button
                    key={a.kind}
                    size="sm"
                    active={a.kind === agent}
                    aria-pressed={a.kind === agent}
                    data-testid={`video-agent-${a.kind}`}
                    onClick={() => setAgent(a.kind as VideoAgent)}
                  >
                    {AGENTS[a.kind]?.name ?? a.name}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
        {error && (
          <p role="alert" data-testid="video-new-error" className="rounded-lg border border-st-failed/40 bg-st-failed/10 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-st-failed">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
