import { describe, expect, it } from 'vitest'
import { isSubsequence, score } from './match'

describe('match score', () => {
  it('returns null when query letters do not appear in order', () => {
    expect(score('six', 'seven')).toBeNull()
    expect(score('six', 'xis')).toBeNull()
    expect(score('abc', 'acb')).toBeNull()
    expect(isSubsequence('abc', 'acb')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(score('SIX', 'layout: six')).toBe(score('six', 'Layout: Six'))
    expect(score('Six', 'LAYOUT: SIX')).toBe(score('six', 'Layout: Six'))
    expect(score('six', 'Layout: Six')).not.toBeNull()
  })

  it('returns 0 for empty query to keep original order', () => {
    expect(score('', 'Layout: Six')).toBe(0)
    expect(score('', 'Anything')).toBe(0)
    expect(score('   ', 'Anything')).toBe(0)
  })

  it('exact prefix beats start of a word', () => {
    const prefixScore = score('six', 'Sixteen')
    const wordStartScore = score('six', 'Layout: Six')
    expect(prefixScore).not.toBeNull()
    expect(wordStartScore).not.toBeNull()
    expect(prefixScore!).toBeGreaterThan(wordStartScore!)
  })

  it('start of a word beats scattered subsequence', () => {
    const wordStartScore = score('six', 'Layout: Six')
    const scatteredScore = score('six', 's-item-x')
    expect(wordStartScore).not.toBeNull()
    expect(scatteredScore).not.toBeNull()
    expect(wordStartScore!).toBeGreaterThan(scatteredScore!)
  })

  it('shorter labels win ties within the same tier', () => {
    // Both are start of a word: 'Layout: Six' (shorter) beats 'Layout: Sixteen'
    const sixScore = score('six', 'Layout: Six')
    const sixteenScore = score('six', 'Layout: Sixteen')
    expect(sixScore).not.toBeNull()
    expect(sixteenScore).not.toBeNull()
    expect(sixScore!).toBeGreaterThan(sixteenScore!)

    // Both are exact prefix: 'Six' beats 'Sixteen'
    const shortPrefix = score('six', 'Six')
    const longPrefix = score('six', 'Sixteen')
    expect(shortPrefix!).toBeGreaterThan(longPrefix!)

    // Both are scattered subsequence
    const shortScattered = score('st', 'start')
    const longScattered = score('st', 'something longer')
    expect(shortScattered!).toBeGreaterThan(longScattered!)
  })

  it('handles multi-word queries matching word starts', () => {
    const match = score('test agent', 'Start Test Agent')
    expect(match).not.toBeNull()
    // Should be at least start-of-word tier
    expect(match!).toBeGreaterThan(15000)
  })
})
