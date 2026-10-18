// Anywhere (Labs) in Settings > Dictation: the block is disabled until labs.anywhere is on, then it
// shows the shortcut and the Accessibility line. This test never presses the global shortcut and never
// types into another app.

import { launch } from './lib.mjs'

export default async function anywhere() {
  const t = await launch('anywhere')
  const { win } = t

  await t.step('the Anywhere block shows disabled in Settings > Dictation', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid="settings-screen"]', { timeout: 8000 })
    await win.click('[data-testid="settings-nav-dictation"]')
    await win.waitForSelector('[data-testid="dictation-section"]', { timeout: 8000 })
    await win.waitForSelector('[data-testid="anywhere-block"]', { timeout: 8000 })
    t.check('the Anywhere block is present', true)
    // The block reads prefs first and says "Loading" until they arrive; wait for the link itself.
    await win.waitForSelector('[data-testid="anywhere-labs-link"]', { timeout: 8000 }).catch(() => {})
    const labsLink = await win.locator('[data-testid="anywhere-labs-link"]').count()
    t.check('it points to Labs while off', labsLink === 1, `${labsLink} links`)
    const shortcut = await win.locator('[data-testid="anywhere-shortcut"]').count()
    t.check('the shortcut line is hidden while off', shortcut === 0, `${shortcut} shortcut lines`)
    await win.locator('[data-testid="anywhere-block"]').scrollIntoViewIfNeeded()
    await t.shot('01-disabled')
  })

  await t.step('turning on labs.anywhere reveals the shortcut and the Accessibility line', async () => {
    await win.evaluate(() =>
      window.regatta.invoke('prefs:set', { labs: { video: false, board: false, anywhere: true } })
    )
    await win.waitForSelector('[data-testid="anywhere-shortcut"]', { timeout: 8000 })
    t.check('the shortcut line appears once on', true)
    await win.waitForSelector('[data-testid="anywhere-access-line"]', { timeout: 8000 })
    t.check('the Accessibility line appears once on', true)
    const shortcutText = (await win.locator('[data-testid="anywhere-shortcut"]').textContent()) ?? ''
    t.check('the shortcut text mentions the keys', shortcutText.includes('Space'), shortcutText.slice(0, 60))
    const labsLink = await win.locator('[data-testid="anywhere-labs-link"]').count()
    t.check('the Labs link is gone once on', labsLink === 0, `${labsLink} links`)
    await win.locator('[data-testid="anywhere-block"]').scrollIntoViewIfNeeded()
    await t.shot('02-enabled')
  })

  return t.close()
}
