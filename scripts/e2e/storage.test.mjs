// Settings > Storage lists the leftover worktrees git really made (one folder down, as panes make them,
// and directly in the worktrees folder, as heats, night watch and flows do), moves the selected one to
// Regatta's trash with its files and branch kept, keeps a locked one in place and says why, lists trashed
// worktrees under Regatta's trash, and deletes them and their branches only when Empty trash is confirmed.
// Settings > About shows the version and the open source notices. Screenshots go to /tmp/regatta-e2e/storage/.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
}

/** A throwaway repository with one commit. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'regatta-e2e-storage-repo-'))
  git(['init', '-b', 'main'], repo)
  writeFileSync(join(repo, 'README.md'), '# regatta storage\n')
  git(['add', '.'], repo)
  git(['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'first commit'], repo)
  return repo
}

/** A worktree git really makes, so a fresh app scan finds it under the worktrees folder. */
function addWorktree(repo, home, name) {
  mkdirSync(join(home, 'proj'), { recursive: true })
  const path = join(home, 'proj', name)
  git(['worktree', 'add', '-b', `regatta/${name}`, path, 'HEAD'], repo)
  return path
}

function branchExists(repo, name) {
  return git(['branch', '--list', `regatta/${name}`], repo).trim() !== ''
}

export default async function storage() {
  const repo = makeRepo()
  const worktreesHome = mkdtempSync(join(tmpdir(), 'regatta-e2e-storage-wt-'))
  const clean = addWorktree(repo, worktreesHome, 'clean')
  writeFileSync(join(clean, 'notes.txt'), 'my unsaved notes\n')
  const dirty = addWorktree(repo, worktreesHome, 'dirty')
  git(['worktree', 'lock', '--reason', 'on a drive that is not always there', dirty], repo)

  // The app reads this when it scans, so it is set before the window opens.
  const t = await launch('storage', { env: { REGATTA_WORKTREES_DIR: worktreesHome } })
  const { win } = t
  let results = []

  const rowFor = (name) => win.locator(`[data-testid=storage-leftover][data-path$="/proj/${name}"]`)
  const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim()
  /** The Settings content area scrolls; the leftovers sit below the items, so bring them into the picture. */
  const scrollContent = (toEnd) =>
    win.evaluate((end) => {
      const anchor = document.querySelector('[data-testid=storage-items]') ?? document.body
      let el = anchor
      while (el && !['auto', 'scroll'].includes(getComputedStyle(el).overflowY)) el = el.parentElement
      if (el) el.scrollTop = end ? el.scrollHeight : 0
    }, toEnd)

  try {
    await t.step('opens Settings > Storage and lists what Regatta keeps', async () => {
      await win.keyboard.press('Meta+,')
      await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
      await win.click('[data-testid=settings-nav-storage]')
      await win.waitForSelector('[data-testid=storage-item-worktrees]', { timeout: 20000 })
      const ids = ['worktrees', 'checkpoints', 'conversations', 'nights', 'videos', 'models', 'accounts']
      for (const id of ids) t.check(`item ${id} is listed with a Show in Finder button`, (await win.locator(`[data-testid=storage-item-${id}]`).count()) === 1 && (await win.locator(`[data-testid=storage-reveal-${id}]`).count()) === 1)
      const worktreesItem = await text(win.locator('[data-testid=storage-item-worktrees]'))
      t.check('the worktrees item shows a size', /\d/.test(worktreesItem) && !worktreesItem.includes('not measured'), worktreesItem)
      // A folder that does not exist yet reads "nothing yet"; "not measured" is kept for one that could not be read (polish-2).
      t.check('a folder that is not there says nothing yet', (await text(win.locator('[data-testid=storage-item-videos]'))).includes('nothing yet'))
      await win.waitForSelector('[data-testid=storage-leftover]', { timeout: 30000 })
      t.check('the scan time is shown', /Scanned \d\d:\d\d/.test(await win.locator('main, body').first().innerText()))
      t.check('trash starts empty', (await text(win.locator('[data-testid=storage-trash-empty]'))) === 'Trash is empty.')
      await t.shot('01-storage-items')
    })

    await t.step('lists the removable leftover with a checkbox and the locked one with its reason', async () => {
      t.check('two leftovers', (await win.locator('[data-testid=storage-leftover]').count()) === 2)
      const cleanRow = rowFor('clean')
      const dirtyRow = rowFor('dirty')
      t.check('clean row is removable', (await cleanRow.getAttribute('data-removable')) === 'true')
      t.check('locked row is kept', (await dirtyRow.getAttribute('data-removable')) === 'false')
      const cleanText = await text(cleanRow)
      t.check('the row shows the folder, the repository and the branch', cleanText.includes('clean') && cleanText.includes('on regatta/clean'), cleanText.slice(0, 100))
      t.check('the row shows a size and when it changed', /(\d+(\.\d)? ?(B|KB|MB))/.test(cleanText) && cleanText.includes('changed'), cleanText.slice(0, 100))
      t.check('the removable row has a checkbox', (await cleanRow.locator('input[type=checkbox]').count()) === 1)
      t.check('the kept row has no checkbox', (await dirtyRow.locator('input[type=checkbox]').count()) === 0)
      const reason = await text(dirtyRow.locator('[data-testid=storage-leftover-reason]'))
      t.check('the kept row says why it is kept', reason.includes('locked') && reason.includes('on a drive that is not always there'), reason)
      t.check('the kept row has Show in Finder and Copy command', (await dirtyRow.locator('[data-testid=storage-leftover-reveal]').count()) === 1 && (await dirtyRow.locator('[data-testid=storage-leftover-copy]').count()) === 1)
      t.check('the removable row has no reason', (await cleanRow.locator('[data-testid=storage-leftover-reason]').count()) === 0)
      t.check(
        'the hint says selected worktrees move to trash and branches stay until trash is emptied',
        (await text(win.locator('[data-testid=storage-hint]'))) === "Selected worktrees move into Regatta's trash with their files and commits kept. Branches stay until you empty the trash."
      )
      t.check('Move to trash waits for a pick', await win.locator('[data-testid=storage-remove]').isDisabled())
      await scrollContent(true)
      await t.shot('02-storage-leftovers')
    })

    await t.step('Show in Finder reveals the right folder (Finder itself is stubbed out)', async () => {
      // Opening a real Finder window would disturb whoever runs this, so main only records the call.
      await t.app.evaluate(({ shell }) => {
        globalThis.__revealed = []
        globalThis.__realReveal = shell.showItemInFolder
        shell.showItemInFolder = (path) => globalThis.__revealed.push(path)
      })
      try {
        await win.click('[data-testid=storage-reveal-worktrees]')
        await rowFor('dirty').locator('[data-testid=storage-leftover-reveal]').click()
        await win.waitForTimeout(500)
        const asked = await t.app.evaluate(() => globalThis.__revealed)
        t.check('the item button reveals the worktrees folder', asked[0] === worktreesHome, String(asked[0]))
        t.check('the kept row reveals its own folder', asked[1] === dirty, String(asked[1]))
      } finally {
        await t.app.evaluate(({ shell }) => {
          shell.showItemInFolder = globalThis.__realReveal
        })
      }
    })

    await t.step('Copy command puts the git command on the clipboard', async () => {
      // The clipboard is the real one of whoever runs this test: put their text back afterwards.
      const before = await t.app.evaluate(({ clipboard }) => clipboard.readText())
      await rowFor('dirty').locator('[data-testid=storage-leftover-copy]').click()
      await win.waitForFunction(() => document.querySelector('[data-testid=storage-leftover-copy]')?.textContent?.includes('Copied'), null, { timeout: 5000 })
      const copied = await t.app.evaluate(({ clipboard }) => clipboard.readText())
      await t.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before)
      const expected = `git -C "${realpathSync(repo)}" worktree remove "${dirty}"`
      t.check('the clipboard holds the command', copied === expected, copied)
      await win.waitForFunction(() => document.querySelector('[data-testid=storage-leftover-copy]')?.textContent?.includes('Copy command'), null, { timeout: 8000 })
      t.check('the Copied note goes away again', true)
    })

    await t.step('Select all picks only what can be moved to trash', async () => {
      await win.click('[data-testid=storage-select-all]')
      const boxes = win.locator('[data-testid=storage-leftover] input[type=checkbox]')
      t.check('one checkbox exists and it is checked', (await boxes.count()) === 1 && (await boxes.first().isChecked()))
      t.check('the button now offers to clear', (await text(win.locator('[data-testid=storage-select-all]'))) === 'Clear')
      await win.click('[data-testid=storage-select-all]')
      t.check('and clearing unchecks it', !(await boxes.first().isChecked()))
    })

    await t.step('moves the selected leftover to trash with its unsaved file intact and keeps the locked one and both branches', async () => {
      await rowFor('clean').locator('input[type=checkbox]').check()
      await win.click('[data-testid=storage-remove]')
      await win.waitForSelector('[data-testid=storage-confirm]', { timeout: 8000 })
      const confirmText = await text(win.locator('[data-testid=storage-confirm-panel]'))
      t.check(
        'the confirmation states the count and trash behavior',
        confirmText.includes("Move 1 worktree to Regatta's trash? Its folder moves into .regatta-trash; its branch stays until you empty the trash."),
        confirmText
      )
      await scrollContent(true)
      await t.shot('02b-confirm')
      await win.click('[data-testid=storage-confirm]')
      await win.waitForSelector('[data-testid=storage-result]', { timeout: 60000 })
      t.check('the result is told', (await text(win.locator('[data-testid=storage-result]'))) === "Moved 1 worktree to Regatta's trash.")
      t.check('the moved row is gone from the leftovers list', (await rowFor('clean').count()) === 0)
      t.check('the locked row is still listed with its reason', (await rowFor('dirty').count()) === 1 && (await text(rowFor('dirty').locator('[data-testid=storage-leftover-reason]'))).includes('locked'))
      t.check('the old folder is gone from its original path', !existsSync(clean))
      t.check('both branches remain', branchExists(repo, 'clean') && branchExists(repo, 'dirty'))
      const trashEntry = win.locator('[data-testid=storage-trash-entry]')
      t.check('the moved worktree is listed in Regatta\'s trash', (await trashEntry.count()) === 1)
      const trashPath = await trashEntry.first().getAttribute('data-trash-path')
      t.check('its unsaved file is preserved inside .regatta-trash', Boolean(trashPath) && readFileSync(join(trashPath, 'notes.txt'), 'utf8') === 'my unsaved notes\n')
      t.check('git still lists the repaired trashed worktree', Boolean(trashPath) && git(['worktree', 'list', '--porcelain'], repo).includes(`worktree ${realpathSync(trashPath)}`))
      await scrollContent(true)
      await t.shot('03-after-remove')
    })

    await t.step('a worktree that gets locked after the scan is kept when moving to trash is asked', async () => {
      const racy = addWorktree(repo, worktreesHome, 'racy')
      await win.click('[data-testid=storage-scan]')
      await win.waitForSelector('[data-testid=storage-leftover][data-path$="/proj/racy"][data-removable=true]', { timeout: 30000 })
      writeFileSync(join(racy, 'late.txt'), 'made after the scan\n')
      git(['worktree', 'lock', '--reason', 'locked after the scan', racy], repo)
      await rowFor('racy').locator('input[type=checkbox]').check()
      await win.click('[data-testid=storage-remove]')
      await win.waitForSelector('[data-testid=storage-confirm]', { timeout: 8000 })
      await win.click('[data-testid=storage-confirm]')
      await win.waitForSelector('[data-testid=storage-result]', { timeout: 60000 })
      t.check('the result says nothing was moved to trash and one was kept', (await text(win.locator('[data-testid=storage-result]'))) === 'Nothing was moved to trash. 1 was kept, its reason is shown above.')
      const row = rowFor('racy')
      t.check('the row is kept and tells why', (await row.getAttribute('data-removable')) === 'false' && (await text(row.locator('[data-testid=storage-leftover-reason]'))).includes('locked after the scan'))
      t.check('the folder and its file are there', readFileSync(join(racy, 'late.txt'), 'utf8') === 'made after the scan\n')
      t.check('its branch remains', branchExists(repo, 'racy'))
      await scrollContent(true)
      await t.shot('04-kept-at-removal')
    })

    await t.step('a heat-shaped worktree directly in the folder is listed and moved to trash, then Empty trash deletes both trashed entries and their branches', async () => {
      // Heats, night watch and flows make their worktrees directly in the worktrees folder, not one level down.
      const lane = join(worktreesHome, 'heat-7-claude')
      git(['worktree', 'add', '-b', 'regatta/heat-7-claude', lane, 'HEAD'], repo)
      const laneRow = win.locator('[data-testid=storage-leftover][data-path$="/heat-7-claude"]')
      await win.click('[data-testid=storage-scan]')
      await win.waitForSelector('[data-testid=storage-leftover][data-path$="/heat-7-claude"][data-removable=true]', { timeout: 30000 })
      t.check('the lane is listed with its branch', (await text(laneRow)).includes('on regatta/heat-7-claude'))
      await laneRow.locator('input[type=checkbox]').check()
      await win.click('[data-testid=storage-remove]')
      await win.waitForSelector('[data-testid=storage-confirm]', { timeout: 8000 })
      await win.click('[data-testid=storage-confirm]')
      await win.waitForSelector('[data-testid=storage-result]', { timeout: 60000 })
      t.check('the result is told', (await text(win.locator('[data-testid=storage-result]'))).startsWith("Moved 1 worktree to Regatta's trash."))
      t.check('the lane moved to trash and its branch remains', !existsSync(lane) && branchExists(repo, 'heat-7-claude'))
      t.check('two entries are listed in Regatta\'s trash', (await win.locator('[data-testid=storage-trash-entry]').count()) === 2)

      await win.click('[data-testid=storage-empty-trash]')
      await win.waitForSelector('[data-testid=storage-empty-trash-confirm-panel]', { timeout: 8000 })
      const willDelete = await text(win.locator('[data-testid=storage-empty-trash-will-delete]'))
      t.check('Empty trash confirmation lists both trashed entries and their branches', willDelete.includes('Will delete (2):') && willDelete.includes('clean (regatta/clean)') && willDelete.includes('heat-7-claude (regatta/heat-7-claude)'), willDelete)
      await win.click('[data-testid=storage-empty-trash-confirm]')
      await win.waitForSelector('[data-testid=storage-empty-trash-result]', { timeout: 60000 })
      t.check('trash is empty after confirming', (await win.locator('[data-testid=storage-trash-empty]').count()) === 1 && (await win.locator('[data-testid=storage-trash-entry]').count()) === 0)
      t.check('emptying trash deletes the owned branches of the trashed entries', !branchExists(repo, 'clean') && !branchExists(repo, 'heat-7-claude'))
      t.check('git no longer lists the emptied worktrees', !git(['worktree', 'list', '--porcelain'], repo).includes('heat-7-claude') && !git(['worktree', 'list', '--porcelain'], repo).includes('/clean'))
    })

    await t.step('says so when no worktree is left', async () => {
      // The user clears the rest by hand, outside Regatta (this test's own throwaway folders).
      for (const name of ['dirty', 'racy']) {
        git(['worktree', 'unlock', join(worktreesHome, 'proj', name)], repo)
        git(['worktree', 'remove', '--force', join(worktreesHome, 'proj', name)], repo)
      }
      await win.click('[data-testid=storage-scan]')
      await win.waitForSelector('[data-testid=storage-empty]', { timeout: 30000 })
      t.check('the empty message is shown', (await text(win.locator('[data-testid=storage-empty]'))) === 'No leftover worktrees.')
      t.check('no rows, no buttons to remove, no hint', (await win.locator('[data-testid=storage-leftover]').count()) === 0 && (await win.locator('[data-testid=storage-remove]').count()) === 0 && (await win.locator('[data-testid=storage-hint]').count()) === 0)
      t.check('the branches of the untouched leftovers are still there', ['dirty', 'racy'].every((name) => branchExists(repo, name)))
    })

    await t.step('About shows the version and the notices', async () => {
      await win.click('[data-testid=settings-nav-about]')
      await win.waitForSelector('[data-testid=about-notice]', { timeout: 10000 })
      const version = await text(win.locator('[data-testid=about-version]'))
      t.check('version shown', /^v\d+\.\d+\.\d+/.test(version), version)
      const body = await win.locator('main, body').first().innerText()
      t.check('the license line is shown', body.includes('Free and open source under the MIT license.'))
      t.check('what Regatta does is said', body.includes('Regatta runs the agent CLIs you already have, on your own accounts, and never adds a markup.'))
      t.check('the notices have a title', body.includes('Open source notices'))
      const notices = await win.locator('[data-testid=about-notice]').allInnerTexts()
      const electron = notices.find((n) => n.includes('Electron'))
      t.check('notices are listed, with Electron and its MIT license', notices.length > 1 && Boolean(electron) && electron.includes('MIT') && /\d+\.\d+/.test(electron), `${notices.length} notices`)
      const overflow = await win.locator('[data-testid=about-licenses]').evaluate((el) => getComputedStyle(el).overflowY)
      t.check('the list scrolls', overflow === 'auto' || overflow === 'scroll', overflow)
      await t.shot('05-about')
    })
  } finally {
    results = await t.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreesHome, { recursive: true, force: true })
  }

  return results
}
