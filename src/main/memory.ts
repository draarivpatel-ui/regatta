// Measures memory used by each session's process tree.

import { execFile } from 'node:child_process'
import type { MemorySample } from '../shared/types'

export interface PsRow {
  pid: number
  ppid: number
  rssKb: number
}

export interface MemoryMonitorDeps {
  /** Live sessions and their root process ids. */
  sessions: () => { id: string; pid: number | null }[]
  emit: (samples: MemorySample[]) => void
  intervalMs?: number
}

function isInt(n: number): boolean {
  return Number.isFinite(n) && Math.floor(n) === n
}

/** Parses `ps -axo pid=,ppid=,rss=` output into pid, ppid and rssKb rows. Ignores bad lines. */
export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length !== 3) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const rssKb = Number(parts[2])
    if (!isInt(pid) || !isInt(ppid) || !isInt(rssKb)) continue
    if (pid < 0 || ppid < 0 || rssKb < 0) continue
    rows.push({ pid, ppid, rssKb })
  }
  return rows
}

/** Sums the root process and all its descendants, in bytes. Handles cycles safely. */
export function treeRssBytes(rows: PsRow[], rootPid: number): number {
  const rssByPid = new Map<number, number>()
  const children = new Map<number, number[]>()
  for (const row of rows) {
    rssByPid.set(row.pid, row.rssKb)
    const list = children.get(row.ppid)
    if (list) list.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  let totalKb = 0
  const visited = new Set<number>()
  const stack: number[] = [rootPid]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    if (visited.has(pid)) continue
    visited.add(pid)
    const rss = rssByPid.get(pid)
    if (rss !== undefined) totalKb += rss
    const kids = children.get(pid)
    if (kids) {
      for (const kid of kids) {
        if (!visited.has(kid)) stack.push(kid)
      }
    }
  }
  return totalKb * 1024
}

function runPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

const FIRST_SAMPLE_MS = 1500
const DEFAULT_INTERVAL_MS = 10000

export class MemoryMonitor {
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: MemoryMonitorDeps) {}

  start(): void {
    this.stop()
    if (process.platform === 'win32') return
    const intervalMs = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS
    this.timer = setTimeout(() => {
      void this.sample()
      this.timer = setInterval(() => {
        void this.sample()
      }, intervalMs)
    }, FIRST_SAMPLE_MS)
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async sample(): Promise<void> {
    try {
      const live = this.deps.sessions().filter((s): s is { id: string; pid: number } => s.pid !== null)
      if (live.length === 0) {
        this.deps.emit([])
        return
      }
      const text = await runPs()
      const rows = parsePs(text)
      const samples: MemorySample[] = live.map((s) => ({ id: s.id, rssBytes: treeRssBytes(rows, s.pid) }))
      this.deps.emit(samples)
    } catch {
      // The timer never throws. A failed sample is skipped silently.
    }
  }
}
