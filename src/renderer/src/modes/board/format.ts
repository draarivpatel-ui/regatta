// Small helpers for the Board: the icon and color each kind reads as, the action labels, where a
// click takes you, and how each card action dispatches to its engine.

import { ListChecks, Moon, ShipWheel, SquareTerminal, Workflow, type LucideIcon } from 'lucide-react'
import { hasSingleWinner, retryHeatOptions, type BoardAction, type BoardCard, type BoardKind, type RetryableHeat } from '@shared/board'
import type { FlowRun } from '@shared/flows'
import type { RegattaBridge } from '@shared/ipc'
import type { Task } from '@shared/tasks'
import { useFlows } from '../../store/flows'
import { useHeats } from '../../store/heats'
import { useNight } from '../../store/night'
import { useSessions } from '../../store/sessions'
import { useUi } from '../../store/ui'

export const KIND_ICON: Record<BoardKind, LucideIcon> = {
  task: ListChecks,
  heat: ShipWheel,
  night: Moon,
  flow: Workflow,
  pane: SquareTerminal
}

export const ACTION_LABEL: Record<BoardAction, string> = {
  run: 'Run',
  stop: 'Stop',
  retry: 'Retry',
  sendback: 'Send back',
  merge: 'Merge',
  choose: 'Open in Skipper to choose',
  approve: 'Approve',
  markdone: 'Mark done',
  archive: 'Archive'
}

const PREFIX: Record<string, string> = { night: 'night-', nightq: 'nightq-', flow: 'flow-' }

export function strip(prefix: string, id: string): string {
  const mark = PREFIX[prefix]
  return mark && id.startsWith(mark) ? id.slice(mark.length) : id
}

/** The place a card lives: switch to that mode or open that overlay on the item itself. */
export function openCard(card: BoardCard): void {
  const ui = useUi.getState()
  switch (card.kind) {
    case 'task': {
      ui.setMode('agents')
      const activateTasks = (): boolean => {
        if (typeof document === 'undefined') return false
        const tab = document.querySelector<HTMLElement>('[data-testid=automate-tasks]')
        if (!tab) return false
        tab.click()
        return true
      }
      if (!activateTasks() && typeof queueMicrotask === 'function') {
        queueMicrotask(() => {
          activateTasks()
        })
      }
      break
    }
    case 'heat':
      useHeats.getState().select(card.id)
      ui.openOverlay('skipper')
      break
    case 'night': {
      const nightStore = useNight.getState()
      if (card.id.startsWith('nightq-')) {
        nightStore.select('tonight')
      } else {
        const runId = strip('night', card.id)
        const night = nightStore.state?.nights.find((n) => n.runs.some((r) => r.id === runId)) ?? nightStore.state?.nights[0]
        if (night) nightStore.select(night.id)
        nightStore.selectRun(runId)
      }
      ui.openOverlay('night')
      break
    }
    case 'flow': {
      const runId = strip('flow', card.id)
      const flowsStore = useFlows.getState()
      const run = flowsStore.runs.find((r) => r.id === runId)
      if (run) {
        flowsStore.selectFlow(run.flowId)
        if (useFlows.getState().selectedFlowId !== run.flowId) {
          useFlows.setState({ selectedFlowId: run.flowId })
        }
      }
      ui.setMode('flows')
      const focusRunCard = (): boolean => {
        if (typeof document === 'undefined') return false
        let el = document.querySelector<HTMLElement>(`[data-testid=flow-run-card][data-run-id="${runId}"]`)
        if (!el) {
          const more = document.querySelector<HTMLElement>('[data-testid=flow-runs-more]')
          if (more) {
            more.click()
            el = document.querySelector<HTMLElement>(`[data-testid=flow-run-card][data-run-id="${runId}"]`)
          }
        }
        if (!el) return false
        const toggle = el.querySelector<HTMLElement>('[data-testid=flow-run-toggle]')
        if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click()
        el.scrollIntoView?.({ block: 'nearest' })
        return true
      }
      if (!focusRunCard() && typeof queueMicrotask === 'function') {
        queueMicrotask(() => {
          focusRunCard()
        })
      }
      break
    }
    case 'pane':
      ui.setMode('code')
      useSessions.getState().focus(card.id)
      break
  }
}

