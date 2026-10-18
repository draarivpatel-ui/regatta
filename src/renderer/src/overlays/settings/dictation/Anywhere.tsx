// Settings > Dictation: the Anywhere (Labs) block. It is off until Labs is on, then it shows the
// shortcut, whether Accessibility is allowed, and the safety rule.

import { useEffect, useState } from 'react'
import type { Prefs } from '@shared/types'
import { bridge } from '../../../lib/bridge'
import { Button, Kbd } from '../../../components/ui'

interface AnywhereState {
  enabled: boolean
  trusted: boolean
  shortcut: string
  error: string | null
}

function openLabsSection(): void {
  document.querySelector<HTMLButtonElement>('[data-testid="settings-nav-labs"]')?.click()
}

export function AnywhereSettings(): React.JSX.Element {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [state, setState] = useState<AnywhereState | null>(null)

  const refresh = (): void => {
    bridge
      .invoke('anywhere:status')
      .then((next) => setState(next))
      .catch(() => setState(null))
  }

  useEffect(() => {
    let alive = true
    const load = (): void => {
      bridge
        .invoke('prefs:get')
        .then((next) => {
          if (alive) {
            setPrefs(next)
            refresh()
          }
        })
        .catch(() => undefined)
    }
    load()
    const off = bridge.on('prefs:changed', (next) => {
      setPrefs(next)
      refresh()
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const labsOn = prefs?.labs.anywhere === true

  return (
    <section aria-label="Anywhere" data-testid="anywhere-block">
      <h4 className="text-[12.5px] font-semibold text-fg">Anywhere (Labs)</h4>
      {!prefs ? (
        <p className="mt-1 text-[12.5px] text-muted">Loading,</p>
      ) : !labsOn ? (
        <div className="mt-1.5">
          <p className="text-[12.5px] leading-relaxed text-muted">
            Dictate into any app with <Kbd>Option+Shift+Command+Space</Kbd>. This is an early feature and is off until
            you turn it on.
          </p>
          <div className="mt-2">
            <Button variant="ghost" size="sm" data-testid="anywhere-labs-link" onClick={openLabsSection}>
              Turn it on in Settings &gt; Labs
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 space-y-2">
          <p className="text-[12.5px] leading-relaxed text-muted" data-testid="anywhere-shortcut">
            Press <Kbd>Option+Shift+Command+Space</Kbd> to start dictating into the app in front, press it again to
            finish.
          </p>
          <p className="text-[12.5px] leading-relaxed text-muted" data-testid="anywhere-access-line">
            {state?.trusted ? 'Accessibility is allowed, so Regatta can type into other apps.' : 'Regatta needs Accessibility permission to type into other apps.'}
            {state && !state.trusted && (
              <>
                {' '}
                <Button variant="ghost" size="sm" data-testid="anywhere-open-settings" onClick={() => void bridge.invoke('anywhere:openAccessibility').catch(() => undefined)}>
                  Open Settings
                </Button>
              </>
            )}
          </p>
          {state?.error && (
            <p role="alert" className="text-[12.5px] text-st-failed" data-testid="anywhere-error">
              {state.error}
            </p>
          )}
          <p className="text-[12.5px] leading-relaxed text-muted">
            Never types into password fields and never presses Return.
          </p>
        </div>
      )}
    </section>
  )
}
