// Runs every scripts/e2e/*.test.mjs (or only the names given as arguments) against the built app.
// Usage: node scripts/e2e/run.mjs [name ...]   for example: node scripts/e2e/run.mjs core inbox

import { readdirSync } from 'node:fs'

const dir = new URL('.', import.meta.url)
const wanted = process.argv.slice(2)
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => wanted.length === 0 || wanted.includes(f.replace('.test.mjs', '')))
  .sort()

let failed = 0
let total = 0
for (const file of files) {
  console.log(`\n${file}`)
  const mod = await import(new URL(file, dir).href)
  let results = []
  try {
    results = await mod.default()
  } catch (err) {
    results = [{ label: `${file} crashed`, ok: false }]
    console.log(`  FAIL  ${file} crashed: ${String(err.message).split('\n')[0]}`)
  }
  total += results.length
  failed += results.filter((r) => !r.ok).length
}

console.log(failed ? `\n${failed} of ${total} checks failed` : `\nAll ${total} checks passed in ${files.length} file(s)`)
process.exit(failed ? 1 : 0)
