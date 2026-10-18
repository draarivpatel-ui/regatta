// Agents mode: crew member creation, read turn with write request approval, and file edits.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launch } from './lib.mjs'

export default async function agents() {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-agents-'))
  writeFileSync(join(dir, 'README.md'), 'start\n')

  const t = await launch('agents', { cwd: dir })
  const { win } = t

  await t.step('switch to agents mode', async () => {
    await win.keyboard.press('Meta+1')
    await win.waitForSelector('[data-testid=agents-mode]', { timeout: 8000 })
    t.check('agents mode opens', (await win.locator('[data-testid=agents-mode]').count()) === 1)
    await t.shot('01-agents-mode')
  })

  await t.step('create crew member', async () => {
    await win.click('[data-testid=crew-new]')
    await win.waitForSelector('[data-testid=crew-modal]', { timeout: 5000 })
    await win.fill('[data-testid=crew-name-input]', 'Release partner')
    await win.fill('[data-testid=crew-role-input]', 'Implementation and release review')
    await win.selectOption('[data-testid=crew-agent-select]', { label: 'Test Agent' })
    await win.click('[data-testid=crew-save]')
    await win.waitForSelector('[data-testid=crew-modal]', { state: 'detached', timeout: 5000 })
    await win.waitForSelector('[data-testid=crew-card]', { timeout: 5000 })
    t.check('crew member appears in list', (await win.locator('[data-testid=crew-card]').count()) === 1)
    await t.shot('02-crew-member')
  })

  await t.step('send edit request', async () => {
    await win.waitForSelector('[data-testid=crew-input]', { timeout: 8000 })
    await win.fill('[data-testid=crew-input]', 'edit the readme')
    await win.keyboard.press('Enter')
    await t.shot('03-sent')
  })

  await t.step('approval card appears', async () => {
    await win.waitForSelector('[data-testid=crew-write-request]', { timeout: 15000 })
    t.check('approval card appears', (await win.locator('[data-testid=crew-write-request]').count()) === 1)
    await t.shot('04-approval-card')
  })

  await t.step('approve workspace edits', async () => {
    await win.click('[data-testid=crew-approve]')
    await t.shot('05-approved')
  })

  await t.step('wait for edit to finish', async () => {
    await win.waitForFunction(
      () => document.body.innerText.includes('Edited README.md'),
      null,
      { timeout: 15000 }
    )
    t.check('shows Edited README.md', true)
    await t.shot('06-edited')
  })

  await t.step('readme file updated', async () => {
    const content = readFileSync(join(dir, 'README.md'), 'utf8')
    t.check('README contains edited by test agent', content.includes('edited by test agent'))
  })

  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup error
  }

  return t.close()
}
