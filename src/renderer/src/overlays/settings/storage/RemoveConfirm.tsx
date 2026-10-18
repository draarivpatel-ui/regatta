// Confirmation panel before moving leftover worktrees to Regatta's trash.

import { Button } from '../../../components/ui'

export function RemoveConfirm({
  count,
  busy,
  error,
  onConfirm,
  onCancel
}: {
  count: number
  busy: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div data-testid="storage-confirm-panel" className="mt-3 rounded-lg border border-line-strong bg-raised px-3 py-2.5">
      <p className="text-[12.5px]">
        Move {count} {count === 1 ? 'worktree' : 'worktrees'} to Regatta&apos;s trash?{' '}
        {count === 1
          ? 'Its folder moves into .regatta-trash; its branch stays until you empty the trash.'
          : 'Their folders move into .regatta-trash; branches stay until you empty the trash.'}
      </p>

      {error && <p className="mt-2 text-[12px] text-st-failed">{error}</p>}

      <div className="mt-2 flex items-center gap-1.5">
        <Button variant="accent" size="sm" data-testid="storage-confirm" onClick={onConfirm} disabled={busy}>
          {busy ? 'Moving' : 'Move to trash'}
        </Button>
        <Button variant="ghost" size="sm" data-testid="storage-cancel" onClick={onCancel} disabled={busy}>
          Keep
        </Button>
      </div>
    </div>
  )
}
