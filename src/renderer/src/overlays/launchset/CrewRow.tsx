// One row of the crew dialog: an agent, its monogram and a stepper from 0 to 4.

import type { AgentKind, DetectedAgent } from '@shared/types'
import { Minus, Plus } from 'lucide-react'
import { AgentBadge } from '../../components/marks'
import { IconButton } from '../../components/ui'
import { MAX_PER_AGENT } from './useCrew'

interface CrewRowProps {
  agent: DetectedAgent
  count: number
  bump: (kind: AgentKind, delta: number) => void
}

export function CrewRow({ agent, count, bump }: CrewRowProps): React.JSX.Element {
  // The leading version number only, so "codex-cli 0.162.1" shows as "0.162.1".
  const version = agent.version?.replace(/^[^\d]*/, '').split(/[\s(]/)[0]
  return (
    <div
      data-testid="crew-row"
      data-agent={agent.kind}
      className="flex items-center gap-3 border-b border-line py-1.5 last:border-b-0"
    >
      <AgentBadge kind={agent.kind} size={20} />
      <span className="flex-1 truncate text-[12.5px] text-fg">{agent.name}</span>
      {version && <span className="font-mono text-[10.5px] text-faint">{version}</span>}
      <div className="flex items-center gap-0.5 rounded-lg border border-line bg-panel p-[3px]">
        <IconButton
          size="sm"
          className="!w-6"
          onClick={() => bump(agent.kind, -1)}
          disabled={count === 0}
          data-testid="crew-minus"
          data-agent={agent.kind}
          aria-label={`One fewer ${agent.name}`}
          title={`One fewer ${agent.name}`}
        >
          <Minus size={13} />
        </IconButton>
        <span
          data-testid="crew-count"
          data-agent={agent.kind}
          aria-label={`${agent.name}: ${count}`}
          className="w-6 text-center font-mono text-[12.5px] text-fg tabular-nums"
        >
          {count}
        </span>
        <IconButton
          size="sm"
          className="!w-6"
          onClick={() => bump(agent.kind, 1)}
          disabled={count >= MAX_PER_AGENT}
          data-testid="crew-plus"
          data-agent={agent.kind}
          aria-label={`One more ${agent.name}`}
          title={`One more ${agent.name}`}
        >
          <Plus size={13} />
        </IconButton>
      </div>
    </div>
  )
}