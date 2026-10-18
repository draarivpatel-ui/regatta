// One model row in Settings, Dictation: download, progress with cancel, or installed.

import type { DictationModel } from '@shared/dictation'
import { Button } from '../../../components/ui'

function formatMiB(received: number, total: number): string {
  const toMiB = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  if (total > 0) return `${toMiB(received)} of ${toMiB(total)}`
  return toMiB(received)
}

export function ModelRow({
  model,
  current,
  downloading,
  progress,
  onDownload,
  onUse,
  onCancel
}: {
  model: DictationModel
  current: boolean
  downloading: boolean
  progress: { received: number; total: number } | null
  onDownload: () => void
  onUse: () => void
  onCancel: () => void
}): React.JSX.Element {
  const percent = progress && progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : null
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2.5" data-testid={`dictation-model-${model.id}`}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-fg">
            {model.name}
            <span className="ml-2 font-normal text-faint">
              {model.sizeMiB} MiB, {model.languages}
            </span>
          </p>
          {downloading && progress && (
            <p className="mt-0.5 text-[11px] text-muted">Downloading, {formatMiB(progress.received, progress.total)}</p>
          )}
        </div>
        {!model.installed && !downloading && (
          <Button variant="subtle" size="sm" data-testid={`dictation-download-${model.id}`} onClick={onDownload}>
            Download
          </Button>
        )}
        {model.installed &&
          (current ? (
            <span className="text-[12px] font-medium text-st-idle">In use</span>
          ) : (
            <Button variant="ghost" size="sm" data-testid={`dictation-use-${model.id}`} onClick={onUse}>
              Use this
            </Button>
          ))}
        {downloading && (
          <Button variant="ghost" size="sm" data-testid="dictation-cancel-download" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {downloading && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-press" role="progressbar" aria-label={`Downloading ${model.name}`}>
          {percent === null ? (
            <div className="h-full w-1/3 rounded-full bg-accent animate-breathe" />
          ) : (
            <div className="h-full rounded-full bg-accent transition-all duration-150" style={{ width: `${percent}%` }} />
          )}
        </div>
      )}
    </div>
  )
}
