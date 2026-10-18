import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDir, readFile, writeFile } from './files'

let root = ''
let outside = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rg-files-'))
  outside = mkdtempSync(join(tmpdir(), 'rg-files-out-'))

  writeFileSync(join(root, 'README.md'), '# Regatta\n')
  writeFileSync(join(root, 'notes.txt'), 'hello')
  writeFileSync(join(root, 'apple.txt'), 'a')
  writeFileSync(join(root, '.DS_Store'), 'finder')
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x00, 0x1a, 0x0a]))
  writeFileSync(join(root, 'huge.log'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), '')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export {}\n')
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n')

  writeFileSync(join(outside, 'secret.txt'), 'not yours')
  symlinkSync(outside, join(root, 'escape'), 'dir')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('listDir', () => {
  it('puts folders first, sorts each group without regard to case and skips heavy folders', async () => {
    const entries = await listDir(root, '')
    expect(entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:docs',
      'dir:escape',
      'dir:src',
      'file:apple.txt',
      'file:blob.bin',
      'file:huge.log',
      'file:notes.txt',
      'file:README.md'
    ])
    expect(entries.map((e) => e.path)).toEqual([
      'docs',
      'escape',
      'src',
      'apple.txt',
      'blob.bin',
      'huge.log',
      'notes.txt',
      'README.md'
    ])
    expect(entries.find((e) => e.name === 'notes.txt')?.size).toBe(5)
    expect(entries.find((e) => e.name === 'docs')?.size).toBeNull()
  })

  it('lists a folder inside the project', async () => {
    const entries = await listDir(root, 'docs')
    expect(entries).toEqual([{ name: 'guide.md', path: 'docs/guide.md', kind: 'file', size: 8 }])
  })
})

describe('paths that leave the project', () => {
  it('rejects a relative path that climbs out', async () => {
    await expect(listDir(root, '../')).rejects.toThrow('That path is outside the project')
    await expect(readFile(root, '../secret.txt')).rejects.toThrow('That path is outside the project')
    await expect(writeFile(root, '../escape.txt', 'no')).rejects.toThrow('That path is outside the project')
  })

  it('rejects an absolute path outside the root', async () => {
    await expect(readFile(root, join(outside, 'secret.txt'))).rejects.toThrow('That path is outside the project')
    await expect(writeFile(root, join(outside, 'secret.txt'), 'no')).rejects.toThrow('That path is outside the project')
    await expect(listDir(root, outside)).rejects.toThrow('That path is outside the project')
  })

  it('rejects a symlink that points at a folder outside the root', async () => {
    await expect(listDir(root, 'escape')).rejects.toThrow('That path is outside the project')
    await expect(readFile(root, 'escape/secret.txt')).rejects.toThrow('That path is outside the project')
    await expect(writeFile(root, 'escape/secret.txt', 'no')).rejects.toThrow('That path is outside the project')
  })
})

describe('readFile', () => {
  it('returns text', async () => {
    const file = await readFile(root, 'src/index.ts')
    expect(file.content).toBe('export {}\n')
    expect(file.size).toBe(10)
    expect(file.binary).toBe(false)
    expect(file.tooLarge).toBe(false)
    expect(file.path).toBe('src/index.ts')
  })

  it('calls a file with a NUL byte near the start binary', async () => {
    const file = await readFile(root, 'blob.bin')
    expect(file.binary).toBe(true)
    expect(file.tooLarge).toBe(false)
    expect(file.content).toBe('')
  })

  it('refuses a file over 2 MB', async () => {
    const file = await readFile(root, 'huge.log')
    expect(file.tooLarge).toBe(true)
    expect(file.binary).toBe(false)
    expect(file.content).toBe('')
    expect(file.size).toBeGreaterThan(2 * 1024 * 1024)
  })
})

describe('writeFile', () => {
  it('round trips a new file and an existing one', async () => {
    await writeFile(root, 'notes.txt', 'hello world')
    expect((await readFile(root, 'notes.txt')).content).toBe('hello world')

    await writeFile(root, 'src/added.ts', 'export const a = 1\n')
    expect((await readFile(root, 'src/added.ts')).content).toBe('export const a = 1\n')
  })

  it('needs the parent folder to exist already', async () => {
    await expect(writeFile(root, 'nowhere/file.txt', 'x')).rejects.toThrow()
  })
})