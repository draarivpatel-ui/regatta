import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanEnv } from './env'
import { runSearch } from './search'

const roots: string[] = []

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-search-'))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** Hides rg so the git grep or node fallback engine is picked. */
const noRgEnv = { ...cleanEnv(process.env), PATH: '/nonexistent' }

function gitBinDir(): string | null {
  try {
    return dirname(execFileSync('which', ['git'], { encoding: 'utf8' }).trim())
  } catch {
    return null
  }
}

function rgPath(): string | null {
  try {
    return execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

describe('runSearch: node fallback', () => {
  it('finds literal text with regex characters and skips node_modules', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'a.txt'), 'log a.b(c) here\n')
    writeFileSync(join(root, 'b.txt'), 'log axbx here\n')
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'skip.txt'), 'a.b(c)\n')
    const result = await runSearch(root, { text: 'a.b(c)' }, noRgEnv)
    expect(result.engine).toBe('node')
    expect(result.truncated).toBe(false)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toEqual({ path: 'a.txt', line: 1, column: 5, text: 'log a.b(c) here' })
  })

  it('treats the query as a pattern when regex is on', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'codes.txt'), 'error code 404\nerror code 418\nnothing here\n')
    const result = await runSearch(root, { text: 'code 4\\d\\d', regex: true }, noRgEnv)
    expect(result.engine).toBe('node')
    expect(result.matches.map((m) => m.line)).toEqual([1, 2])
    expect(result.matches[0]).toMatchObject({ path: 'codes.txt', column: 7 })
  })

  it('respects case sensitivity both ways', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'hello.txt'), 'Hello World\n')
    const loose = await runSearch(root, { text: 'hello' }, noRgEnv)
    expect(loose.matches).toHaveLength(1)
    const strict = await runSearch(root, { text: 'hello', caseSensitive: true }, noRgEnv)
    expect(strict.matches).toHaveLength(0)
    const exact = await runSearch(root, { text: 'Hello', caseSensitive: true }, noRgEnv)
    expect(exact.matches).toHaveLength(1)
  })

  it('stops at the limit and reports truncated', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'many.txt'), 'needle one\nneedle two\nneedle three\n')
    const result = await runSearch(root, { text: 'needle', limit: 2 }, noRgEnv)
    expect(result.truncated).toBe(true)
    expect(result.matches.map((m) => m.line)).toEqual([1, 2])
  })

  it('skips binary files and files over 1 MB', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'bin.dat'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2])]))
    writeFileSync(join(root, 'big.txt'), Buffer.concat([Buffer.alloc(1024 * 1024 + 1, 'x'), Buffer.from('needle')]))
    writeFileSync(join(root, 'text.txt'), 'needle\n')
    const result = await runSearch(root, { text: 'needle' }, noRgEnv)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.path).toBe('text.txt')
  })

  it('returns no matches for an empty query', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'a.txt'), 'needle\n')
    const result = await runSearch(root, { text: '' }, noRgEnv)
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(false)
  })
})

describe('runSearch: git grep', () => {
  const gitDir = gitBinDir()

  describe.skipIf(gitDir === null)('with git on PATH and rg hidden', () => {
    it('searches a git repository', async () => {
      const root = makeRoot()
      execFileSync('git', ['init', '-q'], { cwd: root })
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'app.ts'), 'const answer = 42\n')
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], { cwd: root })
      const result = await runSearch(root, { text: 'answer' }, { ...cleanEnv(process.env), PATH: gitDir as string })
      expect(result.engine).toBe('git-grep')
      expect(result.truncated).toBe(false)
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]).toEqual({ path: 'src/app.ts', line: 1, column: 7, text: 'const answer = 42' })
    })

    it('strips git routing variables from the environment before running git grep', async () => {
      const root = makeRoot()
      const decoy = makeRoot()
      for (const [dir, file, line] of [
        [root, 'in-root.ts', 'const targetNeedle = 1\n'],
        [decoy, 'in-decoy.ts', 'const targetNeedle = 2\n']
      ] as const) {
        execFileSync('git', ['init', '-q'], { cwd: dir })
        writeFileSync(join(dir, file), line)
        execFileSync('git', ['add', '-A'], { cwd: dir })
        execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: dir })
      }
      const env = {
        ...cleanEnv(process.env),
        PATH: gitDir as string,
        GIT_DIR: join(decoy, '.git'),
        GIT_WORK_TREE: decoy
      }
      const result = await runSearch(root, { text: 'targetNeedle' }, env)
      expect(result.engine).toBe('git-grep')
      expect(result.matches.map((m) => m.path)).toEqual(['in-root.ts'])
    })
  })
})

describe('runSearch: rg', () => {
  describe.skipIf(rgPath() === null)('with rg on PATH', () => {
    it('uses rg in a plain folder', async () => {
      const root = makeRoot()
      writeFileSync(join(root, 'a.txt'), 'needle in rg land\n')
      const result = await runSearch(root, { text: 'needle' }, cleanEnv(process.env))
      expect(result.engine).toBe('rg')
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]).toEqual({ path: 'a.txt', line: 1, column: 1, text: 'needle in rg land' })
    })
  })
})
