// Video mode end to end: turn Video on in Labs, make a clip with the Test Agent, read the plan, build
// to Ready, and look at the player at five moments with each of the three tabs open. The Test Agent
// writes PLAN.md and copies Regatta's example on build (and makes a one-line change when asked for one);
// the checks and the render run in the render process. No real agent sign-in is read and no network is
// used. REGATTA_E2E_VISIBLE=1 shows the window on screen, so the build's check (a render process) runs
// while the app window is visible, where it was once seen to hang. The default stays hidden.
//
// Screenshots go to /tmp/regatta-e2e/video/ and are taken with the window's own capture (`shot` below),
// not with t.shot. Playwright's page.screenshot makes Chromium lay a <webview> out at the size of the
// whole window while it captures, then clips it to the player area (the page inside gets a resize event
// to 1440x900 and back, probed on 2026-10-15), so a stage drawn that way is not the one on screen.
// Every number about the player is read at rest, never during a Playwright screenshot.

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './lib.mjs'

/** Runs code inside the player's webview and returns what the page answers. */
async function inside(win, source) {
  return win.evaluate(async (code) => {
    const wv = document.querySelector('[data-testid=video-webview]')
    if (!wv) throw new Error('no player webview')
    return wv.executeJavaScript(code)
  }, source)
}

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance
const timeNow = (win) => win.evaluate(() => Number(document.querySelector('[data-testid=video-time]')?.getAttribute('data-time') ?? NaN))
const sceneCount = (win) => win.evaluate(() => document.querySelectorAll('[data-testid^=video-scene-]').length)
const statusNow = (win) => win.evaluate(() => document.querySelector('[data-testid=video-status]')?.textContent ?? '')
const rect = (win, selector) =>
  win.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }, selector)

/** A screenshot of the window as it is on screen, webview included. See the note at the top. */
async function shot(t, name) {
  // The capture is the last frame the window painted; after a burst of typing that can be a few frames old.
  await t.win.waitForTimeout(150)
  const png = await t.app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
    return image.toPNG().toString('base64')
  })
  writeFileSync(join(t.shots, `${name}.png`), Buffer.from(png, 'base64'))
}

/** Where the picture really is on screen: the box around everything that is not the black bars. */
async function pictureOnScreen(t, area) {
  const viewport = await t.win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  return t.app.evaluate(
    async ({ BrowserWindow }, args) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
      const size = image.getSize()
      const sx = size.width / args.viewport.w
      const sy = size.height / args.viewport.h
      const bitmap = image.toBitmap()
      const x0 = Math.max(0, Math.floor(args.area.x * sx))
      const x1 = Math.min(size.width, Math.ceil((args.area.x + args.area.w) * sx))
      const y0 = Math.max(0, Math.floor(args.area.y * sy))
      const y1 = Math.min(size.height, Math.ceil((args.area.y + args.area.h) * sy))
      let minX = x1
      let maxX = -1
      let minY = y1
      let maxY = -1
      let bright = 0
      for (let y = y0; y < y1; y++) {
        const row = y * size.width * 4
        for (let x = x0; x < x1; x++) {
          const i = row + x * 4
          const b = bitmap[i]
          const g = bitmap[i + 1]
          const r = bitmap[i + 2]
          const peak = r > g ? (r > b ? r : b) : g > b ? g : b
          if (peak > 6) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
            if (peak > 170) bright++
          }
        }
      }
      if (maxX < 0) return null
      return {
        left: (minX - x0) / sx,
        top: (minY - y0) / sy,
        right: (x1 - 1 - maxX) / sx,
        bottom: (y1 - 1 - maxY) / sy,
        width: (maxX - minX + 1) / sx,
        height: (maxY - minY + 1) / sy,
        bright
      }
    },
    { area, viewport }
  )
}

/** The page inside the player, as the runtime sees it. */
const guestLayout = (win) =>
  inside(
    win,
    `(function(){
      var r = document.getElementById('stage').getBoundingClientRect();
      return { iw: innerWidth, ih: innerHeight, x: r.x, y: r.y, w: r.width, h: r.height, sw: RegattaVideo.width, sh: RegattaVideo.height };
    })()`
  )

/** Which scene the page shows, how far into it, and the words drawn on it. */
const guestFrame = (win) =>
  inside(
    win,
    `(function(){
      var el = document.querySelector('section[data-active]');
      var anims = el ? document.getAnimations().filter(function (a) { return a.effect && a.effect.target && el.contains(a.effect.target) }) : [];
      var caps = document.querySelector('.rv-captions');
      var h1 = el ? el.querySelector('h1') : null;
      return {
        scene: el ? el.getAttribute('data-scene') : null,
        local: anims.length ? Number(anims[0].currentTime) / 1000 : null,
        caption: caps && caps.style.visibility === 'visible' ? caps.textContent : '',
        headline: h1 ? h1.textContent : ''
      };
    })()`
  )

/** Waits until the layout has stopped moving and the page has taken the size of its area. */
async function settled(win) {
  let last = ''
  for (let i = 0; i < 50; i++) {
    const view = await win.evaluate(() => {
      const r = document.querySelector('[data-testid=video-webview]')?.getBoundingClientRect()
      return r ? [Math.round(r.width), Math.round(r.height)] : null
    })
    const guest = view ? await inside(win, '[Math.round(innerWidth), Math.round(innerHeight)]').catch(() => null) : null
    const now = JSON.stringify([view, guest])
    if (view && guest && view[0] === guest[0] && view[1] === guest[1] && now === last) return
    last = now
    await win.waitForTimeout(100)
  }
}

/**
 * The stage on screen must keep its aspect ratio, sit in the middle of the player, use as much of the
 * player as it can, and be the same stage the page says it drew. Read from the page and from pixels.
 */
