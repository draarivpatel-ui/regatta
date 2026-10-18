// The phone shaped body of the Device panel: a live simulator screen in a rounded frame.

import { Smartphone } from 'lucide-react'
import type { DevicePhase } from './useSimulators'

/** The two states with no screen of their own say what to do next. */
export const NO_SIMULATORS = 'No simulators found. Install Xcode and an iOS simulator runtime.'
export const NEED_BOOT = 'Boot a device to see its screen here.'

const BUSY_TEXT: Record<Exclude<DevicePhase, 'none'>, string> = {
  loading: 'Reading simulators…',
  booting: 'Booting…',
  waiting: 'Booting…',
  off: NEED_BOOT
}

export function PhoneFrame({ phase, screen }: { phase: DevicePhase; screen: string | null }): React.JSX.Element {
  if (phase === 'none') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
        <Smartphone size={22} className="text-faint" />
        <p data-testid="device-none" className="text-[12px] leading-relaxed text-muted">
          {NO_SIMULATORS}
        </p>
      </div>
    )
  }

  // The hook only clears the frame when nothing is on screen, so one frame here is the live device.
  if (screen !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center px-3 py-3">
        <div
          data-testid="device-frame"
          className="relative w-full max-w-[230px] flex-1 overflow-hidden rounded-[28px] border-[7px] border-press bg-term shadow-[0_18px_44px_-18px_rgba(0,0,0,0.85)]"
        >
          <span className="pointer-events-none absolute left-1/2 top-1 z-10 h-[3px] w-14 -translate-x-1/2 rounded-full bg-line-strong" aria-hidden="true" />
          <img
            src={screen}
            alt="Simulator screen"
            data-testid="device-screen"
            draggable={false}
            className="h-full w-full rounded-[21px] object-contain"
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <p data-testid="device-busy" className="animate-breathe text-center text-[12px] text-muted">
        {BUSY_TEXT[phase]}
      </p>
    </div>
  )
}
