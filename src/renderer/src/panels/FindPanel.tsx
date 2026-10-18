// Find beside the panes.

import { useCallback, useState } from 'react'
import type { SearchResult } from '@shared/types'
import { bridge } from '../lib/bridge'
import { Button } from '../components/ui'
import { ResultList } from './find/ResultList'

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; result: SearchResult }
  | { kind: 'error'; message: string }

function statusText(status: Status): string {
  switch (status.kind) {
    case 'idle':
      return 'Search every text file in the project.'
    case 'loading':
      return 'Searching'
    case 'error':
      return `Search failed: ${status.message}`
    case 'done': {
      const { matches, truncated } = status.result
      if (matches.length === 0) return 'No matches'
      if (truncated) return `Showing the first ${matches.length} matches`
      const files = new Set(matches.map((m) => m.path)).size
      return `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}`
    }
  }
}

export function FindPanel(): React.JSX.Element {
  const [text, setText] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const run = useCallback(async () => {
    if (!text) return
    setStatus({ kind: 'loading' })
    try {
      const result = await bridge.invoke('search:run', { text, regex, caseSensitive, limit: 500 })
      setStatus({ kind: 'done', result })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [text, regex, caseSensitive])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="find-panel">
      <div className="border-b border-line p-2">
        <div className="flex items-center gap-1.5">
          <input
            data-testid="find-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run()
            }}
            placeholder="Find in project"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-bg px-2 text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
          />
          <Button
            size="sm"
            active={caseSensitive}
            aria-pressed={caseSensitive}
            aria-label="Match case"
            title="Match case"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </Button>
          <Button
            size="sm"
            active={regex}
            aria-pressed={regex}
            aria-label="Regular expression"
            title="Regular expression"
            onClick={() => setRegex((v) => !v)}
          >
            .*
          </Button>
        </div>
        <div data-testid="find-status" className="mt-1.5 px-0.5 text-[11.5px] text-faint">
          {statusText(status)}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {status.kind === 'done' && <ResultList matches={status.result.matches} query={{ text, regex, caseSensitive }} />}
      </div>
    </div>
  )
}
