// How a step prompt is filled in: the brief and the previous output go in exactly as they are.

import { describe, expect, it } from 'vitest'
import { fillPrompt } from '../../shared/flows'

describe('fillPrompt', () => {
  it('puts the brief in as it is, whatever characters it holds', () => {
    // In a replacement string these mean "the match", "what follows it", "what precedes it", a dollar and a group.
    expect(fillPrompt('Plan {{brief}}', 'cost $& total', 'x')).toBe('Plan cost $& total')
    expect(fillPrompt('Plan {{brief}}', "it's $' done", 'x')).toBe("Plan it's $' done")
    expect(fillPrompt('Plan {{brief}}', 'back $` tick', 'x')).toBe('Plan back $` tick')
    expect(fillPrompt('Plan {{brief}}', '$$ and $1', 'x')).toBe('Plan $$ and $1')
  })

  it('puts the previous output in as it is, whatever characters it holds', () => {
    expect(fillPrompt('Said: {{previous}}', 'x', "it's $' done")).toBe("Said: it's $' done")
    expect(fillPrompt('Said: {{ previous }}', 'x', 'cost $& total')).toBe('Said: cost $& total')
    expect(fillPrompt('Said: {{previous}}', 'x', '$` and $$ and $1')).toBe('Said: $` and $$ and $1')
  })

  it('fills both in one pass: a placeholder inside the brief or the output stays text', () => {
    expect(fillPrompt('A {{brief}} B {{previous}}', 'see {{previous}}', 'out')).toBe('A see {{previous}} B out')
    expect(fillPrompt('A {{previous}} B {{brief}}', 'the brief', 'see {{brief}}')).toBe('A see {{brief}} B the brief')
  })

  it('fills every placeholder and leaves other braces alone', () => {
    expect(fillPrompt('{{brief}} and {{ brief }} and {{previous}}', 'b', 'p')).toBe('b and b and p')
    expect(fillPrompt('{{other}} {brief} {{brief}', 'b', 'p')).toBe('{{other}} {brief} {{brief}')
  })
})
