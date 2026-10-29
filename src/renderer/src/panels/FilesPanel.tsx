// Files beside the panes: the project tree, and a small editor for text files.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileContent, FileEntry } from '@shared/types'
import { bridge } from '../lib/bridge'
import { useFiles } from '../store/files'
import { EditorView } from './files/EditorView'
import { TreeView } from './files/TreeView'
import { errorMessage, useFileTree } from './files/useFileTree'

// Lets e2e tests ask the panel to open a file at a line, the way Find does.
;(window as unknown as { __regattaOpenFile: (path: string, line?: number) => void }).__regattaOpenFile = (path, line) =>
  useFiles.getState().requestOpen(path, line)

export function FilesPanel(): React.JSX.Element {
  const tree = useFileTree()
  const request = useFiles((s) => s.openRequest)
  const [file, setFile] = useState<FileContent | null>(null)
  const [draft, setDraft] = useState('')
  const [line, setLine] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A read that finished after another one started is stale, so drop it.
  // `at` is the line an open request asked for; a click in the tree passes none.
  const wanted = useRef(0)

  const openFile = useCallback(async (path: string, at: number | null) => {
    const ticket = (wanted.current += 1)
    setError(null)
    try {
      const next = await bridge.invoke('files:read', path)
      if (ticket !== wanted.current) return
      setFile(next)
      setDraft(next.content)
      setLine(at)
    } catch (err) {
      if (ticket !== wanted.current) return
      setFile(null)
      setError(errorMessage(err))
    }
  }, [])

  // Find and quick actions ask the panel to open a file at a line.
  const [handled, setHandled] = useState<number | null>(null)
  useEffect(() => {
    if (!request || request.nonce === handled) return
    setHandled(request.nonce)
    void openFile(request.path, request.line)
  }, [request, handled, openFile])

  const onOpenEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.kind === 'dir') tree.toggle(entry)
      else void openFile(entry.path, null)
    },
    [tree, openFile]
  )

  const save = useCallback(async () => {
    if (!file) return
    setSaving(true)
    setError(null)
    try {
      await bridge.invoke('files:write', file.path, draft, file.root)
      setFile((prev) => (prev ? { ...prev, content: draft } : prev))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [file, draft])

  const message = error ?? tree.error

  return (
    <div className="relative flex h-full flex-col" data-testid="files-panel">
      {file ? (
        <EditorView
          file={file}
          value={draft}
          line={line}
          saving={saving}
          onChange={setDraft}
          onSave={() => void save()}
          onLineShown={() => setLine(null)}
          onBack={() => {
            setFile(null)
            setLine(null)
          }}
        />
      ) : (
        <TreeView tree={tree} onOpen={onOpenEntry} />
      )}

      {message !== null && (
        <p
          data-testid="files-error"
          role="alert"
          className="shrink-0 border-t border-line bg-panel px-3 py-2 text-[11.5px] leading-relaxed text-st-failed"
        >
          {message}
        </p>
      )}
    </div>
  )
}