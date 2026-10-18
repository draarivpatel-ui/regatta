// Memory readout: after starting an agent the status strip shows a measured total.
import { launch } from './lib.mjs'

export default async function memory() {
  const t = await launch('memory')
  const { win } = t

  await t.step('memory readout shows a number', async () => {
    await t.startAgent('Test Agent')
    await win.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid=memory-readout]')
        const text = el?.textContent ?? ''
        return !text.includes('measuring') && /\d/.test(text)
      },
      undefined,
      { timeout: 15000 }
    )
    t.check('readout shows a number within 15 seconds', true)
  })

  return t.close()
}
