import { describe, expect, it } from 'vitest'
import { deviceWidthLabel, isWebUrl, normalizeUrl } from './devices'

describe('normalizeUrl', () => {
  it('leaves a full address alone', () => {
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('https://example.com/app?q=1')).toBe('https://example.com/app?q=1')
    expect(normalizeUrl('file:///tmp/index.html')).toBe('file:///tmp/index.html')
  })

  it('adds http when the scheme is missing', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('example.com')).toBe('http://example.com')
  })

  it('trims what the user typed', () => {
    expect(normalizeUrl('  http://localhost:3000  ')).toBe('http://localhost:3000')
  })

  it('returns nothing for empty input', () => {
    expect(normalizeUrl('   ')).toBe('')
  })
})

describe('isWebUrl', () => {
  it('accepts http and https only', () => {
    expect(isWebUrl('http://localhost:3000')).toBe(true)
    expect(isWebUrl('https://example.com')).toBe(true)
    expect(isWebUrl('file:///tmp/index.html')).toBe(false)
    expect(isWebUrl('about:blank')).toBe(false)
  })
})

describe('deviceWidthLabel', () => {
  it('names the fixed widths and calls the rest full width', () => {
    expect(deviceWidthLabel('desktop')).toBe('Full width')
    expect(deviceWidthLabel('tablet')).toBe('768 px')
    expect(deviceWidthLabel('phone')).toBe('390 px')
  })
})