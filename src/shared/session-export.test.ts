import { describe, expect, it } from 'vitest'
import { exportPanesMarkdown, exportPanesTsv, formatDurationCompact } from './session-export'

describe('session-export', () => {
  it('formats durations into compact human strings', () => {
    expect(formatDurationCompact(42)).toBe('42s')
    expect(formatDurationCompact(185)).toBe('3m 5s')
    expect(formatDurationCompact(3900)).toBe('1h 5m')
  })

  it('builds a markdown table for active panes and worktree lanes', () => {
    const md = exportPanesMarkdown(
      'regatta',
      [
        {
          id: 'p1',
          title: 'Pane 1',
          command: 'npm test',
          cwd: '/tmp/worktree-a',
          branch: 'feat/trash-guard',
          state: 'idle',
          elapsedSec: 125
        }
      ],
      [
        {
          laneId: 'Lane A',
          branch: 'regatta/heat-1/lane-a',
          passedChecks: 3,
          totalChecks: 3,
          merged: true
        }
      ]
    )
    expect(md).toContain('# Regatta Workspace Snapshot: regatta')
    expect(md).toContain('| Pane 1 | `npm test` | `feat/trash-guard` | idle | 2m 5s |')
    expect(md).toContain('* **Lane A** (`regatta/heat-1/lane-a`): 3/3 checks passed, merged')
  })

  it('exports tab-separated rows and strips embedded newlines', () => {
    const tsv = exportPanesTsv([
      {
        id: 'p2',
        title: 'Shell\tOne',
        command: 'git status',
        cwd: '/tmp/repo',
        branch: 'main',
        state: 'working',
        elapsedSec: 19
      }
    ])
    const lines = tsv.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('id\ttitle\tcommand\tbranch\tstate\telapsed_sec\tcwd')
    expect(lines[1]).toContain('Shell One\tgit status\tmain\tworking\t19')
  })
})
