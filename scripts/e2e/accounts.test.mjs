// Accounts: Settings > Agents shows computer sign-ins, add/remove/default, pane and chat pickers.

import { launch } from './lib.mjs'

function esc(id) {
  return id.replace(/:/g, '\\:')
}

export default async function accounts() {
  // The fake world's home holds a made-up Claude Code sign-in, so this test never reads the real one.
  // `claude` and `codex` in the world are stand-ins that run the fake agent.
  const t = await launch('accounts', {
    homeFiles: { '.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'ada@example.com' } }) }
  })
  const { win } = t

  const claudeSystemSel = `[data-testid=${esc('account-row-claude:system')}]`
  const codexSystemSel = `[data-testid=${esc('account-row-codex:system')}]`
  const claudeWorkSel = `[data-testid=${esc('account-row-claude:work')}]`
  const claudeWorkDefaultSel = `[data-testid=${esc('account-default-claude:work')}]`
  const claudeWorkRemoveSel = `[data-testid=${esc('account-remove-claude:work')}]`

  function hasDefault(rowSel) {
    return win.locator(rowSel).locator('span:has-text("Default")').count()
  }

  await t.step('opens settings and shows both computer sign-ins as default', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-agents]')
    await win.waitForSelector(claudeSystemSel, { timeout: 8000 })
    await win.waitForSelector(codexSystemSel, { timeout: 8000 })
    const claudeDefault = await hasDefault(claudeSystemSel)
    const codexDefault = await hasDefault(codexSystemSel)
    t.check('Claude Code computer sign-in is default', claudeDefault === 1)
    t.check('Codex computer sign-in is default', codexDefault === 1)
    // The email is made up and the fake home has no Codex login, so reading the real home would fail both.
    const claudeRow = (await win.locator(claudeSystemSel).textContent()) ?? ''
    t.check('the Claude Code sign-in comes from the fake home', claudeRow.includes('signed in as ada@example.com'), claudeRow.slice(0, 120))
    const codexRow = (await win.locator(codexSystemSel).textContent()) ?? ''
    t.check('the Codex sign-in is missing, as in the fake home', codexRow.includes('not signed in yet'), codexRow.slice(0, 120))
    await t.shot('01-computer-signins')
  })

  await t.step('add a Claude Code account "Work"', async () => {
    // Click Add account for Claude Code
    await win.click('[data-testid=account-add-claude]')
    await win.waitForSelector('input[placeholder="Account name"]', { timeout: 4000 })
    await win.fill('input[placeholder="Account name"]', 'Work')
    await win.waitForTimeout(200)
    await win.locator('input[placeholder="Account name"]').press('Enter')
    // Wait for the account row to appear
    await win.waitForSelector(claudeWorkSel, { timeout: 8000 })
    const rows = await win.locator('[data-testid^=account-row-claude]').count()
    t.check('Work account appears in list', rows === 2)
    // Close the settings overlay first (Escape), then close the new pane if one opened
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)
    const panes = await win.locator('[data-testid=pane]').count()
    if (panes > 0) {
      // Close the first pane's close button
      await win.locator('[data-testid=pane]').first().locator('[aria-label="Close pane"]').click()
      await win.waitForTimeout(500)
    }
    await t.shot('02-added-work')
  })

  await t.step('make Work the default', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-agents]')
    await win.waitForSelector(claudeWorkSel, { timeout: 8000 })
    await win.click(claudeWorkDefaultSel)
    // Wait for accounts:changed event to propagate and UI to update
    await win.waitForTimeout(2000)
    const workDefault = await hasDefault(claudeWorkSel)
    const sysDefault = await hasDefault(claudeSystemSel)
    t.check('Work is now default', workDefault === 1)
    t.check('System is no longer default', sysDefault === 0)
    await t.shot('03-work-default')
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)
  })

  await t.step('remove Work and see computer sign-in default again', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-agents]')
    await win.waitForSelector(claudeWorkSel, { timeout: 8000 })
    // Handle the native confirm dialog
    win.once('dialog', (dialog) => dialog.accept())
    await win.click(claudeWorkRemoveSel)
    // Wait for row to disappear
    await win.waitForFunction(
      (sel) => !document.querySelector(sel),
      claudeWorkSel,
      { timeout: 15000 }
    )
    await win.waitForTimeout(500) // wait for default to update
    const sysDefault = await hasDefault(claudeSystemSel)
    t.check('Computer sign-in is default again', sysDefault === 1)
    await t.shot('04-removed-work')
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)
  })

  await t.step('pane header shows account picker for Claude Code', async () => {
    // Ensure we're back at the main view
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)
    // "Claude Code" here is the world's stand-in command, which runs the fake agent.
    await win.click('[data-testid=new-pane-button]')
    await win.waitForTimeout(500)
    const claudeButton = win.locator('[data-testid=new-pane-menu] button', { hasText: 'Claude Code' })
    t.check('Claude Code (the stand-in) is offered', (await claudeButton.count()) > 0)
    await claudeButton.first().click()
    await win.waitForFunction((n) => document.querySelectorAll('[data-testid=pane]').length === n, 1, { timeout: 15000 })
    await win.waitForSelector('[data-testid=pane-account]', { timeout: 8000 }).catch(() => {})
    t.check('Pane header has account picker', (await win.locator('[data-testid=pane-account]').count()) === 1)
    let paneText = ''
    for (let i = 0; i < 30 && !paneText.includes('no AI, for trying Regatta'); i++) {
      await win.waitForTimeout(500)
      paneText = await t.textOf(0)
    }
    t.check('the pane runs the stand-in, not the real CLI', paneText.includes('no AI, for trying Regatta'), paneText.slice(0, 80))
    const started = t.standinCalls().filter((line) => line.startsWith('claude ') && line !== 'claude --version')
    t.check('the stand-in log shows the pane started claude', started.length >= 1, started[0]?.slice(0, 80))
    await t.shot('05-pane-picker')
    // Close the new pane menu if still open
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
  })

  await t.step('chat composer shows account picker', async () => {
    // Switch to Chat mode
    await win.click('[data-testid=mode-chat]')
    await win.waitForTimeout(1000)
    // Check for account picker in chat composer
    const picker = await win.locator('[data-testid=chat-account]').count()
    t.check('Chat composer has account picker', picker === 1)
    await t.shot('06-chat-picker')
  })

  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  return t.close()
}