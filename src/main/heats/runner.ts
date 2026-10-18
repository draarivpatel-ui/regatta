// Spawns coding agents in headless (non-interactive) mode and streams their activity and token usage.

import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentKind } from '../../shared/types'
import { supervise } from './procgroup'
import type { GroupSupervisor } from './procgroup'

export interface RunOptions {
  agent: AgentKind
  command: string
  baseArgs: string[]
  prompt: string
  cwd: string
  env: Record<string, string>
  allowCommands: boolean
  onActivity: (line: string) => void
  onTokens: (total: number) => void
  /** Told about each command the agent ran. */
  onCommand?: (c: { command: string; failed: boolean; output: string }) => void
}

export interface RunResult {
  exitCode: number | null
  durationMs: number
  tokens: number | null
  stopped: boolean
  /** True when some process of the agent's group could not be stopped. Its folder must be kept. */
  stuck?: boolean
  /** Why a guard did not start or stopped the run, shown to the user. */
  refused?: string
}

export interface RunHandle {
  done: Promise<RunResult>
  stop: () => void
}

export interface ParsedCommand {
  command: string
  failed: boolean
  output: string
}

const ANSI_REGEX = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g
const TOKENS_LINE_REGEX = /tokens:\s*(\d+)/i
const FAKE_COMMAND_REGEX = /^ran:\s*(.+?)\s*\(exit\s+(-?\d+)\)(?:\s(.*))?$/
const MAX_COMMAND_OUTPUT = 4096

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '')
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function tailOutput(text: string): string {
  return text.length > MAX_COMMAND_OUTPUT ? text.slice(-MAX_COMMAND_OUTPUT) : text
}

function cleanLine(line: string): string | null {
  const stripped = stripAnsi(line).trim()
  if (!stripped) return null
  return truncate(stripped, 200)
}

function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (part && typeof part === 'object' && (part as Record<string, unknown>)['type'] === 'text') {
        const text = (part as Record<string, unknown>)['text']
        if (typeof text === 'string') parts.push(text)
      }
    }
    return parts.join('\n')
  }
  return ''
}

function parseClaudeBlock(
  block: Record<string, unknown>,
  pendingBash?: Map<string, string>,
  commands?: ParsedCommand[]
): string | undefined {
  if (block['type'] === 'tool_use') {
    const name = typeof block['name'] === 'string' ? block['name'] : ''
    if (name === 'Bash' && pendingBash && typeof block['id'] === 'string') {
      const input = block['input']
      if (input && typeof input === 'object') {
        const cmd = (input as Record<string, unknown>)['command']
        if (typeof cmd === 'string') pendingBash.set(block['id'], cmd)
      }
    }
    if (name) return `Using ${name}`
  }
  if (block['type'] === 'tool_result' && pendingBash && commands) {
    const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : ''
    const command = id ? pendingBash.get(id) : undefined
    if (command !== undefined) {
      pendingBash.delete(id)
      commands.push({
        command,
        failed: block['is_error'] === true,
        output: tailOutput(extractResultText(block['content']))
      })
    }
  }
  if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text']) {
    return block['text'].trim()
  }
  return undefined
}

function parseClaudeStreamJson(
  line: string,
  pendingBash?: Map<string, string>
): { activity?: string; tokens?: number; commands?: ParsedCommand[] } {
  try {
    const data = JSON.parse(line)
    const commands: ParsedCommand[] = []
    let activity: string | undefined

    if ((data.type === 'assistant' || data.type === 'user') && data.message && Array.isArray(data.message.content)) {
      for (const block of data.message.content) {
        if (block && typeof block === 'object') {
          const act = parseClaudeBlock(block as Record<string, unknown>, pendingBash, commands)
          if (act && !activity) activity = act
        }
      }
    } else if (data.type === 'tool_use' || data.type === 'tool_result') {
      const act = parseClaudeBlock(data as Record<string, unknown>, pendingBash, commands)
      if (act) activity = act
    }

    let tokens: number | undefined
    if (data.type === 'result' && data.usage) {
      const input = data.usage.input_tokens ?? 0
      const output = data.usage.output_tokens ?? 0
      const cacheRead = data.usage.cache_read_input_tokens ?? 0
      const cacheWrite = data.usage.cache_creation_input_tokens ?? 0
      tokens = input + output + cacheRead + cacheWrite
    }

    const out: { activity?: string; tokens?: number; commands?: ParsedCommand[] } = {}
    if (activity) out.activity = activity
    if (tokens !== undefined) out.tokens = tokens
    if (commands.length > 0) out.commands = commands
    return out
  } catch {
  }
  return {}
}

