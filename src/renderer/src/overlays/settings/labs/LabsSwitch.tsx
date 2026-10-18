// One row in Settings > Labs: a name, what the feature does, and a switch.

import { Toggle } from '../Toggle'

interface LabsSwitchProps {
  testId: string
  title: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
  /** Board and Dictate anywhere are switched on but not built yet; this is the line under them. */
  comingSoon?: boolean
}

export function LabsSwitch({ testId, title, description, checked, onChange, comingSoon }: LabsSwitchProps): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{description}</p>
        {comingSoon && (
          <p className="mt-1 text-[11px] font-medium text-faint" data-testid={`${testId}-soon`}>
            Coming soon
          </p>
        )}
      </div>
      <Toggle checked={checked} onChange={onChange} testId={testId} label={title} />
    </div>
  )
}
