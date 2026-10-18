// Board store (main): the two things the board keeps of its own, archived ids and send-back notes,
// saved in <dataDir>/board.json. Everything else on the board is derived from the engines' state.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardData } from '../shared/board'

export interface BoardStoreDeps {
  /** App data folder: <dataDir>/board.json. */
  dataDir: string
  emit: (data: BoardData) => void
  now?: () => number
}

/** The card ids archived (hidden) and the send-back notes, by card id. Nothing else is stored. */
export class BoardStore {
  private data: BoardData

  constructor(private readonly deps: BoardStoreDeps) {
    this.data = loadFromDisk(deps.dataDir)
  }

  list(): BoardData {
    return clone(this.data)
  }

  /** Hides a card from the board. Keeps its send-back note, so archiving is not destructive. */
  archive(id: string): BoardData {
    if (!id) return this.list()
    if (this.data.archived.includes(id)) return this.list()
    this.data = { ...this.data, archived: [...this.data.archived, id] }
    this.persist()
    return this.list()
  }

  /** Puts an archived card back on the board. */
  unarchive(id: string): BoardData {
    if (!this.data.archived.includes(id)) return this.list()
    this.data = { ...this.data, archived: this.data.archived.filter((x) => x !== id) }
    this.persist()
    return this.list()
  }

  /** Remembers a note for a card. A "to review" task with a note reads as waiting again. */
  sendBack(id: string, note: string): BoardData {
    if (!id) return this.list()
    const trimmed = (note ?? '').trim()
    const notes = { ...this.data.notes }
    if (!trimmed) delete notes[id]
    else notes[id] = trimmed
    this.data = { ...this.data, notes }
    this.persist()
    return this.list()
  }

  private persist(): void {
    saveToDisk(this.deps.dataDir, this.data)
    this.deps.emit(this.list())
  }
}

function loadFromDisk(dataDir: string): BoardData {
  const file = join(dataDir, 'board.json')
  if (!existsSync(file)) return { archived: [], notes: {} }
  try {
    return sanitize(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { archived: [], notes: {} }
  }
}

function saveToDisk(dataDir: string, data: BoardData): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    const file = join(dataDir, 'board.json')
    const tmp = join(dataDir, `board.json.tmp-${process.pid}`)
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // The board still works while the app is open.
  }
}

/** Drops anything that is not a string id or a string note, so a half-written file cannot crash the board. */
export function sanitize(raw: unknown): BoardData {
  if (typeof raw !== 'object' || raw === null) return { archived: [], notes: {} }
  const r = raw as Record<string, unknown>
  const archived = Array.isArray(r['archived'])
    ? [...new Set((r['archived'] as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0))]
    : []
  const notes: Record<string, string> = {}
  const rawNotes = r['notes']
  if (typeof rawNotes === 'object' && rawNotes !== null) {
    for (const [key, value] of Object.entries(rawNotes as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) notes[key] = value.trim()
    }
  }
  return { archived, notes }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
