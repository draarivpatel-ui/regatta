// One board card: what it is (kind icon), its title (the full card width), the agents on it, how long
// it has sat in this column, its latest line, and the actions its kind allows. Clicking the body opens
// where the work lives; the action buttons stop that click from bubbling.

import type { BoardAction, BoardCard as Card } from '@shared/board'
import { AgentBadge } from '../../components/marks'
import { Button } from '../../components/ui'
import { ago } from '../../lib/format'
import { ACTION_LABEL, KIND_ICON } from './format'

interface Props {
  card: Card
  now: number
  busy: boolean
  onOpen: () => void
  onAction: (action: BoardAction) => void
}

export function BoardCardView({ card, now, busy, onOpen, onAction }: Props): React.JSX.Element {
  const Icon = KIND_ICON[card.kind]
  return (
    <article
      data-testid={`board-card-${card.id}`}
      data-kind={card.kind}
      onClick={onOpen}
      className="flex min-w-0 cursor-pointer flex-col rounded-xl border border-line bg-panel p-3 animate-[fade-up_160ms_cubic-bezier(0.2,0.8,0.2,1)_both]"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
        title={`Open ${card.title}`}
        className="group flex min-w-0 items-start gap-2 text-left"
      >
        <Icon size={14} className="mt-0.5 shrink-0 text-faint group-hover:text-muted" />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg tracking-[-0.01em]">{card.title}</h3>
      </button>

      <div
        data-testid={`board-meta-${card.id}`}
        className="mt-1 flex min-w-0 items-center gap-x-2 overflow-hidden text-[11px] whitespace-nowrap text-muted"
      >
        <span className="shrink-0 capitalize">{card.kind}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{ago(card.since, now)}</span>
        {card.agents.length > 0 && (
          <span className="flex min-w-0 shrink-0 items-center gap-1">
            {card.agents.map((agent) => (
              <AgentBadge key={agent} kind={agent} size={14} />
            ))}
          </span>
        )}
      </div>

      {card.latest && (
        <p className="mt-2 w-full truncate rounded-md border border-line bg-term px-2 py-1 font-mono text-[11px] text-muted" title={card.latest}>
          {card.latest}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {card.actions.map((action) => (
          <Button
            key={action}
            variant={
              action === 'run' || action === 'merge' || action === 'approve'
                ? 'accent'
                : action === 'stop' || action === 'choose'
                  ? 'subtle'
                  : 'ghost'
            }
            size="sm"
            data-testid={`board-action-${action}-${card.id}`}
            onClick={(e) => {
              e.stopPropagation()
              onAction(action)
            }}
            disabled={busy}
            title={ACTION_LABEL[action]}
          >
            {ACTION_LABEL[action]}
          </Button>
        ))}
      </div>
    </article>
  )
}