function parseCodexJson(line: string): { activity?: string; tokens?: number; command?: ParsedCommand } {
  try {
    const data = JSON.parse(line)
    if (data.type === 'item.completed' && data.item && typeof data.item === 'object') {
      const item = data.item as Record<string, unknown>
      if (item['type'] === 'command_execution' && typeof item['command'] === 'string') {
        const exitCode = item['exit_code']
        const status = item['status']
        const failed =
          (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0) || status === 'failed'
        const rawOut = typeof item['aggregated_output'] === 'string' ? item['aggregated_output'] : ''
        return {
          command: {
            command: item['command'],
            failed,
            output: tailOutput(rawOut)
          }
        }
      }
      if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
        const text = item['text'].trim()
        return text ? { activity: text } : {}
      }
    }
    if (data.type === 'turn.completed' && data.usage && typeof data.usage === 'object') {
      const usage = data.usage as Record<string, unknown>
      const input = typeof usage['input_tokens'] === 'number' && Number.isFinite(usage['input_tokens']) ? usage['input_tokens'] : 0
      const output = typeof usage['output_tokens'] === 'number' && Number.isFinite(usage['output_tokens']) ? usage['output_tokens'] : 0
      return { tokens: input + output }
    }
    if (data.message) {
      return { activity: String(data.message).trim() }
    }
    if (data.text) {
      return { activity: String(data.text).trim() }
    }
    if (data.total_token_usage != null) {
      return { tokens: data.total_token_usage }
    }
    if (data.token_count != null) {
      return { tokens: data.token_count }
    }
  } catch {
  }
  return {}
}

function parseFakeCommandLine(line: string): ParsedCommand | null {
  const stripped = stripAnsi(line).replace(/\r$/, '')
  const match = FAKE_COMMAND_REGEX.exec(stripped)
  if (!match) return null
  const command = (match[1] ?? '').trim()
  const exitCode = Number(match[2])
  const output = tailOutput(match[3] ?? '')
  return {
    command,
    failed: exitCode !== 0,
    output
  }
}

/** Command line arguments for an agent in headless mode. Pure, unit tested. */
export function headlessArgs(agent: AgentKind, prompt: string, cwd: string, allowCommands: boolean): string[] {
  switch (agent) {
    case 'claude': {
      const permMode = allowCommands ? 'bypassPermissions' : 'acceptEdits'
      return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', permMode]
    }
    case 'codex': {
      const args = ['exec', '--json', '-s', 'workspace-write']
      if (allowCommands) args.push('--approve-for-me')
      args.push(prompt)
      return args
    }
    case 'grok': {
      const args = ['--cwd', cwd]
      if (allowCommands) args.push('--always-approve')
      args.push(prompt)
      return args
    }
    case 'opencode': {
      const args = ['run', '--dir', cwd]
      if (allowCommands) args.push('--auto')
      args.push(prompt)
      return args
    }
    case 'gemini': {
      const approvalMode = allowCommands ? 'yolo' : 'auto_edit'
      return ['-p', prompt, '--approval-mode', approvalMode]
    }
    case 'fake': {
      return ['--headless', prompt]
    }
    default: {
      const agentNames: Record<AgentKind, string> = {
        claude: 'Claude Code',
        codex: 'Codex',
        gemini: 'Gemini CLI',
        grok: 'Grok',
        cursor: 'Cursor Agent',
        aider: 'Aider',
        opencode: 'OpenCode',
        qwen: 'Qwen Code',
        amp: 'Amp',
        shell: 'Terminal',
        fake: 'Test Agent'
      }
      throw new Error(`${agentNames[agent] ?? agent} cannot race yet`)
    }
  }
}

