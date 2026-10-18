// Settings screen: a list of sections on the left, the chosen section on the right.
// Each section lives in its own file in ./settings so packages never edit the same file.

import { useEffect, useState } from 'react'
import {
  Bell,
  Bot,
  FlaskConical,
  Gauge,
  HardDrive,
  Info,
  Mic,
  Network,
  Palette,
  PlugZap,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  Wrench
} from 'lucide-react'
import type { Prefs } from '@shared/types'
import { bridge } from '../lib/bridge'
import { Modal } from '../components/overlay'
import { cx } from '../components/ui'
import type { SectionProps } from './settings/common'
import { AboutSection } from './settings/AboutSection'
import { AgentToolsSection } from './settings/AgentToolsSection'
import { AgentsSection } from './settings/AgentsSection'
import { AppearanceSection } from './settings/AppearanceSection'
import { DictationSection } from './settings/DictationSection'
import { GeneralSection } from './settings/GeneralSection'
import { LabsSection } from './settings/LabsSection'
import { McpSection } from './settings/McpSection'
import { NotificationsSection } from './settings/NotificationsSection'
import { ServersSection } from './settings/ServersSection'
import { ServicesSection } from './settings/ServicesSection'
import { SkillsSection } from './settings/SkillsSection'
import { StorageSection } from './settings/StorageSection'
import { UsageSection } from './settings/UsageSection'

type SectionId =
  | 'general'
  | 'appearance'
  | 'agents'
  | 'skills'
  | 'services'
  | 'mcp'
  | 'agentTools'
  | 'usage'
  | 'notifications'
  | 'dictation'
  | 'servers'
  | 'storage'
  | 'labs'
  | 'about'

const NAV: { id: SectionId; label: string; icon: React.JSX.Element; render: (p: SectionProps) => React.JSX.Element }[] = [
  { id: 'general', label: 'General', icon: <SettingsIcon size={14} />, render: (p) => <GeneralSection {...p} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={14} />, render: () => <AppearanceSection /> },
  { id: 'agents', label: 'Agents', icon: <Bot size={14} />, render: () => <AgentsSection /> },
  { id: 'skills', label: 'Skills', icon: <Sparkles size={14} />, render: () => <SkillsSection /> },
  { id: 'services', label: 'Services', icon: <PlugZap size={14} />, render: () => <ServicesSection /> },
  { id: 'mcp', label: 'MCP', icon: <Network size={14} />, render: () => <McpSection /> },
  { id: 'agentTools', label: 'Agent tools', icon: <Wrench size={14} />, render: () => <AgentToolsSection /> },
  { id: 'usage', label: 'Usage', icon: <Gauge size={14} />, render: () => <UsageSection /> },
  { id: 'notifications', label: 'Notifications', icon: <Bell size={14} />, render: (p) => <NotificationsSection {...p} /> },
  { id: 'dictation', label: 'Dictation', icon: <Mic size={14} />, render: () => <DictationSection /> },
  { id: 'servers', label: 'Servers', icon: <Server size={14} />, render: () => <ServersSection /> },
  { id: 'storage', label: 'Storage', icon: <HardDrive size={14} />, render: () => <StorageSection /> },
  { id: 'labs', label: 'Labs', icon: <FlaskConical size={14} />, render: () => <LabsSection /> },
  { id: 'about', label: 'About', icon: <Info size={14} />, render: () => <AboutSection /> }
]

export function SettingsScreen({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [section, setSection] = useState<SectionId>('general')
  const [prefs, setPrefs] = useState<Prefs | null>(null)

  useEffect(() => {
    let alive = true
    void bridge
      .invoke('prefs:get')
      .then((next) => {
        if (alive) setPrefs(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const patchPrefs = (patch: Partial<Prefs>): void => {
    setPrefs((prev) => (prev ? { ...prev, ...patch } : prev))
    void bridge
      .invoke('prefs:set', patch)
      .then((next) => setPrefs(next))
      .catch(() => undefined)
  }

  return (
    <Modal title="Settings" onClose={onClose} testId="settings-screen" width={920}>
      <div className="flex h-[540px]">
        <nav className="w-[208px] shrink-0 overflow-y-auto border-r border-line pr-2" aria-label="Settings sections">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`settings-nav-${item.id}`}
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? 'true' : undefined}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-150',
                section === item.id ? 'bg-press text-fg' : 'text-muted hover:bg-hover hover:text-fg'
              )}
            >
              <span className={cx('flex w-5 justify-center', section === item.id ? 'text-accent-bright' : 'text-faint')}>
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto pr-1 pl-5">
          {NAV.find((item) => item.id === section)?.render({ prefs, onPatch: patchPrefs })}
        </div>
      </div>
    </Modal>
  )
}
