// One small confirm dialog for the three questions Flows mode asks: delete a flow, replace its steps with a
// recipe, discard a run.

import type { ReactNode } from 'react'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/ui'

interface ConfirmDialogProps {
  testId: string
  title: string
  /** The question's explanation, in plain words. */
  body: ReactNode
  /** Left out when the action cannot go ahead: the dialog then only offers to close. */
  confirmLabel?: string
  /** A destructive action gets the red outline button instead of the accent one. */
  danger?: boolean
  onConfirm?: () => void
  onCancel: () => void
}

export function ConfirmDialog({ testId, title, body, confirmLabel, danger, onConfirm, onCancel }: ConfirmDialogProps): React.JSX.Element {
  return (
    <Modal
      testId={testId}
      title={title}
      subtitle={body}
      width={440}
      onClose={onCancel}
      footer={
        <>
          {/* Focus starts on the safe choice when the action destroys something, and on the action otherwise. */}
          <Button variant="ghost" autoFocus={!onConfirm || danger} data-testid="flow-confirm-cancel" onClick={onCancel}>
            {onConfirm ? 'Cancel' : 'Close'}
          </Button>
          {onConfirm && (
            <Button
              variant={danger ? 'outline' : 'accent'}
              className={danger ? 'text-st-failed hover:bg-st-failed/10' : undefined}
              autoFocus={!danger}
              data-testid="flow-confirm-yes"
              onClick={onConfirm}
            >
              {confirmLabel ?? 'Continue'}
            </Button>
          )}
        </>
      }
    >
      {null}
    </Modal>
  )
}
