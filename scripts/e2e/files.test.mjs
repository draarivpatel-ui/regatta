// Files panel: the tree, opening a file, editing it and saving it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

export default async function files() {
  const project = mkdtempSync(join(tmpdir(), 'rg-e2e-files-'))
  mkdirSync(join(project, 'docs'))
  writeFileSync(join(project, 'notes.txt'), 'hello')
  writeFileSync(join(project, 'docs', 'guide.md'), '# Guide\nline two\nline three\n')

  const t = await launch('files', { cwd: project })
  const { win } = t

  await t.step('tree', async () => {
    await win.click('[data-testid=panel-files]')
    await win.waitForSelector('[data-testid=side-panel-files]', { timeout: 10000 })
    await win.waitForSelector('[data-testid=file-row][data-path="notes.txt"]', { timeout: 10000 })
    t.check('the panel lists files from the project root', true)
    t.check(
      'folders come before files',
      (await win.locator('[data-testid=file-row]').first().getAttribute('data-kind')) === 'dir'
    )
    await t.shot('01-tree')
  })

  await t.step('open and edit', async () => {
    await win.click('[data-testid=file-row][data-path="notes.txt"]')
    await win.waitForSelector('[data-testid=file-editor]', { timeout: 10000 })
    t.check('opening a file shows the editor', (await win.inputValue('[data-testid=file-editor]')) === 'hello')
    await win.fill('[data-testid=file-editor]', 'hello world')
    await win.waitForSelector('[data-testid=file-dirty]', { timeout: 5000 })
    t.check('editing marks the file as changed', true)
    await win.click('[data-testid=file-save]')
    await win.waitForSelector('[data-testid=file-dirty]', { state: 'detached', timeout: 10000 })
    t.check('saving clears the changed dot', readFileSync(join(project, 'notes.txt'), 'utf8') === 'hello world')
    await t.shot('02-editor')
  })

  await t.step('back and expand', async () => {
    await win.click('[data-testid=file-back]')
    await win.waitForSelector('[data-testid=file-editor]', { state: 'detached', timeout: 5000 })
    await win.click('[data-testid=file-row][data-path="docs"]')
    await win.waitForSelector('[data-testid=file-row][data-path="docs/guide.md"]', { timeout: 10000 })
    t.check('opening a folder loads what is inside it', true)
    await t.shot('03-expanded')
  })

  await t.step('filter', async () => {
    await win.fill('[data-testid=files-filter]', 'guide')
    await win.waitForSelector('[data-testid=file-row][data-path="docs/guide.md"]', { timeout: 10000 })
    const paths = await win.locator('[data-testid=file-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-path')))
    t.check('the filter keeps what matches and the folder holding it', paths.includes('docs') && paths.includes('docs/guide.md'), paths.join(', '))
    t.check('the filter drops what does not match', !paths.includes('notes.txt'), paths.join(', '))
    await t.shot('04-filter')
  })

  await t.step('open request', async () => {
    await win.evaluate(() => window.__regattaOpenFile('docs/guide.md', 3))
    await win.waitForFunction(() => document.querySelector('[data-testid=file-editor]')?.value.includes('line three'), null, { timeout: 10000 })
    const picked = await win.evaluate(() => {
      const el = document.querySelector('[data-testid=file-editor]')
      return { text: el.value.slice(el.selectionStart, el.selectionEnd), focused: document.activeElement === el }
    })
    t.check('an open request opens the file', await win.inputValue('[data-testid=file-editor]').then((v) => v.startsWith('# Guide')))
    t.check('it scrolls to the line asked for and selects it', picked.text === 'line three', picked.text)
    t.check('the editor takes the keyboard', picked.focused)
    await t.shot('05-open-request')
  })

  await t.step('cmd s saves', async () => {
    await win.click('[data-testid=file-editor]')
    await win.keyboard.press('End')
    await win.keyboard.type('\nadded from the editor')
    await win.keyboard.press('Meta+s')
    await win.waitForSelector('[data-testid=file-dirty]', { state: 'detached', timeout: 10000 })
    t.check('Cmd+S saves while the editor has focus', readFileSync(join(project, 'docs', 'guide.md'), 'utf8').endsWith('added from the editor'))
  })

  const results = await t.close()
  rmSync(project, { recursive: true, force: true })
  return results
}