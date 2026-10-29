// Git helpers: status and worktrees.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { withoutRepoRouting } from './env'
import { sandboxGitArgs } from './heats/git-ops'
import type { GitChange, GitStatus, WorktreeInfo } from '../shared/types'

/** Git never needs longer than this here; anything slower is a hang, not a slow disk. */
const TIMEOUT_MS = 15_000

const NEED_COMMIT = 'Worktrees need a git repository with at least one commit'

const SANDBOX_ENV_OVERRIDES = {
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: ''
}

/** Runs git with an argument list (never a shell string) and returns its stdout. */
function git(args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv): Promise<string> {
  const env = { ...withoutRepoRouting({ ...process.env }), ...(extraEnv ?? {}) }
  return new Promise((done, fail) => {
    execFile('git', args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr).trim().split('\n').find((line) => line.trim().length > 0)
        fail(new Error(detail || `git ${args[0]} failed`))
        return
      }
      done(String(stdout))
    })
  })
}

/** Runs git and returns null instead of throwing when git says no. */
async function tryGit(args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    return await git(args, cwd, extraEnv)
  } catch {
    return null
  }
}

/** True when `root` sits inside a git work tree (a plain folder returns false). */
async function inWorkTree(root: string): Promise<boolean> {
  return (await tryGit(['rev-parse', '--is-inside-work-tree'], root))?.trim() === 'true'
}

/** True when `root` is inside a work tree that has at least one commit. */
async function isRepo(root: string): Promise<boolean> {
  if (!(await inWorkTree(root))) return false
  return (await tryGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root)) !== null
}

/** The top level folder of the repository `root` is in, or `root` itself. */
async function repoTop(root: string): Promise<string> {
  const top = await tryGit(['rev-parse', '--show-toplevel'], root)
  return top && top.trim() ? top.trim() : resolve(root)
}

/** Parses `git status --porcelain=v1 -z`: two-letter code, then the path, NUL separated. */
export function parsePorcelain(text: string): GitChange[] {
  const fields = text.split('\0')
  const changes: GitChange[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.length < 4) continue
    const status = field.slice(0, 2)
    changes.push({ status, path: field.slice(3) })
    // A rename or copy is followed by its old path in a second field.
    if (status.includes('R') || status.includes('C')) i++
  }
  return changes
}

/** Branch and changed files of the repository at `root`, or null when `root` is not a git repo. */
export async function gitStatus(root: string): Promise<GitStatus | null> {
  const baseSettings = await sandboxGitArgs(root, SANDBOX_ENV_OVERRIDES, true)
  if ((await tryGit([...baseSettings, 'rev-parse', '--is-inside-work-tree'], root, SANDBOX_ENV_OVERRIDES))?.trim() !== 'true') {
    return null
  }
  const settings = await sandboxGitArgs(root, SANDBOX_ENV_OVERRIDES)
  const branch = (await tryGit([...settings, 'rev-parse', '--abbrev-ref', 'HEAD'], root, SANDBOX_ENV_OVERRIDES))?.trim() ?? null
  // A read must not run user programs or fetch: sandboxGitArgs disables hooks, fsmonitor and filter drivers,
  // --no-optional-locks skips writing the index, and SANDBOX_ENV_OVERRIDES disables lazy fetch and transport.
  // Submodules are not entered: their own config (a clean filter) is out of reach of the sandbox flags.
  const changes = parsePorcelain(
    await git(
      ['--no-optional-locks', ...settings, '-c', 'submodule.recurse=false', '-c', 'diff.ignoreSubmodules=all', 'status', '--porcelain=v1', '-z', '--ignore-submodules=all'],
      root,
      SANDBOX_ENV_OVERRIDES
    )
  )
  return { branch, changes }
}

/** The folder every worktree Regatta creates lives under. */
export function worktreesDir(): string {
  const configured = process.env['REGATTA_WORKTREES_DIR']
  return resolve(configured && configured.trim() ? configured : join(homedir(), '.regatta', 'worktrees'))
}

/** Lowercase letters, digits and dashes only, so a name is always a legal folder. */
function cleanName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'agent'
}

/** Root of the worktrees for the repository at `root`: the repo folder name plus a path hash. */
async function repoWorktreesDir(root: string): Promise<string> {
  const top = await repoTop(root)
  const hash = createHash('sha256').update(top).digest('hex').slice(0, 8)
  const folder = `${cleanName(basename(top))}-${hash}`
  return join(worktreesDir(), folder)
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  return (await tryGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root)) !== null
}

/** Creates a new worktree of `root` on a new branch and returns where it lives. */
export async function createWorktree(root: string, name: string): Promise<WorktreeInfo> {
  if (!(await isRepo(root))) throw new Error(NEED_COMMIT)
  const folder = cleanName(name)
  const parent = await repoWorktreesDir(root)

  // A name already taken gets -2, -3 and so on, for the branch and the folder together.
  let slug = folder
  let branch = `regatta/${slug}`
  for (let n = 2; await branchExists(root, branch) || existsSync(join(parent, slug)); n++) {
    slug = `${folder}-${n}`
    branch = `regatta/${slug}`
  }

  const path = join(parent, slug)
  mkdirSync(parent, { recursive: true })
  await git(['worktree', 'add', '-b', branch, path, 'HEAD'], root)
  return { path, branch }
}