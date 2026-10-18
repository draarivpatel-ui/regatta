// Settings, Dictation: engine, models, shortcut, privacy and a try-it recorder.

import { useRef, useState } from 'react'
import { Copy, Loader2, Mic } from 'lucide-react'
import { bridge } from '../../lib/bridge'
import { recordAudio, type ActiveRecording } from '../../dictation/recorder'
import { MIC_DENIED_MESSAGE } from '../../dictation/controller'
import { Button, Kbd } from '../../components/ui'
import { SectionTitle } from './common'
import { useDictationStatus } from './dictation/useDictationStatus'
import { ModelRow } from './dictation/ModelRow'
import { AnywhereSettings } from './dictation/Anywhere'

const BREW_COMMAND = 'brew install whisper-cpp'

type TryState = 'idle' | 'recording' | 'working' | 'done' | 'error'

function EngineBlock({ engine, onCheck }: { engine: string | null | undefined; onCheck: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copyBrew = (): void => {
    void navigator.clipboard
      .writeText(BREW_COMMAND)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }
  return (
    <section aria-label="Engine">
      <h4 className="text-[12.5px] font-semibold text-fg">Engine</h4>
      {engine === undefined ? (
        <p className="mt-1 text-[12.5px] text-muted">Checking for whisper.cpp,</p>
      ) : engine ? (
        <p className="mt-1 text-[12.5px] text-muted" data-testid="dictation-engine">
          whisper.cpp found at <span className="font-mono text-fg">{engine}</span>
        </p>
      ) : (
        <div className="mt-1">
          <p className="text-[12.5px] text-muted" data-testid="dictation-engine">
            whisper.cpp is not installed
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
            Install it with
            <code className="rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-[11.5px] text-fg">
              {BREW_COMMAND}
            </code>
            <Button variant="ghost" size="sm" data-testid="dictation-copy-brew" onClick={copyBrew}>
              <Copy size={13} />
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </p>
        </div>
      )}
      <div className="mt-2">
        <Button variant="ghost" size="sm" data-testid="dictation-check" onClick={onCheck}>
          Check again
        </Button>
      </div>
    </section>
  )
}

function TryIt({ ready }: { ready: boolean }): React.JSX.Element {
  const [state, setState] = useState<TryState>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const rec = useRef<ActiveRecording | null>(null)

  const toggle = (): void => {
    if (state === 'recording') {
      const held = rec.current
      rec.current = null
      if (!held) {
        setState('idle')
        return
      }
      setState('working')
      void held
        .stop()
        .then((wav) => bridge.invoke('dictation:transcribe', wav))
        .then((words) => {
          if (!words.trim()) {
            setError('Nothing was heard. Try again.')
            setState('error')
            return
          }
          setText(words)
          setError('')
          setState('done')
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Dictation failed. Try again.')
          setState('idle')
        })
      return
    }
    if (state === 'working') return
    setError('')
    setText('')
    if (!ready) {
      setError('Install whisper.cpp and download a model first.')
      setState('error')
      return
    }
    void bridge
      .invoke('dictation:microphone')
      .then((mic) => {
        if (mic !== 'granted') throw new Error(MIC_DENIED_MESSAGE)
        return recordAudio(() => undefined)
      })
      .then((next) => {
        rec.current = next
        setState('recording')
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Dictation failed. Try again.')
        setState('error')
      })
  }

  return (
    <section aria-label="Try it">
      <h4 className="text-[12.5px] font-semibold text-fg">Try it</h4>
      <div className="mt-1.5 flex items-center gap-2">
        <Button
          variant={state === 'recording' ? 'accent' : 'subtle'}
          size="sm"
          data-testid="dictation-try"
          onClick={toggle}
          disabled={state === 'working'}
        >
          {state === 'working' ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}
          {state === 'recording' ? 'Stop and transcribe' : state === 'working' ? 'Working' : 'Try it'}
        </Button>
        {state === 'recording' && <span className="text-[12px] text-muted">Recording, speak now.</span>}
      </div>
      {(state === 'done' || state === 'error') && (
        <p
          data-testid="dictation-try-result"
          data-state={state}
          className={state === 'done' ? 'mt-2 text-[12.5px] text-fg' : 'mt-2 text-[12.5px] text-st-failed'}
        >
          {state === 'done' ? text : error}
        </p>
      )}
      {state === 'idle' && error && <p className="mt-2 text-[12.5px] text-st-failed">{error}</p>}
    </section>
  )
}

export function DictationSection(): React.JSX.Element {
  const { status, refresh } = useDictationStatus()

  const download = (id: 'base.en' | 'large-v3-turbo-q5_0'): void => {
    void bridge
      .invoke('dictation:download', id)
      .catch(() => undefined)
  }
  const useModel = (id: 'base.en' | 'large-v3-turbo-q5_0'): void => {
    void bridge
      .invoke('dictation:setModel', id)
      .catch(() => undefined)
  }
  const cancelDownload = (): void => {
    bridge.invoke('dictation:cancelDownload').catch(() => undefined)
  }

  return (
    <div className="max-w-[520px]" data-testid="dictation-section">
      <SectionTitle>Dictation</SectionTitle>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        Speak into a composer or a terminal. Your words arrive as a draft; nothing is sent or run until you do it.
      </p>
      <div className="mt-4 space-y-5">
        <EngineBlock engine={status?.engine} onCheck={refresh} />
        <section aria-label="Models">
          <h4 className="text-[12.5px] font-semibold text-fg">Models</h4>
          <div className="mt-1.5 space-y-2">
            {(status?.models ?? []).map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                current={status?.model === model.id}
                downloading={status?.download?.id === model.id}
                progress={status?.download?.id === model.id ? status.download : null}
                onDownload={() => download(model.id)}
                onUse={() => useModel(model.id)}
                onCancel={cancelDownload}
              />
            ))}
            {!status && <p className="text-[12.5px] text-muted">Loading models,</p>}
          </div>
          {status?.error && (
            <p role="alert" className="mt-2 text-[12.5px] text-st-failed">
              {status.error}
            </p>
          )}
        </section>
        <section aria-label="Shortcut">
          <h4 className="text-[12.5px] font-semibold text-fg">Shortcut</h4>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            <Kbd>Cmd+Shift+Space</Kbd> to start and stop, <Kbd>Esc</Kbd> to cancel. Recordings stop after 2 minutes.
          </p>
        </section>
        <section aria-label="Privacy">
          <h4 className="text-[12.5px] font-semibold text-fg">Privacy</h4>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            Speech is turned into text on this computer. The recording is deleted as soon as the text is ready.
          </p>
        </section>
        <AnywhereSettings />
        <TryIt ready={Boolean(status?.engine && status?.model)} />
      </div>
    </div>
  )
}
