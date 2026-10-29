// A tiny local HTTP server that agents report their events to.
// Claude Code gets hooks through --settings; Codex gets a notify command through -c.

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

/** May return a promise; for the events in AWAITED_EVENTS the server answers only once it settles. */
export type HookListener = (sessionId: string, event: string, payload: unknown) => void | Promise<void>

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionEnd'
] as const

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse'])

/**
 * Hooks the agent waits for: Claude Code does not start a turn until UserPromptSubmit returns, and does
 * not stop until Stop returns, so the checkpoint snapshot can complete inside them.
 */
const AWAITED_EVENTS = new Set(['UserPromptSubmit', 'Stop'])
const AWAITED_CURL_SECONDS = 30
const DEFAULT_CURL_SECONDS = 2

export class HookServer {
  readonly token = randomBytes(16).toString('hex')
  private server: Server | null = null
  port = 0

  constructor(private readonly listener: HookListener) {}

  start(): Promise<number> {
    this.server = createServer((req, res) => {
      // Any local program can connect: a request target that is not a URL is refused, never thrown.
      let url: URL
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch {
        res.writeHead(400).end()
        return
      }
      const match = /^\/hook\/([\w-]+)\/([\w-]+)$/.exec(url.pathname)
      if (req.method !== 'POST' || !match || url.searchParams.get('t') !== this.token) {
        res.writeHead(404).end()
        return
      }
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 256 * 1024) req.destroy()
      })
      req.on('end', () => {
        let payload: unknown = {}
        try {
          payload = body ? JSON.parse(body) : {}
        } catch {
          payload = { raw: body.slice(0, 2000) }
        }
        const answer = (): void => {
          if (!res.writableEnded) res.writeHead(204).end()
        }
        let pending: void | Promise<void>
        try {
          pending = this.listener(match[1]!, match[2]!, payload)
        } catch {
          answer()
          return
        }
        if (AWAITED_EVENTS.has(match[2]!) && pending) void Promise.resolve(pending).then(answer, answer)
        else answer()
      })
    })
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        resolve(this.port)
      })
    })
  }

  stop(): void {
    this.server?.close()
  }

  url(sessionId: string, event: string): string {
    return `http://127.0.0.1:${this.port}/hook/${sessionId}/${event}?t=${this.token}`
  }

  /** JSON for `claude --settings` that reports every hook event to this server. */
  claudeSettings(sessionId: string): string {
    const hooks: Record<string, unknown[]> = {}
    for (const event of CLAUDE_EVENTS) {
      const seconds = AWAITED_EVENTS.has(event) ? AWAITED_CURL_SECONDS : DEFAULT_CURL_SECONDS
      const command = `curl -s -m ${seconds} -X POST -H 'Content-Type: application/json' --data-binary @- '${this.url(sessionId, event)}' >/dev/null 2>&1 || true`
      const hook: Record<string, unknown> = { type: 'command', command }
      if (AWAITED_EVENTS.has(event)) hook['timeout'] = AWAITED_CURL_SECONDS + 5
      const entry: Record<string, unknown> = { hooks: [hook] }
      if (TOOL_EVENTS.has(event)) entry['matcher'] = '*'
      hooks[event] = [entry]
    }
    return JSON.stringify({ hooks })
  }

  /** Arguments for `codex` so it calls us when a turn completes. Codex appends the event JSON. */
  codexArgs(sessionId: string): string[] {
    const parts = ['curl', '-s', '-m', '2', '-X', 'POST', '-H', 'Content-Type: application/json', this.url(sessionId, 'notify'), '--data-binary']
    return ['-c', `notify=[${parts.map((p) => JSON.stringify(p)).join(',')}]`]
  }
}
