import { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, RefreshCw, AlertTriangle } from 'lucide-react'
import { useSessions } from '../store/sessions'
import { bridge } from '../lib/bridge'
import type { GitOverview, GitFileChange, GitDiff } from '@shared/types'
import { Button, IconButton, cx } from '../components/ui'
import { GitFileRow } from './git/GitFileRow'
import { GitDiffView } from './git/GitDiffView'
import { GitCommitBox } from './git/GitCommitBox'
import { GitHistory } from './git/GitHistory'
import { GitWorktrees } from './git/GitWorktrees'
import { RequestGate } from './git/requestGate'
import { RefreshLoop } from './git/refreshLoop'
import { cleanError } from './git/errors'

const STATUS_ORDER = ['U', 'M', 'A', 'D', 'R', 'C', '?']

const isStagedLetter = (letter: string): boolean => letter !== ' ' && letter !== '?'

function sortFiles(files: GitFileChange[], letterOf: (f: GitFileChange) => string): GitFileChange[] {
  return [...files].sort((a, b) => {
    const aIdx = STATUS_ORDER.indexOf(letterOf(a))
    const bIdx = STATUS_ORDER.indexOf(letterOf(b))
    if (aIdx !== bIdx) return aIdx - bIdx
    return a.path.localeCompare(b.path)
  })
}

/** An overview together with the folder it was read for. */
interface Shown {
  folder: string
  data: GitOverview | null
  /** The commit HEAD is at, only read while HEAD is detached. */
  head: string | null
  /** When this overview was read, so a failed refresh can say when the last good status came from. */
  at: number
}

interface ShownDiff {
  folder: string
  data: GitDiff
}

function busyBannerText(busy: string): string {
  if (busy === 'unknown') return 'Regatta could not read the repository state. Check it in a terminal.'
  return `A ${busy} is in progress. Finish it in a terminal.`
}

