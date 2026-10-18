import { describe, expect, it } from 'vitest'
import { parsePs, treeRssBytes } from './memory'

describe('parsePs', () => {
  it('parses pid, ppid and rss rows', () => {
    const text = '    1     0  1234\n  100     1  5678\n'
    expect(parsePs(text)).toEqual([
      { pid: 1, ppid: 0, rssKb: 1234 },
      { pid: 100, ppid: 1, rssKb: 5678 }
    ])
  })

  it('ignores bad lines', () => {
    const text = '  10     1   512\nnot a row\n  11     1\n  12     1   abc\n\n  13     1   256  extra\n'
    expect(parsePs(text)).toEqual([{ pid: 10, ppid: 1, rssKb: 512 }])
  })
})

describe('treeRssBytes', () => {
  it('sums nested children in bytes', () => {
    const rows = [
      { pid: 10, ppid: 1, rssKb: 100 },
      { pid: 11, ppid: 10, rssKb: 200 },
      { pid: 12, ppid: 11, rssKb: 300 },
      { pid: 99, ppid: 1, rssKb: 9999 }
    ]
    expect(treeRssBytes(rows, 10)).toBe((100 + 200 + 300) * 1024)
  })

  it('handles a cycle safely', () => {
    const rows = [
      { pid: 20, ppid: 21, rssKb: 100 },
      { pid: 21, ppid: 20, rssKb: 200 }
    ]
    expect(treeRssBytes(rows, 20)).toBe((100 + 200) * 1024)
  })

  it('returns 0 for a missing root', () => {
    const rows = [{ pid: 30, ppid: 1, rssKb: 100 }]
    expect(treeRssBytes(rows, 424242)).toBe(0)
  })
})
