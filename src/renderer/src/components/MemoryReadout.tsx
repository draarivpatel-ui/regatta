// Total memory used by all agents, shown at the right end of the status strip.

import { useEffect } from 'react'
import { create } from 'zustand'
import type { MemorySample } from '@shared/types'
import { bridge } from '../lib/bridge'
import { formatBytes } from '../lib/bytes'
import { useSessions } from '../store/sessions'

interface MemoryState {
  samples: MemorySample[] | null
  setSamples: (samples: MemorySample[]) => void
}

/** Latest per session memory samples. Null until the first sample arrives. */
export const useMemory = create<MemoryState>((set) => ({
  samples: null,
  setSamples: (samples) => set({ samples })
}))

export function MemoryReadout(): React.JSX.Element {
  const samples = useMemory((s) => s.samples)
  const sessions = useSessions((s) => s.sessions)

  useEffect(() => {
    const off = bridge.on('session:memory', (next) => useMemory.getState().setSamples(next))
    return off
  }, [])

  // A pane that just started has no measured memory yet: keep saying so instead of "0 B".
  if (!samples || (samples.length > 0 && samples.every((s) => s.rssBytes === 0))) {
    return (
      <span data-testid="memory-readout" className="text-faint">
        Memory: measuring…
      </span>
    )
  }

  const total = samples.reduce((sum, s) => sum + s.rssBytes, 0)
  const lines = samples.map((s) => {
    const name = sessions[s.id]?.title ?? s.id
    return `${name}: ${formatBytes(s.rssBytes)}`
  })

  return (
    <span data-testid="memory-readout" className="text-faint" title={lines.join('\n')}>
      Memory: {formatBytes(total)}
    </span>
  )
}
