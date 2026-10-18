// Core Code mode behavior: panes, status, fleet list, layout menu.

import { launch } from './lib.mjs'

export default async function core() {
  const t = await launch('core')
  const { win } = t

  await t.step('empty state', async () => {
    t.check('empty state offers the test agent', await win.locator('[data-testid=start-fake]').count())
    await t.shot('01-empty')
  })

  await t.step('three panes open', async () => {
    await t.startAgent('Test Agent')
    await t.startAgent('Test Agent')
    await t.startAgent('Terminal')
    t.check('three panes open', (await win.locator('[data-testid=pane]').count()) === 3)
  })

  await t.step('working', async () => {
    await win.waitForTimeout(1000)
    await t.typeInto(0, 'build the login page')
    await t.waitForState(0, 'working', 5000)
    t.check('test agent shows working after a task', true)
    await t.shot('02-working')
  })

  await t.step('needs you', async () => {
    await t.typeInto(1, 'ask')
    await t.waitForState(1, 'waiting', 5000)
    t.check('a yes/no question shows needs you', true)
  })

  await t.step('shell', async () => {
    await t.typeInto(2, 'echo regatta-$((6*7))')
    await win.waitForTimeout(1500)
    const text = await t.textOf(2)
    t.check('the shell pane runs commands', text.includes('regatta-42'))
    await t.shot('03-three-panes')
  })

  await t.step('fleet', async () => {
    const rows = await win.locator('[data-testid=fleet-row]').count()
    t.check('fleet sidebar lists every agent', rows === 3, `${rows} rows`)
  })

  await t.step('answer', async () => {
    await t.typeInto(1, 'y')
    await t.waitForState(1, 'working', 5000)
    t.check('answering the question resumes work', true)
    await win.waitForTimeout(1200)
    t.check('it stays working instead of falling back to needs you', (await t.stateOf(1)) === 'working', String(await t.stateOf(1)))
    await t.waitForState(1, 'idle', 8000)
    t.check('back at its prompt shows ready', true)
  })

  await t.step('layout menu', async () => {
    await win.click('[data-testid=layout-button]')
    await win.waitForTimeout(250)
    t.check('layout menu opens', await win.locator('[data-testid=layout-menu]').count())
    await t.shot('04-layout-menu')
    await win.keyboard.press('Escape')
  })

  await t.step('failed', async () => {
    await t.typeInto(0, 'fail')
    await t.waitForState(0, 'failed', 15000)
    t.check('an agent that exits with an error shows failed', true)
    await t.shot('05-failed')
  })

  return t.close()
}
