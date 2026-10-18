// State for the Device panel: the simulators on this Mac, which one is chosen, and its live screen.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SimDevice } from '@shared/types'
import { bridge } from '../../lib/bridge'
import { readStoredUdid, storeUdid } from './storage'

/** A simulator screen is slow to change, so a frame every second and a half is plenty. */
const POLL_MS = 1_500

/** Electron wraps errors from main; the message the panel shows is the part after the wrapper. */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim()
}

/** The name in the device list, for example "iPhone 17 Pro · iOS 26.0". */
export function deviceLabel(device: SimDevice): string {
  return `${device.name} · ${device.runtime}`
}

/** What the body of the panel shows. A frame, when there is one, comes instead of any of these. */
export type DevicePhase = 'loading' | 'booting' | 'waiting' | 'off' | 'none'

export interface Simulators {
  devices: SimDevice[]
  /** False until the first list has come back. */
  loaded: boolean
  /** The device the screen is shown for, "" when there is none. */
  udid: string
  device: SimDevice | undefined
  booted: boolean
  /** Which change is running, or null when the panel is free. */
  busy: 'boot' | 'shutdown' | null
  phase: DevicePhase
  /** PNG data URL of the newest frame, or null when there is none yet. */
  screen: string | null
  error: string | null
  choose: (udid: string) => void
  togglePower: () => void
  openSimulator: () => void
}

export function useSimulators(): Simulators {
  const [devices, setDevices] = useState<SimDevice[]>([])
  const [udid, setUdid] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<'boot' | 'shutdown' | null>(null)
  const [screen, setScreen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A list read that finished after another one started is stale, so drop it.
  const wanted = useRef(0)
  // The current selection, so a refresh can keep it without re-creating the loader.
  const udidRef = useRef(udid)
  udidRef.current = udid

  /** Reads the simulator list. `prefer` is the device to keep selected when it is still there. */
  const load = useCallback(async (prefer?: string): Promise<void> => {
    const ticket = (wanted.current += 1)
    setError(null)
    try {
      const list = await bridge.invoke('device:list')
      if (ticket !== wanted.current) return
      setDevices(list)
      const current = udidRef.current
      const keep = [prefer, current, readStoredUdid()].find((id) => id !== undefined && id !== '' && list.some((d) => d.udid === id))
      setUdid(keep ?? list[0]?.udid ?? '')
    } catch (err) {
      if (ticket !== wanted.current) return
      setError(errorMessage(err))
    } finally {
      if (ticket === wanted.current) setLoaded(true)
    }
  }, [])

  // The panel mounts only while it is open, so this runs each time the user shows it.
  useEffect(() => {
    void load()
  }, [load])

  const device = devices.find((d) => d.udid === udid)
  const booted = device?.state === 'Booted'

  const choose = useCallback((next: string): void => {
    setUdid(next)
    setScreen(null)
    storeUdid(next)
  }, [])

  const togglePower = useCallback((): void => {
    const target = device
    if (!target || busy !== null) return
    const wasBooted = target.state === 'Booted'
    setBusy(wasBooted ? 'shutdown' : 'boot')
    void (async () => {
      try {
        if (wasBooted) await bridge.invoke('device:shutdown', target.udid)
        else await bridge.invoke('device:boot', target.udid)
      } catch (err) {
        setError(errorMessage(err))
      }
      await load(target.udid)
      setBusy(null)
    })()
  }, [device, busy, load])

  const openSimulator = useCallback((): void => {
    void bridge.invoke('device:openSimulator').catch((err: unknown) => setError(errorMessage(err)))
  }, [])

  // One frame every 1.5 s, and only while the device is on. Hiding the panel unmounts this,
  // and a device that is shut down stops the timer outright.
  useEffect(() => {
    if (!udid || !booted) {
      setScreen(null)
      return
    }
    let cancelled = false
    // A capture can take twenty seconds on a slow Mac, so a tick while one is running is skipped
    // rather than stacking more simctl calls behind it.
    let inFlight = false
    const grab = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const next = await bridge.invoke('device:screenshot', udid)
        if (cancelled || next === null) return
        // A null capture means "not booted, or the frame is not ready": keep the last one.
        setScreen(next)
      } catch {
        // Same: a failed capture is not worth a warning strip, the device may be mid boot.
      } finally {
        inFlight = false
      }
    }
    void grab()
    const timer = setInterval(() => void grab(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [udid, booted])

  const phase: DevicePhase = !loaded
    ? 'loading'
    : devices.length === 0
      ? 'none'
      : busy === 'boot'
        ? 'booting'
        : booted
          ? 'waiting'
          : 'off'

  return { devices, loaded, udid, device, booted, busy, phase, screen, error, choose, togglePower, openSimulator }
}
