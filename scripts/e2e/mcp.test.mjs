// Settings > MCP: turn the server on, then talk to it from this test process the way a client would.

import { launch } from './lib.mjs'

/** Posts one JSON-RPC message to the server, with or without a token. */
async function rpc(url, token, message, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: JSON.stringify(message)
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

export default async function mcp() {
  const t = await launch('mcp')
  const { win } = t

  await t.step('section opens', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-mcp]')
    await win.locator('[data-testid=mcp-toggle]').waitFor({ timeout: 8000 })
    t.check('the MCP section is there', true)
    await win.waitForFunction(
      () => document.querySelector('[data-testid=mcp-status]')?.textContent?.trim() !== 'Reading settings',
      null,
      { timeout: 8000 }
    )
    const status = await win.locator('[data-testid=mcp-status]').textContent()
    t.check('the server starts off', String(status).trim() === 'Off', String(status).trim())
    const chips = await win.locator('[data-testid=mcp-tool]').count()
    t.check('the tools are listed as chips', chips > 0, `${chips} chips`)
    await t.shot('01-mcp-off')
  })

  await t.step('turning it on', async () => {
    await win.click('[data-testid=mcp-toggle]')
    await win.waitForFunction(
      () => document.querySelector('[data-testid=mcp-status]')?.textContent?.startsWith('On at ') === true,
      null,
      { timeout: 10000 }
    )
    const status = String(await win.locator('[data-testid=mcp-status]').textContent()).trim()
    t.check('the status line shows the URL', /^On at http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(status), status)
    const snippet = await win.locator('[data-testid=mcp-snippet]').textContent()
    t.check('the Claude Code snippet is on screen', String(snippet).includes('claude mcp add --transport http'), String(snippet).slice(0, 40))
    t.check('the snippet hides most of the token', String(snippet).includes('rgt_'), 'shows the hint')
    t.check('the off note is gone', (await win.locator('[data-testid=mcp-off-note]').count()) === 0)
    await t.shot('02-mcp-on-claude')
  })

  let url = null
  let token = null

  await t.step('reads the url and token from the app', async () => {
    const state = await win.evaluate(() => window.regatta.invoke('mcp:state'))
    token = await win.evaluate(() => window.regatta.invoke('mcp:token'))
    url = state.url
    t.check('the app reports a URL', typeof url === 'string' && url.startsWith('http://127.0.0.1:'), String(url))
    t.check('the app reports a token', typeof token === 'string' && token.startsWith('rgt_'), String(token).slice(0, 8))
    t.check('the running state is on', state.running === true && state.error === null, String(state.error))
    await t.shot('03-mcp-token')
    await win.locator('[data-testid=mcp-show]').click()
    await win.waitForFunction(
      (full) => document.querySelector('[data-testid=mcp-token]')?.textContent === full,
      token,
      { timeout: 5000 }
    )
    t.check('Show reveals the whole token', (await win.locator('[data-testid=mcp-token]').textContent()) === token)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    t.check('escape closes settings', (await win.locator('[data-testid=settings-screen]').count()) === 0)
  })

  await t.step('a shell pane', async () => {
    await t.startAgent('Terminal')
    t.check('a shell pane is open', (await win.locator('[data-testid=pane]').count()) === 1)
  })

  await t.step('older handshake', async () => {
    const init = await rpc(url, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'regatta-e2e', version: '1' } }
    })
    t.check('initialize answers 200', init.status === 200, `${init.status}`)
    t.check(
      'initialize reports the server',
      init.json?.result?.serverInfo?.name === 'regatta' && init.json?.result?.protocolVersion === '2025-11-25',
      JSON.stringify(init.json?.result?.serverInfo ?? {})
    )
    t.check('initialize lists the tool capability', init.json?.result?.capabilities?.tools?.listChanged === false)

    const list = await rpc(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = (list.json?.result?.tools ?? []).map((x) => x.name)
    t.check('tools/list has the regatta tools', names.includes('regatta_list_panes'), names.join(', '))

    const sessionId = await t.sessionId(0)
    const call = await rpc(url, token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'regatta_list_panes', arguments: {} }
    })
    const panes = call.json?.result?.structuredContent?.panes ?? []
    t.check('a tool call answers with text', call.json?.result?.content?.[0]?.text?.includes('Terminal'), String(call.json?.result?.content?.[0]?.text ?? '').slice(0, 60))
    t.check('the shell pane is listed', panes.some((p) => p.id === sessionId), sessionId)
  })

  await t.step('per-request protocol', async () => {
    const reply = await rpc(
      url,
      token,
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
      { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }
    )
    t.check('modern tools/list answers 200', reply.status === 200, `${reply.status}`)
    t.check('the answer is complete', reply.json?.result?.resultType === 'complete')
    t.check(
      'modern tools/list has the tools',
      (reply.json?.result?.tools ?? []).some((x) => x.name === 'regatta_read_pane'),
      String((reply.json?.result?.tools ?? []).length)
    )
  })

  await t.step('without the token', async () => {
    const denied = await rpc(url, null, { jsonrpc: '2.0', id: 5, method: 'tools/list' })
    t.check('a request with no token is refused', denied.status === 401, `${denied.status}`)
    const wrong = await rpc(url, 'rgt_not-the-token', { jsonrpc: '2.0', id: 6, method: 'tools/list' })
    t.check('a request with the wrong token is refused', wrong.status === 401, `${wrong.status}`)
  })

  await t.step('turning it off', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-mcp]')
    await win.locator('[data-testid=mcp-toggle]').waitFor({ timeout: 8000 })
    await win.click('[data-testid=mcp-toggle]')
    await win.waitForFunction(
      () => document.querySelector('[data-testid=mcp-status]')?.textContent?.trim() === 'Off',
      null,
      { timeout: 10000 }
    )
    t.check('the server goes back to off', true)
    t.check('the off note is back', (await win.locator('[data-testid=mcp-off-note]').count()) === 1)
    await t.shot('04-mcp-off-note')
    await win.keyboard.press('Escape')
  })

  return t.close()
}