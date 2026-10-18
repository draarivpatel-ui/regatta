// The project tree: a filter box on top, then one row per file and folder.

import { Fragment } from 'react'
import { ChevronRight, FileText, Folder, FolderOpen, Search, X } from 'lucide-react'
import type { FileEntry } from '@shared/types'
import { cx, IconButton } from '../../components/ui'
import { ROOT, type FileTree } from './useFileTree'

/** How far down the filter looks before it stops. */
const MAX_DEPTH = 24

/** How deep rows are drawn. A symlink that loops back on itself cannot make this run away. */
const MAX_ROWS_DEPTH = 64

/** True when the entry matches the filter, or is a folder that leads to something that does. */
function hits(entry: FileEntry, query: string, tree: FileTree, depth = 0): boolean {
  if (entry.name.toLowerCase().includes(query)) return true
  if (entry.kind !== 'dir' || depth >= MAX_DEPTH) return false
  return (tree.entries[entry.path] ?? []).some((child) => hits(child, query, tree, depth + 1))
}

/** The entries of one folder the user should see right now. */
function visible(tree: FileTree, dir: string, showAll: boolean): FileEntry[] {
  const list = tree.entries[dir] ?? []
  const query = tree.filter.trim().toLowerCase()
  if (!query || showAll) return list
  return list.filter((entry) => hits(entry, query, tree))
}

function sizeLabel(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Row({ entry, depth, open, loading, onOpen }: {
  entry: FileEntry
  depth: number
  open: boolean
  loading: boolean
  onOpen: (entry: FileEntry) => void
}): React.JSX.Element {
  const isDir = entry.kind === 'dir'
  return (
    <button
      type="button"
      data-testid="file-row"
      data-path={entry.path}
      data-kind={entry.kind}
      title={entry.path}
      onClick={() => onOpen(entry)}
      className="group flex h-[22px] w-full items-center gap-1.5 pr-2 text-left text-[12.5px] text-fg transition-colors duration-150 hover:bg-hover"
      style={{ paddingLeft: 4 + depth * 12 }}
    >
      {isDir ? (
        <ChevronRight size={13} className={cx('shrink-0 text-faint transition-transform duration-150', open && 'rotate-90')} />
      ) : (
        <span className="w-[13px] shrink-0" />
      )}
      {isDir ? (
        open ? (
          <FolderOpen size={13} className="shrink-0 text-accent/80" />
        ) : (
          <Folder size={13} className="shrink-0 text-accent/60" />
        )
      ) : (
        <FileText size={13} className="shrink-0 text-faint" />
      )}
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-faint">{loading ? 'loading' : sizeLabel(entry.size)}</span>
    </button>
  )
}

interface RowsProps {
  dir: string
  depth: number
  /** True when this folder already matched the filter, so everything under it shows. */
  showAll: boolean
  tree: FileTree
  onOpen: (entry: FileEntry) => void
}

function Rows({ dir, depth, showAll, tree, onOpen }: RowsProps): React.JSX.Element | null {
  const list = tree.entries[dir]
  if (!list || depth > MAX_ROWS_DEPTH) return null
  const query = tree.filter.trim().toLowerCase()
  const filtering = query.length > 0
  return (
    <>
      {visible(tree, dir, showAll).map((entry) => {
        const open = entry.kind === 'dir' && (tree.isOpen(entry.path) || filtering)
        const childAll = showAll || (filtering && entry.name.toLowerCase().includes(query))
        return (
          <Fragment key={entry.path}>
            <Row
              entry={entry}
              depth={depth}
              open={open}
              loading={Boolean(tree.loading[entry.path])}
              onOpen={onOpen}
            />
            {open && tree.entries[entry.path] && (
              <Rows dir={entry.path} depth={depth + 1} showAll={childAll} tree={tree} onOpen={onOpen} />
            )}
          </Fragment>
        )
      })}
    </>
  )
}

export function TreeView({ tree, onOpen }: { tree: FileTree; onOpen: (entry: FileEntry) => void }): React.JSX.Element {
  const root = tree.entries[ROOT]
  const filtering = tree.filter.trim().length > 0
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-line px-2.5">
        <Search size={13} className="shrink-0 text-faint" />
        <input
          data-testid="files-filter"
          type="text"
          value={tree.filter}
          onChange={(e) => tree.setFilter(e.target.value)}
          placeholder="Filter files"
          aria-label="Filter files"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
        />
        {tree.filter !== '' && (
          <IconButton onClick={() => tree.setFilter('')} aria-label="Clear filter" title="Clear filter">
            <X size={12} />
          </IconButton>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="files-tree">
        {root === undefined && <p className="px-3 py-4 text-[12px] text-faint">Loading the project...</p>}
        {root !== undefined && root.length === 0 && !filtering && (
          <p className="px-3 py-4 text-[12px] text-faint">This folder is empty.</p>
        )}
        <Rows dir={ROOT} depth={0} showAll={false} tree={tree} onOpen={onOpen} />
        {filtering && root !== undefined && visible(tree, ROOT, false).length === 0 && (
          <p className="px-3 py-4 text-[12px] text-faint">Nothing here matches "{tree.filter.trim()}".</p>
        )}
        {tree.limited && (
          <p className="px-3 py-2 text-[11px] leading-relaxed text-faint">
            Stopped after {Object.keys(tree.entries).length} folders. Clear the filter to browse by hand.
          </p>
        )}
      </div>
    </div>
  )
}