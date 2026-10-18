import { describe, expect, it } from 'vitest'
import type { Skill, Teammate } from '../../shared/chat'
import { REASONING_LEVELS } from '../../shared/chat'
import { chatArgs, teammateInstructions } from './args'

describe('chatArgs', () => {
  describe('claude', () => {
    it('runs the first turn in read mode', () => {
      expect(chatArgs('claude', { text: 'fix the bug', access: 'read' })).toEqual([
        '-p', 'fix the bug',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode', 'plan'
      ])
    })

    it('allows edits with write access', () => {
      expect(chatArgs('claude', { text: 'fix the bug', access: 'write' })).toContain('--permission-mode')
      expect(chatArgs('claude', { text: 'fix the bug', access: 'write' })).toContain('acceptEdits')
    })

    it('continues the session and picks a model on a later turn', () => {
      expect(chatArgs('claude', { text: 'more', access: 'read', sessionId: 'sess-1', model: 'opus' })).toEqual([
        '-p', 'more',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode', 'plan',
        '--resume', 'sess-1',
        '--model', 'opus'
      ])
    })

    it('appends crew member instructions as a system prompt', () => {
      expect(
        chatArgs('claude', { text: 'hello', access: 'read', instructions: 'You are Ada, reviewer.' })
      ).toEqual([
        '-p', 'hello',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode', 'plan',
        '--append-system-prompt', 'You are Ada, reviewer.'
      ])
    })

    it('adds reasoning effort when provided', () => {
      expect(chatArgs('claude', { text: 'think hard', access: 'read', reasoning: 'high' })).toEqual([
        '-p', 'think hard',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode', 'plan',
        '--effort', 'high'
      ])
    })

    it('includes reasoning on a resumed turn', () => {
      expect(chatArgs('claude', { text: 'more', access: 'read', sessionId: 'sess-1', reasoning: 'max' })).toEqual([
        '-p', 'more',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode', 'plan',
        '--resume', 'sess-1',
        '--effort', 'max'
      ])
    })
  })

  describe('codex', () => {
    it('runs the first turn in a read only sandbox', () => {
      expect(chatArgs('codex', { text: 'fix the bug', access: 'read' })).toEqual([
        'exec', '--json', '-s', 'read-only', 'fix the bug'
      ])
    })

    it('writes inside the folder with write access', () => {
      expect(chatArgs('codex', { text: 'fix the bug', access: 'write' })).toEqual([
        'exec', '--json', '-s', 'workspace-write', 'fix the bug'
      ])
    })

    it('resumes its own session with the same sandbox flag', () => {
      expect(chatArgs('codex', { text: 'more', access: 'write', sessionId: '0199abc' })).toEqual([
        'exec', 'resume', '0199abc', '--json', '-s', 'workspace-write', 'more'
      ])
    })

    it('adds a model when one is chosen', () => {
      expect(chatArgs('codex', { text: 'hello', access: 'read', model: 'gpt-5-codex' })).toEqual([
        'exec', '--json', '-s', 'read-only', '--model', 'gpt-5-codex', 'hello'
      ])
    })

    it('reads crew member instructions before the request', () => {
      expect(
        chatArgs('codex', { text: 'hello', access: 'read', instructions: 'You are Ada, reviewer.' })
      ).toEqual(['exec', '--json', '-s', 'read-only', 'You are Ada, reviewer.\n\nhello'])
    })

    it('adds reasoning effort before resume on first turn', () => {
      expect(chatArgs('codex', { text: 'think hard', access: 'read', reasoning: 'high' })).toEqual([
        'exec', '-c', 'model_reasoning_effort=high', '--json', '-s', 'read-only', 'think hard'
      ])
    })

    it('adds reasoning effort before resume on a resumed turn', () => {
      expect(chatArgs('codex', { text: 'more', access: 'write', sessionId: '0199abc', reasoning: 'max' })).toEqual([
        'exec', '-c', 'model_reasoning_effort=max', 'resume', '0199abc', '--json', '-s', 'workspace-write', 'more'
      ])
    })
  })

  describe('test agent', () => {
    it('gets the chat flag, the access and the session', () => {
      expect(chatArgs('fake', { text: 'hello', access: 'read', sessionId: 'abc' })).toEqual([
        '--chat', 'hello', '--access', 'read', '--resume', 'abc'
      ])
    })

    it('is told when it may write', () => {
      expect(chatArgs('fake', { text: 'edit it', access: 'write' })).toEqual(['--chat', 'edit it', '--access', 'write'])
    })

    it('ignores reasoning', () => {
      expect(chatArgs('fake', { text: 'hello', access: 'read', reasoning: 'high' })).toEqual([
        '--chat', 'hello', '--access', 'read'
      ])
    })
  })

  it('refuses an agent that cannot chat', () => {
    expect(() => chatArgs('gemini' as 'claude', { text: 'hello', access: 'read' })).toThrow(/cannot chat/)
  })
})

describe('teammateInstructions', () => {
  const teammate: Teammate = {
    id: 't1',
    name: 'Ada',
    role: 'Implementation and release review',
    instructions: 'Check the tests before you say yes.',
    agent: 'claude',
    memory: 'The build runs on port 5173.',
    createdAt: 0
  }

  it('names the crew member, then the instructions, then the notes', () => {
    expect(teammateInstructions(teammate)).toBe(
      'You are Ada, Implementation and release review.\n\nCheck the tests before you say yes.\n\nNotes you keep:\nThe build runs on port 5173.'
    )
  })

  it('leaves out parts the crew member does not have', () => {
    expect(teammateInstructions({ ...teammate, instructions: '', memory: '' })).toBe(
      'You are Ada, Implementation and release review.'
    )
  })

  it('adds the skills the crew member has, before its notes, and skips the rest', () => {
    const skill = (id: string, name: string, instructions: string): Skill => ({
      id,
      name,
      description: '',
      instructions,
      source: 'regatta',
      createdAt: 0,
      updatedAt: 0
    })
    const skills = [skill('s1', 'Release checklist', 'Run the tests.'), skill('s2', 'Other', 'Not hers.'), skill('s3', 'Empty', '  ')]
    expect(teammateInstructions({ ...teammate, skills: ['s1', 's3', 'missing'] }, skills)).toBe(
      'You are Ada, Implementation and release review.\n\nCheck the tests before you say yes.\n\nSkills you have:\n\n## Release checklist\nRun the tests.\n\nNotes you keep:\nThe build runs on port 5173.'
    )
  })
})
