// Inbox slide-over: lists every session most urgent first, jumps to the one you pick,
// and closes finished sessions.

import { launch } from './lib.mjs'

export default async function inbox() {
  const t = await launch('inbox')
  const { win } = t

  await t.step('two agents start', async () => {
    await t.startAgent('Test Agent')
    await t.startAgent('Test Agent')
    await win.waitForTimeout(800)
    t.check('two panes open', (await win.locator('[data-testid=pane]').count()) === 2)
  })

  await t.step('needs you sorts to the top', async () => {
    await t.typeInto(1, 'ask')
    await t.waitForState(1, 'waiting', 6000)
    const waitingId = await t.sessionId(1)
    await win.click('[data-testid=inbox-button]')
    await win.waitForSelector('[data-testid=inbox-panel]', { timeout: 5000 })
    await t.shot('01-inbox-waiting')
    const firstState = await win.locator('[data-testid=inbox-row]').first().getAttribute('data-state')
    t.check('the first inbox row is the waiting session', firstState === 'waiting', String(firstState))
    t.check('the waiting session is its own row', (await win.locator(`[data-testid=inbox-row][data-session="${waitingId}"]`).count()) === 1)

    await win.locator('[data-testid=inbox-row]').first().locator('[data-testid=inbox-open]').click()
    await win.waitForSelector('[data-testid=inbox-panel]', { state: 'detached', timeout: 5000 })
    await win.waitForFunction(
      (id) => document.querySelector(`[data-testid=pane][data-session="${id}"]`)?.getAttribute('data-focused') === 'true',
      waitingId,
      { timeout: 5000 }
    )
    t.check('open jumps to that pane and closes the inbox', true)
  })

  await t.step('close finished removes ended panes', async () => {
    await t.typeInto(0, 'fail')
    await t.waitForState(0, 'failed', 15000)
    await win.click('[data-testid=inbox-button]')
    await win.waitForSelector('[data-testid=inbox-panel]', { timeout: 5000 })
    await t.shot('02-inbox-failed')
    const doneRows = await win.locator('[data-testid=inbox-row][data-state="failed"]').count()
    t.check('the failed session lists under its section', doneRows === 1, `${doneRows} failed rows`)
    await win.click('[data-testid=inbox-close-finished]')
    await win.waitForFunction(() => document.querySelectorAll('[data-testid=pane]').length === 1, undefined, { timeout: 8000 })
    t.check('one pane left after closing finished', (await win.locator('[data-testid=pane]').count()) === 1)
    await t.shot('03-one-pane-left')
  })

  return t.close()
}
