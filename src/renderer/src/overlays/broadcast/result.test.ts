import { describe, expect, it } from 'vitest'
import { sentSummary, notSentLine } from './result'

describe('broadcast result wording', () => {
  it('says "all N" only when every picked pane took the text', () => {
    expect(sentSummary(4, 4)).toBe('Sent to all 4 panes')
    expect(sentSummary(3, 4)).toBe('Sent to 3 of 4 panes')
    expect(sentSummary(0, 4)).toBe('Sent to 0 of 4 panes')
  })

  it('handles the empty pick without inventing a number', () => {
    expect(sentSummary(0, 0)).toBe('Nothing was sent')
  })

  it('names the panes that did not take it, so a partial send is honest', () => {
    expect(notSentLine([{ short: 'codex' }])).toBe('not sent: codex has exited')
    expect(notSentLine([{ short: 'codex' }, { short: 'gemini' }])).toBe('not sent: codex has exited, gemini has exited')
    expect(notSentLine([])).toBe('')
  })
})
