// Opens every surface of the built app and saves a screenshot of each once animations settle.
// Not part of the test suite. Usage: npm run build && env -u ELECTRON_RUN_AS_NODE node scripts/visual-tour.mjs
// Screenshots go to /tmp/regatta-e2e/tour/.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { launch } from './e2e/lib.mjs'

// A small sample project so the panels have something to show.
const project = mkdtempSync('/tmp/regatta-tour-project-')
mkdirSync(join(project, 'src'), { recursive: true })
mkdirSync(join(project, 'test'), { recursive: true })
writeFileSync(join(project, 'README.md'), '# Launchpad\n\nA tiny sample app.\n')
writeFileSync(join(project, 'src', 'cart.js'), 'export function total(items) {\n  return items.reduce((sum, i) => sum + i.price, 0)\n}\n')
writeFileSync(join(project, 'test', 'cart.test.js'), "import { total } from '../src/cart.js'\nit('adds prices', () => {\n  expect(total([{ price: 2 }])).toBe(2)\n})\n")
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'launchpad', scripts: { test: 'node --test' } }, null, 2))
execFileSync('git', ['init', '-q'], { cwd: project })
execFileSync('git', ['-c', 'user.name=Tour', '-c', 'user.email=tour@localhost', 'add', '-A'], { cwd: project })
execFileSync('git', ['-c', 'user.name=Tour', '-c', 'user.email=tour@localhost', 'commit', '-qm', 'start'], { cwd: project })

const t = await launch('tour', { cwd: project })
const { win } = t
const settle = (ms = 700) => win.waitForTimeout(ms)
const shot = async (name) => {
  await settle()
  await t.shot(name)
  console.log(`saved ${name}`)
}
const escape = async () => {
  await win.keyboard.press('Escape')
  await settle(400)
}

await shot('01-empty-state')
await t.startAgent('Test Agent')
await t.startAgent('Test Agent')
await t.startAgent('Test Agent')
await t.startAgent('Terminal')
await settle(1200)
await t.typeInto(0, 'add a discount code to the cart')
await t.typeInto(1, 'ask')
await t.typeInto(3, 'ls')
await settle(900)
await shot('02-grid-four-panes')

await win.click('[data-testid=new-pane-button]')
await shot('03-new-pane-menu')
await escape()

await win.click('[data-testid=layout-button]')
await shot('04-layout-menu')
await escape()

await win.click('[data-testid=inbox-button]')
await shot('05-inbox')
await escape()

await win.click('[data-testid=broadcast-button]')
await shot('06-broadcast')
await escape()

await win.keyboard.press('Meta+K')
await shot('07-quick-actions')
await escape()

await win.click('[data-testid=panel-files]')
await settle(500)
await win.locator('[data-testid=file-row]', { hasText: 'src' }).first().click().catch(() => undefined)
await shot('08-files-panel')
await win.click('[data-testid=panel-files]')

await win.click('[data-testid=panel-find]')
await settle(300)
await win.fill('[data-testid=find-input]', 'total').catch(() => undefined)
await win.keyboard.press('Enter')
await shot('09-find-panel')
await win.click('[data-testid=panel-find]')

await win.click('[data-testid=panel-browser]')
await shot('10-preview-tab')
await win.click('[data-testid=panel-browser]')

await win.keyboard.press('Meta+,')
await shot('11-settings')
await escape()

await win.click('[data-testid=new-pane-button]')
await win.locator('[data-testid=new-pane-menu] button', { hasText: 'Start a crew' }).first().click()
await shot('12-crew-dialog')
await escape()

await win.click('[data-testid=skipper-button]')
await shot('13-skipper')
await win.click('[aria-label="Close Skipper"]')
await settle(400)

await t.pane(0).locator('button[aria-label="Pane actions"]').click()
await shot('14-pane-menu')
await escape()

await t.close()
console.log('tour done: /tmp/regatta-e2e/tour/')
