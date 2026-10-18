// Daily token budgets and loop guard e2e test.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-budgets-repo-'))
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/app.js'), 'export const x = 1\n')
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'budgets-fixture',
        version: '0.0.0',
        scripts: {
          test: 'test -f DONE.txt'
        }
      },
      null,
      2
    ) + '\n'
  )
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  execFileSync(
    'git',
    ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'first commit'],
    { cwd: dir, stdio: 'ignore' }
  )
  return dir
}

async function runSingleHeat(win, taskText) {
  await win.click('[data-testid=skipper-button]')
  await win.waitForSelector('[data-testid=skipper-view]', { timeout: 8000 })
  await win.click('[data-testid=heat-new]')
  await win.waitForSelector('[data-testid=heat-form]', { timeout: 8000 })

  await win.locator('[data-testid=heat-task]').fill(taskText)
  await win.waitForSelector('[data-testid=heat-agent][data-agent=fake]', { timeout: 8000 })
  await win.locator('[data-testid=heat-agent][data-agent=fake]').click()
  await win.locator('[data-testid=heat-agent-plus][data-agent=fake]').click()

  await win.waitForFunction(() => !document.querySelector('[data-testid=heat-start]')?.disabled, undefined, {
    timeout: 5000
  })
  await win.click('[data-testid=heat-start]')
  await win.waitForSelector('[data-testid=heat-view]', { timeout: 10000 })
  await win.waitForFunction(
    () => document.querySelector('[data-testid=heat-status]')?.getAttribute('data-status') === 'decided',
    undefined,
    { timeout: 60000 }
  )
}

export default async function budgets() {
  const repoDir = makeRepo()
  const profileDir = mkdtempSync(join(tmpdir(), 'regatta-budgets-profile-'))
  // One entry per check, collected from both launches. `t.close()` returns the launch's own
  // results array, so pushing it into a separate array avoids duplicating every check.
  const collected = []
  let t = null
  let tLoop = null

  try {
    t = await launch('budgets', { cwd: repoDir, profile: profileDir })
    const { win } = t

    await t.step('open Settings > Usage and set Test Agent budget to 1 token', async () => {
      await win.keyboard.press('Meta+,')
      await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
      await win.click('[data-testid=settings-nav-usage]')
      await win.waitForSelector('[data-testid=budgets-panel]', { timeout: 8000 })
      const input = win.locator('[data-testid=budget-fake]')
      await input.waitFor({ timeout: 8000 })
      await input.fill('1')
      await win.waitForTimeout(300)
      t.check('budget input for fake is 1', (await input.inputValue()) === '1')
      await t.shot('01-budgets-panel')
      await win.keyboard.press('Escape')
      await win.waitForFunction(() => !document.querySelector('[data-testid=settings-screen]'), null, { timeout: 8000 })
    })

    await t.step('run initial heat to push Test Agent over its 1 token budget, then start second heat and see Not started', async () => {
      // First heat runs and records 1234 tokens in the ledger (or stops mid-run when 1234 > 1)
      await runSingleHeat(win, 'First task to use tokens')
      const firstTexts = await win.locator('[data-testid=heat-lane]').allTextContents()
      t.check(
        'first heat pushed Test Agent past its 1 token budget',
        firstTexts.some((s) => s.includes('Stopped: Test Agent passed its daily budget') || s.includes('Not started: Test Agent is past its daily budget')),
        firstTexts.join(' | ')
      )

      // Start a second heat now that Test Agent is already over budget before starting
      await win.click('[data-testid=skipper-button]')
      await win.waitForTimeout(200)
      await runSingleHeat(win, 'Second task when already over budget')
      const secondTexts = await win.locator('[data-testid=heat-lane]').allTextContents()
      t.check(
        'lane says Not started when over budget',
        secondTexts.some((s) => s.includes('Not started: Test Agent is past its daily budget')),
        secondTexts.join(' | ')
      )
      await t.shot('02-heat-not-started')
      // Close Skipper overlay
      await win.keyboard.press('Escape')
      await win.waitForTimeout(300)
    })

    await t.step('Chat warning and pane badge show for an over-budget agent', async () => {
      // Start a Test Agent pane in Code mode and check the pane header badge
      await t.startAgent('Test Agent')
      const sid = await t.sessionId(0)
      await win.waitForSelector(`[data-testid="pane-budget-${sid}"]`, { timeout: 8000 })
      const badgeText = await win.locator(`[data-testid="pane-budget-${sid}"]`).textContent()
      t.check('pane header shows Over budget badge', badgeText?.includes('Over budget'), badgeText ?? '')

      // Switch to Chat mode and pick Test Agent
      await win.keyboard.press('Meta+3')
      await win.waitForSelector('[data-testid="chat-mode"]', { timeout: 8000 })
      await win.click('[data-testid="chat-new"]')
      await win.waitForSelector('[data-testid="chat-agent"]', { timeout: 8000 })
      await win.selectOption('[data-testid="chat-agent"]', { label: 'Test Agent' })
      await win.waitForSelector('[data-testid="chat-budget-warning"]', { timeout: 8000 })
      const warningText = await win.locator('[data-testid="chat-budget-warning"]').textContent()
      t.check(
        'chat composer shows over-budget warning',
        warningText === "Past today's budget for Test Agent. Turns still run.",
        warningText ?? ''
      )
      await t.shot('03-chat-budget-warning')
    })

    await t.step('screenshot the budgets panel with over-budget state and clear the budget', async () => {
      await win.keyboard.press('Meta+,')
      await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
      await win.click('[data-testid=settings-nav-usage]')
      await win.waitForSelector('[data-testid=budgets-panel]', { timeout: 8000 })
      const stateAttr = await win.locator('[data-testid=budget-state-fake]').getAttribute('data-state')
      t.check('budgets panel shows over state for Test Agent', stateAttr === 'over', String(stateAttr))
      await t.shot('04-budgets-panel-over')

      // Clear the budget
      const input = win.locator('[data-testid=budget-fake]')
      await input.fill('')
      await win.waitForFunction(
        () => document.querySelector('[data-testid=budget-state-fake]')?.getAttribute('data-state') === 'none',
        null,
        { timeout: 8000 }
      )
      t.check('clearing budget resets state', true)
      await win.keyboard.press('Escape')
      await win.waitForTimeout(300)
    })

    collected.push(...(await t.close()))
    t = null

    // Launch with REGATTA_FAKE_SCENARIO=loop and verify the loop guard stops the heat lane
    tLoop = await launch('budgets-loop', {
      cwd: repoDir,
      profile: profileDir,
      env: { REGATTA_FAKE_SCENARIO: 'loop' }
    })
    const { win: wLoop } = tLoop

    await tLoop.step('run a heat with REGATTA_FAKE_SCENARIO=loop and see loop guard stop it', async () => {
      await runSingleHeat(wLoop, 'Task that triggers loop scenario')
      const laneTexts = await wLoop.locator('[data-testid=heat-lane]').allTextContents()
      tLoop.check(
        'lane shows Stopped: `npm test` failed the same way 3 times.',
        laneTexts.some((s) => s.includes('Stopped: `npm test` failed the same way 3 times.')),
        laneTexts.join(' | ')
      )
      await tLoop.shot('05-heat-loop-stopped')
    })

    collected.push(...(await tLoop.close()))
    tLoop = null
  } finally {
    // Never leave an Electron app running, even when a step threw.
    if (t) await t.close().catch(() => undefined)
    if (tLoop) await tLoop.close().catch(() => undefined)
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(profileDir, { recursive: true, force: true })
  }

  return collected
}
