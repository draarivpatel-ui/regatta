// The left column of Flows mode: every flow with its step count and last edit.

import { Plus } from 'lucide-react'
import type { Flow, FlowRun } from '@shared/flows'
import { Button, cx } from '../../components/ui'
import { StatusDot } from '../../components/marks'
import { flowSummary, formatDay, isLive, runTone } from './logic'

interface FlowListProps {
  /** False until the engine's first list has come back, so a saved flow never flashes "No flows yet". */
  loaded: boolean
  /** In the order to show. */
  flows: Flow[]
  runs: FlowRun[]
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}

export function FlowList({ loaded, flows, runs, selectedId, onSelect, onNew }: FlowListProps): React.JSX.Element {
  return (
    <aside data-testid="flows-list" aria-label="Flows" className="flex h-full w-[260px] shrink-0 flex-col border-r border-line bg-chrome">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h1 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Flows</h1>
        <Button variant="subtle" size="sm" data-testid="flow-new" onClick={onNew}>
          <Plus size={13} strokeWidth={2.4} />
          New flow
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {flows.length === 0 ? (
          <div className={cx('px-2 py-6 text-center', !loaded && 'invisible')}>
            <p className="text-[12.5px] font-medium text-fg">No flows yet</p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">A flow chains agents, checks and approvals into one run.</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {flows.map((flow) => {
              const selected = flow.id === selectedId
              const live = runs.find((run) => run.flowId === flow.id && isLive(run))
              return (
                <li key={flow.id}>
                  <button
                    type="button"
                    data-testid="flow-row"
                    data-flow-id={flow.id}
                    data-selected={String(selected)}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onSelect(flow.id)}
                    className={cx(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150',
                      selected ? 'bg-press' : 'hover:bg-hover'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-fg">{flow.name}</span>
                      <span className="mt-0.5 block truncate text-[11.5px] text-faint">
                        {flowSummary(flow)} · {formatDay(flow.updatedAt)}
                      </span>
                    </span>
                    {live && (
                      <span
                        role="img"
                        aria-label={live.status === 'waiting' ? 'Needs you' : 'Working'}
                        title={live.status === 'waiting' ? 'Needs you' : 'Working'}
                        data-testid="flow-row-live"
                        data-state={live.status}
                      >
                        <StatusDot state={runTone(live.status)} size={7} />
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
