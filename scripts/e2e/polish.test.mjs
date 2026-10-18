// Polish end to end: the title bar at 960, 1100 and 1440 px wide (nothing overlaps, nothing is cut off,
// the mode tabs give up their words before anything else does), and the notes of a night report, where a
// note naming two git commands shows a code chip with a copy button of its own for each of them.
// Screenshots go to /tmp/regatta-e2e/polish/.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

const q = (id) => `[data-testid=${id}]`
const RUNS = '[data-testid=night-runs] > button'
/** The widths the title bar has to stay whole at: the window's minimum, the one it overlapped at, and a wide one. */
const WIDTHS = [960, 1100, 1440]

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** A throwaway repository on main with one commit. The test process already has the test git identity (lib.mjs). */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-polish-e2e-'))
  git(['init', '-b', 'main'], dir)
  writeFileSync(join(dir, 'README.md'), '# polish e2e\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'first commit'], dir)
  return dir
}

/** Waits until a button exists and is on. A bare `!el?.disabled` is true when the element is missing, so it is not used. */
function buttonOn(win, id, timeout = 8000) {
  return win.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel)
      return Boolean(el) && !el.disabled
    },
    q(id),
    { timeout }
  )
}

/** Sets the window size and waits for the renderer to lay out at that width. */
async function setWidth(t, width) {
  await t.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 900), width)
  await t.win.waitForFunction((w) => Math.abs(window.innerWidth - w) <= 4, width, { timeout: 8000 })
}

/** The title bar and every button in it, as the window lays them out. */
function barRects(win) {
  return win.evaluate(() => {
    const bar = document.querySelector('[data-testid=title-bar]')
    const box = bar.getBoundingClientRect()
    const of = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })
    return {
      bar: of(box),
      inner: { width: window.innerWidth, height: window.innerHeight },
      buttons: [...bar.querySelectorAll('button')].map((el) => ({
        name: el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? 'button',
        ...of(el.getBoundingClientRect())
      }))
    }
  })
}

/** Pairs of buttons that share more than a hair of the same space. */
function overlaps(buttons) {
  const found = []
  for (let i = 0; i < buttons.length; i++) {
    for (let j = i + 1; j < buttons.length; j++) {
      const a = buttons[i]
      const b = buttons[j]
      const wide = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const tall = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (wide > 0.5 && tall > 0.5) found.push(`${a.name} over ${b.name} by ${wide.toFixed(1)} x ${tall.toFixed(1)}`)
    }
  }
  return found
}

/** Buttons that are not whole and inside the bar, and a bar that is not inside the window: something is cut off. */
function cutOff(rects) {
  const { bar, inner, buttons } = rects
  const found = []
  if (bar.left < -0.5 || bar.right > inner.width + 0.5) found.push(`the bar itself runs ${bar.left} to ${bar.right} in a window ${inner.width} wide`)
  for (const b of buttons) {
    if (b.width <= 0 || b.height <= 0) found.push(`${b.name} is not laid out`)
    else if (b.left < bar.left - 0.5 || b.right > bar.right + 0.5 || b.top < bar.top - 0.5 || b.bottom > bar.bottom + 0.5) {
      found.push(`${b.name} at ${b.left} to ${b.right}, ${b.top} to ${b.bottom}`)
    }
  }
  return found
}

