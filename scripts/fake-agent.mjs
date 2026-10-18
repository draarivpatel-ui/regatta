#!/usr/bin/env node
// A pretend coding agent for tests and demos. It never calls any AI service.
// Type a task and it "works" for a few seconds with a live status line.
// Type "ask" to get a yes or no question, "fail" to exit with an error, "quit" to exit cleanly.
// With --chat it answers one message on standard output (see chatWork below).

import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const out = (s) => process.stdout.write(s)
const err = (s) => process.stderr.write(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let awaitingAnswer = false
let busy = false

/**
 * Takes a `--mcp-config <file>` pair out of the arguments wherever it is, and says which MCP servers the
 * file lists. Agent tools (Settings > Agent tools) add this pair, and the rest of the arguments must
 * look as they did without it.
 */
function takeMcpConfig(args) {
  const at = args.indexOf('--mcp-config')
  if (at === -1) return args
  const file = args[at + 1]
  args.splice(at, file === undefined ? 1 : 2)
  let names = 'none'
  try {
    const keys = Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {})
    if (keys.length > 0) names = keys.join(', ')
  } catch {
    // unreadable: "none"
  }
  out(`MCP servers: ${names}\n`)
  return args
}

function parseArgs() {
  const args = takeMcpConfig(process.argv.slice(2))
  if (args[0] === '--headless' && args[1]) {
    return { headless: true, prompt: args[1] }
  }
  if (args[0] === '--chat' && args[1]) {
    const access = valueOf(args, '--access') === 'write' ? 'write' : 'read'
    return { chat: true, prompt: args[1], access, resume: valueOf(args, '--resume') }
  }
  return { headless: false, prompt: null }
}

function valueOf(args, flag) {
  const at = args.indexOf(flag)
  return at === -1 ? null : args[at + 1] ?? null
}

/**
 * One conversation turn. The session id comes first so the caller can continue the conversation,
 * "edit" with read access asks for write access instead of touching anything, "slow" takes five
 * seconds, and the last line is the token count.
 */
async function chatWork(text, access, resume) {
  out(`SESSION: ${resume || randomUUID()}\n`)
  if (text.toLowerCase().includes('background')) {
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    if (process.env.REGATTA_FAKE_PIDFILE && helper.pid) {
      writeFileSync(process.env.REGATTA_FAKE_PIDFILE, String(helper.pid))
    }
    out('Started a helper.\n')
    await sleep(30000)
  }
  if (text.toLowerCase().includes('slow')) await sleep(5000)
  out(`Echo: ${text}\n`)
  if (text.toLowerCase().includes('edit')) {
    if (access === 'write') {
      const readme = join(process.cwd(), 'README.md')
      appendFileSync(readme, 'edited by test agent\n')
      out('Edited README.md\n')
    } else {
      out('NEEDS WRITE: I would add a line to README.md\n')
    }
  }
  out('tokens: 42\n')
  process.exit(0)
}

// Video turns (see src/main/video/engine.ts): write a plan, or build by copying Regatta's example.
function videoWork(task) {
  if (task.includes('Write PLAN.md for this video')) {
    writeFileSync(
      join(process.cwd(), 'PLAN.md'),
      '# Plan\n\nRemember: every agent, side by side.\n\n1. panes, Side by side, 3 s\n2. status, Who needs you, 3 s\n3. checks, Checks decide, 3 s\n4. name, Regatta, 3 s\n'
    )
    err('Wrote PLAN.md\r\n')
    return true
  }
  const example = /(\/\S+\/example\/index\.html)/.exec(task)?.[1]
  if (example && /Build index\.html|Update index\.html|Change only that|Fix the cause/.test(task)) {
    let html = readFileSync(example, 'utf8')
    // A change request shows up in the first headline so tests can see that it happened.
    if (task.includes('Change only that')) html = html.replace('Every agent, side by side.', 'Every agent, changed by the test agent.')
    writeFileSync(join(process.cwd(), 'index.html'), html)
    err('Wrote index.html\r\n')
    return true
  }
  return false
}

