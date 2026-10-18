// The right column of Video mode: the plan, the agent's activity, and rendering, as three tabs.
// The tab is the user's choice and nothing else moves it: a finished build leaves it where it was.

import { Activity, FileText, Film } from 'lucide-react'
import type { VideoProject } from '@shared/video'
import { cx } from '../../components/ui'
import { useVideo, type VideoTab } from '../../store/video'
import { ActivityTab } from './ActivityTab'
import { PlanTab } from './PlanTab'
import { RenderTab } from './RenderTab'

const TABS: { id: VideoTab; label: string; icon: React.ReactNode }[] = [
  { id: 'plan', label: 'Plan', icon: <FileText size={13} /> },
  { id: 'activity', label: 'Activity', icon: <Activity size={13} /> },
  { id: 'render', label: 'Render', icon: <Film size={13} /> }
]

export function SidePanel({ video }: { video: VideoProject }): React.JSX.Element {
  const tab = useVideo((s) => s.tab)
  const setTab = useVideo((s) => s.setTab)

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l border-line bg-chrome" data-testid="video-side">
      <div className="flex h-[46px] shrink-0 items-center border-b border-line px-3">
        <div role="tablist" aria-label="Plan, activity and render" className="flex w-full rounded-lg border border-line bg-panel p-[3px]">
          {TABS.map((t) => {
            const on = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`video-tab-${t.id}`}
                aria-selected={on}
                aria-controls="video-tabpanel"
                data-testid={`video-tab-${t.id}`}
                onClick={() => setTab(t.id)}
                className={cx(
                  'flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-md text-[12px] outline-none transition-colors duration-150',
                  'focus-visible:ring-2 focus-visible:ring-accent/50',
                  on ? 'bg-press font-medium text-fg' : 'text-muted hover:text-fg'
                )}
              >
                {t.icon}
                {t.label}
              </button>
            )
          })}
        </div>
      </div>
      <div
        role="tabpanel"
        id="video-tabpanel"
        aria-labelledby={`video-tab-${tab}`}
        data-testid="video-tabpanel"
        data-tab={tab}
        className="flex min-h-0 flex-1 flex-col p-3"
      >
        {tab === 'plan' && <PlanTab key={video.id} video={video} />}
        {tab === 'activity' && <ActivityTab video={video} />}
        {tab === 'render' && <RenderTab video={video} />}
      </div>
    </aside>
  )
}
