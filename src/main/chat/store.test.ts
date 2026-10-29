import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Conversation, Teammate } from '../../shared/chat'
import { deleteConversationFile, loadConversations, loadTeammates, saveConversation, saveTeammates } from './store'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'regatta-chat-store-'))
}

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'Hello',
    agent: 'claude',
    model: '',
    cwd: '/work',
    access: 'read',
    cliSessionId: null,
    teammateId: null,
    messages: [],
    status: 'idle',
    pending: null,
    tokens: null,
    createdAt: 1,
    updatedAt: 2,
    error: null,
    ...patch
  }
}

describe('conversations on disk', () => {
  it('writes one file per conversation and reads them back', () => {
    const dataDir = tempDir()
    saveConversation(dataDir, conversation())
    saveConversation(dataDir, conversation({ id: 'c2', title: 'Second' }))

    expect(readdirSync(join(dataDir, 'chats')).sort()).toEqual(['c1.json', 'c2.json'])
    const loaded = loadConversations(dataDir)
    expect(loaded.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    expect(loaded.find((c) => c.id === 'c2')?.title).toBe('Second')
  })

  it('brings a conversation that was running back as idle', () => {
    const dataDir = tempDir()
    saveConversation(dataDir, conversation({ status: 'running' }))
    expect(loadConversations(dataDir)[0]?.status).toBe('idle')
  })

  it('keeps the messages, the session id and the token count', () => {
    const dataDir = tempDir()
    saveConversation(
      dataDir,
      conversation({
        cliSessionId: 'sess-9',
        tokens: 126,
        messages: [{ id: 'm1', role: 'user', text: 'hi', at: 3 }],
        pending: { id: 'w1', kind: 'workspace-write', request: 'edit the readme', summary: 'One line' }
      })
    )
    const loaded = loadConversations(dataDir)[0] as Conversation
    expect(loaded.cliSessionId).toBe('sess-9')
    expect(loaded.tokens).toBe(126)
    expect(loaded.messages).toEqual([{ id: 'm1', role: 'user', text: 'hi', at: 3 }])
    // The id comes back too, so the saved request can still be approved (sol-loop S12).
    expect(loaded.pending).toEqual({ id: 'w1', kind: 'workspace-write', request: 'edit the readme', summary: 'One line' })
  })

  it('drops a saved write request that has no id, since it could never be approved (sol-loop S12)', () => {
    const dataDir = tempDir()
    saveConversation(dataDir, conversation({ pending: { kind: 'workspace-write', request: 'edit the readme', summary: 'One line' } }))
    expect((loadConversations(dataDir)[0] as Conversation).pending).toBeNull()
  })

  it('keeps the chosen sign-in and reasoning effort, and drops an effort the agent does not offer (sol-loop S11)', () => {
    const dataDir = tempDir()
    saveConversation(dataDir, conversation({ account: 'claude-work', reasoning: 'high' }))
    saveConversation(dataDir, conversation({ id: 'c2', agent: 'codex', reasoning: 'max' }))
    const loaded = loadConversations(dataDir)
    expect(loaded.find((c) => c.id === 'c1')).toMatchObject({ account: 'claude-work', reasoning: 'high' })
    expect(loaded.find((c) => c.id === 'c2')).toMatchObject({ account: null, reasoning: '' })
  })

  it('skips a file it cannot read instead of losing the others', () => {
    const dataDir = tempDir()
    saveConversation(dataDir, conversation())
    writeFileSync(join(dataDir, 'chats', 'broken.json'), '{ not json')
    writeFileSync(join(dataDir, 'chats', 'notes.txt'), 'ignored')

    const loaded = loadConversations(dataDir)
    expect(loaded.map((c) => c.id)).toEqual(['c1'])
  })

  it('deletes one conversation by itself', () => {
    const dataDir = tempDir()
    saveConversation(dataDir, conversation())
    saveConversation(dataDir, conversation({ id: 'c2' }))
    deleteConversationFile(dataDir, 'c1')

    expect(loadConversations(dataDir).map((c) => c.id)).toEqual(['c2'])
  })

  it('has nothing to load from a folder that was never used', () => {
    expect(loadConversations(tempDir())).toEqual([])
  })
})

describe('crew members on disk', () => {
  const teammate: Teammate = {
    id: 't1',
    name: 'Ada',
    role: 'Reviewer',
    instructions: 'Check the tests.',
    agent: 'claude',
    memory: 'Port 5173.',
    createdAt: 10
  }

  it('saves the list to one file and reads it back', () => {
    const dataDir = tempDir()
    saveTeammates(dataDir, [teammate])

    expect(readdirSync(dataDir)).toEqual(['teammates.json'])
    expect(loadTeammates(dataDir)).toEqual([teammate])
  })

  it('replaces the whole list on every save', () => {
    const dataDir = tempDir()
    saveTeammates(dataDir, [teammate])
    saveTeammates(dataDir, [{ ...teammate, id: 't2', name: 'Grace' }])

    expect(loadTeammates(dataDir).map((t) => t.name)).toEqual(['Grace'])
  })

  it('skips entries without a name or an id', () => {
    const dataDir = tempDir()
    writeFileSync(join(dataDir, 'teammates.json'), JSON.stringify([{ id: 't1', name: 'Ada' }, { name: 'No id' }]))
    expect(loadTeammates(dataDir).map((t) => t.id)).toEqual(['t1'])
  })

  it('is empty when the file is broken or missing', () => {
    const dataDir = tempDir()
    writeFileSync(join(dataDir, 'teammates.json'), 'nope')
    expect(loadTeammates(dataDir)).toEqual([])
    expect(loadTeammates(tempDir())).toEqual([])
  })

  it('writes plain JSON a person can read', () => {
    const dataDir = tempDir()
    saveTeammates(dataDir, [teammate])
    expect(JSON.parse(readFileSync(join(dataDir, 'teammates.json'), 'utf8'))[0].name).toBe('Ada')
  })
})
