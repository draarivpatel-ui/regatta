// Grouped results for the Find panel.

import type { SearchMatch, SearchQuery } from '@shared/types'
import { useFiles } from '../../store/files'

export interface FileGroup {
  path: string
  matches: SearchMatch[]
}

export function groupByFile(matches: SearchMatch[]): FileGroup[] {
  const byPath = new Map<string, SearchMatch[]>()
  for (const match of matches) {
    const list = byPath.get(match.path)
    if (list) list.push(match)
    else byPath.set(match.path, [match])
  }
  return [...byPath.entries()].map(([path, group]) => ({ path, matches: group }))
}

interface Query {
  text: string
  regex: boolean
  caseSensitive: boolean
}

interface Span {
  start: number
  end: number
}

/** Start and end offsets of every occurrence of the query inside one line. */
function matchSpans(line: string, query: Query): Span[] {
  const spans: Span[] = []
  if (query.regex) {
    let re: RegExp
    try {
      re = new RegExp(query.text, query.caseSensitive ? 'g' : 'gi')
    } catch {
      return []
    }
    for (let m = re.exec(line); m; m = re.exec(line)) {
      spans.push({ start: m.index, end: m.index + m[0].length })
      if (m[0].length === 0) re.lastIndex++
    }
    return spans
  }
  const hay = query.caseSensitive ? line : line.toLowerCase()
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase()
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + Math.max(needle.length, 1))) {
    spans.push({ start: at, end: at + needle.length })
  }
  return spans
}

function HighlightedLine({ text, query }: { text: string; query: Query }): React.JSX.Element {
  const spans = matchSpans(text, query)
  const parts: React.JSX.Element[] = []
  let pos = 0
  spans.forEach((span, i) => {
    if (span.start > pos) parts.push(<span key={`plain-${i}`}>{text.slice(pos, span.start)}</span>)
    parts.push(
      <span key={`hit-${i}`} className="bg-accent/25 text-fg">
        {text.slice(span.start, span.end)}
      </span>
    )
    pos = span.end
  })
  if (pos < text.length) parts.push(<span key="tail">{text.slice(pos)}</span>)
  return <>{parts}</>
}

function ResultRow({ match, query }: { match: SearchMatch; query: Query }): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="find-result"
      data-path={match.path}
      data-line={String(match.line)}
      onClick={() => useFiles.getState().requestOpen(match.path, match.line)}
      className="flex w-full items-baseline gap-2 px-2 py-[3px] text-left transition-colors duration-150 hover:bg-hover"
    >
      <span className="w-8 shrink-0 text-right font-mono text-[11px] text-faint">{match.line}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
        <HighlightedLine text={match.text} query={query} />
      </span>
    </button>
  )
}

export function ResultList({ matches, query }: { matches: SearchMatch[]; query: Query }): React.JSX.Element {
  const groups = groupByFile(matches)
  return (
    <div>
      {groups.map((group) => (
        <div key={group.path} className="mb-1">
          <div
            data-testid="find-file-header"
            className="sticky top-0 flex items-baseline gap-2 bg-panel px-2 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{group.path}</span>
            <span className="shrink-0 text-[11px] text-faint">{group.matches.length}</span>
          </div>
          {group.matches.map((match) => (
            <ResultRow key={`${match.path}:${match.line}`} match={match} query={query} />
          ))}
        </div>
      ))}
    </div>
  )
}
