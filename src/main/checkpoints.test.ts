// Unit tests for checkpoints: shadow-repo snapshots, roll back and redo.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Checkpoints, parseNumstat } from './checkpoints'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000 })
}

const cleanupDirs: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanupDirs.push(dir)
  return dir
}

function makeRepo(): string {
  const dir = temp('regatta-chk-repo-')
  git(['init', '-b', 'main'], dir)
  writeFileSync(join(dir, 'a.txt'), 'a original\n')
  writeFileSync(join(dir, 'c.txt'), 'c original\n')
  git(['add', '.'], dir)
  git([...IDENTITY, 'commit', '-m', 'initial commit'], dir)
  return dir
}

afterAll(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseNumstat', () => {
  it('parses empty or whitespace output', () => {
    expect(parseNumstat('')).toEqual([])
    expect(parseNumstat('  \n')).toEqual([])
  })

  it('parses additions, removals, and binary files', () => {
    const raw = ['10\t5\tfile.ts', '-\t-\timage.png', '0\t2\tdeleted.txt', ''].join('\0')
    expect(parseNumstat(raw)).toEqual([
      { path: 'file.ts', added: 10, removed: 5 },
      { path: 'image.png', added: 0, removed: 0 },
      { path: 'deleted.txt', added: 0, removed: 2 }
    ])
  })

  it('handles rename token format as delete plus add', () => {
    const raw = ['5\t3\t', 'old.txt', 'new.txt', ''].join('\0')
    expect(parseNumstat(raw)).toEqual([
      { path: 'old.txt', added: 0, removed: 3 },
      { path: 'new.txt', added: 5, removed: 0 }
    ])
  })
})

