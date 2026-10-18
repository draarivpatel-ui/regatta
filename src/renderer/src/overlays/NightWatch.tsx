// Night watch: queue tasks for the night and read the morning report.
// Left, the nights; right, Tonight (add tasks, start) or one night's report (merge, open, discard).

import { useEffect } from 'react'
import { Moon, X } from 'lucide-react'
import { IconButton } from '../components/ui'
import { useNight } from '../store/night'
import { NightForm } from './night/NightForm'
import { NightReport } from './night/NightReport'
import { NightSidebar } from './night/NightSidebar'

export function NightWatchView({ onClose }: { onClose: () => void }): React.JSX.Element {
  const state = useNight((s) => s.state)
  const selected = useNight((s) => s.selected)
  const load = useNight((s) => s.load)
  const error = useNight((s) => s.error)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      // A question in the run card (merge, discard, stop) closes first; the view closes on the next Escape.
      if (useNight.getState().ask) useNight.getState().setAsk(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const night = selected === 'tonight' ? null : (state?.nights.find((n) => n.id === selected) ?? null)

  return (
    <div data-testid="night-view" className="fixed inset-x-0 bottom-0 top-[50px] z-30 flex flex-col bg-bg animate-fade-in">
      <header className="flex h-[46px] shrink-0 items-center border-b border-line px-4">
        <Moon size={15} className="text-accent" />
        <span className="ml-2 text-[13px] font-semibold">Night watch</span>
        <span className="ml-2 text-[11.5px] text-faint">Queue tasks to run overnight, read what happened in the morning</span>
        <IconButton className="ml-auto" onClick={onClose} aria-label="Close Night watch" title="Close">
          <X size={15} />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1">
        <NightSidebar />
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg">
          {state === null ? (
            <p role={error ? 'alert' : undefined} className={error ? 'px-6 py-6 text-[12.5px] text-st-failed' : 'px-6 py-6 text-[12.5px] text-faint'}>
              {error ?? 'Loading nights...'}
            </p>
          ) : night ? (
            <NightReport key={night.id} night={night} />
          ) : (
            <NightForm key="tonight" />
          )}
        </section>
      </div>
    </div>
  )
}
