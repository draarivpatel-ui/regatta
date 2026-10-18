// Settings > Agent tools: add the fake MCP server, verify it, see its two tools, turn it on,
// open a Test Agent pane and see "MCP servers: <id>", then edit arguments to see it turned off
// and "Changed since verified".

import { join } from 'node:path'
import { launch, repo } from './lib.mjs'

export default async function agentTools() {
  const t = await launch('agent-tools')
  const { win } = t
  const fakeMcp = join(repo, 'scripts', 'fake-mcp-server.mjs')
  const id = 'notes-mcp'

  await t.step('opens agent tools settings', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-agentTools]')
    await win.waitForSelector('[data-testid=agent-tools-add]', { timeout: 8000 })
    t.check('agent tools section opens', true)
  })

  await t.step('adds the fake MCP server with masked env', async () => {
    await win.click('[data-testid=agent-tools-add]')
    await win.waitForSelector('[data-testid=agent-tools-form]', { timeout: 8000 })
    await win.fill('[data-testid=agent-tools-name]', id)
    await win.fill('[data-testid=agent-tools-command]', process.execPath)
    await win.fill('[data-testid=agent-tools-args]', fakeMcp)
    await win.fill('[data-testid=agent-tools-env]', 'SECRET_KEY=my-secret-val')
    await win.click('[data-testid=agent-tools-save]')

    const card = win.locator(`[data-testid=agent-tool-${id}]`)
    await card.waitFor({ timeout: 8000 })
    const text = (await card.textContent()) ?? ''
    t.check('server card shows Not verified', text.includes('Not verified'), text.slice(0, 120))
    t.check('env value is masked after saving', text.includes('SECRET_KEY=********') && !text.includes('my-secret-val'))

    const toggle = win.locator(`[data-testid=agent-tool-toggle-${id}]`)
    t.check('toggle is disabled before verification', await toggle.isDisabled())

    await win.click(`[data-testid=agent-tool-env-show-${id}]`)
    const shownText = (await card.textContent()) ?? ''
    t.check('show button reveals env value', shownText.includes('SECRET_KEY=my-secret-val'))
  })

  await t.step('verifies the server and shows its two tools', async () => {
    await win.click(`[data-testid=agent-tool-verify-${id}]`)
    const toolsBox = win.locator(`[data-testid=agent-tool-tools-${id}]`)
    await toolsBox.waitFor({ timeout: 15000 })
    const toolsText = (await toolsBox.textContent()) ?? ''
    t.check(
      'both tools and descriptions are shown',
      toolsText.includes('read_notes') && toolsText.includes('write_note'),
      toolsText.slice(0, 140)
    )
    const stateText = (await win.locator(`[data-testid=agent-tool-state-${id}]`).textContent()) ?? ''
    t.check('badge reads Verified with 2 tools', stateText.includes('Verified with 2 tools'), stateText)
    await t.shot('01-agent-tools-verified')
  })

  await t.step('turns the server on and passes it to a Test Agent pane', async () => {
    const toggle = win.locator(`[data-testid=agent-tool-toggle-${id}]`)
    await toggle.click()
    await win.waitForFunction(
      (srvId) => document.querySelector(`[data-testid=agent-tool-toggle-${srvId}]`)?.getAttribute('aria-checked') === 'true',
      id,
      { timeout: 8000 }
    )
    const stateText = (await win.locator(`[data-testid=agent-tool-state-${id}]`).textContent()) ?? ''
    t.check('badge reads Turned on', stateText.includes('Turned on'), stateText)
    await t.shot('02-agent-tools-on')

    // Close settings and start a Test Agent pane.
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    await t.startAgent('Test Agent')
    await win.waitForFunction(
      (srvId) => {
        const panes = document.querySelectorAll('[data-testid=pane]')
        const sessionId = panes[0]?.getAttribute('data-session')
        if (!sessionId || typeof window.__regattaText !== 'function') return false
        const text = window.__regattaText(sessionId)
        return String(text).includes(`MCP servers: ${srvId}`)
      },
      id,
      { timeout: 10000 }
    )
    const paneText = await t.textOf(0)
    t.check('Test Agent pane shows MCP servers line', paneText.includes(`MCP servers: ${id}`), paneText.slice(0, 120))
    await t.shot('03-pane-with-mcp')
  })

  await t.step('editing arguments turns the server off and shows Changed since verified', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-agentTools]')
    await win.waitForSelector(`[data-testid=agent-tool-${id}]`, { timeout: 8000 })

    await win.click(`[data-testid=agent-tool-edit-${id}]`)
    await win.waitForSelector('[data-testid=agent-tools-form]', { timeout: 8000 })
    await win.fill('[data-testid=agent-tools-args]', `${fakeMcp}\n--noisy`)
    await win.click('[data-testid=agent-tools-save]')

    await win.waitForFunction(
      (srvId) =>
        (document.querySelector(`[data-testid=agent-tool-state-${srvId}]`)?.textContent ?? '').includes('Changed since verified'),
      id,
      { timeout: 8000 }
    )
    const toggle = win.locator(`[data-testid=agent-tool-toggle-${id}]`)
    const checked = await toggle.getAttribute('aria-checked')
    const disabled = await toggle.isDisabled()
    t.check('server is turned off and toggle disabled after edit', checked === 'false' && disabled, `checked=${checked}`)
    t.check('Changed since verified badge shows', true)
    await t.shot('04-changed-since-verified')
  })

  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  return t.close()
}
