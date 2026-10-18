// Settings > Notifications.

import { Toggle } from './Toggle'
import { SectionTitle, type SectionProps } from './common'

export function NotificationsSection({ prefs, onPatch }: SectionProps): React.JSX.Element {
  return (
    <div className="max-w-[520px]">
      <SectionTitle>Notifications</SectionTitle>
      <div className="mt-4 flex items-start gap-3">
        <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed">
          Show a desktop notification when an agent needs you or finishes while Regatta is in the background.
        </p>
        <Toggle
          checked={prefs?.notifications ?? true}
          onChange={(next) => onPatch({ notifications: next })}
          testId="pref-notifications"
          label="Desktop notifications"
          disabled={prefs === null}
        />
      </div>
    </div>
  )
}
