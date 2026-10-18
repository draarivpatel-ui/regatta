// Video mode (Labs): videos written as code by an agent, previewed frame by frame, rendered to MP4.
// Left the list, center the player and timeline, right the plan, the agent's activity and rendering.

import { useEffect, useMemo, useState } from 'react'
import { Clapperboard } from 'lucide-react'
import type { Prefs } from '@shared/types'
import { bridge } from '../../lib/bridge'
import { Button } from '../../components/ui'
import { useSessions } from '../../store/sessions'
import { useVideo } from '../../store/video'
import { VideoList } from './VideoList'
import { NewVideoDialog } from './NewVideoDialog'
import { PlayerPanel } from './PlayerPanel'
import { SidePanel } from './SidePanel'

/** Reads the Labs flags from main, and keeps up with every change the user makes in Settings. */
function useLabs(): { prefs: Prefs | null; enableVideo: () => void } {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  useEffect(() => {
    let alive = true
    void bridge
      .invoke('prefs:get')
      .then((next) => {
        if (alive) setPrefs(next)
      })
      .catch(() => undefined)
    const off = bridge.on('prefs:changed', (next) => {
      if (alive) setPrefs(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  const enableVideo = (): void => {
    if (!prefs) return
    void bridge.invoke('prefs:set', { labs: { ...prefs.labs, video: true } }).catch(() => undefined)
  }
  return { prefs, enableVideo }
}

function LabsGate({ onEnable }: { onEnable: () => void }): React.JSX.Element {
  return (
    <div data-testid="video-mode" className="flex h-full flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Clapperboard size={26} className="text-faint" />
      <p className="text-[14px] font-semibold text-fg">Video is in Labs</p>
      <p className="max-w-[360px] text-[12.5px] leading-relaxed text-muted">
        An agent writes a short video in code; Regatta previews it frame by frame and renders it to MP4.
      </p>
      <div className="mt-1">
        <Button variant="accent" size="md" data-testid="video-enable" onClick={onEnable}>
          Turn on Video
        </Button>
      </div>
    </div>
  )
}

function EmptyHint({ first, onNew }: { first: boolean; onNew: () => void }): React.JSX.Element {
  return (
    <section
      data-testid="video-empty"
      className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2 bg-bg px-6 text-center"
    >
      <Clapperboard size={22} className="text-faint" />
      {first ? (
        <>
          <p className="text-[13px] font-medium text-fg">Make your first video</p>
          <p className="max-w-[340px] text-[12px] leading-relaxed text-muted">
            Say what it should show. An agent writes a plan, you read it, and then it builds the video for you to
            look at frame by frame.
          </p>
        </>
      ) : (
        <p className="text-[13px] text-muted">Pick a video on the left, or make a new one.</p>
      )}
      <Button variant={first ? 'accent' : 'subtle'} size={first ? 'md' : 'sm'} className="mt-1" data-testid="video-empty-new" onClick={onNew}>
        New video
      </Button>
    </section>
  )
}

export function VideoMode(): React.JSX.Element {
  const { prefs, enableVideo } = useLabs()
  const videos = useVideo((s) => s.videos)
  const selectedId = useVideo((s) => s.selectedId)
  const select = useVideo((s) => s.select)
  const load = useVideo((s) => s.load)
  const loadFFmpeg = useVideo((s) => s.loadFFmpeg)
  const loaded = useVideo((s) => s.loaded)
  const agents = useSessions((s) => s.agents)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    void load()
    void loadFFmpeg()
  }, [load, loadFFmpeg])

  // Nothing is picked, or the picked one is gone: fall back to the most recently touched video.
  useEffect(() => {
    if (!loaded) return
    if (selectedId && selectedId in videos) return
    const first = Object.values(videos).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    select(first ? first.id : null)
  }, [loaded, selectedId, videos, select])

  const selected = useMemo(() => (selectedId ? (videos[selectedId] ?? null) : null), [selectedId, videos])
  const list = useMemo(() => Object.values(videos).sort((a, b) => b.updatedAt - a.updatedAt), [videos])

  if (prefs && !prefs.labs.video) return <LabsGate onEnable={enableVideo} />

  return (
    <div data-testid="video-mode" className="flex h-full min-h-0 flex-1 overflow-hidden bg-bg">
      <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-line bg-chrome">
        <VideoList
          videos={list}
          selectedId={selected?.id ?? null}
          onSelect={select}
          onNew={() => setCreating(true)}
        />
      </aside>
      {selected ? (
        <PlayerPanel key={selected.id} video={selected} />
      ) : (
        <EmptyHint first={list.length === 0} onNew={() => setCreating(true)} />
      )}
      {selected && <SidePanel video={selected} />}
      {creating && <NewVideoDialog agents={agents} onClose={() => setCreating(false)} />}
    </div>
  )
}
