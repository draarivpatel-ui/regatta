// The open source notices list in Settings > About.

import type { LicenseNotice } from '@shared/types'

/** `notices` is null until they are read; `failed` says they could not be. */
export function NoticesList({ notices, failed = false }: { notices: LicenseNotice[] | null; failed?: boolean }): React.JSX.Element {
  return (
    <div
      data-testid="about-licenses"
      className="mt-2 max-h-[220px] divide-y divide-line overflow-y-auto rounded-lg border border-line bg-panel"
    >
      {notices === null && <p className="px-3 py-2 text-[12.5px] text-muted">{failed ? 'The notices could not be read.' : 'Loading notices.'}</p>}
      {notices !== null && notices.length === 0 && <p className="px-3 py-2 text-[12.5px] text-muted">No notices were found.</p>}
      {(notices ?? []).map((notice) => (
        <div key={notice.name} data-testid="about-notice" className="flex items-center gap-3 px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{notice.name}</span>
          <span className="shrink-0 font-mono text-[11.5px] text-muted">{notice.version}</span>
          <span className="w-[104px] shrink-0 text-right text-[11.5px] text-faint">{notice.license}</span>
        </div>
      ))}
    </div>
  )
}
