// Device panel: it opens beside the panes and lists the simulators on this Mac.
// The test never boots a device, so it checks what a shut down list looks like.

import { execFileSync } from 'node:child_process'
import { launch } from './lib.mjs'

/** How many simulators simctl reports here, or -1 when this machine has no usable Xcode. */
function simulatorCount() {
  if (process.platform !== 'darwin') return -1
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8', timeout: 90000 })
    const devices = JSON.parse(out).devices ?? {}
    return Object.values(devices).reduce((total, list) => total + (list ?? []).filter((d) => d.isAvailable).length, 0)
  } catch {
    return -1
  }
}

export default async function device() {
  // The simulator list lives in the real home, so this is the one test that keeps it. It still gets the stand-ins.
  const t = await launch('device', { realHome: true })
  const { win } = t

  await t.step('panel opens', async () => {
    await win.click('[data-testid=panel-simulator]')
    await win.waitForSelector('[data-testid=device-panel]', { timeout: 10000 })
    t.check('the Device panel opens beside the panes', true)
    await t.shot('01-panel')
  })

  // A cold CoreSimulator registry takes over 20 seconds to scan, so the list arrives late.
  const count = simulatorCount()

  await t.step('device list', async () => {
    if (count > 0) {
      await win.waitForSelector('[data-testid=device-select]', { timeout: 70000 })
      const labels = await win.locator('[data-testid=device-select] option').evaluateAll((nodes) => nodes.map((n) => n.textContent ?? ''))
      t.check('the select lists the simulators on this Mac', labels.length > 0, `${labels.length} options`)
      t.check('an option names the device and its runtime', /\S+ · \S+ \d+\.\d+/.test(labels[0] ?? ''), labels[0])
      t.check('every option carries a runtime', labels.every((l) => l.includes(' · ')), labels.join(', '))
      const phone = (label) => label.trim().startsWith('iPhone')
      const lastPhone = labels.map(phone).lastIndexOf(true)
      const firstOther = labels.findIndex((l) => !phone(l))
      t.check('iPhones come ahead of the other devices', firstOther === -1 || lastPhone < firstOther, labels.join(', '))
    } else {
      await win.waitForSelector('[data-testid=device-none]', { timeout: 70000 })
      const text = await win.textContent('[data-testid=device-none]')
      t.check('with no simulators the panel says what to install', (text ?? '').includes('Install Xcode'), text)
      t.check('the select stays out of the way', (await win.locator('[data-testid=device-select]').count()) === 0)
    }
    await t.shot('02-list')
  })

  await t.step('controls', async () => {
    if (count <= 0) return
    t.check('the panel offers a boot button', (await win.locator('[data-testid=device-boot]').count()) === 1)
    t.check('the panel opens the Simulator app', (await win.locator('[data-testid=device-open-simulator]').count()) === 1)
    const badge = await win.textContent('[data-testid=device-state]')
    t.check('the badge says what the device is doing', /Booted|Off|Booting|Shutting down/.test(badge ?? ''), badge)
    await t.shot('03-controls')
  })

  await t.step('no screen until something is booted', async () => {
    if (count <= 0) return
    if (/Booted/.test((await win.textContent('[data-testid=device-state]')) ?? '')) {
      t.check('a booted device shows its screen', (await win.locator('[data-testid=device-screen]').count()) <= 1)
      return
    }
    await win.waitForSelector('[data-testid=device-busy]', { timeout: 10000 })
    const hint = await win.textContent('[data-testid=device-busy]')
    t.check('a shut down device invites you to boot it', (hint ?? '') === 'Boot a device to see its screen here.', hint)
    t.check('nothing is drawn as a screen', (await win.locator('[data-testid=device-screen]').count()) === 0)
    await t.shot('04-need-boot')
  })

  await t.step('closing docks it away', async () => {
    await win.click('[data-testid=panel-simulator]')
    await win.waitForSelector('[data-testid=side-panel-simulator]', { state: 'detached', timeout: 10000 })
    t.check('clicking Device again hides the panel', true)
  })

  return t.close()
}