describe('Checkpoints', () => {
  it('records steps, rolls back, and redoes without modifying project git', async () => {
    const baseDir = temp('regatta-chk-base-')
    const cwd = makeRepo()

    const headBefore = git(['rev-parse', 'HEAD'], cwd).trim()
    const branchBefore = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim()

    const changedSessions: string[] = []
    const checkpoints = new Checkpoints({
      baseDir: () => baseDir,
      emitChanged: (id) => changedSessions.push(id)
    })

    // 1. Step start
    await checkpoints.stepStart('sess-1', 'fake', cwd, 'first step')

    // 2. Edit a.txt, create b.txt, delete c.txt
    writeFileSync(join(cwd, 'a.txt'), 'a edited by agent\n')
    writeFileSync(join(cwd, 'b.txt'), 'b created by agent\n')
    unlinkSync(join(cwd, 'c.txt'))

    // 3. Step end
    await checkpoints.stepEnd('sess-1')

    const steps = checkpoints.list('sess-1')
    expect(steps).toHaveLength(1)
    const step = steps[0]!
    expect(step.sessionId).toBe('sess-1')
    expect(step.label).toBe('first step')
    expect(step.rolledBack).toBe(false)
    expect(step.files).toHaveLength(3)

    const filePaths = step.files.map((f) => f.path).sort()
    expect(filePaths).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(changedSessions).toContain('sess-1')

    // 4. Edit a.txt again by hand
    writeFileSync(join(cwd, 'a.txt'), 'a edited by human\n')

    // 5. Rollback
    const rollbackResult = await checkpoints.rollback(step.id)
    expect(rollbackResult.stepId).toBe(step.id)
    expect(rollbackResult.verified).toBe(true)

    const aRollback = rollbackResult.files.find((f) => f.path === 'a.txt')
    expect(aRollback?.action).toBe('kept')
    expect(aRollback?.note).toBe('you edited it since')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a edited by human\n')

    const bRollback = rollbackResult.files.find((f) => f.path === 'b.txt')
    expect(bRollback?.action).toBe('rewound')
    expect(existsSync(join(cwd, 'b.txt'))).toBe(false)

    const cRollback = rollbackResult.files.find((f) => f.path === 'c.txt')
    expect(cRollback?.action).toBe('rewound')
    expect(readFileSync(join(cwd, 'c.txt'), 'utf8')).toBe('c original\n')

    expect(rollbackResult.summary).toContain('Rewound 2 of 3 files')

    const headAfterRollback = git(['rev-parse', 'HEAD'], cwd).trim()
    const branchAfterRollback = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim()
    expect(headAfterRollback).toBe(headBefore)
    expect(branchAfterRollback).toBe(branchBefore)

    const stepsAfterRollback = checkpoints.list('sess-1')
    expect(stepsAfterRollback[0]?.rolledBack).toBe(true)

    // 6. Redo
    const redoResult = await checkpoints.redo(step.id)
    expect(redoResult.stepId).toBe(step.id)
    expect(redoResult.verified).toBe(true)

    const aRedo = redoResult.files.find((f) => f.path === 'a.txt')
    expect(aRedo?.action).toBe('kept')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a edited by human\n')

    const bRedo = redoResult.files.find((f) => f.path === 'b.txt')
    expect(bRedo?.action).toBe('restored')
    expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('b created by agent\n')

    const cRedo = redoResult.files.find((f) => f.path === 'c.txt')
    expect(cRedo?.action).toBe('restored')
    expect(existsSync(join(cwd, 'c.txt'))).toBe(false)

    expect(redoResult.summary).toContain('Restored 2 of 3 files')

    const stepsAfterRedo = checkpoints.list('sess-1')
    expect(stepsAfterRedo[0]?.rolledBack).toBe(false)

    // Project git repo remains untouched
    const headAfterRedo = git(['rev-parse', 'HEAD'], cwd).trim()
    const branchAfterRedo = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim()
    expect(headAfterRedo).toBe(headBefore)
    expect(branchAfterRedo).toBe(branchBefore)
  })

  it('drops a step with no changes', async () => {
    const baseDir = temp('regatta-chk-base-')
    const cwd = makeRepo()

    const checkpoints = new Checkpoints({
      baseDir: () => baseDir,
      emitChanged: () => {}
    })

    await checkpoints.stepStart('sess-empty', 'fake', cwd, 'empty step')
    await checkpoints.stepEnd('sess-empty')

    expect(checkpoints.list('sess-empty')).toHaveLength(0)
  })

  it('loads steps again in a new Checkpoints instance', async () => {
    const baseDir = temp('regatta-chk-base-')
    const cwd = makeRepo()

    const instance1 = new Checkpoints({
      baseDir: () => baseDir,
      emitChanged: () => {}
    })

    await instance1.stepStart('sess-reload', 'fake', cwd, 'turn 1')
    writeFileSync(join(cwd, 'a.txt'), 'reload test modified\n')
    await instance1.stepEnd('sess-reload')

    expect(instance1.list('sess-reload')).toHaveLength(1)

    // Create fresh instance
    const instance2 = new Checkpoints({
      baseDir: () => baseDir,
      emitChanged: () => {}
    })

    const loaded = instance2.list('sess-reload')
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.label).toBe('turn 1')
    expect(loaded[0]?.files[0]?.path).toBe('a.txt')

    // Test rollback from new instance
    const res = await instance2.rollback(loaded[0]!.id)
    expect(res.verified).toBe(true)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a original\n')
  })

  it('ends open step if a second stepStart is called before stepEnd', async () => {
    const baseDir = temp('regatta-chk-base-')
    const cwd = makeRepo()

    const checkpoints = new Checkpoints({
      baseDir: () => baseDir,
      emitChanged: () => {}
    })

    await checkpoints.stepStart('sess-consec', 'fake', cwd, 'first')
    writeFileSync(join(cwd, 'a.txt'), 'first edit\n')

    // Second stepStart without stepEnd
    await checkpoints.stepStart('sess-consec', 'fake', cwd, 'second')
    writeFileSync(join(cwd, 'a.txt'), 'second edit\n')
    await checkpoints.stepEnd('sess-consec')

    const list = checkpoints.list('sess-consec')
    expect(list).toHaveLength(2)
    expect(list[0]?.label).toBe('second')
    expect(list[1]?.label).toBe('first')
  })

  it('handles two sessions sharing a folder without corrupting git state', async () => {
    const baseDir = temp('regatta-chk-base-')
    const cwd = makeRepo()

    const checkpoints = new Checkpoints({
      baseDir: () => baseDir,
      emitChanged: () => {}
    })

    // Start both sessions concurrently
    await Promise.all([
      checkpoints.stepStart('sess-a', 'fake', cwd, 'step a'),
      checkpoints.stepStart('sess-b', 'fake', cwd, 'step b')
    ])

    writeFileSync(join(cwd, 'file-a.txt'), 'from session a\n')
    writeFileSync(join(cwd, 'file-b.txt'), 'from session b\n')

    // End both concurrently
    await Promise.all([
      checkpoints.stepEnd('sess-a'),
      checkpoints.stepEnd('sess-b')
    ])

    const listA = checkpoints.list('sess-a')
    const listB = checkpoints.list('sess-b')
    expect(listA.length).toBeGreaterThanOrEqual(1)
    expect(listB.length).toBeGreaterThanOrEqual(1)
  })
})