export function GitPanel(): React.JSX.Element {
  const focusedId = useSessions((s) => s.focusedId)
  const sessions = useSessions((s) => s.sessions)
  const focusedCwd = (focusedId ? sessions[focusedId]?.cwd : null) ?? null
  const workspace = useSessions((s) => s.workspace)
  const ready = useSessions((s) => s.ready)
  const projectCwd = workspace?.root ?? null

  // "This pane" is offered only while the focused pane runs in a different folder (a worktree).
  const paneCwd = focusedCwd && projectCwd && focusedCwd !== projectCwd ? focusedCwd : null
  const [view, setView] = useState<'project' | 'pane'>('project')
  const folder = view === 'pane' && paneCwd ? paneCwd : projectCwd
  const folderRef = useRef<string | null>(folder)
  folderRef.current = folder

  const [shown, setShown] = useState<Shown | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [diff, setDiff] = useState<ShownDiff | null>(null)
  const [commitVersion, setCommitVersion] = useState(0)
  const overviewGate = useRef(new RequestGate())
  const diffGate = useRef(new RequestGate())
  const mutating = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const savedScroll = useRef(0)

  // What is on screen belongs to the active folder, or it is not shown and nothing can be changed.
  const current = shown && shown.folder === folder ? shown : null
  const overview = current?.data ?? null
  const shownDiff = diff && diff.folder === folder ? diff.data : null

  const load = useCallback(async () => {
    const target = folder
    if (!target) return
    const ticket = overviewGate.current.begin(target)
    setLoading(true)
    try {
      const data = await bridge.invoke('git:overview', target)
      let head: string | null = null
      if (data?.detached) {
        try {
          head = (await bridge.invoke('git:log', target, 1))[0]?.hash ?? null
        } catch {
          head = null
        }
      }
      if (!overviewGate.current.isCurrent(ticket, folderRef.current)) return
      setShown({ folder: target, data, head, at: Date.now() })
      setLoadError(null)
    } catch (err) {
      if (!overviewGate.current.isCurrent(ticket, folderRef.current)) return
      setLoadError(cleanError(err, 'Could not read this folder'))
    } finally {
      if (overviewGate.current.isCurrent(ticket, folderRef.current)) setLoading(false)
    }
  }, [folder])

  // A new folder starts clean: no old lists, no open diff, no old errors.
  useEffect(() => {
    setShown(null)
    setDiff(null)
    setLoadError(null)
    setActionError(null)
    savedScroll.current = 0
  }, [folder])

  // One refresh at a time; the next timed one is scheduled when the current one is done, so a slow
  // answer is never overtaken by the next request. Focus and the refresh button just ask for one.
  const loopRef = useRef<RefreshLoop | null>(null)
  useEffect(() => {
    const loop = new RefreshLoop(load, 3000)
    loopRef.current = loop
    loop.start()
    const onFocus = (): void => loop.trigger()
    window.addEventListener('focus', onFocus)
    return () => {
      loop.stop()
      if (loopRef.current === loop) loopRef.current = null
      window.removeEventListener('focus', onFocus)
    }
  }, [load])
  const refreshNow = useCallback(() => loopRef.current?.trigger(), [])

  // Coming back from a diff, the lists were hidden (not unmounted); put the scroll position back.
  useEffect(() => {
    if (!shownDiff && bodyRef.current) bodyRef.current.scrollTop = savedScroll.current
  }, [shownDiff])

  const mutate = useCallback(
    async (kind: 'stage' | 'unstage', paths: string[]) => {
      if (!current || current.folder !== folderRef.current || paths.length === 0 || mutating.current) return
      const target = current.folder
      mutating.current = true
      setActionError(null)
      const ticket = overviewGate.current.begin(target)
      try {
        const data = await bridge.invoke(kind === 'stage' ? 'git:stage' : 'git:unstage', target, paths)
        if (overviewGate.current.isCurrent(ticket, folderRef.current)) {
          setShown((prev) => ({ folder: target, data, head: prev && prev.folder === target ? prev.head : null, at: Date.now() }))
          setLoadError(null)
        }
      } catch (err) {
        if (folderRef.current === target) setActionError(cleanError(err, `Could not ${kind} the file`))
        refreshNow()
      } finally {
        mutating.current = false
      }
    },
    [current, refreshNow]
  )

  const handleStage = useCallback((path: string) => void mutate('stage', [path]), [mutate])
  const handleUnstage = useCallback((path: string) => void mutate('unstage', [path]), [mutate])

  const stagedFiles = overview?.files.filter((f) => isStagedLetter(f.staged)) ?? []
  // Everything with a working-tree side: modified, deleted, conflicted, and untracked ('?').
  const changedFiles = overview?.files.filter((f) => f.unstaged !== ' ') ?? []

  // A post-index-change hook would run on every stage or unstage, which the panel does not do.
  const indexHook = overview?.hooks?.some((h) => h.startsWith('post-index-change')) ?? false

  const handleStageAll = useCallback(() => void mutate('stage', changedFiles.map((f) => f.path)), [mutate, changedFiles])
  const handleUnstageAll = useCallback(() => void mutate('unstage', stagedFiles.map((f) => f.path)), [mutate, stagedFiles])

  const openDiff = useCallback(
    async (file: GitFileChange, isStaged: boolean) => {
      if (!current || current.folder !== folderRef.current) return
      const target = current.folder
      const ticket = diffGate.current.begin(target)
      setActionError(null)
      try {
        const data = await bridge.invoke('git:diff', target, file.path, isStaged)
        if (!diffGate.current.isCurrent(ticket, folderRef.current)) return
        savedScroll.current = bodyRef.current?.scrollTop ?? 0
        setDiff({ folder: target, data })
      } catch (err) {
        if (folderRef.current === target) setActionError(cleanError(err, 'Could not show this file'))
      }
    },
    [current]
  )

  const handleCommitted = useCallback(() => {
    setCommitVersion((v) => v + 1)
    refreshNow()
  }, [refreshNow])

  if (!ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <GitBranch size={24} className="mb-2 animate-pulse text-faint" />
        <p className="text-[12.5px] text-muted">Loading…</p>
      </div>
    )
  }
  if (!folder) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <GitBranch size={24} className="mb-2 text-faint" />
        <p className="text-[12.5px] text-muted">This folder is not a git repository.</p>
      </div>
    )
  }

  const branchDisplay = !overview
    ? 'Git'
    : overview.detached
      ? current?.head
        ? `Detached at ${current.head.slice(0, 7)}`
        : 'Detached HEAD'
      : (overview.branch ?? 'No branch')
  const upstreamInfo = overview?.upstream ? `${overview.ahead} ahead, ${overview.behind} behind` : null
  const isPaneView = view === 'pane' && paneCwd !== null

  return (
    <div className="flex h-full flex-col" data-testid="git-panel">
      <header className="flex h-[38px] shrink-0 items-center gap-2 border-b border-line px-3">
        <GitBranch size={16} className="shrink-0 text-accent" />
        <span className="flex-1 truncate font-mono text-[12.5px] font-medium" data-testid="git-branch">
          {branchDisplay}
        </span>
        {upstreamInfo && <span className="shrink-0 text-[11px] text-faint">{upstreamInfo}</span>}
        <div className="flex items-center gap-1">
          {paneCwd && (
            <div className="flex rounded-md border border-line bg-panel/50 p-0.5" role="group" aria-label="Git view">
              <button
                type="button"
                onClick={() => setView('project')}
                className={cx(
                  'rounded-[4px] px-2 py-1 text-[11.5px] font-medium transition-colors',
                  !isPaneView ? 'bg-hover text-fg' : 'text-muted hover:text-fg'
                )}
                data-testid="git-view-project"
              >
                Project
              </button>
              <button
                type="button"
                onClick={() => setView('pane')}
                className={cx(
                  'rounded-[4px] px-2 py-1 text-[11.5px] font-medium transition-colors',
                  isPaneView ? 'bg-hover text-fg' : 'text-muted hover:text-fg'
                )}
                data-testid="git-view-pane"
              >
                This pane
              </button>
            </div>
          )}
          <IconButton onClick={refreshNow} aria-label="Refresh" title="Refresh" data-testid="git-refresh">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </IconButton>
        </div>
      </header>

      {overview?.busy && (
        <div
          data-testid="git-busy"
          className="flex shrink-0 items-center gap-2 border-b border-st-waiting/30 bg-st-waiting/10 px-3 py-2 text-[12px] text-st-waiting"
        >
          <AlertTriangle size={14} className="shrink-0" />
          <span>{busyBannerText(overview.busy)}</span>
        </div>
      )}

      {indexHook && (
        <div
          data-testid="git-index-hook-notice"
          className="shrink-0 border-b border-st-waiting/30 bg-st-waiting/10 px-3 py-2 text-[12px] text-st-waiting"
        >
          This repository has a post-index-change git hook. The Git panel does not run hooks yet, so stage from a terminal.
        </div>
      )}

      {actionError && (
        <div
          data-testid="git-action-error"
          className="shrink-0 border-b border-st-failed/30 bg-st-failed/10 px-3 py-2 text-[12px] text-st-failed"
        >
          {actionError}
        </div>
      )}

      {shownDiff && <GitDiffView diff={shownDiff} onBack={() => setDiff(null)} />}

      {/* Hidden, not unmounted, while a diff is open: the typed message and a commit in flight stay. */}
      <div ref={bodyRef} className={cx('min-h-0 flex-1 overflow-auto', shownDiff && 'hidden')}>
        {!current && !loadError && (
          <div className="flex h-full items-center justify-center text-faint">Loading…</div>
        )}
        {!current && loadError && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" data-testid="git-load-error">
            <p className="text-[12.5px] text-st-failed">{loadError}</p>
            <Button size="sm" onClick={refreshNow}>
              Try again
            </Button>
          </div>
        )}
        {current && loadError && (
          <div
            data-testid="git-refresh-error"
            className="shrink-0 border-b border-st-failed/30 bg-st-failed/10 px-3 py-2 text-[12px] text-st-failed"
          >
            <div>{loadError}</div>
            <div className="mt-0.5 text-[11px] text-st-failed/80">
              Showing the last good status from {new Date(current.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
            </div>
          </div>
        )}
        {current && !overview && (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <GitBranch size={24} className="mb-2 text-faint" />
            <p className="text-[12.5px] text-muted">This folder is not a git repository.</p>
          </div>
        )}
        {overview && (
          <div className="flex min-h-full flex-col" data-stale={loadError ? 'true' : undefined}>
            {stagedFiles.length === 0 && changedFiles.length === 0 && (
              <div className="flex flex-col items-center justify-center px-6 py-8 text-center">
                <GitBranch size={24} className="mb-2 text-faint" />
                <p className="text-[12.5px] text-muted">No changes.</p>
              </div>
            )}
            {stagedFiles.length > 0 && (
              <div className="shrink-0" data-testid="git-staged">
                <div className="flex items-center justify-between border-b border-line px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-faint">Staged</span>
                    <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                      {stagedFiles.length}
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={handleUnstageAll} disabled={indexHook} data-testid="git-unstage-all">
                    Unstage all
                  </Button>
                </div>
                <div className="max-h-[220px] overflow-auto">
                  {sortFiles(stagedFiles, (f) => f.staged).map((file) => (
                    <GitFileRow
                      key={`s:${file.path}`}
                      file={file}
                      isStaged={true}
                      indexLocked={indexHook}
                      onStage={handleStage}
                      onUnstage={handleUnstage}
                      onClick={() => void openDiff(file, true)}
                      testId={`git-file-${file.path}`}
                    />
                  ))}
                </div>
              </div>
            )}
            {changedFiles.length > 0 && (
              <div className="shrink-0" data-testid="git-changes">
                <div className="flex items-center justify-between border-b border-line px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-faint">Changes</span>
                    <span className="rounded bg-st-working/20 px-1.5 py-0.5 text-[10px] font-medium text-st-working">
                      {changedFiles.length}
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={handleStageAll} disabled={indexHook} data-testid="git-stage-all">
                    Stage all
                  </Button>
                </div>
                <div className="max-h-[260px] overflow-auto">
                  {sortFiles(changedFiles, (f) => f.unstaged).map((file) => (
                    <GitFileRow
                      key={`c:${file.path}`}
                      file={file}
                      isStaged={false}
                      indexLocked={indexHook}
                      onStage={handleStage}
                      onUnstage={handleUnstage}
                      onClick={() => void openDiff(file, false)}
                      testId={`git-file-${file.path}`}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="flex-1" />
            <GitCommitBox key={folder} folder={folder} overview={overview} onCommitted={handleCommitted} />
            <GitHistory key={`h:${folder}`} cwd={folder} version={commitVersion} />
            <GitWorktrees key={`w:${folder}`} cwd={folder} />
          </div>
        )}
      </div>
    </div>
  )
}
