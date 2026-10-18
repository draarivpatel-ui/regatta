import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { bridge } from '../../lib/bridge'
import type { GitCommit } from '@shared/types'
import { ago } from '../../lib/format'
import { cleanError } from './errors'

interface GitHistoryProps {
  cwd: string | null
  /** Changes after each commit, so an open list reloads. */
  version: number
}

export function GitHistory({ cwd, version }: GitHistoryProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !cwd) return
    let wanted = true
    setLoading(true)
    bridge
      .invoke('git:log', cwd, 30)
      .then((log) => {
        if (!wanted) return
        setCommits(log)
        setError(null)
      })
      .catch((err) => {
        if (wanted) setError(cleanError(err, 'The history could not be read'))
      })
      .finally(() => {
        if (wanted) setLoading(false)
      })
    return () => {
      wanted = false
    }
  }, [open, cwd, version])

  const toggle = () => setOpen((o) => !o)

  return (
    <details data-testid="git-history" className="border-t border-line" open={open}>
      <summary
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-hover"
        onClick={(e) => {
          e.preventDefault()
          toggle()
        }}
      >
        <span className="text-[12.5px] font-medium">History</span>
        {open ? <ChevronUp size={14} className="text-muted" /> : <ChevronDown size={14} className="text-muted" />}
        <span className="ml-auto text-[11px] text-faint">{loading && commits.length === 0 ? 'Loading…' : `${commits.length} ${commits.length === 1 ? 'commit' : 'commits'}`}</span>
      </summary>
      {open && (
        <div className="px-3 pb-3 space-y-2 max-h-[300px] overflow-auto">
          {error ? (
            <div className="py-4 text-center text-st-failed">{error}</div>
          ) : loading && commits.length === 0 ? (
            <div className="text-center py-4 text-faint">Loading…</div>
          ) : commits.length === 0 ? (
            <div className="text-center py-4 text-faint">No commits</div>
          ) : (
            commits.map((commit) => (
              <div key={commit.hash} className="px-2 py-1.5 rounded-lg hover:bg-hover transition-colors">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-faint">{commit.hash.slice(0, 7)}</span>
                  <span className="flex-1 truncate text-[12.5px]">{commit.subject}</span>
                </div>
                <div className="flex items-center gap-2 ml-9 text-[11px] text-faint">
                  <span>{commit.author}</span>
                  <span>·</span>
                  <span>{ago(commit.at, Date.now())}</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </details>
  )
}