// Heat view: status, lanes, decision.

import { useState } from 'react'
import { Check, X } from 'lucide-react'
import type { HeatState, LaneState } from '@shared/heats'
import { bridge } from '../../lib/bridge'
import { useNow } from '../../lib/useNow'
import { useHeats } from '../../store/heats'
import { AgentBadge } from '../../components/marks'
import { Button, cx } from '../../components/ui'
import { baselineLine, formatDiff, formatTokens, heatStatusText, laneElapsed, laneName } from './helpers'

function CheckDot({ passed, name }: { passed: boolean | null; name: string }): React.JSX.Element {
  const cls =
    passed === null ? 'bg-st-quiet' : passed ? 'bg-st-idle' : 'bg-st-failed'
  return (
    <span
      title={name}
      aria-label={`${name}: ${passed === null ? 'not run' : passed ? 'passing' : 'failing'}`}
      className={cx('inline-block h-[7px] w-[7px] rounded-full', cls)}
    />
  )
}

function LaneRow({
  lane,
  heat,
  now,
  expanded,
  onToggle
}: {
  lane: LaneState
  heat: HeatState
  now: number
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const agentName = laneName(lane)
  return (
    <div className="border-b border-line last:border-b-0">
      <div
        data-testid="heat-lane"
        data-agent={lane.agent}
        data-attempt={lane.attempt}
        data-phase={lane.phase}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className="grid cursor-pointer grid-cols-[minmax(0,1.4fr)_76px_64px_76px_84px_minmax(0,1fr)] items-center gap-3 px-4 py-2.5 text-[12px] transition-colors duration-150 hover:bg-hover"
      >
        <span className="flex min-w-0 items-center gap-2">
          {lane.attempt !== undefined && <span className="shrink-0 text-faint">{lane.attempt}.</span>}
          <AgentBadge kind={lane.agent} size={18} />
          <span className="truncate font-medium">{agentName}</span>
          <span className="shrink-0 text-[11px] text-faint">{lane.phase}</span>
          {lane.attempt !== undefined && lane.gates.length > 0 && <span className="shrink-0 text-[11px] text-muted">{lane.gates.filter((gate) => gate.passed).length}/5 gates</span>}
        </span>
        <span className="text-muted tabular-nums">{laneElapsed(lane.startedAt, lane.endedAt, now)}</span>
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-muted tabular-nums">
          <span>{formatDiff(lane.diff.added, lane.diff.removed)}</span>
          {lane.error && (
            <span data-testid="heat-lane-diff-error" className="truncate text-[11px] text-st-failed" title={lane.error}>
              {lane.error}
            </span>
          )}
        </span>
        <span className="text-muted tabular-nums">{formatTokens(lane.tokens)}</span>
        <span className="flex items-center gap-1.5">
          {heat.checks.map((c) => {
            const found = lane.checks.find((r) => r.name === c.name)
            return <CheckDot key={c.name} name={c.name} passed={found ? found.passed : null} />
          })}
        </span>
        <span className="truncate font-mono text-[11.5px] text-faint" title={lane.latest || lane.error || ''}>
          {lane.latest || lane.error || ''}
        </span>
      </div>
      {lane.attempt !== undefined && (lane.branch || lane.worktree) && (
        <p data-testid="handoff-worktree" className="break-all px-4 pb-2 font-mono text-[11px] text-muted">
          {lane.branch && <span data-testid="handoff-branch">{lane.branch}</span>}
          {lane.branch && lane.worktree ? ': ' : ''}
          {lane.worktree}
        </p>
      )}
      {expanded && (
        <div data-testid="heat-gates" className="border-t border-line bg-panel/50 px-4 py-2.5">
          {lane.gates.length === 0 ? (
            <p className="text-[12px] text-faint">No gates scored yet.</p>
          ) : (
            <div className="space-y-1.5">
              {lane.gates.map((g) => (
                <div
                  key={g.id}
                  data-testid="heat-gate"
                  data-gate={g.id}
                  data-passed={g.passed ? 'true' : 'false'}
                  className="flex items-start gap-2 text-[12px]"
                >
                  {g.passed ? (
                    <Check size={13} className="mt-0.5 shrink-0 text-st-idle" />
                  ) : (
                    <X size={13} className="mt-0.5 shrink-0 text-st-failed" />
                  )}
                  <span className="shrink-0 font-medium">{g.id}</span>
                  <span className="min-w-0 flex-1 text-muted">{g.detail}</span>
                </div>
              ))}
            </div>
          )}
          {lane.error && <p className="mt-1.5 text-[12px] text-st-failed">{lane.error}</p>}
        </div>
      )}
    </div>
  )
}

export function HeatView({ heat }: { heat: HeatState }): React.JSX.Element {
  const now = useNow()
  const merged = useHeats((s) => s.merged[heat.id])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handoff = heat.mode === 'handoff'
  const racing = heat.status === 'baseline' || heat.status === 'racing'
  const waiting = heat.status === 'waiting'

  const cancel = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await bridge.invoke('heats:cancel', heat.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const continueHandoff = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try { await bridge.invoke('heats:continue', heat.id) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const mergeLane = async (laneId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await bridge.invoke('heats:merge', heat.id, laneId)
      useHeats.getState().setMerged(heat.id, result.summary)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const discard = async (): Promise<void> => {
    if (!window.confirm("Discard this heat? Lanes with nothing new are removed; a copy of each lane's commits stays in the repository.")) return
    setBusy(true)
    setError(null)
    try {
      await bridge.invoke('heats:discard', heat.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const winnerLane = (laneId: string): LaneState | undefined => heat.lanes.find((l) => l.id === laneId)

  return (
    <div data-testid="heat-view" className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-line px-6 pt-5 pb-4">
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-[15px] font-semibold tracking-[-0.01em]">{heat.task}</h2>
          <span
            data-testid="heat-status"
            data-status={heat.status}
            className="shrink-0 rounded-full border border-line-strong bg-panel px-2.5 py-1 text-[11.5px] font-medium text-muted"
          >
            {heatStatusText(heat, now)}
          </span>
        </div>
        <p data-testid="heat-baseline" className="mt-2 font-mono text-[11.5px] text-faint">
          {baselineLine(heat)}
        </p>
        {waiting && <div className="mt-3 flex items-center gap-2">
          <p className="mr-auto text-[12px] text-muted">Checks did not pass. Continue with the next agent?</p>
          <Button variant="accent" size="sm" data-testid="handoff-continue" disabled={busy} onClick={() => void continueHandoff()}>Continue</Button>
          <Button variant="subtle" size="sm" data-testid="handoff-stop" disabled={busy} onClick={() => void cancel()}>Stop</Button>
        </div>}
        {racing && (
          <div className="mt-3">
            <Button variant="subtle" size="sm" data-testid="heat-cancel" disabled={busy} onClick={() => void cancel()}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      <div className="px-6 pt-4">
        <p className="text-[12.5px] font-medium">{handoff ? 'Attempts' : 'Lanes'}</p>
      </div>
      <div className="mx-6 mt-2 overflow-hidden rounded-xl border border-line bg-raised">
        <div className="grid grid-cols-[minmax(0,1.4fr)_76px_64px_76px_84px_minmax(0,1fr)] gap-3 border-b border-line bg-panel/60 px-4 py-1.5 text-[11px] font-medium text-faint">
          <span>Agent</span>
          <span>Elapsed</span>
          <span>Diff</span>
          <span>Tokens</span>
          <span>Checks</span>
          <span>Latest</span>
        </div>
        <ol data-testid={handoff ? 'handoff-attempts' : 'heat-lanes'}>
        {heat.lanes.map((lane, i) => (
          <li key={lane.id}>
          <LaneRow
            key={`${lane.branch ?? lane.id}-${i}`}
            lane={lane}
            heat={heat}
            now={now}
            expanded={expanded === i}
            onToggle={() => setExpanded((prev) => (prev === i ? null : i))}
          />
          </li>
        ))}
        </ol>
      </div>

      {heat.decision && (
        <div className="px-6 py-4">
          <div
            data-testid="heat-decision"
            data-kind={heat.decision.kind}
            className="rounded-xl border border-line bg-panel px-4 py-3.5"
          >
            <p className="text-[12.5px] leading-relaxed">{heat.decision.note}</p>
            {heat.status === 'decided' && <div className="mt-3 flex flex-wrap gap-2">
              {heat.decision.kind === 'winner' &&
                heat.decision.laneIds.slice(0, 1).map((laneId) => {
                  const lane = winnerLane(laneId)
                  const name = lane ? laneName(lane) : laneId
                  return (
                    <Button
                      key={laneId}
                      variant="accent"
                      size="sm"
                      data-testid="heat-merge"
                      disabled={busy}
                      onClick={() => void mergeLane(laneId)}
                    >
                      Merge {name}&apos;s change
                    </Button>
                  )
                })}
              {heat.decision.kind === 'tie' &&
                heat.lanes
                  .filter((l) => heat.decision!.laneIds.includes(l.id))
                  .map((lane, i) => (
                    <Button
                      key={`${lane.branch ?? lane.id}-${i}`}
                      variant="subtle"
                      size="sm"
                      data-testid="heat-keep"
                      data-lane={lane.id}
                      disabled={busy}
                      onClick={() => void mergeLane(lane.id)}
                    >
                      Keep {laneName(lane)}&apos;s change
                    </Button>
                  ))}
              {(
                <Button variant="subtle" size="sm" data-testid="heat-discard" disabled={busy} onClick={() => void discard()}>
                  Discard
                </Button>
              )}
            </div>}
          </div>
        </div>
      )}

      {['cancelled', 'error'].includes(heat.status) && <div className="px-6 py-4">
        <Button variant="subtle" size="sm" data-testid="heat-discard" disabled={busy} onClick={() => void discard()}>Discard</Button>
      </div>}

      {merged && (
        <div className="px-6 pb-4">
          <p data-testid="heat-merged" className="rounded-xl border border-st-idle/30 bg-st-idle/[0.07] px-4 py-3 text-[12.5px] leading-relaxed text-fg">
            {merged}
          </p>
        </div>
      )}

      {heat.notes && heat.notes.length > 0 && (
        <div className="px-6 pb-4">
          <ul data-testid="heat-notes" className="list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-muted">
            {heat.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="px-6 pb-4">
          <p role="alert" data-testid="heat-error" className="text-[12.5px] text-st-failed">
            {error}
          </p>
        </div>
      )}

      {heat.status === 'error' && heat.error && (
        <div className="px-6 pb-4">
          <p role="alert" className="text-[12.5px] text-st-failed">
            {heat.error}
          </p>
        </div>
      )}
    </div>
  )
}
