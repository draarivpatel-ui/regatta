// Night watch end to end, in the fake world with the Test Agent: queue tasks (one with a custom check), remove one,
// schedule and cancel, start a night, read its report while it runs and when it is over, merge one run (first
// refused, then done), discard another, and open a third in a pane. Then, each on its own: stopping a night that runs,
// a project that has checks of its own, a project opened below the top of its repository, a night that was missed
// because the app was closed when it was due, and a refusal from main shown inline (a folder that is no repository).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

const CART = "it('adds', () => { expect(1).toBe(1) })\nit('subtracts', () => { expect(2).toBe(2) })\n"
const DISCARD_ASK = 'Discard this run? Its worktree is removed only when nothing in it is unsaved; a copy of its commits stays in the repository.'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function makeRepo(prefix, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  git(['init', '-b', 'main'], dir)
  mkdirSync(join(dir, 'test'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'test', 'cart.test.js'), CART)
  writeFileSync(join(dir, 'GUARD.txt'), 'guard\n')
  writeFileSync(join(dir, 'src', 'app.js'), 'export const app = 1\n')
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(dir, file), text)
  git(['add', '.'], dir)
  git(['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'first commit'], dir)
  return dir
}

// An en dash or an em dash, built from code points so that this file holds neither.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`)

const q = (id) => `[data-testid=${id}]`
const TASKS = '[data-testid^=night-task-]'
const RUNS = '[data-testid=night-runs] > button'

/** Waits until a button exists and is on. A bare `!el?.disabled` is true when the element is missing, so it is not used. */
function buttonOn(win, id, timeout = 8000) {
  return win.waitForFunction((sel) => {
    const el = document.querySelector(sel)
    return Boolean(el) && !el.disabled
  }, q(id), { timeout })
}

async function taskCount(win) {
  return win.locator(TASKS).count()
}

function queued(win, n, timeout = 10000) {
  return win.waitForFunction(([sel, want]) => document.querySelectorAll(sel).length === want, [TASKS, n], { timeout })
}

/** Fills the Tonight form for the Test Agent with one custom check and presses Add to tonight. */
async function addTask(win, prompt, check) {
  const before = await taskCount(win)
  await win.locator(q('night-prompt')).fill(prompt)
  await win.locator('[data-testid=night-agent][data-agent=fake]').click()
  await win.locator(q('night-check-custom')).fill(check)
  await buttonOn(win, 'night-add')
  await win.click(q('night-add'))
  await queued(win, before + 1)
}

/** The statuses of the run rows, top to bottom. */
function runStatuses(win) {
  return win.locator(RUNS).evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))
}

function reportStatus(win) {
  return win.locator(q('night-report')).getAttribute('data-status')
}

/** A screenshot once everything that moves in has stopped moving. The window is hidden, so its fades run slowly. */
async function shot(t, name) {
  await t.win.waitForFunction(
    () => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
    undefined,
    { timeout: 10000 }
  )
  await t.shot(name)
}

/** Scrolls the report to its end (a run's buttons and any question are there) or back to its top. */
function scrollReport(win, where) {
  return win.evaluate((to) => {
    const el = document.querySelector('[data-testid=night-report]')
    if (el) el.scrollTop = to === 'end' ? el.scrollHeight : 0
  }, where)
}

/** Fails when what the view shows breaks the writing and design rules: a raw escape, a dash, a shout, small capitals. */
async function checkWords(t, label) {
  const text = await t.win.locator(q('night-view')).innerText()
  const bad = []
  if (/\\u[0-9a-fA-F]{4}/.test(text)) bad.push('an unprocessed escape')
  if (DASHES.test(text)) bad.push('an en or em dash')
  if (text.includes('!')) bad.push('an exclamation mark')
  const shouting = await t.win.evaluate(
    () => [...document.querySelectorAll('[data-testid=night-view] *')].filter((el) => getComputedStyle(el).textTransform === 'uppercase').length
  )
  if (shouting > 0) bad.push(`${shouting} all-caps labels`)
  t.check(`${label}: plain words, no dashes, no all-caps labels`, bad.length === 0, bad.join(', '))
}

export default async function night() {
  const repoDir = makeRepo('regatta-night-e2e-')
  const checksDir = makeRepo('regatta-night-checks-e2e-', {
    'package.json': JSON.stringify({ name: 'night-checks-e2e', private: true, scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }, null, 2)
  })
  let results = []
  try {
    results = [...(await flow(repoDir)), ...(await stopNight()), ...(await detectedChecks(checksDir)), ...(await subfolder()), ...(await missed()), ...(await noRepo())]
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(checksDir, { recursive: true, force: true })
  }
  return results
}

