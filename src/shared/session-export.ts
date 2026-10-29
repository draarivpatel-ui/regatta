// Formats active terminal panes and finished heat runs into plain Markdown or TSV
// so you can save a snapshot of what ran in each worktree without copying pane by pane.

export interface PaneSnapshotItem {
  id: string
  title: string
  command: string
  cwd: string
  branch: string | null
  state: 'idle' | 'working' | 'waiting' | 'failed' | 'quiet'
  elapsedSec: number
}

export interface HeatLaneSnapshot {
  laneId: string
  branch: string
  passedChecks: number
  totalChecks: number
  merged: boolean
}

export function formatDurationCompact(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const hrs = Math.floor(safe / 3600)
  const mins = Math.floor((safe % 3600) / 60)
  const secs = safe % 60
  if (hrs > 0) return `${hrs}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

export function exportPanesMarkdown(projectName: string, panes: PaneSnapshotItem[], lanes: HeatLaneSnapshot[] = []): string {
  const lines: string[] = []
  lines.push(`# Regatta Workspace Snapshot: ${projectName || 'Untitled'}`)
  lines.push('')
  lines.push(`Active panes: ${panes.length}`)
  lines.push('')

  if (panes.length > 0) {
    lines.push('| Pane | Command | Branch | Status | Runtime |')
    lines.push('| :--- | :--- | :--- | :--- | :--- |')
    for (const p of panes) {
      const branchLabel = p.branch || 'main'
      lines.push(`| ${p.title} | \`${p.command}\` | \`${branchLabel}\` | ${p.state} | ${formatDurationCompact(p.elapsedSec)} |`)
    }
    lines.push('')
  }

  if (lanes.length > 0) {
    lines.push('## Worktree Lanes')
    lines.push('')
    for (const l of lanes) {
      const checkLabel = `${l.passedChecks}/${l.totalChecks} checks passed`
      const mergeLabel = l.merged ? 'merged' : 'kept in worktree'
      lines.push(`* **${l.laneId}** (\`${l.branch}\`): ${checkLabel}, ${mergeLabel}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function exportPanesTsv(panes: PaneSnapshotItem[]): string {
  const header = ['id', 'title', 'command', 'branch', 'state', 'elapsed_sec', 'cwd'].join('\t')
  const rows = panes.map((p) =>
    [p.id, p.title, p.command, p.branch || '', p.state, String(Math.max(0, Math.floor(p.elapsedSec))), p.cwd]
      .map((cell) => String(cell).replace(/[\t\r\n]+/g, ' '))
      .join('\t')
  )
  return [header, ...rows].join('\n')
}
