// Quick actions (Cmd+K) e2e test.

import { launch } from './lib.mjs'

export default async function quickActions() {
  const t = await launch('quick-actions')
  const { win } = t

  await t.step('start one test agent', async () => {
    await t.startAgent('Test Agent')
    t.check('one pane open', (await win.locator('[data-testid=pane]').count()) === 1)
  })

  await t.step('quick actions layout six', async () => {
    await win.keyboard.press('Meta+k')
    await win.waitForSelector('[data-testid=quick-actions]')
    await win.waitForSelector('[data-testid=quick-input]')
    await win.keyboard.type('six')
    await win.waitForTimeout(200)

    const firstItem = win.locator('[data-testid=quick-item]').first()
    const text = await firstItem.textContent()
    t.check('first item contains Layout: Six', text.includes('Layout: Six'))

    await win.keyboard.press('Enter')
    await win.waitForFunction(
      () => document.querySelector('[data-testid=pane-grid]')?.getAttribute('data-layout') === 'six',
      null,
      { timeout: 5000 }
    )
    t.check(
      'pane grid has layout six',
      (await win.locator('[data-testid=pane-grid]').getAttribute('data-layout')) === 'six'
    )
  })

  await t.step('quick actions start test agent', async () => {
    await win.keyboard.press('Meta+k')
    await win.waitForSelector('[data-testid=quick-actions]')
    await win.waitForSelector('[data-testid=quick-input]')
    await win.keyboard.type('test agent')
    await win.waitForTimeout(200)

    const firstItem = win.locator('[data-testid=quick-item]').first()
    const text = await firstItem.textContent()
    t.check('first item contains Start Test Agent', text.includes('Start Test Agent'))

    await win.keyboard.press('Enter')
    await win.waitForFunction(
      () => document.querySelectorAll('[data-testid=pane]').length === 2,
      null,
      { timeout: 10000 }
    )
    t.check('two panes open', (await win.locator('[data-testid=pane]').count()) === 2)
  })

  return t.close()
}
