// Command lines for one chat turn.
// The table this follows is in docs/design/conversations.md. Pure logic, unit tested.

import type { Access, ChatAgent, Reasoning, Skill, Teammate } from '../../shared/chat'

export interface TurnArgs {
  /** What the user asked for. */
  text: string
  access: Access
  /** Empty means the CLI's own default model. */
  model?: string
  /** The CLI's own session id from an earlier turn, when the conversation has one. */
  sessionId?: string | null
  /** Crew member instructions and notes. Claude takes them as a system prompt, Codex reads them first. */
  instructions?: string | null
  /** Reasoning effort level. Empty or absent means the CLI's default. */
  reasoning?: Reasoning
}

/** Claude Code: stream-json output, no partial message flag off, plan or accept edits. */
function claudeArgs(opts: TurnArgs): string[] {
  const args = [
    '-p',
    opts.text,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    opts.access === 'read' ? 'plan' : 'acceptEdits'
  ]
  if (opts.sessionId) args.push('--resume', opts.sessionId)
  if (opts.instructions) args.push('--append-system-prompt', opts.instructions)
  if (opts.model) args.push('--model', opts.model)
  if (opts.reasoning) args.push('--effort', opts.reasoning)
  return args
}

/** Codex: exec for the first turn, exec resume for every one after it. */
function codexArgs(opts: TurnArgs): string[] {
  const args = ['exec']
  if (opts.reasoning) args.push('-c', `model_reasoning_effort=${opts.reasoning}`)
  if (opts.sessionId) args.push('resume', opts.sessionId)
  args.push('--json', '-s', opts.access === 'read' ? 'read-only' : 'workspace-write')
  if (opts.model) args.push('--model', opts.model)
  args.push(withInstructions(opts.text, opts.instructions))
  return args
}

/** The test agent, which never talks to a service. It also takes the access and the session id. */
function fakeArgs(opts: TurnArgs): string[] {
  const args = ['--chat', withInstructions(opts.text, opts.instructions), '--access', opts.access]
  if (opts.sessionId) args.push('--resume', opts.sessionId)
  return args
}

/** CLIs without a system prompt flag read the crew member's instructions as part of the request. */
function withInstructions(text: string, instructions: string | null | undefined): string {
  return instructions ? `${instructions}\n\n${text}` : text
}

/** The arguments after the agent's own leading arguments (the test agent's script path, for example). */
export function chatArgs(agent: ChatAgent, opts: TurnArgs): string[] {
  switch (agent) {
    case 'claude':
      return claudeArgs(opts)
    case 'codex':
      return codexArgs(opts)
    case 'fake':
      return fakeArgs(opts)
    default:
      throw new Error(`${agent} cannot chat yet.`)
  }
}

/** What a crew member is told about itself before every turn. `skills` are the ones it has. */
export function teammateInstructions(teammate: Teammate, skills: Skill[] = []): string {
  const parts = [`You are ${teammate.name}, ${teammate.role}.`]
  const instructions = teammate.instructions.trim()
  const memory = teammate.memory.trim()
  if (instructions) parts.push(instructions)
  const own = skills.filter((skill) => teammate.skills?.includes(skill.id) && skill.instructions.trim())
  if (own.length > 0) {
    parts.push(['Skills you have:', ...own.map((skill) => `## ${skill.name}\n${skill.instructions.trim()}`)].join('\n\n'))
  }
  if (memory) parts.push(`Notes you keep:\n${memory}`)
  return parts.join('\n\n')
}