export default async function polish() {
  const repoDir = makeRepo()
  let t
  let results = []

  try {
    // A short run for the Test Agent, so the night is over in a few seconds.
    t = await launch('polish', { cwd: repoDir, env: { REGATTA_FAKE_DELAY_MS: '2000' } })
    const { win } = t
    const shot = async (name) => {
      await win.waitForFunction(
        () => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
        undefined,
        { timeout: 10000 }
      )
      await t.shot(name)
    }

    await t.step('the title bar keeps every control whole from the minimum window width up', async () => {
      const mac = (await win.evaluate(() => window.regatta.platform)) === 'darwin'
      const tabs = '[data-testid=title-bar] [data-testid^=mode-]'
      t.check('all five mode tabs are in the bar', (await win.locator(tabs).count()) === 5)

      for (const width of WIDTHS) {
        await setWidth(t, width)
        const rects = await barRects(win)
        const over = overlaps(rects.buttons)
        const cut = cutOff(rects)
        t.check(`at ${width} px no two title bar buttons overlap`, over.length === 0, over.join(' | '))
        t.check(`at ${width} px every title bar button is whole and inside the bar`, cut.length === 0, cut.join(' | '))
        t.check(`at ${width} px the Skipper button is on screen`, rects.buttons.some((b) => b.name === 'skipper-button' && b.width > 0), rects.buttons.map((b) => b.name).join(','))
        if (mac) t.check(`at ${width} px the first control still clears the traffic lights`, rects.buttons[0].left >= 84, String(rects.buttons[0].left))
        // The tabs are the first thing to give way: icons only while the window is narrow, words once it is wide.
        const words = (await win.locator(tabs).allInnerTexts()).join(',')
        if (width === 1440) t.check('at 1440 px the mode tabs say their names', words === 'Agents,Code,Chat,Flows,Video', words)
        else t.check(`at ${width} px the mode tabs keep their icons and drop their words`, words === ',,,,', words)
        await shot(`01-title-bar-${width}`)
      }
      await setWidth(t, 1440)
    })

    await t.step('a note that names two git commands offers a copy button for each', async () => {
      await win.click(q('night-button'))
      await win.waitForSelector(q('night-form'), { timeout: 8000 })
      await win.locator(q('night-prompt')).fill('Create DONE.txt')
      await win.locator('[data-testid=night-agent][data-agent=fake]').click()
      await win.locator(q('night-check-custom')).fill('test -f DONE.txt')
      await buttonOn(win, 'night-add')
      await win.click(q('night-add'))
      await win.waitForFunction(() => document.querySelectorAll('[data-testid^=night-task-]').length === 1, undefined, { timeout: 10000 })
      await win.click(q('night-start-now'))
      await win.waitForSelector(`${q('night-report')}[data-status=running]`, { timeout: 20000 })
      const nightId = (await win.locator(q('night-report')).getAttribute('data-night')) ?? ''
      await win.waitForFunction(() => document.querySelector('[data-testid=night-report]')?.getAttribute('data-status') === 'finished', undefined, { timeout: 180000 })
      t.check('the night ran its one task and is over', nightId.length > 0, nightId)

      // Discarding it keeps a copy of its commits, and the note says where and how to get them back.
      await win.locator(RUNS).first().click()
      await win.waitForSelector(`${q('night-card')}[data-status=ready]`, { timeout: 15000 })
      await win.click(q('night-discard'))
      await win.waitForSelector(q('night-discard-ask'), { timeout: 8000 })
      await win.click(q('night-discard-confirm'))
      await win.waitForSelector(`${q('night-card')}[data-status=discarded]`, { timeout: 60000 })

      // The engine's own note, straight from the state: the two commands in it are what the note has to offer.
      const run = await win.evaluate(async (id) => {
        const state = await window.regatta.invoke('night:state')
        return state.nights.find((n) => n.id === id).runs[0]
      }, nightId)
      const ref = /refs\/regatta\/discarded\/\S+/.exec(run.note)?.[0] ?? ''
      const branch = /git branch (\S+) /.exec(run.note)?.[1] ?? ''
      t.check('the note names a kept copy and the branch that brings it back', ref.length > 0 && branch.length > 0, run.note)

      const note = win.locator(q('night-note')).filter({ hasText: `Kept a copy of the run's work at ${ref}` })
      await note.first().waitFor({ timeout: 10000 })
      const chips = note.first().locator(q('copy-command'))
      const shown = await note.first().locator(q('note-command')).allInnerTexts()
      t.check('the note shows two code chips, each with its own copy button', (await chips.count()) === 2 && shown.length === 2, shown.join(' | '))
      t.check('the first chip is the command that restores the work', shown[0] === `git branch ${branch} ${ref}^1`, shown[0])
      t.check('the second chip is the command that lists what was kept', shown[1] === `git log ${ref}`, shown[1])
      const words = await note.first().innerText()
      t.check('the words around the commands are still plain text', words.includes("Kept a copy of the run's work at") && words.includes('shows everything kept'), words.replace(/\n/g, ' '))
      await shot('02-note-chips')

      // A stand-in for the clipboard: the test sees what the window asks to be copied and never touches the real one.
      await win.evaluate(() => {
        window.__copied = []
        navigator.clipboard.writeText = (text) => {
          window.__copied.push(text)
          return Promise.resolve()
        }
      })
      await chips.nth(1).click()
      await win.waitForFunction(() => window.__copied.length === 1, undefined, { timeout: 5000 })
      const copied = await win.evaluate(() => window.__copied)
      t.check('the second copy button copies the second command and nothing else', copied.length === 1 && copied[0] === `git log ${ref}`, copied.join(' | '))
      await chips.nth(0).click()
      await win.waitForFunction(() => window.__copied.length === 2, undefined, { timeout: 5000 })
      const both = await win.evaluate(() => window.__copied)
      t.check('the first copy button copies the first command and nothing else', both[1] === `git branch ${branch} ${ref}^1`, both.join(' | '))
    })
  } finally {
    if (t) results = await t.close()
    rmSync(repoDir, { recursive: true, force: true })
  }
  return results
}
