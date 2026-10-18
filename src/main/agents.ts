// Finds which agent CLIs are installed and their versions.

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { AGENTS, AGENT_ORDER } from '../shared/agents'
import type { AgentKind, DetectedAgent } from '../shared/types'

function run(file: string, args: string[], env: Record<string, string>, timeout = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

async function which(command: string, env: Record<string, string>): Promise<string | null> {
  const out = await run('/usr/bin/which', [command], env, 3000)
  const path = out?.trim().split('\n')[0]
  return path ? path : null
}

function firstLine(text: string | null): string | null {
  const line = text?.trim().split('\n')[0]?.trim()
  return line ? line.slice(0, 60) : null
}

export interface DetectOptions {
  /** Adds the internal test agent (used by e2e tests). */
  includeFake: boolean
  /** Folder that holds scripts/fake-agent.mjs. */
  appPath: string
}

export async function detectAgents(env: Record<string, string>, opts: DetectOptions): Promise<DetectedAgent[]> {
  const kinds: AgentKind[] = opts.includeFake ? [...AGENT_ORDER, 'fake'] : [...AGENT_ORDER]
  return Promise.all(
    kinds.map(async (kind): Promise<DetectedAgent> => {
      const def = AGENTS[kind]
      if (kind === 'shell') {
        return { ...def, installed: true, path: env['SHELL'] || '/bin/zsh', version: null }
      }
      if (kind === 'fake') {
        const node = await which('node', env)
        return { ...def, args: [join(opts.appPath, 'scripts', 'fake-agent.mjs')], installed: node !== null, path: node, version: 'test' }
      }
      const path = await which(def.command, env)
      const version = path ? firstLine(await run(path, ['--version'], env)) : null
      return { ...def, installed: path !== null, path, version }
    })
  )
}
