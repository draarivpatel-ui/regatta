// Notifier: desktop notifications for agent state changes.

import { Notification } from 'electron'
import type { SessionInfo, SessionState, SessionStatus } from '../shared/types'
import { AGENTS } from '../shared/agents'

export interface NotifierDeps {
  prefs: () => { notifications: boolean }
  session: (id: string) => SessionInfo | undefined
  windowFocused: () => boolean
  focusSession: (id: string) => void
  now?: () => number
}

export type NotificationFactory = (opts: {
  title: string
  body: string
  onClick: () => void
}) => { show(): void; onclick: (() => void) | null }

const RATE_LIMIT_MS = 10_000
const LONG_TURN_MS = 20_000

interface LastNotify {
  at: number
  state: SessionState
}

export class Notifier {
  private lastNotify = new Map<string, LastNotify>()
  private workingSince = new Map<string, number>()
  private live = new Set<Notification>()
  private readonly now: () => number

  constructor(
    private readonly deps: NotifierDeps,
    private readonly factory?: NotificationFactory
  ) {
    this.now = deps.now ?? Date.now
  }

  onStatus(id: string, status: SessionStatus, previous: SessionStatus | null): void {
    if (!this.deps.prefs().notifications) return
    if (this.deps.windowFocused()) return

    const session = this.deps.session(id)
    if (!session) return

    const agentDef = AGENTS[session.agent]
    const agentName = agentDef?.name ?? session.agent
    const folderName = session.cwd.split('/').pop() ?? session.cwd

    let title = ''
    let body = ''
    let shouldNotify = false

    switch (status.state) {
      case 'waiting': {
        if (previous?.state === 'waiting') {
          const last = this.lastNotify.get(id)
          const t = this.now()
          if (last && t - last.at < RATE_LIMIT_MS) break
        }
        title = `${agentName} needs you`
        body = status.reason
        shouldNotify = true
        break
      }
      case 'idle': {
        if (previous?.state !== 'working') break
        const started = this.workingSince.get(id)
        if (!started) break
        const duration = this.now() - started
        if (duration < LONG_TURN_MS) break
        title = `${agentName} is ready`
        body = `Finished its turn in ${folderName}.`
        shouldNotify = true
        break
      }
      case 'failed': {
        title = `${agentName} stopped`
        body = status.reason
        shouldNotify = true
        break
      }
      case 'working': {
        if (previous?.state !== 'working') {
          this.workingSince.set(id, status.since)
        }
        break
      }
      default: {
        this.workingSince.delete(id)
        break
      }
    }

    if (!shouldNotify) return

    const last = this.lastNotify.get(id)
    const t = this.now()
    if (last && t - last.at < RATE_LIMIT_MS) return

    this.lastNotify.set(id, { at: t, state: status.state })
    this.showNotification(title, body, () => this.deps.focusSession(id))
  }

  private showNotification(title: string, body: string, onClick: () => void): void {
    if (this.factory) {
      const notif = this.factory({ title, body, onClick })
      notif.onclick = onClick
      notif.show()
      return
    }
    // Electron notifications report clicks as an event, and must stay referenced until then
    // or they can be garbage collected and the click is lost.
    const notif = new Notification({ title, body })
    this.live.add(notif)
    notif.on('click', () => {
      this.live.delete(notif)
      onClick()
    })
    notif.on('close', () => this.live.delete(notif))
    notif.show()
  }
}