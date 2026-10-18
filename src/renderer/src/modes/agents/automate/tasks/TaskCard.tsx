// One task row: what it is, who it is handed to, how its heat is going, and the actions its status allows.

import { FolderOpen, Moon, Pencil, Play, Trash2, Check } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import type { HeatState } from '@shared/heats'
import type { Teammate } from '@shared/chat'
import type { Task } from '@shared/tasks'
import { EDITABLE_STATUSES, TASK_STATUS_LABEL } from '@shared/tasks'
import { Button, cx } from '../../../../components/ui'
import { AgentBadge } from '../../../../components/marks'
import { PixelAvatar } from '../../PixelAvatar'
import { assigneeName, colorOf, leadOf } from './format'
import { ago } from '../../../../lib/format'

interface TaskCardProps {
  task: Task
  /** The heat this task is riding, when it has one and it is still listed. */
  heat: HeatState | undefined
  teammates: Teammate[]
  now: number
  busy: boolean
  onRun: () => void
  onOpen: () => void
  onDone: () => void
  onTonight: () => void
  onEdit: () => void
  onRemove: () => void
}

export function TaskCard({ task, heat, teammates, now, busy, onRun, onOpen, onDone, onTonight, onEdit, onRemove }: TaskCardProps): React.JSX.Element {
  const assignee = assigneeName(task, teammates)
  const lead = leadOf(task, teammates)
  const waiting = task.status === 'running'
  const editable = EDITABLE_STATUSES.includes(task.status)
  // The attempt now running is the last one that has started, which is where the newest line comes from.
  const lane = waiting ? heat?.lanes.filter((l) => l.latest).at(-1) : undefined

  return (
    <article
      data-testid={`task-${task.id}`}
      data-status={task.status}
      className="flex min-w-0 flex-col rounded-xl border border-line bg-panel p-3 animate-fade-up"
    >
      <h3 className="w-full truncate text-[13px] font-semibold text-fg tracking-[-0.01em]" title={task.title}>
        {task.title}
      </h3>

      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted">
        {task.assignee.kind === 'crew' ? (
          <PixelAvatar name={assignee} size={16} />
        ) : lead ? (
          <AgentBadge kind={lead} size={16} />
        ) : null}
        <span className="min-w-0 truncate" title={assignee}>
          {assignee}
        </span>
        {task.backups.length > 0 && (
          <span className="min-w-0 truncate text-muted" title={task.backups.map((kind) => AGENTS[kind]?.short ?? kind).join(', ')}>
            + {task.backups.map((kind) => AGENTS[kind]?.short ?? kind).join(', ')}
          </span>
        )}
      </div>

      <div
        data-testid={`task-meta-${task.id}`}
        className="mt-1 flex items-center gap-x-2 overflow-hidden text-[11px] whitespace-nowrap text-muted"
      >
        <span className={cx('shrink-0 font-medium', colorOf(task.status))}>{TASK_STATUS_LABEL[task.status]}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{ago(task.createdAt, now)} old</span>
        {task.createdBy !== 'you' && (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">from {task.createdBy === 'mcp' ? 'MCP' : 'crew'}</span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate">
          {task.checks.length === 0 ? 'no checks' : `${task.checks.length} ${task.checks.length === 1 ? 'check' : 'checks'}`}
        </span>
      </div>

      {task.note && <p className="mt-2 w-full truncate text-[11.5px] text-muted" title={task.note}>{task.note}</p>}
      {lane?.latest && (
        <p className="mt-2 w-full truncate rounded-md border border-line bg-term px-2 py-1 font-mono text-[11px] text-muted" title={lane.latest}>
          {lane.latest}
        </p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        {editable && (
          <Button variant="accent" size="sm" data-testid={`task-run-${task.id}`} onClick={onRun} disabled={busy} title="Run this task">
            <Play size={13} />
            Run
          </Button>
        )}
        {task.heatId && (
          <Button variant="ghost" size="sm" data-testid={`task-open-${task.id}`} onClick={onOpen} title="Open its heat in Skipper" aria-label={`Open ${task.title} in Skipper`}>
            <FolderOpen size={13} />
          </Button>
        )}
        {task.status !== 'running' && task.status !== 'done' && (
          <Button variant="subtle" size="sm" data-testid={`task-done-${task.id}`} onClick={onDone} disabled={busy} title="Mark done without merging" aria-label={`Mark ${task.title} done`}>
            <Check size={13} />
          </Button>
        )}
        <Button variant="ghost" size="sm" data-testid={`task-tonight-${task.id}`} onClick={onTonight} disabled={busy} title="Add to tonight's night watch" aria-label={`Add ${task.title} to tonight`}>
          <Moon size={13} />
        </Button>
        {editable && (
          <Button variant="ghost" size="sm" data-testid={`task-edit-${task.id}`} onClick={onEdit} title="Edit" aria-label={`Edit ${task.title}`}>
            <Pencil size={13} />
          </Button>
        )}
        {!waiting && task.status !== 'review' && (
          <Button variant="ghost" size="sm" data-testid={`task-remove-${task.id}`} onClick={onRemove} title="Remove" aria-label={`Remove ${task.title}`}>
            <Trash2 size={13} />
          </Button>
        )}
      </div>
    </article>
  )
}
