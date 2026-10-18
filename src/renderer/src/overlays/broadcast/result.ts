// Pure wording for the Broadcast result line, shown after a send.

/**
 * "Sent to all 4 panes" when every pane took it, otherwise "Sent to 3 of 4 panes".
 * `sent` is the count main reported as delivered, `total` how many were picked.
 */
export function sentSummary(sent: number, total: number): string {
  if (total <= 0) return 'Nothing was sent'
  return sent >= total ? `Sent to all ${total} panes` : `Sent to ${sent} of ${total} panes`
}

/**
 * The panes that did not take the text, named for the result line, for example
 * "not sent: codex has exited". A picked pane that has since exited cannot receive anything.
 * Pass the picked sessions with their state read fresh after the send.
 */
export function notSentLine(exited: { short: string }[]): string {
  if (exited.length === 0) return ''
  return `not sent: ${exited.map((s) => `${s.short} has exited`).join(', ')}`
}
