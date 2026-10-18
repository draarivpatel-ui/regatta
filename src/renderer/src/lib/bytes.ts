// Human readable byte sizes for the memory readout.

const KB = 1024
const MB = 1024 * 1024

const BIG_UNITS = ['MB', 'GB', 'TB', 'PB', 'EB'] as const

/** Formats bytes as "0 B", "512 KB", "1.2 MB" or "3.4 GB". One decimal from MB up, none below. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < KB) return `${Math.round(bytes)} B`
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`
  let value = bytes / MB
  let unit = 0
  while (value >= KB && unit < BIG_UNITS.length - 1) {
    value /= KB
    unit += 1
  }
  return `${value.toFixed(1)} ${BIG_UNITS[unit]}`
}
