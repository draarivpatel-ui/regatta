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
