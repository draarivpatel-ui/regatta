// Mounts whichever overlay is open. Each overlay lives in its own file.

import { useEffect } from 'react'
import { useUi } from '../store/ui'
import { bridge } from '../lib/bridge'
import { BroadcastDialog } from './Broadcast'
import { CheckpointsPanel } from './Checkpoints'
import { SkipperView } from './Skipper'
import { InboxPanel } from './Inbox'
import { LaunchSetDialog } from './LaunchSet'
import { NightWatchView } from './NightWatch'
import { QuickActions } from './QuickActions'
import { SettingsScreen } from './Settings'
import { OnboardingSheet } from './Onboarding'

export function Overlays(): React.JSX.Element | null {
  const overlay = useUi((s) => s.overlay)
  const close = (): void => useUi.getState().openOverlay(null)

  // First run: show the welcome sheet once, unless something else is already open.
  useEffect(() => {
    let alive = true
    void bridge
      .invoke('prefs:get')
      .then((prefs) => {
        if (alive && !prefs.welcomeSeen && useUi.getState().overlay === null) {
          useUi.getState().openOverlay('welcome')
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  switch (overlay) {
    case 'inbox':
      return <InboxPanel onClose={close} />
    case 'broadcast':
      return <BroadcastDialog onClose={close} />
    case 'quick':
      return <QuickActions onClose={close} />
    case 'settings':
      return <SettingsScreen onClose={close} />
    case 'launchset':
      return <LaunchSetDialog onClose={close} />
    case 'skipper':
      return <SkipperView onClose={close} />
    case 'checkpoints':
      return <CheckpointsPanel onClose={close} />
    case 'night':
      return <NightWatchView onClose={close} />
    case 'welcome':
      return <OnboardingSheet onClose={close} />
    default:
      return null
  }
}
