// The file editor shown inside the Files panel: header, line numbers, textarea.

import { useLayoutEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { FileContent } from '@shared/types'
import { Button, IconButton, Kbd } from '../../components/ui'

/** Must match the line height of the textarea and the gutter, so numbers line up with text. */
const LINE_HEIGHT = 18

interface EditorProps {
  file: FileContent
  /** What the textarea holds, which may differ from what is on disk. */
  value: string
  /** A line to scroll to and select, or null when there is no request. */
  line: number | null
  saving: boolean
  onChange: (text: string) => void
  onSave: () => void
  onLineShown: () => void
  onBack: () => void
}

export function EditorView({ file, value, line, saving, onChange, onSave, onLineShown, onBack }: EditorProps): React.JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const lines = value.split('\n')
  const dirty = value !== file.content

  // The gutter scrolls with the text.
  const syncScroll = (): void => {
    if (area.current && gutter.current) gutter.current.scrollTop = area.current.scrollTop
  }

  // Scroll to the line somebody asked for and select it (Find does this).
  // A layout effect, not a timer: reading clientHeight below forces the layout the scroll needs.
  useLayoutEffect(() => {
    if (line === null) return
    const el = area.current
    if (!el) return
    const row = Math.max(0, Math.min(lines.length - 1, line - 1))
    let start = 0
    for (let i = 0; i < row; i += 1) start += (lines[i]?.length ?? 0) + 1
    el.focus()
    el.setSelectionRange(start, start + (lines[row]?.length ?? 0))
    el.scrollTop = Math.max(0, row * LINE_HEIGHT - el.clientHeight / 2)
    syncScroll()
    onLineShown()
    // A new request, or new text to place it in, is what moves the caret.
  }, [line, value])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      onSave()
    }
  }

  const numbers = lines.map((_, i) => i + 1).join('\n')
  const gutterWidth = `${Math.max(2, String(lines.length).length) + 2}ch`

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[34px] shrink-0 items-center gap-2 border-b border-line px-1.5">
        <IconButton onClick={onBack} aria-label="Back to the file tree" title="Back to the tree" data-testid="file-back">
          <ArrowLeft size={14} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted" title={file.path}>
          {file.path}
        </span>
        {dirty && <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent" title="Unsaved changes" data-testid="file-dirty" />}
        {dirty && <Kbd>Cmd S</Kbd>}
        <Button
          variant="accent"
          size="sm"
          onClick={onSave}
          disabled={!dirty || saving || file.binary || file.tooLarge}
          data-testid="file-save"
        >
          {saving ? 'Saving' : 'Save'}
        </Button>
      </header>

      {file.binary ? (
        <p className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-muted">
          This file holds bytes that are not text, so there is nothing to show or edit here.
        </p>
      ) : file.tooLarge ? (
        <p className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-muted">
          This file is over 2 MB. Regatta opens files up to that size, and this one is bigger.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden bg-term">
          <div
            ref={gutter}
            aria-hidden="true"
            style={{ width: gutterWidth }}
            className="shrink-0 select-none overflow-hidden whitespace-pre border-r border-line bg-panel/60 px-2 py-2 text-right font-mono text-[12px] leading-[18px] text-faint"
          >
            {numbers}
          </div>
          <textarea
            ref={area}
            data-testid="file-editor"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
            onKeyDown={onKeyDown}
            wrap="off"
            spellCheck={false}
            aria-label={file.path}
            className="min-h-0 min-w-0 flex-1 select-text resize-none whitespace-pre bg-transparent px-2 py-2 font-mono text-[12px] leading-[18px] text-fg caret-accent outline-none"
          />
        </div>
      )}
    </div>
  )
}