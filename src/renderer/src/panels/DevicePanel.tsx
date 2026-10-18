// Device preview beside the panes: the simulators on this Mac and the screen of the chosen one.

import { Power, Smartphone } from 'lucide-react'
import type { SimDevice } from '@shared/types'
import { Button, cx } from '../components/ui'
import { PhoneFrame } from './device/PhoneFrame'
import { deviceLabel, useSimulators } from './device/useSimulators'

const STATE_TEXT: Record<string, string> = {
  Booted: 'Booted',
  Shutdown: 'Off',
  Booting: 'Booting',
  ShuttingDown: 'Shutting down'
}

const STATE_TONE: Record<string, string> = {
  Booted: 'border-st-idle/40 bg-st-idle/10 text-st-idle',
  Booting: 'border-st-starting/40 bg-st-starting/10 text-st-starting',
  ShuttingDown: 'border-st-starting/40 bg-st-starting/10 text-st-starting'
}

function StateBadge({ state }: { state: string }): React.JSX.Element {
  return (
    <span
      data-testid="device-state"
      className={cx(
        'shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] leading-none transition-colors duration-150',
        STATE_TONE[state] ?? 'border-line-strong bg-raised text-faint'
      )}
    >
      {STATE_TEXT[state] ?? state}
    </span>
  )
}

export function DevicePanel(): React.JSX.Element {
  const { devices, loaded, udid, device, booted, busy, phase, screen, error, choose, togglePower, openSimulator } = useSimulators()
  const hasDevice = loaded && devices.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="device-panel">
      {hasDevice && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-2">
          <select
            data-testid="device-select"
            aria-label="Simulator"
            value={udid}
            onChange={(e) => choose(e.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-raised px-1.5 text-[12px] text-fg outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {devices.map((d: SimDevice) => (
              <option key={d.udid} value={d.udid}>
                {deviceLabel(d)}
              </option>
            ))}
          </select>
          {device !== undefined && <StateBadge state={device.state} />}
          <Button variant="subtle" size="sm" data-testid="device-boot" onClick={togglePower} disabled={busy !== null} title={booted ? 'Shut the simulator down' : 'Boot the simulator'}>
            <Power size={13} className={booted ? 'text-st-idle' : 'text-muted'} />
            {booted ? 'Shut down' : 'Boot'}
          </Button>
          <Button variant="ghost" size="sm" data-testid="device-open-simulator" onClick={openSimulator} title="Show the Simulator app">
            <Smartphone size={13} />
            Open Simulator
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        <PhoneFrame phase={phase} screen={screen} />
      </div>

      {error !== null && (
        <p
          data-testid="device-error"
          role="alert"
          className="shrink-0 border-t border-line bg-panel px-3 py-2 text-[11.5px] leading-relaxed text-st-failed"
        >
          {error}
        </p>
      )}
    </div>
  )
}
