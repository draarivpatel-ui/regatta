// Settings > Skills: list Claude Code skills found on this computer to copy in.

import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import { useSkills } from '../../../store/skills'
import { Modal } from '../../../components/overlay'
import { Button, cx } from '../../../components/ui'

export function ImportSkills({ onClose }: { onClose: () => void }): React.JSX.Element {
  const importable = useSkills((s) => s.importable)
  const loadImportable = useSkills((s) => s.loadImportable)
  const importFrom = useSkills((s) => s.importFrom)
  const error = useSkills((s) => s.error)
  const clearError = useSkills((s) => s.clearError)
  const [busyPath, setBusyPath] = useState<string | null>(null)

  useEffect(() => {
    void loadImportable()
  }, [loadImportable])

  const copy = async (path: string): Promise<void> => {
    setBusyPath(path)
    clearError()
    try {
      const saved = await importFrom(path)
      if (saved) onClose()
    } finally {
      setBusyPath(null)
    }
  }

  return (
    <Modal
      title="Copy from Claude Code"
      subtitle="Skills found in ~/.claude/skills on this computer. Copy one into Regatta to give it to crew members."
      onClose={onClose}
      testId="skills-import-modal"
      width={560}
    >
      {error && (
        <p role="alert" className="mb-2 text-[12px] text-st-failed">
          {error}
        </p>
      )}
      {importable.length === 0 ? (
        <p className="py-6 text-center text-[12.5px] text-muted" data-testid="skills-import-empty">
          No Claude Code skills found in ~/.claude/skills.
        </p>
      ) : (
        <div className="space-y-1.5 pt-1">
          {importable.map((item) => (
            <div
              key={item.path}
              data-testid="skills-import-row"
              className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium text-fg">{item.name}</p>
                {item.description && <p className="mt-0.5 truncate text-[11.5px] text-muted">{item.description}</p>}
                <p className="mt-0.5 truncate font-mono text-[10.5px] text-faint">{item.path}</p>
              </div>
              <Button
                variant="subtle"
                size="sm"
                data-testid="skills-import"
                disabled={busyPath !== null}
                onClick={() => void copy(item.path)}
                className={cx(busyPath === item.path && 'opacity-40')}
              >
                <Copy size={13} />
                {busyPath === item.path ? 'Copying…' : 'Copy'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
