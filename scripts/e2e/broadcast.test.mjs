// Broadcast: one message to the sessions you pick.

import { launch } from './lib.mjs'

export default async function broadcast() {
  const t = await launch('broadcast')
  const { win } = t

  await t.step('three panes open', async () => {
    await t.startAgent('Test Agent')
    await t.startAgent('Test Agent')
    await t.startAgent('Terminal')
    await win.waitForTimeout(1000)
    t.check('two test agents and a terminal are open', (await win.locator('[data-testid=pane]').count()) === 3)
    await t.shot('01-panes')
  })

  await t.step('dialog', async () => {
    await win.click('[data-testid=broadcast-button]')
    await win.waitForSelector('[data-testid=broadcast-dialog]', { timeout: 5000 })
    t.check('every live session is listed', (await win.locator('[data-testid=broadcast-target]').count()) === 3)
    t.check('all of them are checked', (await win.locator('[data-testid=broadcast-target][data-checked=true]').count()) === 3)
    await t.shot('02-dialog')
  })

  await t.step('message', async () => {
    await win.click('[data-testid=broadcast-text]')
    await win.keyboard.type('build the api')
    t.check('the send button says how many sessions it reaches', (await win.locator('[data-testid=broadcast-send]').textContent())?.includes('Send to 3 sessions'))
    t.check('the send button is armed by the text', !(await win.locator('[data-testid=broadcast-send]').isDisabled()))
  })

  await t.step('shared folder', async () => {
    const note = win.locator('[data-testid=broadcast-shared-warning]')
    t.check('the shared folder note appears', (await note.count()) === 1)
    t.check('it names the folder', (await note.first().textContent())?.includes('2 agents share'))
    t.check('it offers a crew with worktrees', (await win.locator('[data-testid=broadcast-start-crew]').count()) === 1)
    await t.shot('03-shared-folder')
  })

  await t.step('uncheck the terminal', async () => {
    await win.locator('[data-testid=broadcast-target]').nth(2).locator('input[type=checkbox]').click()
    t.check('the terminal row is unchecked', (await win.locator('[data-testid=broadcast-target][data-checked=false]').count()) === 1)
    t.check('the send button counts the two agents', (await win.locator('[data-testid=broadcast-send]').textContent())?.includes('Send to 2 sessions'))
    await t.shot('04-terminal-unchecked')
  })

  await t.step('send', async () => {
    await win.click('[data-testid=broadcast-send]')
    await win.waitForSelector('[data-testid=broadcast-dialog]', { state: 'detached', timeout: 5000 })
    await t.waitForState(0, 'working', 8000)
    await t.waitForState(1, 'working', 8000)
    t.check('both test agents are working', true)
    await win.waitForTimeout(400)
    const text = await t.textOf(2)
    t.check('the terminal never got the command', !text.includes('build the api'))
    await t.shot('05-after-send')
  })

  await t.step('all and none', async () => {
    await t.waitForState(0, 'idle', 8000)
    await t.waitForState(1, 'idle', 8000)
    await win.click('[data-testid=broadcast-button]')
    await win.waitForSelector('[data-testid=broadcast-dialog]', { timeout: 5000 })
    t.check('both agents are checked again after the agents finished', (await win.locator('[data-testid=broadcast-target][data-checked=true]').count()) === 3)
    await win.click('[data-testid=broadcast-none]')
    await win.click('[data-testid=broadcast-text]')
    await win.keyboard.type('never sent')
    t.check('nothing checked disables the send button', await win.locator('[data-testid=broadcast-send]').isDisabled())
    t.check('an empty pick shows no shared folder note', (await win.locator('[data-testid=broadcast-shared-warning]').count()) === 0)
    await win.click('[data-testid=broadcast-all]')
    t.check('all checks everything again', (await win.locator('[data-testid=broadcast-target][data-checked=true]').count()) === 3)
    t.check('the note comes back with both agents', (await win.locator('[data-testid=broadcast-shared-warning]').count()) === 1)
  })

  await t.step('cmd+enter sends', async () => {
    await win.locator('[data-testid=broadcast-target]').nth(1).locator('input[type=checkbox]').click()
    await win.keyboard.press('Meta+Enter')
    await win.waitForSelector('[data-testid=broadcast-dialog]', { state: 'detached', timeout: 5000 })
    await t.waitForState(0, 'working', 8000)
    t.check('cmd+enter sends to the checked agent', true)
    t.check('the unchecked agent stays ready', (await t.stateOf(1)) === 'idle', String(await t.stateOf(1)))
    await t.shot('06-cmd-enter')
  })

  await t.step('cancel sends nothing', async () => {
    await win.click('[data-testid=broadcast-button]')
    await win.waitForSelector('[data-testid=broadcast-dialog]', { timeout: 5000 })
    await win.click('[data-testid=broadcast-text]')
    await win.keyboard.type('stay unsent')
    await win.locator('[data-testid=broadcast-dialog] button', { hasText: 'Cancel' }).click()
    await win.waitForSelector('[data-testid=broadcast-dialog]', { state: 'detached', timeout: 5000 })
    await win.waitForTimeout(600)
    const text = await t.textOf(2)
    t.check('cancel closes the dialog without sending', !text.includes('stay unsent'))
    t.check('the shell is still ready', (await t.stateOf(2)) === 'idle', String(await t.stateOf(2)))
  })

  await t.step('start a crew instead', async () => {
    await win.click('[data-testid=broadcast-button]')
    await win.waitForSelector('[data-testid=broadcast-dialog]', { timeout: 5000 })
    await win.click('[data-testid=broadcast-start-crew]')
    await win.waitForSelector('[data-testid=launchset-dialog]', { timeout: 5000 })
    t.check('the note opens the crew dialog', (await win.locator('[data-testid=launchset-dialog]').count()) === 1)
    t.check('the crew dialog takes over the broadcast one', (await win.locator('[data-testid=broadcast-dialog]').count()) === 0)
    await t.shot('07-start-a-crew')
    await win.keyboard.press('Escape')
  })

  return t.close()
}
