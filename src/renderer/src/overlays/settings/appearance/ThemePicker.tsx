// The theme cards in Settings > Appearance.

import { useEffect, useState } from 'react'
import { Monitor } from 'lucide-react'
import type { Prefs } from '@shared/types'
import { THEMES, SYSTEM_THEME, accentSet, type ThemeDef, type Token } from '@shared/themes'
import { bridge } from '../../../lib/bridge'
import { cx } from '../../../components/ui'
import { currentTheme } from '../../../theme/apply'

type Colors = Record<Token, string>

/** A tiny window drawn in the theme's own colors: title bar, a pane with text, three state dots. */
function Preview({ colors, accent, chosen, monitor }: { colors: Colors; accent: string; chosen: boolean; monitor?: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex h-[58px] w-[92px] flex-col overflow-hidden rounded-md border transition-shadow duration-150',
        chosen ? 'border-transparent ring-2 ring-accent' : 'border-line-strong'
      )}
      style={{ background: colors.bg }}
    >
      <span className="flex h-[15px] items-center gap-1 px-1.5" style={{ background: colors.chrome }}>
        {monitor ? (
          <span className="flex h-full flex-1 items-center justify-center">
            <Monitor size={9} color={colors.muted} />
          </span>
        ) : (
          <>
            <span className="h-1 w-1 rounded-full" style={{ background: colors.faint }} />
            <span className="h-1 w-1 rounded-full" style={{ background: colors.faint }} />
            <span className="ml-auto h-[3px] w-3 rounded-full" style={{ background: accent }} />
          </>
        )}
      </span>
      <span className="flex flex-1 gap-1 p-1">
        <span
          className="flex flex-1 flex-col gap-[3px] rounded-[3px] p-[3px]"
          style={{ background: colors.panel, border: `1px solid ${colors.line}` }}
        >
          <span className="h-[3px] w-[80%] rounded-full" style={{ background: colors.fg }} />
          <span className="h-[3px] w-[55%] rounded-full" style={{ background: colors.muted }} />
          <span className="h-[3px] w-[35%] rounded-full" style={{ background: accent }} />
          <span className="mt-auto flex gap-[3px]">
            <span className="h-[4px] w-[4px] rounded-full" style={{ background: colors['st-idle'] }} />
            <span className="h-[4px] w-[4px] rounded-full" style={{ background: colors['st-working'] }} />
            <span className="h-[4px] w-[4px] rounded-full" style={{ background: colors['st-waiting'] }} />
          </span>
        </span>
      </span>
    </span>
  )
}

function Card({
  testId,
  label,
  selected,
  onPick,
  children
}: {
  testId: string
  label: string
  selected: boolean
  onPick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onPick}
      aria-pressed={selected}
      title={label}
      className={cx(
        'flex w-[104px] flex-col items-center gap-1.5 rounded-lg p-1.5 transition-colors duration-150',
        'hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        selected && 'bg-hover'
      )}
    >
      {children}
      <span className={cx('text-[11.5px] leading-none', selected ? 'text-fg' : 'text-muted')}>{label}</span>
    </button>
  )
}

/** The accent a preview shows: the custom one when it is set, the theme's own otherwise. */
function previewAccent(theme: ThemeDef, custom: string | null): string {
  return (custom ? accentSet(custom, theme)?.accent : null) ?? theme.colors.accent
}

/** Reads the saved theme and saves a new one as soon as the user picks a card. */
export function ThemePicker(): React.JSX.Element {
  const [prefs, setPrefs] = useState<Prefs | null>(null)

  useEffect(() => {
    let alive = true
    const off = bridge.on('prefs:changed', (next) => {
      if (alive) setPrefs(next)
    })
    void bridge
      .invoke('prefs:get')
      .then((next) => {
        if (alive) setPrefs(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      off()
    }
  }, [])

  const choice = prefs?.theme ?? SYSTEM_THEME
  const active = currentTheme(prefs)
  const custom = prefs?.accent ?? null

  const pick = (id: string): void => {
    setPrefs((prev) => (prev ? { ...prev, theme: id } : prev))
    void bridge
      .invoke('prefs:set', { theme: id })
      .then(setPrefs)
      .catch(() => undefined)
  }

  const group = (kind: 'dark' | 'light', label: string): React.JSX.Element => (
    <div className="mt-3">
      <p className="text-[12px] font-medium text-muted">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {THEMES.filter((t) => t.kind === kind).map((t) => (
          <Card
            key={t.id}
            testId={`theme-${t.id}`}
            label={t.name}
            selected={choice === t.id}
            onPick={() => pick(t.id)}
          >
            <Preview colors={t.colors} accent={previewAccent(t, custom)} chosen={choice === t.id} />
          </Card>
        ))}
      </div>
    </div>
  )

  return (
    <div className="mt-4" data-testid="settings-appearance">
      <p className="text-[13px] font-medium">Theme</p>
      <div className="mt-2 flex flex-wrap gap-1">
        <Card testId="theme-system" label="Match the system" selected={choice === SYSTEM_THEME} onPick={() => pick(SYSTEM_THEME)}>
          <Preview
            colors={active.colors}
            accent={previewAccent(active, custom)}
            chosen={choice === SYSTEM_THEME}
            monitor
          />
        </Card>
      </div>
      {group('dark', 'Dark')}
      {group('light', 'Light')}
      <p className="mt-2.5 text-[12px] text-muted" data-testid="theme-active">
        Showing {active.name}.
      </p>
    </div>
  )
}
