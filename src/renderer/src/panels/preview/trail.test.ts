import { describe, expect, it } from 'vitest'
import { canGoBack, canGoForward, onArrive, startTrail } from './trail'

describe('the trail of addresses', () => {
  it('starts with nowhere to go', () => {
    const trail = startTrail('http://localhost:3000')
    expect(canGoBack(trail)).toBe(false)
    expect(canGoForward(trail)).toBe(false)
  })

  it('offers Back after a new address', () => {
    const trail = onArrive(startTrail('http://localhost:3000'), 'http://localhost:3000/orders')
    expect(canGoBack(trail)).toBe(true)
    expect(canGoForward(trail)).toBe(false)
  })

  it('moves back to an address it has been to, and forward again', () => {
    const first = startTrail('http://localhost:3000')
    const second = onArrive(first, 'http://localhost:3000/orders')
    const back = onArrive(second, 'http://localhost:3000')
    expect(back.at).toBe(0)
    expect(canGoForward(back)).toBe(true)
    expect(onArrive(back, 'http://localhost:3000/orders').at).toBe(1)
  })

  it('drops the addresses ahead once the page goes somewhere new', () => {
    const trail = onArrive(onArrive(startTrail('a'), 'b'), 'a')
    const next = onArrive(trail, 'c')
    expect(next.urls).toEqual(['a', 'c'])
    expect(canGoForward(next)).toBe(false)
  })

  it('keeps the same object when the page did not move', () => {
    const trail = startTrail('http://localhost:3000')
    expect(onArrive(trail, 'http://localhost:3000')).toBe(trail)
  })
})