// Device sizes, address tidying and the remembered address for the Preview tab.

export type DeviceId = 'desktop' | 'tablet' | 'phone'

export interface DeviceDef {
  id: DeviceId
  label: string
  /** Fixed pixel width, or null for the full width of the panel. */
  width: number | null
}

export const DEVICES: DeviceDef[] = [
  { id: 'desktop', label: 'Desktop', width: null },
  { id: 'tablet', label: 'Tablet', width: 768 },
  { id: 'phone', label: 'Phone', width: 390 }
]

/** Where the preview opens before the user types anything, and after storage is cleared. */
export const DEFAULT_URL = 'http://localhost:3000'

const STORAGE_KEY = 'regatta.preview.url'

/** Schemes that are already complete enough to hand to the webview as they are. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const SHORT_SCHEME = /^(file|data|about|blob):/i

/**
 * The address to load: what the user typed, with a scheme added when they left it off.
 * Returns an empty string for input that holds nothing worth loading.
 */
export function normalizeUrl(raw: string): string {
  const value = raw.trim()
  if (value === '') return ''
  if (HAS_SCHEME.test(value) || SHORT_SCHEME.test(value)) return value
  return `http://${value}`
}

/** True for the addresses that a normal web browser can open. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}

/** The address to show on the title of a device button, for example "390 px". */
export function deviceWidthLabel(device: DeviceId): string {
  const width = DEVICES.find((d) => d.id === device)?.width
  return width === null || width === undefined ? 'Full width' : `${width} px`
}

/** The last address the user looked at, or the default when there is none. */
export function readStoredUrl(): string {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value !== null && value.trim() !== '' ? value : DEFAULT_URL
  } catch {
    // Storage can be off (private window, locked profile). The default still works.
    return DEFAULT_URL
  }
}

/** Remembers the address for next time. Silently does nothing when storage is off. */
export function storeUrl(url: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, url)
  } catch {
    // Nothing to do: the preview still works, it just forgets.
  }
}