// Tasks end to end, in the fake world with the Test Agent: a task is written in the form, run as a hand-off,
// comes back for review, is opened in Skipper and merged, and reads as done. Then a task marked done without
// merging, and a task added to tonight's night watch.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './lib.mjs'

const q = (id) => `[data-testid=${id}]`
const MARKER = 'grep -q "changed by test agent" src/app.js'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 }).trim()
}

/** All the tasks main holds, newest first. */
function tasksOf(win) {
  return win.evaluate(() => window.regatta.invoke('tasks:list'))
}

function statusRow(win, id) {
  return win.locator(q(`task-${id}`))
}

function waitTaskStatus(win, id, status, timeout = 60000) {
  return win.waitForFunction(
    ([sel, want]) => document.querySelector(sel)?.getAttribute('data-status') === want,
    [`[data-testid=task-${id}]`, status],
    { timeout }
  )
}

/** True when the task row sits inside that column. */
function inColumn(win, column, id) {
  return win.locator(`[data-testid=tasks-column-${column}] [data-testid=task-${id}]`).count()
}

export default async function tasks() {
  const repo = mkdtempSync('/tmp/regatta-tasks-e2e-')
  let t
  try {
    git(repo, 'init', '-b', 'main')
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'app.js'), 'export const app = 1\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')

    t = await launch('tasks', { cwd: repo })
    const { win } = t

    await t.step('Tasks opens under Agents > Automate', async () => {
      await win.click(q('mode-agents'))
      await win.click(q('automate-tasks'))
      await win.waitForSelector(q('tasks-view'))
      const empty = (await win.locator(q('tasks-view')).innerText()).includes('No tasks yet')
      const rows = await win.locator('[data-testid=tasks-view] article[data-testid^=task-]').count()
      t.check('the view opens with nothing tracked and a way to write the first task', empty && rows === 0 && (await win.locator(q('tasks-new')).isVisible()))
      await t.shot('01-tasks-empty')
    })

    let task = null
    await t.step('the form writes a task for the Test Agent', async () => {
      await win.click(q('tasks-new'))
      await win.waitForSelector(q('tasks-editor'))
      await win.locator(q('tasks-title')).fill('Add the welcome banner')
      await win.locator(q('tasks-prompt')).fill('Put a welcome banner in src/app.js')
      await win.locator(q('tasks-agent')).selectOption('fake')
      await win.locator(q('tasks-check-name')).first().fill('marker')
      await win.locator(q('tasks-check-command')).first().fill(MARKER)
      await win.locator('[data-testid=tasks-backup][data-agent=claude]').check()
      await win.click(q('tasks-save'))
      await win.waitForSelector(q('tasks-editor'), { state: 'detached' })
      const saved = (await tasksOf(win)).find((row) => row.title === 'Add the welcome banner')
      task = saved ?? null
      const row = saved ? statusRow(win, saved.id) : null
      const text = row ? await row.innerText() : ''
      t.check('the task is saved in To do, made here', Boolean(saved) && saved.status === 'todo' && saved.createdBy === 'you')
      t.check(
        'it keeps the lead, the backup and one named check',
        Boolean(saved) &&
          saved.assignee.kind === 'agent' &&
          saved.assignee.agent === 'fake' &&
          JSON.stringify(saved.backups) === JSON.stringify(['claude']) &&
          saved.checks.length === 1 &&
          saved.checks[0].name === 'marker' &&
          saved.heatId === null,
        saved ? JSON.stringify(saved.checks) : 'no task'
      )
      t.check('the row reads as the Test Agent with its backup', text.includes('Test Agent') && text.includes('To do') && text.includes('1 check'), text.replace(/\n/g, ' | '))
      t.check('it sits in the To do column', (await inColumn(win, 'todo', saved.id)) === 1)
      t.check('the tasks file holds it', existsSync(join(t.profile, 'tasks.json')) && readFileSync(join(t.profile, 'tasks.json'), 'utf8').includes('Add the welcome banner'))
      await t.shot('02-tasks-todo')
    })

    await t.step('Run starts a hand-off and the task follows its heat', async () => {
      await win.click(q(`task-run-${task.id}`))
      await waitTaskStatus(win, task.id, 'running', 20000)
      const running = (await tasksOf(win)).find((row) => row.id === task.id)
      const heats = await win.evaluate(() => window.regatta.invoke('heats:list'))
      const heat = heats.find((row) => row.id === running.heatId)
      t.check('a hand-off heat started with the lead then its backup', heat?.mode === 'handoff' && JSON.stringify(heat.lanes.map((lane) => lane.agent)) === JSON.stringify(['fake', 'claude']))
      t.check('the task reads as running and lost its Run button', (await inColumn(win, 'running', task.id)) === 1 && (await win.locator(q(`task-run-${task.id}`)).count()) === 0)
      t.check('its heat can be opened from the task', (await win.locator(q(`task-open-${task.id}`)).count()) === 1)
      await waitTaskStatus(win, task.id, 'review')
      const decided = (await tasksOf(win)).find((row) => row.id === task.id)
      t.check('the task waits in To review when a lane passed', decided.status === 'review' && (await inColumn(win, 'review', task.id)) === 1)
      t.check('the check the run passed was the one the form wrote', decided.checks[0].command === MARKER)
      await win.waitForTimeout(300)
      await t.shot('03-tasks-review')
    })

    await t.step('the board fits the Tasks area at every width and the card text keeps its width', async () => {
      const measure = () =>
        win.evaluate(() => {
          const bar = document.querySelector('[data-testid=title-bar]')
          const btn = document.querySelector('[data-testid=tasks-new]')
          const area = document.querySelector('[data-testid=tasks-area]')
          const fleet = document.querySelector('[data-testid=fleet-sidebar]')
          const areaBox = area.getBoundingClientRect()
          const inside = (el) => {
            const b = el.getBoundingClientRect()
            return b.left >= areaBox.left - 1 && b.right <= areaBox.right + 1 && b.top >= areaBox.top - 1 && b.bottom <= areaBox.bottom + 1
          }
          const headers = [...area.querySelectorAll('[data-testid^=tasks-group-]')]
          const cards = [...area.querySelectorAll('article[data-testid^=task-]')]
          const titleRatios = cards.map((card) => {
            const c = card.getBoundingClientRect()
            const h = card.querySelector('h3')
            return c.width > 0 ? h.getBoundingClientRect().width / c.width : 0
          })
          const metas = cards.map((card) => {
            const m = card.querySelector('[data-testid^=task-meta-]')
            const cs = getComputedStyle(m)
            const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
            return m.getBoundingClientRect().height / lineHeight
          })
          const title = cards[0]?.querySelector('h3') ?? null
          const meta = cards[0]?.querySelector('[data-testid^=task-meta-]') ?? null
          const btnBox = btn?.getBoundingClientRect() ?? null
          return {
            innerWidth: window.innerWidth,
            docScrollWidth: document.documentElement.scrollWidth,
            barLeft: bar ? bar.getBoundingClientRect().left : Number.NaN,
            btnRight: btnBox ? btnBox.right : Number.NaN,
            fleetOpen: Boolean(fleet) && fleet.getBoundingClientRect().width > 0,
            areaScrollsX: area.scrollWidth > area.clientWidth + 1,
            headerCount: headers.length,
            headersInside: headers.length > 0 && headers.every(inside),
            cardCount: cards.length,
            cardsInside: cards.every(inside),
            minTitleRatio: titleRatios.length ? Math.min(...titleRatios) : 0,
            maxMetaLines: metas.length ? Math.max(...metas) : 0,
            titleColor: title ? getComputedStyle(title).color : '',
            metaColor: meta ? getComputedStyle(meta).color : ''
          }
        })

      // A card's title uses the normal text token and its meta line the secondary token, so they read like other cards.
      const seen = await measure()
      t.check(
        'the card title and meta read at normal contrast',
        seen.titleColor === 'rgb(231, 235, 240)' && seen.metaColor === 'rgb(154, 164, 178)',
        `title ${seen.titleColor}, meta ${seen.metaColor}`
      )

      for (const width of [960, 1100, 1440]) {
        await win.setViewportSize({ width, height: 900 })
        await win.waitForTimeout(250)
        const m = await measure()
        t.check(`at ${width}px the page does not scroll sideways`, m.docScrollWidth <= m.innerWidth && m.innerWidth === width, `scrollWidth ${m.docScrollWidth}, innerWidth ${m.innerWidth}`)
        t.check(`at ${width}px the title bar stays on screen`, m.barLeft >= 0, `bar left ${m.barLeft}`)
        t.check(`at ${width}px the New task button is fully inside`, m.btnRight <= m.innerWidth, `button right ${m.btnRight}`)
        t.check(`at ${width}px the Fleet sidebar is open`, m.fleetOpen)
        t.check(`at ${width}px the Tasks area does not scroll sideways`, !m.areaScrollsX)
        t.check(
          `at ${width}px every group header is fully inside the Tasks area`,
          m.headersInside && m.headerCount === 5,
          `${m.headerCount} headers`
        )
        t.check(`at ${width}px every card is fully inside the Tasks area`, m.cardCount > 0 && m.cardsInside, `${m.cardCount} cards`)
        t.check(`at ${width}px each card title keeps most of the card width`, m.minTitleRatio > 0.5, `narrowest title ${Math.round(m.minTitleRatio * 100)}% of its card`)
        t.check(`at ${width}px each meta line stays on one line`, m.maxMetaLines < 1.6, `meta ${m.maxMetaLines.toFixed(2)} lines`)
        await t.shot(`07-tasks-width-${width}`)
      }
      await win.setViewportSize({ width: 1440, height: 900 })
      await win.waitForTimeout(150)
    })

    await t.step('opening in Skipper shows the hand-off, and merging finishes the task', async () => {
      await win.click(q(`task-open-${task.id}`))
      await win.waitForSelector(q('heat-view'))
      await win.waitForSelector('[data-testid=heat-status][data-status=decided]', { timeout: 20000 })
      t.check('Skipper shows the heat the task is riding', (await win.locator(q('heat-view')).count()) === 1)
      await win.click(q('heat-merge'))
      await win.waitForSelector(q('heat-merged'), { timeout: 20000 })
      await win.keyboard.press('Escape')
      await win.waitForSelector(q('skipper-view'), { state: 'detached' })
      await win.waitForSelector(q('tasks-view'))
      await waitTaskStatus(win, task.id, 'done', 20000)
      const done = (await tasksOf(win)).find((row) => row.id === task.id)
      t.check('the merged task is Done and reads in that column', done.status === 'done' && (await inColumn(win, 'done', task.id)) === 1)
      t.check('the change came home', readFileSync(join(repo, 'src', 'app.js'), 'utf8').includes('changed by test agent'))
      t.check('nothing is offered for a finished task', (await win.locator(q(`task-done-${task.id}`)).count()) === 0 && (await win.locator(q(`task-run-${task.id}`)).count()) === 0)
      await t.shot('04-tasks-done')
    })

    await t.step('a person can mark a task done without merging it', async () => {
      await win.click(q('tasks-new'))
      await win.waitForSelector(q('tasks-editor'))
      await win.locator(q('tasks-title')).fill('Write the release notes')
      await win.locator(q('tasks-prompt')).fill('Summarise the last ten commits')
      await win.locator(q('tasks-assignee-agent')).click()
      await win.locator(q('tasks-agent')).selectOption('fake')
      await win.locator(q('tasks-check-remove')).first().click()
      await win.locator('[data-testid=tasks-check-preset]', { hasText: /^Test$/ }).click()
      await win.click(q('tasks-save'))
      await win.waitForSelector(q('tasks-editor'), { state: 'detached' })
      const second = (await tasksOf(win)).find((row) => row.title === 'Write the release notes')
      t.check('the preset check was written into the task', Boolean(second) && second.checks.length === 1 && second.checks[0].command === 'npm test')
      const heatsBefore = (await win.evaluate(() => window.regatta.invoke('heats:list'))).length
      await win.click(q(`task-done-${second.id}`))
      await waitTaskStatus(win, second.id, 'done', 10000)
      const after = (await tasksOf(win)).find((row) => row.id === second.id)
      const heatsAfter = (await win.evaluate(() => window.regatta.invoke('heats:list'))).length
      t.check('marking done moved the task and started no heat', after.status === 'done' && after.heatId === null && heatsAfter === heatsBefore)
      t.check('it sits with the merged task', (await inColumn(win, 'done', second.id)) === 1 && (await win.locator('[data-testid=tasks-column-done] article[data-testid^=task-]').count()) === 2)
      await t.shot('05-tasks-marked-done')
    })

    await t.step('Add to tonight puts the same work in the night queue', async () => {
      await win.click(q('tasks-new'))
      await win.waitForSelector(q('tasks-editor'))
      await win.locator(q('tasks-title')).fill('Tidy the changelog')
      await win.locator(q('tasks-prompt')).fill('Sort the changelog entries by release')
      await win.locator(q('tasks-agent')).selectOption('fake')
      await win.locator(q('tasks-check-name')).first().fill('marker')
      await win.locator(q('tasks-check-command')).first().fill(MARKER)
      await win.click(q('tasks-save'))
      await win.waitForSelector(q('tasks-editor'), { state: 'detached' })
      const third = (await tasksOf(win)).find((row) => row.title === 'Tidy the changelog')
      await win.click(q(`task-tonight-${third.id}`))
      await win.waitForSelector(q('tasks-open-night'))
      t.check('the view says it went into tonight', (await win.locator(q('tonight-note')).count()) === 1)
      await win.click(q('tasks-open-night'))
      await win.waitForSelector(q('night-form'), { timeout: 10000 })
      const row = win.locator('[data-testid^=night-task-]', { hasText: 'Sort the changelog entries by release' })
      t.check('the night queue holds the prompt with the Test Agent', (await row.count()) === 1 && (await row.first().getAttribute('data-agent')) === 'fake')
      t.check('the queued task carries the same check', (await row.first().locator(q('night-tag')).getAttribute('title')).includes(MARKER))
      const still = (await tasksOf(win)).find((row2) => row2.id === third.id)
      t.check('adding to tonight did not start or finish the task', still.status === 'todo' && still.heatId === null)
      await t.shot('06-tasks-tonight')
    })

    const results = await t.close()
    t = null
    return results
  } finally {
    if (t) await t.close()
    rmSync(repo, { recursive: true, force: true })
  }
}
