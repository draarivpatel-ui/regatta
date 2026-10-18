// Approvals: request binding (approving a replaced request is refused) and stopping a turn that
// started a child process.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export default async function approvals() {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-approvals-'))
  const pidFile = join(dir, 'helper.pid')
  writeFileSync(join(dir, 'README.md'), 'start\n')

  const t = await launch('approvals', {
    cwd: dir,
    env: { REGATTA_FAKE_PIDFILE: pidFile }
  })
  const { app, win } = t

  await app.evaluate(({ ipcMain }) => {
    globalThis.__approveCalls = []
    const origHandle = ipcMain.handle.bind(ipcMain)
    void origHandle
    const listeners = ipcMain._invokeHandlers
    if (listeners && typeof listeners.get === 'function') {
      const orig = listeners.get('chat:approve')
      if (orig) {
        listeners.set('chat:approve', (event, ...args) => {
          globalThis.__approveCalls.push(args)
          return orig(event, ...args)
        })
      }
    }
  })

  try {
    await t.step('open Chat mode and pick the Test Agent', async () => {
      await win.keyboard.press('Meta+3')
      await win.waitForSelector('[data-testid="chat-mode"]', { timeout: 8000 })
      await win.click('[data-testid="chat-new"]')
      await win.waitForSelector('[data-testid="chat-agent"]', { timeout: 8000 })
      await win.selectOption('[data-testid="chat-agent"]', { label: 'Test Agent' })
      await win.waitForTimeout(300)
      const agent = await win.locator('[data-testid="chat-agent"]').inputValue()
      const access = await win.locator('[data-testid="chat-mode-picker"]').inputValue()
      t.check('Test Agent selected in Ask first mode', agent === 'fake' && access === 'read')
      await t.shot('01-chat-ready')
    })

    await t.step('edit request gives an approval card and approving it edits README.md', async () => {
      await win.fill('[data-testid="chat-input"]', 'edit the readme')
      await win.keyboard.press('Enter')
      await win.waitForSelector('[data-testid="chat-write-request"]', { timeout: 15000 })
      t.check('approval card appears', (await win.locator('[data-testid="chat-write-request"]').count()) === 1)
      const shownRequestId = await win.getAttribute('[data-testid="chat-write-request"]', 'data-request-id')
      t.check('approval card exposes shown request id', Boolean(shownRequestId))
      await app.evaluate(() => {
        globalThis.__approveCalls = []
      })
      await t.shot('02-card-shown')

      await win.click('[data-testid="chat-approve"]')
      await win.waitForFunction(() => document.body.innerText.includes('Edited README.md'), null, {
        timeout: 15000
      })
      const approveCalls = await app.evaluate(() => globalThis.__approveCalls)
      t.check(
        'chat approve control sends the shown request id',
        Array.isArray(approveCalls) && approveCalls.length === 1 && approveCalls[0][1] === shownRequestId,
        JSON.stringify(approveCalls)
      )
      const content = readFileSync(join(dir, 'README.md'), 'utf8')
      t.check('README.md edited after approval', content.includes('edited by test agent'))
      await t.shot('03-approved-edit')
    })

    await t.step('crew approve control in Agents mode sends the shown request id', async () => {
      writeFileSync(join(dir, 'README.md'), 'crew-start\n')
      await win.keyboard.press('Meta+1')
      await win.waitForSelector('[data-testid="agents-mode"]', { timeout: 8000 })
      await win.click('[data-testid="crew-new"]')
      await win.waitForSelector('[data-testid="crew-modal"]', { timeout: 5000 })
      await win.fill('[data-testid="crew-name-input"]', 'Checker')
      await win.selectOption('[data-testid="crew-agent-select"]', { label: 'Test Agent' })
      await win.click('[data-testid="crew-save"]')
      await win.waitForSelector('[data-testid="crew-modal"]', { state: 'detached', timeout: 5000 })
      await win.waitForSelector('[data-testid="crew-input"]', { timeout: 8000 })
      await win.fill('[data-testid="crew-input"]', 'edit the readme')
      await win.keyboard.press('Enter')
      await win.waitForSelector('[data-testid="crew-write-request"]', { timeout: 15000 })
      const shownCrewId = await win.getAttribute('[data-testid="crew-write-request"]', 'data-request-id')
      t.check('crew approval card exposes shown request id', Boolean(shownCrewId))
      await app.evaluate(() => {
        globalThis.__approveCalls = []
      })
      await win.click('[data-testid="crew-approve"]')
      await win.waitForFunction(() => document.body.innerText.includes('Edited README.md'), null, {
        timeout: 15000
      })
      const crewCalls = await app.evaluate(() => globalThis.__approveCalls)
      t.check(
        'crew approve control sends the shown request id',
        Array.isArray(crewCalls) && crewCalls.length === 1 && crewCalls[0][1] === shownCrewId,
        JSON.stringify(crewCalls)
      )
      await win.keyboard.press('Meta+3')
      await win.waitForSelector('[data-testid="chat-mode"]', { timeout: 8000 })
    })

    await t.step('a request replaced by a newer one cannot be approved with the old id', async () => {
      writeFileSync(join(dir, 'README.md'), 'fresh\n')

      await win.fill('[data-testid="chat-input"]', 'edit the readme first')
      await win.keyboard.press('Enter')
      await win.waitForSelector('[data-testid="chat-write-request"]', { timeout: 15000 })

      const first = await win.evaluate(async () => {
        const list = await window.regatta.invoke('chat:list')
        const conv = list[0]
        return { conversationId: conv?.id ?? null, requestId: conv?.pending?.id ?? null }
      })
      t.check('first request has an id', Boolean(first.conversationId && first.requestId))

      await win.fill('[data-testid="chat-input"]', 'edit the readme second')
      await win.keyboard.press('Enter')
      await win.waitForFunction(
        () => document.querySelector('[data-testid="chat-write-request"]')?.textContent?.includes('edit the readme second'),
        null,
        { timeout: 15000 }
      )

      const second = await win.evaluate(async () => {
        const list = await window.regatta.invoke('chat:list')
        const conv = list[0]
        return { requestId: conv?.pending?.id ?? null }
      })
      t.check('newer request has a different id', Boolean(second.requestId && second.requestId !== first.requestId))

      const refusal = await win.evaluate(async ({ conversationId, oldRequestId }) => {
        try {
          await window.regatta.invoke('chat:approve', conversationId, oldRequestId)
          return null
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }
      }, { conversationId: first.conversationId, oldRequestId: first.requestId })

      t.check(
        'old request id is refused',
        Boolean(refusal && refusal.includes('That request changed. Look at it again.')),
        refusal ?? 'not refused'
      )
      t.check('README.md was not edited by the refused approval', readFileSync(join(dir, 'README.md'), 'utf8') === 'fresh\n')
      await t.shot('04-stale-refused')
    })

    await t.step('background turn then Stop ends the helper process within 5 seconds', async () => {
      await win.fill('[data-testid="chat-input"]', 'background helper please')
      await win.keyboard.press('Enter')

      await win.waitForFunction(
        () => document.querySelector('[data-testid="chat-transcript"]')?.textContent?.includes('Started a helper.'),
        null,
        { timeout: 15000 }
      )
      t.check('pid file written by helper', existsSync(pidFile))
      const helperPid = Number(readFileSync(pidFile, 'utf8').trim())
      t.check('helper pid is valid', helperPid > 0, String(helperPid))

      try {
        await win.click('[data-testid="chat-send"]')
        const deadline = Date.now() + 5000
        while (Date.now() < deadline && isAlive(helperPid)) {
          await new Promise((r) => setTimeout(r, 50))
        }
        t.check('helper pid is gone within 5 seconds', !isAlive(helperPid), String(helperPid))
        await t.shot('05-stopped-helper')
      } finally {
        try {
          process.kill(helperPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    })
  } finally {
    try {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8').trim())
        if (pid > 0) process.kill(pid, 'SIGKILL')
      }
    } catch {
      // Already gone.
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors.
    }
  }

  return t.close()
}
