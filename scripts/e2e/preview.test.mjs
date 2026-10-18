// Preview tab: the URL bar loads a page in the webview, the page updates the bar,
// the buttons move through history, and the device buttons resize the page.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launch } from './lib.mjs'

const page = (win) => win.locator('[data-testid=preview-webview]')
const widthOf = async (win) => win.evaluate(() => document.querySelector('[data-testid=preview-webview]').getBoundingClientRect().width)
/** Runs code inside the page the webview is showing. */
const inside = (win, code) => win.evaluate((source) => document.querySelector('[data-testid=preview-webview]').executeJavaScript(source), code)

export default async function preview() {
  const dir = mkdtempSync(join(tmpdir(), 'rg-e2e-preview-'))
  const first = join(dir, 'index.html')
  const second = join(dir, 'second.html')
  writeFileSync(first, '<!doctype html><title>Preview Test</title><a href="second.html">second</a>')
  writeFileSync(second, '<!doctype html><title>Second Page</title>')
  const firstUrl = pathToFileURL(first).href
  const secondUrl = pathToFileURL(second).href

  const t = await launch('preview')
  const { win } = t

  await t.step('opens on the default address', async () => {
    await win.click('[data-testid=panel-browser]')
    await win.waitForSelector('[data-testid=preview-webview]', { timeout: 10000 })
    t.check('the URL field starts on localhost:3000', (await win.inputValue('[data-testid=preview-url]')) === 'http://localhost:3000')
    t.check('back and forward start off', await win.locator('[data-testid=preview-back]').isDisabled())
    await t.shot('01-open')
  })

  await t.step('loads the page', async () => {
    await win.fill('[data-testid=preview-url]', firstUrl)
    await win.press('[data-testid=preview-url]', 'Enter')
    await win.waitForFunction(() => document.querySelector('[data-testid=preview-webview]')?.getTitle() === 'Preview Test', null, { timeout: 15000 })
    t.check('typing an address and pressing Enter loads it in the webview', true)
    t.check('the URL field keeps the address that loaded', (await win.inputValue('[data-testid=preview-url]')) === firstUrl)
    t.check('the address is remembered for next time', (await win.evaluate(() => localStorage.getItem('regatta.preview.url'))) === firstUrl)
    t.check('open in the browser is off for a file address', await win.locator('[data-testid=preview-open]').isDisabled())
    await t.shot('02-loaded')
  })

  await t.step('reload', async () => {
    const before = await inside(win, 'performance.timeOrigin')
    await win.click('[data-testid=preview-reload-button]')
    await win.waitForFunction(async (old) => {
      const view = document.querySelector('[data-testid=preview-webview]')
      return (await view.executeJavaScript('performance.timeOrigin')) !== old
    }, before, { timeout: 15000 })
    t.check('reload loads the page again from scratch', (await page(win).evaluate((el) => el.getTitle())) === 'Preview Test')
  })

  // The page title can change a moment before the panel's own history catches up, so wait for the button.
  const becomesEnabled = (sel) => win.waitForFunction((q) => document.querySelector(q) && !document.querySelector(q).disabled, sel, { timeout: 5000 }).then(() => true, () => false)

  await t.step('history', async () => {
    await inside(win, "document.querySelector('a').click()")
    await win.waitForFunction(() => document.querySelector('[data-testid=preview-webview]')?.getTitle() === 'Second Page', null, { timeout: 15000 })
    t.check('a link inside the page opens', true)
    t.check('the URL field follows the page', (await win.inputValue('[data-testid=preview-url]')) === secondUrl)
    t.check('back comes alive', await becomesEnabled('[data-testid=preview-back]'))
    await win.click('[data-testid=preview-back]')
    await win.waitForFunction(() => document.querySelector('[data-testid=preview-webview]')?.getTitle() === 'Preview Test', null, { timeout: 15000 })
    t.check('back returns to the first page', true)
    t.check('forward comes alive', await becomesEnabled('[data-testid=preview-forward]'))
    await t.shot('03-history')
  })

  await t.step('device sizes', async () => {
    t.check('Desktop fills the panel', (await widthOf(win)) > 250, `${await widthOf(win)} px`)
    await win.click('[data-testid=preview-device-phone]')
    await win.waitForFunction(() => Math.round(document.querySelector('[data-testid=preview-webview]').getBoundingClientRect().width) === 390)
    t.check('Phone is 390 wide', (await widthOf(win)) === 390, `${await widthOf(win)} px`)
    await t.shot('04-phone')
    await win.click('[data-testid=preview-device-tablet]')
    await win.waitForFunction(() => Math.round(document.querySelector('[data-testid=preview-webview]').getBoundingClientRect().width) === 768)
    t.check('Tablet is 768 wide', (await widthOf(win)) === 768, `${await widthOf(win)} px`)
    await win.click('[data-testid=preview-device-desktop]')
    await win.waitForFunction(() => document.querySelector('[data-testid=preview-webview]').getBoundingClientRect().width > 250)
    t.check('Desktop fills the panel again', true)
  })

  await t.step('nothing running', async () => {
    await win.fill('[data-testid=preview-url]', '127.0.0.1:1')
    await win.press('[data-testid=preview-url]', 'Enter')
    await win.waitForSelector('[data-testid=preview-error]', { timeout: 15000 })
    t.check('an address with no scheme gets http', (await win.inputValue('[data-testid=preview-url]')) === 'http://127.0.0.1:1')
    const message = (await win.locator('[data-testid=preview-error]').innerText()).replace(/\s+/g, ' ')
    t.check('an address with no server behind it says so', message.includes('Nothing is running at http://127.0.0.1:1/ yet.'), message)
    t.check('it offers a reload', await win.locator('[data-testid=preview-error-reload]').count())
    t.check('open in the browser is on for an http address', !(await win.locator('[data-testid=preview-open]').isDisabled()))
    await t.shot('05-nothing-running')
  })

  const results = await t.close()
  rmSync(dir, { recursive: true, force: true })
  return results
}