async function headlessWork(task) {
  if (videoWork(task)) {
    err('tokens: 321\r\n')
    process.exit(0)
  }
  const scenario = process.env.REGATTA_FAKE_SCENARIO || 'good'
  const delayMs = Number(process.env.REGATTA_FAKE_DELAY_MS) || (scenario === 'slow' ? 4000 : 1000)
  const stepDelay = delayMs / 12

  // A pretend agent stuck in a loop: the same failing command, with a different duration each time.
  if (scenario === 'loop') {
    for (const seconds of ['0.84', '0.91', '0.79', '0.88', '0.83']) {
      err(`ran: npm test (exit 1) 3 failing tests in ${seconds}s\n`)
      await sleep(200)
    }
    err('tokens: 1234\n')
    process.exit(1)
  }

  const steps = ['Reading the project', 'Planning the change', 'Editing files', 'Running the tests']
  let tick = 0

  for (const step of steps) {
    for (let i = 0; i < 6; i++) {
      err(`\r\x1b[2K\x1b[36m${spin[tick++ % spin.length]}\x1b[0m ${step}… \x1b[2m(${Math.floor(tick / 5)}s)\x1b[0m`)
      await sleep(stepDelay)
    }
  }

  if (scenario === 'delete-tests') {
    const testDirs = ['test', 'tests', '__tests__', 'spec']
    for (const d of testDirs) {
      const fullPath = join(process.cwd(), d)
      if (existsSync(fullPath)) {
        rmSync(fullPath, { recursive: true, force: true })
      }
    }
    // Also delete test files in src
    function deleteTestFiles(dir) {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry)
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          deleteTestFiles(fullPath)
        } else if (entry.match(/\.(test|spec)\.(js|ts|tsx|jsx)$/)) {
          rmSync(fullPath, { force: true })
        }
      }
    }
    deleteTestFiles(join(process.cwd(), 'src'))
  }

  if (scenario === 'break-guard') {
    const guardPath = join(process.cwd(), 'GUARD.txt')
    if (existsSync(guardPath)) {
      rmSync(guardPath, { force: true })
    }
  }

  if (scenario !== 'no-change') {
    writeFileSync(join(process.cwd(), 'DONE.txt'), `done: ${task}`)
    const appPath = join(process.cwd(), 'src/app.js')
    mkdirSync(join(process.cwd(), 'src'), { recursive: true })
    appendFileSync(appPath, '// changed by test agent\n')
  }

  err(`\r\x1b[2K\x1b[32m✓\x1b[0m Finished "${task}". 21 tests pass.\r\n`)
  err('tokens: 1234\r\n')

  const exitCode = scenario === 'fail' ? 2 : 0
  process.exit(exitCode)
}

async function interactiveWork(task) {
  busy = true
  const steps = ['Reading the project', 'Planning the change', 'Editing files', 'Running the tests']
  let tick = 0
  for (const step of steps) {
    for (let i = 0; i < 6; i++) {
      out(`\r\x1b[2K\x1b[36m${spin[tick++ % spin.length]}\x1b[0m ${step}… \x1b[2m(${Math.floor(tick / 5)}s, esc to interrupt)\x1b[0m`)
      await sleep(120)
    }
  }
  out(`\r\x1b[2K\x1b[32m✓\x1b[0m Finished "${task}". 21 tests pass.\r\n\r\n> `)
  busy = false
}

const parsed = parseArgs()
if (parsed.headless) {
  headlessWork(parsed.prompt).catch((e) => {
    err(`Error: ${e.message}\r\n`)
    process.exit(1)
  })
} else if (parsed.chat) {
  chatWork(parsed.prompt, parsed.access, parsed.resume).catch((e) => {
    err(`Error: ${e.message}\r\n`)
    process.exit(1)
  })
} else {
  out('\x1b[1;36mTest Agent\x1b[0m 1.0  \x1b[2m(no AI, for trying Regatta)\x1b[0m\r\n')
  out('Type a task. Try \x1b[1mask\x1b[0m for a question, \x1b[1mquit\x1b[0m to exit.\r\n\r\n> ')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: '' })

  rl.on('line', async (line) => {
    const text = line.trim()
    if (text === 'quit') process.exit(0)
    if (text === 'fail') {
      out('\r\n\x1b[31mSomething went wrong.\x1b[0m\r\n')
      process.exit(3)
    }
    if (busy) return
    if (awaitingAnswer) {
      awaitingAnswer = false
      out(text.toLowerCase().startsWith('y') ? 'Overwriting package.json.\r\n' : 'Leaving package.json alone.\r\n')
      await interactiveWork('update package.json')
      return
    }
    if (text === 'ask') {
      awaitingAnswer = true
      out('Overwrite package.json? (y/n) ')
      return
    }
    if (!text) {
      out('> ')
      return
    }
    await interactiveWork(text)
  })
}