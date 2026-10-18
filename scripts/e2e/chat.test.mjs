// Chat mode: new chat with the Test Agent, a read turn, then a write request
// approval that edits README.md.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launch } from './lib.mjs'

export default async function chat() {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-chat-'))
  writeFileSync(join(dir, 'README.md'), 'start\n')

  const t = await launch('chat', { cwd: dir })
  const { win } = t

  await t.step('switch to chat mode', async () => {
    await win.keyboard.press('Meta+3')
    await win.waitForSelector('[data-testid="chat-mode"]', { timeout: 8000 })
    t.check('chat mode opens', (await win.locator('[data-testid="chat-mode"]').count()) === 1)
    await t.shot('01-chat-mode')
  })

  await t.step('start a new chat', async () => {
    await win.click('[data-testid="chat-new"]')
    await win.waitForSelector('[data-testid="chat-input"]', { timeout: 8000 })
    t.check('composer appears', (await win.locator('[data-testid="chat-input"]').count()) === 1)
    await t.shot('02-new-chat')
  })

  await t.step('pick the Test Agent', async () => {
    await win.waitForSelector('[data-testid="chat-agent"]', { timeout: 8000 })
    await win.selectOption('[data-testid="chat-agent"]', { label: 'Test Agent' })
    await win.waitForTimeout(500)
    const value = await win.locator('[data-testid="chat-agent"]').inputValue()
    t.check('test agent picked', value === 'fake', value)
    await t.shot('03-agent-picked')
  })

  await t.step('send hello', async () => {
    await win.fill('[data-testid="chat-input"]', 'hello')
    await win.keyboard.press('Enter')
    await win.waitForFunction(
      () => document.querySelector('[data-testid="chat-transcript"]')?.textContent?.includes('Echo: hello'),
      null,
      { timeout: 15000 }
    )
    t.check('transcript contains Echo: hello', true)
    await t.shot('04-sent')
  })

  await t.step('send edit request', async () => {
    await win.waitForSelector('[data-testid="chat-input"]', { timeout: 8000 })
    await win.fill('[data-testid="chat-input"]', 'edit the readme')
    await win.keyboard.press('Enter')
    await t.shot('05-sent')
  })

  await t.step('write request card appears', async () => {
    await win.waitForSelector('[data-testid="chat-write-request"]', { timeout: 15000 })
    t.check('write request card appears', (await win.locator('[data-testid="chat-write-request"]').count()) === 1)
    await t.shot('06-approval-card')
  })

  await t.step('approve workspace edits', async () => {
    await win.click('[data-testid="chat-approve"]')
    await t.shot('07-approved')
  })

  await t.step('wait for edit to finish', async () => {
    await win.waitForFunction(() => document.body.innerText.includes('Edited README.md'), null, {
      timeout: 15000
    })
    t.check('shows Edited README.md', true)
    await t.shot('08-edited')
  })

  await t.step('README file updated', async () => {
    const content = readFileSync(join(dir, 'README.md'), 'utf8')
    t.check('README contains edited by test agent', content.includes('edited by test agent'))
  })

  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors.
  }

  return t.close()
}
