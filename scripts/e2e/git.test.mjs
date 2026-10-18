// Git panel: changes (including new files), staging, diffs, commit, hook refusals, folder switch.
// Every action goes through the real UI (hover, click, type); git itself is asked to confirm.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']

function sh(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
}

function makeRepo(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  sh(['init', '-b', 'main'], dir)
  sh(['config', 'user.name', 'Regatta Test'], dir)
  sh(['config', 'user.email', 'test@regatta.local'], dir)
  sh(['config', 'commit.gpgsign', 'false'], dir)
  writeFileSync(join(dir, 'README.md'), '# regatta\n')
  writeFileSync(join(dir, 'main.ts'), 'console.log("hello")\n')
  sh(['add', '.'], dir)
  sh([...IDENTITY, 'commit', '-m', 'first commit'], dir)
  return dir
}

const staged = (dir) => sh(['diff', '--cached', '--name-only'], dir).split('\n').filter(Boolean).sort()

export default async function git() {
  const project = makeRepo('rg-e2e-git-')
  const other = makeRepo('rg-e2e-git-other-')
  writeFileSync(join(project, 'README.md'), '# regatta\nedited\n')
  writeFileSync(join(project, 'new-file.txt'), 'brand new\n')
  writeFileSync(join(other, 'b-only.txt'), 'only in the second repository\n')

  const t = await launch('git', { cwd: project })
  const { win } = t
  const row = (path) => win.locator(`[data-testid="git-file-${path}"]`)
  const inChanges = (path) => win.locator(`[data-testid=git-changes] [data-testid="git-file-${path}"]`)
  const inStaged = (path) => win.locator(`[data-testid=git-staged] [data-testid="git-file-${path}"]`)

  await t.step('open the panel', async () => {
    await win.click('[data-testid=panel-git]')
    await win.waitForSelector('[data-testid=side-panel-git]', { timeout: 8000 })
    await inChanges('README.md').waitFor({ timeout: 8000 })
    t.check('the branch name is shown', (await win.locator('[data-testid=git-branch]').innerText()) === 'main')
    t.check('the changed file is under Changes', (await inChanges('README.md').count()) === 1)
    t.check('the new (untracked) file is under Changes too', (await inChanges('new-file.txt').count()) === 1)
    t.check('nothing is staged yet', (await win.locator('[data-testid=git-staged]').count()) === 0)
    t.check('the Changes count says 2', (await win.locator('[data-testid=git-changes]').innerText()).includes('2'))
    t.check('History is there', (await win.locator('[data-testid=git-history]').count()) === 1)
    t.check('Worktrees is there', (await win.locator('[data-testid=git-worktrees]').count()) === 1)
    await t.shot('01-panel-open')
  })

  await t.step('stage one file with the plus button', async () => {
    await inChanges('README.md').hover()
    await win.click('[data-testid="git-stage-README.md"]')
    await inStaged('README.md').waitFor({ timeout: 8000 })
    t.check('the file moved to Staged', (await inStaged('README.md').count()) === 1)
    t.check('it left Changes', (await inChanges('README.md').count()) === 0)
    t.check('the new file is still under Changes', (await inChanges('new-file.txt').count()) === 1)
    t.check('git agrees: only README.md is staged', JSON.stringify(staged(project)) === JSON.stringify(['README.md']))
    await t.shot('02-staged-one')
  })

  await t.step('open the diff, read it, go back', async () => {
    await inStaged('README.md').click()
    await win.waitForSelector('[data-testid=git-diff]', { timeout: 8000 })
    await win.waitForSelector('[data-testid=git-diff-lines]', { timeout: 8000 })
    const shown = await win.locator('[data-testid=git-diff]').innerText()
    t.check('the diff names the file', (await win.locator('[data-testid=git-diff-path]').innerText()) === 'README.md')
    t.check('the diff is tagged Staged', shown.includes('Staged') && !shown.includes('Not staged'))
    t.check('the added line is shown', (await win.locator('[data-testid=git-diff-lines] [data-kind=add]').innerText()).includes('edited'))
    t.check('raw diff --git and index lines are hidden', !shown.includes('diff --git') && !/^index /m.test(shown))
    t.check('the --- and +++ lines are hidden', !shown.includes('--- a/') && !shown.includes('+++ b/'))
    t.check('the hunk header is shown (faint)', (await win.locator('[data-testid=git-diff-lines] [data-kind=hunk]').innerText()).startsWith('@@'))
    const added = win.locator('[data-testid=git-diff-lines] [data-kind=add]')
    t.check('the added line has new line number 2', (await added.locator('[data-testid=git-diff-new]').innerText()).trim() === '2')
    t.check('the added line has no old line number', (await added.locator('[data-testid=git-diff-old]').innerText()).trim() === '')
    const context = win.locator('[data-testid=git-diff-lines] [data-kind=ctx]').first()
    t.check(
      'the unchanged line has both numbers (1 and 1)',
      (await context.locator('[data-testid=git-diff-old]').innerText()).trim() === '1' &&
        (await context.locator('[data-testid=git-diff-new]').innerText()).trim() === '1'
    )
    await t.shot('03-diff-open')
    await win.click('[data-testid=git-diff-back]')
    await inStaged('README.md').waitFor({ timeout: 8000 })
    t.check('back returns to the lists', (await win.locator('[data-testid=git-diff]').count()) === 0)
  })

  await t.step('the diff of a new file shows every line as added', async () => {
    await inChanges('new-file.txt').click()
    await win.waitForSelector('[data-testid=git-diff-lines]', { timeout: 8000 })
    const lines = win.locator('[data-testid=git-diff-lines] [data-kind=add]')
    t.check('one added line with the file text', (await lines.count()) === 1 && (await lines.innerText()).includes('brand new'))
    t.check('it is tagged Not staged', (await win.locator('[data-testid=git-diff]').innerText()).includes('Not staged'))
    await win.click('[data-testid=git-diff-back]')
    await inChanges('new-file.txt').waitFor({ timeout: 8000 })
  })

  await t.step('a change with no text lines is described, not called "No changes"', async () => {
    chmodSync(join(project, 'main.ts'), 0o755)
    await inChanges('main.ts').waitFor({ timeout: 10000 })
    await inChanges('main.ts').click()
    await win.waitForSelector('[data-testid=git-diff-lines]', { timeout: 8000 })
    const shown = await win.locator('[data-testid=git-diff]').innerText()
    t.check('it says the mode changed', shown.includes('Mode changed from 100644 to 100755'))
    t.check('it does not say No changes', !shown.includes('No changes'))
    await win.click('[data-testid=git-diff-back]')
    chmodSync(join(project, 'main.ts'), 0o644)
    await win.waitForSelector('[data-testid="git-file-main.ts"]', { state: 'detached', timeout: 10000 })
  })

  await t.step('a typed message survives the 3 second refresh', async () => {
    await win.fill('[data-testid=git-message]', 'Update README and add new file')
    await win.evaluate(() => {
      document.querySelector('[data-testid=git-message]').__kept = 'same element'
    })
    await win.waitForTimeout(3600)
    const state = await win.evaluate(() => {
      const box = document.querySelector('[data-testid=git-message]')
      return { kept: box?.__kept ?? null, value: box?.value ?? null }
    })
    t.check('the textarea is the same element after a refresh', state.kept === 'same element')
    t.check('the typed message is still there', state.value === 'Update README and add new file')
    t.check('the button counts the staged files', (await win.locator('[data-testid=git-commit]').innerText()) === 'Commit 1 file')
  })

  await t.step('a commit hook turns Commit off and says why, without running the hook', async () => {
    const hook = join(project, '.git', 'hooks', 'pre-commit')
    const marker = join(project, '..', `${project.split('/').pop()}-hook-ran`)
    mkdirSync(join(project, '.git', 'hooks'), { recursive: true })
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`)
    chmodSync(hook, 0o755)
    await win.waitForSelector('[data-testid=git-hooks-notice]', { timeout: 10000 })
    const notice = await win.locator('[data-testid=git-hooks-notice]').innerText()
    t.check(
      'the notice names the hook and says to commit from a terminal',
      notice === 'This repository has git hooks (pre-commit). The Git panel does not run hooks yet, so commit from a terminal.'
    )
    t.check('the Commit button is disabled', await win.locator('[data-testid=git-commit]').isDisabled())
    t.check('the typed message is kept', (await win.inputValue('[data-testid=git-message]')) === 'Update README and add new file')
    t.check('the hook never ran', !existsSync(marker))
    await t.shot('04-hook-refused')
    rmSync(hook)
    await win.waitForSelector('[data-testid=git-hooks-notice]', { state: 'detached', timeout: 10000 })
    t.check('removing the hook turns Commit back on', await win.locator('[data-testid=git-commit]').isEnabled())
  })

  await t.step('a post-index-change hook turns staging off and says why', async () => {
    const hook = join(project, '.git', 'hooks', 'post-index-change')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    chmodSync(hook, 0o755)
    await win.waitForSelector('[data-testid=git-index-hook-notice]', { timeout: 10000 })
    t.check(
      'the notice says to stage from a terminal',
      (await win.locator('[data-testid=git-index-hook-notice]').innerText()).includes('so stage from a terminal')
    )
    t.check('Stage all is disabled', await win.locator('[data-testid=git-stage-all]').isDisabled())
    t.check('the row plus button is disabled', await win.locator('[data-testid="git-stage-new-file.txt"]').isDisabled())
    rmSync(hook)
    await win.waitForSelector('[data-testid=git-index-hook-notice]', { state: 'detached', timeout: 10000 })
    t.check('removing the hook turns staging back on', await win.locator('[data-testid=git-stage-all]').isEnabled())
  })

  await t.step('commit with the button', async () => {
    await win.click('[data-testid=git-commit]')
    await win.waitForSelector('[data-testid=git-commit-success]', { timeout: 15000 })
    const text = await win.locator('[data-testid=git-commit-success]').innerText()
    const hash = sh(['rev-parse', '--short=7', 'HEAD'], project).trim()
    t.check('"Committed <hash>" is shown with the real short hash', text.trim() === `Committed ${hash}`)
    t.check('git has the commit with the typed message', sh(['log', '-1', '--format=%s'], project).trim() === 'Update README and add new file')
    t.check('the message box was cleared', (await win.inputValue('[data-testid=git-message]')) === '')
    await inChanges('new-file.txt').waitFor({ timeout: 8000 })
    // new-file.txt was listed before the commit too, so wait for the refresh to drop README.md before reading.
    await row('README.md').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
    t.check('the committed file left the lists', (await row('README.md').count()) === 0)
    t.check('the untracked file is still listed', (await inChanges('new-file.txt').count()) === 1)
    await t.shot('05-after-commit')
  })

  await t.step('Stage all takes the new file too, and Cmd+Enter commits', async () => {
    await win.click('[data-testid=git-stage-all]')
    await inStaged('new-file.txt').waitFor({ timeout: 8000 })
    t.check('git agrees: new-file.txt is staged', JSON.stringify(staged(project)) === JSON.stringify(['new-file.txt']))
    await win.fill('[data-testid=git-message]', 'Add the new file')
    await win.press('[data-testid=git-message]', 'Meta+Enter')
    await win.waitForSelector('[data-testid=git-commit-success]', { timeout: 15000 })
    t.check('the second commit exists', sh(['log', '-1', '--format=%s'], project).trim() === 'Add the new file')
    await win.waitForSelector('text=No changes.', { timeout: 8000 })
    t.check('the empty state says "No changes."', (await win.locator('text=No changes.').count()) === 1)
    t.check('the commit box is still there with its "Committed" note', (await win.locator('[data-testid=git-commit-success]').count()) === 1)
    await t.shot('06-clean')
  })

  await t.step('history lists the commits', async () => {
    await win.click('[data-testid=git-history] summary')
    await win.waitForSelector('[data-testid=git-history] >> text=Add the new file', { timeout: 8000 })
    const text = await win.locator('[data-testid=git-history]').innerText()
    t.check('history shows all three commits', text.includes('Add the new file') && text.includes('Update README and add new file') && text.includes('first commit'))
  })

  await t.step('a pane in another repository gets its own view', async () => {
    await win.evaluate(
      (cwd) => window.regatta.invoke('session:create', { agent: 'shell', cols: 80, rows: 24, cwd }),
      other
    )
    await win.waitForSelector('[data-testid=git-view-pane]', { timeout: 10000 })
    await win.click('[data-testid=git-view-pane]')
    await inChanges('b-only.txt').waitFor({ timeout: 8000 })
    t.check('the other repository file is shown', (await inChanges('b-only.txt').count()) === 1)
    t.check('the project files are not mixed in', (await win.locator('[data-testid="git-file-new-file.txt"]').count()) === 0)
    await inChanges('b-only.txt').hover()
    await win.click('[data-testid="git-stage-b-only.txt"]')
    await inStaged('b-only.txt').waitFor({ timeout: 8000 })
    t.check('staging happened in the second repository', JSON.stringify(staged(other)) === JSON.stringify(['b-only.txt']))
    t.check('and not in the project', staged(project).length === 0)
    await t.shot('07-other-repo')
    await win.click('[data-testid=git-view-project]')
    await win.waitForSelector('text=No changes.', { timeout: 8000 })
    t.check('switching back shows the project, without the other repository files', (await win.locator('[data-testid="git-file-b-only.txt"]').count()) === 0)
  })

  await t.step('a failed refresh shows the error and marks the retained status stale until fixed', async () => {
    writeFileSync(join(project, '.git', 'index'), 'corrupt')
    await win.click('[data-testid=git-refresh]')
    await win.waitForSelector('[data-testid=git-refresh-error]', { timeout: 10000 })
    const text = await win.locator('[data-testid=git-refresh-error]').innerText()
    t.check('the refresh error names the corrupt index', /index file smaller than expected|index file corrupt/i.test(text))
    t.check('the same notice marks the retained status stale with its time', /Showing the last good status from .+\./.test(text))
    t.check('the retained status is still shown underneath', (await win.locator('text=No changes.').count()) === 1)
    sh(['read-tree', 'HEAD'], project)
    await win.click('[data-testid=git-refresh]')
    await win.waitForSelector('[data-testid=git-refresh-error]', { state: 'detached', timeout: 10000 })
    t.check('restoring the index clears the error and stale notice', (await win.locator('[data-testid=git-refresh-error]').count()) === 0)
  })

  const results = await t.close()
  rmSync(project, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
  return results
}
