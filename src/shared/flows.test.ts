import { describe, expect, it } from 'vitest'
import { MAX_STEPS, RECIPES, fillPrompt } from './flows'

describe('flows', () => {
  it('fills the brief and previous placeholders', () => {
    expect(fillPrompt('Plan {{brief}} then {{ previous }}', 'a cart', 'step one said hi')).toBe('Plan a cart then step one said hi')
    expect(fillPrompt('No placeholders', 'x', 'y')).toBe('No placeholders')
  })
  it('ships recipes that fit the step limit and name their agents', () => {
    expect(RECIPES.length).toBeGreaterThanOrEqual(5)
    for (const r of RECIPES) {
      expect(r.steps.length).toBeLessThanOrEqual(MAX_STEPS)
      for (const s of r.steps) {
        if (s.kind === 'agent') expect(s.agent && s.prompt).toBeTruthy()
        if (s.kind === 'check') expect(s.command).toBeTruthy()
      }
    }
  })
})
