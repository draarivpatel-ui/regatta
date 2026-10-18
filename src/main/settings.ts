// Small JSON settings file in the app's user data folder.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Prefs, WorkspaceInfo } from '../shared/types'

interface StoredSettings {
  workspaceRoot: string | null
  recent: string[]
  prefs: Prefs
}

export const DEFAULT_PREFS: Prefs = { notifications: true, quietAfterSec: 8, confirmClosePane: false, theme: 'harbor', accent: null, labs: { video: false, board: false, anywhere: false }, welcomeSeen: false }

export class SettingsStore {
  private data: StoredSettings = { workspaceRoot: null, recent: [], prefs: { ...DEFAULT_PREFS } }
  private readonly file: string

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'regatta-settings.json')
    try {
      if (existsSync(this.file)) {
        const stored = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredSettings>
        this.data = { ...this.data, ...stored, prefs: { ...DEFAULT_PREFS, ...stored.prefs } }
      }
    } catch {
      // A broken settings file falls back to defaults.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  workspace(fallbackRoot: string): WorkspaceInfo {
    const root = this.data.workspaceRoot && existsSync(this.data.workspaceRoot) ? this.data.workspaceRoot : fallbackRoot
    return { root, name: basename(root) || root, recent: this.data.recent.filter((r) => r !== root) }
  }

  prefs(): Prefs {
    return this.data.prefs
  }

  setPrefs(patch: Partial<Prefs>): Prefs {
    this.data.prefs = { ...this.data.prefs, ...patch }
    this.save()
    return this.data.prefs
  }

  setWorkspace(root: string): void {
    this.data.workspaceRoot = root
    this.data.recent = [root, ...this.data.recent.filter((r) => r !== root)].slice(0, 8)
    this.save()
  }
}
