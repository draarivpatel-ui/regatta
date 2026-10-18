// Find panel: search the project, open a result in the Files panel.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './lib.mjs'

export default async function find() {
  const dir = mkdtempSync('/tmp/regatta-find-e2e-')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.ts'), 'const answer = 42\n')

  const t = await launch('find', { cwd: dir })
  const { win } = t

  await t.step('find panel opens', async () => {
    await win.click('[data-testid=panel-find]')
    t.check('the find panel shows its input', await win.locator('[data-testid=find-input]').count())
    await t.shot('01-find-panel')
  })

  await t.step('search finds the match', async () => {
    await win.click('[data-testid=find-input]')
    await win.keyboard.type('answer')
    await win.keyboard.press('Enter')
    await win.waitForSelector('[data-testid=find-result]', { timeout: 15000 })
    const rows = await win.locator('[data-testid=find-result]').count()
    t.check('exactly one result row', rows === 1, `${rows} rows`)
    const path = await win.locator('[data-testid=find-result]').first().getAttribute('data-path')
    const line = await win.locator('[data-testid=find-result]').first().getAttribute('data-line')
    t.check('the result points at src/app.ts line 1', path === 'src/app.ts' && line === '1', `${path}:${line}`)
    const status = await win.locator('[data-testid=find-status]').innerText()
    t.check('the status line reports 1 match in 1 file', status.includes('1 match in 1 file'), status)
    await t.shot('02-results')
  })

  await t.step('clicking a result opens the Files panel', async () => {
    await win.locator('[data-testid=find-result]').first().click()
    await win.waitForSelector('[data-testid=side-panel-files]', { timeout: 5000 })
    t.check('the files panel opens on the result', true)
  })

  return t.close()
}
