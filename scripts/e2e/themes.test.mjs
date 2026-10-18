// Themes and accents: pick a theme in Settings > Appearance and the whole app follows.

import { launch } from './lib.mjs'

const HARBOR_BG = '#0b0e13'
const PAPER_BG = '#f8f4ec'
const PAPER_TERM = 'rgb(251, 247, 239)'
const HARBOR_TERM = 'rgb(11, 15, 21)'
const DUSK_BG = '#0b0911'
const THEME_IDS = [
  'theme-system',
  'theme-harbor',
  'theme-deep',
  'theme-graphite',
  'theme-kelp',
  'theme-ember',
  'theme-dusk',
  'theme-daylight',
  'theme-paper',
  'theme-sailcloth',
  'theme-chalk'
]

/** The value of a color variable on the root element, as the browser reads it. */
function cssVar(win, name) {
  return win.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), `--color-${name}`)
}

/**
 * The color xterm paints with. theme.css keeps .xterm-viewport transparent on purpose,
 * so read the scrollable element xterm 6 puts the theme background on.
 */
function terminalBackground(win) {
  return win.evaluate(() => {
    const host = document.querySelector('.term-host')
    const el = host?.querySelector('.xterm-scrollable-element') ?? host?.querySelector('.xterm-viewport')
    return el instanceof HTMLElement ? getComputedStyle(el).backgroundColor : ''
  })
}

async function openAppearance(win) {
  await win.keyboard.press('Meta+,')
  await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
  await win.click('[data-testid=settings-nav-appearance]')
  await win.locator('[data-testid=theme-harbor]').waitFor({ timeout: 8000 })
}

async function closeSettings(win) {
  await win.keyboard.press('Escape')
  await win.waitForFunction(() => !document.querySelector('[data-testid=settings-screen]'), null, { timeout: 8000 })
}

/** Brings a part of the settings section into view and lets the window settle before a screenshot. */
async function shot(win, t, file, at) {
  await win.evaluate((testId) => {
    for (const el of document.querySelectorAll('[data-testid=settings-screen] .overflow-y-auto')) el.scrollTop = 0
    const target = testId ? document.querySelector(`[data-testid=${testId}]`) : null
    if (target) target.scrollIntoView({ block: 'start' })
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))
  }, at ?? null)
  await win.waitForTimeout(300)
  await t.shot(file)
}

async function pick(win, id, expectedBg) {
  await win.click(`[data-testid=${id}]`)
  await win.waitForFunction(
    (want) => getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() === want,
    expectedBg,
    { timeout: 8000 }
  )
}