export interface DispatchCardDeps {
  tasks: Task[]
  heats: RetryableHeat[]
  runs: FlowRun[]
  invoke: RegattaBridge['invoke']
  archive: (id: string) => Promise<unknown>
  openSkipper?: (heatId: string) => void
}

/** Calls the engine's own channel for a card action. The board does nothing to git or files itself. */
export async function dispatchCardAction(card: BoardCard, action: BoardAction, deps: DispatchCardDeps): Promise<void> {
  const id = card.id
  if (action === 'archive') {
    await deps.archive(id)
    return
  }
  if (action === 'choose') {
    const heatId = card.kind === 'task' ? deps.tasks.find((t) => t.id === id)?.heatId ?? null : card.kind === 'heat' ? id : null
    if (heatId) {
      if (deps.openSkipper) {
        deps.openSkipper(heatId)
      } else {
        useHeats.getState().select(heatId)
        useUi.getState().openOverlay('skipper')
      }
    }
    return
  }
  if (action === 'approve') {
    if (card.kind === 'flow') await deps.invoke('flows:approve', strip('flow', id))
    return
  }
  if (action === 'run' && card.kind === 'task') {
    await deps.invoke('tasks:run', id)
  } else if (action === 'retry') {
    if (card.kind === 'task') {
      await deps.invoke('tasks:run', id)
    } else if (card.kind === 'flow') {
      const run = deps.runs.find((r) => r.id === strip('flow', id))
      if (run) {
        await deps.invoke('flows:run', run.flowId)
        await deps.archive(id)
      }
    } else if (card.kind === 'heat') {
      const heat = deps.heats.find((h) => h.id === id)
      if (heat) {
        await deps.invoke('heats:start', retryHeatOptions(heat))
        await deps.archive(id)
      }
    }
  } else if (action === 'stop') {
    if (card.kind === 'pane') await deps.invoke('session:kill', id)
    else if (card.kind === 'flow') await deps.invoke('flows:stop', strip('flow', id))
    else if (card.kind === 'heat') await deps.invoke('heats:cancel', id)
    else if (card.kind === 'task') {
      const heatId = deps.tasks.find((t) => t.id === id)?.heatId
      if (heatId) await deps.invoke('heats:cancel', heatId)
    }
  } else if (action === 'merge') {
    if (card.kind === 'task') {
      const heatId = deps.tasks.find((t) => t.id === id)?.heatId
      const heat = deps.heats.find((h) => h.id === heatId)
      const lane = hasSingleWinner(heat) ? heat?.decision?.laneIds[0] : undefined
      if (heatId && lane) await deps.invoke('heats:merge', heatId, lane)
    } else if (card.kind === 'heat') {
      const heat = deps.heats.find((h) => h.id === id)
      const lane = hasSingleWinner(heat) ? heat?.decision?.laneIds[0] : undefined
      if (lane) await deps.invoke('heats:merge', id, lane)
    } else if (card.kind === 'night') {
      await deps.invoke('night:merge', strip('night', id))
    } else if (card.kind === 'flow') {
      await deps.invoke('flows:merge', strip('flow', id))
    }
  } else if (action === 'markdone') {
    await deps.invoke('tasks:done', id)
  }
}

export interface SendBackDeps {
  updateTask: (id: string, patch: { note: string }) => Promise<Task[] | null>
  sendBackBoard: (id: string, note: string) => Promise<boolean>
  hasBoardNote?: boolean
}

/** Sends a card back with a note: a task goes through Tasks so its note is kept and it returns to To do. */
export async function submitSendBack(card: BoardCard, note: string, deps: SendBackDeps): Promise<boolean> {
  if (card.kind === 'task') {
    const updated = await deps.updateTask(card.id, { note })
    if (!updated) return false
    if (deps.hasBoardNote) await deps.sendBackBoard(card.id, '')
    return true
  }
  return deps.sendBackBoard(card.id, note)
}
