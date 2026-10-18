// A note as it reads, with every git command it names shown as a small code chip that carries its own
// copy button, so a note holding two commands offers a copy of each instead of a copy of the first.
// The words around the commands stay plain text.

import { CopyButton } from './CopyButton'

/** A piece of a note: plain words, or one git command the user may want to run by hand. */
export interface NotePart {
  kind: 'text' | 'command'
  text: string
}

/**
 * The verbs a note tells the user to run: the two the engines write into a kept copy ("git branch <name>
 * <ref>^1" restores it, "git log <ref>" lists it). A command never begins with anything else, so a
 * sentence that quotes git at work ("git status warned: ...") stays prose.
 */
const COMMAND = /\bgit (?:branch|log) /g

/**
 * Where the command that starts at `from` (the first word after the verb) ends, or null when nothing
 * follows that names anything. A word naming something is a branch, a ref or a placeholder: it carries a
 * slash, a dash, a caret, a bracket or a digit. A plain word is the sentence the command sits in, as in
 * "git log <ref> shows everything kept", so the command stops before it.
 */
function commandEnd(note: string, from: number): number | null {
  let end: number | null = null
  let at = from
  for (;;) {
    let start = at
    while (start < note.length && note[start] === ' ') start++
    // The end of the sentence, the close of the parenthesis or the end of the note ends the command.
    if (start >= note.length || note[start] === ';' || note[start] === ')') return end
    let stop = start
    while (stop < note.length && !/[ ;)]/.test(note[stop]!)) stop++
    const token = note.slice(start, stop)
    // A full stop or a comma the sentence put after the word is not part of the command.
    const word = token.replace(/[.,;:]+$/, '')
    if (word === '' || /^[A-Za-z]+$/.test(word)) return end
    end = start + word.length
    at = stop
    if (word.length !== token.length) return end
  }
}

/**
 * The parts of a note, in order: the words, and each git command it names. Joining the parts gives the
 * note back, so nothing is lost by reading it this way.
 */
export function noteParts(note: string): NotePart[] {
  const parts: NotePart[] = []
  let cursor = 0
  for (const found of note.matchAll(COMMAND)) {
    const start = found.index ?? 0
    if (start < cursor) continue
    const end = commandEnd(note, start + found[0].length)
    if (end === null) continue
    if (start > cursor) parts.push({ kind: 'text', text: note.slice(cursor, start) })
    parts.push({ kind: 'command', text: note.slice(start, end) })
    cursor = end
  }
  if (cursor < note.length) parts.push({ kind: 'text', text: note.slice(cursor) })
  return parts
}

export function NoteText({ note }: { note: string }): React.JSX.Element {
  return (
    <span className="min-w-0 flex-1 select-text break-words">
      {noteParts(note).map((part, i) =>
        part.kind === 'text' ? (
          <span key={i}>{part.text}</span>
        ) : (
          <span key={i} className="mx-1 rounded-md border border-line bg-raised px-1.5 align-middle">
            <code data-testid="note-command" className="font-mono text-[11px] text-muted">
              {part.text}
            </code>
            <CopyButton text={part.text} testId="copy-command" title="Copy this command" />
          </span>
        )
      )}
    </span>
  )
}
