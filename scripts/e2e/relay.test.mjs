// Relay: a pane that hit its usage limit offers to resume at reset or to continue in another agent.

import { launch } from './lib.mjs'

export default async function relay() {
  const t = await launch('relay')
  const { win } = t

  await t.step('two agents start', async () => {
    await t.startAgent('Test Agent')
    await t.startAgent('Test Agent')
    t.check('two panes open', (await win.locator('[data-testid=pane]').count()) === 2)
  })

  await t.step('a usage limit shows the relay card', async () => {
    await t.typeInto(0, "You've hit your usage limit. It resets 11:58pm")
    await win.waitForSelector('[data-testid=relay-card]', { timeout: 20000 })
    await t.waitForState(0, 'waiting', 10000)
    await t.shot('01-relay-card')
    const card = t.pane(0).locator('[data-testid=relay-card]')
    const text = await card.innerText()
    t.check('the card says the agent hit its usage limit', text.includes('hit its usage limit'), text.replace(/\n/g, ' | '))
    t.check('the card gives the reset time', text.includes('resets at 11:58 PM'), text.replace(/\n/g, ' | '))
    t.check('the resume button names the time', (await t.pane(0).locator('[data-testid=relay-resume]').innerText()).includes('Resume at 11:58 PM'))
    t.check('the continue menu is offered', (await t.pane(0).locator('[data-testid=relay-continue]').count()) === 1)
  })

  await t.step('resume at reset can be scheduled', async () => {
    await t.pane(0).locator('[data-testid=relay-resume]').click()
    await win.waitForTimeout(400)
    const label = await t.pane(0).locator('[data-testid=relay-resume]').innerText()
    t.check('the button shows the scheduled resume and how to cancel', label.includes('Resuming at 11:58 PM') && label.includes('Cancel'), label)
    await t.shot('02-resume-scheduled')
    await t.pane(0).locator('[data-testid=relay-resume]').click()
    await win.waitForTimeout(400)
    t.check('clicking again cancels the schedule', (await t.pane(0).locator('[data-testid=relay-resume]').innerText()).includes('Resume at 11:58 PM'))
  })

  await t.step('continue now in another agent', async () => {
    await t.pane(0).locator('[data-testid=relay-continue]').click()
    await win.waitForSelector('[data-testid=relay-continue-menu]', { timeout: 5000 })
    await win.waitForTimeout(300)
    await t.shot('03-continue-menu')
    const menuBox = await win.locator('[data-testid=relay-continue-menu]').boundingBox()
    const paneBox = await t.pane(0).boundingBox()
    const fits = menuBox !== null && paneBox !== null && menuBox.y >= paneBox.y && menuBox.y + menuBox.height <= paneBox.y + paneBox.height
    t.check('the menu opens inside the pane', fits, `menu ${JSON.stringify(menuBox)} in pane ${JSON.stringify(paneBox)}`)
    const items = await win.locator('[data-testid=relay-continue-menu] button').count()
    t.check('the menu lists the installed agents, never the Terminal', items > 0 && !(await win.locator('[data-testid=relay-continue-menu] button', { hasText: 'Terminal' }).count()), `${items} items`)
    await win.locator('[data-testid=relay-continue-menu] button', { hasText: 'Test Agent' }).first().click()
    await win.waitForFunction(() => document.querySelectorAll('[data-testid=pane]').length === 3, undefined, { timeout: 20000 })
    // The carried-over prompt is typed once the new agent is ready. A fake world starts with no checkpoint store, so the
    // first step in it takes a couple of seconds longer than in a used home; wait for the text instead of a fixed pause.
    let text = ''
    for (let i = 0; i < 30 && !text.includes('Carry on from here.'); i++) {
      await win.waitForTimeout(500)
      text = (await t.textOf(2)).replace(/\s+/g, ' ')
    }
    await t.shot('04-continued')
    t.check('the new pane carries the work over', text.includes('Carry on from here.'), text.slice(0, 100))
    t.check('the old pane drops the card', (await t.pane(0).locator('[data-testid=relay-card]').count()) === 0)
    t.check('the new pane is its own session', (await t.pane(2).getAttribute('data-session')) !== (await t.pane(0).getAttribute('data-session')))
  })

  return t.close()
}
