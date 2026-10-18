// First-run welcome: three steps (agents found, how status works, start).
// Every way out marks the welcome seen, so it shows once unless reopened from Settings > General.

import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, LayoutGrid } from 'lucide-react'
import type { SessionState, SessionStatus } from '@shared/types'
import { bridge } from '../lib/bridge'
import { useSessions } from '../store/sessions'
import { useUi } from '../store/ui'
import { useNow } from '../lib/useNow'
import { AgentBadge, StatusChip } from '../components/marks'
import { Modal } from '../components/overlay'
import { Button } from '../components/ui'

const SUBTITLES = [
  'Regatta runs the agent CLIs you already have.',
  'Each pane tells you what its agent is doing.',
  'Pick a folder, pick a layout, start an agent.'
] as const

function exampleStatus(state: SessionState): SessionStatus {
  return { state, since: Date.now(), reason: 'Welcome example', source: 'output' }
}

const STATUS_ROWS: { state: SessionState; sentence: string }[] = [
  { state: 'working', sentence: 'The agent is doing something right now.' },
  { state: 'waiting', sentence: 'The agent asked a question or needs approval. Open its pane to answer.' },
  { state: 'quiet', sentence: 'No signal for a while. The agent may still be thinking.' },
  { state: 'done', sentence: 'The process finished.' },
  { state: 'failed', sentence: 'The process stopped with an error.' }
]

function AgentsStep(): React.JSX.Element {
  const agents = useSessions((s) => s.agents)
  const installed = agents.filter((a) => a.installed && a.kind !== 'shell' && a.kind !== 'fake')
  return (
    <div data-testid="welcome-step-1">
      {installed.length === 0 && (
        <p className="mb-3 rounded-lg border border-line bg-panel px-3 py-2 text-[12.5px] leading-relaxed text-muted">
          Regatta runs the agent CLIs you already have. Install one, then reopen this from Settings &gt; General.
        </p>
      )}
      <div className="space-y-1.5">
        {agents.map((a) => (
          <div
            key={a.kind}
            data-testid={`welcome-agent-${a.kind}`}
            className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2"
          >
            <AgentBadge kind={a.kind} size={20} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{a.name}</span>
            <span className={a.installed ? 'shrink-0 text-[12px] text-st-idle' : 'shrink-0 text-[12px] text-faint'}>
              {a.installed ? 'Found' : 'Not found on your PATH'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusStep({ now }: { now: number }): React.JSX.Element {
  return (
    <div data-testid="welcome-step-2">
      <div className="space-y-1.5">
        {STATUS_ROWS.slice(0, 3).map((row) => (
          <div key={row.state} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
            <StatusChip status={exampleStatus(row.state)} now={now} showElapsed={false} />
            <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-muted">{row.sentence}</span>
          </div>
        ))}
        <div className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
          <span className="shrink-0 rounded-full border border-line-strong bg-raised px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-faint">
            limited status
          </span>
          <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-muted">
            Some agents only offer their screen, so Regatta reads it and shows limited status for them.
          </span>
        </div>
        {STATUS_ROWS.slice(3).map((row) => (
          <div key={row.state} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
            <StatusChip status={exampleStatus(row.state)} now={now} showElapsed={false} />
            <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-muted">{row.sentence}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
        An agent which gives no signal is shown as quiet or limited, never guessed as done.
      </p>
    </div>
  )
}

function StartStep({ onDismiss }: { onDismiss: () => void }): React.JSX.Element {
  const openFolder = (): void => {
    onDismiss()
    void useSessions.getState().pickWorkspace()
  }
  const pickLayout = (): void => {
    onDismiss()
    useUi.getState().setMode('code')
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-testid=layout-button]')?.click(), 50)
  }
  return (
    <div data-testid="welcome-step-3">
      <p className="text-[12.5px] leading-relaxed text-muted">
        Open the folder you want to work in, arrange the panes the way you like, then start an agent from New pane.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          data-testid="welcome-open-folder"
          onClick={openFolder}
          className="flex items-center gap-2.5 rounded-xl border border-line bg-panel px-3 py-2.5 text-left transition-colors duration-150 hover:border-accent/40 hover:bg-hover"
        >
          <FolderOpen size={15} className="shrink-0 text-accent-bright" />
          <span className="min-w-0">
            <span className="block truncate text-[12.5px] font-medium">Open a project folder</span>
            <span className="block truncate text-[11px] text-faint">Choose where agents work</span>
          </span>
        </button>
        <button
          type="button"
          data-testid="welcome-pick-layout"
          onClick={pickLayout}
          className="flex items-center gap-2.5 rounded-xl border border-line bg-panel px-3 py-2.5 text-left transition-colors duration-150 hover:border-accent/40 hover:bg-hover"
        >
          <LayoutGrid size={15} className="shrink-0 text-accent-bright" />
          <span className="min-w-0">
            <span className="block truncate text-[12.5px] font-medium">Pick a layout</span>
            <span className="block truncate text-[11px] text-faint">Arrange the panes</span>
          </span>
        </button>
      </div>
    </div>
  )
}

export function OnboardingSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [step, setStep] = useState(1)
  const now = useNow()

  const dismiss = useCallback(() => {
    void bridge.invoke('prefs:set', { welcomeSeen: true }).catch(() => undefined)
    onClose()
  }, [onClose])

  // Enter moves forward (or closes on the last step). A focused button already
  // handles Enter itself, so leave those presses alone to avoid acting twice.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.tagName === 'A')) return
      e.preventDefault()
      if (step < 3) setStep(step + 1)
      else dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, dismiss])

  return (
    <WelcomeSheet title="Welcome to Regatta" subtitle={SUBTITLES[step - 1] ?? ''} onClose={dismiss} step={step} setStep={setStep} now={now} />
  )
}

function WelcomeSheet({
  title,
  subtitle,
  onClose,
  step,
  setStep,
  now
}: {
  title: string
  subtitle: string
  onClose: () => void
  step: number
  setStep: (n: number) => void
  now: number
}): React.JSX.Element {
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      testId="welcome"
      width={560}
      footer={
        <div className="flex w-full items-center">
          <span className="w-[76px]">
            {step > 1 && (
              <Button data-testid="welcome-back" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
          </span>
          <span className="flex flex-1 items-center justify-center gap-1.5" aria-label={`Step ${step} of 3`}>
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                className={n === step ? 'h-1.5 w-5 rounded-full bg-accent' : 'h-1.5 w-1.5 rounded-full bg-line-strong'}
              />
            ))}
          </span>
          <span className="flex w-[76px] justify-end">
            {step < 3 ? (
              <Button variant="accent" data-testid="welcome-next" onClick={() => setStep(step + 1)}>
                Next
              </Button>
            ) : (
              <Button variant="accent" data-testid="welcome-close" onClick={onClose}>
                Close
              </Button>
            )}
          </span>
        </div>
      }
    >
      {step === 1 && <AgentsStep />}
      {step === 2 && <StatusStep now={now} />}
      {step === 3 && <StartStep onDismiss={onClose} />}
    </Modal>
  )
}
