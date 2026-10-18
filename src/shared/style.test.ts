// House style checks that run with the unit tests.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const SKIP = new Set(['node_modules', 'out', 'dist', 'release', '.git', '.smoke', 'test-results'])
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
const EXT = /\.(ts|tsx|mjs|js|css|md|json|html)$/

function files(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...files(path))
    else if (EXT.test(name) && name !== 'package-lock.json') found.push(path)
  }
  return found
}

describe('house style', () => {
  it('uses no em dashes or en dashes anywhere', () => {
    const offenders: string[] = []
    for (const file of files(ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (DASHES.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
