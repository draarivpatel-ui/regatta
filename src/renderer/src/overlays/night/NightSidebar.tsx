// The left column of Night watch: Tonight, then every night newest first.

import { Moon } from 'lucide-react'
import { cx } from '../../components/ui'
import { useNight } from '../../store/night'
import { nightLook, nightRowLine, nightRowTitle, tonightLine } from './helpers'
import { LookDot } from './marks'

const ROW = 'mb-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/50'

export function NightSidebar(): React.JSX.Element {
  const state = useNight((s) => s.state)
  const selected = useNight((s) => s.selected)
  const select = useNight((s) => s.select)
  const nights = state?.nights ?? []

  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-chrome">
      <h2 className="shrink-0 px-4 pb-2 pt-3.5 text-[12.5px] font-medium text-muted">Nights</h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <button
          type="button"
          data-testid="night-row-tonight"
          onClick={() => select('tonight')}
          aria-current={selected === 'tonight' ? 'true' : undefined}
          className={cx(ROW, selected === 'tonight' ? 'bg-press' : 'hover:bg-hover')}
        >
          <Moon size={15} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium">Tonight</span>
            <span data-testid="tonight-status" className="mt-0.5 block truncate text-[11px] text-faint">
              {tonightLine(state)}
            </span>
          </span>
        </button>

        {nights.map((night) => {
          const look = nightLook(night)
          const active = selected === night.id
          return (
            <button
              key={night.id}
              type="button"
              data-testid={`night-row-${night.id}`}
              data-status={night.status}
              onClick={() => select(night.id)}
              aria-current={active ? 'true' : undefined}
              className={cx(ROW, active ? 'bg-press' : 'hover:bg-hover')}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{nightRowTitle(night, nights)}</span>
                <span className="mt-0.5 block truncate text-[11px] text-faint">{nightRowLine(night)}</span>
              </span>
              <LookDot look={look} pulse={night.status === 'running'} />
            </button>
          )
        })}
        {state !== null && nights.length === 0 && (
          <p className="px-2.5 py-2 text-[11.5px] leading-relaxed text-faint">Finished nights show up here, newest first.</p>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-4 py-3">
        <div className="flex items-start gap-2 text-[11.5px] leading-relaxed text-faint">
          <Moon size={13} className="mt-0.5 shrink-0" />
          <p>Regatta keeps this Mac awake while a night runs on power. Closing the window is fine; quitting the app stops the night.</p>
        </div>
        {state?.keepingAwake && (
          <p data-testid="night-awake" className="mt-2 flex items-center gap-2 text-[11.5px] font-medium text-st-working">
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inset-0 rounded-full bg-st-working opacity-60 animate-ping" />
              <span className="relative inline-block h-2 w-2 rounded-full bg-st-working animate-breathe" />
            </span>
            Keeping awake
          </p>
        )}
      </div>
    </aside>
  )
}
