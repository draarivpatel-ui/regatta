// Packaged app smoke test. It runs only when REGATTA_PACKAGED_APP points at a built Regatta.app;
// otherwise it returns no checks so the normal suite is unchanged. It launches the real bundle binary
// and confirms the packaged app behaves like `npm run start`: home screen, app:info, the bundled video
// resource, a working Terminal pane (node-pty loads from the unpacked native binary), and Settings > About.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './lib.mjs'

export default async function packaged() {
  const bundle = process.env.REGATTA_PACKAGED_APP
  if (!bundle) {
    console.log('  SKIP  packaged: set REGATTA_PACKAGED_APP to a built Regatta.app to run this check')
    return []
  }
  const executablePath = bundle.endsWith('.app') ? join(bundle, 'Contents', 'MacOS', 'Regatta') : bundle
  if (!existsSync(executablePath)) {
    console.log(`  FAIL  packaged: no launchable binary at ${executablePath}`)
    return [{ label: 'packaged app binary exists', ok: false }]
  }

  const t = await launch('packaged', { executablePath })
  const { win } = t

  await t.step('home screen', async () => {
    const home = await win.locator('[data-testid=start-fake]').count()
    t.check('the packaged app opens on the home screen', home > 0, `${home} start buttons`)
    await t.shot('01-home')
  })

  await t.step('app:info version', async () => {
    const info = await win.evaluate(() => window.regatta.invoke('app:info'))
    t.check('app:info reports version 0.1.0', info.version === '0.1.0', String(info.version))
  })

  await t.step('bundled video resource', async () => {
    const exists = await t.app.evaluate(({ app }) => {
      const fs = process.getBuiltinModule('node:fs')
      const path = process.getBuiltinModule('node:path')
      const target = path.join(process.resourcesPath, 'video', 'regatta-video.js')
      return app.isPackaged && fs.existsSync(target)
    })
    t.check('the packaged app ships process.resourcesPath/video/regatta-video.js', exists)
  })

  await t.step('terminal pane runs a command', async () => {
    await t.startAgent('Terminal')
    await t.typeInto(0, 'echo regatta-$((6*7))')
    await win.waitForTimeout(1500)
    const text = await t.textOf(0)
    t.check('a Terminal pane starts and prints output (node-pty loads)', text.includes('regatta-42'), JSON.stringify(text.slice(-40)))
    await t.shot('02-terminal')
  })

  await t.step('settings about', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-about]')
    await win.waitForTimeout(300)
    const about = await win.locator('[data-testid=settings-screen]', { hasText: 'MIT license' }).count()
    t.check('Settings > About opens', about > 0)
    await t.shot('03-about')
    await win.keyboard.press('Escape')
  })

  return t.close()
}
