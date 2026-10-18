// Settings > General.

import { useSessions } from '../../store/sessions'
import { useUi } from '../../store/ui'
import { Button } from '../../components/ui'
import { Toggle } from './Toggle'
import { SectionTitle, type SectionProps } from './common'

export function GeneralSection({ prefs, onPatch }: SectionProps): React.JSX.Element {
  const workspace = useSessions((s) => s.workspace)
  const quiet = prefs?.quietAfterSec ?? 8
  return (
    <div className="max-w-[520px]">
      <SectionTitle>General</SectionTitle>
      <div className="mt-4">
        <p className="text-[13px] font-medium">Project folder</p>
        <div className="mt-1.5 flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted" data-testid="settings-workspace-path">
            {workspace?.root ?? 'No folder chosen'}
          </span>
          <Button
            variant="subtle"
            size="sm"
            data-testid="settings-change-workspace"
            onClick={() => void useSessions.getState().pickWorkspace()}
          >
            Change
          </Button>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">Ask before closing a pane</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">Confirm before a pane and its process go away.</p>
        </div>
        <Toggle
          checked={prefs?.confirmClosePane ?? false}
          onChange={(next) => onPatch({ confirmClosePane: next })}
          testId="pref-confirm-close"
          label="Ask before closing a pane"
          disabled={prefs === null}
        />
      </div>
      <div className="mt-5 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">Welcome</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">The three step introduction from the first run.</p>
        </div>
        <Button
          variant="subtle"
          size="sm"
          data-testid="settings-show-welcome"
          onClick={() => useUi.getState().openOverlay('welcome')}
        >
          Show the welcome again
        </Button>
      </div>
      <div className="mt-5">
        <p className="text-[13px] font-medium">Mark an agent quiet after</p>
        <div className="mt-1.5 flex items-center gap-2">
          <Button
            variant="subtle"
            size="sm"
            data-testid="pref-quiet-minus"
            disabled={prefs === null || quiet <= 4}
            onClick={() => onPatch({ quietAfterSec: Math.max(4, quiet - 1) })}
            aria-label="Decrease quiet delay"
          >
            -
          </Button>
          <span className="min-w-[86px] text-center text-[12.5px] tabular-nums" data-testid="pref-quiet-after">
            {quiet} seconds
          </span>
          <Button
            variant="subtle"
            size="sm"
            data-testid="pref-quiet-plus"
            disabled={prefs === null || quiet >= 60}
            onClick={() => onPatch({ quietAfterSec: Math.min(60, quiet + 1) })}
            aria-label="Increase quiet delay"
          >
            +
          </Button>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">New panes use the new value right away.</p>
      </div>
    </div>
  )
}
