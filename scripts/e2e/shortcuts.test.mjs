// Keyboard shortcuts for working with panes: focus cycling, maximize, close and the Find panel.
// The window renders but stays hidden (REGATTA_HIDDEN=1).

import { launch } from './lib.mjs'

/** Index of the pane that reports data-focused="true", or -1 when none does. */
const focusedIndex = (t) =>
  t.win.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid=pane]')).findIndex((p) => p.getAttribute('data-focused') === 'true')
  )

export default async function shortcuts() {
  const t = await launch('shortcuts')
  const { win } = t

  await t.step('three test agents', async () => {
    await t.startAgent('Test Agent')
    await t.startAgent('Test Agent')
    await t.startAgent('Test Agent')
    t.check('three panes open', (await win.locator('[data-testid=pane]').count()) === 3)
  })

  await t.step('focus cycles and wraps with Cmd and brackets', async () => {
    await t.pane(0).click()
    await win.waitForFunction(
      () => document.querySelector('[data-testid=pane]')?.getAttribute('data-focused') === 'true'
    )
    t.check('clicking a pane focuses it', (await focusedIndex(t)) === 0, `focused ${await focusedIndex(t)}`)

    await win.keyboard.press('Meta+BracketRight')
    t.check('Cmd+] moves focus to the next pane', (await focusedIndex(t)) === 1, `focused ${await focusedIndex(t)}`)

    await win.keyboard.press('Meta+BracketRight')
    t.check('a second press moves on again', (await focusedIndex(t)) === 2, `focused ${await focusedIndex(t)}`)

    await win.keyboard.press('Meta+BracketRight')
    t.check('a third press wraps back to the first pane', (await focusedIndex(t)) === 0, `focused ${await focusedIndex(t)}`)

    await win.keyboard.press('Meta+BracketLeft')
    t.check('Cmd+[ moves focus the other way', (await focusedIndex(t)) === 2, `focused ${await focusedIndex(t)}`)

    await win.keyboard.press('Meta+BracketRight')
    await t.shot('01-focus-cycling')
  })

  await t.step('maximize and restore with Cmd+Enter', async () => {
    const grid = win.locator('[data-testid=pane-grid]')
    await win.keyboard.press('Meta+Enter')
    const maximized = await grid.getAttribute('data-maximized')
    t.check(
      'Cmd+Enter maximizes the focused pane',
      Boolean(maximized) && (await win.locator('[data-testid=pane]').count()) === 1,
      `data-maximized=${maximized}`
    )
    await t.shot('02-maximized')

    await win.keyboard.press('Meta+Enter')
    t.check(
      'Cmd+Enter again restores every pane',
      (await grid.getAttribute('data-maximized')) === '' && (await win.locator('[data-testid=pane]').count()) === 3,
      `data-maximized=${await grid.getAttribute('data-maximized')}`
    )
  })

  await t.step('close the focused pane with Cmd+W', async () => {
    await win.keyboard.press('Meta+W')
    await win.waitForFunction((n) => document.querySelectorAll('[data-testid=pane]').length === n, 2, { timeout: 5000 })
    t.check('Cmd+W closes the focused pane', (await win.locator('[data-testid=pane]').count()) === 2)
    await t.shot('03-after-close')
  })

  await t.step('open the Find panel with Cmd+Shift+F', async () => {
    await win.keyboard.press('Meta+Shift+F')
    await win.waitForSelector('[data-testid=side-panel-find]', { timeout: 5000 })
    t.check('Cmd+Shift+F opens the Find panel', (await win.locator('[data-testid=side-panel-find]').count()) === 1)
    await t.shot('04-find-panel')
  })

  return t.close()
}
