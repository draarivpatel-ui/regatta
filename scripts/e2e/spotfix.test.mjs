// Spot fix end to end: point at a heading in a page served on localhost, ask the Test Agent to change
// it, review the before and after, offer the checks the user starts by hand (they never run on their own),
// undo the exact files, then run a second spot fix and keep it.

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, 'fixtures', 'spotfix')

const inside = (win, code) => win.evaluate((source) => document.querySelector('[data-testid=preview-webview]').executeJavaScript(source), code)

/** Moves the hover outline over the heading, without clicking yet. */
const HOVER_HEADLINE = `(() => {
  const el = document.getElementById('headline') || document.querySelector('h1')
  const r = el.getBoundingClientRect()
  const x = Math.round(r.left + r.width / 2)
  const y = Math.round(r.top + r.height / 2)
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }))
  return { x, y, tag: el.tagName.toLowerCase() }
})()`

/** Clicks the heading center, which is what the waiting picker resolves on. */
const CLICK_HEADLINE = `(() => {
  const el = document.getElementById('headline') || document.querySelector('h1')
  const r = el.getBoundingClientRect()
  const x = Math.round(r.left + r.width / 2)
  const y = Math.round(r.top + r.height / 2)
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }))
  document.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }))
  return { x, y, tag: el.tagName.toLowerCase(), id: el.id }
})()`

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
}

