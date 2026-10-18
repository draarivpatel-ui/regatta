// Settings > About: what Regatta is, its license, and the open source packages it ships with.

import { useEffect, useState } from 'react'
import type { AppInfo, LicenseNotice } from '@shared/types'
import { bridge } from '../../lib/bridge'
import { Logo } from '../../components/marks'
import { SectionTitle } from './common'
import { NoticesList } from './about/NoticesList'

export function AboutSection(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [notices, setNotices] = useState<LicenseNotice[] | null>(null)
  const [noticesFailed, setNoticesFailed] = useState(false)

  useEffect(() => {
    let alive = true
    void bridge
      .invoke('app:info')
      .then((next) => {
        if (alive) setInfo(next)
      })
      .catch(() => undefined)
    void bridge
      .invoke('about:licenses')
      .then((next) => {
        if (alive) setNotices(next)
      })
      .catch(() => {
        if (alive) setNoticesFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="max-w-[620px]">
      <div className="flex items-center gap-3">
        <Logo size={40} />
        <div>
          <div className="flex items-baseline gap-2">
            <h3 className="text-[17px] font-semibold tracking-[-0.01em]">Regatta</h3>
            {info && <span data-testid="about-version" className="font-mono text-[12px] text-muted">v{info.version}</span>}
          </div>
          <p className="mt-0.5 text-[12.5px] text-muted">Free and open source under the MIT license.</p>
        </div>
      </div>

      <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
        Regatta runs the agent CLIs you already have, on your own accounts, and never adds a markup.
      </p>

      <div className="mt-5">
        <SectionTitle>Open source notices</SectionTitle>
        <NoticesList notices={notices} failed={noticesFailed} />
      </div>
    </div>
  )
}
