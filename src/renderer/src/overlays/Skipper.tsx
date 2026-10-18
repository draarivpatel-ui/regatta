// Skipper: race agents on one task (Heats) or hand a task to a leader with a backup.
// and later skipper.

import { useEffect } from 'react'
import { Plus, X } from 'lucide-react'
import { IconButton, Button, cx } from '../components/ui'
import { useHeats } from '../store/heats'
import { HeatForm } from './skipper/HeatForm'
import { HeatView } from './skipper/HeatView'
import { heatBadgeText } from './skipper/helpers'

export function SkipperView({ onClose }: { onClose: () => void }): React.JSX.Element {
  const heats = useHeats((s) => s.heats)
  const selectedId = useHeats((s) => s.selectedId)
  const select = useHeats((s) => s.select)
  const load = useHeats((s) => s.load)
  const loaded = useHeats((s) => s.loaded)

  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const selected = heats.find((h) => h.id === selectedId) ?? null

  return (
    <div data-testid="skipper-view" className="fixed inset-x-0 bottom-0 top-[50px] z-30 flex flex-col bg-bg animate-fade-in">
      <header className="flex h-[46px] shrink-0 items-center border-b border-line px-4">
        <span className="text-[13px] font-semibold">Skipper</span>
        <span className="ml-2 text-[11.5px] text-faint">Heats race agents on one task, checks pick the winner</span>
        <IconButton className="ml-auto" onClick={onClose} aria-label="Close Skipper" title="Close">
          <X size={15} />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[260px] shrink-0 flex-col border-r border-line bg-chrome">
          <div className="shrink-0 p-3">
            <Button
              variant="accent"
              size="sm"
              data-testid="heat-new"
              onClick={() => select(null)}
              className="w-full justify-center"
            >
              <Plus size={13} />
              New heat
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {!loaded && <p className="px-2 py-3 text-[12px] text-faint">Loading heats...</p>}
            {loaded && heats.length === 0 && (
              <p className="px-2 py-3 text-[12px] text-faint">No heats yet. Start one to race agents.</p>
            )}
            {heats.map((h) => {
              const active = h.id === selectedId
              return (
                <button
                  key={h.id}
                  type="button"
                  data-testid="heat-row"
                  data-id={h.id}
                  data-status={h.status}
                  onClick={() => select(h.id)}
                  aria-current={active ? 'true' : undefined}
                  className={cx(
                    'mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors duration-150',
                    active ? 'bg-press' : 'hover:bg-hover'
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium">{h.task || 'Untitled heat'}</span>
                    <span className="mt-0.5 block text-[11px] text-faint">
                      {h.lanes.length} {h.lanes.length === 1 ? 'lane' : 'lanes'}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full border border-line bg-panel px-2 py-0.5 text-[10.5px] text-muted">
                    {heatBadgeText(h.status)}
                  </span>
                </button>
              )
            })}
          </div>
        </aside>
        <section className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden bg-bg">
          {selected ? <HeatView key={selected.id} heat={selected} /> : <HeatForm key="new" />}
        </section>
      </div>
    </div>
  )
}
