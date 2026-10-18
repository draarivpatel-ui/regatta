// Settings > Storage: what Regatta keeps on disk, leftover worktrees nothing uses, and Regatta's trash.

import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import type { EmptyTrashEntryReport, StorageReport } from '@shared/types'
import { bridge } from '../../lib/bridge'
import { useNow } from '../../lib/useNow'
import { Button, IconButton } from '../../components/ui'
import { SectionTitle } from './common'
import { LeftoverRow } from './storage/LeftoverRow'
import { RemoveConfirm } from './storage/RemoveConfirm'
import { TrashBlock } from './storage/TrashBlock'
import { cleanError, clock, removalResult, storageBytesLabel } from './storage/labels'

export function StorageSection(): React.JSX.Element {
  const now = useNow()
  const [report, setReport] = useState<StorageReport | null>(null)
  const [scanning, setScanning] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [showConfirm, setShowConfirm] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const [showEmptyConfirm, setShowEmptyConfirm] = useState(false)
  const [emptying, setEmptying] = useState(false)
  const [emptyError, setEmptyError] = useState<string | null>(null)
  const [emptyOutcomes, setEmptyOutcomes] = useState<EmptyTrashEntryReport[] | null>(null)

  // Keep only selections that are still listed and still safe to move to trash.
  const pruneSelection = useCallback((next: StorageReport) => {
    setSelected((prev) => {
      const keep = new Set(next.leftovers.filter((l) => l.removable).map((l) => l.path))
      const filtered = new Set<string>()
      for (const path of prev) if (keep.has(path)) filtered.add(path)
      return filtered
    })
  }, [])

  const load = useCallback(() => {
    setScanning(true)
    setResult(null)
    setEmptyOutcomes(null)
    void bridge
      .invoke('storage:scan')
      .then((next) => {
        setReport(next)
        setScanError(null)
        pruneSelection(next)
      })
      .catch((err) => setScanError(cleanError(err)))
      .finally(() => setScanning(false))
  }, [pruneSelection])

  useEffect(() => {
    load()
  }, [load])

  const leftovers = report?.leftovers ?? []
  const trash = report?.trash ?? []

  const reveal = (path: string): void => {
    void bridge.invoke('storage:reveal', path).catch(() => undefined)
  }

  const toggle = (path: string, next: boolean): void => {
    setResult(null)
    setSelected((prev) => {
      const copy = new Set(prev)
      if (next) copy.add(path)
      else copy.delete(path)
      return copy
    })
  }

  const removable = leftovers.filter((l) => l.removable)
  const allSelected = removable.length > 0 && removable.every((l) => selected.has(l.path))
  const toggleAll = (): void => {
    setResult(null)
    setSelected(allSelected ? new Set() : new Set(removable.map((l) => l.path)))
  }

  const openConfirm = (): void => {
    setRemoveError(null)
    setShowConfirm(true)
  }

  const doRemove = (): void => {
    const paths = removable.filter((l) => selected.has(l.path)).map((l) => l.path)
    if (paths.length === 0) return
    setRemoving(true)
    setRemoveError(null)
    void bridge
      .invoke('storage:removeWorktrees', paths)
      .then((next) => {
        const listed = new Set(next.leftovers.map((l) => l.path))
        const kept = paths.filter((p) => listed.has(p)).length
        setReport(next)
        setSelected(new Set())
        setShowConfirm(false)
        setResult(removalResult(paths.length - kept, kept))
      })
      .catch((err) => setRemoveError(cleanError(err)))
      .finally(() => setRemoving(false))
  }

  const openEmptyConfirm = (): void => {
    setEmptyError(null)
    setShowEmptyConfirm(true)
  }

  const doEmptyTrash = (): void => {
    setEmptying(true)
    setEmptyError(null)
    void bridge
      .invoke('storage:emptyTrash')
      .then((res) => {
        setReport(res.report)
        setShowEmptyConfirm(false)
        setEmptyOutcomes(res.outcomes)
      })
      .catch((err) => setEmptyError(cleanError(err)))
      .finally(() => setEmptying(false))
  }

  return (
    <div className="max-w-[620px]">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <SectionTitle>Storage</SectionTitle>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">What Regatta keeps on this computer.</p>
        </div>
        <Button variant="subtle" size="sm" data-testid="storage-scan" onClick={load} disabled={scanning}>
          <RefreshCw size={13} className={scanning ? 'animate-spin' : undefined} />
          {scanning ? 'Scanning' : 'Scan again'}
        </Button>
      </div>

      <div className="mt-3 space-y-1.5" data-testid="storage-items">
        {(report?.items ?? []).map((item) => (
          <div key={item.id} data-testid={`storage-item-${item.id}`} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[12.5px]">{item.label}</span>
            <span className="shrink-0 text-[12px] tabular-nums text-muted">{storageBytesLabel(item.bytes)}</span>
            <IconButton aria-label={`Show ${item.label} in Finder`} data-testid={`storage-reveal-${item.id}`} onClick={() => reveal(item.path)}>
              <FolderOpen size={13} />
            </IconButton>
          </div>
        ))}
      </div>

      {report && <p className="mt-3 text-[11.5px] text-faint">Scanned {clock(report.scannedAt)}</p>}

      <div className="mt-5">
        <h4 className="text-[13px] font-medium">Worktrees nothing uses</h4>

        {scanError !== null && !scanning && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-st-failed" data-testid="storage-scan-error">
            Could not look for leftover worktrees: {scanError}
          </p>
        )}

        {scanError === null && report !== null && leftovers.length === 0 && !scanning && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted" data-testid="storage-empty">
            No leftover worktrees.
          </p>
        )}

        {leftovers.length > 0 && (
          <>
            <div className="mt-2 space-y-1.5" data-testid="storage-leftovers">
              {leftovers.map((leftover, index) => (
                <LeftoverRow
                  key={leftover.path}
                  leftover={leftover}
                  index={index}
                  now={now}
                  checked={selected.has(leftover.path)}
                  disabled={removing}
                  onToggle={(next) => toggle(leftover.path, next)}
                  onReveal={() => reveal(leftover.path)}
                />
              ))}
            </div>

            <div className="mt-2.5 flex items-center gap-1.5">
              <Button variant="ghost" size="sm" data-testid="storage-select-all" onClick={toggleAll} disabled={removable.length === 0 || removing}>
                {allSelected ? 'Clear' : 'Select all'}
              </Button>
              <Button
                variant="subtle"
                size="sm"
                data-testid="storage-remove"
                onClick={openConfirm}
                disabled={selected.size === 0 || removing}
              >
                Move to trash
              </Button>
            </div>

            <p className="mt-2 text-[11.5px] leading-relaxed text-faint" data-testid="storage-hint">
              Selected worktrees move into Regatta&apos;s trash with their files and commits kept. Branches stay until you empty the trash.
            </p>

            {showConfirm && (
              <RemoveConfirm
                count={selected.size}
                busy={removing}
                error={removeError}
                onConfirm={doRemove}
                onCancel={() => setShowConfirm(false)}
              />
            )}
          </>
        )}

        {result && (
          <p className="mt-1.5 text-[12px] text-muted" data-testid="storage-result">
            {result}
          </p>
        )}
      </div>

      <TrashBlock
        trash={trash}
        now={now}
        scanning={scanning}
        emptying={emptying}
        showConfirm={showEmptyConfirm}
        emptyError={emptyError}
        outcomes={emptyOutcomes}
        onOpenConfirm={openEmptyConfirm}
        onCancelConfirm={() => setShowEmptyConfirm(false)}
        onConfirmEmpty={doEmptyTrash}
        onReveal={reveal}
      />
    </div>
  )
}
