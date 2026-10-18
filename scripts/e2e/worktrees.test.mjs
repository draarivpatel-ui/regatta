// Start a crew: the dialog, the steppers, the worktree toggle and the worktrees git really makes.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
}

/** A throwaway repository with one commit, so `git worktree add` has something to branch from. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'regatta-e2e-repo-'))
  git(['init', '-b', 'main'], repo)
  writeFileSync(join(repo, 'README.md'), '# regatta crew\n')
  git(['add', '.'], repo)
  git(
    ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'first commit'],
    repo
  )
  return repo
}

/** Every line of `git worktree list` as a path and the branch or ref checked out there. */
function worktreeList(repo) {
  return git(['worktree', 'list'], repo)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)\s+[0-9a-f]{7,}\s+[[(](.*)[\])]$/)
      return { path: m[1], ref: m[2].replace(/^HEAD -> /, '') }
    })
}

/** Clicks minus or plus until the row for `kind` shows `target`. */
async function setCount(win, kind, target) {
  const row = win.locator(`[data-testid=crew-row][data-agent="${kind}"]`)
  for (let i = 0; i < 8; i++) {
    const now = Number((await row.locator('[data-testid=crew-count]').innerText()).trim())
    if (now === target) return now
    await row.locator(`[data-testid=${now < target ? 'crew-plus' : 'crew-minus'}]`).click()
    await win.waitForTimeout(60)
  }
  throw new Error(`${kind} never reached ${target}`)
}

async function countOf(win, kind) {
  const row = win.locator(`[data-testid=crew-row][data-agent="${kind}"]`)
  return Number((await row.locator('[data-testid=crew-count]').innerText()).trim())
}

export default async function worktrees() {
  const repo = makeRepo()
  const t = await launch('worktrees', { cwd: repo })
  const { win } = t
  // The fake world gives the app this folder as REGATTA_WORKTREES_DIR, so every worktree has to land in it.
  const worktreesHome = join(t.world, 'worktrees')
  let results = []

  try {
    await t.step('open the crew dialog', async () => {
      await win.click('[data-testid=new-pane-button]')
      await win.locator('[data-testid=new-pane-menu] button', { hasText: 'Start a crew' }).first().click()
      await win.waitForSelector('[data-testid=launchset-dialog]', { timeout: 10000 })
      const title = await win.locator('[data-testid=launchset-dialog] h2').innerText()
      t.check('the dialog says Start a crew', title.trim() === 'Start a crew', title)
      t.check('a row per installed agent', (await win.locator('[data-testid=crew-row]').count()) > 1)
      await win.waitForTimeout(400)
      await t.shot('01-crew-dialog')
    })

    await t.step('steppers', async () => {
      const fake = win.locator('[data-testid=crew-row][data-agent=fake]')
      const first = await countOf(win, 'fake')
      await fake.locator('[data-testid=crew-plus]').click()
      await win.waitForTimeout(80)
      const second = await countOf(win, 'fake')
      t.check('plus adds one', second === first + 1, `${first} then ${second}`)
      await fake.locator('[data-testid=crew-minus]').click()
      await win.waitForTimeout(80)
      t.check('minus takes one back', (await countOf(win, 'fake')) === first)
    })

    await t.step('pick two test agents and none of the rest', async () => {
      const kinds = await win.locator('[data-testid=crew-row]').evaluateAll((rows) => rows.map((r) => r.dataset.agent))
      for (const kind of kinds) await setCount(win, kind, kind === 'fake' ? 2 : 0)
      const counts = {}
      for (const kind of kinds) counts[kind] = await countOf(win, kind)
      t.check(
        'two test agents, zero of everything else',
        counts.fake === 2 && kinds.filter((k) => k !== 'fake').every((k) => counts[k] === 0),
        JSON.stringify(counts)
      )
      const label = await win.locator('[data-testid=crew-start]').innerText()
      t.check('the button says how many will start', label.trim() === 'Start 2 agents', label)
    })

    await t.step('worktree toggle', async () => {
      const toggle = win.locator('[data-testid=crew-isolate]')
      t.check('the toggle starts off', (await toggle.getAttribute('aria-checked')) === 'false')
      await toggle.click()
      await win.waitForTimeout(120)
      t.check('clicking the toggle turns it on', (await toggle.getAttribute('aria-checked')) === 'true')
      await t.shot('02-isolate-on')
    })

    await t.step('start the crew', async () => {
      await win.click('[data-testid=crew-start]')
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=pane]').length === 2, null, { timeout: 30000 })
      t.check('two panes opened', (await win.locator('[data-testid=pane]').count()) === 2)
      t.check('the dialog closed', (await win.locator('[data-testid=launchset-dialog]').count()) === 0)
      await t.shot('03-crew-running')
    })

    await t.step('git really made the worktrees', async () => {
      // git prints real paths, and on macOS the temp folder is behind a symlink.
      const list = worktreeList(repo)
      const projectPath = realpathSync(repo)
      const worktreesPath = realpathSync(worktreesHome)
      t.check('git worktree list shows three entries', list.length === 3, `${list.length} entries`)
      t.check('the first is the project folder itself', list[0].path === projectPath, list[0].path)
      t.check('each new worktree is on a regatta branch', list.slice(1).every((w) => w.ref.startsWith('regatta/')), list.slice(1).map((w) => w.ref).join(', '))
      t.check('the worktrees live under the worktrees folder', list.slice(1).every((w) => w.path.startsWith(worktreesPath)), worktreesPath)
      t.check('the project folder is untouched', git(['status', '--porcelain'], repo).trim() === '')
    })
  } finally {
    results = await t.close()
    rmSync(repo, { recursive: true, force: true })
  }

  // The same dialog in a plain folder: worktrees need a repository, so the toggle is off and off limits.
  const plain = mkdtempSync(join(tmpdir(), 'regatta-e2e-plain-'))
  const t2 = await launch('worktrees-plain', { cwd: plain })
  try {
    await t2.step('outside a git repository', async () => {
      await t2.win.click('[data-testid=new-pane-button]')
      await t2.win.locator('[data-testid=new-pane-menu] button', { hasText: 'Start a crew' }).first().click()
      await t2.win.waitForSelector('[data-testid=launchset-dialog]', { timeout: 10000 })
      await t2.win.waitForSelector('[data-testid=crew-isolate][data-git="none"]', { timeout: 10000 })
      const toggle = t2.win.locator('[data-testid=crew-isolate]')
      t2.check('the worktree toggle is off', (await toggle.getAttribute('aria-checked')) === 'false')
      t2.check('the worktree toggle is disabled', await toggle.isDisabled())
      const text = await t2.win.locator('[data-testid=launchset-dialog]').innerText()
      t2.check('it says why', text.includes('This folder is not a git repository.'))
      await t2.win.waitForTimeout(400)
      await t2.shot('04-no-git')
    })
  } finally {
    results.push(...(await t2.close()))
    rmSync(plain, { recursive: true, force: true })
  }

  return results
}