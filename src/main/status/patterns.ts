// Text patterns that reveal what an agent is doing when it offers no other signal.
// Each pattern is checked against the last few lines of plain text the agent printed.

import type { AgentKind } from '../../shared/types'

export interface Pattern {
  re: RegExp
  /** Short reason shown to the user. */
  label: string
}

/** The agent is asking the user something and is blocked until they answer. */
export const WAITING: Pattern[] = [
  { re: /\(y\/n\)|\[y\/N\]|\[Y\/n\]|\(yes\/no\)/i, label: 'asked a yes or no question' },
  { re: /do you want to (?:proceed|continue|make this edit|create|run|allow|apply)/i, label: 'asked to proceed' },
  { re: /allow (?:this|edits?|command|access|the tool)\b/i, label: 'asked for permission' },
  { re: /(?:needs?|requires?) (?:your )?(?:approval|permission)/i, label: 'needs approval' },
  { re: /waiting for (?:your )?(?:approval|confirmation|input)/i, label: 'waiting for input' },
  { re: /press enter to (?:continue|confirm)/i, label: 'press Enter to continue' },
  { re: /approve\?|\bapprove (?:this|the) (?:command|change|edit)/i, label: 'asked for approval' }
]

/** The agent says it is busy right now. */
export const WORKING: Pattern[] = [
  { re: /esc to (?:interrupt|cancel)/i, label: 'busy (shows esc to interrupt)' },
  { re: /\bworking\b.*\(\d+s/i, label: 'busy (shows a timer)' },
  { re: /\bthinking\b|\breasoning\b/i, label: 'thinking' },
  { re: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✶✳✢·]\s+\w+(?:ing|…)/u, label: 'busy (spinner)' }
]

/** A shell prompt at the end of the output: the shell is ready for a command. */
const SHELL_PROMPT = /(?:[%$#❯➜>]\s*)$/u

export function matchWaiting(text: string): Pattern | null {
  return WAITING.find((p) => p.re.test(text)) ?? null
}

export function matchWorking(text: string): Pattern | null {
  return WORKING.find((p) => p.re.test(text)) ?? null
}

export function looksLikeShellPrompt(agent: AgentKind, lastLine: string): boolean {
  return agent === 'shell' && SHELL_PROMPT.test(lastLine.trimEnd() + ' ')
}

/** An agent's own input prompt with nothing typed yet, for example a bare "> " line. */
export function looksLikeAgentPrompt(agent: AgentKind, lastLine: string): boolean {
  return agent !== 'shell' && /^\s*[>❯›]\s*$/u.test(lastLine)
}
