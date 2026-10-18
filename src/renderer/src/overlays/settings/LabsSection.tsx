// Settings > Labs: the early features, each off until switched on. Video, Board and Dictate anywhere
// all work.

import { useEffect, useState } from 'react'
import type { Prefs } from '@shared/types'
import { bridge } from '../../lib/bridge'
import { SectionTitle } from './common'
import { LabsSwitch } from './labs/LabsSwitch'

type LabsKey = keyof Prefs['labs']

export function LabsSection(): React.JSX.Element {
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

  const setLabs = (key: LabsKey, value: boolean): void => {
    const labs = { ...(prefs?.labs ?? { video: false, board: false, anywhere: false }), [key]: value }
    // Optimistic, so the switch answers at once even before main replies.
    setPrefs((prev) => (prev ? { ...prev, labs } : prev))
    void bridge
      .invoke('prefs:set', { labs })
      .then((next) => setPrefs(next))
      .catch(() => undefined)
  }

  return (
    <div className="max-w-[560px]">
      <SectionTitle>Labs</SectionTitle>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Early features. Each one is off until you turn it on.</p>
      {!prefs ? (
        <p className="mt-4 text-[12.5px] text-muted" data-testid="labs-loading">
          Loading
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          <LabsSwitch
            testId="labs-video"
            title="Video"
            description="An agent writes a short video in code; render it to MP4."
            checked={prefs.labs.video}
            onChange={(next) => setLabs('video', next)}
          />
          <LabsSwitch
            testId="labs-board"
            title="Board"
            description="A board whose cards follow your runs."
            checked={prefs.labs.board}
            onChange={(next) => setLabs('board', next)}
          />
          <LabsSwitch
            testId="labs-anywhere"
            title="Dictate anywhere"
            description="Dictation into the app in front with Option+Shift+Command+Space. Needs Accessibility permission; never types into password fields."
            checked={prefs.labs.anywhere}
            onChange={(next) => setLabs('anywhere', next)}
          />
        </div>
      )}
    </div>
  )
}
