// Reasoning picker in Chat mode: shows for Claude and Codex, hidden for Test Agent,
// persists across reopen, resets when agent changes.

import { launch } from './lib.mjs'

export default async function reasoning() {
  // `claude` and `codex` in the fake world are stand-ins that run the fake agent, so the picker can be tried for both.
  const t = await launch('reasoning')
  const { win } = t

  await t.step('switch to chat mode', async () => {
    await win.keyboard.press('Meta+3')
    await win.waitForSelector('[data-testid="chat-mode"]', { timeout: 8000 })
    t.check('chat mode opens', (await win.locator('[data-testid="chat-mode"]').count()) === 1)
    await t.shot('01-chat-mode')
  })

  await t.step('start a new chat with Claude Code', async () => {
    await win.click('[data-testid="chat-new"]')
    await win.waitForSelector('[data-testid="chat-input"]', { timeout: 8000 })
    await win.waitForSelector('[data-testid="chat-agent"]', { timeout: 8000 })
    await win.selectOption('[data-testid="chat-agent"]', { label: 'Claude Code' })
    await win.waitForTimeout(500)
    t.check('composer appears', (await win.locator('[data-testid="chat-input"]').count()) === 1)
    await t.shot('02-new-chat-claude')
  })

  await t.step('reasoning picker has six options for Claude Code', async () => {
    await win.waitForSelector('[data-testid="chat-reasoning"]', { timeout: 8000 })
    const options = await win.locator('[data-testid="chat-reasoning"] option').allTextContents()
    const expected = ['Default effort', 'Low effort', 'Medium effort', 'High effort', 'Extra high effort', 'Max effort']
    t.check('six reasoning options for Claude', JSON.stringify(options) === JSON.stringify(expected), options.join(', '))
    await t.shot('03-reasoning-options-claude')
  })

  await t.step('choose High reasoning', async () => {
    await win.selectOption('[data-testid="chat-reasoning"]', { label: 'High effort' })
    await win.waitForTimeout(300)
    const value = await win.locator('[data-testid="chat-reasoning"]').inputValue()
    t.check('High selected', value === 'high', value)
    await t.shot('04-high-selected')
  })

  await t.step('close and reopen chat mode, High persists', async () => {
    await win.keyboard.press('Meta+1')
    await win.waitForTimeout(500)
    await win.keyboard.press('Meta+3')
    await win.waitForSelector('[data-testid="chat-mode"]', { timeout: 8000 })
    await win.waitForSelector('[data-testid="chat-reasoning"]', { timeout: 8000 })
    const value = await win.locator('[data-testid="chat-reasoning"]').inputValue()
    t.check('High persists after reopen', value === 'high', value)
    await t.shot('05-persists-after-reopen')
  })

  await t.step('verify via chat:get that reasoning is stored', async () => {
    const conversations = await win.evaluate(async () => {
      const bridge = window.regatta
      return bridge.invoke('chat:list')
    })
    const convo = conversations.find((c) => c.reasoning === 'high')
    t.check('chat:get returns reasoning=high', !!convo)
    await t.shot('06-chat-get-reasoning')
  })

  await t.step('switch conversation to Codex', async () => {
    await win.waitForSelector('[data-testid="chat-agent"]', { timeout: 8000 })
    await win.selectOption('[data-testid="chat-agent"]', { label: 'Codex' })
    await win.waitForTimeout(500)
    await t.shot('07-switched-to-codex')
  })

  await t.step('reasoning stays High when agent changed to Codex (both offer High)', async () => {
    const value = await win.locator('[data-testid="chat-reasoning"]').inputValue()
    t.check('reasoning stays High', value === 'high', value)
    await t.shot('07b-high-stays')
  })

  await t.step('choose Max for Claude, then switch to Codex resets to Default', async () => {
    await win.selectOption('[data-testid="chat-agent"]', { label: 'Claude Code' })
    await win.waitForTimeout(500)
    await win.selectOption('[data-testid="chat-reasoning"]', { label: 'Max effort' })
    await win.waitForTimeout(300)
    await win.selectOption('[data-testid="chat-agent"]', { label: 'Codex' })
    await win.waitForTimeout(500)
    const value = await win.locator('[data-testid="chat-reasoning"]').inputValue()
    t.check('reasoning reset to Default when Max not offered by Codex', value === '', value)
    await t.shot('08-reset-to-default')
  })

  await t.step('reasoning picker has five options for Codex', async () => {
    await win.waitForSelector('[data-testid="chat-reasoning"]', { timeout: 8000 })
    const options = await win.locator('[data-testid="chat-reasoning"] option').allTextContents()
    const expected = ['Default effort', 'Low effort', 'Medium effort', 'High effort', 'Extra high effort']
    t.check('five reasoning options for Codex', JSON.stringify(options) === JSON.stringify(expected), options.join(', '))
    await t.shot('09-reasoning-options-codex')
  })

  await t.step('Test Agent hides reasoning picker', async () => {
    await win.selectOption('[data-testid="chat-agent"]', { label: 'Test Agent' })
    await win.waitForTimeout(500)
    const count = await win.locator('[data-testid="chat-reasoning"]').count()
    t.check('reasoning picker hidden for Test Agent', count === 0, count)
    await t.shot('10-hidden-for-test-agent')
  })

  await t.step('screenshot composer with picker open', async () => {
    await win.selectOption('[data-testid="chat-agent"]', { label: 'Claude Code' })
    await win.waitForTimeout(500)
    await win.locator('[data-testid="chat-reasoning"]').click()
    await win.waitForTimeout(300)
    await t.shot('11-picker-open')
  })

  return t.close()
}