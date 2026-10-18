// Dictate anywhere's pill, one state at a time: listening (the fake microphone's level moves),
// transcribing, added, cancelled, an error, and the permission-needed state. The pill is the real
// AnywherePill page, opened the way the app opens it (?view=anywhere, with the same preload) in a
// second window that stays hidden like the main window. Its states are driven with anywhere:toggle
// events. The two calls the pill makes to main (anywhere:status and anywhere:deliver) are stubbed in
// main, so nothing is typed into another app, no shortcut is pressed and Accessibility is never asked
// for. Each state gets a screenshot and checks on its text or data-testid.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, repo } from './lib.mjs'

const PILL = '[data-testid=anywhere-pill]'

/** Stubs the two main-process handlers the pill calls, so no real delivery or permission check runs. */
async function stubMain(t) {
  await t.app.evaluate(({ ipcMain }) => {
    globalThis.__anywhereTrusted = true
    globalThis.__deliverCalls = 0
    ipcMain.removeHandler('anywhere:status')
    ipcMain.handle('anywhere:status', () => ({
      enabled: true,
      trusted: globalThis.__anywhereTrusted,
      shortcut: 'Alt+Shift+Command+Space',
      error: null
    }))
    ipcMain.removeHandler('anywhere:deliver')
    // Holds each delivery until the test answers it, so the transcribing state can be seen.
    ipcMain.handle('anywhere:deliver', (_event, wav) => {
      globalThis.__deliverCalls += 1
      globalThis.__wavBytes = wav.length
      return new Promise((resolve) => {
        globalThis.__finishDeliver = resolve
      })
    })
  })
}

/** Opens the pill page in a second window, as the app's own code does (src/main/anywhere.ts createPill). */
async function openPill(t) {
  await t.app.evaluate(
    async ({ BrowserWindow }, paths) => {
      const win = new BrowserWindow({
        width: 380,
        height: 72,
        show: false,
        // Painted while hidden, so the page reads as visible: the test window must never appear on screen.
        paintWhenInitiallyHidden: true,
        frame: false,
        transparent: true,
        resizable: false,
        focusable: false,
        skipTaskbar: true,
        webPreferences: { preload: paths.preload, contextIsolation: true, sandbox: true }
      })
      globalThis.__pillWindow = win
      await win.loadFile(paths.html, { query: { view: 'anywhere' } })
    },
    { preload: join(repo, 'out/preload/index.js'), html: join(repo, 'out/renderer/index.html') }
  )
}

/** The Playwright page for the pill window, found among the app's windows once it has loaded. */
async function findPill(t) {
  for (let i = 0; i < 100; i++) {
    const page = t.app.windows().find((p) => p.url().includes('view=anywhere'))
    if (page) return page
    await t.win.waitForTimeout(200)
  }
  throw new Error('the pill window never opened')
}

/** Sends one anywhere:toggle event to the pill window, the way main forwards a shortcut press. */
const toggle = (t, action) =>
  t.app.evaluate((_electron, name) => globalThis.__pillWindow.webContents.send('anywhere:toggle', { action: name }), action)

/** Answers the delivery the pill is waiting on, with the result the real delivery would give. */
const finishDeliver = (t, result) => t.app.evaluate((_electron, answer) => globalThis.__finishDeliver(answer), result)

/** Waits until main has received `count` deliveries from the pill. */
async function waitForDeliveries(t, count) {
  for (let i = 0; i < 80; i++) {
    const seen = await t.app.evaluate(() => globalThis.__deliverCalls)
    if (seen >= count) return seen
    await t.win.waitForTimeout(100)
  }
  throw new Error(`the pill sent no delivery number ${count}`)
}

const deliveries = (t) => t.app.evaluate(() => globalThis.__deliverCalls)

async function waitForState(pill, state) {
  try {
    await pill.waitForFunction((s) => document.querySelector('[data-testid=anywhere-pill]')?.getAttribute('data-state') === s, state, {
      timeout: 8000
    })
  } catch (err) {
    const now = await pill.evaluate(() => {
      const el = document.querySelector('[data-testid=anywhere-pill]')
      return el ? `${el.getAttribute('data-state')}: ${el.textContent.trim()}` : 'no pill drawn'
    })
    throw new Error(`waiting for "${state}", the pill shows ${now}: ${String(err.message).split('\n')[0]}`)
  }
}

const pillText = (pill) => pill.textContent(PILL).then((text) => (text ?? '').trim())

/** The level meter's width in percent, as the pill draws it now. */
const meterWidth = (pill) =>
  pill.evaluate(() => {
    const bar = document.querySelector('[title="Microphone level"] > span')
    return bar ? parseFloat(bar.style.width) : NaN
  })

/** A screenshot of the pill window itself, taken in main so a hidden window still paints. */
async function shotPill(t, name) {
  const png = await t.app.evaluate(async () => (await globalThis.__pillWindow.webContents.capturePage()).toPNG().toString('base64'))
  writeFileSync(join(t.shots, `${name}.png`), Buffer.from(png, 'base64'))
}

