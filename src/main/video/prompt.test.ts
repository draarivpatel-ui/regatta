// The words an agent is given for one turn: the paths, the brief, then the request itself.

import { describe, expect, it } from 'vitest'
import type { PointNote } from '../../shared/video'
import { buildTurnPrompt, changeLine, turnNote } from './prompt'

const base = {
  videoFolder: '/data/videos/abc123',
  projectRoot: '/work/project',
  resourcesDir: '/app/resources/video',
  title: 'Regatta launch',
  brief: 'Show four agents side by side.',
  width: 1280,
  height: 720,
  fps: 30,
  kind: 'plan' as const
}

describe('buildTurnPrompt', () => {
  it('starts with the paths, the guide, the example, the title, the brief and the stage', () => {
    const prompt = buildTurnPrompt(base)
    expect(prompt).toContain('/data/videos/abc123')
    expect(prompt).toContain('/work/project')
    expect(prompt).toContain('/app/resources/video/AGENT_GUIDE.md')
    expect(prompt).toContain('/app/resources/video/example/index.html')
    expect(prompt).toContain('Title: Regatta launch')
    expect(prompt).toContain('Brief: Show four agents side by side.')
    expect(prompt).toContain('Stage: 1280 by 720 pixels, 30 fps.')
    expect(prompt).toContain('read only')
  })

  it('tells the agent never to touch the runtime files', () => {
    const prompt = buildTurnPrompt(base)
    expect(prompt).toContain('Never edit them')
    expect(prompt).toContain('never write outside the video folder')
  })

  it('asks for PLAN.md only on a plan turn', () => {
    expect(buildTurnPrompt(base)).toContain('Write PLAN.md for this video. Do not write index.html yet.')
    expect(buildTurnPrompt({ ...base, kind: 'build' })).toContain('Build index.html to match PLAN.md.')
    expect(buildTurnPrompt({ ...base, kind: 'revise' })).toContain('PLAN.md changed. Update index.html to match it.')
  })

  it('gives a fix turn the failing checks and says to fix the cause', () => {
    const prompt = buildTurnPrompt({
      ...base,
      kind: 'fix',
      failing: [{ name: 'stable', passed: false, detail: '12 of 28 frames rendered the same twice' }]
    })
    expect(prompt).toContain('- stable: 12 of 28 frames rendered the same twice')
    expect(prompt).toContain('Fix the cause.')
  })

  it('puts the failing details first and the order to fix the cause last', () => {
    const prompt = buildTurnPrompt({
      ...base,
      kind: 'fix',
      failing: [
        { name: 'loads', passed: false, detail: 'Script error: boom' },
        { name: 'stable', passed: false, detail: '12 of 28 frames rendered the same twice' }
      ]
    })
    expect(prompt.endsWith('The checks below failed.\n- loads: Script error: boom\n- stable: 12 of 28 frames rendered the same twice\nFix the cause.\n')).toBe(true)
  })
})

describe('changeLine', () => {
  const note: PointNote = {
    time: 4.2,
    scene: 'demo',
    selector: 'section[data-scene="demo"] > h1',
    text: 'Big words',
    x: 640,
    y: 300,
    note: 'make the title bigger'
  }

  it('reads exactly as the card words it', () => {
    expect(changeLine(note)).toBe(
      'At 4.2 s, in scene demo, the element section[data-scene="demo"] > h1 showing "Big words" (at 640, 300 on the stage): make the title bigger. Change only that.'
    )
  })

  it('names the time, the scene, the element, its text, the spot and the note', () => {
    const line = changeLine(note)
    expect(line).toContain('At 4.2 s')
    expect(line).toContain('in scene demo')
    expect(line).toContain('section[data-scene="demo"] > h1')
    expect(line).toContain('"Big words"')
    expect(line).toContain('(at 640, 300 on the stage)')
    expect(line).toContain('make the title bigger')
    expect(line.endsWith('Change only that.')).toBe(true)
  })

  it('does not double the full stop when the note has one', () => {
    expect(changeLine({ ...note, note: 'make the title bigger.' })).toContain('bigger. Change only that.')
    expect(changeLine({ ...note, note: 'make the title bigger.' })).not.toContain('..')
    expect(changeLine({ ...note, note: 'bigger?' })).toContain('bigger? Change only that.')
    expect(changeLine({ ...note, note: '  make it bigger  ' })).toContain(': make it bigger. Change only that.')
  })

  it('leaves out a scene or a selector it does not know', () => {
    const line = changeLine({ ...note, scene: null, selector: null })
    expect(line).not.toContain('in scene')
    expect(line).not.toContain('the element')
    expect(line).toBe('At 4.2 s, showing "Big words" (at 640, 300 on the stage): make the title bigger. Change only that.')
    expect(changeLine({ ...note, selector: null })).toBe(
      'At 4.2 s, in scene demo, showing "Big words" (at 640, 300 on the stage): make the title bigger. Change only that.'
    )
    expect(changeLine({ ...note, scene: null })).toBe(
      'At 4.2 s, the element section[data-scene="demo"] > h1 showing "Big words" (at 640, 300 on the stage): make the title bigger. Change only that.'
    )
  })
})

describe('turnNote', () => {
  it('summarises a turn in a line', () => {
    expect(turnNote('plan')).toBe('Write the plan')
    expect(turnNote('build')).toBe('Build the video')
    expect(turnNote('revise')).toBe('Match the edited plan')
    expect(turnNote('fix')).toBe('Fix a failed check')
    expect(
      turnNote('change', { time: 7, scene: 'a', selector: 'b', text: 'c', x: 1, y: 2, note: 'move it' })
    ).toBe('Change at 7 s: move it')
  })
})
