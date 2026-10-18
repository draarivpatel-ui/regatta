// Start a crew: several agents at once, optionally each in its own worktree.

import { useSessions } from '../store/sessions'
import { Modal } from '../components/overlay'
import { Button } from '../components/ui'
import { CrewRow } from './launchset/CrewRow'
import { IsolateSwitch } from './launchset/IsolateSwitch'
import { useCrew } from './launchset/useCrew'

export function LaunchSetDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const all = useSessions((s) => s.agents)
  const workspace = useSessions((s) => s.workspace)
  const focusedId = useSessions((s) => s.focusedId)
  const crew = useCrew(all)
  const folder = workspace?.name ?? 'this folder'

  const start = async (): Promise<void> => {
    if (await crew.start(focusedId)) onClose()
  }

  const label = `Start ${crew.total} ${crew.total === 1 ? 'agent' : 'agents'}`

  return (
    <Modal
      title="Start a crew"
      subtitle={`Start several agents in ${folder} at once.`}
      onClose={onClose}
      testId="launchset-dialog"
      width={540}
      footer={
        <>
          <Button onClick={onClose} data-testid="crew-cancel">
            Cancel
          </Button>
          <Button
            variant="accent"
            data-testid="crew-start"
            disabled={crew.total === 0 || crew.starting}
            onClick={() => void start()}
          >
            {crew.starting ? 'Starting…' : label}
          </Button>
        </>
      }
    >
      <p className="pb-1.5 text-[11.5px] text-faint">How many of each agent?</p>
      {crew.agents.length === 0 ? (
        <p className="py-6 text-center text-[12.5px] text-muted">No agents found on this computer.</p>
      ) : (
        <div className="rounded-xl border border-line bg-panel px-3">
          {crew.agents.map((agent) => (
            <CrewRow
              key={agent.kind}
              agent={agent}
              count={crew.counts[agent.kind] ?? 0}
              bump={crew.bump}
            />
          ))}
        </div>
      )}
      <IsolateSwitch checked={crew.isolate} onChange={crew.setIsolate} git={crew.git} />
      {crew.error && (
        <p role="alert" className="mt-2 text-[12.5px] text-st-failed">
          {crew.error}
        </p>
      )}
    </Modal>
  )
}