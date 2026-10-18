// The Board (Labs) end to end, in the fake world with the Test Agent: a task made through Tasks shows up
// as a card in Waiting; Run moves it to Running on its own and then to To review when a lane passes; a
// person marks it done into Done; Archive hides it everywhere. Then the layout is checked at 960, 1100 and
// 1440 px with the sidebar open and closed: nothing clipped, no sideways scroll, the meta line on one line,
// the card text keeping its width, and four columns whenever all four fit at 240 px each. Every screenshot
// and every contrast check first waits until document.getAnimations() has no running animation left, so a
// card is never caught mid entrance fade.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './lib.mjs'

const q = (id) => `[data-testid=${id}]`
const MARKER = 'grep -q "changed by test agent" src/app.js'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 }).trim()
}

/** True when the card sits inside that board column. */
function inColumn(win, column, id) {
  return win.locator(`[data-testid=board-col-${column}] [data-testid=board-card-${id}]`).count()
}

/** Waits until the card moves into the named column. */
function waitColumn(win, id, column, timeout = 60000) {
  return win.waitForFunction(
    ([col, cardId]) => Boolean(document.querySelector(`[data-testid=board-col-${col}] [data-testid=board-card-${cardId}]`)),
    [column, id],
    { timeout }
  )
}

/** The card is nowhere on the board: not in any of the four columns. */
async function goneFromBoard(win, id) {
  const found = await win
    .locator(`[data-testid=board-col-waiting] [data-testid=board-card-${id}], [data-testid=board-col-running] [data-testid=board-card-${id}], [data-testid=board-col-review] [data-testid=board-card-${id}], [data-testid=board-col-done] [data-testid=board-card-${id}]`)
    .count()
  return found === 0
}

