// First-run welcome: shows on first launch, walks three steps, closes, stays closed
// on relaunch, and reopens from Settings > General.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './lib.mjs'

export default async function onboarding() {
  const t = await launch('onboarding', { welcome: true })
  const { win } = t
  await win.setViewportSize({ width: 1100, height: 760 })
  await win.waitForTimeout(300)

  await t.step('welcome shows on first run', async () => {
    await win.waitForSelector('[data-testid=welcome]', { timeout: 10000 })
    t.check('welcome shows on first run', true)
    await win.waitForSelector('[data-testid=welcome-step-1]', { timeout: 8000 })
    const rows = await win.locator('[data-testid^=welcome-agent-]').count()
    t.check('step 1 lists the detected agents', rows > 0, `${rows} rows`)
    const first = ((await win.locator('[data-testid^=welcome-agent-]').first().textContent()) ?? '').replace(/\s+/g, ' ')
    t.check('an agent row says Found', first.includes('Found'), first.slice(0, 80))
    await t.shot('01-agents')
  })

  await t.step('enter moves to step 2', async () => {
    await win.keyboard.press('Enter')
    await win.waitForSelector('[data-testid=welcome-step-2]', { timeout: 8000 })
    t.check('enter moves to step 2', true)
    // the example chips show their state without an elapsed timer.
    const chips = (await win.locator('[data-testid=welcome-step-2] [data-testid=status-chip]').allInnerTexts()).map((s) =>
      s.replace(/\s+/g, ' ').trim()
    )
    t.check(
      'step 2 chips show no elapsed timer',
      chips.length === 5 && chips.every((c) => !c.includes('·') && !/\d\s*s/.test(c)),
      chips.join(' | ')
    )
    await t.shot('02-status')
    await t.shot('welcome-step2')
  })

  await t.step('back returns to step 1', async () => {
    await win.click('[data-testid=welcome-back]')
    await win.waitForSelector('[data-testid=welcome-step-1]', { timeout: 8000 })
    t.check('back returns to step 1', true)
  })

  await t.step('next walks to step 3', async () => {
    await win.click('[data-testid=welcome-next]')
    await win.waitForSelector('[data-testid=welcome-step-2]', { timeout: 8000 })
    await win.click('[data-testid=welcome-next]')
    await win.waitForSelector('[data-testid=welcome-step-3]', { timeout: 8000 })
    t.check('next walks to step 3', true)
    await t.shot('03-start')
  })

  await t.step('close hides it and marks it seen', async () => {
    await win.click('[data-testid=welcome-close]')
    await win.waitForSelector('[data-testid=welcome]', { state: 'detached', timeout: 8000 })
    t.check('close hides the welcome', true)
    await win.waitForTimeout(400)
    const stored = readFileSync(join(t.profile, 'regatta-settings.json'), 'utf8')
    t.check('closing marks the welcome seen', stored.includes('"welcomeSeen": true'), stored.slice(0, 120))
  })

  const profile = t.profile
  const firstRun = await t.close()

  const t2 = await launch('onboarding', { profile })
  const w2 = t2.win
  await w2.setViewportSize({ width: 1100, height: 760 })
  await w2.waitForTimeout(300)
  await t2.step('stays closed on relaunch', async () => {
    await w2.waitForTimeout(2500)
    t2.check('no welcome after relaunch', (await w2.locator('[data-testid=welcome]').count()) === 0)
  })

  await t2.step('settings reopens it', async () => {
    await w2.keyboard.press('Meta+,')
    await w2.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await w2.click('[data-testid=settings-show-welcome]')
    await w2.waitForSelector('[data-testid=welcome-step-1]', { timeout: 8000 })
    t2.check('settings shows the welcome again', true)
    await t2.shot('04-reopened')
    await w2.keyboard.press('Escape')
    await w2.waitForSelector('[data-testid=welcome]', { state: 'detached', timeout: 8000 })
    t2.check('escape closes the welcome', true)
  })

  return [...firstRun, ...(await t2.close())]
}
