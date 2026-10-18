// The small box that opens where the user pointed at the frame: what is there, a note, and the button
// that asks the agent for the change.

import { Button } from '../../components/ui'
import { formatClock, placeNote } from './common'

/** A spot the user pointed at. */
export interface PointSpot {
  /** Where the click landed, in the player area's own pixels. */
  boxX: number
  boxY: number
  /** Stage coordinates, kept for the change request. */
  x: number
  y: number
  scene: string | null
  selector: string | null
  text: string
  time: number
}

/** The box is this wide and this tall (the note field does not resize); near an edge it moves to the other side of the click. */
export const NOTE_WIDTH = 248
const NOTE_HEIGHT = 160

export function PointBox({
  spot,
  region,
  note,
  onNote,
  onSend,
  onCancel
}: {
  spot: PointSpot
  region: { width: number; height: number }
  note: string
  onNote: (text: string) => void
  onSend: () => void
  onCancel: () => void
}): React.JSX.Element {
  const place = placeNote({ x: spot.boxX, y: spot.boxY }, region, { width: NOTE_WIDTH, height: NOTE_HEIGHT })
  return (
    <>
      {/* Where the click landed, so the user can see what the note is about. */}
      <span
        aria-hidden
        data-testid="video-point-marker"
        className="pointer-events-none absolute z-10 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-accent/15"
        style={{ left: spot.boxX, top: spot.boxY }}
      />
      <div
        data-testid="video-note"
        role="dialog"
        aria-label="Ask for a change at this spot"
        className="absolute z-20 rounded-xl border border-line-strong bg-raised/95 p-2.5 shadow-2xl backdrop-blur-xl animate-pop-in"
        style={{ left: place.left, top: place.top, width: NOTE_WIDTH }}
      >
        <p className="text-[11px] text-muted" data-testid="video-note-time">
          {formatClock(spot.time)}
          {spot.scene ? <span className="text-faint"> · {spot.scene}</span> : null}
        </p>
        <p className="mt-0.5 truncate text-[12px] text-fg" title={spot.text} data-testid="video-note-text">
          {spot.text || <span className="text-faint">the frame itself</span>}
        </p>
        <textarea
          autoFocus
          className="mt-1.5 min-h-[52px] w-full resize-none rounded-md border border-line-strong bg-panel px-2 py-1 text-[12px] text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/40"
          data-testid="video-note-field"
          placeholder="What should change here?"
          value={note}
          onChange={(e) => onNote(e.target.value)}
          onKeyDown={(e) => {
            // Cmd or Ctrl and Enter sends, as in the other message boxes.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && note.trim().length > 0) {
              e.preventDefault()
              onSend()
            }
          }}
        />
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          <Button variant="ghost" size="sm" data-testid="video-note-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="accent" size="sm" data-testid="video-note-send" disabled={note.trim().length === 0} onClick={onSend}>
            Ask for this change
          </Button>
        </div>
      </div>
    </>
  )
}
