// Two real Test Agent runs each get a fresh worktree and branch, with attempt 2 based on attempt 1's commit.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './lib.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 }).trim()
}

export default async function handoff() {
  const repo = mkdtempSync('/tmp/regatta-handoff-e2e-')
  let t
  try {
    git(repo, 'init', '-b', 'main')
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
    writeFileSync(join(repo, 'app.test.js'), "it('ok', () => expect(1).toBe(1))\n")
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    t = await launch('handoff', { cwd: repo })
    const { win } = t
    await t.step('form chooses two Test Agent attempts', async () => {
      await win.click('[data-testid=skipper-button]')
      await win.click('[data-testid=heat-new]')
      await win.click('[data-testid=skipper-tab-handoff]')
      await win.waitForSelector('[data-testid=handoff-form]')
      await win.locator('[data-testid=handoff-goal]').fill('Improve the app with two accumulated changes')
      await win.locator('[data-testid=handoff-preference]').selectOption('quality')
      await win.locator('[data-testid=handoff-agent-scope]').selectOption('picked')
      await win.locator('[data-testid=handoff-agent][data-agent=fake]').check()
      await win.locator('[data-testid=handoff-agent-plus][data-agent=fake]').click()
      await win.locator('[data-testid=handoff-attempts]').selectOption('2')
      await win.waitForSelector('[data-testid=handoff-check-name]')
      while (await win.locator('[data-testid=handoff-check-remove]').count()) await win.locator('[data-testid=handoff-check-remove]').first().click()
      await win.click('[data-testid=handoff-check-add]')
      await win.locator('[data-testid=handoff-check-name]').fill('two changes')
      await win.locator('[data-testid=handoff-check-command]').fill('test "$(grep -c \'changed by test agent\' src/app.js)" -ge 2')
      t.check('two attempts appear in the order', await win.locator('[data-testid=handoff-order-item]').count() === 2)
      t.check('start is available', await win.locator('[data-testid=handoff-start]').isEnabled())
      await t.shot('01-handoff-form')
    })

    await t.step('second attempt wins in its own worktree based on attempt 1 commit', async () => {
      await win.click('[data-testid=handoff-start]')
      await win.waitForSelector('[data-testid=heat-view]')
      await win.waitForSelector('[data-testid=heat-status][data-status=decided]', { timeout: 60000 })
      const heats = await win.evaluate(() => window.regatta.invoke('heats:list'))
      const heat = heats.find((heat) => heat.mode === 'handoff')
      t.check('one hand-off has two numbered attempts', heat?.lanes.length === 2 && heat.lanes[0].attempt === 1 && heat.lanes[1].attempt === 2)
      t.check('both attempts finished', await win.locator('[data-testid=heat-lane][data-phase=done]').count() === 2)
      t.check('the second attempt is the winner', heat?.decision?.kind === 'winner' && heat.decision.laneIds[0] === heat.lanes[1].id)
      t.check('attempt 1 failed its required check', heat?.lanes[0].checks[0].passed === false)
      t.check('attempt 2 passed its required check', heat?.lanes[1].checks[0].passed === true)
      t.check(
        'each attempt has its own worktree and branch',
        heat?.lanes[0].worktree !== heat?.lanes[1].worktree &&
          heat?.lanes[0].branch === `regatta/heat-${heat.id}-a1` &&
          heat?.lanes[1].branch === `regatta/heat-${heat.id}-a2`
      )
      const prompt = readFileSync(join(heat.lanes[1].worktree, 'DONE.txt'), 'utf8')
      t.check('Test Agent received failed gates and activity in its prompt', prompt.includes('BEGIN PREVIOUS ATTEMPT EVIDENCE') && prompt.includes('checks: failing: two changes') && prompt.includes('Previous activity (last 20 lines):'))
      t.check('both attempt worktrees and branches are visible', (await win.locator('[data-testid=handoff-worktree]').count()) === 2 && (await win.locator('[data-testid=handoff-branch]').count()) === 2)
      await t.shot('02-handoff-decided')
    })

    await t.step('merge brings both changes home and moves both attempt worktrees to trash', async () => {
      const heat = (await win.evaluate(() => window.regatta.invoke('heats:list'))).find((heat) => heat.mode === 'handoff')
      await win.click('[data-testid=heat-merge]')
      await win.waitForSelector('[data-testid=heat-merged]', { timeout: 20000 })
      const mergedText = await win.locator('[data-testid=heat-merged]').innerText()
      t.check('merge summary counts two worktrees moved to trash', mergedText.includes('Removed 2 worktrees and 0 branches.') && mergedText.includes("Moved its worktree to Regatta's trash"), mergedText)
      t.check('main is at the tested second tip', git(repo, 'rev-parse', 'HEAD') === heat.lanes[1].tip)
      t.check('both edits were merged', readFileSync(join(repo, 'src', 'app.js'), 'utf8').split('changed by test agent').length - 1 === 2)
      t.check('both attempt worktrees moved to .regatta-trash', !existsSync(heat.lanes[0].worktree) && !existsSync(heat.lanes[1].worktree) && readdirSync(join(t.world, 'worktrees', '.regatta-trash')).length === 2)
      t.check('both attempt branches stay until trash is emptied', git(repo, 'branch', '--list', `regatta/heat-${heat.id}-*`).includes(`regatta/heat-${heat.id}-a1`) && git(repo, 'branch', '--list', `regatta/heat-${heat.id}-*`).includes(`regatta/heat-${heat.id}-a2`))
      await t.shot('03-handoff-merged')
    })
    const results = await t.close()
    t = null
    return results
  } finally {
    if (t) await t.close()
    rmSync(repo, { recursive: true, force: true })
  }
}
