// Tree state for the Files panel: lazy folder loading, what is open, and the filter.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { bridge } from '../../lib/bridge'

/** How many folders the filter walks into before it stops looking. */
const MAX_FILTER_DIRS = 500

/** The first folder in the tree. */
export const ROOT = ''

/** Electron wraps errors from main; the message the panel shows is the part after the wrapper. */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim()
}

export interface FileTree {
  /** Folder path to its entries, "" for the root. */
  entries: Record<string, FileEntry[]>
  open: Record<string, true>
  loading: Record<string, true>
  filter: string
  /** True when the filter walk hit its limit, so the view is not the whole project. */
  limited: boolean
  error: string | null
  setFilter: (text: string) => void
  isOpen: (path: string) => boolean
  /** Opens a folder, loading it the first time; closes it when it is already open. */
  toggle: (entry: FileEntry) => void
}

export function useFileTree(): FileTree {
  const [entries, setEntries] = useState<Record<string, FileEntry[]>>({})
  const [open, setOpen] = useState<Record<string, true>>({})
  const [loading, setLoading] = useState<Record<string, true>>({})
  const [filter, setFilter] = useState('')
  const [limited, setLimited] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cache = useRef(new Map<string, FileEntry[]>())
  const loaded = useRef(false)

  /** Reads one folder. Returns null when main refused it, so callers can stay quiet. */
  const fetchDir = useCallback(async (dir: string): Promise<FileEntry[] | null> => {
    const hit = cache.current.get(dir)
    if (hit) return hit
    setError(null)
    try {
      const list = await bridge.invoke('files:list', dir)
      cache.current.set(dir, list)
      return list
    } catch (err) {
      cache.current.set(dir, [])
      setError(errorMessage(err))
      return null
    }
  }, [])

  const publish = useCallback((batch: Record<string, FileEntry[]>) => {
    setEntries((prev) => ({ ...prev, ...batch }))
  }, [])

  // The project root on mount.
  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void fetchDir(ROOT).then((list) => {
      if (list) publish({ [ROOT]: list })
    })
  }, [fetchDir, publish])

  // While the filter is on, walk the whole project so matches under closed folders show up.
  useEffect(() => {
    if (!filter.trim()) {
      setLimited(false)
      return
    }
    let cancelled = false
    let visited = 0
    let pending: Record<string, FileEntry[]> = {}
    const flush = (): void => {
      if (cancelled || Object.keys(pending).length === 0) return
      const batch = pending
      pending = {}
      publish(batch)
    }
    const visit = async (dir: string): Promise<void> => {
      if (cancelled) return
      if (visited >= MAX_FILTER_DIRS) {
        setLimited(true)
        return
      }
      visited += 1
      const list = await fetchDir(dir)
      if (cancelled) return
      if (!list) return
      if (cache.current.get(dir) !== list) pending[dir] = list
      if (visited % 64 === 0) flush()
      for (const entry of list) if (entry.kind === 'dir') await visit(entry.path)
    }
    void visit(ROOT).then(flush)
    return () => {
      cancelled = true
    }
  }, [filter, fetchDir, publish])

  const toggle = useCallback(
    (entry: FileEntry) => {
      if (entry.kind !== 'dir') return
      const path = entry.path
      if (open[path]) {
        setOpen((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })
        return
      }
      setOpen((prev) => ({ ...prev, [path]: true }))
      if (cache.current.has(path)) return
      setLoading((prev) => ({ ...prev, [path]: true }))
      void fetchDir(path).then((list) => {
        setLoading((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })
        if (list) publish({ [path]: list })
      })
    },
    [open, fetchDir, publish]
  )

  return useMemo(
    () => ({
      entries,
      open,
      loading,
      filter,
      limited,
      error,
      setFilter,
      isOpen: (path: string) => Boolean(open[path]),
      toggle
    }),
    [entries, open, loading, filter, limited, error, toggle]
  )
}