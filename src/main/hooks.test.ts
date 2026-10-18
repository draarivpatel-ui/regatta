// The hook server answers UserPromptSubmit and Stop only after the listener's promise settles.

import { afterEach, describe, expect, it } from 'vitest'
import { HookServer } from './hooks'

const servers: HookServer[] = []
afterEach(() => servers.splice(0).forEach((s) => s.stop()))

async function post(server: HookServer, session: string, event: string): Promise<number> {
  const res = await fetch(server.url(session, event), { method: 'POST', body: '{}' })
  return res.status
}

describe('HookServer', () => {
  it('holds the answer to UserPromptSubmit and Stop until the listener finishes', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const server = new HookServer(() => gate)
    servers.push(server)
    await server.start()

    for (const event of ['UserPromptSubmit', 'Stop']) {
      let answered = false
      const request = post(server, 'abc', event).then((status) => {
        answered = true
        return status
      })
      await new Promise((r) => setTimeout(r, 80))
      expect(answered).toBe(false)
      release()
      expect(await request).toBe(204)
      // arm the next round
      const next = new Promise<void>((r) => (release = r))
      ;(server as unknown as { listener: () => Promise<void> }).listener = () => next
    }
  })

  it('answers other events at once and still answers when the listener fails', async () => {
    const never = new Promise<void>(() => {})
    const server = new HookServer((_id, event) => (event === 'PreToolUse' ? never : Promise.reject(new Error('boom'))))
    servers.push(server)
    await server.start()
    expect(await post(server, 'abc', 'PreToolUse')).toBe(204)
    expect(await post(server, 'abc', 'UserPromptSubmit')).toBe(204)
  })

  it('gives the two awaited hooks a 30 second curl limit and keeps 2 seconds for the rest', async () => {
    const server = new HookServer(() => {})
    await server.start()
    servers.push(server)
    const hooks = JSON.parse(server.claudeSettings('abc')).hooks as Record<string, { hooks: { command: string; timeout?: number }[] }[]>
    for (const [event, entries] of Object.entries(hooks)) {
      const command = entries[0]!.hooks[0]!.command
      if (event === 'UserPromptSubmit' || event === 'Stop') {
        expect(command).toContain('curl -s -m 30 ')
        expect(entries[0]!.hooks[0]!.timeout).toBeGreaterThan(30)
      } else expect(command).toContain('curl -s -m 2 ')
    }
  })
})