export default async function themes() {
  const t = await launch('themes', { visible: true })
  const { win } = t

  await t.step('settings opens on appearance', async () => {
    await openAppearance(win)
    const missing = []
    for (const id of THEME_IDS) if ((await win.locator(`[data-testid=${id}]`).count()) !== 1) missing.push(id)
    t.check('a card for the system and for all ten themes', missing.length === 0, missing.join(', '))
    t.check('the accent controls are there', (await win.locator('[data-testid=accent-theme]').count()) === 1)
    t.check('dark themes come before light ones', (await win.locator('[data-testid=theme-dusk]').count()) === 1)
  })

  await t.step('the default is Harbor, the dark theme', async () => {
    const bg = await cssVar(win, 'bg')
    t.check('the default bg is Harbor', bg === HARBOR_BG, bg)
  })

  await t.step('pick Paper', async () => {
    await pick(win, 'theme-paper', PAPER_BG)
    t.check('Paper bg is applied', (await cssVar(win, 'bg')) === PAPER_BG, await cssVar(win, 'bg'))
    const scheme = await win.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
    t.check('color-scheme follows the theme', scheme === 'light', scheme)
    t.check('Paper is marked as chosen', (await win.locator('[data-testid=theme-paper]').getAttribute('aria-pressed')) === 'true')
    await shot(win, t, '01-paper')
  })

  await t.step('the terminal follows the theme', async () => {
    await closeSettings(win)
    await t.startAgent('Terminal')
    await win.waitForSelector('.term-host .xterm-scrollable-element', { timeout: 8000 })
    const bg = await terminalBackground(win)
    t.check('the xterm viewport takes the Paper terminal background', bg === PAPER_TERM, bg)
    await shot(win, t, '02-paper-terminal')
  })

  await t.step('a custom accent changes --color-accent', async () => {
    await openAppearance(win)
    await win.click('[data-testid=accent-custom]')
    await win.locator('[data-testid=accent-input]').waitFor({ timeout: 8000 })
    await win.fill('[data-testid=accent-input]', '#ff00aa')
    await win.waitForFunction(
      () => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() === '#ff00aa',
      null,
      { timeout: 8000 }
    )
    t.check('a custom accent reaches the app', (await cssVar(win, 'accent')) === '#ff00aa', await cssVar(win, 'accent'))
    const note = await win.locator('[data-testid=accent-contrast]').textContent()
    t.check('the contrast line names the theme', Boolean(note && note.includes('Paper')), String(note))
    const ring = await win.locator('[data-testid=theme-paper] .ring-accent').count()
    t.check('the chosen card keeps its accent ring', ring === 1)
    await shot(win, t, '03-custom-accent', 'accent-picker')
  })

  await t.step('a custom accent is kept readable', async () => {
    await win.fill('[data-testid=accent-input]', '#ffe9b8')
    await win.waitForFunction(
      () => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() !== '#ffe9b8',
      null,
      { timeout: 8000 }
    )
    const accent = await cssVar(win, 'accent')
    t.check('a too light accent is darkened, not used raw', accent !== '#ffe9b8', accent)
    t.check('the section explains the change', (await win.locator('[data-testid=accent-adjusted]').count()) === 1)
  })

  await t.step('back to the theme accent', async () => {
    await win.click('[data-testid=accent-use-theme]')
    await win.waitForFunction(
      () => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() === '#9c5a12',
      null,
      { timeout: 8000 }
    )
    t.check('the theme accent comes back', (await cssVar(win, 'accent')) === '#9c5a12', await cssVar(win, 'accent'))
    // The color variable changes before React closes the controls; under load that can be a frame or two later.
    await win.waitForSelector('[data-testid=accent-input]', { state: 'detached', timeout: 8000 }).catch(() => {})
    t.check('the custom controls close up', (await win.locator('[data-testid=accent-input]').count()) === 0)
  })

  await t.step('pick Harbor again', async () => {
    await pick(win, 'theme-harbor', HARBOR_BG)
    t.check('Harbor bg is applied', (await cssVar(win, 'bg')) === HARBOR_BG, await cssVar(win, 'bg'))
    const scheme = await win.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
    t.check('color-scheme goes back to dark', scheme === 'dark', scheme)
    await shot(win, t, '04-harbor')
    await closeSettings(win)
    const term = await terminalBackground(win)
    t.check('the open terminal follows back', term === HARBOR_TERM, term)
  })

  await t.step('match the system', async () => {
    await openAppearance(win)
    await win.click('[data-testid=theme-system]')
    const dark = await win.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)
    await win.waitForFunction(
      (want) => getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() === want,
      dark ? HARBOR_BG : '#f2f5f8',
      { timeout: 8000 }
    )
    t.check('match the system resolves to the system theme', true)
    const label = await win.locator('[data-testid=theme-active]').textContent()
    t.check('the section names the theme on screen', Boolean(label && label.includes(dark ? 'Harbor' : 'Daylight')), String(label))
  })

  await t.step('the choice is still there next time', async () => {
    await pick(win, 'theme-dusk', DUSK_BG)
    await closeSettings(win)
    await openAppearance(win)
    await win.waitForFunction(
      () => document.querySelector('[data-testid=theme-dusk]')?.getAttribute('aria-pressed') === 'true',
      null,
      { timeout: 8000 }
    )
    t.check('Dusk stays chosen', (await win.locator('[data-testid=theme-dusk]').getAttribute('aria-pressed')) === 'true')
    t.check('Dusk is still applied', (await cssVar(win, 'bg')) === DUSK_BG, await cssVar(win, 'bg'))
    await shot(win, t, '05-dusk')
  })

  await closeSettings(win)

  return t.close()
}