async function checkLayout(t, label) {
  const { win } = t
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await settled(win)
  const player = await rect(win, '[data-testid=video-player]')
  const view = await rect(win, '[data-testid=video-webview]')
  const guest = await guestLayout(win)
  const seen = await pictureOnScreen(t, player)
  const aspect = guest.sw / guest.sh
  t.check(`${label}: the webview fills the player area`, near(view.w, player.w, 1) && near(view.h, player.h, 1), `${view.w}x${view.h} in ${player.w}x${player.h}`)
  t.check(`${label}: the page sees that same size`, near(guest.iw, view.w, 1) && near(guest.ih, view.h, 1), `${guest.iw}x${guest.ih}`)
  t.check(
    `${label}: the stage keeps its aspect ratio within 2 percent`,
    Math.abs(guest.w / guest.h / aspect - 1) < 0.02,
    `${(guest.w / guest.h).toFixed(3)} against ${aspect.toFixed(3)}`
  )
  t.check(
    `${label}: the stage is centered in the player`,
    near(guest.x, (guest.iw - guest.w) / 2, 1) && near(guest.y, (guest.ih - guest.h) / 2, 1),
    `at ${guest.x.toFixed(1)}, ${guest.y.toFixed(1)}`
  )
  t.check(`${label}: the stage is as big as the player allows`, near(guest.w, guest.iw, 1.5) || near(guest.h, guest.ih, 1.5), `${guest.w.toFixed(1)}x${guest.h.toFixed(1)}`)
  const hints = await win.evaluate(() => {
    const el = document.querySelector('[data-testid=video-hints]')
    return el ? { scroll: el.scrollWidth, client: el.clientWidth } : null
  })
  t.check(`${label}: the hint row under the timeline is not cut off`, hints !== null && hints.scroll <= hints.client + 1, hints ? `${hints.scroll} in ${hints.client}` : 'missing')
  const gaps = await win.evaluate(() => {
    const labels = [...document.querySelectorAll('[data-testid=video-ruler] span')].map((el) => el.getBoundingClientRect()).sort((a, b) => a.left - b.left)
    let least = Infinity
    for (let i = 1; i < labels.length; i++) least = Math.min(least, labels[i].left - labels[i - 1].right)
    return { count: labels.length, least }
  })
  t.check(`${label}: the ruler labels do not touch each other`, gaps.count >= 2 && gaps.least >= 4, `${gaps.count} labels, least gap ${gaps.least.toFixed(1)}`)
  t.check(`${label}: the picture on screen was found`, seen !== null)
  if (seen) {
    t.check(
      `${label}: the picture on screen has the same aspect ratio within 2 percent`,
      Math.abs(seen.width / seen.height / aspect - 1) < 0.02,
      `${seen.width.toFixed(1)}x${seen.height.toFixed(1)}`
    )
    t.check(
      `${label}: the bars on screen are even on both sides`,
      near(seen.left, seen.right, 2) && near(seen.top, seen.bottom, 2),
      `left ${seen.left.toFixed(1)}, right ${seen.right.toFixed(1)}, top ${seen.top.toFixed(1)}, bottom ${seen.bottom.toFixed(1)}`
    )
    t.check(
      `${label}: the picture on screen is where the page says it is`,
      near(seen.left, guest.x, 2) && near(seen.top, guest.y, 2) && near(seen.width, guest.w, 2.5) && near(seen.height, guest.h, 2.5)
    )
  }
  return { player, guest, seen }
}

/** Resizes the window by its content and waits for the page in the player to follow. */
async function resizeWindow(t, width, height) {
  await t.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height })
  await t.win.waitForFunction((size) => window.innerWidth === size.width && window.innerHeight === size.height, { width, height }, { timeout: 8000 })
  await settled(t.win)
}

/** The ids of the videos in the list, newest first. */
const videoIds = (win) =>
  win.evaluate(() => [...document.querySelectorAll('[data-testid^=video-row-]')].map((el) => el.getAttribute('data-testid').slice('video-row-'.length)))

/** Opens the New video dialog, fills it, and creates the video with the Test Agent. */
async function createVideo(t, { title, brief, aspect }) {
  const { win } = t
  await win.click('[data-testid=video-new]')
  await win.waitForSelector('[data-testid=video-create]', { timeout: 8000 })
  await win.fill('[data-testid=video-title]', title)
  await win.fill('[data-testid=video-brief]', brief)
  await win.click(`[data-testid=video-aspect-${aspect.replace(':', 'x')}]`)
  await win.click('[data-testid=video-agent-fake]')
  await win.click('[data-testid=video-create]')
  await win.waitForFunction(() => !document.querySelector('[data-testid=video-new-dialog]'), null, { timeout: 15000 })
}

const waitForStatus = (win, words, timeout = 120000) =>
  win.waitForFunction((w) => document.querySelector('[data-testid=video-status]')?.textContent === w, words, { timeout })

/** A turn or a check is under way: the header has left the status it had before the click. */
const waitForStatusToLeave = (win, words, timeout = 15000) =>
  win.waitForFunction((w) => document.querySelector('[data-testid=video-status]')?.textContent !== w, words, { timeout })

const MOMENTS = [
  { at: 0, label: '0:00.0', file: 't00_0', scene: 'panes', caption: '' },
  { at: 1.5, label: '0:01.5', file: 't01_5', scene: 'panes', caption: 'Run all your coding agents in one window.' },
  { at: 4, label: '0:04.0', file: 't04_0', scene: 'status', caption: 'The one that needs you comes first.' },
  { at: 7, label: '0:07.0', file: 't07_0', scene: 'checks', caption: 'Race them on a task; your tests decide.' },
  { at: 10, label: '0:10.0', file: 't10_0', scene: 'name', caption: 'Regatta. Free and open source.' }
]
const SCENE_START = { panes: 0, status: 3, checks: 6, name: 9 }
const TABS = ['plan', 'activity', 'render']

