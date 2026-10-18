// The worktree switch: each agent of the crew gets its own copy of the code and its own branch.

import type { GitStatus } from '@shared/types'
import { GitBranch } from 'lucide-react'
import { cx } from '../../components/ui'

export const NOT_A_REPO = 'This folder is not a git repository.'

interface IsolateSwitchProps {
  checked: boolean
  onChange: (on: boolean) => void
  /** Undefined while the first git:status call is in flight, null when this is not a git repo. */
  git: GitStatus | null | undefined
  disabled?: boolean
}

export function IsolateSwitch({ checked, onChange, git, disabled }: IsolateSwitchProps): React.JSX.Element {
  const loading = git === undefined
  const off = disabled || git === null || loading
  const on = checked && !off
  return (
    <div className="mt-3 rounded-xl border border-line bg-panel p-3">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Give each its own worktree"
        data-testid="crew-isolate"
        data-git={git === undefined ? 'checking' : git === null ? 'none' : 'ready'}
        disabled={off}
        onClick={() => onChange(!on)}
        className={cx(
          'flex w-full items-start gap-2.5 rounded-lg text-left transition-colors duration-150 outline-none',
          'focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed',
          off ? 'opacity-60' : 'hover:bg-hover'
        )}
      >
        <GitBranch size={14} className={cx('mt-[3px] shrink-0', on ? 'text-accent' : 'text-muted')} />
        <span className="flex-1">
          <span className="block text-[12.5px] font-medium text-fg">Give each its own worktree</span>
          <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">
            Each agent works on its own copy of the code and its own branch, so they cannot overwrite each other.
          </span>
        </span>
        <span
          aria-hidden="true"
          className={cx(
            'relative mt-[2px] h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-150',
            on ? 'bg-accent' : 'bg-press'
          )}
        >
          <span
            className={cx(
              'absolute top-[2px] h-[14px] w-[14px] rounded-full bg-fg transition-[left] duration-150',
              on ? 'left-[16px]' : 'left-[2px]'
            )}
          />
        </span>
      </button>
      {git === null && <p className="mt-2 text-[11.5px] text-st-waiting">{NOT_A_REPO}</p>}
      {loading && <p className="mt-2 text-[11.5px] text-faint">Checking this folder…</p>}
    </div>
  )
}