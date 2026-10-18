// The environment helpers: repository-routing variables are never inherited by git, agents or checks.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanEnv, stripRepoRoutingFromProcess, withoutRepoRouting } from './env'

/** Exactly what `git rev-parse --local-env-vars` prints (git 2.54), plus the other routing variables. */
const ROUTING = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_EXEC_PATH',
  'GIT_QUARANTINE_PATH',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_17',
  'GIT_CONFIG_VALUE_17'
]
const KEEP = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM', 'GIT_TERMINAL_PROMPT', 'PATH', 'HOME']

function sample(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [...ROUTING, ...KEEP]) env[name] = `value of ${name}`
  return env
}

describe('withoutRepoRouting', () => {
  it('removes every routing variable and keeps the config file selectors and everything else', () => {
    const out = withoutRepoRouting(sample())
    for (const name of ROUTING) expect(out, name).not.toHaveProperty(name)
    for (const name of KEEP) expect(out[name], name).toBe(`value of ${name}`)
  })

  it('does not change the environment it was given', () => {
    const env = sample()
    withoutRepoRouting(env)
    expect(env['GIT_WORK_TREE']).toBe('value of GIT_WORK_TREE')
  })
})

describe('cleanEnv', () => {
  it('drops the routing variables (the shell environment agents and checks get never carries them)', () => {
    const out = cleanEnv(sample())
    for (const name of ROUTING) expect(out, name).not.toHaveProperty(name)
    expect(out['PATH']).toBe('value of PATH')
  })
})

describe('stripRepoRoutingFromProcess', () => {
  const saved: Record<string, string | undefined> = {}
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('deletes them from process.env and leaves the rest', () => {
    for (const name of ['GIT_WORK_TREE', 'GIT_DIR', 'GIT_CONFIG_KEY_3', 'GIT_CONFIG_NOSYSTEM']) saved[name] = process.env[name]
    process.env['GIT_WORK_TREE'] = '/tmp/x'
    process.env['GIT_DIR'] = '/tmp/y'
    process.env['GIT_CONFIG_KEY_3'] = 'a.b'
    process.env['GIT_CONFIG_NOSYSTEM'] = '1'
    stripRepoRoutingFromProcess()
    expect(process.env['GIT_WORK_TREE']).toBeUndefined()
    expect(process.env['GIT_DIR']).toBeUndefined()
    expect(process.env['GIT_CONFIG_KEY_3']).toBeUndefined()
    expect(process.env['GIT_CONFIG_NOSYSTEM']).toBe('1')
  })
})
