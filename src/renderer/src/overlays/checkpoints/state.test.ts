import { describe, expect, it } from 'vitest'
import type { CheckpointStep, RollbackResult } from '@shared/checkpoints'
import { fileLabel, viewResult, viewStep } from './state'

function step(extra: Partial<CheckpointStep> = {}): CheckpointStep {
  return { id: 's', sessionId: 'x', agent: 'fake', label: 'l', startedAt: 1, endedAt: 2, start: 'a', end: 'b', files: [], rolledBack: false, ...extra }
}

describe('viewStep', () => {
  it('offers a roll back for an ordinary step and a redo after it', () => {
    expect(viewStep(step())).toMatchObject({ canRollback: true, canRedo: false, canRetry: false, blocked: null })
    expect(viewStep(step({ rolledBack: true }))).toMatchObject({ canRollback: false, canRedo: true, canRetry: false })
  })

  it('offers retry and redo for a partial roll back', () => {
    const v = viewStep(step({ rolledBack: true, partial: true }))
    expect(v).toMatchObject({ canRetry: true, retryDirection: 'rollback', canRedo: true, canRollback: false })
    expect(v.partialNote).toMatch(/Partly rolled back/)
  })

  it('offers Retry for a roll back that failed before changing anything', () => {
    const v = viewStep(step({ rolledBack: false, partial: true, partialDirection: 'rollback' }))
    expect(v).toMatchObject({ canRetry: true, retryDirection: 'rollback', canRollback: false, canRedo: false })
    expect(v.partialNote).toMatch(/Nothing was rolled back yet/)
  })

  it('continues a partial redo in the redo direction and offers roll back as the way back', () => {
    const v = viewStep(step({ rolledBack: true, partial: true, partialDirection: 'redo' }))
    expect(v).toMatchObject({ canRetry: true, retryDirection: 'redo', canRedo: false, canRollback: true })
    expect(v.partialNote).toMatch(/Redo is only partly done/)
  })

  it('offers nothing for shared, unprotected and failed steps, and says why', () => {
    const shared = viewStep(step({ shared: true, blockedReason: 'Another agent was here.' }))
    expect(shared).toMatchObject({ canRollback: false, canRedo: false, canRetry: false })
    expect(shared.blocked?.text).toBe('Another agent was here.')
    const unprotected = viewStep(step({ unprotected: 'slow', blockedReason: 'This turn is not protected: slow' }))
    expect(unprotected.blocked).toEqual({ heading: 'Not protected', text: 'This turn is not protected: slow' })
    expect(unprotected.canRollback).toBe(false)
    expect(viewStep(step({ failed: 'Checkpoint end failed: x' })).blocked?.heading).toBe('Checkpoint failed')
  })
})

describe('viewResult and fileLabel', () => {
  const file = { path: 'a', added: 1, removed: 0 }
  it('shows only the refusal for a refused request', () => {
    const r: RollbackResult = { stepId: 's', files: [{ ...file, action: 'kept', note: 'No.' }], verified: false, summary: 'No.', refused: 'No.' }
    expect(viewResult(r)).toEqual({ refusal: 'No.', showFiles: false, canRedo: false, retry: false, retryDirection: 'rollback' })
  })

  it('uses the engine note instead of a fixed badge', () => {
    expect(fileLabel({ ...file, action: 'kept', note: 'not touched: a parent folder is now a symbolic link' })).toBe('kept: not touched: a parent folder is now a symbolic link')
    expect(fileLabel({ ...file, action: 'kept', note: 'could not be written: EACCES', error: true })).toBe('could not be written: EACCES')
    expect(fileLabel({ ...file, action: 'kept', note: '' })).toBe('kept: you edited it since')
  })

  it('offers retry when a failure left no file changed', () => {
    const r: RollbackResult = { stepId: 's', files: [{ ...file, action: 'kept', note: 'x', error: true }], verified: false, summary: 's', direction: 'rollback' }
    expect(viewResult(r)).toMatchObject({ retry: true, canRedo: false })
  })

  it('offers retry when some files failed and some were rewound', () => {
    const r: RollbackResult = {
      stepId: 's',
      files: [{ ...file, action: 'rewound', note: '' }, { ...file, path: 'b', action: 'kept', note: 'x', error: true }],
      verified: false,
      summary: 's'
    }
    expect(viewResult(r)).toMatchObject({ canRedo: true, retry: true, retryDirection: 'rollback' })
    expect(viewResult({ ...r, direction: 'redo' })).toMatchObject({ canRedo: false, retry: true, retryDirection: 'redo' })
  })
})
