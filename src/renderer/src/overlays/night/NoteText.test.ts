// What a note looks like when the git commands in it are read out of the sentence, and what the note
// renders as. The notes are the ones the engines write: src/main/nightwatch/engine.ts (a run of a night)
// and src/main/flows/engine.ts (a run of a flow). Both park the work under refs/regatta/discarded/ and
// name the command that brings it back.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NoteText, noteParts } from './NoteText'

/** The note a night leaves for a run it kept a copy of (nightwatch/engine.ts, cleanupRun). */
const NIGHT_REF = 'refs/regatta/discarded/night-abc123-1'
const NIGHT_NOTE =
  `Kept a copy of the run's work at ${NIGHT_REF} ` +
  `(restore the work with git branch night-abc123-1-restored ${NIGHT_REF}^1; git log ${NIGHT_REF} shows everything kept).`

/** The note a flow leaves, closed off by the parenthesis (flows/engine.ts, parkedSentence). */
const FLOW_REF = 'refs/regatta/discarded/flow-r7'
const FLOW_NOTE =
  `Kept a copy of the run's work at ${FLOW_REF} ` +
  `(restore the work with git branch flow-r7-restored ${FLOW_REF}^1). git log ${FLOW_REF} shows everything kept.`

/** The commands in a note, in order. */
function commands(note: string): string[] {
  return noteParts(note)
    .filter((part) => part.kind === 'command')
    .map((part) => part.text)
}

describe('the git commands in a note', () => {
  it('finds both commands of a night note, and keeps the words around them', () => {
    expect(commands(NIGHT_NOTE)).toEqual([
      `git branch night-abc123-1-restored ${NIGHT_REF}^1`,
      `git log ${NIGHT_REF}`
    ])
    expect(noteParts(NIGHT_NOTE).map((part) => part.text).join('')).toBe(NIGHT_NOTE)
  })

  it('finds both commands of a flow note, one closed by a parenthesis and one by a full stop', () => {
    expect(commands(FLOW_NOTE)).toEqual([`git branch flow-r7-restored ${FLOW_REF}^1`, `git log ${FLOW_REF}`])
    expect(noteParts(FLOW_NOTE).map((part) => part.text).join('')).toBe(FLOW_NOTE)
  })

  it('stops at the words of the sentence, so the note it names is the command and not the remark', () => {
    const parts = noteParts(NIGHT_NOTE)
    expect(parts.at(-1)).toEqual({ kind: 'text', text: ' shows everything kept).' })
    expect(parts[2]).toEqual({ kind: 'text', text: '; ' })
  })

  it('reads a placeholder branch name as part of the command, as the older notes wrote it', () => {
    const note = `Kept a copy of the run's work at refs/regatta/discarded/flow-r1 (restore it with git branch <name> refs/regatta/discarded/flow-r1).`
    expect(commands(note)).toEqual(['git branch <name> refs/regatta/discarded/flow-r1'])
  })

  it('leaves a note with nothing to run as one piece of text', () => {
    const notes = [
      'Branch regatta/flow-r1 was kept: it is checked out in a worktree.',
      'Missed: Regatta was not running at 01:00, when this night was due, so it was not started. Its tasks are back in the queue.',
      'The check changed tracked files, so its result does not match the committed change.'
    ]
    for (const note of notes) expect(noteParts(note)).toEqual([{ kind: 'text', text: note }])
  })

  it('reads git at work in a sentence as prose, not as something to paste', () => {
    expect(commands('Could not look at your folder, so nothing was merged. git status warned: something')).toEqual([])
    expect(commands('The merge stopped: git merge failed: conflicts in a.txt')).toEqual([])
    expect(commands('You can see what was kept with git log.')).toEqual([])
    expect(commands('Everything kept is listed by git log to see it.')).toEqual([])
  })
})

describe('a note on screen', () => {
  it('gives each command a code chip with a copy button of its own', () => {
    const html = renderToStaticMarkup(createElement(NoteText, { note: NIGHT_NOTE }))
    expect(html.match(/data-testid="copy-command"/g)).toHaveLength(2)
    expect(html.match(/data-testid="note-command"/g)).toHaveLength(2)
    expect(html).toContain(`>git branch night-abc123-1-restored ${NIGHT_REF}^1</code>`)
    expect(html).toContain(`>git log ${NIGHT_REF}</code>`)
    // The words that are not commands stay plain text.
    expect(html).toContain('Kept a copy of the run&#x27;s work at refs/regatta/discarded/night-abc123-1 (restore the work with ')
    expect(html).toContain(' shows everything kept).')
  })

  it('shows no chip at all for a note that names no command', () => {
    const note = 'Branch regatta/flow-r1 was kept: it is checked out in a worktree.'
    const html = renderToStaticMarkup(createElement(NoteText, { note }))
    expect(html).not.toContain('copy-command')
    expect(html).toContain(note)
  })
})