export default async function anywhereShots() {
  const t = await launch('anywhere-shots')
  const pageErrors = []
  let pill = null

  await t.step('the pill page opens in its own window and is visible', async () => {
    await stubMain(t)
    await openPill(t)
    pill = await findPill(t)
    pill.on('pageerror', (e) => pageErrors.push(e.message))
    await pill.waitForFunction(() => typeof window.regatta?.invoke === 'function', null, { timeout: 15000 })
    const visibility = await pill.evaluate(() => document.visibilityState)
    t.check('the pill page loads with the bridge and reads as visible', visibility === 'visible', `visibilityState ${visibility}`)
    t.check('the pill is hidden until a shortcut press (idle draws nothing)', (await pill.locator(PILL).count()) === 0)
    // Chromium's fake device never answers getUserMedia in this hidden window (probed on this machine: the pill and
    // the main window both wait past 4 s). So the pill's recorder gets a test microphone instead: a tone whose
    // loudness slowly rises and falls, so the level meter moves. The recorder itself is the real one.
    await pill.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext()
        const tone = ctx.createOscillator()
        tone.frequency.value = 440
        const level = ctx.createGain()
        level.gain.value = 0.5
        const wobble = ctx.createOscillator()
        wobble.frequency.value = 1.5
        const depth = ctx.createGain()
        depth.gain.value = 0.4
        wobble.connect(depth)
        depth.connect(level.gain)
        const out = ctx.createMediaStreamDestination()
        tone.connect(level)
        level.connect(out)
        tone.start()
        wobble.start()
        return out.stream
      }
    })
  })

  await t.step('listening: the timer runs and the fake microphone moves the level meter', async () => {
    if (!pill) throw new Error('no pill window')
    await toggle(t, 'start')
    await waitForState(pill, 'listening')
    const samples = []
    for (let i = 0; i < 10; i++) {
      samples.push(await meterWidth(pill))
      await t.win.waitForTimeout(150)
    }
    const text = await pillText(pill)
    t.check('the pill says Listening with a timer', text.includes('Listening') && (await pill.locator('[data-testid=anywhere-elapsed]').count()) === 1, text)
    const peak = Math.max(...samples)
    t.check('the level meter rises above zero from the fake microphone', peak > 0, `widths ${samples.join(', ')}`)
    t.check('and it moves, so it is not stuck at one level', new Set(samples).size >= 3, `${new Set(samples).size} different levels`)
    await shotPill(t, '01-listening')
  })

  await t.step('transcribing: the recording goes to delivery and the pill says so', async () => {
    if (!pill) throw new Error('no pill window')
    await toggle(t, 'stop')
    await waitForState(pill, 'transcribing')
    const calls = await waitForDeliveries(t, 1)
    const wavBytes = await t.app.evaluate(() => globalThis.__wavBytes)
    const text = await pillText(pill)
    t.check('the pill says it is turning speech into text', text.includes('Turning speech into text'), text)
    t.check('the recording reached delivery as more than a WAV header', wavBytes > 44 && calls === 1, `${wavBytes} bytes`)
    await shotPill(t, '02-transcribing')
  })

  await t.step('added: the pill names the app the words went into', async () => {
    if (!pill) throw new Error('no pill window')
    await finishDeliver(t, { ok: true, app: 'TextEdit', text: 'Hello there.', error: null })
    await waitForState(pill, 'added')
    const text = await pillText(pill)
    t.check('the pill says Added in TextEdit', text.includes('Added in TextEdit'), text)
    await shotPill(t, '03-added')
  })

  await t.step('cancelled: a cancel while listening ends the take without delivering it', async () => {
    if (!pill) throw new Error('no pill window')
    const before = await deliveries(t)
    await toggle(t, 'start')
    await waitForState(pill, 'listening')
    await toggle(t, 'cancel')
    await waitForState(pill, 'cancelled')
    const text = await pillText(pill)
    t.check('the pill says Cancelled', text.includes('Cancelled'), text)
    t.check('the cancelled take was not sent for delivery', (await deliveries(t)) === before, `${before} before, ${await deliveries(t)} after`)
    await shotPill(t, '04-cancelled')
  })

  await t.step('an error: a delivery that fails shows its reason', async () => {
    if (!pill) throw new Error('no pill window')
    await toggle(t, 'start')
    await waitForState(pill, 'listening')
    await toggle(t, 'stop')
    await waitForState(pill, 'transcribing')
    const calls = await waitForDeliveries(t, 2)
    await finishDeliver(t, { ok: false, app: null, text: '', error: 'Heard nothing.' })
    await waitForState(pill, 'error')
    const text = await pillText(pill)
    t.check('the pill shows the reason in the error state', text.includes('Heard nothing.') && calls === 2, text)
    await shotPill(t, '05-error')
  })

  await t.step('permission: without Accessibility the pill asks for it and offers Open Settings', async () => {
    if (!pill) throw new Error('no pill window')
    // The app is no longer trusted; the pill learns it when it is shown again (visibilitychange).
    await t.app.evaluate(() => {
      globalThis.__anywhereTrusted = false
    })
    await pill.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitForState(pill, 'permission')
    const text = await pillText(pill)
    t.check('the pill names Accessibility', text.includes('Accessibility'), text)
    t.check('the pill offers an Open Settings button', (await pill.locator('[data-testid=anywhere-open-settings]').count()) === 1)
    await shotPill(t, '06-permission')
  })

  t.check('the pill page raised no errors through the whole run', pageErrors.length === 0, pageErrors.join('; ').slice(0, 200))
  return t.close()
}