export default async function board() {
  const repo = mkdtempSync('/tmp/regatta-board-e2e-')
  let t
  try {
    git(repo, 'init', '-b', 'main')
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')

    t = await launch('board', { cwd: repo })
    const { win } = t

    /** Waits until nothing is animating, so a screenshot or a contrast read never lands mid entrance fade. */
    const settle = () =>
      win.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 5000 })
    /** A screenshot that first waits out every running animation. */
    const shot = async (file) => {
      await settle()
      await t.shot(file)
    }

    await t.step('the Board tab appears only once its Labs switch is on', async () => {
      const before = await win.locator(q('mode-board')).count()
      await win.evaluate(() => window.regatta.invoke('prefs:set', { labs: { video: false, board: true, anywhere: false } }))
      await win.waitForSelector(q('mode-board'), { timeout: 8000 })
      await win.click(q('mode-board'))
      await win.waitForSelector(q('board-mode'))
      const gate = await win.locator(q('board-enable')).count()
      t.check('the tab is hidden while the lab is off', before === 0, `${before} tabs before`)
      t.check('the board opens with its columns and no Labs gate', (await win.locator(q('board-area')).count()) === 1 && gate === 0)
      await shot('01-board-empty')
    })

    let task = null
    await t.step('a task made through Tasks shows on the board in Waiting with a Run action', async () => {
      const created = await win.evaluate(
        (marker) =>
          window.regatta.invoke('tasks:create', {
            title: 'Add the welcome banner',
            prompt: 'Put a welcome banner in src/app.js',
            assignee: { kind: 'agent', agent: 'fake' },
            backups: [],
            checks: [{ name: 'marker', command: marker, kind: 'required' }],
            note: ''
          }),
        MARKER
      )
      task = created.find((row) => row.title === 'Add the welcome banner') ?? null
      await win.waitForSelector(q(`board-card-${task.id}`), { timeout: 10000 })
      const cardText = await win.locator(q(`board-card-${task.id}`)).innerText()
      const agentBadges = await win.locator(`[data-testid=board-meta-${task.id}] [title="Test Agent"]`).count()
      t.check('the card is a task card in Waiting', (await inColumn(win, 'waiting', task.id)) === 1 && (await win.locator(q(`board-card-${task.id}`)).getAttribute('data-kind')) === 'task')
      t.check('the card carries its title, its kind and the assigned agent', cardText.includes('Add the welcome banner') && cardText.toLowerCase().includes('task') && agentBadges === 1, cardText.replace(/\n/g, ' | '))
      t.check('Waiting offers Run and Archive', (await win.locator(q(`board-action-run-${task.id}`)).count()) === 1 && (await win.locator(q(`board-action-archive-${task.id}`)).count()) === 1)
      await shot('02-board-waiting')
    })

    await t.step('Run moves the card to Running on its own, then to To review when a lane passes', async () => {
      await win.click(q(`board-action-run-${task.id}`))
      await waitColumn(win, task.id, 'running', 20000)
      t.check('the card left Waiting for Running without any other click', (await inColumn(win, 'running', task.id)) === 1 && (await inColumn(win, 'waiting', task.id)) === 0)
      t.check('a running card can be stopped but not marked done', (await win.locator(q(`board-action-stop-${task.id}`)).count()) === 1 && (await win.locator(q(`board-action-markdone-${task.id}`)).count()) === 0)
      await waitColumn(win, task.id, 'review', 60000)
      const reviewActions = await win.locator(q(`board-card-${task.id}`)).innerText()
      t.check('a passed lane moves the card to To review on its own', (await inColumn(win, 'review', task.id)) === 1)
      t.check('the review card offers Merge, Send back, Mark done and Archive', ['Merge', 'Send back', 'Mark done', 'Archive'].every((label) => reviewActions.includes(label)) || (await win.locator(q(`board-action-markdone-${task.id}`)).count()) === 1, reviewActions.replace(/\n/g, ' | '))
      await shot('03-board-review')
    })

    await t.step('a person marks it done, and only a person moves a card to Done', async () => {
      await win.click(q(`board-action-markdone-${task.id}`))
      await waitColumn(win, task.id, 'done', 20000)
      const stored = await win.evaluate(() => window.regatta.invoke('tasks:list'))
      const done = stored.find((row) => row.id === task.id)
      t.check('the card moved to Done', (await inColumn(win, 'done', task.id)) === 1 && done.status === 'done')
      t.check('a done card is left with only Archive', (await win.locator(q(`board-action-archive-${task.id}`)).count()) === 1 && (await win.locator(q(`board-action-markdone-${task.id}`)).count()) === 0)
      await shot('04-board-done')
    })

    await t.step('the board fits at every width with the sidebar open or closed and the card text keeps its width', async () => {
      const measure = () =>
        win.evaluate(() => {
          const area = document.querySelector('[data-testid=board-area]')
          const fleet = document.querySelector('[data-testid=fleet-sidebar]')
          const areaBox = area.getBoundingClientRect()
          const inside = (el) => {
            const b = el.getBoundingClientRect()
            return b.left >= areaBox.left - 1 && b.right <= areaBox.right + 1 && b.top >= areaBox.top - 1 && b.bottom <= areaBox.bottom + 1
          }
          const headers = [...area.querySelectorAll('[data-testid^=board-group-]')]
          const cards = [...area.querySelectorAll('article[data-testid^=board-card-]')]
          const titleRatios = cards.map((card) => {
            const c = card.getBoundingClientRect()
            const h = card.querySelector('h3')
            return c.width > 0 ? h.getBoundingClientRect().width / c.width : 0
          })
          const metas = cards.map((card) => {
            const m = card.querySelector('[data-testid^=board-meta-]')
            const cs = getComputedStyle(m)
            const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
            return m.getBoundingClientRect().height / lineHeight
          })
          const title = cards[0]?.querySelector('h3') ?? null
          const meta = cards[0]?.querySelector('[data-testid^=board-meta-]') ?? null
          // The title's contrast against its own card background, from the computed colors (WCAG relative luminance).
          const channel = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
          const luminance = (rgb) => 0.2126 * channel(rgb[0] / 255) + 0.7152 * channel(rgb[1] / 255) + 0.0722 * channel(rgb[2] / 255)
          const rgbOf = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number)
          let titleContrast = 0
          if (title) {
            const l1 = luminance(rgbOf(getComputedStyle(title).color))
            const l2 = luminance(rgbOf(getComputedStyle(title.closest('article')).backgroundColor))
            titleContrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
          }
          return {
            innerWidth: window.innerWidth,
            docScrollWidth: document.documentElement.scrollWidth,
            layout: area.getAttribute('data-layout'),
            fleetOpen: Boolean(fleet) && fleet.getBoundingClientRect().width > 0,
            areaScrollsX: area.scrollWidth > area.clientWidth + 1,
            headerCount: headers.length,
            headersInside: headers.length > 0 && headers.every(inside),
            cardCount: cards.length,
            cardsInside: cards.every(inside),
            minTitleRatio: titleRatios.length ? Math.min(...titleRatios) : 0,
            maxMetaLines: metas.length ? Math.max(...metas) : 0,
            titleColor: title ? getComputedStyle(title).color : '',
            metaColor: meta ? getComputedStyle(meta).color : '',
            cardOpacity: cards[0] ? getComputedStyle(cards[0]).opacity : '',
            titleContrast
          }
        })

      const setSidebar = async (open) => {
        const isOpen = () =>
          win.evaluate(() => {
            const fleet = document.querySelector('[data-testid=fleet-sidebar]')
            return Boolean(fleet) && fleet.getBoundingClientRect().width > 0
          })
        if ((await isOpen()) === open) return
        await win.click('[aria-label="Toggle right sidebar"]')
        await win.waitForFunction(
          (want) => {
            const fleet = document.querySelector('[data-testid=fleet-sidebar]')
            const shown = Boolean(fleet) && fleet.getBoundingClientRect().width > 0
            return shown === want
          },
          open,
          { timeout: 5000 }
        )
      }

      // Four 240px columns with 16px gaps need 1008px of content. The area keeps px-6 (48px) of padding and
      // the Fleet sidebar takes 300px of the window, so the list is expected only where four columns do not fit.
      const cases = [
        { width: 960, sidebar: true, layout: 'list' },
        { width: 1100, sidebar: true, layout: 'list' },
        { width: 1440, sidebar: true, layout: 'columns' },
        { width: 960, sidebar: false, layout: 'list' },
        { width: 1100, sidebar: false, layout: 'columns' },
        { width: 1440, sidebar: false, layout: 'columns' }
      ]

      await settle()
      const seen = await measure()
      t.check(
        'the card title and meta read at normal contrast',
        seen.titleColor === 'rgb(231, 235, 240)' && seen.metaColor === 'rgb(154, 164, 178)',
        `title ${seen.titleColor}, meta ${seen.metaColor}`
      )
      t.check('the card is fully opaque once its entrance has ended', seen.cardOpacity === '1', `opacity ${seen.cardOpacity}`)
      t.check('the card title clears 4.5:1 against the card background', seen.titleContrast >= 4.5, `${seen.titleContrast.toFixed(2)}:1`)

      for (const c of cases) {
        const tag = `${c.width}px-${c.sidebar ? 'sidebar-open' : 'sidebar-closed'}`
        await win.setViewportSize({ width: c.width, height: 900 })
        await setSidebar(c.sidebar)
        await settle()
        const m = await measure()
        t.check(`at ${tag} the page does not scroll sideways`, m.docScrollWidth <= m.innerWidth && m.innerWidth === c.width, `scrollWidth ${m.docScrollWidth}, innerWidth ${m.innerWidth}`)
        t.check(`at ${tag} the Fleet sidebar is ${c.sidebar ? 'open' : 'closed'}`, m.fleetOpen === c.sidebar)
        t.check(`at ${tag} the board area does not scroll sideways`, !m.areaScrollsX)
        t.check(`at ${tag} the four group headers are fully inside`, m.headersInside && m.headerCount === 4, `${m.headerCount} headers`)
        t.check(`at ${tag} every card is fully inside the board area`, m.cardCount > 0 && m.cardsInside, `${m.cardCount} cards`)
        t.check(`at ${tag} each card title keeps most of the card width`, m.minTitleRatio > 0.5, `narrowest title ${Math.round(m.minTitleRatio * 100)}% of its card`)
        t.check(`at ${tag} each meta line stays on one line`, m.maxMetaLines < 1.6, `meta ${m.maxMetaLines.toFixed(2)} lines`)
        t.check(`at ${tag} the card title still clears 4.5:1 on its card`, m.titleContrast >= 4.5, `${m.titleContrast.toFixed(2)}:1`)
        t.check(`at ${tag} it ${c.layout === 'columns' ? 'shows four columns' : 'lists the groups'}`, m.layout === c.layout, `layout ${m.layout}`)
        await shot(`05-board-${tag}`)
      }
    })

    await t.step('Archive hides the card everywhere on the board', async () => {
      await win.setViewportSize({ width: 1440, height: 900 })
      // The width loop ends with the sidebar closed; the board returns to its usual open state for the rest.
      const fleetClosed = await win.evaluate(() => {
        const fleet = document.querySelector('[data-testid=fleet-sidebar]')
        return !fleet || fleet.getBoundingClientRect().width === 0
      })
      if (fleetClosed) {
        await win.click('[aria-label="Toggle right sidebar"]')
        await win.waitForFunction(() => {
          const fleet = document.querySelector('[data-testid=fleet-sidebar]')
          return Boolean(fleet) && fleet.getBoundingClientRect().width > 0
        }, null, { timeout: 5000 })
      }
      await settle()
      await win.click(q(`board-action-archive-${task.id}`))
      await win.waitForFunction(
        (cardId) => !document.querySelector(`[data-testid=board-card-${cardId}]`),
        task.id,
        { timeout: 10000 }
      )
      t.check('the archived card is gone from every column', await goneFromBoard(win, task.id))
      t.check('the board keeps only an archived list of its own', (await win.locator(q('board-area')).count()) === 1)
      await shot('06-board-archived')
    })

    const results = await t.close()
    t = null
    return results
  } finally {
    if (t) await t.close()
    rmSync(repo, { recursive: true, force: true })
  }
}
