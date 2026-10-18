// Draws the Regatta app icon and writes build/icon.png (1024 by 1024, transparent outside the square).
// It renders scripts/icon/icon-page.html in Electron (already installed, so no browser download is needed)
// and screenshots it with a transparent background. Run: node scripts/icon/render.mjs
// electron-builder turns build/icon.png into the .icns for the bundle.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const mainFile = path.join(here, 'main.cjs')
const electronBinary = require('electron')
const out = path.join(repo, 'build', 'icon.png')
mkdirSync(path.dirname(out), { recursive: true })

const env = { ...process.env }
// If ELECTRON_RUN_AS_NODE is set, Electron would start as plain Node. Strip it.
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ executablePath: electronBinary, args: [mainFile], cwd: repo, env, timeout: 120000 })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1024, height: 1024 })
  await page.evaluate(() => document.readyState === 'complete')
  await page.waitForTimeout(300)
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } })
  console.log(`Wrote ${out}`)
} finally {
  await app.close().catch(() => undefined)
}
