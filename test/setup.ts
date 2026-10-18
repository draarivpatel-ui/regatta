// Runs before every unit test file (listed under setupFiles in vitest.config.mts).
//
// Many unit tests run git in throwaway repositories. Without this, that git reads the real ~/.gitconfig of
// whoever runs the tests: its global hooks, its commit signing, its ignore rules. So every test file gets a
// git config of its own with a fixed test identity, and the system config is switched off.
//
// The config text is the same file the end-to-end tests use for their fake home.

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'regatta-unit-gitconfig-'))
const config = join(dir, 'gitconfig')
copyFileSync(fileURLToPath(new URL('../scripts/e2e/standins/gitconfig', import.meta.url)), config)

process.env['GIT_CONFIG_GLOBAL'] = config
process.env['GIT_CONFIG_NOSYSTEM'] = '1'

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
