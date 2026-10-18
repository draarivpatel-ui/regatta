// Heats end to end: start a heat with two Test Agent lanes, wait for a decision, merge.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

const CART = "it('adds', () => { expect(1).toBe(1) })\nit('subtracts', () => { expect(2).toBe(2) })\n"

function sh(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-heats-e2e-'))
  sh(['init', '-b', 'main'], dir)
  mkdirSync(join(dir, 'test'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'test', 'cart.test.js'), CART)
  writeFileSync(join(dir, 'GUARD.txt'), 'guard\n')
  writeFileSync(join(dir, 'src', 'app.js'), 'export const app = 1\n')
  sh(['add', '.'], dir)
  execFileSync(
    'git',
    ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'first commit'],
    { cwd: dir, stdio: 'ignore' }
  )
  return dir
}

export default async function heats() {
  const repoDir = makeRepo()
  const t = await launch('heats', { cwd: repoDir })
  const { win } = t

  await t.step('open skipper and start a new heat', async () => {
    await win.click('[data-testid=skipper-button]')
    await win.waitForSelector('[data-testid=skipper-view]', { timeout: 5000 })
    await win.click('[data-testid=heat-new]')
    await win.waitForSelector('[data-testid=heat-form]', { timeout: 5000 })
    t.check('skipper opens with a new heat form', true)
  })

  await t.step('fill the task', async () => {
    await win.locator('[data-testid=heat-task]').fill('Add DONE.txt and leave the guard alone')
    t.check('task typed', (await win.locator('[data-testid=heat-task]').inputValue()).length > 0)
  })

  await t.step('pick the test agent twice', async () => {
    await win.waitForSelector('[data-testid=heat-agent][data-agent=fake]', { timeout: 8000 })
    await win.locator('[data-testid=heat-agent][data-agent=fake]').click()
    await win.locator('[data-testid=heat-agent-plus][data-agent=fake]').click()
    await win.waitForFunction(
      () => document.querySelector('[data-testid=heat-start]')?.textContent?.includes('2 lanes'),
      undefined,
      { timeout: 5000 }
    )
    t.check('two test agent lanes picked', true)
    await t.shot('01-heat-form')
  })

  await t.step('set the checks', async () => {
    await win.waitForSelector('[data-testid=heat-check-name]', { timeout: 8000 })
    // Remove every row the detector found, then add the two rows the test needs.
    for (let guard = 0; guard < 8; guard++) {
      const n = await win.locator('[data-testid=heat-check-remove]').count()
      if (n === 0) break
      await win.locator('[data-testid=heat-check-remove]').first().click()
      await win.waitForTimeout(120)
    }
    await win.click('[data-testid=heat-check-add]')
    await win.click('[data-testid=heat-check-add]')
    t.check('two check rows added', (await win.locator('[data-testid=heat-check-name]').count()) === 2)

    await win.locator('[data-testid=heat-check-name]').nth(0).fill('done')
    await win.locator('[data-testid=heat-check-command]').nth(0).fill('test -f DONE.txt')
    await win.locator('[data-testid=heat-check-name]').nth(1).fill('guard')
    await win.locator('[data-testid=heat-check-command]').nth(1).fill('test -f GUARD.txt')

    const secondKind = await win.locator('[data-testid=heat-check-kind]').nth(1).getAttribute('data-kind')
    if (secondKind !== 'guard') {
      await win.locator('[data-testid=heat-check-kind]').nth(1).click()
    }
    const kinds = await win.locator('[data-testid=heat-check-kind]').allInnerTexts()
    t.check('checks are done required and guard guard', kinds[0] === 'required' && kinds[1] === 'guard', kinds.join(','))
  })

  await t.step('start and wait for a decision', async () => {
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
    t.check('heat reaches decided', true)
    await t.shot('02-heat-decided')
  })

  await t.step('lanes finished', async () => {
    const done = await win.locator('[data-testid=heat-lane][data-phase=done]').count()
    t.check('two lanes finished', done === 2, `${done} done lanes`)
    // The lanes run in git worktrees. In the fake world they go to the world's own folder, never ~/.regatta/worktrees.
    const made = readdirSync(join(t.world, 'worktrees'))
    t.check('the lane worktrees were made in the world folder', made.length > 0, `${made.length} entries`)
  })

  await t.step('merge the winner', async () => {
    if ((await win.locator('[data-testid=heat-merge]').count()) > 0) {
      await win.locator('[data-testid=heat-merge]').first().click()
    } else {
      await win.locator('[data-testid=heat-keep]').first().click()
    }
    await win.waitForSelector('[data-testid=heat-merged]', { timeout: 20000 })
    t.check('merge summary shows', true)
    await t.shot('03-heat-merged')
    t.check('DONE.txt exists in the repo', existsSync(join(repoDir, 'DONE.txt')))
    const rootEntries = readdirSync(join(t.world, 'worktrees')).filter((name) => name !== '.regatta-trash')
    const trashed = readdirSync(join(t.world, 'worktrees', '.regatta-trash'))
    t.check('the lane worktrees moved into .regatta-trash', rootEntries.length === 0 && trashed.length === 2, `root=${rootEntries.join(',')}, trashed=${trashed.length}`)
  })

  return t.close()
}
