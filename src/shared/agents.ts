// Built-in agent definitions. Marks are our own two-letter monograms, not company logos.

import type { AgentDefinition, AgentKind } from './types'

export const AGENTS: Record<AgentKind, AgentDefinition> = {
  claude: {
    kind: 'claude',
    name: 'Claude Code',
    short: 'claude',
    command: 'claude',
    args: [],
    monogram: 'Cl',
    color: '#d9825b',
    signals: 'hooks'
  },
  codex: {
    kind: 'codex',
    name: 'Codex',
    short: 'codex',
    command: 'codex',
    args: [],
    monogram: 'Cx',
    color: '#e5e7eb',
    signals: 'notify'
  },
  gemini: {
    kind: 'gemini',
    name: 'Gemini CLI',
    short: 'gemini',
    command: 'gemini',
    args: [],
    monogram: 'Ge',
    color: '#8b9cf7',
    signals: 'output'
  },
  grok: {
    kind: 'grok',
    name: 'Grok',
    short: 'grok',
    command: 'grok',
    args: [],
    monogram: 'Gk',
    color: '#cbd5e1',
    signals: 'output'
  },
  cursor: {
    kind: 'cursor',
    name: 'Cursor Agent',
    short: 'cursor',
    command: 'cursor-agent',
    args: [],
    monogram: 'Cu',
    color: '#a3a3a3',
    signals: 'output'
  },
  aider: {
    kind: 'aider',
    name: 'Aider',
    short: 'aider',
    command: 'aider',
    args: [],
    monogram: 'Ai',
    color: '#4ade80',
    signals: 'output'
  },
  opencode: {
    kind: 'opencode',
    name: 'OpenCode',
    short: 'opencode',
    command: 'opencode',
    args: [],
    monogram: 'Oc',
    color: '#f0abfc',
    signals: 'output'
  },
  qwen: {
    kind: 'qwen',
    name: 'Qwen Code',
    short: 'qwen',
    command: 'qwen',
    args: [],
    monogram: 'Qw',
    color: '#a78bfa',
    signals: 'output'
  },
  amp: {
    kind: 'amp',
    name: 'Amp',
    short: 'amp',
    command: 'amp',
    args: [],
    monogram: 'Am',
    color: '#fb923c',
    signals: 'output'
  },
  shell: {
    kind: 'shell',
    name: 'Terminal',
    short: 'shell',
    command: '',
    args: [],
    monogram: '>_',
    color: '#94a3b8',
    signals: 'output'
  },
  fake: {
    kind: 'fake',
    name: 'Test Agent',
    short: 'test-agent',
    command: 'node',
    args: [],
    monogram: 'Ta',
    color: '#2dd4bf',
    signals: 'output',
    internal: true
  }
}

export const AGENT_ORDER: AgentKind[] = [
  'claude',
  'codex',
  'gemini',
  'grok',
  'cursor',
  'opencode',
  'qwen',
  'amp',
  'aider',
  'shell'
]
