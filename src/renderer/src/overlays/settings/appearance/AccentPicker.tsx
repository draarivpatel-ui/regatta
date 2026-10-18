// The accent controls in Settings > Appearance.

import { useEffect, useState } from 'react'
import { Pipette } from 'lucide-react'
import type { Prefs } from '@shared/types'
import { accentSet, contrast, hexToRgb, rgbToHex } from '@shared/themes'
import { bridge } from '../../../lib/bridge'
import { Button, cx } from '../../../components/ui'
import { currentTheme } from '../../../theme/apply'

type AccentMode = 'theme' | 'custom'

/** "4.8:1", one decimal, the way a contrast check reads. */
function ratio(a: string, b: string): string {
  return `${contrast(a, b).toFixed(1)}:1`
}

/** The accent controls: the theme's own color, or a custom one kept readable. */
export function AccentPicker(): React.JSX.Element {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [mode, setMode] = useState<AccentMode>('theme')
  const [draft, setDraft] = useState<string>('')

  useEffect(() => {
    let alive = true
    const off = bridge.on('prefs:changed', (next) => {
      if (!alive) return
      setPrefs(next)
      setMode(next.accent === null ? 'theme' : 'custom')
    })
    void bridge
      .invoke('prefs:get')
      .then((next) => {
        if (!alive) return
        setPrefs(next)
        setMode(next.accent === null ? 'theme' : 'custom')
      })
      .catch(() => undefined)
    return () => {
      alive = false
      off()
    }
  }, [])

  const theme = currentTheme(prefs)
  const saved = prefs?.accent ?? null
  const custom = mode === 'custom'
  const shown = custom ? (saved ?? theme.colors.accent) : theme.colors.accent
  const set = custom && saved ? accentSet(saved, theme) : null
  const swatch = set?.accent ?? shown
  const rgb = hexToRgb(shown)

  const save = (accent: string | null): void => {
    setPrefs((prev) => (prev ? { ...prev, accent } : prev))
    void bridge
      .invoke('prefs:set', { accent })
      .then((next) => {
        setPrefs(next)
        setMode(next.accent === null ? 'theme' : 'custom')
      })
      .catch(() => undefined)
  }

  const onHex = (text: string): void => {
    setDraft(text.trim())
    const parsed = hexToRgb(text.trim())
    if (parsed) save(rgbToHex(parsed[0], parsed[1], parsed[2]))
  }

  const tabClass = (on: boolean): string =>
    cx(
      'flex h-8 items-center gap-2 rounded-md px-2.5 text-[12.5px] transition-colors duration-150',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
      on ? 'bg-press text-fg' : 'text-muted hover:bg-hover hover:text-fg'
    )

  return (
    <div className="mt-6" data-testid="accent-picker">
      <p className="text-[13px] font-medium">Accent</p>
      <div className="mt-2 flex gap-1" role="group" aria-label="Accent color">
        <button
          type="button"
          data-testid="accent-theme"
          onClick={() => {
            setDraft('')
            save(null)
          }}
          aria-pressed={!custom}
          className={tabClass(!custom)}
        >
          <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full" style={{ background: theme.colors.accent }} />
          Theme accent
        </button>
        <button
          type="button"
          data-testid="accent-custom"
          onClick={() => setMode('custom')}
          aria-pressed={custom}
          className={tabClass(custom)}
        >
          <Pipette size={13} />
          Custom
        </button>
      </div>

      {custom && (
        <div className="mt-3 flex items-center gap-2.5">
          <label className="relative h-8 w-9 shrink-0 overflow-hidden rounded-md border border-line-strong" aria-label="Pick an accent color">
            <input
              type="color"
              data-testid="accent-swatch"
              value={rgb ? rgbToHex(rgb[0], rgb[1], rgb[2]) : '#000000'}
              onChange={(e) => {
                setDraft(e.target.value)
                save(e.target.value)
              }}
              className="absolute -left-1 -top-1 h-12 w-14 cursor-pointer border-0 bg-transparent p-0"
            />
          </label>
          <input
            type="text"
            data-testid="accent-input"
            value={draft || (rgb ? rgbToHex(rgb[0], rgb[1], rgb[2]) : '')}
            onChange={(e) => onHex(e.target.value)}
            onBlur={() => setDraft('')}
            spellCheck={false}
            aria-label="Accent hex color"
            placeholder="#2dd4bf"
            className={cx(
              'h-8 w-[104px] rounded-md border border-line bg-panel px-2 font-mono text-[12px] text-fg',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
            )}
          />
          <Button
            variant="ghost"
            size="sm"
            data-testid="accent-use-theme"
            onClick={() => {
              setDraft('')
              save(null)
            }}
          >
            Use the theme accent
          </Button>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full border border-line" style={{ background: swatch }} />
        <span className="text-[12px] text-muted" data-testid="accent-contrast">
          Contrast {ratio(swatch, theme.colors.bg)} on {theme.name}
        </span>
      </div>
      {set?.adjusted === true && (
        <p className="mt-1 text-[12px] text-muted" data-testid="accent-adjusted">
          Made {theme.kind === 'dark' ? 'lighter' : 'darker'} to stay readable: {set.accent}
        </p>
      )}
      {custom && saved !== null && set?.adjusted === false && (
        <p className="mt-1 text-[12px] text-muted" data-testid="accent-kept">
          Kept exactly as you picked it.
        </p>
      )}
    </div>
  )
}
