// Live dictation status for Settings. Subscribes to dictation:changed.

import { useEffect, useState } from 'react'
import type { DictationStatus } from '@shared/dictation'
import { bridge } from '../../../lib/bridge'

export function useDictationStatus(): { status: DictationStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<DictationStatus | null>(null)

  useEffect(() => {
    let alive = true
    bridge
      .invoke('dictation:status')
      .then((next) => {
        if (alive) setStatus(next)
      })
      .catch(() => undefined)
    const off = bridge.on('dictation:changed', (next) => setStatus(next))
    return () => {
      alive = false
      off()
    }
  }, [])

  return {
    status,
    refresh: () => {
      bridge
        .invoke('dictation:status')
        .then((next) => setStatus(next))
        .catch(() => undefined)
    }
  }
}
