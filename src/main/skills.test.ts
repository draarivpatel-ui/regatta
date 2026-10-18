// Unit tests for SkillStore: save, update, limits, remove, reload from disk, a broken
// file, importable discovery and import.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SkillStore } from './skills'
import type { Skill } from '../shared/chat'

const cleanup: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

interface Setup {
  store: SkillStore
  dataDir: string
  home: string
  emitted: Skill[][]
}

function setup(): Setup {
  const base = temp('regatta-skills-')
  const dataDir = join(base, 'data')
  const home = join(base, 'home')
  mkdirSync(dataDir, { recursive: true })
  const emitted: Skill[][] = []
  const store = new SkillStore({ dataDir, home, emit: (list) => emitted.push(list), now: () => 1700000000000 })
  return { store, dataDir, home, emitted }
}

function writeSkillFile(home: string, folder: string, content: string): string {
  const dir = join(home, '.claude', 'skills', folder)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, content, 'utf8')
  return file
}

describe('save and update', () => {
  it('adds a skill with a new id, source regatta and one emit', () => {
    const { store, emitted } = setup()
    const list = store.save({ name: 'Release checklist', description: 'Steps before a release', instructions: 'Run the tests.' })
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toHaveLength(8)
    expect(list[0]!.source).toBe('regatta')
    expect(list[0]!.createdAt).toBe(1700000000000)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toHaveLength(1)
  })

  it('trims the name, description and instructions', () => {
    const { store } = setup()
    const list = store.save({ name: '  Release checklist  ', description: '  Steps  ', instructions: '  Run the tests.  ' })
    expect(list[0]!.name).toBe('Release checklist')
    expect(list[0]!.description).toBe('Steps')
    expect(list[0]!.instructions).toBe('Run the tests.')
  })

  it('updates by id, keeping source and createdAt', () => {
    const { store } = setup()
    const first = store.save({ name: 'Release checklist', description: 'Steps', instructions: 'Run the tests.' })
    const id = first[0]!.id
    const updated = store.save({ id, name: 'Release checklist v2', description: 'More steps', instructions: 'Run the tests twice.' })
    expect(updated).toHaveLength(1)
    expect(updated[0]!.id).toBe(id)
    expect(updated[0]!.name).toBe('Release checklist v2')
    expect(updated[0]!.source).toBe('regatta')
    expect(updated[0]!.createdAt).toBe(first[0]!.createdAt)
    expect(updated[0]!.updatedAt).toBe(1700000000000)
  })

  it('refuses an update to an unknown id', () => {
    const { store } = setup()
    expect(() => store.save({ id: 'nope1234', name: 'A', description: '', instructions: 'x' })).toThrow(
      'That skill no longer exists.'
    )
  })
})

describe('validation', () => {
  it('rejects a missing or too long name', () => {
    const { store } = setup()
    expect(() => store.save({ name: '   ', description: '', instructions: 'x' })).toThrow('Name is required.')
    expect(() => store.save({ name: 'x'.repeat(61), description: '', instructions: 'x' })).toThrow(
      'Name must be 60 characters or fewer.'
    )
  })

  it('rejects a too long description', () => {
    const { store } = setup()
    expect(() => store.save({ name: 'A', description: 'x'.repeat(141), instructions: 'x' })).toThrow(
      'Description must be 140 characters or fewer.'
    )
  })

  it('rejects missing or too long instructions', () => {
    const { store } = setup()
    expect(() => store.save({ name: 'A', description: '', instructions: '  ' })).toThrow('Instructions are required.')
    expect(() => store.save({ name: 'A', description: '', instructions: 'x'.repeat(20_001) })).toThrow(
      'Instructions must be 20,000 characters or fewer.'
    )
  })

  it('rejects a duplicate name, ignoring case', () => {
    const { store } = setup()
    store.save({ name: 'Release checklist', description: '', instructions: 'one' })
    expect(() => store.save({ name: 'release checklist', description: '', instructions: 'two' })).toThrow(
      'That name is already used by another skill.'
    )
  })
})

describe('remove and disk', () => {
  it('removes the skill, writes the file and emits the full list', () => {
    const { store, dataDir, emitted } = setup()
    const list = store.save({ name: 'Release checklist', description: '', instructions: 'Run the tests.' })
    const after = store.remove(list[0]!.id)
    expect(after).toEqual([])
    expect(emitted[emitted.length - 1]).toEqual([])
    expect(readFileSync(join(dataDir, 'skills.json'), 'utf8')).toBe('[]')
    expect(readdirSync(dataDir)).toEqual(['skills.json'])
  })

  it('reloads skills from disk in a new store', () => {
    const { store, dataDir, home } = setup()
    store.save({ name: 'Release checklist', description: 'Steps', instructions: 'Run the tests.' })
    const again = new SkillStore({ dataDir, home, emit: () => undefined })
    expect(again.list()).toHaveLength(1)
    expect(again.list()[0]!.name).toBe('Release checklist')
  })

  it('treats a broken file as no skills', () => {
    const { dataDir, home } = setup()
    writeFileSync(join(dataDir, 'skills.json'), 'not json at all', 'utf8')
    const store = new SkillStore({ dataDir, home, emit: () => undefined })
    expect(store.list()).toEqual([])
  })
})

