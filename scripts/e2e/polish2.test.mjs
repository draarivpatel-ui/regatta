// Code mode toolbar at narrow window widths. From the 960 px minimum up, no control in the row under
// the title bar may overlap a neighbour or run past the row's edge: the side panel tabs give up their
// words first (staying nameable by tooltip and aria-label), then the gaps tighten. Screenshots go to
// /tmp/regatta-e2e/polish2/.

import { launch } from './lib.mjs'

const q = (id) => `[data-testid=${id}]`
const WIDTHS = [960, 1100, 1440]
const TABS = ['files', 'find', 'git', 'browser', 'thread', 'flows', 'simulator']

/** Sets the window size and waits for the renderer to lay out at that width. */
async function setWidth(t, width) {
  await t.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 900), width)
  await t.win.waitForFunction((w) => Math.abs(window.innerWidth - w) <= 4, width, { timeout: 8000 })
}

/** The toolbar row and every button in it, as the window lays them out. */
function barRects(win) {
  return win.evaluate(() => {
    const bar = document.querySelector('[data-testid=code-toolbar]')
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

/** A button not whole and inside the row, or a row not inside the window: something is cut off. */
function cutOff(rects) {
  const { bar, inner, buttons } = rects
  const found = []
  if (bar.left < -0.5 || bar.right > inner.width + 0.5) found.push(`the row runs ${bar.left} to ${bar.right} in a window ${inner.width} wide`)
  for (const b of buttons) {
    if (b.width <= 0 || b.height <= 0) found.push(`${b.name} is not laid out`)
    else if (b.right > bar.right + 0.5 || b.left < bar.left - 0.5 || b.top < bar.top - 0.5 || b.bottom > bar.bottom + 0.5) {
      found.push(`${b.name} at ${b.left.toFixed(1)} to ${b.right.toFixed(1)} in a row to ${bar.right.toFixed(1)}`)
    }
  }
  return found
}

/** Sets the window size and waits for the renderer to lay out at that size. */
async function setSize(t, width, height) {
  await t.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height])
  await t.win.waitForFunction(
    ([w, h]) => Math.abs(window.innerWidth - w) <= 4 && Math.abs(window.innerHeight - h) <= 4,
    [width, height],
    { timeout: 8000 }
  )
}

/** The fleet sidebar and its empty state text, as the window lays them out. */
function fleetRects(win) {
  return win.evaluate(() => {
    const of = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })
    const side = document.querySelector('[data-testid=fleet-sidebar]')
    const empty = document.querySelector('[data-testid=fleet-empty]')
    return {
      inner: window.innerWidth,
      side: side ? of(side.getBoundingClientRect()) : null,
      empty: empty ? of(empty.getBoundingClientRect()) : null
    }
  })
}

/** The launch card and the status strip, as the window lays them out, plus which element sits on the strip. */
function emptyRects(win) {
  return win.evaluate(() => {
    const of = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })
    const strip = document.querySelector('[data-testid=status-strip]')
    const card = document.querySelector('[data-testid=empty-card]')
    const area = document.querySelector('[data-testid=empty-area]')
    let hit = null
    if (strip) {
      const s = strip.getBoundingClientRect()
      hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2)
    }
    return {
      strip: strip ? of(strip.getBoundingClientRect()) : null,
      card: card ? of(card.getBoundingClientRect()) : null,
      area: area ? of(area.getBoundingClientRect()) : null,
      hitOnStrip: strip ? strip.contains(hit) : null
    }
  })
}

