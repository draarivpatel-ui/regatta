// Dictation: speak into the chat composer and into a shell pane, cancel with Esc.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

const EXPECTED = 'hello from the test'

function fakeWhisper(dir) {
  const path = join(dir, 'whisper-fake')
  writeFileSync(path, '#!/bin/sh\necho "hello from the test"\n')
  chmodSync(path, 0o755)
  return path
}

// Dictation records through navigator.mediaDevices.getUserMedia. The e2e must never open the real
// microphone, so the page is given a synthetic silent source instead: an oscillator into a
// MediaStreamDestination. This keeps the whole pill -> transcribe -> deliver flow intact while
// staying independent of the machine's audio capture (which can hang during input open).
async function installFakeMic(win) {
  await win.evaluate(() => {
    const silentStream = (() => {
      const Ctx = window.AudioContext || window.webkitAudioContext
      const ac = new Ctx({ sampleRate: 16000 })
      const dest = ac.createMediaStreamDestination()
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      gain.gain.value = 0
      osc.connect(gain)
      gain.connect(dest)
      try {
        osc.start()
      } catch {
        // already started
      }
      return dest.stream
    })()
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      writable: true,
      value: async () => silentStream
    })
    if (navigator.mediaDevices.webkitGetUserMedia) navigator.mediaDevices.webkitGetUserMedia = async () => silentStream
  })
}

export default async function dictation() {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-dict-e2e-'))
  const profile = mkdtempSync(join(tmpdir(), 'regatta-dict-profile-'))
  mkdirSync(join(profile, 'models'), { recursive: true })
  writeFileSync(join(profile, 'models', 'ggml-base.en.bin'), 'dummy-model')
  const engine = fakeWhisper(dir)

  const t = await launch('dictation', { profile, env: { REGATTA_WHISPER_CLI: engine } })
  const { win } = t
  await installFakeMic(win)
  const shortcut = async () => win.keyboard.press('Meta+Shift+Space')

  await t.step('dictate into the chat composer', async () => {
    await win.keyboard.press('Meta+3')
    await win.waitForSelector('[data-testid="chat-mode"]', { timeout: 8000 })
    t.check('chat mode opens', (await win.locator('[data-testid="chat-mode"]').count()) === 1)
    await win.click('[data-testid="chat-input"]')
    await shortcut()
    await win.waitForSelector('[data-testid="dictation-pill"][data-state="listening"]', { timeout: 10000 })
    t.check('the pill shows listening', true)
    await t.shot('01-listening')
    await win.waitForTimeout(1000)
    await shortcut()
    await win.waitForSelector('[data-testid="dictation-pill"][data-state="added"]', { timeout: 15000 })
    t.check('the pill shows added after transcribing', true)
    await win.waitForFunction(
      (expected) => document.querySelector('[data-testid="chat-input"]')?.value.includes(expected),
      EXPECTED,
      { timeout: 10000 }
    )
    t.check('the composer contains the dictated words', true)
    await t.shot('02-added')
  })

  await t.step('dictate into a shell pane without running anything', async () => {
    await win.keyboard.press('Meta+2')
    await t.startAgent('Terminal')
    await t.pane(0).locator('.xterm').click()
    await shortcut()
    await win.waitForSelector('[data-testid="dictation-pill"][data-state="listening"]', { timeout: 10000 })
    await win.waitForTimeout(1000)
    await shortcut()
    await win.waitForSelector('[data-testid="dictation-pill"][data-state="added"]', { timeout: 15000 })
    t.check('dictating into a pane shows added', true)
    await win.waitForFunction((expected) => document.body.innerText.includes(expected), EXPECTED, { timeout: 10000 })
    const text = await t.textOf(0)
    t.check('the words appear on the terminal screen', text.includes(EXPECTED), text.slice(-80))
    t.check('nothing was run', !text.includes('command not found') && !text.includes('not found'), text.slice(-80))
  })

  await t.step('esc cancels and adds nothing', async () => {
    await win.keyboard.press('Meta+3')
    await win.waitForSelector('[data-testid="chat-input"]', { timeout: 8000 })
    await win.click('[data-testid="chat-input"]')
    const before = await win.locator('[data-testid="chat-input"]').inputValue()
    await shortcut()
    await win.waitForSelector('[data-testid="dictation-pill"][data-state="listening"]', { timeout: 10000 })
    await win.keyboard.press('Escape')
    await win.waitForSelector('[data-testid="dictation-pill"][data-state="cancelled"]', { timeout: 8000 })
    t.check('escape shows Cancelled', true)
    const after = await win.locator('[data-testid="chat-input"]').inputValue()
    t.check('cancelling adds nothing', after === before, `${before.length} chars before, ${after.length} after`)
  })

  const extraResults = []
  await t.step('without a model the shortcut opens Settings Dictation', async () => {
    const second = await launch('dictation-settings', {})
    const w = second.win
    try {
      await w.keyboard.press('Meta+Shift+Space')
      await w.waitForSelector('[data-testid="settings-screen"]', { timeout: 8000 })
      await w.waitForSelector('[data-testid="dictation-section"]', { timeout: 8000 })
      second.check('settings opens on the Dictation section', true)
      const downloads = await w.locator('[data-testid^="dictation-download-"]').count()
      second.check('both models offer Download', downloads === 2, `${downloads} buttons`)
      const engineText = await w.locator('[data-testid="dictation-engine"]').textContent()
      second.check('the engine row renders', (engineText ?? '').includes('whisper.cpp'), (engineText ?? '').slice(0, 60))
      second.check('Try it is present', (await w.locator('[data-testid="dictation-try"]').count()) === 1)
      await second.shot('03-settings-dictation')
    } finally {
      const extra = await second.close()
      extraResults.push(...extra)
    }
  })

  const results = await t.close()
  return [...results, ...extraResults]
}