async function flow(repoDir) {
  // Each Test Agent run takes about four seconds, so a night that is running can be looked at and stopped.
  const t = await launch('night', { cwd: repoDir, env: { REGATTA_FAKE_DELAY_MS: '2000' } })
  const { win } = t
  let nightId = ''
  let baseSha = ''
  let results = []

  try {
    await t.step('open Night watch on Tonight', async () => {
      await win.click(q('night-button'))
      await win.waitForSelector(q('night-form'), { timeout: 5000 })
      t.check('Night watch opens on Tonight with nothing queued', (await win.locator(q('tonight-status')).innerText()) === 'No tasks queued')
      t.check('Add to tonight is off while the form is empty', await win.locator(q('night-add')).isDisabled())
      t.check(
        'Schedule and Start now are off while the queue is empty',
        (await win.locator(q('night-schedule')).isDisabled()) && (await win.locator(q('night-start-now')).isDisabled())
      )
      const kinds = await win.locator(q('night-agent')).evaluateAll((els) => els.map((e) => e.getAttribute('data-agent')).sort())
      t.check(
        'the picker lists the installed agents that can run on their own, and no others',
        JSON.stringify(kinds) === JSON.stringify(['claude', 'codex', 'fake', 'gemini', 'grok', 'opencode']),
        kinds.join(',')
      )
      t.check('a project with no checks says so', (await win.locator(q('night-form')).innerText()).includes('No checks found in this project'))
      await checkWords(t, 'Tonight')
      await shot(t, '01-night-empty')
    })

    await t.step('add a task for the test agent with a custom check', async () => {
      await win.locator(q('night-prompt')).fill('Create DONE.txt')
      await win.locator('[data-testid=night-agent][data-agent=fake]').click()
      t.check('Add to tonight stays off until there is a check', await win.locator(q('night-add')).isDisabled())
      await win.locator(q('night-check-custom')).fill('test -f DONE.txt')
      await buttonOn(win, 'night-add')
      await win.click(q('night-add'))
      await queued(win, 1)
      const row = win.locator(TASKS).first()
      const text = await row.innerText()
      t.check('the queue shows the prompt and the check', text.includes('Create DONE.txt') && text.includes('test -f DONE.txt'), text.replace(/\n/g, ' | '))
      t.check('the task keeps the Test Agent', (await row.getAttribute('data-agent')) === 'fake')
      t.check('the Tonight row counts it', (await win.locator(q('tonight-status')).innerText()) === '1 task queued')
      t.check('the form is cleared for the next task', (await win.locator(q('night-prompt')).inputValue()) === '' && (await win.locator(q('night-check-custom')).inputValue()) === '')
      await shot(t, '02-task-queued')
    })

    await t.step('remove a queued task', async () => {
      await addTask(win, 'Create REMOVE_ME.txt', 'test -f REMOVE_ME.txt')
      t.check('two tasks queued', (await taskCount(win)) === 2)
      const doomed = win.locator(TASKS, { hasText: 'REMOVE_ME' })
      await doomed.locator('[data-testid^=night-remove-]').click()
      await queued(win, 1)
      const left = await win.locator(`${TASKS} ${q('night-queue-prompt')}`).allInnerTexts()
      t.check('removing a queued task keeps the other one', JSON.stringify(left) === JSON.stringify(['Create DONE.txt']), left.join(' | '))
    })

    await t.step('queue the rest of tonight', async () => {
      await addTask(win, 'Second copy of DONE.txt', 'test -f DONE.txt')
      await addTask(win, 'Fail on purpose', 'test -f NEVER.txt')
      t.check('three tasks queued', (await taskCount(win)) === 3)
      t.check('the Tonight row says so', (await win.locator(q('tonight-status')).innerText()) === '3 tasks queued')
    })

    await t.step('schedule an hour ahead, then cancel and get the tasks back', async () => {
      const ahead = new Date(Date.now() + 3600_000)
      const time = `${String(ahead.getHours()).padStart(2, '0')}:${String(ahead.getMinutes()).padStart(2, '0')}`
      // A time that has already passed today means tomorrow; one still ahead means today.
      const past = new Date(Date.now() - 3600_000)
      const pastText = `${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`
      const pastAt = new Date()
      pastAt.setHours(past.getHours(), past.getMinutes(), 0, 0)
      await win.locator(q('night-start-at')).fill(pastText)
      const hint = (await win.locator(q('night-start')).innerText()).includes(pastAt.getTime() <= Date.now() ? 'Tomorrow, in' : 'Today, in')
      t.check('a time that has passed today is read as tomorrow, one still ahead as today', hint)
      await win.locator(q('night-start-at')).fill(time)
      await win.click(q('night-schedule'))
      await win.waitForSelector(q('night-scheduled'), { timeout: 8000 })
      const line = (await win.locator(q('night-scheduled')).innerText()).trim()
      t.check('the Start card says when the night starts', /^Starts at .+, in (\d+ h \d+ m|\d+ m)$/.test(line), line)
      t.check('the Tonight row says it too', (await win.locator(q('tonight-status')).innerText()).startsWith('Starts at '))
      t.check('Schedule and Start now give way to Cancel', (await win.locator(q('night-schedule')).count()) === 0 && (await win.locator(q('night-cancel')).count()) === 1)
      t.check('the scheduled night is listed with its tasks', (await win.locator('[data-testid^=night-row-][data-status=scheduled]').innerText()).includes('3 tasks, 0 ready'))
      t.check('the Start card says how many tasks wait', (await win.locator(q('night-start')).innerText()).includes('3 tasks will run one after another.'))
      await shot(t, '03-scheduled')

      // The scheduled night has a report of its own, with its tasks waiting and a way to cancel it.
      await win.click(q('night-see-report'))
      await win.waitForSelector(`${q('night-report')}[data-status=scheduled]`, { timeout: 5000 })
      t.check('its report says Scheduled', (await win.locator(q('night-status')).innerText()) === 'Scheduled')
      t.check('its first fact is when it starts, not when it ran', (await win.locator(`${q('night-fact-ran')} dt`).innerText()) === 'Starts')
      t.check('and counts the tasks that wait', /^3 tasks \u00B7 starts at .+$/.test((await win.locator(q('night-summary')).innerText()).split('\n')[0]))
      t.check('all three are queued', (await runStatuses(win)).join(',') === 'queued,queued,queued')
      t.check('the report can cancel the night', (await win.locator(q('night-cancel')).innerText()).includes('Cancel the night'))
      await shot(t, '03b-scheduled-report')
      await win.click(q('night-cancel'))
      await win.waitForSelector(`${q('night-report')}[data-status=cancelled]`, { timeout: 8000 })
      await win.click(q('night-row-tonight'))
      await win.waitForSelector(q('night-form'), { timeout: 5000 })
      await queued(win, 3)
      t.check('cancelling from the report puts the tasks back too', (await win.locator(q('tonight-status')).innerText()) === '3 tasks queued')

      // And again from Tonight, the way the card says.
      await win.locator(q('night-start-at')).fill(time)
      await win.click(q('night-schedule'))
      await win.waitForSelector(q('night-scheduled'), { timeout: 8000 })
      await win.click(q('night-cancel'))
      await win.waitForSelector(q('night-scheduled'), { state: 'detached', timeout: 8000 })
      await queued(win, 3)
      const back = await win.locator(`${TASKS} ${q('night-queue-prompt')}`).allInnerTexts()
      t.check('cancelling puts the three tasks back in the queue, in order', JSON.stringify(back) === JSON.stringify(['Create DONE.txt', 'Second copy of DONE.txt', 'Fail on purpose']), back.join(' | '))
      t.check('the Tonight row counts them again', (await win.locator(q('tonight-status')).innerText()) === '3 tasks queued')

      const cancelled = win.locator('[data-testid^=night-row-][data-status=cancelled]')
      t.check('the cancelled nights are kept in the list', (await cancelled.count()) === 2)
      await win.locator(q('night-prompt')).fill('A draft that stays')
      await cancelled.first().click()
      await win.waitForSelector(q('night-report'), { timeout: 5000 })
      t.check('its report says it never started', (await win.locator(q('night-summary')).innerText()).includes('cancelled before it started'))
      t.check('and shows the Cancelled pill', (await win.locator(q('night-status')).innerText()) === 'Cancelled')
      await shot(t, '04-cancelled-night')
      await win.click(q('night-row-tonight'))
      await win.waitForSelector(q('night-form'), { timeout: 5000 })
      t.check('what was typed on Tonight is still there after a look at a night', (await win.locator(q('night-prompt')).inputValue()) === 'A draft that stays')
      await win.locator(q('night-prompt')).fill('')
    })

    await t.step('start now and watch the night run', async () => {
      baseSha = git(['rev-parse', 'HEAD'], repoDir).trim()
      await win.click(q('night-start-now'))
      await win.waitForSelector(`${q('night-report')}[data-status=running]`, { timeout: 10000 })
      nightId = (await win.locator(q('night-report')).getAttribute('data-night')) ?? ''
      t.check('Start now opens the report of the night that began', nightId.length > 0 && (await win.locator(q(`night-row-${nightId}`)).getAttribute('data-status')) === 'running')
      t.check('the sidebar says it is keeping the Mac awake', await win.locator(q('night-awake')).isVisible())
      t.check('the Tonight row says Running now', (await win.locator(q('tonight-status')).innerText()) === 'Running now')
      t.check('the report has a Stop the night button while it runs', (await win.locator(q('night-cancel')).innerText()).includes('Stop the night'))
      t.check('all three tasks are listed', (await win.locator(RUNS).count()) === 3)

      // The first task is done while the others still run: it is ready, but cannot be merged until the night is over.
      await win.waitForFunction(
        () =>
          document.querySelector('[data-testid=night-report]')?.getAttribute('data-status') === 'running' &&
          document.querySelector('[data-testid=night-runs] > [data-status=ready]') !== null,
        undefined,
        { timeout: 90000 }
      )
      const first = (await runStatuses(win))[0]
      t.check('the first task is ready while the night still runs', first === 'ready', first)
      t.check('Merge waits for the end of the night', await win.locator(q('night-merge')).isDisabled())
      t.check('and says why', (await win.locator(q('night-merge-hint')).innerText()).includes('once the night has finished'))
      await shot(t, '05-ready-while-running')
    })

    await t.step('wait for the night to finish', async () => {
      await win.waitForFunction(() => document.querySelector('[data-testid=night-report]')?.getAttribute('data-status') === 'finished', undefined, { timeout: 150000 })
      const statuses = await runStatuses(win)
      t.check('two tasks are ready and the one that fails its check is failed', JSON.stringify(statuses) === JSON.stringify(['ready', 'ready', 'failed']), statuses.join(','))
      const summary = (await win.locator(q('night-summary')).innerText()).split('\n')[0]
      t.check(
        'the summary counts ready and failed, with the failed task\'s note, and when it ran',
        /^2 of 3 ready · 1 failed \(failing: test -f NEVER\.txt\) · ran .+ to .+$/.test(summary),
        summary
      )
      t.check('the title is the date and the project folder', /· regatta-night-e2e-/.test(await win.locator(q('night-title')).innerText()))
      t.check('Ran shows the start and the end', /^.+ to .+$/.test(await win.locator(`${q('night-fact-ran')} dd`).innerText()))
      t.check('Per task says up to 30 minutes', (await win.locator(`${q('night-fact-limit')} dd`).innerText()) === 'up to 30 minutes')
      const base = await win.locator(`${q('night-fact-base')} dd`).innerText()
      t.check('Base is the commit the night started from', base === baseSha.slice(0, 7), `${base} vs ${baseSha.slice(0, 7)}`)
      t.check('and says the working folder is never touched', (await win.locator(q('night-fact-base')).innerText()).includes('your working folder is never touched'))
      const tokens = (await win.locator(q('night-tokens')).innerText()).trim()
      t.check('tokens are shown per agent', /^Test Agent \d+(\.\d)?k tokens$/.test(tokens), tokens)
      t.check('the sidebar row says three tasks, two ready', (await win.locator(q(`night-row-${nightId}`)).innerText()).includes('3 tasks, 2 ready'))
      t.check('Keeping awake is gone', (await win.locator(q('night-awake')).count()) === 0)
      await checkWords(t, 'the report')
    })

    await t.step('read the first run: checks, gates, tests, branch', async () => {
      t.check('the first row is the one on screen', (await win.locator(`${RUNS}:nth-child(1)`).getAttribute('data-selected')) === 'true')
      const card = win.locator(q('night-card'))
      t.check('the card is for the first task', (await card.getAttribute('data-status')) === 'ready' && (await card.innerText()).includes('Create DONE.txt'))
      const branch = (await win.locator(q('night-branch')).innerText()).trim()
      t.check('the branch is shown whole', branch === `regatta/night-${nightId}-fake-1`, branch)
      const check = win.locator(q('night-check-result'))
      t.check('the check is shown as passed, with its time', (await check.getAttribute('data-passed')) === 'true' && /\d+\.\d s/.test(await check.innerText()), (await check.innerText()).replace(/\n/g, ' '))
      const gates = await win.locator(q('night-gate')).evaluateAll((els) => els.map((e) => `${e.getAttribute('data-gate')}:${e.getAttribute('data-passed')}`))
      t.check('all five gates pass', JSON.stringify(gates) === JSON.stringify(['finished:true', 'changed:true', 'checks:true', 'no-regressions:true', 'integrity:true']), gates.join(','))
      t.check('the gates have names and reasons', (await win.locator(q('night-gates')).innerText()).includes('No regressions') && (await win.locator(q('night-gates')).innerText()).includes('tests left intact'))
      const tests = (await win.locator(q('night-tests')).innerText()).replace(/\n/g, ' ')
      t.check('the test counts are shown', tests.includes('2 tests and 2 assertions in 1 file') && tests.includes('test/cart.test.js'), tests)
      t.check('the diff is shown', /^\+\d+ -\d+ in 2 files$/.test((await win.locator(q('night-diff')).innerText()).trim()))
      t.check('the last output is shown', (await win.locator(q('night-latest')).innerText()).trim().length > 0)
      await shot(t, '06-night-ready')
      await scrollReport(win, 'end')
      await shot(t, '06b-night-ready-end')
      await scrollReport(win, 'top')
    })

    await t.step('read the failed run', async () => {
      await win.locator(`${RUNS}:nth-child(3)`).click()
      await win.waitForSelector(`${q('night-card')}[data-status=failed]`, { timeout: 5000 })
      const check = win.locator(q('night-check-result'))
      t.check('its check is shown as failed', (await check.getAttribute('data-passed')) === 'false')
      const gates = await win.locator(q('night-gate')).evaluateAll((els) => els.map((e) => `${e.getAttribute('data-gate')}:${e.getAttribute('data-passed')}`))
      t.check('the checks gate fails and the rest pass', JSON.stringify(gates) === JSON.stringify(['finished:true', 'changed:true', 'checks:false', 'no-regressions:true', 'integrity:true']), gates.join(','))
      t.check('the gate gives its reason', (await win.locator(`${q('night-gate')}[data-gate=checks]`).innerText()).includes('failing: test -f NEVER.txt'))
      t.check('the note says why it failed', (await win.locator(q('night-card-note')).innerText()).includes('failing: test -f NEVER.txt'))
      t.check('a failed run has no Merge, only Open and Discard', (await win.locator(q('night-merge')).count()) === 0 && (await win.locator(q('night-open')).count()) === 1 && (await win.locator(q('night-discard')).count()) === 1)
      await shot(t, '07-failed-run')
      await scrollReport(win, 'end')
      await shot(t, '07b-failed-run-end')
      await scrollReport(win, 'top')
      await win.locator(`${RUNS}:nth-child(1)`).click()
      await win.waitForSelector(`${q('night-card')}[data-status=ready]`, { timeout: 5000 })
    })

    await t.step('merge the first run: refused while the folder has changes, then done', async () => {
      // A change to a tracked file in the user's folder: the engine refuses to merge into it, in a sentence.
      writeFileSync(join(repoDir, 'GUARD.txt'), 'changed by hand\n')
      await buttonOn(win, 'night-merge')
      await win.click(q('night-merge'))
      await win.waitForSelector(q('night-merge-ask'), { timeout: 5000 })
      t.check('Merge asks before it does anything', (await win.locator(q('night-merge-ask')).innerText()).startsWith('Merge this run?'))
      t.check('and nothing has been merged yet', !existsSync(join(repoDir, 'DONE.txt')))
      await scrollReport(win, 'end')
      await shot(t, '08-merge-ask')
      await win.click(q('night-merge-confirm'))
      await win.waitForFunction(() => document.querySelector('[data-testid=night-card]')?.textContent?.includes('Commit or stash your changes first'), undefined, { timeout: 15000 })
      const shown = await win.locator(q('night-card')).innerText()
      t.check('the refusal is shown as a sentence on the run', shown.includes('Commit or stash your changes first. Merging needs a clean folder.') && !shown.includes('Error invoking'), shown.replace(/\n/g, ' ').slice(0, 200))
      t.check('the run stays ready with its buttons', (await win.locator(q('night-card')).getAttribute('data-status')) === 'ready' && (await win.locator(q('night-merge')).isEnabled()))
      t.check('and the user\'s folder got nothing', !existsSync(join(repoDir, 'DONE.txt')) && readFileSync(join(repoDir, 'GUARD.txt'), 'utf8') === 'changed by hand\n')
      await shot(t, '09-merge-refused')

      writeFileSync(join(repoDir, 'GUARD.txt'), 'guard\n')
      await win.click(q('night-merge'))
      await win.waitForSelector(q('night-merge-ask'), { timeout: 5000 })
      await win.click(q('night-merge-confirm'))
      await win.waitForSelector(`${q('night-card')}[data-status=merged]`, { timeout: 30000 })
      const result = (await win.locator(q('night-result')).innerText()).trim()
      t.check('the result summary says what was merged', /^(Fast-forwarded|Merged into) main/.test(result), result)
      t.check('DONE.txt is now in the repository folder', existsSync(join(repoDir, 'DONE.txt')))
      t.check('with the run\'s own content', readFileSync(join(repoDir, 'DONE.txt'), 'utf8').startsWith('done: Create DONE.txt'))
      t.check('the run\'s worktree moved to .regatta-trash and its branch stays until trash is emptied', git(['branch', '--list', `regatta/night-${nightId}-fake-1`], repoDir).trim() !== '' && readdirSync(join(t.world, 'worktrees', '.regatta-trash')).length === 1)
      t.check('the first row says Merged', (await runStatuses(win))[0] === 'merged')
      const summary = (await win.locator(q('night-summary')).innerText()).split('\n')[0]
      t.check('the summary still adds up', /^1 of 3 ready · 1 failed \(.+\) · 1 merged · ran /.test(summary), summary)
      t.check('a merged run has no Merge, Open or Discard to press, and its branch is no longer shown', (await win.locator(`${q('night-merge')}, ${q('night-discard')}, ${q('night-open')}, ${q('night-branch')}`).count()) === 0)
      await scrollReport(win, 'end')
      await shot(t, '10-merged')
    })

    await t.step('discard the second run, with the confirmation', async () => {
      await win.locator(`${RUNS}:nth-child(2)`).click()
      await win.waitForSelector(`${q('night-card')}[data-status=ready]`, { timeout: 5000 })
      const worktree = await win.evaluate(async (id) => (await window.regatta.invoke('night:state')).nights.find((n) => n.id === id).runs[1].worktree, nightId)
      await win.click(q('night-discard'))
      await win.waitForSelector(q('night-discard-ask'), { timeout: 5000 })
      t.check('Discard asks with the sentence from the card', (await win.locator(q('night-discard-ask')).innerText()).includes(DISCARD_ASK))
      await scrollReport(win, 'end')
      await shot(t, '11-discard-ask')

      await win.click(q('night-ask-cancel'))
      await win.waitForSelector(q('night-discard-ask'), { state: 'detached', timeout: 5000 })
      t.check('Cancel keeps the run as it was', (await win.locator(q('night-card')).getAttribute('data-status')) === 'ready' && existsSync(worktree))

      await win.click(q('night-discard'))
      await win.waitForSelector(q('night-discard-ask'), { timeout: 5000 })
      await win.keyboard.press('Escape')
      await win.waitForSelector(q('night-discard-ask'), { state: 'detached', timeout: 5000 })
      t.check('Escape closes the question and leaves Night watch open', (await win.locator(q('night-view')).count()) === 1 && (await win.locator(q('night-card')).getAttribute('data-status')) === 'ready')

      await win.click(q('night-discard'))
      await win.waitForSelector(q('night-discard-ask'), { timeout: 5000 })
      await win.click(q('night-discard-confirm'))
      await win.waitForSelector(`${q('night-card')}[data-status=discarded]`, { timeout: 30000 })
      t.check('the second row says Discarded', (await runStatuses(win))[1] === 'discarded')
      t.check('its worktree moved to .regatta-trash', !existsSync(worktree) && readdirSync(join(t.world, 'worktrees', '.regatta-trash')).length === 2)

      // Every run that is merged or discarded has its commits kept first (a keep commit under refs/regatta/discarded/, named for the run),
      // and so has its folder (named for the folder): so the first run's merge left a note of its own.
      const refs = git(['for-each-ref', '--format=%(refname)', 'refs/regatta/discarded'], repoDir).trim().split('\n').filter(Boolean)
      const ref = `refs/regatta/discarded/night-${nightId}-1`
      t.check('a copy of its commits was kept in the repository', refs.includes(ref), refs.join(','))
      const notes = win.locator(q('night-notes'))
      const note = notes.locator(q('night-note'), { hasText: `Kept a copy of the run's work at ${ref} ` })
      t.check('the report lists the kept copy as a note', (await notes.count()) === 1 && (await note.count()) === 1, await notes.innerText())
      const copy = note.locator(q('night-copy-command'))
      t.check('the note has a Copy command button', (await copy.count()) === 1)

      // The clipboard is the real one of whoever runs this test: their text is put back afterwards.
      const before = await t.app.evaluate(({ clipboard }) => clipboard.readText())
      await copy.click()
      await win.waitForSelector(`${q('night-notes')} ${q('night-copy-command')}[data-copied=true]`, { timeout: 5000 })
      const copied = await t.app.evaluate(({ clipboard }) => clipboard.readText())
      await t.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before)
      // The first parent of the keep commit is the work; the keep commit itself is empty. The branch has a real name, so the command can be pasted as it is.
      const restored = `night-${nightId}-1-restored`
      t.check('Copy command copies the git command alone, for the work', copied === `git branch ${restored} ${ref}^1`, copied)
      // The command works as copied: it brings the discarded work back.
      git(copied.split(' ').slice(1), repoDir)
      t.check('and the copy holds the discarded run\'s work', git(['show', `${restored}:DONE.txt`], repoDir).startsWith('done: Second copy of DONE.txt'))
      t.check('the sidebar now counts no ready tasks', (await win.locator(q(`night-row-${nightId}`)).innerText()).includes('3 tasks, 0 ready'))
      await scrollReport(win, 'top')
      await shot(t, '12-discarded')
      await scrollReport(win, 'end')
      await shot(t, '12b-discarded-end')
    })

    await t.step('open the failed run in a pane', async () => {
      await win.locator(`${RUNS}:nth-child(3)`).click()
      await win.waitForSelector(`${q('night-card')}[data-status=failed]`, { timeout: 5000 })
      const worktree = await win.evaluate(async (id) => (await window.regatta.invoke('night:state')).nights.find((n) => n.id === id).runs[2].worktree, nightId)
      await win.click(q('night-open'))
      await win.waitForSelector(q('night-view'), { state: 'detached', timeout: 10000 })
      await win.waitForSelector('[data-testid=pane]', { timeout: 10000 })
      const sessions = await win.evaluate(() => window.regatta.invoke('session:list'))
      t.check('Open starts the run\'s agent in the run\'s worktree and shows the pane', sessions.length === 1 && sessions[0].agent === 'fake' && sessions[0].cwd === worktree, JSON.stringify(sessions.map((s) => [s.agent, s.cwd])))
      await shot(t, '13-opened-in-a-pane')
    })

    await t.step('Escape closes Night watch and the night is still there when it opens again', async () => {
      await win.click(q('night-button'))
      await win.waitForSelector(q('night-view'), { timeout: 5000 })
      await win.keyboard.press('Escape')
      await win.waitForSelector(q('night-view'), { state: 'detached', timeout: 5000 })
      t.check('Escape closes the view', (await win.locator(q('night-view')).count()) === 0)
      await win.click(q('night-button'))
      await win.waitForSelector(q('night-view'), { timeout: 5000 })
      await win.click(q(`night-row-${nightId}`))
      await win.waitForSelector(q('night-report'), { timeout: 5000 })
      t.check('the night is listed again with its report', (await reportStatus(win)) === 'finished' && (await runStatuses(win)).join(',') === 'merged,discarded,failed')
      await win.click(q('night-row-tonight'))
      await win.waitForSelector(q('night-form'), { timeout: 5000 })
      t.check('Tonight is empty again: the night took the queue with it', (await win.locator(q('tonight-status')).innerText()) === 'No tasks queued')
    })
  } finally {
    results = await t.close()
  }
  return results
}

