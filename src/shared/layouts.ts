// Pane grid layouts. Pure functions so they can be unit tested.

export type LayoutId = 'one' | 'two' | 'duo-preview' | 'pair-preview' | 'four' | 'six' | 'nine' | 'twelve' | 'sixteen'

export interface LayoutDef {
  id: LayoutId
  label: string
  capacity: number
  cols: number
  rows: number
  /** Opens the preview panel next to the panes. */
  withPreview: boolean
  /** Opens the right sidebar on its Preview tab when this layout is chosen. */
  sidebarPreview: boolean
  hint: string
}

export const LAYOUTS: LayoutDef[] = [
  { id: 'duo-preview', label: 'Two + preview', capacity: 2, cols: 2, rows: 1, withPreview: true, sidebarPreview: false, hint: 'Two agents and a live preview' },
  { id: 'pair-preview', label: 'Pair with preview', capacity: 2, cols: 2, rows: 1, withPreview: false, sidebarPreview: true, hint: 'Two panes side by side, preview open' },
  { id: 'one', label: 'Single', capacity: 1, cols: 1, rows: 1, withPreview: false, sidebarPreview: false, hint: 'One agent, full size' },
  { id: 'two', label: 'Side by side', capacity: 2, cols: 2, rows: 1, withPreview: false, sidebarPreview: false, hint: 'Compare two agents' },
  { id: 'four', label: 'Four', capacity: 4, cols: 2, rows: 2, withPreview: false, sidebarPreview: false, hint: 'Good for watching a crew' },
  { id: 'six', label: 'Six', capacity: 6, cols: 3, rows: 2, withPreview: false, sidebarPreview: false, hint: 'Needs a wide window' },
  { id: 'nine', label: 'Nine', capacity: 9, cols: 3, rows: 3, withPreview: false, sidebarPreview: false, hint: 'Needs a large window' },
  { id: 'twelve', label: 'Twelve', capacity: 12, cols: 4, rows: 3, withPreview: false, sidebarPreview: false, hint: 'Needs a large window' },
  { id: 'sixteen', label: 'Sixteen', capacity: 16, cols: 4, rows: 4, withPreview: false, sidebarPreview: false, hint: 'Needs a very large window' }
]

export const MAX_PANES = 16

/** Smallest comfortable pane, in CSS pixels. */
export const MIN_PANE = { width: 300, height: 170 }

export function getLayout(id: LayoutId): LayoutDef {
  const found = LAYOUTS.find((l) => l.id === id)
  if (!found) throw new Error(`Unknown layout: ${id}`)
  return found
}

/** True when every pane of the layout would be at least MIN_PANE in the given area. */
export function layoutFits(layout: LayoutDef, width: number, height: number, gap = 8): boolean {
  const paneW = (width - gap * (layout.cols - 1)) / layout.cols
  const paneH = (height - gap * (layout.rows - 1)) / layout.rows
  return paneW >= MIN_PANE.width && paneH >= MIN_PANE.height
}

/** Smallest window area (CSS pixels) where every pane still reaches MIN_PANE, same gap as layoutFits. */
export function layoutMinSize(layout: LayoutDef, gap = 8): { width: number; height: number } {
  return {
    width: layout.cols * MIN_PANE.width + (layout.cols - 1) * gap,
    height: layout.rows * MIN_PANE.height + (layout.rows - 1) * gap
  }
}

/** The line shown under the layout menu for a layout too big for the window, for example
 * "16 panes need a window at least 1224 by 704 (yours is 1000 by 700)." */
export function layoutFitReason(layout: LayoutDef, width: number, height: number, gap = 8): string {
  const min = layoutMinSize(layout, gap)
  const panes = layout.capacity === 1 ? '1 pane needs' : `${layout.capacity} panes need`
  return `${panes} a window at least ${min.width} by ${min.height} (yours is ${Math.round(width)} by ${Math.round(height)}).`
}

/** Smallest layout (by capacity) that can hold `count` panes, never a preview layout. */
export function layoutForCount(count: number): LayoutDef {
  const plain = LAYOUTS.filter((l) => !l.withPreview && !l.sidebarPreview).sort((a, b) => a.capacity - b.capacity)
  return plain.find((l) => l.capacity >= count) ?? plain[plain.length - 1]!
}

/** Grid placement for `count` panes inside a layout: rows actually used and columns. */
export function gridFor(layout: LayoutDef, count: number): { cols: number; rows: number } {
  if (count <= 0) return { cols: 1, rows: 1 }
  const shown = Math.min(count, layout.capacity)
  const cols = Math.min(layout.cols, shown)
  const rows = Math.min(layout.rows, Math.ceil(shown / cols))
  return { cols, rows }
}
