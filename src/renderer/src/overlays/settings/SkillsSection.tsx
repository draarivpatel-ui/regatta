// Settings > Skills: reusable instructions for crew members. Write one, then give it to
// any crew member; every turn with that crew member includes the skill's instructions.

import { useEffect, useState } from 'react'
import { Plus, Sparkles } from 'lucide-react'
import type { Skill } from '@shared/chat'
import { useChat } from '../../store/chat'
import { useSkills } from '../../store/skills'
import { Button, cx } from '../../components/ui'
import { SkillEditor } from './skills/SkillEditor'
import { ImportSkills } from './skills/ImportSkills'

/** Names of the crew members whose `skills` include this id, joined with a comma. */
function usedBy(teammates: { name: string; skills?: string[] }[], id: string): string {
  return teammates.filter((t) => t.skills?.includes(id)).map((t) => t.name).join(', ')
}

function SkillRow({ skill, users }: { skill: Skill; users: string }): React.JSX.Element {
  return (
    <div
      data-testid={`skills-row-${skill.id}`}
      className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-left transition-colors duration-150 hover:bg-hover"
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-[12.5px] font-medium text-fg">{skill.name}</span>
        {skill.source === 'claude' && (
          <span className="shrink-0 rounded border border-line bg-raised px-1.5 py-px text-[10.5px] text-faint">
            from Claude Code
          </span>
        )}
      </div>
      {skill.description && <p className="mt-0.5 truncate text-[11.5px] text-faint">{skill.description}</p>}
      <p className="mt-1 text-[11.5px] tabular-nums" data-testid={`skills-users-${skill.id}`}>
        {users ? (
          <span className="text-muted">Used by {users}</span>
        ) : (
          <span className="text-faint">Not given to anyone yet</span>
        )}
      </p>
    </div>
  )
}

export function SkillsSection(): React.JSX.Element {
  const skills = useSkills((s) => s.skills)
  const load = useSkills((s) => s.load)
  const teammates = useChat((s) => s.teammates)
  const [editing, setEditing] = useState<Skill | 'new' | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="max-w-[620px]">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold tracking-[-0.01em]">Skills</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            Instructions you write once and give to crew members. Each turn with a crew member includes the skills it
            has.
          </p>
        </div>
        <Button
          variant="subtle"
          size="sm"
          data-testid="skills-import-open"
          onClick={() => setImportOpen(true)}
          className="shrink-0"
        >
          <Sparkles size={13} />
          Copy from Claude Code
        </Button>
        <Button variant="accent" size="sm" data-testid="skills-new" onClick={() => setEditing('new')} className="shrink-0">
          <Plus size={13} />
          New skill
        </Button>
      </div>

      <div className="mt-3 space-y-1.5" data-testid="skills-list">
        {editing === null ? (
          skills.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-muted">
              No skills yet. Write one with New skill, or copy one from Claude Code.
            </p>
          ) : (
            skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => setEditing(skill)}
                className="block w-full cursor-pointer"
              >
                <SkillRow skill={skill} users={usedBy(teammates, skill.id)} />
              </button>
            ))
          )
        ) : (
          <SkillEditor
            skill={editing === 'new' ? null : editing}
            usedBy={editing === 'new' ? '' : usedBy(teammates, editing.id)}
            onClose={() => setEditing(null)}
          />
        )}
      </div>

      {importOpen && <ImportSkills onClose={() => setImportOpen(false)} />}
    </div>
  )
}
