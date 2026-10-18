// Settings screen: open with Meta+Comma, toggle notifications off and keep it, list agents.

import { launch } from './lib.mjs'

export default async function settings() {
  const t = await launch('settings')
  const { win } = t

  await t.step('opens with Meta+Comma', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    t.check('settings screen opens', true)
    await t.shot('01-settings')
  })

  await t.step('notifications persist off', async () => {
    await win.click('[data-testid=settings-nav-notifications]')
    const sw = win.locator('[data-testid=pref-notifications]')
    await sw.waitFor({ timeout: 8000 })
    const before = await sw.getAttribute('aria-checked')
    t.check('notifications switch is present', before === 'true' || before === 'false', String(before))
    if (before === 'true') {
      await sw.click()
      await win.waitForFunction(
        () => document.querySelector('[data-testid=pref-notifications]')?.getAttribute('aria-checked') === 'false',
        null,
        { timeout: 8000 }
      )
    }
    const off = await sw.getAttribute('aria-checked')
    t.check('notifications can be switched off', off === 'false', String(off))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
    t.check('escape closes settings', (await win.locator('[data-testid=settings-screen]').count()) === 0)
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-notifications]')
    await win.waitForTimeout(300)
    const again = await win.locator('[data-testid=pref-notifications]').getAttribute('aria-checked')
    t.check('notifications stay off after reopen', again === 'false', String(again))
  })

  await t.step('agents list test agent', async () => {
    await win.click('[data-testid=settings-nav-agents]')
    const rows = win.locator('[data-testid=settings-agent-row]')
    await rows.first().waitFor({ timeout: 8000 })
    const text = await rows.allTextContents()
    t.check('agents list includes Test Agent', text.some((s) => s.includes('Test Agent')), `${text.length} rows`)
    await t.shot('02-agents')
  })

  await t.step('the computer sign-ins come from the fake home', async () => {
    // Opening Agents makes the app read the computer's own Claude Code and Codex sign-ins. In the fake world
    // the home is empty, so both say "not signed in yet"; the real home would show an email or "signed in".
    const claude = win.locator('[data-testid=account-row-claude\\:system]')
    await claude.waitFor({ timeout: 8000 })
    const claudeText = ((await claude.textContent()) ?? '').replace(/\s+/g, ' ')
    t.check('Claude Code shows no sign-in', claudeText.includes('not signed in yet') && !claudeText.includes('signed in as'), claudeText.slice(0, 120))
    const codexText = ((await win.locator('[data-testid=account-row-codex\\:system]').textContent()) ?? '').replace(/\s+/g, ' ')
    t.check('Codex shows no sign-in', codexText.includes('not signed in yet'), codexText.slice(0, 120))
  })

  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  return t.close()
}