export function runAgent(opts: RunOptions): RunHandle {
  const { agent, command, baseArgs, prompt, cwd, env, allowCommands, onActivity, onTokens, onCommand } = opts
  const args = [...baseArgs, ...headlessArgs(agent, prompt, cwd, allowCommands)]

  let stopped = false
  let tokens: number | null = null
  let child: ChildProcess | null = null
  let group: GroupSupervisor | null = null
  const pendingBash = new Map<string, string>()
  const startTime = Date.now()

  const donePromise = new Promise<RunResult>((resolve) => {
    child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      // Its own process group, so that stopping the agent stops everything it started too.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    group = supervise(child)

    const handleLine = (line: string, stream: 'stdout' | 'stderr') => {
      if (agent === 'claude' && stream === 'stdout') {
        const parsed = parseClaudeStreamJson(line, pendingBash)
        if (parsed.activity) {
          const cleaned = cleanLine(parsed.activity)
          if (cleaned) onActivity(cleaned)
        }
        if (parsed.commands && onCommand) {
          for (const cmd of parsed.commands) onCommand(cmd)
        }
        if (parsed.tokens != null && parsed.tokens !== tokens) {
          tokens = parsed.tokens
          onTokens(tokens)
        }
        return
      }

      if (agent === 'codex' && stream === 'stdout') {
        const parsed = parseCodexJson(line)
        if (parsed.activity) {
          const cleaned = cleanLine(parsed.activity)
          if (cleaned) onActivity(cleaned)
        }
        if (parsed.command && onCommand) {
          onCommand(parsed.command)
        }
        if (parsed.tokens != null && parsed.tokens !== tokens) {
          tokens = parsed.tokens
          onTokens(tokens)
        }
        return
      }

      const tokenMatch = line.match(TOKENS_LINE_REGEX)
      if (tokenMatch) {
        const total = Number(tokenMatch[1])
        if (total !== tokens) {
          tokens = total
          onTokens(tokens)
        }
      }

      if (onCommand) {
        const cmd = parseFakeCommandLine(line)
        if (cmd) onCommand(cmd)
      }

      const cleaned = cleanLine(line)
      if (cleaned) onActivity(cleaned)
    }

    let stdoutBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      let newlineIndex
      while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex)
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        handleLine(line, 'stdout')
      }
    })

    let stderrBuffer = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8')
      let newlineIndex
      while ((newlineIndex = stderrBuffer.indexOf('\n')) !== -1) {
        const line = stderrBuffer.slice(0, newlineIndex)
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1)
        handleLine(line, 'stderr')
      }
    })

    child.on('error', (err) => {
      onActivity(`Spawn error: ${err.message}`)
      resolve({ exitCode: null, durationMs: Date.now() - startTime, tokens, stopped })
    })

    // Done only once the agent and every process of its group are gone.
    void group.done.then((code) => {
      if (stdoutBuffer) handleLine(stdoutBuffer, 'stdout')
      if (stderrBuffer) handleLine(stderrBuffer, 'stderr')
      resolve({ exitCode: code, durationMs: Date.now() - startTime, tokens, stopped, ...(group?.stuck ? { stuck: true } : {}) })
    })
  })

  function stop(): void {
    if (stopped || !group) return
    stopped = true
    group.stop()
  }

  return { done: donePromise, stop }
}

export { parseClaudeStreamJson, parseCodexJson, parseFakeCommandLine, cleanLine, stripAnsi }
