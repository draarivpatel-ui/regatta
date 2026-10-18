// Backend for the Find panel.

import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { withoutRepoRouting } from './env'
import type { SearchMatch, SearchQuery, SearchResult } from '../shared/types'

const TIMEOUT_MS = 10_000
const MAX_COLUMNS = 300
const MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_LIMIT = 500
const SKIP_DIRS = new Set(['.git', 'node_modules'])

type RgRecord = {
  type?: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
    submatches?: { match?: { text?: string }; start?: number }[]
  }
}

interface ToolError extends Error {
  code?: number | string
  stdout?: string
}

/** Runs a search tool without a shell. Exit code 1 means "no matches", not an error. */
function runTool(cmd: string, args: string[], root: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: root, env, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          const toolErr = err as ToolError
          if (toolErr.code === 1) return resolve(typeof toolErr.stdout === 'string' ? toolErr.stdout : '')
          return reject(err)
        }
        resolve(stdout)
      }
    )
  })
}

/** Absolute path of the rg binary when it is on env.PATH, otherwise null. */
function findRg(env: Record<string, string>): string | null {
  for (const dir of (env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const name of process.platform === 'win32' ? ['rg.exe'] : ['rg']) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // keep looking
      }
    }
  }
  return null
}

function isGitRepo(root: string): boolean {
  return existsSync(join(root, '.git'))
}

function posix(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//, '')
}

async function searchRg(rg: string, root: string, query: SearchQuery, env: Record<string, string>): Promise<SearchResult> {
  const limit = query.limit ?? DEFAULT_LIMIT
  const args = ['--json', '--max-columns', String(MAX_COLUMNS), '--glob', '!node_modules', '--glob', '!.git']
  if (!query.regex) args.push('--fixed-strings')
  if (!query.caseSensitive) args.push('--ignore-case')
  args.push('--', query.text, '.')
  const out = await runTool(rg, args, root, env)
  const matches: SearchMatch[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    let record: RgRecord
    try {
      record = JSON.parse(line) as RgRecord
    } catch {
      continue
    }
    if (record.type !== 'match' || !record.data) continue
    const data = record.data
    const sub = data.submatches?.[0]
    const subText = sub?.match?.text ?? ''
    const lineText = (data.lines?.text ?? '').replace(/[\r\n]+$/, '')
    const text = lineText.slice(0, MAX_COLUMNS)
    const found = subText ? text.indexOf(subText) : -1
    const column = (found >= 0 ? found : Number(sub?.start ?? 0)) + 1
    matches.push({ path: posix(data.path?.text ?? ''), line: Number(data.line_number ?? 0), column, text })
  }
  return { matches: matches.slice(0, limit), truncated: matches.length > limit, engine: 'rg' }
}

async function searchGitGrep(root: string, query: SearchQuery, env: Record<string, string>): Promise<SearchResult> {
  const limit = query.limit ?? DEFAULT_LIMIT
  const args = ['grep', '-n', '--column', '-I']
  if (!query.regex) args.push('-F')
  if (!query.caseSensitive) args.push('-i')
  args.push('-e', query.text)
  const out = await runTool('git', args, root, withoutRepoRouting(env))
  const matches: SearchMatch[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const m = /^(.+):(\d+):(\d+):([\s\S]*)$/.exec(line)
    if (!m) continue
    matches.push({
      path: posix(m[1] ?? ''),
      line: Number(m[2]),
      column: Number(m[3]),
      text: (m[4] ?? '').slice(0, MAX_COLUMNS)
    })
  }
  return { matches: matches.slice(0, limit), truncated: matches.length > limit, engine: 'git-grep' }
}

/** Column of the first match of query in line, or null when the line does not match. */
function firstMatchColumn(line: string, query: SearchQuery): number | null {
  if (query.regex) {
    let re: RegExp
    try {
      re = new RegExp(query.text, query.caseSensitive ? '' : 'i')
    } catch {
      return null
    }
    const m = re.exec(line)
    return m ? m.index + 1 : null
  }
  const hay = query.caseSensitive ? line : line.toLowerCase()
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase()
  const at = hay.indexOf(needle)
  return at >= 0 ? at + 1 : null
}

function isTextFile(full: string): boolean {
  let size: number
  try {
    size = statSync(full).size
  } catch {
    return false
  }
  if (size > MAX_FILE_BYTES) return false
  let head: Buffer
  try {
    head = readFileSync(full).subarray(0, 8192)
  } catch {
    return false
  }
  return !head.includes(0)
}

function walk(root: string, visit: (path: string) => void): void {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) walk(full, visit)
    else if (entry.isFile()) visit(full)
  }
}

function searchNode(root: string, query: SearchQuery): SearchResult {
  const limit = query.limit ?? DEFAULT_LIMIT
  const matches: SearchMatch[] = []
  let truncated = false
  walk(root, (full) => {
    if (truncated) return
    if (!isTextFile(full)) return
    let text: string
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      return
    }
    const path = posix(relative(root, full))
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const column = firstMatchColumn(lines[i] ?? '', query)
      if (column == null) continue
      matches.push({ path, line: i + 1, column, text: (lines[i] ?? '').slice(0, MAX_COLUMNS) })
      if (matches.length >= limit) {
        truncated = true
        return
      }
    }
  })
  return { matches: matches.slice(0, limit), truncated, engine: 'node' }
}

/** Searches every text file under `root`. */
export async function runSearch(root: string, query: SearchQuery, env: Record<string, string>): Promise<SearchResult> {
  const rg = findRg(env)
  const useGit = rg == null && isGitRepo(root)
  const engine: SearchResult['engine'] = rg ? 'rg' : useGit ? 'git-grep' : 'node'
  if (!query.text) return { matches: [], truncated: false, engine }
  if (rg) return searchRg(rg, root, query, env)
  if (useGit) {
    try {
      return await searchGitGrep(root, query, env)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return searchNode(root, query)
      throw err
    }
  }
  return searchNode(root, query)
}
