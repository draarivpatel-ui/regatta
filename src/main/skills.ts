// Skills: reusable instructions for crew members, kept in <dataDir>/skills.json.

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, realpathSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import type { ImportableSkill, Skill } from '../shared/chat'

/** Claude Code keeps one skill per folder as SKILL.md. */
const SKILLS_DIR = join('.claude', 'skills')
const SKILL_FILE = 'SKILL.md'
/** Importable skill files stay small; anything bigger is skipped. */
const MAX_IMPORT_BYTES = 64 * 1024

export interface SkillStoreDeps {
  dataDir: string
  /** Home folder, for Claude Code's skill folders (read only). */
  home: string
  emit: (skills: Skill[]) => void
  now?: () => number
}

export class SkillStore {
  private skills: Skill[] = []
  private readonly file: string
  private readonly now: () => number

  constructor(private readonly deps: SkillStoreDeps) {
    this.file = join(deps.dataDir, 'skills.json')
    this.now = deps.now ?? (() => Date.now())
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(parsed)) this.skills = parsed as Skill[]
    } catch {
      // A missing or broken file means no skills.
    }
  }

  list(): Skill[] {
    return [...this.skills]
  }

  save(skill: Pick<Skill, 'name' | 'description' | 'instructions'> & { id?: string }): Skill[] {
    const name = skill.name.trim()
    const description = skill.description.trim()
    const instructions = skill.instructions.trim()
    if (!name) throw new Error('Name is required.')
    if (name.length > 60) throw new Error('Name must be 60 characters or fewer.')
    if (description.length > 140) throw new Error('Description must be 140 characters or fewer.')
    if (!instructions) throw new Error('Instructions are required.')
    if (instructions.length > 20_000) throw new Error('Instructions must be 20,000 characters or fewer.')

    const existing = skill.id ? this.skills.find((s) => s.id === skill.id) : undefined
    if (skill.id && !existing) throw new Error('That skill no longer exists.')
    const clash = (candidate: string): boolean =>
      this.skills.some((s) => s.id !== skill.id && s.name.toLowerCase() === candidate.toLowerCase())
    if (clash(name)) throw new Error('That name is already used by another skill.')

    const now = this.now()
    if (existing) {
      existing.name = name
      existing.description = description
      existing.instructions = instructions
      existing.updatedAt = now
    } else {
      let id = randomBytes(4).toString('hex')
      while (this.skills.some((s) => s.id === id)) id = randomBytes(4).toString('hex')
      this.skills.push({ id, name, description, instructions, source: 'regatta', createdAt: now, updatedAt: now })
    }
    return this.persist()
  }

  remove(id: string): Skill[] {
    this.skills = this.skills.filter((s) => s.id !== id)
    return this.persist()
  }

  /** Claude Code skill folders on this computer that can be copied in. Never throws. */
  async importable(): Promise<ImportableSkill[]> {
    try {
      const skillsDir = join(this.deps.home, SKILLS_DIR)
      const found: ImportableSkill[] = []
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        const file = join(skillsDir, entry.name, SKILL_FILE)
        let stats
        try {
          stats = statSync(file)
        } catch {
          continue
        }
        if (!stats.isFile() || stats.size >= MAX_IMPORT_BYTES) continue
        const read = readSkillFile(file)
        if (!read) continue
        found.push({ name: read.name || entry.name, description: read.description, path: file })
      }
      found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      return found
    } catch {
      return []
    }
  }

  /** Copies one of the files `importable()` just found into Regatta's own skills. */
  async import(path: string): Promise<Skill[]> {
    const found = await this.importable()
    const wanted = safeReal(path)
    const match = found.find((s) => safeReal(s.path) === wanted)
    if (!match || !wanted) throw new Error('That skill file is not one Regatta found.')

    const read = readSkillFile(match.path)
    if (!read) throw new Error('That skill file is not one Regatta found.')

    const taken = (candidate: string): boolean =>
      this.skills.some((s) => s.name.toLowerCase() === candidate.toLowerCase())
    let name = read.name || basename(match.path)
    if (taken(name)) {
      name = `${name} (Claude Code)`
      let n = 2
      while (taken(name)) {
        name = `${read.name || basename(match.path)} (Claude Code) ${n}`
        n += 1
      }
    }
    const now = this.now()
    let id = randomBytes(4).toString('hex')
    while (this.skills.some((s) => s.id === id)) id = randomBytes(4).toString('hex')
    this.skills.push({
      id,
      name,
      description: read.description,
      instructions: read.body,
      source: 'claude',
      createdAt: now,
      updatedAt: now
    })
    return this.persist()
  }

  private persist(): Skill[] {
    mkdirSync(this.deps.dataDir, { recursive: true })
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify(this.skills, null, 2))
    renameSync(tmp, this.file)
    const list = this.list()
    this.deps.emit(list)
    return list
  }
}

function safeReal(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

interface FrontMatter {
  name: string
  description: string
  body: string
}

/** Reads a SKILL.md: optional YAML front matter between two `---` lines, then the body. */
function readSkillFile(file: string): FrontMatter | null {
  try {
    const lines = readFileSync(file, 'utf8').split('\n')
    const first = lines.findIndex((line) => line.trim() === '---')
    const second = first === -1 ? -1 : lines.findIndex((line, i) => i > first && line.trim() === '---')
    const meta: Record<string, string> = {}
    if (first !== -1 && second !== -1) {
      for (const line of lines.slice(first + 1, second)) {
        const idx = line.indexOf(':')
        if (idx === -1) continue
        const key = line.slice(0, idx).trim()
        let value = line.slice(idx + 1).trim()
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        ) {
          value = value.slice(1, -1)
        }
        if (key === 'name' || key === 'description') meta[key] = value
      }
      const body = lines.slice(second + 1).join('\n').trim()
      return { name: meta['name'] ?? '', description: meta['description'] ?? '', body }
    }
    return { name: '', description: '', body: lines.join('\n').trim() }
  } catch {
    return null
  }
}
