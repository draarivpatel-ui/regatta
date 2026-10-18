// Pure matching function for quick actions. Case-insensitive subsequence scoring.

export function isSubsequence(query: string, text: string): boolean {
  let ti = 0
  for (let qi = 0; qi < query.length; qi++) {
    const idx = text.indexOf(query[qi]!, ti)
    if (idx === -1) return false
    ti = idx + 1
  }
  return true
}

function matchesWordStart(q: string, t: string): boolean {
  let idx = t.indexOf(q)
  while (idx !== -1) {
    if (idx === 0 || /[^a-zA-Z0-9]/.test(t[idx - 1]!)) {
      return true
    }
    idx = t.indexOf(q, idx + 1)
  }
  return false
}

/**
 * Scores a query against a text label.
 * Case-insensitive. Returns null when query letters do not appear in order.
 * Higher is better: exact prefix beats start of a word beats scattered subsequence.
 * Shorter labels win ties within the same tier.
 * Empty query returns 0 to preserve the original order.
 */
export function score(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  if (!isSubsequence(q, t)) return null
  if (t.startsWith(q)) return 30000 - text.length
  if (matchesWordStart(q, t)) return 20000 - text.length
  return 10000 - text.length
}
