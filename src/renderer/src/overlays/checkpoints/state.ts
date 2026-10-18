// What the Checkpoints panel offers for a step, decided from the state the engine reports.

import type { CheckpointStep, RollbackFile, RollbackResult } from '@shared/checkpoints'

export interface StepView {
  /** Why the engine would refuse to roll this step back or redo it, with a short heading. */
  blocked: { heading: string; text: string } | null
  /** A roll back can be requested. */
  canRollback: boolean
  /** A partly applied operation can be run again to finish it, in the same direction. */
  canRetry: boolean
  /** The direction Retry continues. */
  retryDirection: 'rollback' | 'redo' | null
  canRedo: boolean
  /** Shown while a roll back is half done. */
  partialNote: string | null
}

export function viewStep(step: CheckpointStep): StepView {
  let blocked: StepView['blocked'] = null
  if (step.unprotected) {
    blocked = { heading: 'Not protected', text: step.blockedReason ?? `This turn is not protected: ${step.unprotected}` }
  } else if (step.failed) {
    blocked = { heading: 'Checkpoint failed', text: step.blockedReason ?? step.failed }
  } else if (step.shared) {
    blocked = { heading: 'Shared folder', text: step.blockedReason ?? 'Another agent worked in this folder at the same time, so this step cannot be rolled back.' }
  } else if (step.blockedReason) {
    blocked = { heading: 'Cannot roll back', text: step.blockedReason }
  }
  if (blocked) return { blocked, canRollback: false, canRetry: false, retryDirection: null, canRedo: false, partialNote: null }
  if (!step.rolledBack && step.partial === true) {
    // A roll back that failed before changing anything: Retry is the way forward, with nothing to redo.
    return {
      blocked: null,
      canRollback: false,
      canRetry: true,
      retryDirection: 'rollback',
      canRedo: false,
      partialNote: 'Nothing was rolled back yet: some files could not be changed. Retry to try again.'
    }
  }
  const partial = step.rolledBack && step.partial === true
  const direction = step.partialDirection ?? 'rollback'
  if (partial && direction === 'redo') {
    // A redo stopped halfway: Retry finishes it, Roll back undoes what it restored.
    return {
      blocked: null,
      canRollback: true,
      canRetry: true,
      retryDirection: 'redo',
      canRedo: false,
      partialNote: 'Redo is only partly done: some files could not be changed. Retry to finish it, or Roll back to undo it.'
    }
  }
  return {
    blocked: null,
    canRollback: !step.rolledBack,
    canRetry: partial,
    retryDirection: partial ? 'rollback' : null,
    canRedo: step.rolledBack,
    partialNote: partial ? 'Partly rolled back: some files could not be changed. Retry to finish it, or Redo to put them back.' : null
  }
}

/** The badge text for a file in a result: the engine's own note, never a guess. */
export function fileLabel(file: RollbackFile): string {
  if (file.action === 'rewound') return 'rewound'
  if (file.action === 'restored') return 'restored'
  if (file.error) return file.note || 'could not be written'
  return `kept: ${file.note || 'you edited it since'}`
}

export interface ResultView {
  /** The request was refused: show only this, with no file badges, no Redo and no "not touched" line. */
  refusal: string | null
  showFiles: boolean
  canRedo: boolean
  retry: boolean
  /** The direction Retry continues: the operation that produced this result. */
  retryDirection: 'rollback' | 'redo'
}

export function viewResult(result: RollbackResult): ResultView {
  if (result.refused) return { refusal: result.refused, showFiles: false, canRedo: false, retry: false, retryDirection: result.direction ?? 'rollback' }
  const failed = result.files.some((f) => f.error) || !result.verified
  const rewound = result.files.some((f) => f.action === 'rewound' || f.action === 'restored')
  const direction = result.direction ?? 'rollback'
  // After a redo, "Redo" would do nothing; the way back is a roll back, offered from the step itself.
  return { refusal: null, showFiles: true, canRedo: rewound && direction === 'rollback', retry: failed, retryDirection: direction }
}