/** Stopping a night that runs: it asks first, stops the agent, and the tasks after the running one never start. */
async function stopNight() {
  const repoDir = makeRepo('regatta-night-stop-e2e-')
  // Each Test Agent run takes ten seconds here, which is time enough to look at the night and stop it.
  const t = await launch('night-stop', { cwd: repoDir, env: { REGATTA_FAKE_DELAY_MS: '5000' } })
  const { win } = t
  let results = []
  try {
    await t.step('stop a night that is running', async () => {
      await win.click(q('night-button'))
      await win.waitForSelector(q('night-form'), { timeout: 5000 })
      await addTask(win, 'A task that will be stopped', 'test -f DONE.txt')
      await addTask(win, 'A task that never starts', 'test -f DONE.txt')
      await win.click(q('night-start-now'))
      await win.waitForSelector(`${q('night-report')}[data-status=running]`, { timeout: 10000 })
      await win.waitForSelector(`${RUNS}[data-status=running]`, { timeout: 30000 })
      t.check('one task runs and the other waits', (await runStatuses(win)).join(',') === 'running,queued')
      await shot(t, '01-night-running')

      // Tonight, while a night runs: new tasks wait for the next one, and the Start card says so.
      await win.click(q('night-row-tonight'))
      await win.waitForSelector(q('night-form'), { timeout: 5000 })
      t.check('Tonight says a night is running and offers its report', (await win.locator(q('night-start')).innerText()).includes('A night is running now') && (await win.locator(q('night-see-report')).count()) === 1)
      t.check('Schedule and Start now are not offered while it runs', (await win.locator(`${q('night-schedule')}, ${q('night-start-now')}`).count()) === 0)
      await shot(t, '02-tonight-while-running')
      await win.click(q('night-see-report'))
      await win.waitForSelector(`${q('night-report')}[data-status=running]`, { timeout: 5000 })

      await win.click(q('night-cancel'))
      await win.waitForSelector(q('night-stop-ask'), { timeout: 5000 })
      t.check('Stop the night asks first', (await win.locator(q('night-stop-ask')).innerText()).startsWith('Stop the night?'))
      t.check('and the run keeps going while it asks', (await runStatuses(win))[0] === 'running')
      await shot(t, '03-stop-ask')
      await win.click(q('night-stop-confirm'))
      await win.waitForSelector(`${q('night-report')}[data-status=cancelled]`, { timeout: 15000 })
      t.check('both tasks are stopped', (await runStatuses(win)).join(',') === 'stopped,stopped')
      t.check('the night says Cancelled', (await win.locator(q('night-status')).innerText()) === 'Cancelled')
      const summary = (await win.locator(q('night-summary')).innerText()).split('\n')[0]
      t.check('the summary says what was stopped', /^0 of 2 ready \u00B7 2 stopped \u00B7 ran .+ to .+$/.test(summary), summary)
      t.check('the Mac may sleep again', (await win.locator(q('night-awake')).count()) === 0)
      const second = await win.evaluate(async () => (await window.regatta.invoke('night:state')).nights[0].runs[1])
      t.check('the second task never started and never got a folder', second.startedAt === null && second.worktree === null)
      // Stopping the night stops the agent too: no Test Agent is left working on that prompt.
      const left = () => {
        try {
          return execFileSync('pgrep', ['-f', 'fake-agent.mjs --headless A task that will be stopped'], { encoding: 'utf8' }).trim()
        } catch {
          return ''
        }
      }
      for (let i = 0; i < 40 && left() !== ''; i++) await win.waitForTimeout(250)
      t.check('no agent process is left running', left() === '', left())
      await shot(t, '04-night-stopped')
    })
  } finally {
    results = await t.close()
    rmSync(repoDir, { recursive: true, force: true })
  }
  return results
}

