// Turns raw terminal output into plain text good enough for pattern matching.

// CSI, OSC, DCS/SOS/PM/APC strings and two-byte escapes.
const ESCAPES =
  /\x1b\[[0-9;?<=>!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_=>78]/g

// Other control characters except tab, newline and carriage return.
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export function stripAnsi(input: string): string {
  return input.replace(ESCAPES, '').replace(CONTROLS, '')
}

/** True when a chunk carries visible characters, not just cursor moves or color changes. */
export function hasVisibleText(chunk: string): boolean {
  return /\S/.test(stripAnsi(chunk).replace(/\r/g, ''))
}

/**
 * Appends a chunk to a rolling plain-text tail, keeping at most `max` characters.
 * Carriage returns rewind to the start of the current line, like a terminal would.
 */
export function appendTail(tail: string, chunk: string, max = 4000): string {
  let text = tail
  for (const part of stripAnsi(chunk).split(/(\r\n|\r|\n)/)) {
    if (part === '\n' || part === '\r\n') text += '\n'
    else if (part === '\r') text = text.slice(0, text.lastIndexOf('\n') + 1)
    else text += part
  }
  return text.length > max ? text.slice(text.length - max) : text
}

/** The last `n` non-empty lines of a tail. */
export function lastLines(tail: string, n: number): string {
  const lines = tail.split('\n').filter((l) => l.trim().length > 0)
  return lines.slice(-n).join('\n')
}
