// 8 by 8 symmetric pixel avatar generated from the crew member's name.
// A simple hash picks the pattern and two colors from the theme.

import type { ReactNode } from 'react'
import { cx } from '../../components/ui'

interface PixelAvatarProps {
  name: string
  size?: number
  className?: string
}

// Agent and state colors from Regatta theme tokens
const THEME_COLORS: string[] = [
  '#2dd4bf', // accent and test agent
  '#60a5fa', // working
  '#a5b4fc', // starting
  '#fbbf24', // waiting
  '#34d399', // idle
  '#f87171', // failed
  '#d9825b', // claude
  '#f0abfc', // opencode
  '#a78bfa', // qwen
  '#fb923c', // amp
  '#4ade80', // aider
  '#8b9cf7', // gemini
  '#94a3b8', // done
  '#cbd5e1'  // grok
]

function hashName(str: string): number {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s / 4294967296
  }
}

export function PixelAvatar({ name, size = 28, className }: PixelAvatarProps): React.JSX.Element {
  const h = hashName(name || 'crew')
  const c1Idx = h % THEME_COLORS.length
  const c2Offset = (Math.floor(h / THEME_COLORS.length) % (THEME_COLORS.length - 1)) + 1
  const c2Idx = (c1Idx + c2Offset) % THEME_COLORS.length
  const color1 = THEME_COLORS[c1Idx]!
  const color2 = THEME_COLORS[c2Idx]!

  const rand = lcg(h)
  const rects: ReactNode[] = []

  // 8 rows by 4 columns on the left half, mirrored to 4 columns on the right half
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 4; c++) {
      // Denser in the center column (col 3), sparser at outer edges (col 0)
      const threshold = c === 3 ? 0.65 : c === 2 ? 0.55 : c === 1 ? 0.45 : 0.25
      const filled = rand() < threshold || (r >= 2 && r <= 4 && c === 3)
      if (filled) {
        // Pick between primary color and detail color
        const cellColor = rand() < 0.72 ? color1 : color2
        const rightCol = 7 - c
        rects.push(
          <rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} fill={cellColor} />
        )
        if (rightCol !== c) {
          rects.push(
            <rect key={`${r}-${rightCol}`} x={rightCol} y={r} width={1} height={1} fill={cellColor} />
          )
        }
      }
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 8 8"
      className={cx('shrink-0 rounded-lg overflow-hidden', className)}
      style={{
        borderRadius: Math.max(4, Math.round(size * 0.22)),
        background: `color-mix(in srgb, ${color1} 14%, #10151c)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color1} 28%, transparent)`
      }}
      shapeRendering="crispEdges"
      aria-label={name}
    >
      {rects}
    </svg>
  )
}
