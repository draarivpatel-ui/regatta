import { describe, expect, it } from 'vitest'
import { isLocalUrl } from './spotfix'

describe('isLocalUrl', () => {
  it('accepts pages on this computer', () => {
    expect(isLocalUrl('http://localhost:5173/')).toBe(true)
    expect(isLocalUrl('https://localhost/app')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1:3000/x?y=1')).toBe(true)
    expect(isLocalUrl('http://[::1]:8080/')).toBe(true)
    expect(isLocalUrl('http://a.localhost:4000/')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(isLocalUrl('file:///tmp/index.html')).toBe(false)
    expect(isLocalUrl('http://localhost.evil.com/')).toBe(false)
    expect(isLocalUrl('http://127.0.0.1.nip.io/')).toBe(false)
    expect(isLocalUrl('javascript:alert(1)')).toBe(false)
    expect(isLocalUrl('http://example.com/')).toBe(false)
    expect(isLocalUrl('garbage')).toBe(false)
    expect(isLocalUrl('')).toBe(false)
  })
})
