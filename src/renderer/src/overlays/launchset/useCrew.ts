// State for the Start a crew dialog: how many of each agent, and whether each gets its own worktree.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentKind, DetectedAgent, GitStatus, LaunchSetOptions } from '@shared/types'
import { bridge } from '../../lib/bridge'
import { terminalSize } from '../../terminal/registry'

/** How many of one agent a crew may hold. */
export const MAX_PER_AGENT = 4

/** Every installed agent, including the Terminal, in the order agents:list gives them. */
function installedAgents(agents: DetectedAgent[]): DetectedAgent[] {
  return agents.filter((a) => a.installed)
}

/** The first installed agent starts at one, the rest at zero. */
function initialCounts(list: DetectedAgent[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [i, agent] of list.entries()) counts[agent.kind] = i === 0 ? 1 : 0
  return counts
}

/** Electron wraps main errors, so strip the wrapper to show the plain message. */
function plainMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || text
}

export interface Crew {
  agents: DetectedAgent[]
  counts: Record<string, number>
  total: number
  isolate: boolean
  /** Undefined while the first git:status call is in flight, null when this is not a git repo. */
  git: GitStatus | null | undefined
  starting: boolean
  error: string | null
  bump: (kind: AgentKind, delta: number) => void
  setIsolate: (on: boolean) => void
  /** Starts the crew. Returns true when every agent was handed to the main process. */
  start: (focusedId: string | null) => Promise<boolean>
}

export function useCrew(all: DetectedAgent[]): Crew {
  const agents = useMemo(() => installedAgents(all), [all])
  const [counts, setCounts] = useState<Record<string, number>>(() => initialCounts(agents))
  const [isolate, setIsolate] = useState(false)
  const [git, setGit] = useState<GitStatus | null | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Agents can land after the dialog opens, so make sure every row has a count.
  useEffect(() => {
    setCounts((prev) => {
      let next: Record<string, number> | null = null
      for (const agent of agents) {
        if (prev[agent.kind] === undefined) {
          next ??= { ...prev }
          next[agent.kind] = 0
        }
      }
      return next ?? prev
    })
  }, [agents])

  useEffect(() => {
    let alive = true
    bridge
      .invoke('git:status')
      .then((status) => {
        if (alive) setGit(status)
      })
      .catch(() => {
        if (alive) setGit(null)
      })
    return () => {
      alive = false
    }
  }, [])

  const setCount = useCallback((kind: AgentKind, value: number) => {
    setCounts((prev) => ({ ...prev, [kind]: Math.max(0, Math.min(MAX_PER_AGENT, Math.round(value))) }))
  }, [])

  const bump = useCallback(
    (kind: AgentKind, delta: number) => setCount(kind, (counts[kind] ?? 0) + delta),
    [counts, setCount]
  )

  const total = agents.reduce((sum, agent) => sum + (counts[agent.kind] ?? 0), 0)

  const start = useCallback(
    async (focusedId: string | null): Promise<boolean> => {
      const chosen = agents
        .map((agent) => ({ kind: agent.kind, count: counts[agent.kind] ?? 0 }))
        .filter((entry) => entry.count > 0)
      if (chosen.length === 0) return false
      const { cols, rows } = terminalSize(focusedId ?? '')
      const opts: LaunchSetOptions = { agents: chosen, isolate: isolate && git !== null, cols, rows }
      setStarting(true)
      setError(null)
      try {
        await bridge.invoke('launchset:start', opts)
        return true
      } catch (err) {
        setError(plainMessage(err))
        return false
      } finally {
        setStarting(false)
      }
    },
    [agents, counts, git, isolate]
  )

  return { agents, counts, total, isolate, git, starting, error, bump, setIsolate, start }
}