// Thread panel: the focused agent's transcript, live refresh, and the no transcript state.

import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

const PROMPT = 'Plan the release notes for 1.4'
const REPLY = 'Here is the draft:\n```md\n# 1.4 highlights\n- Faster startup\n```'
const FOLLOWUP = 'Follow-up reply 42 for the refresh check'

function line(value) {
  return `${JSON.stringify(value)}\n`
}

export default async function thread() {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-thread-e2e-'))
  const file = join(dir, 'transcript.jsonl')
  writeFileSync(
    file,
    line({ type: 'user', timestamp: Date.now(), message: { role: 'user', content: PROMPT } }) +
      line({
        type: 'assistant',
        timestamp: Date.now(),
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: REPLY },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/app.ts' } }
          ]
        }
      }),
    'utf8'
  )

  const t = await launch('thread')
  const { win } = t

  await t.step('test agent pane starts', async () => {
    await t.startAgent('Test Agent')
    t.check('one pane open', (await win.locator('[data-testid=pane]').count()) === 1)
  })

  await t.step('transcript reaches the panel', async () => {
    const id = await t.sessionId(0)
    await win.evaluate(
      ([sessionId, path]) => window.regatta.invoke('test:hook', sessionId, 'TranscriptForTest', { transcript_path: path }),
      [id, file]
    )
    await win.click('[data-testid=panel-thread]')
    await win.waitForSelector('[data-testid=side-panel-thread]', { timeout: 5000 })
    await win.waitForSelector('[data-testid=thread-panel]', { timeout: 5000 })
    await win.waitForFunction(
      (prompt) => document.querySelector('[data-testid=thread-panel]')?.textContent?.includes(prompt),
      PROMPT,
      { timeout: 8000 }
    )
    const text = await win.locator('[data-testid=thread-panel]').innerText()
    t.check('the prompt bubble shows', text.includes(PROMPT))
    t.check('the reply shows', text.includes('Here is the draft:'))
    t.check('the Bash tool line shows', text.includes('Bash: npm test'))
    t.check('the Edit tool line shows', text.includes('Edit: src/app.ts'))
    t.check('four thread messages', (await win.locator('[data-testid=thread-message]').count()) === 4)
    await t.shot('01-thread-panel')
  })

  await t.step('a new reply appears within the refresh time', async () => {
    appendFileSync(
      file,
      line({ type: 'assistant', timestamp: Date.now(), message: { role: 'assistant', content: FOLLOWUP } }),
      'utf8'
    )
    await win.waitForFunction((followup) => document.querySelector('[data-testid=thread-panel]')?.textContent?.includes(followup), FOLLOWUP, {
      timeout: 10000
    })
    t.check('the appended reply appears without reopening the panel', true)
  })

  await t.step('a shell pane has no transcript', async () => {
    await t.startAgent('Terminal')
    await win.waitForFunction(() => document.querySelectorAll('[data-testid=pane]').length === 2, undefined, { timeout: 10000 })
    await win.waitForSelector('[data-testid=thread-no-transcript]', { timeout: 10000 })
    const text = await win.locator('[data-testid=thread-no-transcript]').innerText()
    t.check(
      'the shell pane shows the no transcript message',
      text.includes('This agent does not keep a transcript Regatta can read yet. Claude Code does.'),
      text.slice(0, 60)
    )
    await t.shot('02-no-transcript')
  })

  return t.close()
}
