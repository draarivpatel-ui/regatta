// New or edit crew member dialog.
// Name, role, agent, instructions, skills and memory notes.

import { useEffect, useState, type FormEvent } from 'react'
import type { ChatAgent, Teammate } from '@shared/chat'
import { CHAT_AGENTS } from '@shared/chat'
import { AGENTS } from '@shared/agents'
import { useSessions } from '../../store/sessions'
import { useSkills } from '../../store/skills'
import { Modal } from '../../components/overlay'
import { Button, cx } from '../../components/ui'

interface CrewModalProps {
  initialTeammate?: Teammate | null
  onClose: () => void
  onSave: (teammate: {
    id?: string
    name: string
    role: string
    agent: ChatAgent
    instructions: string
    memory: string
    skills?: string[]
  }) => Promise<void>
}

export function CrewModal({ initialTeammate, onClose, onSave }: CrewModalProps): React.JSX.Element {
  const agents = useSessions((s) => s.agents)
  // Installed chat agents
  const installedChatAgents = agents.filter(
    (a) => (CHAT_AGENTS as readonly string[]).includes(a.kind) && a.installed
  )
  const availableAgents: ChatAgent[] =
    installedChatAgents.length > 0
      ? installedChatAgents.map((a) => a.kind as ChatAgent)
      : (CHAT_AGENTS as ChatAgent[])

  const [name, setName] = useState(initialTeammate?.name ?? '')
  const [role, setRole] = useState(initialTeammate?.role ?? '')
  const [agent, setAgent] = useState<ChatAgent>(
    initialTeammate?.agent ?? availableAgents[0] ?? 'claude'
  )
  const [instructions, setInstructions] = useState(initialTeammate?.instructions ?? '')
  const [memory, setMemory] = useState(initialTeammate?.memory ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const skills = useSkills((s) => s.skills)
  const loadSkills = useSkills((s) => s.load)
  const [skillIds, setSkillIds] = useState<Set<string>>(() => new Set(initialTeammate?.skills ?? []))

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const toggleSkill = (id: string): void => {
    setSkillIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSubmit = async (e?: FormEvent): Promise<void> => {
    if (e) e.preventDefault()
    if (!name.trim()) {
      setError('Give this crew member a name.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave({
        ...(initialTeammate ? { id: initialTeammate.id } : {}),
        name: name.trim(),
        role: role.trim(),
        agent,
        instructions: instructions.trim(),
        memory: memory.trim(),
        skills: [...skillIds]
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const isEditing = Boolean(initialTeammate)

  return (
    <Modal
      title={isEditing ? `Edit ${initialTeammate?.name}` : 'New crew member'}
      subtitle="Crew members keep instructions and memory across conversations."
      onClose={onClose}
      testId="crew-modal"
      width={520}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="accent"
            size="sm"
            data-testid="crew-save"
            disabled={!name.trim() || saving}
            onClick={() => void handleSubmit()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 pt-1">
        <div>
          <label htmlFor="crew-name-input" className="block text-[12px] font-medium text-fg">
            Name
          </label>
          <input
            id="crew-name-input"
            data-testid="crew-name-input"
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Release partner"
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
          />
        </div>

        <div>
          <label htmlFor="crew-role-input" className="block text-[12px] font-medium text-fg">
            Role
          </label>
          <input
            id="crew-role-input"
            data-testid="crew-role-input"
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Implementation and release review"
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
          />
        </div>

        <div>
          <label htmlFor="crew-agent-select" className="block text-[12px] font-medium text-fg">
            Agent
          </label>
          <select
            id="crew-agent-select"
            data-testid="crew-agent-select"
            value={agent}
            onChange={(e) => setAgent(e.target.value as ChatAgent)}
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
          >
            {availableAgents.map((kind) => (
              <option key={kind} value={kind}>
                {AGENTS[kind]?.name ?? kind}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="crew-instructions-input" className="block text-[12px] font-medium text-fg">
            Instructions
          </label>
          <textarea
            id="crew-instructions-input"
            data-testid="crew-instructions-input"
            rows={3}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="How this crew member should approach their work."
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60 resize-none"
          />
        </div>

        <div>
          <span className="block text-[12px] font-medium text-fg">Skills</span>
          {skills.length === 0 ? (
            <p className="mt-1.5 text-[12px] text-muted">No skills yet. Add them in Settings &gt; Skills.</p>
          ) : (
            <div className="mt-1.5 max-h-[180px] space-y-1 overflow-y-auto rounded-lg border border-line bg-raised p-1.5">
              {skills.map((skill) => {
                const checked = skillIds.has(skill.id)
                return (
                  <label
                    key={skill.id}
                    className={cx(
                      'flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150',
                      checked ? 'bg-press' : 'hover:bg-hover'
                    )}
                  >
                    <input
                      data-testid={`crew-skill-${skill.id}`}
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSkill(skill.id)}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] text-fg">{skill.name}</span>
                      {skill.description && (
                        <span className="block truncate text-[11.5px] text-faint">{skill.description}</span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>

        <div>
          <label htmlFor="crew-memory-input" className="block text-[12px] font-medium text-fg">
            Memory notes
          </label>
          <textarea
            id="crew-memory-input"
            data-testid="crew-memory-input"
            rows={3}
            value={memory}
            onChange={(e) => setMemory(e.target.value)}
            placeholder="Notes kept between conversations."
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60 resize-none"
          />
        </div>

        {error && (
          <p role="alert" className="text-[12px] text-st-failed">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}
