// Schedules: create a crew schedule, run it now, turn it off and delete it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launch } from './lib.mjs'

export default async function schedules() {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-schedules-'))
  writeFileSync(join(dir, 'README.md'), 'start\n')

  const t = await launch('schedules', { cwd: dir })
  const { win } = t

  await t.step('switch to agents mode', async () => {
    await win.click('[data-testid=mode-agents]')
    await win.waitForSelector('[data-testid=agents-mode]', { timeout: 8000 })
    t.check('agents mode opens', (await win.locator('[data-testid=agents-mode]').count()) === 1)
  })

  await t.step('create a crew member for the test agent', async () => {
    await win.evaluate(() =>
      window.regatta.invoke('teammates:save', {
        name: 'Ada',
        role: 'Checks the open issues',
        agent: 'fake',
        instructions: 'Check the open issues and report back.',
        memory: ''
      })
    )
    await win.waitForSelector('[data-testid=crew-card]', { timeout: 8000 })
    t.check('crew member appears in list', (await win.locator('[data-testid=crew-card]').count()) === 1)
  })

  await t.step('open schedules', async () => {
    await win.click('[data-testid=automate-schedules]')
    await win.waitForSelector('[data-testid=schedules-view]', { timeout: 5000 })
    t.check('schedules view opens', (await win.locator('[data-testid=schedules-view]').count()) === 1)
    t.check('empty state explains itself', await win.locator('[data-testid=schedules-view]').getByText('Nothing scheduled yet').count())
  })

  let rowId = ''
  await t.step('create a daily schedule', async () => {
    await win.click('[data-testid=schedules-new]')
    await win.waitForSelector('[data-testid=schedules-editor]', { timeout: 5000 })
    await win.fill('[data-testid=schedules-name]', 'Daily check')
    await win.selectOption('[data-testid=schedules-teammate]', { label: 'Ada' })
    await win.fill('[data-testid=schedules-prompt]', 'Check the open issues')
    await win.selectOption('[data-testid=schedules-every]', 'daily')
    await win.fill('[data-testid=schedules-time]', '09:30')
    await win.click('[data-testid=schedules-save]')
    await win.waitForSelector('[data-testid^=schedules-row-]', { timeout: 8000 })
    const testId = await win.locator('[data-testid^=schedules-row-]').first().getAttribute('data-testid')
    rowId = String(testId).replace('schedules-row-', '')
    t.check('schedule card appears', rowId.length > 0)
    const cardText = await win.locator(`[data-testid=schedules-row-${rowId}]`).innerText()
    t.check('card shows how often', cardText.includes('Every day at'))
    t.check('card shows the crew member and prompt', cardText.includes('Ada') && cardText.includes('Check the open issues'))
  })

  await t.step('run now adds a run with a check mark', async () => {
    await win.click(`[data-testid=schedules-run-${rowId}]`)
    await win.waitForFunction(
      (id) => document.querySelector(`[data-testid="schedules-row-${id}"]`)?.textContent?.includes('Started a conversation') ?? false,
      rowId,
      { timeout: 15000 }
    )
    t.check('run note lands in the card', true)
    const marks = await win.locator(`[data-testid=schedules-row-${rowId}] [aria-label="Succeeded"]`).count()
    t.check('run shows a check mark', marks === 1)
    await t.shot('01-schedules-card')
  })

  await t.step('turn it off', async () => {
    await win.click(`[data-testid=schedules-toggle-${rowId}]`)
    await win.waitForFunction(
      (id) => document.querySelector(`[data-testid="schedules-row-${id}"]`)?.textContent?.includes('Off') ?? false,
      rowId,
      { timeout: 8000 }
    )
    t.check('card shows Off', true)
  })

  await t.step('delete it', async () => {
    await win.click(`[data-testid=schedules-delete-${rowId}]`)
    await win.waitForSelector('[data-testid=schedules-delete-confirm]', { timeout: 5000 })
    await win.click('[data-testid=schedules-confirm-delete]')
    await win.waitForSelector('[data-testid^=schedules-row-]', { state: 'detached', timeout: 8000 })
    t.check('schedule is gone', (await win.locator('[data-testid^=schedules-row-]').count()) === 0)
  })

  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup error
  }

  return t.close()
}
