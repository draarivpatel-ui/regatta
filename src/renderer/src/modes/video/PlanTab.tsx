// The Plan tab: PLAN.md in an editor, Save, Save and tell the agent, and Build the video once the plan
// is ready. What is on disk and what has been typed over it both live in the store, so looking at another
// tab or another video never loses text and the tab is right on its first paint.

import { useEffect, useRef } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { VideoProject } from '@shared/video'
import { Button, cx } from '../../components/ui'
import { useVideo } from '../../store/video'
import { isRunning } from './common'
import { InlineError } from './InlineError'

export function PlanTab({ video }: { video: VideoProject }): React.JSX.Element {
  const readPlan = useVideo((s) => s.readPlan)
  const savePlan = useVideo((s) => s.savePlan)
  const build = useVideo((s) => s.build)
  const plan = useVideo((s) => s.plan)
  const saved = useVideo((s) => s.plans[video.id])
  const draft = useVideo((s) => s.drafts[video.id])
  const setDraft = useVideo((s) => s.setDraft)
  const busy = isRunning(video.status)
  const writing = video.status === 'planning'
  /** False until PLAN.md has been read once. */
  const loaded = saved !== undefined
  const text = draft ?? saved ?? ''
  const dirty = loaded && draft !== undefined && draft !== saved

  // Whatever the file holds now, every time the tab opens.
  useEffect(() => {
    void readPlan(video.id)
  }, [video.id, readPlan])

  // A turn that just finished may have written PLAN.md (the plan turn) or edited it: read the file again. Text the
  // user has typed over it stays, as a draft, until they save or change it back.
  const wasBusy = useRef(false)
  useEffect(() => {
    if (wasBusy.current && !busy) void readPlan(video.id)
    wasBusy.current = busy
  }, [busy, video.id, readPlan])

  const save = async (tell: boolean): Promise<void> => {
    const sent = text
    const ok = await savePlan(video.id, sent, tell)
    // Whether it worked or not, what is in the file now is the truth.
    await readPlan(video.id)
    // Typing during the turn is a newer draft; only the text that was sent is let go.
    if (ok && useVideo.getState().drafts[video.id] === sent) setDraft(video.id, null)
  }

  const empty = loaded && text.trim().length === 0
  const canBuild = video.status === 'planned' && !busy
  const askForPlan = empty && !busy && (video.status === 'new' || video.status === 'failed')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <InlineError />
      <div className="flex shrink-0 items-center justify-between">
        <span className="font-mono text-[11px] text-faint">PLAN.md</span>
        <span className="text-[11px] text-faint" data-testid="video-plan-state">
          {writing ? 'The agent is writing' : dirty ? 'Not saved' : 'Saved'}
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <textarea
          className={cx(
            'h-full w-full resize-none rounded-lg border border-line-strong bg-panel p-2.5 font-mono text-[12px] leading-relaxed text-fg outline-none placeholder:text-faint read-only:text-muted focus-visible:ring-2 focus-visible:ring-accent/40',
            // Until the file has been read once the editor would show its placeholder for a blink.
            !loaded && 'opacity-0'
          )}
          data-testid="video-plan"
          value={text}
          spellCheck={false}
          readOnly={writing}
          placeholder={writing ? '' : 'What the video should show, scene by scene.'}
          onChange={(e) => setDraft(video.id, e.target.value === saved ? null : e.target.value)}
        />
        {writing && empty && (
          <p className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[12px] text-muted">
            <LoaderCircle size={18} className="animate-spin text-faint" />
            The agent is writing the plan. It shows up here when it is done.
          </p>
        )}
      </div>

      {busy && !writing && (
        <p className="shrink-0 text-[11px] leading-relaxed text-faint" data-testid="video-plan-busy">
          The agent is working. You can keep editing; saving waits until it is done.
        </p>
      )}

      {askForPlan && (
        <div className="shrink-0 rounded-lg border border-line bg-panel/60 p-2.5">
          <p className="text-[11.5px] leading-relaxed text-muted">There is no plan yet. Write one above, or have the agent write it.</p>
          <Button variant="subtle" size="sm" className="mt-2" data-testid="video-plan-write" onClick={() => void plan(video.id)}>
            Ask the agent to write the plan
          </Button>
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Button variant="subtle" size="sm" data-testid="video-plan-save" disabled={busy} onClick={() => void save(false)}>
          Save
        </Button>
        <Button
          variant="subtle"
          size="sm"
          data-testid="video-plan-tell"
          disabled={busy || text.trim().length === 0}
          onClick={() => void save(true)}
        >
          Save and tell the agent
        </Button>
      </div>
      {canBuild && (
        <Button variant="accent" size="md" className="w-full shrink-0 justify-center" data-testid="video-build" onClick={() => void build(video.id)}>
          Build the video
        </Button>
      )}
    </div>
  )
}
