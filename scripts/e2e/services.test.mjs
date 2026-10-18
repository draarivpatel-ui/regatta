// Settings > Services: seven rows, a Checked time, and a working "Check again".
// Runs in the fake world, where six of the seven CLIs are stand-ins that print a version and say they are
// not signed in, and Shopify is not installed. So every row has one known answer.

import { launch } from './lib.mjs'

export default async function services() {
  const t = await launch('services')
  const { win } = t

  await t.step('opens Services in Settings', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-services]')
    await win.waitForSelector('[data-testid=services-row-gh]', { timeout: 25000 })
    await t.shot('01-services')
  })

  await t.step('lists all seven services in order', async () => {
    const ids = ['gh', 'glab', 'stripe', 'wrangler', 'supabase', 'vercel', 'shopify']
    const count = await win.locator('[data-testid^=services-row-]').count()
    t.check('exactly seven rows', count === 7, `${count} rows`)
    const order = await win.locator('[data-testid^=services-row-]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')))
    t.check('in the documented order', JSON.stringify(order) === JSON.stringify(ids.map((id) => `services-row-${id}`)), order.join(', '))
  })

  await t.step('each row shows what its stand-in said', async () => {
    // The stand-in prints 0.0.0 for its version and exits 1 for any status command. How the app reads that
    // differs by service: gh, wrangler and vercel call exit 1 "signed out"; glab and stripe cannot tell, and
    // supabase has no status command and no token in the fake home.
    const expected = {
      gh: { installed: 'yes', signedIn: 'no' },
      glab: { installed: 'yes', signedIn: 'unknown' },
      stripe: { installed: 'yes', signedIn: 'unknown' },
      wrangler: { installed: 'yes', signedIn: 'no' },
      supabase: { installed: 'yes', signedIn: 'unknown' },
      vercel: { installed: 'yes', signedIn: 'no' },
      shopify: { installed: 'no', signedIn: 'unknown' }
    }
    for (const [id, want] of Object.entries(expected)) {
      const row = win.locator(`[data-testid=services-row-${id}]`)
      const got = { installed: await row.getAttribute('data-installed'), signedIn: await row.getAttribute('data-signed-in') }
      t.check(`${id} is installed=${want.installed} signed-in=${want.signedIn}`, got.installed === want.installed && got.signedIn === want.signedIn, JSON.stringify(got))
      if (want.installed === 'yes') {
        const text = (await row.innerText()).replace(/\s+/g, ' ')
        t.check(`${id} shows the stand-in's version`, text.includes('0.0.0'), text)
      }
    }
    t.check('a signed-out CLI shows its sign-in command', (await win.locator('[data-testid=services-hint-gh][data-kind=login]').count()) === 1)
    t.check('the missing CLI shows its install command', (await win.locator('[data-testid=services-hint-shopify][data-kind=install]').count()) === 1)
  })

  await t.step('the stand-ins ran, not the real CLIs', async () => {
    const calls = t.standinCalls()
    const wanted = [
      'gh --version',
      'gh auth status',
      'glab --version',
      'glab auth status',
      'stripe version',
      'stripe login list',
      'wrangler --version',
      'wrangler whoami --json',
      'supabase --version',
      'vercel --version',
      'vercel whoami --non-interactive'
    ]
    for (const call of wanted) t.check(`the log has "${call}"`, calls.includes(call), `${calls.length} calls`)
    t.check('Shopify was never run', !calls.some((c) => c.startsWith('shopify')))
  })

  await t.step('shows a checked time', async () => {
    const line = win.locator('[data-testid=services-checked]')
    t.check('checked line present', (await line.count()) === 1)
    const text = (await line.textContent()) ?? ''
    t.check('checked line shows a clock time', /Checked \d{2}:\d{2}/.test(text), text)
  })

  await t.step('check again reruns and keeps seven rows', async () => {
    const before = t.standinCalls().filter((c) => c === 'gh auth status').length
    await win.evaluate(() => {
      window.__svcDisabledSeen = false
      const btn = document.querySelector('[data-testid=services-check]')
      const obs = new MutationObserver(() => {
        if (btn?.disabled) window.__svcDisabledSeen = true
      })
      obs.observe(btn, { attributes: true, attributeFilter: ['disabled'] })
    })
    await win.click('[data-testid=services-check]')
    await win.waitForFunction(() => window.__svcDisabledSeen === true, null, { timeout: 8000 })
    t.check('button disables while checking', true)
    await win.waitForFunction(
      () => document.querySelector('[data-testid=services-check]')?.disabled === false,
      null,
      { timeout: 40000 }
    )
    const count = await win.locator('[data-testid^=services-row-]').count()
    t.check('seven rows after check again', count === 7, `${count} rows`)
    const after = t.standinCalls().filter((c) => c === 'gh auth status').length
    t.check('check again asked the stand-in again', after > before, `${before} then ${after}`)
    await t.shot('02-check-again')
  })

  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  return t.close()
}
