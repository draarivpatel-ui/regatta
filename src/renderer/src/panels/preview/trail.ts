// The addresses the preview has been to, so Back and Forward know where they can go.
// Electron's webview element reports no history of its own here: canGoBack stays false even
// after the page follows a link, so the panel keeps the trail and the page is asked to move.

/** Where the page is in the addresses it has been to. */
export interface Trail {
  urls: string[]
  at: number
}

/** A trail longer than this loses its oldest addresses. */
const MAX = 60

export function startTrail(url: string): Trail {
  return { urls: [url], at: 0 }
}

/** The trail once the page has arrived at `url`. The same object comes back when nothing moved. */
export function onArrive(trail: Trail, url: string): Trail {
  if (trail.urls[trail.at] === url) return trail
  const seen = trail.urls.indexOf(url)
  if (seen !== -1) return { urls: trail.urls, at: seen }
  const urls = [...trail.urls.slice(0, trail.at + 1), url]
  if (urls.length > MAX) urls.splice(0, urls.length - MAX)
  return { urls, at: urls.length - 1 }
}

export function canGoBack(trail: Trail): boolean {
  return trail.at > 0
}

export function canGoForward(trail: Trail): boolean {
  return trail.at < trail.urls.length - 1
}