import { describe, expect, it } from 'vitest'
import { formatBytes } from './bytes'

describe('formatBytes', () => {
  it('formats bytes and kilobytes without decimals', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(512 * 1024)).toBe('512 KB')
  })

  it('formats megabytes and gigabytes with one decimal', () => {
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB')
    expect(formatBytes(3.4 * 1024 * 1024 * 1024)).toBe('3.4 GB')
  })
})
