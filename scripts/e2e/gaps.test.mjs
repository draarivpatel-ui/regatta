// End to end: the right sidebar in every mode (and its webview never reloading),
// Inbox "Close idle", Broadcast "Sent to N", the "Pair with preview" layout, the layout menu's
// not-a-fit reason, and Services install hints for a missing CLI.
//
// Every check reads something real on screen: an element count, an attribute, visible text, or a
// webview that kept its page. None take a literal true.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launch } from './lib.mjs'

/** The Preview or Fleet tab button inside the right sidebar header. */
const sidebarTabButton = (win, text) =>
  win.locator('[data-testid=fleet-sidebar] button').filter({ hasText: text }).first()

export default async function gaps() {
  const dir = mkdtempSync(join(tmpdir(), 'rg-e2e-gaps-'))
  const pageFile = join(dir, 'gaps.html')
  writeFileSync(pageFile, '<!doctype html><title>Gaps Persist Page</title>')
  const pageUrl = pathToFileURL(pageFile).href

  const t = await launch('gaps')
  const { win } = t

  await t.step('two test agents start', async () => {
    await t.startAgent('Test Agent')
    await t.startAgent('Test Agent')
    await win.waitForTimeout(600)
    t.check('two panes open', (await win.locator('[data-testid=pane]').count()) === 2)
    t.check('the right sidebar is on the Fleet tab', (await win.locator('[data-testid=fleet-sidebar]').count()) === 1)
    t.check('the Fleet tab is the visible one', (await win.locator('[data-testid=fleet-sidebar] [data-testid=fleet-row]').count()) === 2)
  })

  await t.step('item 1: the sidebar stays in Chat and Agents mode', async () => {
    await win.click('[data-testid=mode-chat]')
    await win.waitForTimeout(400)
    t.check('the sidebar is still there in Chat mode', await win.locator('[data-testid=fleet-sidebar]').isVisible())
    t.check('it is a real sidebar width, not collapsed', (await win.locator('[data-testid=fleet-sidebar]').boundingBox())?.width > 200)
    await t.shot('01-sidebar-in-chat')
    await win.click('[data-testid=mode-agents]')
    await win.waitForTimeout(400)
    t.check('the sidebar is still there in Agents mode', await win.locator('[data-testid=fleet-sidebar]').isVisible())
    await win.click('[data-testid=mode-code]')
    await win.waitForTimeout(400)
    t.check('back in Code mode the panes are as they were', (await win.locator('[data-testid=pane]').count()) === 2)
    t.check('and the sidebar is still open', await win.locator('[data-testid=fleet-sidebar]').isVisible())
  })

  await t.step('item 1: the preview webview does not reload when switching modes', async () => {
    await sidebarTabButton(win, 'Preview').click()
    await win.waitForSelector('[data-testid=preview-webview]', { timeout: 12000 })
    await win.fill('[data-testid=preview-url]', pageUrl)
    await win.press('[data-testid=preview-url]', 'Enter')
    await win.waitForFunction(() => document.querySelector('[data-testid=preview-webview]')?.getTitle() === 'Gaps Persist Page', null, { timeout: 15000 })
    const before = await win.evaluate(() => document.querySelector('[data-testid=preview-webview]').executeJavaScript('performance.timeOrigin'))
    await win.click('[data-testid=mode-chat]')
    await win.waitForTimeout(500)
    t.check('the preview page is still the same one in Chat mode', (await win.evaluate(() => document.querySelector('[data-testid=preview-webview]').getTitle())) === 'Gaps Persist Page')
    await win.click('[data-testid=mode-agents]')
    await win.waitForTimeout(500)
    await win.click('[data-testid=mode-code]')
    await win.waitForTimeout(500)
    const after = await win.evaluate(() => document.querySelector('[data-testid=preview-webview]').executeJavaScript('performance.timeOrigin'))
    t.check('the webview never reloaded across mode switches', before === after, `before ${before}, after ${after}`)
    await sidebarTabButton(win, 'Fleet').click()
    await win.waitForTimeout(200)
  })

  await t.step('item 2: Close idle removes only ready and finished panes', async () => {
    // agent-0 works then becomes ready; agent-1 asks so it needs attention and must survive.
    await t.typeInto(0, 'add a login form')
    await t.waitForState(0, 'working', 6000)
    await t.waitForState(0, 'idle', 9000)
    await t.typeInto(1, 'ask')
    await t.waitForState(1, 'waiting', 6000)
    await win.click('[data-testid=inbox-button]')
    await win.waitForSelector('[data-testid=inbox-close-idle]', { timeout: 5000 })
    const label = (await win.locator('[data-testid=inbox-close-idle]').textContent()) ?? ''
    t.check('the Close idle button reads as enabled', !(await win.locator('[data-testid=inbox-close-idle]').isDisabled()), label.trim())
    await win.click('[data-testid=inbox-close-idle]')
    await win.waitForSelector('[data-testid=inbox-close-idle-confirm]', { timeout: 5000 })
    const confirmText = (await win.locator('[data-testid=inbox-close-idle-bar]').textContent()) ?? ''
    t.check('the confirmation names how many panes it will close', /Close 1 finished panes?\?/.test(confirmText.replace(/\s+/g, ' ')), confirmText.replace(/\s+/g, ' ').trim())
    await win.click('[data-testid=inbox-close-idle-confirm]')
    await win.waitForFunction(() => document.querySelectorAll('[data-testid=pane]').length === 1, null, { timeout: 8000 })
    t.check('the ready pane is gone', (await win.locator('[data-testid=pane]').count()) === 1)
    t.check('the needs-you pane is still there', (await win.locator('[data-testid=pane][data-state=waiting]').count()) === 1)
    await t.shot('02-inbox-after-close-idle')
    // The slide-over's backdrop covers the toolbar, so dismiss it before touching those buttons.
    await win.keyboard.press('Escape')
    await win.waitForSelector('[data-testid=inbox-panel]', { state: 'detached', timeout: 5000 })
    t.check('escape takes the inbox away', (await win.locator('[data-testid=inbox-panel]').count()) === 0)
  })

  await t.step('item 3: Broadcast says how many received it', async () => {
    // Start a second agent so a two-pane send reads plainly.
    await t.startAgent('Test Agent')
    await win.waitForTimeout(600)
    await win.click('[data-testid=broadcast-button]')
    await win.waitForSelector('[data-testid=broadcast-dialog]', { timeout: 5000 })
    const targets = await win.locator('[data-testid=broadcast-target]').count()
    await win.click('[data-testid=broadcast-text]')
    await win.keyboard.type('write a short note')
    await win.click('[data-testid=broadcast-send]')
    await win.waitForSelector('[data-testid=broadcast-result]', { timeout: 5000 })
    const summary = (await win.locator('[data-testid=broadcast-result]').textContent()) ?? ''
    t.check('the result reports it was sent', summary.includes('Sent to'), summary.trim())
    t.check('it counts the panes that took the text', /Sent to (all|[\d]+ of) [\d]+ panes/.test(summary.replace(/\s+/g, ' ')), summary.replace(/\s+/g, ' ').trim())
    t.check('the target count on screen matches the total in the message', new RegExp(`${targets} panes`).test(summary), `${targets} targets, ${summary.replace(/\s+/g, ' ').trim()}`)
    await t.shot('03-broadcast-result')
    // The dialog closes on its own a moment later.
    await win.waitForSelector('[data-testid=broadcast-dialog]', { state: 'detached', timeout: 6000 })
    t.check('the dialog closes itself after showing the result', (await win.locator('[data-testid=broadcast-dialog]').count()) === 0)
  })

  await t.step('item 4: Pair with preview opens two slots and the Preview tab', async () => {
    await win.click('[data-testid=layout-button]')
    await win.waitForSelector('[data-testid=layout-menu]', { timeout: 5000 })
    // A layout too big for the window is still listed, dimmed.
    const sixteen = win.locator('[data-testid=layout-sixteen]')
    t.check('Sixteen is still in the menu', (await sixteen.count()) === 1)
    await sixteen.hover()
    await win.waitForTimeout(200)
    const reasonText = (await win.locator('[data-testid=layout-fit-reason]').textContent()) ?? ''
    t.check('hovering it shows why it does not fit', /16 panes need a window at least \d+ by \d+ \(yours is \d+ by \d+\)\./.test(reasonText.replace(/\s+/g, ' ')), reasonText.replace(/\s+/g, ' ').trim())
    await win.click('[data-testid=layout-pair-preview]')
    await win.waitForSelector('[data-testid=layout-menu]', { state: 'detached', timeout: 5000 })
    await win.waitForTimeout(400)
    const grid = win.locator('[data-testid=pane-grid]')
    t.check('the pane grid switched to pair-preview', (await grid.getAttribute('data-layout')) === 'pair-preview', String(await grid.getAttribute('data-layout')))
    const boxes = await win.locator('[data-testid=pane-grid] [data-testid=pane]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
    t.check('panes sit side by side in two columns', boxes.length >= 2 && new Set(boxes).size === 2, `${boxes.join(', ')}`)
    t.check('the right sidebar moved to its Preview tab', (await win.locator('[data-testid=fleet-sidebar] [data-testid=preview-tab]').count()) === 1)
    t.check('a preview page shows in that tab', (await win.locator('[data-testid=preview-webview]').count()) === 1)
    await t.shot('04-pair-with-preview')
  })

  await t.step('item 5: a missing CLI shows how to install it', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-services]')
    await win.waitForSelector('[data-testid^=services-row-]', { timeout: 30000 })
    // In the fake world six service CLIs are stand-ins and Shopify is not installed, whatever this computer has.
    const missing = win.locator('[data-testid^=services-row-][data-installed=no]')
    t.check('exactly one service is not installed', (await missing.count()) === 1, `${await missing.count()} rows`)
    t.check('and it is Shopify', (await missing.first().getAttribute('data-testid')) === 'services-row-shopify')
    const hint = missing.first().locator('[data-testid^=services-hint-]')
    t.check('a not-installed row shows a hint', (await hint.count()) === 1)
    t.check('that hint is an install hint, not a sign-in one', (await hint.getAttribute('data-kind')) === 'install', String(await hint.getAttribute('data-kind')))
    const command = (await hint.locator('code').textContent()) ?? ''
    t.check('it names a real install command', /brew install|npm install -g/.test(command), command)
    t.check('that is the command for Shopify', command === 'npm install -g @shopify/cli', command)
    t.check('the copy control is present', (await missing.first().locator('[data-testid^=services-copy-]').count()) === 1)
    await t.shot('05-services-install-hint')
  })

  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  const results = await t.close()
  rmSync(dir, { recursive: true, force: true })
  return results
}
