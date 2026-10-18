// Remembered simulator choice for the Device panel.

const STORAGE_KEY = 'regatta.device'

/** The device looked at last time, or "" when there is none. */
export function readStoredUdid(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY)?.trim() ?? ''
  } catch {
    // Storage can be off (locked profile). The panel still works, it just forgets.
    return ''
  }
}

/** Remembers the device for next time. Silently does nothing when storage is off. */
export function storeUdid(udid: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, udid)
  } catch {
    // Nothing to do.
  }
}