/** A project that has checks of its own: Night watch offers a box for each, and a custom check never repeats a name. */
async function detectedChecks(repoDir) {
  const t = await launch('night-checks', { cwd: repoDir })
  const { win } = t
  let results = []
  try {
    await t.step('detected checks are boxes, all on to begin with', async () => {
      await win.click(q('night-button'))
      await win.waitForSelector(q('night-form'), { timeout: 5000 })
      await win.waitForSelector(q('night-check'), { timeout: 8000 })
      const boxes = await win.locator(q('night-check')).evaluateAll((els) => els.map((e) => `${e.getAttribute('data-name')}:${e.checked}`))
      t.check('one box per check the project has, all ticked', JSON.stringify(boxes) === JSON.stringify(['test:true', 'lint:true']), boxes.join(','))
      t.check('a project with checks does not say it has none', !(await win.locator(q('night-form')).innerText()).includes('No checks found'))
      await shot(t, '01-detected-checks')
    })

    await t.step('a task takes the ticked checks', async () => {
      await win.locator(q('night-prompt')).fill('Tidy the readme')
      await win.locator('[data-testid=night-agent][data-agent=fake]').click()
      await win.locator('[data-testid=night-check][data-name=lint]').uncheck()
      await buttonOn(win, 'night-add')
      await win.click(q('night-add'))
      await queued(win, 1)
      const tags = await win.locator(`${TASKS} ${q('night-tag')}`).evaluateAll((els) => els.map((e) => `${e.textContent}=${e.getAttribute('title')}`))
      t.check('only the ticked check is on the task', JSON.stringify(tags) === JSON.stringify(['test=npm test (required)']), tags.join(','))
      const boxes = await win.locator(q('night-check')).evaluateAll((els) => els.map((e) => `${e.getAttribute('data-name')}:${e.checked}`))
      t.check('the boxes stay as they were for the next task', JSON.stringify(boxes) === JSON.stringify(['test:true', 'lint:false']), boxes.join(','))
    })

    await t.step('a custom check named like a detected one is told apart', async () => {
      await win.locator(q('night-prompt')).fill('Fix the lint warnings')
      await win.locator('[data-testid=night-check][data-name=test]').uncheck()
      await win.locator('[data-testid=night-check][data-name=lint]').check()
      await win.locator(q('night-check-custom')).fill('test')
      await buttonOn(win, 'night-add')
      await win.click(q('night-add'))
      await queued(win, 2)
      const second = win.locator(TASKS).nth(1)
      const tags = await second.locator(q('night-tag')).evaluateAll((els) => els.map((e) => e.textContent))
      t.check('the second task has the lint check and a custom check with its own name', JSON.stringify(tags) === JSON.stringify(['lint', 'test (2)']), tags.join(','))
      await shot(t, '02-two-tasks')
      // Nothing was started: remove both so the queue is empty again.
      await win.locator(TASKS).first().locator('[data-testid^=night-remove-]').click()
      await win.locator(TASKS).first().locator('[data-testid^=night-remove-]').click()
      await queued(win, 0)
      t.check('removing every task empties the queue', (await win.locator(q('tonight-status')).innerText()) === 'No tasks queued')
    })
  } finally {
    results = await t.close()
  }
  return results
}

