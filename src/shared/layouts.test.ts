import { describe, expect, it } from 'vitest'
import { LAYOUTS, getLayout, gridFor, layoutFits, layoutFitReason, layoutForCount, layoutMinSize } from './layouts'

describe('layouts', () => {
  it('picks the smallest plain layout that holds the panes', () => {
    expect(layoutForCount(1).id).toBe('one')
    expect(layoutForCount(2).id).toBe('two')
    expect(layoutForCount(3).id).toBe('four')
    expect(layoutForCount(5).id).toBe('six')
    expect(layoutForCount(10).id).toBe('twelve')
    expect(layoutForCount(40).id).toBe('sixteen')
  })

  it('only fills the rows it needs', () => {
    expect(gridFor(getLayout('four'), 1)).toEqual({ cols: 1, rows: 1 })
    expect(gridFor(getLayout('four'), 3)).toEqual({ cols: 2, rows: 2 })
    expect(gridFor(getLayout('nine'), 4)).toEqual({ cols: 3, rows: 2 })
    expect(gridFor(getLayout('sixteen'), 20)).toEqual({ cols: 4, rows: 4 })
  })

  it('knows when a window is too small for a layout', () => {
    expect(layoutFits(getLayout('four'), 1100, 700)).toBe(true)
    expect(layoutFits(getLayout('sixteen'), 1100, 700)).toBe(false)
  })

  it('has "Pair with preview": two panes that opens the sidebar preview, never the auto pick', () => {
    const pair = getLayout('pair-preview')
    expect(LAYOUTS.some((l) => l.id === 'pair-preview')).toBe(true)
    expect(pair).toMatchObject({ label: 'Pair with preview', capacity: 2, cols: 2, rows: 1, withPreview: false, sidebarPreview: true })
    // An auto layout for a pane count is always a plain one, never one that moves the sidebar.
    for (const n of [1, 2, 4, 16]) expect(layoutForCount(n).id).not.toBe('pair-preview')
    // Only the two preview layouts carry a preview flag, and each carries exactly one kind.
    const previewFlags = LAYOUTS.filter((l) => l.withPreview || l.sidebarPreview).map((l) => `${l.id}:${l.withPreview}/${l.sidebarPreview}`)
    expect(previewFlags).toEqual(['duo-preview:true/false', 'pair-preview:false/true'])
  })

  it('computes the smallest window where every pane reaches the minimum', () => {
    // MIN_PANE is 300 by 170 and the default gap is 8.
    expect(layoutMinSize(getLayout('one'))).toEqual({ width: 300, height: 170 })
    expect(layoutMinSize(getLayout('pair-preview'))).toEqual({ width: 608, height: 170 })
    expect(layoutMinSize(getLayout('sixteen'))).toEqual({ width: 4 * 300 + 3 * 8, height: 4 * 170 + 3 * 8 })
    expect(layoutMinSize(getLayout('sixteen'))).toEqual({ width: 1224, height: 704 })
    // The minimum size and layoutFits agree: a window at the minimum fits, one pixel smaller does not.
    const sixteen = getLayout('sixteen')
    const min = layoutMinSize(sixteen)
    expect(layoutFits(sixteen, min.width, min.height)).toBe(true)
    expect(layoutFits(sixteen, min.width - 1, min.height)).toBe(false)
    expect(layoutFits(sixteen, min.width, min.height - 1)).toBe(false)
  })

  it('says why a too-big layout does not fit, in words', () => {
    expect(layoutFitReason(getLayout('sixteen'), 1100, 700)).toBe('16 panes need a window at least 1224 by 704 (yours is 1100 by 700).')
    expect(layoutFitReason(getLayout('one'), 100, 100)).toBe('1 pane needs a window at least 300 by 170 (yours is 100 by 100).')
    expect(layoutFitReason(getLayout('pair-preview'), 400, 700)).toBe('2 panes need a window at least 608 by 170 (yours is 400 by 700).')
  })
})
