// The panel docked to the left of the pane grid (Files, Find, Git, Thread, Flows, Device).

import { X } from 'lucide-react'
import { useUi, type SidePanel as PanelId } from '../store/ui'
import { IconButton } from '../components/ui'
import { DevicePanel } from './DevicePanel'
import { FilesPanel } from './FilesPanel'
import { FindPanel } from './FindPanel'
import { FlowsPanel } from './FlowsPanel'
import { GitPanel } from './GitPanel'
import { ThreadPanel } from './ThreadPanel'

const TITLES: Record<PanelId, string> = {
  files: 'Files',
  find: 'Find',
  git: 'Git',
  browser: 'Preview',
  thread: 'Thread',
  flows: 'Flows',
  simulator: 'Device'
}

export function SidePanel({ panel }: { panel: PanelId }): React.JSX.Element {
  const toggle = useUi((s) => s.toggleSidePanel)
  return (
    <section
      data-testid={`side-panel-${panel}`}
      className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-[11px] border border-line bg-panel animate-dock-in"
    >
      <header className="flex h-[38px] shrink-0 items-center border-b border-line px-3">
        <span className="text-[12.5px] font-medium">{TITLES[panel]}</span>
        <IconButton className="ml-auto" onClick={() => toggle(panel)} aria-label={`Close ${TITLES[panel]}`} title="Close">
          <X size={14} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {panel === 'files' && <FilesPanel />}
        {panel === 'find' && <FindPanel />}
        {panel === 'git' && <GitPanel />}
        {panel === 'thread' && <ThreadPanel />}
        {panel === 'flows' && <FlowsPanel />}
        {panel === 'simulator' && <DevicePanel />}
      </div>
    </section>
  )
}