export default async function polish2() {
  const t = await launch('polish2')
  const { win } = t

  try {
    await t.step('the code mode toolbar row is present with all its controls', async () => {
      await win.waitForSelector(q('code-toolbar'), { timeout: 8000 })
      const tabs = await win.locator(`[data-testid^=panel-]`).count()
      t.check('all seven side panel tabs are in the row', tabs === 7, `${tabs} tabs`)
      t.check('the New pane button is in the row', (await win.locator(q('new-pane-button')).count()) === 1)
    })

    await t.step('no control overlaps or runs past the row, from the minimum width up', async () => {
      for (const width of WIDTHS) {
        await setWidth(t, width)
        const rects = await barRects(win)
        const over = overlaps(rects.buttons)
        const cut = cutOff(rects)
        t.check(`at ${width} px no two toolbar controls overlap`, over.length === 0, over.join(' | '))
        t.check(`at ${width} px every toolbar control is whole and inside the row`, cut.length === 0, cut.join(' | '))
        t.check(
          `at ${width} px the New pane button is on screen`,
          rects.buttons.some((b) => b.name === 'new-pane-button' && b.width > 0 && b.right <= rects.bar.right + 0.5),
          rects.buttons.map((b) => `${b.name}:${b.right.toFixed(0)}`).join(',')
        )
        // The tabs are the first thing to give way: words only once the row is wide enough for them.
        const words = (await win.locator(`[data-testid^=panel-]`).allInnerTexts()).map((w) => w.trim())
        const named = words.filter((w) => w.length > 0)
        if (width === 1440) {
          t.check(`at ${width} px the panel tabs say their names`, named.length === 7, named.join(','))
        } else {
          t.check(`at ${width} px the panel tabs keep their icons and drop their words`, named.length === 0, named.join(','))
          // Icon-only tabs must still be nameable, by a tooltip and an accessible label.
          const labelable = await win.evaluate(
            (ids) => ids.every((id) => {
              const el = document.querySelector(`[data-testid=${id}]`)
              return Boolean(el) && Boolean(el.getAttribute('aria-label')) && Boolean(el.getAttribute('title'))
            }),
            TABS.map((id) => `panel-${id}`)
          )
          t.check(`at ${width} px every icon-only tab has a tooltip and an aria-label`, labelable)
        }
        await win.waitForFunction(
          () => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
          undefined,
          { timeout: 10000 }
        )
        await t.shot(`toolbar-${width}`)
      }
    })

    // at the 960 px minimum width the right sidebar has to stay inside the window, with
    // the empty state text whole, and at 1100 and 1440 px keep its old full width.
    await t.step('the fleet sidebar stays inside the window, from the minimum width up', async () => {
      for (const width of WIDTHS) {
        await setSize(t, width, 700)
        const r = await fleetRects(win)
        t.check(
          `at ${width} px the fleet sidebar is whole and inside the window`,
          Boolean(r.side) && r.side.left >= -0.5 && r.side.right <= r.inner + 0.5,
          r.side ? `left ${r.side.left.toFixed(1)} to right ${r.side.right.toFixed(1)} in a window ${r.inner} wide` : 'no sidebar'
        )
        const inside =
          Boolean(r.side && r.empty) &&
          r.empty.left >= r.side.left - 0.5 &&
          r.empty.right <= r.side.right + 0.5 &&
          r.empty.top >= r.side.top - 0.5 &&
          r.empty.bottom <= r.side.bottom + 0.5
        t.check(
          `at ${width} px the empty state text sits fully inside the sidebar`,
          inside,
          r.side && r.empty ? `text ${r.empty.left.toFixed(1)} to ${r.empty.right.toFixed(1)}, sidebar ${r.side.left.toFixed(1)} to ${r.side.right.toFixed(1)}` : 'no empty state'
        )
        if (width > 960) {
          t.check(`at ${width} px the sidebar keeps its full 300 px width`, r.side && Math.abs(r.side.width - 300) <= 1, r.side ? `width ${r.side.width.toFixed(1)}` : 'no sidebar')
        }
        await win.waitForFunction(
          () => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
          undefined,
          { timeout: 10000 }
        )
        await t.shot(`fleet-${width}`)
      }
    })

    // with no panes, the launch card never covers the status strip above it
    // ("No agents running" and the memory readout), centered when it fits and starting at the top of
    // its area when it does not. Screenshots empty-<width>.png.
    await t.step('the launch card never covers the status line, from the minimum width up', async () => {
      for (const width of WIDTHS) {
        await setSize(t, width, 700)
        const r = await emptyRects(win)
        t.check(
          `at ${width} px the launch card is present below the status strip`,
          Boolean(r.strip && r.card) && r.card.top >= r.strip.bottom - 0.5,
          r.strip && r.card ? `strip ends ${r.strip.bottom.toFixed(1)}, card starts ${r.card.top.toFixed(1)}` : 'no card or no strip'
        )
        t.check(
          `at ${width} px nothing sits on the status strip`,
          r.hitOnStrip === true,
          r.hitOnStrip === true ? 'the strip and its text answer alone' : `another element sits on the strip at ${width} px`
        )
        // When the card fits, it is centered in the area below the strip (both carry 32 px of padding).
        if (r.card && r.area && r.card.height <= r.area.height - 64 + 0.5) {
          const slack = r.area.height - 64 - r.card.height
          const want = r.area.top + 32 + slack / 2
          t.check(
            `at ${width} px the card sits centered when it fits`,
            Math.abs(r.card.top - want) <= 1.5,
            `card top ${r.card.top.toFixed(1)}, centered would be ${want.toFixed(1)}`
          )
        }
        await win.waitForFunction(
          () => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
          undefined,
          { timeout: 10000 }
        )
        await t.shot(`empty-${width}`)
      }
    })

    // the mode wrapper carries min-w-0, so a mode's content can never be wider than
    // the window, at the 960 px minimum as at any other width.
    await t.step('the mode wrapper stays at or inside the window, at the minimum width', async () => {
      await setSize(t, 960, 700)
      const r = await win.evaluate(() => {
        const el = document.querySelector('main')?.children[0]
        if (!(el instanceof HTMLElement)) return null
        return { right: el.getBoundingClientRect().right, inner: window.innerWidth }
      })
      t.check(
        'at 960 x 700 the mode wrapper is at or inside the window right edge',
        Boolean(r) && r.right <= r.inner + 0.5,
        r ? `right ${r.right.toFixed(1)} in a window ${r.inner} wide` : 'no mode wrapper'
      )
      await win.waitForFunction(
        () => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
        undefined,
        { timeout: 10000 }
      )
      await t.shot('tidy-960')
    })

    // when the row itself is too narrow for every label, Dictate and
    // Broadcast give up their words (their names stay reachable by aria-label and tooltip) and
    // elsewhere they keep them.
    await t.step('Dictate and Broadcast are icon only when the row is too narrow for their labels', async () => {
      await setSize(t, 960, 700)
      const narrow = await win.evaluate(() => {
        const of = (id) => {
          const el = document.querySelector(`[data-testid=${id}]`)
          return el ? { text: el.innerText.trim(), aria: el.getAttribute('aria-label'), title: el.getAttribute('title') } : null
        }
        return { dictate: of('dictate-button'), broadcast: of('broadcast-button') }
      })
      t.check(
        'at 960 px Dictate and Broadcast are icon only',
        Boolean(narrow.dictate && narrow.broadcast) && narrow.dictate.text === '' && narrow.broadcast.text === '',
        narrow.dictate && narrow.broadcast ? `labels: "${narrow.dictate.text}" "${narrow.broadcast.text}"` : 'a button is missing'
      )
      t.check(
        'at 960 px their names stay as aria-label and title',
        Boolean(narrow.dictate && narrow.broadcast) && narrow.dictate.aria === 'Dictate' && narrow.broadcast.aria === 'Broadcast' &&
          Boolean(narrow.dictate.title) && Boolean(narrow.broadcast.title),
        narrow.dictate && narrow.broadcast ? `aria: "${narrow.dictate.aria}", "${narrow.broadcast.aria}"` : 'a button is missing'
      )
      await setSize(t, 1440, 700)
      const wide = await win.evaluate(() => {
        const of = (id) => document.querySelector(`[data-testid=${id}]`)?.innerText.trim() ?? ''
        return { dictate: of('dictate-button'), broadcast: of('broadcast-button') }
      })
      t.check(
        'at 1440 px Dictate and Broadcast show their labels',
        wide.dictate.includes('Dictate') && wide.broadcast.includes('Broadcast'),
        `labels: "${wide.dictate}" "${wide.broadcast}"`
      )
      await win.waitForFunction(
        () => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
        undefined,
        { timeout: 10000 }
      )
      await t.shot('dictate-widths')
    })
  } finally {
    return t.close()
  }
}
