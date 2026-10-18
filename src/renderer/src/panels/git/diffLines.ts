// Turns the text of a unified diff into rows for the diff view: the raw `diff --git`, `index`, `---`
// and `+++` lines are dropped, the extended header lines that mean something (mode changes, new and
// deleted files, renames, binary files) become plain sentences above the hunks, hunk headers stay
// (shown faint), and every line gets its old and new line number.

export type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx' | 'note'

export interface DiffRow {
  kind: DiffRowKind
  /** The line without its leading + - or space. Hunk headers and notes are kept whole. */
  text: string
  oldNo: number | null
  newNo: number | null
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

const note = (text: string): DiffRow => ({ kind: 'note', text, oldNo: null, newNo: null })

/** What one file's extended header lines say, before its first hunk. */
interface Header {
  oldMode: string | null
  newMode: string | null
  /** The mode of a new file (such as 100644), or null when the file is not new. */
  created: string | null
  deleted: boolean
  renameFrom: string | null
  renameTo: string | null
  copyFrom: string | null
  similarity: string | null
  binary: boolean
}

const emptyHeader = (): Header => ({
  oldMode: null,
  newMode: null,
  created: null,
  deleted: false,
  renameFrom: null,
  renameTo: null,
  copyFrom: null,
  similarity: null,
  binary: false
})

/** The sentences for a header. `hasHunk` tells a new file with lines from a new empty one. */
function headerNotes(h: Header, hasHunk: boolean): DiffRow[] {
  const notes: DiffRow[] = []
  if (h.created !== null) {
    const kind = h.created === '100755' ? ', executable' : h.created === '120000' ? ', symbolic link' : ''
    notes.push(note(`${hasHunk || h.binary ? 'New file' : 'New empty file'}${kind}`))
  }
  if (h.deleted) notes.push(note('Deleted file'))
  if (h.oldMode !== null && h.newMode !== null) notes.push(note(`Mode changed from ${h.oldMode} to ${h.newMode}`))
  const similar = h.similarity && h.similarity !== '100%' ? ` (${h.similarity} similar)` : ''
  if (h.renameFrom !== null) notes.push(note(`Renamed from ${h.renameFrom}${similar}`))
  if (h.copyFrom !== null) notes.push(note(`Copied from ${h.copyFrom}${similar}`))
  if (h.binary) notes.push(note('Binary file changed'))
  return notes
}

/** Returns the title to display for a diff. For renames, returns "old to new". */
export function diffTitle(path: string, text?: string): string {
  if (path.includes(' → ')) return path.replace(/\s*→\s*/g, ' to ')
  if (path.includes(' -> ')) return path.replace(/\s*->\s*/g, ' to ')
  if (path.includes(' \u2192 ')) return path.replace(/\s*\u2192\s*/g, ' to ')

  if (!text) return path

  let renameFrom: string | null = null
  let renameTo: string | null = null

  for (const line of text.split('\n')) {
    if (line.startsWith('@@ ') || line.startsWith('@@@ ')) break
    if (line.startsWith('rename from ')) {
      renameFrom = line.slice(12).trim()
    } else if (line.startsWith('rename to ')) {
      renameTo = line.slice(10).trim()
    }
  }

  if (renameFrom) {
    return `${renameFrom} to ${renameTo ?? path}`
  }

  return path
}

export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = []
  const lines = text.split('\n')
  // The text of a diff ends with a newline; that is not an empty last line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  let header = emptyHeader()
  // Where this file's notes go: right after the previous file's rows.
  let headerAt = 0
  let inHunk = false
  let combined = false
  let sawHunk = false
  let oldNo = 0
  let newNo = 0

  /** Puts the sentences of the header collected so far above the file's rows. */
  const flush = (hasHunk: boolean): void => {
    rows.splice(headerAt, 0, ...headerNotes(header, hasHunk))
    header = emptyHeader()
  }
  const finishFile = (): void => {
    if (!sawHunk) flush(false)
    sawHunk = false
    inHunk = false
    combined = false
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      finishFile()
      headerAt = rows.length
      continue
    }
    const hunk = HUNK.exec(line)
    const isCombined = !hunk && line.startsWith('@@@')
    if (hunk || isCombined) {
      if (!sawHunk) flush(true)
      sawHunk = true
      inHunk = true
      combined = isCombined
      if (hunk) {
        oldNo = Number(hunk[1])
        newNo = Number(hunk[2])
      }
      rows.push({ kind: 'hunk', text: line, oldNo: null, newNo: null })
      continue
    }
    if (!inHunk) {
      if (line.startsWith('old mode ')) header.oldMode = line.slice(9)
      else if (line.startsWith('new mode ')) header.newMode = line.slice(9)
      else if (line.startsWith('new file mode ')) header.created = line.slice(14).trim()
      else if (line.startsWith('deleted file mode ')) header.deleted = true
      else if (line.startsWith('rename from ')) header.renameFrom = line.slice(12)
      else if (line.startsWith('rename to ')) header.renameTo = line.slice(10)
      else if (line.startsWith('copy from ')) header.copyFrom = line.slice(10)
      else if (line.startsWith('similarity index ')) header.similarity = line.slice(17)
      else if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) header.binary = true
      continue
    }
    if (line.startsWith('\\')) {
      rows.push(note(line.slice(2)))
      continue
    }
    if (combined) {
      const marks = line.slice(0, 2)
      const kind: DiffRowKind = marks.includes('+') ? 'add' : marks.includes('-') ? 'del' : 'ctx'
      rows.push({ kind, text: line.slice(2), oldNo: null, newNo: null })
      continue
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null })
    } else {
      rows.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ })
    }
  }
  finishFile()
  return rows
}
