// What the player area says when there is no picture to show yet: no video built, one being built, a
// build that failed, a page that is still loading or did not load.

import { Clapperboard, LoaderCircle, TriangleAlert } from 'lucide-react'
import { Button, cx } from '../../components/ui'
import type { Notice } from './notice'

export function StageNotice({
  notice,
  onActivity,
  overlay
}: {
  notice: Notice
  onActivity: () => void
  /** True when the notice sits on top of a page that is still coming up. */
  overlay?: boolean
}): React.JSX.Element {
  const icon =
    notice.icon === 'spin' ? (
      <LoaderCircle size={20} className="animate-spin text-faint" />
    ) : notice.icon === 'alert' ? (
      <TriangleAlert size={20} className="text-st-failed" />
    ) : (
      <Clapperboard size={22} className="text-faint" />
    )
  return (
    <div
      data-testid="video-stage-notice"
      data-kind={notice.kind}
      className={cx(
        overlay ? 'absolute inset-0 z-10' : 'h-full w-full',
        'flex flex-col items-center justify-center gap-2 bg-term px-6 text-center',
        // A reload is over in a blink; the cover only shows when it is taking a while.
        notice.kind === 'loading' && 'animate-fade-in [animation-delay:400ms]'
      )}
    >
      {icon}
      <p className="text-[13px] font-medium text-fg">{notice.title}</p>
      {notice.line && <p className="max-w-[320px] text-[12px] leading-relaxed text-muted">{notice.line}</p>}
      {notice.action === 'activity' && (
        <Button variant="subtle" size="sm" className="mt-1" data-testid="video-stage-activity" onClick={onActivity}>
          See what happened
        </Button>
      )}
    </div>
  )
}