/** A git project from the fixture page, committed so checkpoints can track and rewind it. */
function makeProject() {
  const proj = mkdtempSync(join(tmpdir(), 'rg-e2e-spotfix-'))
  mkdirSync(join(proj, 'src'), { recursive: true })
  writeFileSync(join(proj, 'index.html'), readFileSync(join(fixtureDir, 'index.html'), 'utf8'))
  writeFileSync(join(proj, 'package.json'), readFileSync(join(fixtureDir, 'package.json'), 'utf8'))
  writeFileSync(join(proj, 'src', 'app.js'), readFileSync(join(fixtureDir, 'src', 'app.js'), 'utf8'))
  writeFileSync(join(proj, 'src', 'app.test.js'), readFileSync(join(fixtureDir, 'src', 'app.test.js'), 'utf8'))
  git(['init', '-b', 'main'], proj)
  git(['add', '.'], proj)
  git(['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], proj)
  return proj
}

/** Serves `root` on a free localhost port; resolves with the server once it is listening. */
function startServer(root) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const path = decodeURIComponent((req.url || '/').split('?')[0])
        const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
        const body = readFileSync(join(root, rel))
        const type = extname(rel) === '.html' ? 'text/html' : extname(rel) === '.js' ? 'text/javascript' : 'text/plain'
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8` })
        res.end(body)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
      }
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function stopServer(server) {
  if (!server) return
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(() => resolve()))
}

const readStatus = (win) => win.locator('[data-testid=spotfix-status]').first().innerText()
const waitForStatus = (win, text) => win.waitForFunction((want) => {
  const el = document.querySelector('[data-testid=spotfix-status]')
  return el && el.textContent.includes(want)
}, text, { timeout: 25000 })

export default async function spotfix() {
  const proj = makeProject()
  const originalApp = readFileSync(join(proj, 'src', 'app.js'), 'utf8')
  let server = null
  let results = []
  let t = null

  try {
    server = await startServer(proj)
    const port = server.address().port
    const url = `http://127.0.0.1:${port}/`

    t = await launch('spotfix', { cwd: proj, env: { REGATTA_FAKE_SCENARIO: 'delete-tests' } })
    const { win } = t

    await t.step('open the preview on the local fixture page', async () => {
      await win.click('[data-testid=panel-browser]')
      await win.waitForSelector('[data-testid=preview-webview]', { timeout: 15000 })
      await win.fill('[data-testid=preview-url]', url)
      await win.press('[data-testid=preview-url]', 'Enter')
      await win.waitForFunction(() => document.querySelector('[data-testid=preview-webview]')?.getTitle() === 'SpotFix Fixture', null, {
        timeout: 20000
      })
      t.check('Spot fix is enabled for a localhost page', !(await win.locator('[data-testid=preview-spotfix]').isDisabled()))
    })

    await t.step('pick the heading with the outline', async () => {
      await win.click('[data-testid=preview-spotfix]')
      await win.waitForFunction(
        async () => {
          const view = document.querySelector('[data-testid=preview-webview]')
          return await view.executeJavaScript('typeof window.__rgSpotfixCancel === "function"')
        },
        null,
        { timeout: 10000 }
      )
      await inside(win, HOVER_HEADLINE)
      await t.shot('01-picker-outline')
      const picked = await inside(win, CLICK_HEADLINE)
      t.check('the heading carries a unique id', picked.id === 'headline', JSON.stringify(picked))
      await win.waitForSelector('[data-testid=spotfix-box]', { timeout: 10000 })
      const boxText = await win.locator('[data-testid=spotfix-box]').innerText()
      t.check('the box names the picked element', /h1/i.test(boxText), boxText.replace(/\n/g, ' '))
      t.check('the box no longer offers a Run checks toggle', (await win.locator('[data-testid=spotfix-checks]').count()) === 0)
      await t.shot('02-box')
    })

    await t.step('send the note to the Test Agent', async () => {
      await win.fill('[data-testid=spotfix-note]', 'make the heading friendlier')
      await win.selectOption('[data-testid=spotfix-agent]', 'fake')
      await win.click('[data-testid=spotfix-send]')
      await win.waitForSelector('[data-testid=spotfix-card]', { timeout: 10000 })
      t.check('a card opened beside the preview', (await win.locator('[data-testid=spotfix-card]').count()) === 1)
    })

    await t.step('the card shows before, after and the changed files', async () => {
      await waitForStatus(win, 'Ready for review')
      await win.waitForSelector('img[data-testid=spotfix-after]', { timeout: 20000 })
      t.check('the before screenshot is shown', (await win.locator('img[data-testid=spotfix-before]').count()) === 1)
      t.check('the after screenshot is shown', (await win.locator('img[data-testid=spotfix-after]').count()) === 1)
      const files = await win.locator('[data-testid=spotfix-files]').innerText()
      t.check('the agent file DONE.txt is listed', files.includes('DONE.txt'), files.replace(/\n/g, ' '))
      t.check('src/app.js is listed as changed', files.includes('src/app.js') || files.includes('app.js'), files.replace(/\n/g, ' '))
      t.check('the deleted test file is listed as changed', files.includes('app.test.js'), files.replace(/\n/g, ' '))
      t.check('DONE.txt exists in the project now', existsSync(join(proj, 'DONE.txt')))
      t.check('src/app.js gained the agent line', readFileSync(join(proj, 'src', 'app.js'), 'utf8') !== originalApp)
      await t.shot('03-card')
    })

    await t.step('the card offers Run checks, which never ran on their own', async () => {
      t.check('no checks ran on their own', (await win.locator('[data-testid=spotfix-check-results]').count()) === 0)
      await win.click('[data-testid=spotfix-run-checks]')
      await win.waitForSelector('[data-testid=spotfix-check-commands]', { timeout: 10000 })
      const commands = await win.locator('[data-testid=spotfix-check-commands]').innerText()
      t.check('the exact test command is listed', /test:.*npm test/.test(commands), commands.replace(/\n/g, ' '))
      await win.waitForSelector('[data-testid=spotfix-checks-note]', { timeout: 10000 })
      const note = await win.locator('[data-testid=spotfix-checks-note]').innerText()
      t.check(
        'the notice says the checks run code this fix changed',
        note.includes('Checks run code from your project, including files this Spot fix changed:'),
        note.replace(/\n/g, ' ')
      )
      const changed = await win.locator('[data-testid=spotfix-checks-changed]').innerText()
      t.check('the notice lists the changed files', changed.includes('src/app.js'), changed.replace(/\n/g, ' '))
      const warning = await win.locator('[data-testid=spotfix-checks-warning]')
      t.check(
        'the changed check file is still called out by name',
        (await warning.count()) === 1 && (await warning.innerText()).includes('src/app.test.js'),
        (await warning.count()) === 1 ? (await warning.innerText()).replace(/\n/g, ' ') : 'no warning'
      )
      const runButton = win.locator('[data-testid=spotfix-checks-run]')
      t.check('a changed file costs a second click', (await runButton.innerText()).trim() === 'Run anyway', await runButton.innerText())
      await runButton.click()
      t.check('the first click only arms the button', (await runButton.innerText()).trim() === 'Run', await runButton.innerText())
      t.check('the first click did not start the checks', (await win.locator('[data-testid=spotfix-check-results]').count()) === 0)
      await t.shot('04-checks')
    })

    await t.step('undo rewinds exactly what the agent changed', async () => {
      await win.click('[data-testid=spotfix-undo]')
      await win.waitForSelector('[data-testid=spotfix-undo-confirm]', { timeout: 5000 })
      t.check('undo asks first and lists the files', (await win.locator('[data-testid=spotfix-undo-confirm]').count()) === 1)
      await win.click('[data-testid=spotfix-undo-confirm]')
      await waitForStatus(win, 'Undone')
      const gone = await waitUntil(() => !existsSync(join(proj, 'DONE.txt')), 15000)
      const restored = await waitUntil(() => readFileSync(join(proj, 'src', 'app.js'), 'utf8') === originalApp, 15000)
      const testBack = await waitUntil(() => existsSync(join(proj, 'src', 'app.test.js')), 15000)
      t.check('undo removed DONE.txt', gone)
      t.check('undo restored src/app.js', restored)
      t.check('undo brought back the deleted test file', testBack)
      t.check('the card lists the rewound files', (await win.locator('[data-testid=spotfix-undo-result]').count()) === 1)
    })

    await t.step('a second spot fix can be kept', async () => {
      await win.click('[data-testid=preview-spotfix]')
      await win.waitForFunction(
        async () => {
          const view = document.querySelector('[data-testid=preview-webview]')
          return await view.executeJavaScript('typeof window.__rgSpotfixCancel === "function"')
        },
        null,
        { timeout: 10000 }
      )
      await inside(win, CLICK_HEADLINE)
      await win.waitForSelector('[data-testid=spotfix-box]', { timeout: 10000 })
      await win.fill('[data-testid=spotfix-note]', 'one more touch')
      await win.selectOption('[data-testid=spotfix-agent]', 'fake')
      await win.click('[data-testid=spotfix-send]')
      await waitForStatus(win, 'Ready for review')
      await win.click('[data-testid=spotfix-keep]')
      await waitForStatus(win, 'Kept')
      t.check('Keep settles the second spot fix', (await readStatus(win)).includes('Kept'))
      t.check('the second run wrote again to the project', existsSync(join(proj, 'DONE.txt')))
    })
  } finally {
    if (t) results = await t.close()
    await stopServer(server)
    rmSync(proj, { recursive: true, force: true })
  }

  return results
}

/** Polls a condition until it holds or the budget runs out. */
async function waitUntil(condition, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (condition()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return condition()
}
