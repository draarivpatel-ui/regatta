import { useEffect } from 'react'
import { X } from 'lucide-react'
import { TitleBar } from './app/TitleBar'
import { useShortcuts } from './app/shortcuts'
import { useAppTheme } from './theme/apply'
import { DictationPill } from './dictation/DictationPill'
import { CodeMode } from './modes/code/CodeMode'
import { ChatMode } from './modes/chat/ChatMode'
import { AgentsMode } from './modes/agents/AgentsMode'
import { FlowsMode } from './modes/flows/FlowsMode'
import { VideoMode } from './modes/video/VideoMode'
import { BoardMode } from './modes/board/BoardMode'
import { FleetSidebar } from './modes/code/FleetSidebar'
import { Overlays } from './overlays'
import { useSessions } from './store/sessions'
import { useUi } from './store/ui'
import { cx } from './components/ui'

function ErrorToast(): React.JSX.Element | null {
  const error = useSessions((s) => s.error)
  const dismiss = useSessions((s) => s.dismissError)
  if (!error) return null
  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex max-w-[560px] -translate-x-1/2 items-center gap-3 rounded-xl border border-st-failed/40 bg-raised px-4 py-2.5 text-[12.5px] shadow-2xl animate-fade-up" role="alert">
      <span className="text-st-failed">{error}</span>
      <button type="button" onClick={dismiss} className="text-muted hover:text-fg" aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  )
}

export function App(): React.JSX.Element {
  const init = useSessions((s) => s.init)
  const ready = useSessions((s) => s.ready)
  const mode = useUi((s) => s.mode)

  useEffect(() => {
    void init()
  }, [init])

  useShortcuts()
  useAppTheme()

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <main className="relative flex min-h-0 flex-1">
        <div className={cx('flex min-h-0 min-w-0 flex-1', mode !== 'code' && 'hidden')}>{ready && <CodeMode />}</div>
        <div className={cx('flex min-h-0 min-w-0 flex-1', mode !== 'chat' && 'hidden')}>{ready && <ChatMode />}</div>
        <div className={cx('flex min-h-0 min-w-0 flex-1', mode !== 'agents' && 'hidden')}>{ready && <AgentsMode />}</div>
        <div className={cx('flex min-h-0 min-w-0 flex-1', mode !== 'flows' && 'hidden')}>{ready && <FlowsMode />}</div>
        <div className={cx('flex min-h-0 min-w-0 flex-1', mode !== 'video' && 'hidden')}>{ready && <VideoMode />}</div>
        <div className={cx('flex min-h-0 min-w-0 flex-1', mode !== 'board' && 'hidden')}>{ready && <BoardMode />}</div>
        {ready && <FleetSidebar />}
      </main>
      {ready && <Overlays />}
      {ready && <DictationPill />}
      <ErrorToast />
    </div>
  )
}
