import { describe, expect, it } from 'vitest'
import { parseDiff, diffTitle } from './diffLines'

const SAMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 83db48f..bf2a3c1 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,5 @@ function main() {',
  ' keep one',
  '-removed',
  '+added one',
  '+added two',
  ' keep two',
  '@@ -40,2 +41,2 @@',
  ' tail',
  '-old end',
  '\\ No newline at end of file',
  '+new end',
  ''
].join('\n')

describe('parseDiff', () => {
  const rows = parseDiff(SAMPLE)

  it('hides the raw diff --git, index, --- and +++ lines', () => {
    const shown = rows.map((r) => r.text).join('\n')
    expect(shown).not.toContain('diff --git')
    expect(shown).not.toContain('index 83db48f')
    expect(shown).not.toContain('--- a/')
    expect(shown).not.toContain('+++ b/')
  })

  it('keeps hunk headers as their own rows without numbers', () => {
    const hunks = rows.filter((r) => r.kind === 'hunk')
    expect(hunks.map((r) => r.text)).toEqual(['@@ -10,4 +10,5 @@ function main() {', '@@ -40,2 +41,2 @@'])
    expect(hunks.every((r) => r.oldNo === null && r.newNo === null)).toBe(true)
  })

  it('numbers context on both sides, removed lines on the old side, added lines on the new side', () => {
    const body = rows.filter((r) => r.kind !== 'hunk')
    expect(body.slice(0, 5).map((r) => [r.kind, r.text, r.oldNo, r.newNo])).toEqual([
      ['ctx', 'keep one', 10, 10],
      ['del', 'removed', 11, null],
      ['add', 'added one', null, 11],
      ['add', 'added two', null, 12],
      ['ctx', 'keep two', 12, 13]
    ])
  })

  it('restarts the numbers at the next hunk and gives the no-newline marker no number', () => {
    const second = rows.slice(rows.findIndex((r) => r.text === '@@ -40,2 +41,2 @@') + 1)
    expect(second.map((r) => [r.kind, r.text, r.oldNo, r.newNo])).toEqual([
      ['ctx', 'tail', 40, 41],
      ['del', 'old end', 41, null],
      ['note', 'No newline at end of file', null, null],
      ['add', 'new end', null, 42]
    ])
  })

  it('does not treat the line after the last newline as an empty context line', () => {
    expect(rows[rows.length - 1]!.text).toBe('new end')
  })

  it('shows a rename note and still hides its header lines', () => {
    const text = ['diff --git a/old.md b/new.md', 'similarity index 100%', 'rename from old.md', 'rename to new.md', ''].join('\n')
    expect(parseDiff(text)).toEqual([{ kind: 'note', text: 'Renamed from old.md', oldNo: null, newNo: null }])
  })

  it('says how similar a changed rename is', () => {
    const text = ['diff --git a/a b/b', 'similarity index 90%', 'rename from a', 'rename to b', 'index 1..2 100644', '--- a/a', '+++ b/b', '@@ -1 +1 @@', '-x', '+y', ''].join('\n')
    expect(parseDiff(text).map((r) => r.text)).toEqual(['Renamed from a (90% similar)', '@@ -1 +1 @@', 'x', 'y'])
  })

  it('turns a mode change with no hunks into a sentence', () => {
    const text = ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n')
    expect(parseDiff(text).map((r) => [r.kind, r.text])).toEqual([['note', 'Mode changed from 100644 to 100755']])
  })

  it('calls a new file with no lines a new empty file, and one with lines a new file', () => {
    const empty = ['diff --git a/e b/e', 'new file mode 100644', 'index 0000000..e69de29', ''].join('\n')
    expect(parseDiff(empty).map((r) => r.text)).toEqual(['New empty file'])
    const full = ['diff --git a/f b/f', 'new file mode 100644', 'index 0000000..d95f3ad', '--- /dev/null', '+++ b/f', '@@ -0,0 +1 @@', '+hi', ''].join('\n')
    expect(parseDiff(full).map((r) => [r.kind, r.text])).toEqual([['note', 'New file'], ['hunk', '@@ -0,0 +1 @@'], ['add', 'hi']])
  })

  it('says when a new empty file is executable', () => {
    const text = ['diff --git a/run b/run', 'new file mode 100755', 'index 0000000..e69de29', ''].join('\n')
    expect(parseDiff(text).map((r) => r.text)).toEqual(['New empty file, executable'])
    expect(parseDiff('new file mode 100755\n').map((r) => r.text)).toEqual(['New empty file, executable'])
  })

  it('shows a deleted file and a binary change', () => {
    const gone = ['diff --git a/g b/g', 'deleted file mode 100644', 'index d95f3ad..0000000', '--- a/g', '+++ /dev/null', '@@ -1 +0,0 @@', '-hi', ''].join('\n')
    expect(parseDiff(gone)[0]).toMatchObject({ kind: 'note', text: 'Deleted file' })
    const bin = ['diff --git a/b.png b/b.png', 'index 1..2 100644', 'Binary files a/b.png and b/b.png differ', ''].join('\n')
    expect(parseDiff(bin).map((r) => r.text)).toEqual(['Binary file changed'])
  })

  it('keeps each file of a multi file diff with its own notes', () => {
    const text = [
      'diff --git a/one b/one', 'old mode 100644', 'new mode 100755',
      'diff --git a/two b/two', 'index 1..2 100644', '--- a/two', '+++ b/two', '@@ -1 +1 @@', '-a', '+b', ''
    ].join('\n')
    expect(parseDiff(text).map((r) => r.text)).toEqual(['Mode changed from 100644 to 100755', '@@ -1 +1 @@', 'a', 'b'])
  })

  it('shows the notes of a link diff that has no diff --git line', () => {
    const text = 'new file mode 120000\n@@ -0,0 +1 @@\n+/target\n\\ No newline at end of file\n'
    expect(parseDiff(text).map((r) => r.text)).toEqual(['New file, symbolic link', '@@ -0,0 +1 @@', '/target', 'No newline at end of file'])
  })

  it('numbers a new file from line 1', () => {
    const text = '@@ -0,0 +1,2 @@\n+one\n+two\n'
    expect(parseDiff(text).map((r) => [r.kind, r.newNo])).toEqual([['hunk', null], ['add', 1], ['add', 2]])
  })

  it('returns nothing for an empty diff', () => {
    expect(parseDiff('')).toEqual([])
  })

  it('numbers lines accurately across several hunks', () => {
    const text = [
      'diff --git a/doc.txt b/doc.txt',
      '--- a/doc.txt',
      '+++ b/doc.txt',
      '@@ -5,3 +5,4 @@ first hunk',
      ' ctx1',
      '-del1',
      '+add1',
      '+add2',
      '@@ -20,2 +21,2 @@ second hunk',
      ' ctx2',
      '-del2',
      '@@ -50,1 +50,2 @@ third hunk',
      '+add3',
      ' ctx3',
      ''
    ].join('\n')
    const rows = parseDiff(text)
    expect(rows.map((r) => [r.kind, r.text, r.oldNo, r.newNo])).toEqual([
      ['hunk', '@@ -5,3 +5,4 @@ first hunk', null, null],
      ['ctx', 'ctx1', 5, 5],
      ['del', 'del1', 6, null],
      ['add', 'add1', null, 6],
      ['add', 'add2', null, 7],
      ['hunk', '@@ -20,2 +21,2 @@ second hunk', null, null],
      ['ctx', 'ctx2', 20, 21],
      ['del', 'del2', 21, null],
      ['hunk', '@@ -50,1 +50,2 @@ third hunk', null, null],
      ['add', 'add3', null, 50],
      ['ctx', 'ctx3', 50, 51]
    ])
  })

  it('numbers all lines of a new file on the new side only', () => {
    const text = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,3 @@',
      '+first',
      '+second',
      '+third',
      ''
    ].join('\n')
    const rows = parseDiff(text)
    expect(rows.map((r) => [r.kind, r.text, r.oldNo, r.newNo])).toEqual([
      ['note', 'New file', null, null],
      ['hunk', '@@ -0,0 +1,3 @@', null, null],
      ['add', 'first', null, 1],
      ['add', 'second', null, 2],
      ['add', 'third', null, 3]
    ])
  })

  it('numbers all lines of a deleted file on the old side only', () => {
    const text = [
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-first',
      '-second',
      '-third',
      ''
    ].join('\n')
    const rows = parseDiff(text)
    expect(rows.map((r) => [r.kind, r.text, r.oldNo, r.newNo])).toEqual([
      ['note', 'Deleted file', null, null],
      ['hunk', '@@ -1,3 +0,0 @@', null, null],
      ['del', 'first', 1, null],
      ['del', 'second', 2, null],
      ['del', 'third', 3, null]
    ])
  })

  it('numbers lines of a modified rename file correctly', () => {
    const text = [
      'diff --git a/old.txt b/new.txt',
      'similarity index 75%',
      'rename from old.txt',
      'rename to new.txt',
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -10,3 +10,3 @@',
      ' keep',
      '-before',
      '+after',
      ' keep2',
      ''
    ].join('\n')
    const rows = parseDiff(text)
    expect(rows.map((r) => [r.kind, r.text, r.oldNo, r.newNo])).toEqual([
      ['note', 'Renamed from old.txt (75% similar)', null, null],
      ['hunk', '@@ -10,3 +10,3 @@', null, null],
      ['ctx', 'keep', 10, 10],
      ['del', 'before', 11, null],
      ['add', 'after', null, 11],
      ['ctx', 'keep2', 12, 12]
    ])
  })

  it('handles no newline at end of file without affecting line numbering', () => {
    const text = [
      '@@ -1,2 +1,2 @@',
      '-old line',
      '\\ No newline at end of file',
      '+new line',
      '\\ No newline at end of file',
      ''
    ].join('\n')
    const rows = parseDiff(text)
    expect(rows.map((r) => [r.kind, r.text, r.oldNo, r.newNo])).toEqual([
      ['hunk', '@@ -1,2 +1,2 @@', null, null],
      ['del', 'old line', 1, null],
      ['note', 'No newline at end of file', null, null],
      ['add', 'new line', null, 1],
      ['note', 'No newline at end of file', null, null]
    ])
  })
})

describe('diffTitle', () => {
  it('returns the plain path for unchanged path and no rename header', () => {
    expect(diffTitle('src/index.ts', '')).toBe('src/index.ts')
    expect(diffTitle('src/index.ts')).toBe('src/index.ts')
  })

  it('formats renames as old to new from diff text', () => {
    const text = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
      ''
    ].join('\n')
    expect(diffTitle('new.ts', text)).toBe('old.ts to new.ts')
  })

  it('uses path as fallback if rename to is missing in header', () => {
    const text = [
      'similarity index 90%',
      'rename from old.ts',
      '@@ -1 +1 @@',
      ''
    ].join('\n')
    expect(diffTitle('new.ts', text)).toBe('old.ts to new.ts')
  })

  it('converts arrow strings in path to "old to new"', () => {
    expect(diffTitle('prev.txt → next.txt')).toBe('prev.txt to next.txt')
    expect(diffTitle('prev.txt -> next.txt')).toBe('prev.txt to next.txt')
  })
})
