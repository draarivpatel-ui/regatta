// Settings > Skills: the editor for one skill, opened from the list or New skill.

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Skill } from '@shared/chat'
import { useSkills } from '../../../store/skills'
import { Button } from '../../../components/ui'

interface SkillEditorProps {
  /** The skill being edited, or null for a new one. */
  skill: Skill | null
  /** Names of the crew members who have it, or an empty string. */
  usedBy: string
  onClose: () => void
}

const MAX_INSTRUCTIONS = 20_000

export function SkillEditor({ skill, usedBy, onClose }: SkillEditorProps): React.JSX.Element {
  const save = useSkills((s) => s.save)
  const remove = useSkills((s) => s.remove)
  const error = useSkills((s) => s.error)
  const clearError = useSkills((s) => s.clearError)

  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [instructions, setInstructions] = useState(skill?.instructions ?? '')
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const saved = await save({ ...(skill ? { id: skill.id } : {}), name, description, instructions })
      if (saved) onClose()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!skill) return
    setSaving(true)
    try {
      await remove(skill.id)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2.5" data-testid="skills-editor">
      <div className="space-y-3">
        <div>
          <label htmlFor="skills-name" className="block text-[12px] font-medium text-fg">
            Name
          </label>
          <input
            id="skills-name"
            data-testid="skills-name"
            type="text"
            autoFocus={!skill}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              clearError()
            }}
            placeholder="Release checklist"
            maxLength={80}
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-raised px-3 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
          />
        </div>

        <div>
          <label htmlFor="skills-description" className="block text-[12px] font-medium text-fg">
            Description
          </label>
          <input
            id="skills-description"
            data-testid="skills-description"
            type="text"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
              clearError()
            }}
            placeholder="One line: what the skill is for"
            maxLength={160}
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-raised px-3 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
          />
        </div>

        <div>
          <label htmlFor="skills-instructions" className="block text-[12px] font-medium text-fg">
            Instructions
          </label>
          <textarea
            id="skills-instructions"
            data-testid="skills-instructions"
            rows={12}
            value={instructions}
            onChange={(e) => {
              setInstructions(e.target.value)
              clearError()
            }}
            placeholder="What the crew member should do, step by step."
            className="mt-1.5 w-full resize-y rounded-lg border border-line-strong bg-raised px-3 py-2 font-mono text-[12px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent/60"
          />
          <p className="mt-1 text-right text-[11px] text-faint tabular-nums" data-testid="skills-count">
            {instructions.length.toLocaleString()} / {MAX_INSTRUCTIONS.toLocaleString()}
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" data-testid="skills-error" className="mt-2 text-[12px] text-st-failed">
          {error}
        </p>
      )}

      {confirmingDelete && (
        <p className="mt-2 text-[12px] text-muted" data-testid="skills-delete-note">
          {usedBy ? `Used by ${usedBy}. Deleting removes it from them too.` : 'This cannot be undone.'}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button variant="accent" size="sm" data-testid="skills-save" disabled={saving} onClick={() => void handleSave()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {skill && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="skills-delete"
            disabled={saving}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 size={13} className="text-st-failed" />
            {confirmingDelete ? 'Confirm delete' : 'Delete'}
          </Button>
        )}
        <Button variant="ghost" size="sm" data-testid="skills-cancel" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        {confirmingDelete && (
          <>
            <span className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)} disabled={saving}>
              Keep
            </Button>
            <Button variant="subtle" size="sm" data-testid="skills-delete-confirm" disabled={saving} onClick={() => void handleDelete()}>
              Delete
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
