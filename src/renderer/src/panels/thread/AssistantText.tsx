// Assistant text with fenced code blocks and inline code.

function InlineCode({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(`[^`\n]+`)/g)
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          <code
            key={i}
            className="rounded border border-line bg-panel px-1 py-px font-mono text-[11.5px] text-fg"
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

interface Block {
  code: boolean
  body: string
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const fence = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)(?:```|$)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) blocks.push({ code: false, body: text.slice(last, match.index) })
    blocks.push({ code: true, body: match[2] ?? '' })
    last = match.index + match[0].length
    if (match[0].length === 0) break
  }
  if (last < text.length) blocks.push({ code: false, body: text.slice(last) })
  if (blocks.length === 0) blocks.push({ code: false, body: text })
  return blocks
}

export function AssistantText({ text }: { text: string }): React.JSX.Element {
  const blocks = splitBlocks(text)
  return (
    <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg">
      {blocks.map((b, i) =>
        b.code ? (
          <pre
            key={i}
            className="my-2 overflow-x-auto rounded-lg border border-line bg-panel p-2.5 font-mono text-[11.5px] leading-relaxed text-fg"
          >
            {b.body.replace(/\n$/, '')}
          </pre>
        ) : (
          <span key={i}>
            <InlineCode text={b.body} />
          </span>
        )
      )}
    </div>
  )
}