describe('importable', () => {
  it('finds skill folders and reads quoted front matter', async () => {
    const { store, home } = setup()
    writeSkillFile(home, 'alpha-skill', '---\nname: "Alpha helper"\ndescription: "Does alpha things"\n---\nBody of alpha.\n')
    writeSkillFile(home, 'beta-skill', '---\nname: Beta helper\ndescription: Does beta things\n---\nBody of beta.\n')
    const found = await store.importable()
    expect(found.map((s) => s.name)).toEqual(['Alpha helper', 'Beta helper'])
    expect(found[0]!.description).toBe('Does alpha things')
    expect(found[1]!.description).toBe('Does beta things')
    expect(found[0]!.path).toBe(join(home, '.claude', 'skills', 'alpha-skill', 'SKILL.md'))
  })

  it('falls back to the folder name when there is no front matter', async () => {
    const { store, home } = setup()
    writeSkillFile(home, 'plain', 'Just a body, no front matter.\n')
    const found = await store.importable()
    expect(found).toHaveLength(1)
    expect(found[0]!.name).toBe('plain')
    expect(found[0]!.description).toBe('')
  })

  it('skips a broken symlink, a directory and a file over 64 KB', async () => {
    const { store, home } = setup()
    writeSkillFile(home, 'good', '---\nname: Good\n---\nBody.\n')
    const brokenDir = join(home, '.claude', 'skills', 'broken')
    mkdirSync(brokenDir, { recursive: true })
    symlinkSync(join(home, 'nowhere', 'SKILL.md'), join(brokenDir, 'SKILL.md'))
    mkdirSync(join(home, '.claude', 'skills', 'folder-skill', 'SKILL.md'), { recursive: true })
    writeSkillFile(home, 'huge', `---\nname: Huge\n---\n${'x'.repeat(70_000)}`)
    const found = await store.importable()
    expect(found.map((s) => s.name)).toEqual(['Good'])
  })

  it('is empty when there is no skills folder, and never throws', async () => {
    const { store } = setup()
    expect(await store.importable()).toEqual([])
  })
})

describe('import', () => {
  it('copies a found skill file, body included', async () => {
    const { store, home } = setup()
    writeSkillFile(home, 'alpha-skill', '---\nname: "Alpha helper"\ndescription: "Does alpha things"\n---\nBody of alpha.\n')
    const found = await store.importable()
    const after = await store.import(found[0]!.path)
    expect(after).toHaveLength(1)
    expect(after[0]!.source).toBe('claude')
    expect(after[0]!.name).toBe('Alpha helper')
    expect(after[0]!.description).toBe('Does alpha things')
    expect(after[0]!.instructions).toBe('Body of alpha.')
  })

  it('refuses any path Regatta did not find, including tricks and files outside the skills folder', async () => {
    const { store, home } = setup()
    const file = writeSkillFile(home, 'alpha-skill', '---\nname: Alpha\n---\nBody.\n')
    const outside = join(home, 'elsewhere')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: Sneaky\n---\nBody.\n', 'utf8')
    await expect(store.import(join(outside, 'SKILL.md'))).rejects.toThrow('That skill file is not one Regatta found.')
    await expect(store.import(join(home, '.claude', 'skills', '..', '..', 'elsewhere', 'SKILL.md'))).rejects.toThrow(
      'That skill file is not one Regatta found.'
    )
    await expect(store.import(join(home, 'nope', 'SKILL.md'))).rejects.toThrow('That skill file is not one Regatta found.')
    // A path that leaves the skills folder through a found file still realpaths to itself, so it is accepted.
    await expect(store.import(file)).resolves.toHaveLength(1)
  })

  it('adds a suffix when the name is taken', async () => {
    const { store, home } = setup()
    store.save({ name: 'Alpha', description: '', instructions: 'Mine.' })
    writeSkillFile(home, 'alpha-skill', '---\nname: Alpha\n---\nTheir body.\n')
    const found = await store.importable()
    const first = await store.import(found[0]!.path)
    expect(first[1]!.name).toBe('Alpha (Claude Code)')
    const second = await store.import(found[0]!.path)
    expect(second[2]!.name).toBe('Alpha (Claude Code) 2')
    const third = await store.import(found[0]!.path)
    expect(third[3]!.name).toBe('Alpha (Claude Code) 3')
    expect(existsSync(join(home, '.claude', 'skills', 'alpha-skill', 'SKILL.md'))).toBe(true)
  })
})
