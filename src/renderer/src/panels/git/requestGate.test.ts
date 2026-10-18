import { describe, expect, it } from 'vitest'
import { RequestGate } from './requestGate'

describe('RequestGate', () => {
  it('accepts the newest request for the folder on screen', () => {
    const gate = new RequestGate()
    const ticket = gate.begin('/repo/a')
    expect(gate.isCurrent(ticket, '/repo/a')).toBe(true)
  })

  it('drops a slow answer for the previous folder after the folder changed', () => {
    const gate = new RequestGate()
    const slow = gate.begin('/repo/a')
    const next = gate.begin('/repo/b')
    expect(gate.isCurrent(slow, '/repo/b')).toBe(false)
    expect(gate.isCurrent(next, '/repo/b')).toBe(true)
  })

  it('drops an answer whose folder is no longer shown even if nothing newer was asked', () => {
    const gate = new RequestGate()
    const ticket = gate.begin('/repo/a')
    expect(gate.isCurrent(ticket, '/repo/b')).toBe(false)
    expect(gate.isCurrent(ticket, null)).toBe(false)
  })

  it('drops an older answer for the same folder when a newer request exists', () => {
    const gate = new RequestGate()
    const older = gate.begin('/repo/a')
    const newer = gate.begin('/repo/a')
    expect(gate.isCurrent(older, '/repo/a')).toBe(false)
    expect(gate.isCurrent(newer, '/repo/a')).toBe(true)
  })

  it('drops the first answer when the folder goes a, b, a', () => {
    const gate = new RequestGate()
    const first = gate.begin('/repo/a')
    gate.begin('/repo/b')
    const again = gate.begin('/repo/a')
    expect(gate.isCurrent(first, '/repo/a')).toBe(false)
    expect(gate.isCurrent(again, '/repo/a')).toBe(true)
  })
})
