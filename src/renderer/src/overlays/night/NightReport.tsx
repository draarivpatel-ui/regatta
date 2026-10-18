// A night's report: how it went, what the engine kept, and every task with merge, open and discard.

import { X } from 'lucide-react'
import type { Night, NightTaskRun } from '@shared/nightwatch'
import { AgentBadge } from '../../components/marks'
import { useNow } from '../../lib/useNow'
import { Button, cx } from '../../components/ui'
import { useNight } from '../../store/night'
import { Ask } from './Ask'
import { CopyButton } from './CopyButton'
import {
  agentName,
  compactTokens,
  gitCommandIn,
  nightBase,
  nightLook,
  nightSummary,
  nightTitle,
  ranLabel,
  ranText,
  RUN_LOOK,
  runSpan,
  tokensByAgent
} from './helpers'
import { LookPill } from './marks'
import { NoteText } from './NoteText'
import { RunCard } from './RunCard'

function Fact({ label, value, note, mono, testId }: { label: string; value: string; note?: string; mono?: boolean; testId: string }): React.JSX.Element {
  return (
    <div data-testid={testId} className="min-w-0 rounded-lg border border-line bg-panel px-3 py-2.5">
      <dt className="text-[11px] text-faint">{label}</dt>
      <dd className={cx('mt-0.5 truncate text-[12.5px]', mono && 'font-mono')} title={value}>
        {value}
      </dd>
      {note && <p className="mt-0.5 text-[10.5px] leading-snug text-faint">{note}</p>}
    </div>
  )
}

/** The thin bar of a run row: moving while it works, green when ready, red when failed, gray otherwise. */
function RunBar({ run }: { run: NightTaskRun }): React.JSX.Element {
  const busy = run.status === 'running' || run.status === 'checking'
  return (
    <span className="block h-1 w-full overflow-hidden rounded-full bg-line" aria-hidden="true">
      <span className={cx('block h-full rounded-full', RUN_LOOK[run.status].bar, run.status === 'queued' ? 'w-0' : 'w-full', busy && 'animate-pulse')} />
    </span>
  )
}

function RunRow({ run, selected, now, onSelect }: { run: NightTaskRun; selected: boolean; now: number; onSelect: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={`night-run-${run.id}`}
      data-status={run.status}
      data-selected={selected ? 'true' : 'false'}
      aria-pressed={selected}
      onClick={onSelect}
      className={cx(
        'grid w-full grid-cols-[20px_minmax(0,1fr)_82px_88px_48px] items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none',
        'transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/50',
        selected ? 'border-accent/40 bg-accent/[0.05]' : 'border-line bg-raised hover:border-line-strong hover:bg-hover'
      )}
    >
      <AgentBadge kind={run.agent} size={20} />
      <span className="truncate text-[12.5px]" title={run.prompt}>
        {run.prompt}
      </span>
      <LookPill look={RUN_LOOK[run.status]} small />
      <RunBar run={run} />
      <span className="text-right font-mono text-[11px] tabular-nums text-faint">{runSpan(run, now) ?? ''}</span>
    </button>
  )
}

export function NightReport({ night }: { night: Night }): React.JSX.Element {
  const now = useNow()
  const selectedRun = useNight((s) => s.selectedRun)
  const selectRun = useNight((s) => s.selectRun)
  const ask = useNight((s) => s.ask)
  const setAsk = useNight((s) => s.setAsk)
  const cancel = useNight((s) => s.cancel)

  const look = nightLook(night)
  // The first task is the one on screen until another is picked.
  const current = night.runs.find((r) => r.id === selectedRun) ?? night.runs[0] ?? null
  const tokens = tokensByAgent(night.runs)
  const stopping = ask?.kind === 'stop' && ask.id === night.id
  const base = nightBase(night)

  return (
    <div data-testid="night-report" data-night={night.id} data-status={night.status} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-6 py-6">
        <div className="flex items-center gap-2.5">
          <span className="text-[12px] font-medium text-faint">Night watch</span>
          <LookPill look={look} pulse={night.status === 'running'} testId="night-status" status={night.status} />
          {night.status === 'running' && !stopping && (
            <Button
              variant="outline"
              size="sm"
              data-testid="night-cancel"
              className="ml-auto border-st-failed/40 text-st-failed hover:bg-st-failed/10"
              onClick={() => setAsk({ kind: 'stop', id: night.id })}
            >
              <X size={13} />
              Stop the night
            </Button>
          )}
          {night.status === 'scheduled' && (
            <Button variant="outline" size="sm" data-testid="night-cancel" className="ml-auto" onClick={() => void cancel()}>
              <X size={13} />
              Cancel the night
            </Button>
          )}
        </div>
        {stopping && (
          <div className="mt-3">
            <Ask
              testId="night-stop-ask"
              text="Stop the night? The task running now is stopped and the tasks after it do not start."
              confirmLabel="Stop the night"
              confirmTestId="night-stop-confirm"
              danger
              onConfirm={() => {
                setAsk(null)
                void cancel()
              }}
              onCancel={() => setAsk(null)}
            />
          </div>
        )}

        <h2 data-testid="night-title" className="mt-2 text-[15px] font-semibold tracking-[-0.01em]">
          {nightTitle(night)}
        </h2>

        <div data-testid="night-summary" className="mt-3 rounded-[10px] border border-line bg-panel px-4 py-3">
          <p className="select-text text-[12.5px] leading-relaxed">{nightSummary(night)}</p>
          {tokens.length > 0 && (
            <p data-testid="night-tokens" className="mt-1 text-[11.5px] text-muted">
              {tokens.map((t) => `${agentName(t.agent)} ${compactTokens(t.tokens)} tokens`).join(' · ')}
            </p>
          )}
        </div>

        {night.notes && night.notes.length > 0 && (
          <ul data-testid="night-notes" className="mt-3 space-y-1.5">
            {night.notes.map((note) => {
              const command = gitCommandIn(note)
              return (
                <li key={note} data-testid="night-note" className="flex items-start gap-2 text-[12px] leading-relaxed text-muted">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-faint" aria-hidden="true" />
                  {/* Every command in the note carries its own copy button; the line keeps one for the first. */}
                  <NoteText note={note} />
                  {command && <CopyButton text={command} label="Copy command" testId="night-copy-command" />}
                </li>
              )
            })}
          </ul>
        )}

        <dl className="mt-4 grid grid-cols-3 gap-3">
          <Fact label={ranLabel(night)} value={ranText(night, now)} testId="night-fact-ran" />
          <Fact label="Per task" value="up to 30 minutes" testId="night-fact-limit" />
          <Fact label="Base" value={base ?? 'not started'} mono={base !== null} note="your working folder is never touched" testId="night-fact-base" />
        </dl>

        <div className="mt-5">
          <h3 className="text-[12.5px] font-medium">Tasks</h3>
          <div data-testid="night-runs" className="mt-2 space-y-1.5">
            {night.runs.map((run) => (
              <RunRow key={run.id} run={run} now={now} selected={current?.id === run.id} onSelect={() => selectRun(run.id)} />
            ))}
          </div>
        </div>

        {current && (
          <div className="mt-4">
            <RunCard key={current.id} night={night} run={current} />
          </div>
        )}
      </div>
    </div>
  )
}
