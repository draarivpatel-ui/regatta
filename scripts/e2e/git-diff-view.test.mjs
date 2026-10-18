// Git panel diff view: two-hunk diff, line numbering, faint hunk headers,
// no raw diff --git header, and rename paths shown as "old to new".

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  return dir
}

export default async function gitDiffView() {
  const project = makeRepo('rg-e2e-diffview-')

  // Create a file with 40 lines so changes at line 2 and line 38 form two distinct hunks.
  const lines = []
  for (let i = 1; i <= 40; i++) {
    lines.push(`line ${i}`)
  }
  writeFileSync(join(project, 'two-hunk.txt'), lines.join('\n') + '\n')
  writeFileSync(join(project, 'old-name.txt'), 'rename me\n')
  sh(['add', '.'], project)
  sh([...IDENTITY, 'commit', '-m', 'initial commit'], project)

  // Edit two-hunk.txt at line 2 and line 38 to produce two hunks.
  lines[1] = 'edited line 2'
  lines[37] = 'edited line 38'
  writeFileSync(join(project, 'two-hunk.txt'), lines.join('\n') + '\n')

  // Stage a rename of old-name.txt to new-name.txt.
  sh(['mv', 'old-name.txt', 'new-name.txt'], project)

  const t = await launch('git-diff-view', { cwd: project })
  const { win } = t

  await t.step('open the git panel', async () => {
    await win.click('[data-testid=panel-git]')
    await win.waitForSelector('[data-testid=side-panel-git]', { timeout: 8000 })
    await win.waitForSelector('[data-testid="git-file-two-hunk.txt"]', { timeout: 8000 })
    t.check('Changes list shows two-hunk.txt', (await win.locator('[data-testid=git-changes] [data-testid="git-file-two-hunk.txt"]').count()) === 1)
    t.check('Staged list shows new-name.txt', (await win.locator('[data-testid=git-staged] [data-testid="git-file-new-name.txt"]').count()) === 1)
  })

  await t.step('open two-hunk diff: see line numbers, faint hunk headers, no diff --git', async () => {
    await win.click('[data-testid=git-changes] [data-testid="git-file-two-hunk.txt"]')
    await win.waitForSelector('[data-testid=git-diff]', { timeout: 8000 })
    await win.waitForSelector('[data-testid=git-diff-lines]', { timeout: 8000 })

    const shown = await win.locator('[data-testid=git-diff]').innerText()
    t.check('the diff title shows the file path', (await win.locator('[data-testid=git-diff-path]').innerText()) === 'two-hunk.txt')
    t.check('the diff is tagged Not staged', shown.includes('Not staged'))
    t.check('raw diff --git header is hidden', !shown.includes('diff --git'))
    t.check('raw index line is hidden', !/^index /m.test(shown))
    t.check('raw --- and +++ lines are hidden', !shown.includes('--- a/') && !shown.includes('+++ b/'))

    const hunks = win.locator('[data-testid=git-diff-lines] [data-kind=hunk]')
    t.check('exactly two hunks are present', (await hunks.count()) === 2)
    t.check('first hunk header starts with @@', (await hunks.nth(0).innerText()).startsWith('@@'))
    t.check('second hunk header starts with @@', (await hunks.nth(1).innerText()).startsWith('@@'))

    const adds = win.locator('[data-testid=git-diff-lines] [data-kind=add]')
    const dels = win.locator('[data-testid=git-diff-lines] [data-kind=del]')
    t.check('first hunk del line has old number 2', (await dels.nth(0).locator('[data-testid=git-diff-old]').innerText()).trim() === '2')
    t.check('first hunk del line has empty new number', (await dels.nth(0).locator('[data-testid=git-diff-new]').innerText()).trim() === '')
    t.check('first hunk add line has new number 2', (await adds.nth(0).locator('[data-testid=git-diff-new]').innerText()).trim() === '2')
    t.check('first hunk add line has empty old number', (await adds.nth(0).locator('[data-testid=git-diff-old]').innerText()).trim() === '')

    t.check('second hunk del line has old number 38', (await dels.nth(1).locator('[data-testid=git-diff-old]').innerText()).trim() === '38')
    t.check('second hunk add line has new number 38', (await adds.nth(1).locator('[data-testid=git-diff-new]').innerText()).trim() === '38')

    const firstCtx = win.locator('[data-testid=git-diff-lines] [data-kind=ctx]').first()
    t.check('context line has old and new number 1',
      (await firstCtx.locator('[data-testid=git-diff-old]').innerText()).trim() === '1' &&
      (await firstCtx.locator('[data-testid=git-diff-new]').innerText()).trim() === '1'
    )

    await t.shot('01-two-hunk-diff')

    await win.click('[data-testid=git-diff-back]')
    await win.waitForSelector('[data-testid="git-file-two-hunk.txt"]', { timeout: 8000 })
    t.check('diff closed after clicking back', (await win.locator('[data-testid=git-diff]').count()) === 0)
  })

  await t.step('open rename diff: title shows old to new', async () => {
    await win.click('[data-testid=git-staged] [data-testid="git-file-new-name.txt"]')
    await win.waitForSelector('[data-testid=git-diff]', { timeout: 8000 })

    const title = await win.locator('[data-testid=git-diff-path]').innerText()
    t.check('rename title shows "old to new"', title === 'old-name.txt to new-name.txt')
    t.check('the diff is tagged Staged', (await win.locator('[data-testid=git-diff]').innerText()).includes('Staged'))

    await t.shot('02-rename-diff')

    await win.click('[data-testid=git-diff-back]')
    await win.waitForSelector('[data-testid="git-file-new-name.txt"]', { timeout: 8000 })
  })

  const results = await t.close()
  rmSync(project, { recursive: true, force: true })
  return results
}
