// Electron's webview tag is a real DOM element that the JSX types do not know about.
// This tells TypeScript which attributes we pass to it.

import type { WebviewTag } from 'electron'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<WebviewTag>, WebviewTag> & {
        src?: string
        partition?: string
        useragent?: string
        httpreferrer?: string
        allowpopups?: boolean
      }
    }
  }
}