/** A portrait composition for the 9:16 video: two short scenes, nothing animated by script. */
const PORTRAIT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="regatta-video" content="width=720,height=1280,fps=30" />
    <title>Portrait</title>
    <link rel="stylesheet" href="regatta-video.css" />
    <script src="regatta-video.js"></script>
    <style>
      #stage { background: #0b1220; color: #e8eef7; font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; }
      section[data-scene] { background: linear-gradient(180deg, #17345c 0%, #0b1220 75%); }
      .card { position: absolute; left: 80px; right: 80px; top: 220px; height: 260px; border: 2px solid #2b4268; border-radius: 28px; background: #121a2a; animation: rise 500ms both; }
      h1 { position: absolute; left: 0; right: 0; top: 560px; margin: 0; text-align: center; font-size: 84px; animation: rise 500ms 200ms both; }
      @keyframes rise { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
    </style>
  </head>
  <body>
    <main id="stage">
      <section data-scene="one" data-title="Portrait" data-duration="2"><div class="card"></div><h1>Portrait</h1></section>
      <section data-scene="two" data-title="Tall frame" data-duration="2"><h1>Tall frame</h1></section>
    </main>
  </body>
</html>
`

export default async function video() {
  // REGATTA_E2E_VISIBLE=1 shows the window on screen (default stays hidden).
  const t = await launch('video', { visible: process.env.REGATTA_E2E_VISIBLE === '1' })
  const { win } = t
  // Pictures from an earlier run would be mistaken for this run's.
  for (const file of readdirSync(t.shots)) if (file.endsWith('.png')) rmSync(join(t.shots, file), { force: true })
  const startSize = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  /** The ids of the 16:9 video, the 9:16 video and the one with nothing on its stage, filled in as they are made. */
  const ids = { wide: null, tall: null, empty: null }

  await t.step('Video mode starts behind the Labs switch', async () => {
    await win.click('[data-testid=mode-video]')
    await win.waitForSelector('[data-testid=video-enable]', { timeout: 8000 })
    await win.waitForTimeout(300)
    t.check('the empty state asks to turn Video on', true)
    await shot(t, '01-labs-gate')
  })

  await t.step('turning Video on reveals the list', async () => {
    await win.click('[data-testid=video-enable]')
    await win.waitForSelector('[data-testid=video-new]', { timeout: 8000 })
    await win.waitForTimeout(300)
    t.check('Video mode opens after the switch', true)
    t.check('the list says there are no videos yet', (await win.locator('[data-testid=video-list-empty]').textContent())?.trim() === 'No videos yet.')
    t.check('the middle invites the first video, with a New video button', ((await win.locator('[data-testid=video-empty]').textContent()) ?? '').includes('Make your first video') && (await win.locator('[data-testid=video-empty-new]').count()) === 1)
    await shot(t, '02-no-videos')
  })

  await t.step('the New video dialog and the Test Agent writing a plan', async () => {
    await win.click('[data-testid=video-new]')
    await win.waitForSelector('[data-testid=video-create]', { timeout: 8000 })
    t.check('Create waits for a title and a brief', await win.locator('[data-testid=video-create]').isDisabled())
    await win.fill('[data-testid=video-title]', 'Launch clip')
    await win.fill('[data-testid=video-brief]', 'Panes side by side, then the name.')
    await win.click('[data-testid=video-agent-fake]')
    await win.waitForTimeout(250)
    await shot(t, '03-new-video-dialog')
    await win.click('[data-testid=video-create]')
    await win.waitForFunction(() => !document.querySelector('[data-testid=video-new-dialog]'), null, { timeout: 15000 })
    await win.waitForSelector('[data-testid^=video-row-]', { timeout: 15000 })
    const rows = await win.locator('[data-testid^=video-row-]').count()
    t.check('a video was created and listed', rows === 1, `${rows} rows`)
  })

  await t.step('the plan lands in the Plan tab, and the player says what comes next', async () => {
    await waitForStatus(win, 'Plan ready', 30000)
    ids.wide = (await videoIds(win))[0]
    await win.waitForTimeout(300)
    const plan = await win.evaluate(() => document.querySelector('[data-testid=video-plan]')?.value ?? '')
    t.check('PLAN.md is shown in the editor', plan.includes('Plan'), `${plan.length} chars`)
    t.check('the Plan tab is the one that is open', (await win.getAttribute('[data-testid=video-tab-plan]', 'aria-selected')) === 'true')
    t.check('the Build button appears when the plan is ready', (await win.locator('[data-testid=video-build]').count()) === 1)
    t.check('and it is the only Build button on screen: the player points at it in words', ((await win.locator('[data-testid=video-stage-notice]').textContent()) ?? '').includes('Build the video') && (await win.locator('[data-testid=video-stage-notice] button').count()) === 0)
    t.check('the player says the plan is ready instead of showing a black box', (await win.getAttribute('[data-testid=video-stage-notice]', 'data-kind')) === 'planned')
    t.check('there is no page in the player yet', (await win.locator('[data-testid=video-webview]').count()) === 0)
    t.check('the timeline says the scenes come once the video is built, with no empty bars or hints', (await win.locator('[data-testid=video-timeline-empty]').count()) === 1 && (await win.locator('[data-testid=video-captions]').count()) === 0 && (await win.locator('[data-testid=video-ruler]').count()) === 0 && (await win.locator('[data-testid=video-hints]').count()) === 0)
    t.check('the controls wait for a built video', await win.locator('[data-testid=video-play]').isDisabled())
    t.check('the list says Plan ready under the title', ((await win.locator('[data-testid^=video-state-]').first().textContent()) ?? '').trim() === 'Plan ready')
    await shot(t, '04-plan-ready')
  })

  await t.step('building runs the checks to Ready, and the Plan tab stays open', async () => {
    await win.click('[data-testid=video-build]')
    await waitForStatus(win, 'Ready')
    await win.waitForTimeout(400)
    t.check('the build settles at Ready', true)
    // In a visible launch the check process once hung; a hang would hold
    // the status at Checking, so this step is also the visible regression run.
    if (process.env.REGATTA_E2E_VISIBLE === '1')
      t.check('visible launch: the check process came back and the video is Ready, not stuck at Checking', (await statusNow(win)) === 'Ready')
    t.check('a finished build leaves the Plan tab open', (await win.getAttribute('[data-testid=video-tabpanel]', 'data-tab')) === 'plan')
    t.check('the Plan tab still shows the plan text', ((await win.evaluate(() => document.querySelector('[data-testid=video-plan]')?.value ?? '')).includes('Plan')))
  })

  await t.step('the player shows the stage', async () => {
    await win.waitForSelector('[data-testid=video-player][data-phase=ready]', { timeout: 30000 })
    const dur = await inside(win, 'window.RegattaVideo.ready.then(function(){return RegattaVideo.duration})')
    const scenes = await inside(win, 'window.RegattaVideo.scenes.length')
    t.check('the composition is 12 seconds', Math.round(dur) === 12, `${dur} s`)
    t.check('the example has four scenes', scenes === 4, `${scenes} scenes`)
    t.check('the scene strip draws four blocks', (await sceneCount(win)) === 4)
    t.check('the clock reads the start and the length', ((await win.locator('[data-testid=video-time]').textContent()) ?? '').trim() === '0:00.0 / 0:12.0')
    t.check('the header gives the length, the size and the frame rate', ((await win.locator('[data-testid=video-meta]').textContent()) ?? '').trim() === '12.0 s · 1280×720 · 30 fps')
    t.check('the first scene is the one marked as playing', (await win.getAttribute('[data-testid=video-scene-panes]', 'data-active')) === 'true')
    t.check('every scene block has its thumbnail', (await win.locator('[data-testid^=video-scene-] img').count()) === 4)
    t.check('a wide video fills its blocks with the thumbnails', (await win.evaluate(() => [...document.querySelectorAll('[data-testid^=video-scene-] img')].every((img) => getComputedStyle(img).objectFit === 'cover'))))
    const broken = await win.evaluate(() => [...document.querySelectorAll('[data-testid^=video-scene-] img')].filter((img) => !img.complete || img.naturalWidth === 0).length)
    t.check('and every thumbnail loaded', broken === 0, `${broken} broken`)
    await checkLayout(t, 'at 1440 wide')
  })

  await t.step('one frame forward and back with the arrow keys', async () => {
    await win.click('[data-testid=video-surface]')
    const before = await timeNow(win)
    await win.keyboard.press('ArrowRight')
    await win.waitForTimeout(120)
    const after = await timeNow(win)
    const delta = after - before
    t.check('one frame advances by a thirtieth of a second', delta > 0.02 && delta < 0.05, `+${delta.toFixed(4)} s`)
    await win.keyboard.press('ArrowLeft')
    await win.waitForTimeout(120)
    t.check('and the Left arrow goes back to the first frame', near(await timeNow(win), 0, 0.001), `${(await timeNow(win)).toFixed(4)} s`)
  })

  await t.step('five moments of the video, each with the Plan, Activity and Render tabs open', async () => {
    let n = 5
    for (const moment of MOMENTS) {
      // Only the arrow keys and the scene blocks, the way a person moves through the video.
      if (moment.at === 0) {
        await win.click('[data-testid=video-scene-panes]')
      } else if (moment.at === 1.5) {
        await win.click('[data-testid=video-surface]')
        for (let i = 0; i < 45; i++) await win.keyboard.press('ArrowRight')
      } else {
        await win.click(`[data-testid=video-scene-${moment.scene}]`)
        await win.click('[data-testid=video-surface]')
        for (let i = 0; i < 30; i++) await win.keyboard.press('ArrowRight')
      }
      await win.waitForFunction((target) => Math.abs(Number(document.querySelector('[data-testid=video-time]')?.getAttribute('data-time')) - target) < 0.01, moment.at, { timeout: 8000 })
      let frame = null
      for (let i = 0; i < 40; i++) {
        frame = await guestFrame(win)
        if (frame.local !== null && near(SCENE_START[frame.scene] + frame.local, moment.at, 0.02)) break
        await win.waitForTimeout(100)
      }
      await inside(win, 'new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r) }) })')
      await win.waitForTimeout(150)
      const label = moment.label
      t.check(`at ${label}: the clock reads ${label}`, ((await win.locator('[data-testid=video-time] > span').first().textContent()) ?? '').trim() === label)
      t.check(`at ${label}: the page is on the ${moment.scene} scene, at that very time`, frame.scene === moment.scene && near(SCENE_START[frame.scene] + frame.local, moment.at, 0.02), `${frame.scene} +${frame.local}`)
      t.check(`at ${label}: the caption is ${moment.caption ? JSON.stringify(moment.caption) : 'not showing yet'}`, frame.caption === moment.caption, JSON.stringify(frame.caption))
      t.check(`at ${label}: the scene strip marks the ${moment.scene} scene`, (await win.getAttribute(`[data-testid=video-scene-${moment.scene}]`, 'data-active')) === 'true')
      const playheadAt = Number(await win.getAttribute('[data-testid=video-playhead]', 'data-percent'))
      t.check(`at ${label}: the playhead is at ${((moment.at / 12) * 100).toFixed(1)} percent`, near(playheadAt, (moment.at / 12) * 100, 0.3), `${playheadAt}`)
      const layout = await checkLayout(t, `at ${label}`)
      const bright = layout.seen?.bright ?? 0
      if (moment.at === 0) {
        t.check('at 0:00.0: the first frame is the start of a fade-in, so nothing is drawn yet', bright === 0, `${bright} bright pixels`)
      } else {
        t.check(`at ${label}: the frame has things drawn on it`, bright > 400, `${bright} bright pixels`)
      }
      for (const tab of TABS) {
        await win.click(`[data-testid=video-tab-${tab}]`)
        await win.waitForTimeout(200)
        t.check(`at ${label}: the ${tab} tab is the one marked as open`, (await win.getAttribute(`[data-testid=video-tab-${tab}]`, 'aria-selected')) === 'true' && (await win.getAttribute('[data-testid=video-tabpanel]', 'data-tab')) === tab)
        if (moment.at === 0) {
          if (tab === 'plan') {
            const editor = await rect(win, '[data-testid=video-plan]')
            const save = await rect(win, '[data-testid=video-plan-save]')
            const tell = await rect(win, '[data-testid=video-plan-tell]')
            const win_ = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
            const inView = (r) => r && r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= win_.w && r.y + r.h <= win_.h
            t.check('the Plan tab shows the editor, big enough to read', editor && editor.w > 250 && editor.h > 200, editor ? `${editor.w}x${editor.h}` : 'missing')
            t.check('the editor holds PLAN.md', (await win.evaluate(() => document.querySelector('[data-testid=video-plan]')?.value ?? '')).includes('1. panes, Side by side, 3 s'))
            t.check('Save is on screen', inView(save))
            t.check('Save and tell the agent is on screen', inView(tell))
            t.check('Render MP4 is not on the Plan tab', (await win.locator('[data-testid=video-render]').count()) === 0)
          } else if (tab === 'activity') {
            const stable = ((await win.locator('[data-testid=video-check-stable]').textContent()) ?? '').trim()
            t.check('the Activity tab lists the pixel check with its numbers', stable.includes('28 of 28'), stable)
            t.check('and the two turns, newest first', (await win.locator('[data-testid^=video-turn-]').count()) === 2)
            t.check('Undo last change is offered', (await win.locator('[data-testid=video-undo]').count()) === 1)
            t.check('there is no plan editor on the Activity tab', (await win.locator('[data-testid=video-plan]').count()) === 0)
          } else {
            const button = win.locator('[data-testid=video-render]')
            // Without ffmpeg the button is there but off, and the tab says why (checked in the render step below).
            const noFfmpeg = (await win.locator('[data-testid=video-ffmpeg-hint]').count()) === 1
            t.check(
              noFfmpeg ? 'the Render tab has Render MP4, kept off because ffmpeg is missing' : 'the Render tab has Render MP4, ready to press',
              (await button.count()) === 1 && (await button.isEnabled()) === !noFfmpeg
            )
            t.check('and says nothing has been rendered yet', (await win.locator('[data-testid=video-renders-empty]').count()) === 1)
            t.check('there is no plan editor on the Render tab', (await win.locator('[data-testid=video-plan]').count()) === 0)
          }
        }
        await shot(t, `${String(n).padStart(2, '0')}-${moment.file}-${tab}`)
      }
      n++
    }
    await win.click('[data-testid=video-tab-plan]')
  })

  await t.step('the stage keeps fitting when the window and the panels change size', async () => {
    // The right sidebar closed: the player gets wider than 16:9 allows for its height, so the picture is as wide as the area.
    await win.click('button[aria-label="Toggle right sidebar"]')
    await settled(win)
    const wide = await checkLayout(t, 'with the sidebar closed')
    t.check('the player area got wider when the sidebar closed', wide.player.w > 800, `${wide.player.w}`)
    await shot(t, '20-sidebar-closed')

    // A short window: now the area is wider than 16:9, so the bars move to the sides.
    await resizeWindow(t, startSize.width, 640)
    const short = await checkLayout(t, 'in a short window')
    t.check('the short window leaves bars on the left and right', short.seen && short.seen.left > 20 && short.seen.right > 20, short.seen ? `${short.seen.left.toFixed(1)} and ${short.seen.right.toFixed(1)}` : 'no picture')
    await shot(t, '21-short-window')

    // A narrow window with the sidebar open again: the player area is tiny, and the stage still fits it.
    await win.click('button[aria-label="Toggle right sidebar"]')
    await resizeWindow(t, 1100, 800)
    const narrow = await checkLayout(t, 'in a narrow window')
    t.check('the narrow window really made the player narrow', narrow.player.w < 400, `${narrow.player.w}`)
    await shot(t, '22-narrow-window')

    await resizeWindow(t, startSize.width, startSize.height)
    const back = await checkLayout(t, 'back at the first size')
    t.check('and the first size gives the first layout again', near(back.player.w, 560, 6), `${back.player.w}`)
  })

  await t.step('clicking a scene jumps to its start', async () => {
    await win.click('[data-testid=video-scene-name]')
    await win.waitForTimeout(150)
    const at = await timeNow(win)
    t.check('the last scene starts at 9 seconds', near(at, 9, 0.05), `${at.toFixed(3)} s`)
  })

  await t.step('the playhead can be dragged and the ruler clicked', async () => {
    const ruler = await rect(win, '[data-testid=video-ruler]')
    const handle = await rect(win, '[data-testid=video-playhead-handle]')
    const startX = handle.x + handle.w / 2
    const y = handle.y + handle.h / 2
    await win.mouse.move(startX, y)
    await win.mouse.down()
    await win.mouse.move(ruler.x + ruler.w * (2 / 12), y, { steps: 6 })
    await win.mouse.up()
    await win.waitForTimeout(150)
    const dragged = await timeNow(win)
    t.check('dragging the playhead to the 2 second mark lands on 2 seconds', near(dragged, 2, 0.1), `${dragged.toFixed(3)} s`)
    await win.mouse.click(ruler.x + ruler.w * (5 / 12), ruler.y + ruler.h / 2)
    await win.waitForTimeout(150)
    const clicked = await timeNow(win)
    t.check('clicking the ruler at 5 seconds lands on 5 seconds', near(clicked, 5, 0.1), `${clicked.toFixed(3)} s`)
    await win.click('[data-testid=video-scene-name]')
    await win.waitForTimeout(150)
  })

  await t.step('Space plays and pauses', async () => {
    // The music is switched off first: a test must not make a sound in the room.
    await win.click('[data-testid=video-mute]')
    t.check('the mute button switches to Unmute', (await win.getAttribute('[data-testid=video-mute]', 'aria-label')) === 'Unmute')
    await win.click('[data-testid=video-surface]')
    const before = await timeNow(win)
    await win.keyboard.press('Space')
    await win.waitForTimeout(700)
    t.check('Space starts playing', (await win.getAttribute('[data-testid=video-play]', 'data-playing')) === 'true')
    await win.keyboard.press('Space')
    await win.waitForTimeout(150)
    const after = await timeNow(win)
    t.check('Space pauses it', (await win.getAttribute('[data-testid=video-play]', 'data-playing')) === 'false')
    t.check('and the time moved while it played', after - before > 0.3 && after - before < 2, `+${(after - before).toFixed(2)} s`)
    await win.click('[data-testid=video-mute]')
    t.check('the mute button switches back', (await win.getAttribute('[data-testid=video-mute]', 'aria-label')) === 'Mute')
    await win.click('[data-testid=video-scene-name]')
    await win.waitForTimeout(150)
  })

  await t.step('pointing at a frame opens a note with its text', async () => {
    await win.click('[data-testid=video-point]')
    await win.waitForSelector('[data-testid=video-point-overlay]', { timeout: 5000 })
    await win.keyboard.press('Escape')
    await win.waitForTimeout(150)
    t.check('Esc leaves pointing straight after Point is pressed', (await win.locator('[data-testid=video-point-overlay]').count()) === 0 && (await win.getAttribute('[data-testid=video-point]', 'aria-pressed')) === 'false')
    await win.click('[data-testid=video-point]')
    await win.waitForSelector('[data-testid=video-point-overlay]', { timeout: 5000 })
    await win.waitForTimeout(200)
    // The crosshair covers the picture and only the picture.
    const player = await rect(win, '[data-testid=video-player]')
    const overlay = await rect(win, '[data-testid=video-point-overlay]')
    const stage = await guestLayout(win)
    t.check(
      'the crosshair area is exactly the picture, not the black bars',
      near(overlay.x - player.x, stage.x, 1.5) && near(overlay.y - player.y, stage.y, 1.5) && near(overlay.w, stage.w, 1.5) && near(overlay.h, stage.h, 1.5),
      `${overlay.w.toFixed(1)}x${overlay.h.toFixed(1)} at ${(overlay.x - player.x).toFixed(1)},${(overlay.y - player.y).toFixed(1)} against ${stage.w.toFixed(1)}x${stage.h.toFixed(1)} at ${stage.x.toFixed(1)},${stage.y.toFixed(1)}`
    )
    t.check('the crosshair is the cursor over the picture and not over the bars', (await win.evaluate(() => getComputedStyle(document.querySelector('[data-testid=video-point-overlay]')).cursor)) === 'crosshair' && (await win.evaluate(() => getComputedStyle(document.querySelector('[data-testid=video-point-shield]')).cursor)) !== 'crosshair')
    await shot(t, '40-point-ready')
    await win.mouse.click(player.x + 20, player.y + 20)
    await win.waitForTimeout(200)
    t.check('a click in a black bar opens no note', (await win.locator('[data-testid=video-note]').count()) === 0)
    t.check('and pointing stays on', (await win.locator('[data-testid=video-point-overlay]').count()) === 1)
    await win.click('[data-testid=video-point-overlay]')
    await win.waitForSelector('[data-testid=video-note]', { timeout: 5000 })
    const text = (await win.locator('[data-testid=video-note-text]').textContent()) ?? ''
    t.check('the note box names the element under the point', text.trim().length > 0 && !text.includes('the frame itself'), JSON.stringify(text.trim()))
    t.check('the note box says when and in which scene', ((await win.locator('[data-testid=video-note-time]').textContent()) ?? '').includes('0:09.0'))
    t.check('a ring marks the spot that was pointed at', (await win.locator('[data-testid=video-point-marker]').count()) === 1)
    // Space and the arrows are text in the note field, not player keys.
    const before = await timeNow(win)
    await win.keyboard.type('make the title bigger, please')
    const typed = await win.inputValue('[data-testid=video-note-field]')
    t.check('spaces and letters can be typed into the note', typed === 'make the title bigger, please', JSON.stringify(typed))
    await win.keyboard.press('ArrowLeft')
    t.check('typing in the note does not play or step the video', near(await timeNow(win), before, 0.001) && (await win.getAttribute('[data-testid=video-play]', 'data-playing')) === 'false')
    await shot(t, '41-point-note')
    // A click in a bar leaves the note as it is.
    await win.mouse.click(player.x + 20, player.y + player.h - 20)
    await win.waitForTimeout(200)
    t.check('a click in a bar leaves the note and its words alone', (await win.inputValue('[data-testid=video-note-field]')) === typed)
    // A click near the corner of the picture: the box goes to the other side of the click and stays inside the player.
    const corner = { x: overlay.x + overlay.w - 6, y: overlay.y + overlay.h - 6 }
    await win.mouse.click(corner.x, corner.y)
    await win.waitForFunction(() => document.querySelector('[data-testid=video-note-field]')?.value === '', null, { timeout: 5000 })
    const note = await rect(win, '[data-testid=video-note]')
    t.check(
      'a click near the corner of the picture gives a note box entirely inside the player',
      note && note.x >= player.x && note.y >= player.y && note.x + note.w <= player.x + player.w + 0.5 && note.y + note.h <= player.y + player.h + 0.5,
      note ? `box ${note.x.toFixed(0)},${note.y.toFixed(0)} ${note.w.toFixed(0)}x${note.h.toFixed(0)} in ${player.x.toFixed(0)},${player.y.toFixed(0)} ${player.w.toFixed(0)}x${player.h.toFixed(0)}` : 'no box'
    )
    t.check(
      'and the box does not cover the spot that was clicked',
      note && !(corner.x >= note.x && corner.x <= note.x + note.w && corner.y >= note.y && corner.y <= note.y + note.h),
      note ? `click at ${corner.x.toFixed(0)},${corner.y.toFixed(0)}` : 'no box'
    )
    await shot(t, '42-point-note-in-the-corner')
    await win.keyboard.press('Escape')
    await win.waitForTimeout(150)
    t.check('Escape closes the note and leaves pointing', (await win.locator('[data-testid=video-note]').count()) === 0 && (await win.locator('[data-testid=video-point-overlay]').count()) === 0)
  })

  await t.step('asking for a change sends it, shows it in Activity, and reloads the video where it was', async () => {
    await win.click('[data-testid=video-scene-name]')
    await win.click('[data-testid=video-point]')
    await win.waitForSelector('[data-testid=video-point-overlay]', { timeout: 5000 })
    await win.click('[data-testid=video-point-overlay]')
    await win.waitForSelector('[data-testid=video-note-field]', { timeout: 5000 })
    await win.keyboard.type('make the first headline say it was changed')
    await win.click('[data-testid=video-note-send]')
    await waitForStatusToLeave(win, 'Ready')
    t.check('asking for the change opens the Activity tab', (await win.getAttribute('[data-testid=video-tabpanel]', 'data-tab')) === 'activity')
    await win.waitForSelector('[data-testid=video-stop]', { timeout: 15000 }).catch(() => undefined)
    await win.waitForFunction(() => document.querySelector('[data-testid=video-status]')?.textContent === 'Checking', null, { timeout: 30000 }).catch(() => undefined)
    if ((await statusNow(win)) === 'Checking') {
      t.check('while the checks run again, the old results are marked as from before', (await win.getAttribute('[data-testid=video-checks]', 'data-stale')) === 'true' && ((await win.locator('[data-testid=video-checks-stale]').textContent()) ?? '').trim() === 'Checking again')
      await shot(t, '43-change-running')
    } else {
      t.check('the checks ran again (the agent was quick)', true)
    }
    await waitForStatus(win, 'Ready')
    // The page reloads once the turn is over; give that a moment to start, then wait for it to be up.
    await win.waitForTimeout(400)
    await win.waitForSelector('[data-testid=video-player][data-phase=ready]', { timeout: 30000 })
    const turns = await win.locator('[data-testid^=video-turn-]').count()
    t.check('Activity lists the change as a third turn', turns === 3, `${turns} turns`)
    t.check('the checks are current again once Ready', (await win.getAttribute('[data-testid=video-checks]', 'data-stale')) === 'false')
    const first = ((await win.locator('[data-testid^=video-turn-]').first().textContent()) ?? '').trim()
    t.check('the newest turn is the change, with the words that were typed', first.includes('Changed a spot') && first.includes('make the first headline say it was changed'), first)
    let headline = ''
    for (let i = 0; i < 40 && !headline.includes('changed by the test agent'); i++) {
      headline = await inside(win, `document.querySelector('section[data-scene="panes"] h1').textContent`).catch(() => '')
      if (!headline.includes('changed by the test agent')) await win.waitForTimeout(250)
    }
    t.check('the agent changed the first headline', headline.includes('changed by the test agent'), headline)
    t.check('the video came back at the spot it was left', near(await timeNow(win), 9, 0.05), `${(await timeNow(win)).toFixed(3)} s`)
    const ruler = await rect(win, '[data-testid=video-ruler]')
    await win.mouse.click(ruler.x + ruler.w * (2 / 12), ruler.y + ruler.h / 2)
    await win.waitForTimeout(400)
    await shot(t, '44-after-the-change')
  })

  await t.step('Render MP4 draws the file and lists it', async () => {
    await win.click('[data-testid=video-tab-render]')
    await win.waitForTimeout(300)
    // A computer without ffmpeg cannot render. The tab says how to get it and keeps the button off; the file itself is
    // then not rendered, as in video-render.test.mjs.
    if ((await win.locator('[data-testid=video-ffmpeg-hint]').count()) === 1) {
      const hint = ((await win.locator('[data-testid=video-ffmpeg-hint]').textContent()) ?? '').trim()
      t.check('without ffmpeg the Render tab says how to install it', hint.includes('brew install ffmpeg'), hint)
      t.check('and keeps Render MP4 off, although the video is Ready', await win.locator('[data-testid=video-render]').isDisabled())
      console.log('  NOTE  ffmpeg is not on PATH, so the MP4 render was not run')
      await shot(t, '50-no-ffmpeg')
      return
    }
    t.check('the Render tab offers the render once the video is Ready', await win.locator('[data-testid=video-render]').isEnabled())
    await win.click('[data-testid=video-render]')
    await win.waitForSelector('[data-testid=video-render-active]', { timeout: 15000 }).catch(() => undefined)
    await shot(t, '50-rendering')
    await win.waitForSelector('[data-testid=video-reveal]', { timeout: 120000 })
    await win.waitForTimeout(300)
    const row = ((await win.locator('[data-testid=video-tabpanel] li[data-status=done]').first().textContent()) ?? '').trim()
    t.check('the finished file is listed with its name, size and loudness', /\.mp4/.test(row) && /(KB|MB)/.test(row) && /LUFS/.test(row), row)
    t.check('Show in Finder is offered for it', (await win.locator('[data-testid=video-reveal]').count()) === 1)
    await shot(t, '51-render-finished')
  })

  await t.step('editing the plan: Save keeps it, Save and tell the agent sends the agent after it', async () => {
    await win.click('[data-testid=video-tab-plan]')
    await win.waitForFunction(() => (document.querySelector('[data-testid=video-plan]')?.value ?? '').includes('Plan'), null, { timeout: 8000 })
    const original = await win.inputValue('[data-testid=video-plan]')
    t.check('an untouched plan says Saved', ((await win.locator('[data-testid=video-plan-state]').textContent()) ?? '').trim() === 'Saved')
    const note = 'Note: hold the last scene for three seconds.'
    await win.fill('[data-testid=video-plan]', `${original.trimEnd()}\n\n${note}\n`)
    t.check('typing in the plan says Not saved', ((await win.locator('[data-testid=video-plan-state]').textContent()) ?? '').trim() === 'Not saved')
    await shot(t, '45-plan-edited')
    await win.click('[data-testid=video-tab-activity]')
    await win.click('[data-testid=video-tab-render]')
    await win.click('[data-testid=video-tab-plan]')
    t.check('a look at the other tabs does not lose what was typed', (await win.inputValue('[data-testid=video-plan]')).includes(note))
    t.check('and the plan still says Not saved', ((await win.locator('[data-testid=video-plan-state]').textContent()) ?? '').trim() === 'Not saved')
    await win.click('[data-testid=video-plan-save]')
    await win.waitForFunction(() => document.querySelector('[data-testid=video-plan-state]')?.textContent === 'Saved', null, { timeout: 8000 })
    t.check('Save says Saved', true)
    await win.click('[data-testid=video-tab-activity]')
    await win.click('[data-testid=video-tab-plan]')
    await win.waitForFunction((n) => (document.querySelector('[data-testid=video-plan]')?.value ?? '').includes(n), note, { timeout: 8000 })
    t.check('the saved plan comes back from the file when the tab is opened again', true)
    t.check('saving did not send the agent anywhere', (await statusNow(win)) === 'Ready')

    await win.fill('[data-testid=video-plan]', `${original.trimEnd()}\n\n${note}\nNote: end on the name.\n`)
    await win.click('[data-testid=video-plan-tell]')
    await waitForStatusToLeave(win, 'Ready')
    await win.waitForTimeout(300)
    t.check('Save and tell the agent keeps the Plan tab open', (await win.getAttribute('[data-testid=video-tabpanel]', 'data-tab')) === 'plan')
    t.check('and locks the buttons while the agent works', await win.locator('[data-testid=video-plan-tell]').isDisabled())
    t.check('the editor says saving waits, and stays open for typing', ((await win.locator('[data-testid=video-plan-busy]').textContent()) ?? '').includes('saving waits') && !(await win.evaluate(() => document.querySelector('[data-testid=video-plan]').readOnly)))
    t.check('the plan still says Saved while the agent works', ((await win.locator('[data-testid=video-plan-state]').textContent()) ?? '').trim() === 'Saved')
    await shot(t, '46-plan-agent-working')
    await waitForStatus(win, 'Ready')
    await win.waitForTimeout(400)
    await win.waitForSelector('[data-testid=video-player][data-phase=ready]', { timeout: 30000 })
    await win.click('[data-testid=video-tab-activity]')
    const newest = ((await win.locator('[data-testid^=video-turn-]').first().textContent()) ?? '').trim()
    t.check('Activity lists a turn that matched the plan', newest.includes('Matched the plan'), newest)
    await win.click('[data-testid=video-tab-plan]')
    await win.waitForFunction(() => (document.querySelector('[data-testid=video-plan]')?.value ?? '').includes('end on the name'), null, { timeout: 8000 }).catch(() => undefined)
    t.check('the editor holds both notes after the turn', (await win.inputValue('[data-testid=video-plan]')).includes('end on the name'))
  })

  await t.step('a 9:16 video builds, fails its checks when the agent ignores the size, and Undo brings the good one back', async () => {
    await createVideo(t, { title: 'Portrait clip', brief: 'A tall clip with two scenes.', aspect: '9:16' })
    await waitForStatus(win, 'Plan ready', 30000)
    t.check('the new video is the one on screen, and is 9:16', ((await win.locator('[data-testid=video-aspect]').textContent()) ?? '').trim() === '9:16')
    const all = await videoIds(win)
    t.check('the list has both videos', all.length === 2, `${all.length}`)
    ids.tall = await win.evaluate(() => document.querySelector('[data-testid^=video-row-][aria-current=true]')?.getAttribute('data-testid')?.slice('video-row-'.length))
    // A good portrait page goes in before the build; the build's snapshot keeps it for Undo.
    writeFileSync(join(t.profile, 'videos', ids.tall, 'index.html'), PORTRAIT_HTML)
    await win.click('[data-testid=video-build]')
    await waitForStatusToLeave(win, 'Plan ready')
    await waitForStatus(win, 'Needs attention', 180000)
    await win.click('[data-testid=video-tab-activity]')
    await win.waitForTimeout(500)
    const loads = ((await win.locator('[data-testid=video-check-loads]').textContent()) ?? '').trim()
    t.check('the failed size check says why', /says 1280x720.*720x1280/.test(loads), loads)
    t.check('the header says the video needs attention', (await statusNow(win)) === 'Needs attention')
    t.check('the failed check carries a cross', (await win.getAttribute('[data-testid=video-check-loads]', 'data-passed')) === 'false')
    await shot(t, '60-needs-attention')
    // The page here draws a 16:9 stage although the video is 9:16. The crosshair must sit on what is drawn.
    await win.click('[data-testid=video-point]')
    await win.waitForSelector('[data-testid=video-point-overlay]', { timeout: 5000 })
    const mismatchPlayer = await rect(win, '[data-testid=video-player]')
    const mismatchOverlay = await rect(win, '[data-testid=video-point-overlay]')
    const mismatchStage = await guestLayout(win)
    t.check(
      'when the page draws another size than the video, the crosshair still covers exactly what is drawn',
      near(mismatchOverlay.x - mismatchPlayer.x, mismatchStage.x, 1.5) &&
        near(mismatchOverlay.y - mismatchPlayer.y, mismatchStage.y, 1.5) &&
        near(mismatchOverlay.w, mismatchStage.w, 1.5) &&
        near(mismatchOverlay.h, mismatchStage.h, 1.5),
      `${mismatchOverlay.w.toFixed(1)}x${mismatchOverlay.h.toFixed(1)} against ${mismatchStage.w.toFixed(1)}x${mismatchStage.h.toFixed(1)}`
    )
    await win.keyboard.press('Escape')
    await win.waitForTimeout(150)
    // Undo goes back one turn at a time: first before the fix, then before the build.
    for (let i = 0; i < 2; i++) {
      await win.click('[data-testid=video-undo]')
      await waitForStatusToLeave(win, 'Needs attention').catch(() => undefined)
      await win.waitForFunction(() => ['Ready', 'Needs attention'].includes(document.querySelector('[data-testid=video-status]')?.textContent ?? ''), null, { timeout: 120000 })
      await win.waitForTimeout(400)
    }
    t.check('two undos bring the portrait page back and it is Ready', (await statusNow(win)) === 'Ready', await statusNow(win))
    await win.waitForSelector('[data-testid=video-player][data-phase=ready]', { timeout: 30000 })
    const meta = ((await win.locator('[data-testid=video-meta]').textContent()) ?? '').trim()
    t.check('the header now reads the portrait size', meta === '4.0 s · 720×1280 · 30 fps', meta)
    t.check('a tall video shows each thumbnail whole', await win.evaluate(() => [...document.querySelectorAll('[data-testid^=video-scene-] img')].length === 2 && [...document.querySelectorAll('[data-testid^=video-scene-] img')].every((img) => getComputedStyle(img).objectFit === 'contain')))
    t.check('a video without captions says so once its page has been read', ((await win.locator('[data-testid=video-captions]').textContent()) ?? '').includes('No captions'))
    await checkLayout(t, 'a 9:16 video in a tall player')
    await win.click('[data-testid=video-tab-plan]')
    await win.waitForTimeout(250)
    await shot(t, '61-portrait-ready')
    // Back to the first video through the list.
    await win.click(`[data-testid=video-row-${ids.wide}]`)
    await win.waitForSelector('[data-testid=video-player][data-phase=ready]', { timeout: 30000 })
    await settled(win)
    t.check('picking the first video in the list brings its player back', ((await win.locator('[data-testid=video-meta]').textContent()) ?? '').trim() === '12.0 s · 1280×720 · 30 fps')
    // Each video keeps its own unsaved plan text.
    await win.waitForFunction(() => (document.querySelector('[data-testid=video-plan]')?.value ?? '').includes('end on the name'), null, { timeout: 8000 })
    const firstPlan = await win.inputValue('[data-testid=video-plan]')
    await win.fill('[data-testid=video-plan]', `${firstPlan.trimEnd()}\nDraft line for the first video.\n`)
    await win.click(`[data-testid=video-row-${ids.tall}]`)
    await win.waitForFunction(() => document.querySelector('[data-testid=video-aspect]')?.textContent === '9:16', null, { timeout: 8000 })
    await win.waitForFunction(() => (document.querySelector('[data-testid=video-plan]')?.value ?? '').includes('Plan'), null, { timeout: 8000 })
    t.check('the other video shows its own plan, without that line', !(await win.inputValue('[data-testid=video-plan]')).includes('Draft line'))
    await win.click(`[data-testid=video-row-${ids.wide}]`)
    await win.waitForFunction(() => document.querySelector('[data-testid=video-aspect]')?.textContent === '16:9', null, { timeout: 8000 })
    await win.waitForFunction(() => (document.querySelector('[data-testid=video-plan]')?.value ?? '').includes('Plan'), null, { timeout: 8000 })
    t.check('switching away and back keeps the unsaved line', (await win.inputValue('[data-testid=video-plan]')).includes('Draft line for the first video.'))
    t.check('and the plan says Not saved', ((await win.locator('[data-testid=video-plan-state]').textContent()) ?? '').trim() === 'Not saved')
    await win.waitForSelector('[data-testid=video-player][data-phase=ready]', { timeout: 30000 })
    await settled(win)
    await checkLayout(t, 'after switching back to the 16:9 video')
    await shot(t, '62-back-to-the-first-video')
  })

  await t.step('a video with nothing on its stage says why, in the player and in Activity', async () => {
    await createVideo(t, { title: 'Empty clip', brief: 'Nothing on the stage yet.', aspect: '16:9' })
    await waitForStatus(win, 'Plan ready', 30000)
    ids.empty = await win.evaluate(() => document.querySelector('[data-testid^=video-row-][aria-current=true]')?.getAttribute('data-testid')?.slice('video-row-'.length))
    // The folder starts with the starter page, which has the runtime and an empty stage. The build's snapshot keeps it,
    // so Undo after a good build brings back a page with no scenes.
    await win.click('[data-testid=video-build]')
    await waitForStatusToLeave(win, 'Plan ready')
    await waitForStatus(win, 'Ready', 120000)
    await win.click('[data-testid=video-tab-activity]')
    await win.waitForSelector('[data-testid=video-undo]', { timeout: 8000 })
    await win.click('[data-testid=video-undo]')
    await waitForStatus(win, 'Needs attention', 120000)
    await win.waitForSelector('[data-testid=video-stage-notice][data-kind=failed]', { timeout: 10000 })
    const notice = ((await win.locator('[data-testid=video-stage-notice]').textContent()) ?? '').trim()
    t.check('the player says there is no video yet, and why', notice.includes('There is no video yet') && notice.includes('No scenes: add'), notice)
    t.check('there is no page in the player to be mistaken for the video', (await win.locator('[data-testid=video-webview]').count()) === 0)
    t.check('the timeline says the scenes come with the video', (await win.locator('[data-testid=video-timeline-empty]').count()) === 1)
    t.check('the controls are off', await win.locator('[data-testid=video-play]').isDisabled() && await win.locator('[data-testid=video-point]').isDisabled())
    const loads = ((await win.locator('[data-testid=video-check-loads]').textContent()) ?? '').trim()
    t.check('Activity gives the same reason under Loads, with a cross', loads.includes('No scenes: add') && (await win.getAttribute('[data-testid=video-check-loads]', 'data-passed')) === 'false', loads)
    t.check('the list marks it as needing attention', ((await win.locator(`[data-testid=video-state-${ids.empty}]`).textContent()) ?? '').trim() === 'Needs attention')
    await shot(t, '64-no-scenes')
  })

  await t.step('a page that is not a video says so, with a way to see why', async () => {
    const file = join(t.profile, 'videos', ids.wide, 'index.html')
    const good = readFileSync(file, 'utf8')
    writeFileSync(file, '<!doctype html><html><body>This is not a video page.</body></html>')
    try {
      // Another video and back: the player starts again from the file.
      await win.click(`[data-testid=video-row-${ids.tall}]`)
      await win.waitForFunction(() => document.querySelector('[data-testid=video-aspect]')?.textContent === '9:16', null, { timeout: 8000 })
      await win.click(`[data-testid=video-row-${ids.wide}]`)
      await win.waitForSelector('[data-testid=video-player][data-phase=error]', { timeout: 20000 })
      await win.waitForTimeout(250)
      t.check('the player says the video did not load', (await win.getAttribute('[data-testid=video-stage-notice]', 'data-kind')) === 'unreadable')
      t.check('and the controls stay off', await win.locator('[data-testid=video-play]').isDisabled())
      t.check('and the captions row claims nothing about captions it could not read', !((await win.locator('[data-testid=video-captions]').textContent()) ?? '').includes('No captions'))
      t.check('the keyboard does nothing to a page that is not there', await (async () => {
        await win.evaluate(() => document.querySelector('[data-testid=video-player]').focus())
        await win.keyboard.press('ArrowRight')
        await win.waitForTimeout(150)
        return near(await timeNow(win), 0, 0.001)
      })())
      await shot(t, '63-video-did-not-load')
      await win.click('[data-testid=video-stage-activity]')
      t.check('See what happened opens the Activity tab', (await win.getAttribute('[data-testid=video-tabpanel]', 'data-tab')) === 'activity')
    } finally {
      writeFileSync(file, good)
    }
    // The good page is back: the player works again after another round trip.
    await win.click(`[data-testid=video-row-${ids.tall}]`)
    await win.waitForFunction(() => document.querySelector('[data-testid=video-aspect]')?.textContent === '9:16', null, { timeout: 8000 })
    await win.click(`[data-testid=video-row-${ids.wide}]`)
    await win.waitForSelector('[data-testid=video-player][data-phase=ready]', { timeout: 30000 })
    t.check('with the page put back the player comes back too', await win.locator('[data-testid=video-play]').isEnabled())
    await win.click('[data-testid=video-tab-plan]')
  })

  await t.step('Labs switches toggle', async () => {
    await win.keyboard.press('Escape')
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-labs]')
    const sw = win.locator('[data-testid=labs-video]')
    await sw.waitFor({ timeout: 8000 })
    const on = await sw.getAttribute('aria-checked')
    t.check('Video starts on for this run', on === 'true', String(on))
    await sw.click()
    await win.waitForFunction(() => document.querySelector('[data-testid=labs-video]')?.getAttribute('aria-checked') === 'false', null, { timeout: 8000 })
    t.check('the Video switch turns off', true)
    await sw.click()
    await win.waitForFunction(() => document.querySelector('[data-testid=labs-video]')?.getAttribute('aria-checked') === 'true', null, { timeout: 8000 })
    t.check('and back on', true)
    t.check('Board is a working switch, not Coming soon', (await win.locator('[data-testid=labs-board-soon]').count()) === 0 && (await win.locator('[data-testid=labs-board]').count()) === 1)
    t.check('Dictate anywhere is a working switch, not Coming soon', (await win.locator('[data-testid=labs-anywhere-soon]').count()) === 0 && (await win.locator('[data-testid=labs-anywhere]').count()) === 1)
    await win.waitForTimeout(250)
    await shot(t, '70-labs')
  })

  await win.keyboard.press('Escape')
  await win.waitForTimeout(200)

  // The app is asked to quit, and a run must never wait for ever on one that does not (a launch once stayed up after
  // its test was over, in a probe run on 2026-10-15). After 30 seconds it is stopped, and that is a failed check.
  const pid = t.app.process().pid
  let stuck = false
  const guard = setTimeout(() => {
    stuck = true
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // It went away by itself in the meantime.
    }
  }, 30000)
  const results = await t.close()
  clearTimeout(guard)
  t.check('the app quits when asked to', !stuck)
  return results
}
