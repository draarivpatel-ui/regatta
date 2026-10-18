#!/usr/bin/env node
// A tiny stdio MCP server for unit and end-to-end tests. Never calls any network service.

import { spawn } from 'node:child_process'
import readline from 'node:readline'

const args = process.argv.slice(2)
const hasFlag = (flag) => args.includes(flag)
const valueAfter = (flag) => {
  const idx = args.indexOf(flag)
  return idx >= 0 ? (args[idx + 1] ?? null) : null
}

const send = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

if (hasFlag('--exit')) {
  process.stderr.write('fake-mcp: configuration file is missing\n')
  process.stderr.write('fake-mcp: exiting before handshake\n')
  process.exit(2)
}

if (hasFlag('--hang')) {
  // Spawn a child in the same process group so tests can verify the whole group is cleaned up.
  const sleeper = spawn('sleep', ['60'], {
    stdio: 'ignore'
  })
  process.stderr.write(`fake-mcp: hanging (child_pid=${sleeper.pid ?? 0})\n`)
  setInterval(() => {}, 1000)
} else {
  if (hasFlag('--noisy')) {
    process.stdout.write('Starting fake MCP server on stdio...\n')
    process.stdout.write('[info] loading local tool definitions\n')
  }

  const envVar = valueAfter('--echo-env')
  const envVal = envVar ? (process.env[envVar] ?? '') : ''

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return

    // Notifications have no id and need no reply.
    if (!('id' in msg)) return

    if (hasFlag('--noisy')) {
      process.stdout.write(`[debug] handling ${String(msg.method)}\n`)
    }

    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: {
            name: envVal ? `fake-mcp-${envVal}` : 'fake-mcp',
            version: '1.0.0'
          }
        }
      })
      return
    }

    if (msg.method === 'tools/list') {
      if (hasFlag('--rpc-error')) {
        process.stderr.write('fake-mcp: tool registry failed to load\n')
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: 'Tool registry unavailable' }
        })
        return
      }

      const cursor = msg.params && typeof msg.params === 'object' ? msg.params.cursor : undefined

      if (hasFlag('--paginate')) {
        if (!cursor) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [{ name: 'page_one_tool', description: 'First page tool.' }],
              nextCursor: 'page-2'
            }
          })
        } else if (cursor === 'page-2') {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [{ name: 'page_two_tool', description: 'Second page tool.' }],
              nextCursor: 'page-3'
            }
          })
        } else {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [{ name: 'page_three_tool', description: 'Third page tool.' }]
            }
          })
        }
        return
      }

      if (hasFlag('--infinite-pages')) {
        const pageNum = cursor ? Number(String(cursor).replace('page-', '')) || 1 : 1
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [{ name: `tool_page_${pageNum}`, description: `Tool on page ${pageNum}.` }],
            nextCursor: `page-${pageNum + 1}`
          }
        })
        return
      }

      if (hasFlag('--long-desc')) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'verbose_tool',
                description: 'A'.repeat(450)
              }
            ]
          }
        })
        return
      }

      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'read_notes',
              description: envVal ? `Read notes (${envVal}).` : 'Read project notes from the workspace.'
            },
            {
              name: 'write_note',
              description: 'Append a short note to the workspace.'
            }
          ]
        }
      })
      return
    }

    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${String(msg.method)}` }
    })
  })
}
