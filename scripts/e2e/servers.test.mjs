// Servers settings: add a server that goes nowhere, check its key, test it, edit and remove it.

import { launch } from './lib.mjs'

export default async function servers() {
  const t = await launch('servers')
  const { win } = t

  await t.step('opens servers settings', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-servers]')
    await win.waitForSelector('[data-testid=servers-add]', { timeout: 8000 })
    t.check('servers section opens', true)
  })

  await t.step('adds a server named Local', async () => {
    await win.click('[data-testid=servers-add]')
    await win.waitForSelector('[data-testid=servers-form]', { timeout: 8000 })
    await win.fill('[data-testid=servers-name]', 'Local')
    await win.fill('[data-testid=servers-host]', '127.0.0.1')
    await win.fill('[data-testid=servers-port]', '1')
    await win.click('[data-testid=servers-save]')
    await win.waitForSelector('[data-testid^="servers-row-"]', { timeout: 8000 })
    const text = await win.locator('[data-testid^="servers-row-"]').first().textContent()
    t.check('card for Local shows', (text ?? '').includes('Local') && (text ?? '').includes('127.0.0.1'), (text ?? '').slice(0, 80))
    await t.shot('01-servers-card')
  })

  await t.step('check key shows no answer', async () => {
    await win.locator('[data-testid^="servers-scan-"]').first().click()
    const err = win.locator('[data-testid^="servers-scan-error-"]').first()
    await err.waitFor({ timeout: 20000 })
    const text = (await err.textContent()) ?? ''
    t.check('inline no answer message', text.includes('No answer'), text.slice(0, 80))
    await t.shot('02-servers-scan')
  })

  await t.step('test connection fails', async () => {
    await win.locator('[data-testid^="servers-test-"]').first().click()
    const result = win.locator('[data-testid^="servers-lasttest-"]').first()
    await result.waitFor({ timeout: 20000 })
    await win.waitForFunction(
      () => (document.querySelector('[data-testid^="servers-lasttest-"]')?.textContent ?? '').includes('Failed'),
      null,
      { timeout: 20000 }
    )
    const text = (await result.textContent()) ?? ''
    t.check('failed test result shows', text.includes('Failed'), text.slice(0, 100))
    await t.shot('03-servers-test')
  })

  await t.step('edits the name', async () => {
    await win.locator('[data-testid^="servers-edit-"]').first().click()
    await win.waitForSelector('[data-testid=servers-form]', { timeout: 8000 })
    await win.fill('[data-testid=servers-name]', 'Local edited')
    await win.click('[data-testid=servers-save]')
    await win.waitForFunction(
      () => (document.querySelector('[data-testid^="servers-row-"]')?.textContent ?? '').includes('Local edited'),
      null,
      { timeout: 8000 }
    )
    t.check('edited name shows', true)
  })

  await t.step('removes the server', async () => {
    await win.locator('[data-testid^="servers-remove-"]').first().click()
    await win.locator('[data-testid^="servers-confirm-remove-"]').first().click()
    await win.waitForFunction(() => document.querySelectorAll('[data-testid^="servers-row-"]').length === 0, null, {
      timeout: 8000
    })
    t.check('server removed', true)
  })

  await t.step('ssh ran through the stand-in, with the fake home', async () => {
    // ssh finds "~" through the system's user database, not HOME, so the world's stand-in runs the real ssh
    // with the fake home's own config. The log is the proof that it ran, and its paths show whose home it saw.
    const calls = t.standinCalls().filter((c) => c.startsWith('ssh '))
    const detail = calls.join(' | ').slice(0, 200)
    t.check('checking the key asked ssh for its settings', calls.includes('ssh -G -p 1 127.0.0.1'), detail)
    const test = calls.find((c) => c.includes('BatchMode=yes')) ?? ''
    t.check('testing the connection ran ssh in batch mode', test !== '', detail)
    t.check('its known_hosts file is in the fake home', test.includes(`UserKnownHostsFile="${t.home}/.ssh/known_hosts"`), test.slice(0, 200))
  })

  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  return t.close()
}
