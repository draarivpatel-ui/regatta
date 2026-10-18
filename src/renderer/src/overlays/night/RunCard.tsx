// The selected run of a night: what it did, how it was judged, and what can be done with it.

import { useState, type ReactNode } from 'react'
import { Check, FolderOpen, GitBranch, Info, Minus, X } from 'lucide-react'
import type { CheckResult, CheckSpec } from '@shared/heats'
import type { Night, NightTaskRun } from '@shared/nightwatch'
import { bridge } from '../../lib/bridge'
import { AgentBadge } from '../../components/marks'
import { Button, cx } from '../../components/ui'
import { useNight } from '../../store/night'
import { useSessions } from '../../store/sessions'
import { useUi } from '../../store/ui'
import { Ask } from './Ask'
import { CopyButton } from './CopyButton'
import {
  agentName,
  branchLikelyThere,
  compactTokens,
  diffText,
  folderForRun,
  formatCheckTime,
  gitCommandIn,
  GATE_LABEL,
  hasLeftovers,
  lastLines,
  plural,
  RUN_LOOK,
  testTotals,
  worktreeLikelyThere
} from './helpers'
import { LookPill } from './marks'
import { NoteText } from './NoteText'

const MERGE_ASK = "Merge this run? Its commits join the branch checked out in your folder, then the run's worktree and branch are cleaned up."
const DISCARD_ASK = 'Discard this run? Its worktree is removed only when nothing in it is unsaved; a copy of its commits stays in the repository.'

function Section({ title, testId, children }: { title: string; testId?: string; children: ReactNode }): React.JSX.Element {
  return (
    <div data-testid={testId} className="mt-4">
      <h4 className="text-[11.5px] font-medium text-faint">{title}</h4>
      <div className="mt-1.5 space-y-1.5">{children}</div>
    </div>
  )
}

function CheckLine({ spec, result }: { spec: CheckSpec; result: CheckResult | undefined }): React.JSX.Element {
  const tail = result && !result.passed ? result.outputTail.trim() : ''
  return (
    <div data-testid="night-check-result" data-name={spec.name} data-passed={result ? String(result.passed) : 'pending'}>
      <div className="flex items-center gap-2 text-[12px]">
        {result ? (
          result.passed ? (
            <Check size={13} className="shrink-0 text-st-idle" aria-label="passed" />
          ) : (
            <X size={13} className="shrink-0 text-st-failed" aria-label="failed" />
          )
        ) : (
          <Minus size={13} className="shrink-0 text-faint" aria-label="not run" />
        )}
        <span className="shrink-0 font-medium">{spec.name}</span>
        {spec.kind === 'guard' && <span className="shrink-0 text-[11px] text-faint">guard</span>}
        {/* A check typed as a command is named after it: the command is shown once. */}
        <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint">{spec.command === spec.name ? '' : spec.command}</code>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">{result ? formatCheckTime(result.durationMs) : 'not run'}</span>
      </div>
      {tail && (
        <pre className="mt-1 max-h-24 select-text overflow-auto whitespace-pre-wrap rounded-md bg-term px-2 py-1.5 font-mono text-[10.5px] leading-snug text-faint">
          {tail}
        </pre>
      )}
    </div>
  )
}

