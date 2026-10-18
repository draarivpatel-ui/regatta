// Checkpoints: roll back an agent step from the pane menu, then redo.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 })
}

/** A throwaway repository with notes.txt reading "one" and one commit. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'regatta-e2e-cp-'))
  git(['init', '-b', 'main'], repo)
  writeFileSync(join(repo, 'notes.txt'), 'one')
  git(['add', '.'], repo)
  git(
    ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'first commit'],
    repo
  )
  return repo
}

export default async function checkpoints() {
  const repo = makeRepo()
  const t = await launch('checkpoints', { cwd: repo })
  const { win } = t
  let results = []

  try {
    await t.step('start a test agent', async () => {
      await t.startAgent('Test Agent')
      t.check('a pane is open', (await win.locator('[data-testid=pane]').count()) === 1)
    })

    await t.step('work while changing two files', async () => {
      await win.waitForTimeout(800)
      await t.typeInto(0, 'build the app')
      await t.waitForState(0, 'working', 6000)
      // Give the step's opening snapshot a moment to capture notes.txt as it was.
      await win.waitForTimeout(1200)
      writeFileSync(join(repo, 'notes.txt'), 'two')
      writeFileSync(join(repo, 'new.txt'), 'added by the test\n')
      await t.waitForState(0, 'idle', 12000)
      t.check('the pane left working', (await t.stateOf(0)) === 'idle', String(await t.stateOf(0)))
    })

    await t.step('open Checkpoints from the pane menu', async () => {
      await win.locator('[data-testid=pane] button[aria-label="Pane actions"]').first().click()
      await win.locator('[data-testid=pane] button', { hasText: 'Checkpoints' }).first().click()
      await win.waitForSelector('[data-testid=checkpoints-panel]', { timeout: 8000 })
      await win.waitForSelector('[data-testid=checkpoint-step]', { timeout: 8000 })
      t.check('the panel opened', (await win.locator('[data-testid=checkpoints-panel]').count()) === 1)
      await t.shot('01-steps')
    })

    await t.step('one step lists both files', async () => {
      const steps = await win.locator('[data-testid=checkpoint-step]').count()
      t.check('exactly one step', steps === 1, `${steps} steps`)
      const text = await win.locator('[data-testid=checkpoint-step]').first().innerText()
      t.check('it lists notes.txt', text.includes('notes.txt'))
      t.check('it lists new.txt', text.includes('new.txt'))
      t.check('it says 2 files', /2 files/.test(text), text.replace(/\n/g, ' '))
      t.check('a protected step shows no blocked note', (await win.locator('[data-testid=checkpoint-blocked]').count()) === 0)
      t.check('a complete step offers no retry', (await win.locator('[data-testid=checkpoint-retry]').count()) === 0)
    })

    await t.step('roll back', async () => {
      await win.locator('[data-testid=checkpoint-rollback]').first().click()
      await win.waitForSelector('[data-testid=checkpoint-confirm]', { timeout: 5000 })
      t.check('a confirmation appears', (await win.locator('[data-testid=checkpoint-confirm]').count()) === 1)
      await t.shot('02-confirm')
      await win.locator('[data-testid=checkpoint-confirm]').first().click()
      await win.waitForSelector('[data-testid=checkpoint-result]', { timeout: 8000 })
      const summary = await win.locator('[data-testid=checkpoint-result]').innerText()
      t.check('the result says two files rewound', /Rewound 2 of 2 files/.test(summary), summary.split('\n')[0])
      t.check('the result notes HEAD was untouched', summary.includes('Your HEAD, index and branches were not touched.'))
      await win.waitForTimeout(400)
      t.check('notes.txt reads one again', readFileSync(join(repo, 'notes.txt'), 'utf8') === 'one')
      t.check('new.txt is gone', !existsSync(join(repo, 'new.txt')))
      await t.shot('03-rolled-back')
    })

    await t.step('redo', async () => {
      const redo = win.locator('[data-testid=checkpoint-result] [data-testid=checkpoint-redo]').first()
      await redo.click()
      // Redo puts the files back one by one. Wait until they are there instead of for a fixed 600 ms: on a busy
      // machine (a full run next to other agents' runs) it has taken over a second, and failed twice that way.
      const started = Date.now()
      let notes = ''
      for (let i = 0; i < 40 && !(notes === 'two' && existsSync(join(repo, 'new.txt'))); i++) {
        await win.waitForTimeout(250)
        notes = readFileSync(join(repo, 'notes.txt'), 'utf8')
      }
      t.check('notes.txt reads two again', notes === 'two', `${Date.now() - started} ms`)
      t.check('new.txt is back', existsSync(join(repo, 'new.txt')))
      await t.shot('04-redone')
    })
  } finally {
    results = await t.close()
    rmSync(repo, { recursive: true, force: true })
  }

  return results
}
