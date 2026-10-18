// Pieces every Settings section shares.

import type { Prefs } from '@shared/types'

/** Props every section receives. Sections that keep their own state may ignore them. */
export interface SectionProps {
  prefs: Prefs | null
  onPatch: (patch: Partial<Prefs>) => void
}

export function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{children}</h3>
}

/** A section whose package has not been built yet: its title, what it will do, and a note. */
export function PlannedSection({ title, lines }: { title: string; lines: string[] }): React.JSX.Element {
  return (
    <div className="max-w-[520px]">
      <SectionTitle>{title}</SectionTitle>
      <div className="mt-2 space-y-2">
        {lines.map((line) => (
          <p key={line.slice(0, 24)} className="text-[12.5px] leading-relaxed text-muted">
            {line}
          </p>
        ))}
        <p className="text-[12.5px] leading-relaxed text-muted">Coming in a later build.</p>
      </div>
    </div>
  )
}