export function RunCard({ night, run }: { night: Night; run: NightTaskRun }): React.JSX.Element {
  const merged = useNight((s) => s.merged[run.id])
  const error = useNight((s) => s.error)
  const ask = useNight((s) => s.ask)
  const setAsk = useNight((s) => s.setAsk)
  const merge = useNight((s) => s.merge)
  const discard = useNight((s) => s.discard)
  const workspace = useSessions((s) => s.workspace)
  const createSession = useSessions((s) => s.createSession)
  const [busy, setBusy] = useState<'merge' | 'discard' | 'open' | null>(null)

  const look = RUN_LOOK[run.status]
  const nightOver = night.status === 'finished' || night.status === 'cancelled'
  // A run that never got a folder (cancelled or missed before it started) has nothing to discard.
  const canDiscard = ((run.status === 'ready' || run.status === 'failed' || run.status === 'stopped') && run.worktree !== null) || hasLeftovers(run)
  const asking = ask && ask.id === run.id && (ask.kind === 'merge' || ask.kind === 'discard') ? ask.kind : null
  // What a merge said just now, or what the run's note says about it after a restart.
  const result = merged ?? (run.status === 'merged' ? run.note : null)
  const command = gitCommandIn(run.note)
  // A merge the engine refused keeps the run ready; its sentence is what to read next.
  const refused = /Not merged:/.test(run.note)
  const totals = testTotals(run.tests)
  const lines = lastLines(run.latest, 10)

  const doMerge = async (): Promise<void> => {
    setBusy('merge')
    try {
      await merge(run.id)
    } finally {
      setBusy(null)
    }
  }

  const doDiscard = async (): Promise<void> => {
    setBusy('discard')
    try {
      await discard(run.id)
    } finally {
      setBusy(null)
    }
  }

  const open = async (): Promise<void> => {
    if (!run.worktree) return
    setBusy('open')
    try {
      // A project opened below the top of its repository ran in the same folder below the worktree. The top of
      // the repository is asked of git for the project folder only; when it cannot be told, the worktree itself opens.
      let top: string | null = null
      if (workspace?.root === night.root) {
        try {
          top = (await bridge.invoke('git:worktrees', null)).find((w) => w.main)?.path ?? null
        } catch {
          top = null
        }
      }
      const session = await createSession(run.agent, folderForRun(run.worktree, night.root, top))
      if (session) {
        useUi.getState().setMode('code')
        useUi.getState().openOverlay(null)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div data-testid="night-card" data-run={run.id} data-status={run.status} className="rounded-[10px] border border-line bg-panel p-4">
      <div className="flex items-start gap-3">
        <AgentBadge kind={run.agent} size={24} />
        <div className="min-w-0 flex-1">
          <p data-testid="night-card-prompt" className="select-text whitespace-pre-wrap text-[13px] leading-relaxed">
            {run.prompt}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <LookPill look={look} pulse={run.status === 'running'} testId="night-card-status" status={run.status} />
            <span className="text-[11.5px] text-faint">{agentName(run.agent)}</span>
          </div>
        </div>
        {run.startedAt !== null && (
          <div className="shrink-0 text-right">
            <p data-testid="night-diff" className="font-mono text-[11.5px] text-muted">
              {diffText(run.diff)}
              {run.error && (
                <span data-testid="night-diff-error" className="ml-2 text-st-failed" title={run.error}>
                  {run.error}
                </span>
              )}
            </p>
            {run.tokens !== null && <p className="mt-0.5 text-[11px] text-faint">{compactTokens(run.tokens)} tokens</p>}
          </div>
        )}
      </div>

      {run.branch && branchLikelyThere(run) && (
        <div className="mt-3 flex items-center gap-1.5 text-[11.5px] text-muted">
          <GitBranch size={12} className="shrink-0" />
          <code data-testid="night-branch" className="min-w-0 select-text truncate font-mono">
            {run.branch}
          </code>
          <CopyButton text={run.branch} testId="night-copy-branch" title="Copy the branch name" />
        </div>
      )}

      {run.checkSpecs.length > 0 && (
        <Section title="Checks" testId="night-checks">
          {run.checkSpecs.map((spec) => (
            <CheckLine key={spec.name} spec={spec} result={run.checks.find((c) => c.name === spec.name)} />
          ))}
        </Section>
      )}

      {run.gates.length > 0 && (
        <Section title="Gates" testId="night-gates">
          {run.gates.map((gate) => (
            <div key={gate.id} data-testid="night-gate" data-gate={gate.id} data-passed={String(gate.passed)} className="flex items-start gap-2 text-[12px]">
              {gate.passed ? (
                <Check size={13} className="mt-0.5 shrink-0 text-st-idle" aria-label="passed" />
              ) : (
                <X size={13} className="mt-0.5 shrink-0 text-st-failed" aria-label="failed" />
              )}
              <span className="shrink-0 font-medium">{GATE_LABEL[gate.id]}</span>
              <span className="min-w-0 flex-1 select-text text-muted">{gate.detail}</span>
            </div>
          ))}
        </Section>
      )}

      {totals && run.tests && (
        <Section title="Tests" testId="night-tests">
          <p className="text-[12px] text-muted">
            {plural(totals.cases, 'test', 'tests')} and {plural(totals.assertions, 'assertion', 'assertions')} in {plural(totals.files, 'file', 'files')}
          </p>
          <div className="space-y-0.5 font-mono text-[11px] text-faint">
            {Object.entries(run.tests).map(([path, counts]) => (
              <p key={path} className="flex gap-3">
                <span className="min-w-0 flex-1 truncate">{path}</span>
                <span className="shrink-0 tabular-nums">
                  {counts.cases} / {counts.assertions}
                </span>
              </p>
            ))}
          </div>
        </Section>
      )}

      {lines && (
        <Section title="Last output">
          <pre data-testid="night-latest" className="max-h-32 select-text overflow-auto whitespace-pre-wrap rounded-md bg-term px-2.5 py-2 font-mono text-[11px] leading-snug text-faint">
            {lines}
          </pre>
        </Section>
      )}

      {result ? (
        <div
          data-testid="night-result"
          className="mt-4 select-text rounded-lg border border-st-idle/30 bg-st-idle/[0.07] px-3 py-2.5 text-[12.5px] leading-relaxed"
        >
          <NoteText note={result} />
        </div>
      ) : (
        run.note && (
          <div
            data-testid="night-card-note"
            className={cx(
              'mt-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed',
              run.status === 'failed'
                ? 'border-st-failed/30 bg-st-failed/[0.07]'
                : refused
                  ? 'border-st-waiting/30 bg-st-waiting/[0.07]'
                  : 'border-line bg-raised text-muted'
            )}
          >
            <Info size={13} className={cx('mt-0.5 shrink-0', run.status === 'failed' ? 'text-st-failed' : refused ? 'text-st-waiting' : 'text-faint')} />
            <NoteText note={run.note} />
            {command && <CopyButton text={command} label="Copy command" testId="night-copy-command" />}
          </div>
        )
      )}

      {error && !run.note.includes(error) && (
        <p role="alert" data-testid="night-card-error" className="mt-3 select-text text-[12.5px] leading-relaxed text-st-failed">
          {error}
        </p>
      )}

      <div className="mt-4">
        {asking === 'merge' ? (
          <Ask
            testId="night-merge-ask"
            text={MERGE_ASK}
            confirmLabel="Merge"
            confirmTestId="night-merge-confirm"
            busy={busy !== null}
            onConfirm={() => void doMerge()}
            onCancel={() => setAsk(null)}
          />
        ) : asking === 'discard' ? (
          <Ask
            testId="night-discard-ask"
            text={DISCARD_ASK}
            confirmLabel="Discard"
            confirmTestId="night-discard-confirm"
            danger
            busy={busy !== null}
            onConfirm={() => void doDiscard()}
            onCancel={() => setAsk(null)}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {run.status === 'ready' && (
              <Button
                variant="accent"
                size="sm"
                data-testid="night-merge"
                disabled={!nightOver || busy !== null}
                onClick={() => setAsk({ kind: 'merge', id: run.id })}
              >
                <Check size={13} />
                {busy === 'merge' ? 'Merging...' : 'Merge'}
              </Button>
            )}
            {worktreeLikelyThere(run) && (
              <Button variant="subtle" size="sm" data-testid="night-open" disabled={busy !== null} onClick={() => void open()}>
                <FolderOpen size={13} />
                Open in a pane
              </Button>
            )}
            {canDiscard && (
              <Button
                variant="outline"
                size="sm"
                data-testid="night-discard"
                disabled={busy !== null}
                className="border-st-failed/40 text-st-failed hover:bg-st-failed/10"
                onClick={() => setAsk({ kind: 'discard', id: run.id })}
              >
                <X size={13} />
                {busy === 'discard' ? 'Discarding...' : hasLeftovers(run) ? 'Try removing again' : 'Discard'}
              </Button>
            )}
          </div>
        )}
        {run.status === 'ready' && !nightOver && !asking && (
          <p data-testid="night-merge-hint" className="mt-2 text-[11.5px] text-faint">
            You can merge once the night has finished.
          </p>
        )}
      </div>
    </div>
  )
}
