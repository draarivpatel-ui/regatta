// Checkpoints: every agent step can be rolled back. See docs/design/checkpoints.md.

import type { AgentKind } from './types'

export interface StepFile {
  path: string
  added: number
  removed: number
}

/** Something a snapshot left out on purpose, for example a file over the size limit. */
export interface SkippedItem {
  path: string
  reason: string
}

export interface CheckpointStep {
  id: string
  sessionId: string
  agent: AgentKind
  /** The prompt that started the step, or a time label. */
  label: string
  startedAt: number
  endedAt: number
  /** Shadow commit before and after the step. */
  start: string
  end: string
  files: StepFile[]
  /** Set after a roll back, cleared after a redo. */
  rolledBack: boolean
  /** Another agent worked in the same folder at the same time, so the step cannot be rolled back safely. */
  shared?: boolean
  /** Why this step cannot be rolled back or redone (shared work, a failed checkpoint). Show it next to the step. */
  blockedReason?: string
  /** The opening snapshot failed or was too slow, so the agent ran unprotected. The text says why; no roll back is offered. */
  unprotected?: string
  /** The checkpoint itself failed (for example a locked index). The text says what went wrong. */
  failed?: string
  /** A roll back (or redo) wrote some files and then stopped; run it again or redo to finish or reverse it. */
  partial?: boolean
  /** Which operation a partial step was left in the middle of: Retry continues this one. */
  partialDirection?: 'rollback' | 'redo'
  /** Files and folders left out of the snapshots on purpose (too big, or a build folder). */
  skipped?: SkippedItem[]
}

export interface RollbackFile extends StepFile {
  action: 'rewound' | 'kept' | 'restored'
  /** Why a file was kept, for example "you edited it since". */
  note: string
  /** The file could not be written (a disk or git failure), as opposed to being kept because the user edited it. */
  error?: boolean
}

export interface RollbackResult {
  stepId: string
  files: RollbackFile[]
  /** Every rewound or restored file was read back and matched. */
  verified: boolean
  /** For example "Rewound 3 of 4 files +21 -25". */
  summary: string
  /** Set when nothing was changed because the request was refused; the text is the reason. */
  refused?: string
  /** Which operation this result belongs to; Retry continues the same direction. */
  direction?: 'rollback' | 'redo'
}
