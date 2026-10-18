/** The text of an error from the main process without Electron's "Error invoking remote method" prefix. */
export function cleanError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const message = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim()
  return message || fallback
}
