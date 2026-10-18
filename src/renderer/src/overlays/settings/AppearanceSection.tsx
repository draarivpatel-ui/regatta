// Settings > Appearance.

import { useUi, type Density } from '../../store/ui'
import { cx } from '../../components/ui'
import { ThemePicker } from './appearance/ThemePicker'
import { AccentPicker } from './appearance/AccentPicker'
import { SectionTitle } from './common'

const DENSITIES: Density[] = ['auto', 'comfortable', 'compact', 'dense']

export function AppearanceSection(): React.JSX.Element {
  const density = useUi((s) => s.density)
  const setDensity = useUi((s) => s.setDensity)
  return (
    <div className="max-w-[520px]">
      <SectionTitle>Appearance</SectionTitle>
      <ThemePicker />
      <AccentPicker />
      <div className="mt-6">
        <p className="text-[13px] font-medium">Text size</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Controls panes and the fleet list.</p>
        <div className="mt-2.5 grid max-w-[420px] grid-cols-4 rounded-lg border border-line bg-panel p-0.5" role="group" aria-label="Text size">
          {DENSITIES.map((d) => (
            <button
              key={d}
              type="button"
              data-testid={`settings-density-${d}`}
              onClick={() => setDensity(d)}
              aria-pressed={density === d}
              className={cx(
                'h-7 rounded-md text-[12px] capitalize transition-colors duration-150',
                density === d ? 'bg-press text-fg' : 'text-muted hover:text-fg'
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
