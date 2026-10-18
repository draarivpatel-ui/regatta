// Settings > Skills: create a skill, give it to a crew member, see "Used by" back in the list.

import { launch } from './lib.mjs'

export default async function skills() {
  const t = await launch('skills')
  const { win } = t

  await t.step('create a skill in Settings > Skills', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-skills]')
    await win.waitForSelector('[data-testid=skills-new]', { timeout: 5000 })
    await win.click('[data-testid=skills-new]')
    await win.waitForSelector('[data-testid=skills-editor]', { timeout: 5000 })
    await win.fill('[data-testid=skills-name]', 'Release checklist')
    await win.fill('[data-testid=skills-description]', 'Steps before tagging a release')
    await win.fill('[data-testid=skills-instructions]', 'Run the tests.\nBump the version.\nTag the commit.')
    await win.click('[data-testid=skills-save]')
    await win.waitForSelector('[data-testid^=skills-row-]', { timeout: 5000 })
    const text = await win.locator('[data-testid^=skills-row-]').first().innerText()
    t.check('skill row lists as not given to anyone', text.includes('Not given to anyone yet'), text.split('\n').pop())
    await t.shot('01-skills')
  })

  await t.step('give the skill to a crew member', async () => {
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
    await win.keyboard.press('Meta+1')
    await win.waitForSelector('[data-testid=agents-mode]', { timeout: 8000 })
    await win.click('[data-testid=crew-new]')
    await win.waitForSelector('[data-testid=crew-modal]', { timeout: 5000 })
    const box = win.locator('[data-testid^=crew-skill-]')
    await box.first().waitFor({ timeout: 5000 })
    await box.first().click()
    const checked = await box.first().isChecked()
    t.check('skill checkbox ticks in the crew modal', checked)
    await t.shot('02-crew-modal')
    await win.fill('[data-testid=crew-name-input]', 'Ada')
    await win.fill('[data-testid=crew-role-input]', 'Implementation and release review')
    await win.click('[data-testid=crew-save]')
    await win.waitForSelector('[data-testid=crew-modal]', { state: 'detached', timeout: 5000 })
    t.check('crew member saved with the skill', (await win.locator('[data-testid=crew-card]').count()) === 1)
  })

  await t.step('row says Used by Ada', async () => {
    await win.keyboard.press('Meta+,')
    await win.waitForSelector('[data-testid=settings-screen]', { timeout: 8000 })
    await win.click('[data-testid=settings-nav-skills]')
    await win.waitForSelector('[data-testid^=skills-row-]', { timeout: 5000 })
    await win.waitForFunction(
      () => document.querySelector('[data-testid^=skills-row-]')?.innerText.includes('Used by Ada'),
      null,
      { timeout: 5000 }
    )
    const text = await win.locator('[data-testid^=skills-row-]').first().innerText()
    t.check('row says Used by Ada', text.includes('Used by Ada'), text.split('\n').pop())
    await t.shot('03-used-by')
  })

  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  return t.close()
}