/** A project opened below the top of its repository: the night runs in the matching folder of the worktree, and Open opens it. */
async function subfolder() {
  // A real path, so that the way git writes the top of the repository is the same text as the project folder's.
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'regatta-night-sub-e2e-')))
  const app = join(top, 'app')
  git(['init', '-b', 'main'], top)
  mkdirSync(join(app, 'src'), { recursive: true })
  mkdirSync(join(app, 'test'), { recursive: true })
  writeFileSync(join(top, 'README.md'), 'top of the repository\n')
  writeFileSync(join(app, 'test', 'cart.test.js'), CART)
  writeFileSync(join(app, 'src', 'app.js'), 'export const app = 1\n')
  git(['add', '.'], top)
  git(['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'first commit'], top)

  const t = await launch('night-subfolder', { cwd: app, env: { REGATTA_FAKE_DELAY_MS: '300' } })
  const { win } = t
  let results = []
  try {
    await t.step('a night in a subfolder project runs in that folder of the worktree', async () => {
      await win.click(q('night-button'))
      await win.waitForSelector(q('night-form'), { timeout: 5000 })
      await addTask(win, 'Create DONE.txt in the app', 'test -f DONE.txt')
      await win.click(q('night-start-now'))
      await win.waitForSelector(`${q('night-report')}[data-status=finished]`, { timeout: 90000 })
      t.check('the task is ready', (await runStatuses(win)).join(',') === 'ready')
      const worktree = await win.evaluate(async () => (await window.regatta.invoke('night:state')).nights[0].runs[0].worktree)
      t.check('the agent worked in the app folder of the worktree, not at its top', existsSync(join(worktree, 'app', 'DONE.txt')) && !existsSync(join(worktree, 'DONE.txt')))
      await shot(t, '01-subfolder-night')

      await win.click(q('night-open'))
      await win.waitForSelector(q('night-view'), { state: 'detached', timeout: 10000 })
      await win.waitForSelector('[data-testid=pane]', { timeout: 10000 })
      const sessions = await win.evaluate(() => window.regatta.invoke('session:list'))
      t.check('Open opens that folder', sessions.length === 1 && sessions[0].cwd === join(worktree, 'app'), JSON.stringify(sessions.map((x) => x.cwd)))
    })
  } finally {
    results = await t.close()
    rmSync(top, { recursive: true, force: true })
  }
  return results
}

/** A night that came due while the app was closed is not started late: it is cancelled, says so, and its tasks are back in the queue. */
async function missed() {
  const repoDir = makeRepo('regatta-night-missed-e2e-')
  const profile = mkdtempSync(join(tmpdir(), 'regatta-night-profile-'))
  let results = []
  try {
    // First run of the app: queue a task, schedule it for later, and quit.
    const first = await launch('night-missed', { cwd: repoDir, profile })
    try {
      await first.step('schedule a night and quit the app', async () => {
        await first.win.click(q('night-button'))
        await first.win.waitForSelector(q('night-form'), { timeout: 5000 })
        await addTask(first.win, 'Run while I am away', 'test -f DONE.txt')
        const ahead = new Date(Date.now() + 3600_000)
        await first.win.locator(q('night-start-at')).fill(`${String(ahead.getHours()).padStart(2, '0')}:${String(ahead.getMinutes()).padStart(2, '0')}`)
        await first.win.click(q('night-schedule'))
        await first.win.waitForSelector(q('night-scheduled'), { timeout: 8000 })
        first.check('the night is scheduled before the app quits', (await first.win.locator(q('tonight-status')).innerText()).startsWith('Starts at '))
      })
    } finally {
      results = await first.close()
    }

    // While the app was closed the time came and went.
    const file = join(profile, 'nightwatch.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.nights[0].startAt = Date.now() - 3600_000
    writeFileSync(file, JSON.stringify(saved, null, 2))

    const second = await launch('night-missed', { cwd: repoDir, profile })
    try {
      await second.step('the missed night is cancelled and its task is back in the queue', async () => {
        const win = second.win
        await win.click(q('night-button'))
        await win.waitForSelector(q('night-form'), { timeout: 5000 })
        await queued(win, 1)
        second.check('the task is back in the queue', (await win.locator(q('tonight-status')).innerText()) === '1 task queued' && (await win.locator(`${TASKS} ${q('night-queue-prompt')}`).innerText()) === 'Run while I am away')
        const row = win.locator('[data-testid^=night-row-][data-status=cancelled]')
        second.check('the night is listed as cancelled', (await row.count()) === 1)
        await row.click()
        await win.waitForSelector(`${q('night-report')}[data-status=cancelled]`, { timeout: 5000 })
        const note = (await win.locator(q('night-notes')).innerText()).trim()
        second.check('the report says it was missed, in its own line', /^Missed: Regatta was not running at .+ so it was not started\. Its tasks are back in the queue\.$/.test(note), note)
        second.check('the task shows as stopped, with the word Missed', (await runStatuses(win)).join(',') === 'stopped' && (await win.locator(q('night-card-note')).innerText()).includes('Missed'))
        second.check('a run that never started has nothing to discard', (await win.locator(q('night-discard')).count()) === 0 && (await win.locator(q('night-open')).count()) === 0)
        second.check('the summary says it never started', (await win.locator(q('night-summary')).innerText()).includes('cancelled before it started'))
        await shot(second, '01-missed-night')
      })
    } finally {
      results = [...results, ...(await second.close())]
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
  return results
}

/** A refusal from main shows inline, in main's own words, and goes away with the next thing the user does. */
async function noRepo() {
  const plain = mkdtempSync(join(tmpdir(), 'regatta-night-norepo-e2e-'))
  writeFileSync(join(plain, 'notes.txt'), 'not a repository\n')
  const t = await launch('night-norepo', { cwd: plain })
  const { win } = t
  let results = []
  try {
    await t.step('a night in a folder that is no repository says why it cannot start', async () => {
      await win.click(q('night-button'))
      await win.waitForSelector(q('night-form'), { timeout: 5000 })
      await addTask(win, 'Tidy the notes', 'test -f notes.txt')
      await win.click(q('night-start-now'))
      await win.waitForSelector(q('night-error'), { timeout: 8000 })
      const text = (await win.locator(q('night-error')).innerText()).trim()
      t.check('main\'s sentence is shown, without the wrapper around it', text === 'Night watch needs a git repository with at least one commit.', text)
      t.check('the task is still queued and no night was made', (await taskCount(win)) === 1 && (await win.locator('[data-testid^=night-row-]:not([data-testid=night-row-tonight])').count()) === 0)
      t.check('the Start buttons are back on', await win.locator(q('night-start-now')).isEnabled())
      await shot(t, '01-refused-inline')
      await win.locator(`${q('night-error')} button`).click()
      await win.waitForSelector(q('night-error'), { state: 'detached', timeout: 3000 })

      // The next refusal replaces the last one, and the next thing that works takes it away.
      await win.click(q('night-start-now'))
      await win.waitForSelector(q('night-error'), { timeout: 8000 })
      await win.locator('[data-testid^=night-remove-]').click()
      await queued(win, 0)
      await win.waitForSelector(q('night-error'), { state: 'detached', timeout: 3000 })
      t.check('removing the task clears the message', (await win.locator(q('night-error')).count()) === 0)
    })
  } finally {
    results = await t.close()
    rmSync(plain, { recursive: true, force: true })
  }
  return results
}
