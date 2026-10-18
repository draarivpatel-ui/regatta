// The environment agents run in. Apps opened from the Dock do not get the user's shell PATH,
// so we ask the login shell once for its environment.

import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'

const DROP = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_RENDERER_URL'])

/**
 * Variables that aim git at another repository, folder, index or object store. This is exactly the
 * output of `git rev-parse --local-env-vars` (git 2.54), kept as a fixed list so a different git
 * on the user's machine cannot make it shorter.
 */
const GIT_LOCAL_ENV_VARS = [
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
  'GIT_COMMON_DIR'
]

/**
 * Other variables that change which repository, namespace or program git works with, or what a
 * ref update may touch. GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM and GIT_CONFIG_SYSTEM are not here
 * on purpose: they pick config files, and tests (and the shadow repository) rely on them.
 */
const GIT_ROUTING_EXTRA = [
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_EXEC_PATH',
  'GIT_QUARANTINE_PATH'
]

const GIT_ROUTING = new Set([...GIT_LOCAL_ENV_VARS, ...GIT_ROUTING_EXTRA])

/** GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n> (set with GIT_CONFIG_COUNT) inject config entries. */
const GIT_CONFIG_PAIR = /^GIT_CONFIG_(KEY|VALUE)_\d+$/

function isRepoRouting(name: string): boolean {
  // Windows variable names are case-insensitive.
  const upper = process.platform === 'win32' ? name.toUpperCase() : name
  return GIT_ROUTING.has(upper) || GIT_CONFIG_PAIR.test(upper)
}

/**
 * Copy of an environment without the variables that would aim git at a different repository than
 * the folder it is run in (an inherited GIT_WORK_TREE makes every status and check look at another
 * folder). Keeps everything else, GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM included.
 */
export function withoutRepoRouting<T extends NodeJS.ProcessEnv | Record<string, string>>(env: T): T {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    if (!isRepoRouting(k)) out[k] = v
  }
  return out as T
}

/**
 * Deletes the repository-routing variables from this process's own environment. src/main/index.ts
 * calls it first thing, so nothing started later (git, agents, checks) can inherit them.
 */
export function stripRepoRoutingFromProcess(): void {
  for (const k of Object.keys(process.env)) {
    if (isRepoRouting(k)) delete process.env[k]
  }
}

/** Copy of an environment without undefined values, Electron-only variables or repository-routing variables. */
export function cleanEnv(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || DROP.has(k) || isRepoRouting(k)) continue
    out[k] = v
  }
  return out
}

/** Parses `env -0` output (NUL separated KEY=value entries). */
export function parseEnv0(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of text.split('\0')) {
    const i = entry.indexOf('=')
    if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1)
  }
  return out
}

/** Resolves the user's login shell environment, falling back to our own after 6 seconds. */
export function loadShellEnv(): Promise<Record<string, string>> {
  const fallback = cleanEnv(process.env)
  if (process.platform === 'win32' || process.env['REGATTA_SKIP_LOGIN_ENV']) return Promise.resolve(fallback)
  const shell = process.env['SHELL'] || '/bin/zsh'
  const marker = '__REGATTA_ENV_MARK__'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s' '${marker}'; /usr/bin/env -0; printf '%s' '${marker}'`],
      { timeout: 6000, maxBuffer: 4 * 1024 * 1024, env: { ...fallback, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTART: 'false' } },
      (_err, stdout) => {
        const parts = typeof stdout === 'string' ? stdout.split(marker) : []
        if (parts.length >= 3 && parts[1]) {
          const env = cleanEnv(parseEnv0(parts[1]))
          if (env['PATH']) return resolve({ ...fallback, ...env })
        }
        resolve(fallback)
      }
    )
  })
}

/** The full path of an executable named `name` on the PATH in `env`, or null. */
export function findOnPath(name: string, env: Record<string, string>): string | null {
  for (const dir of (env['PATH'] ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}
