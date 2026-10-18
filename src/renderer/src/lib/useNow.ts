import { useEffect, useState } from 'react'

const listeners = new Set<(t: number) => void>()
let timer: number | null = null

/** One shared one-second clock for every "x s ago" label. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    listeners.add(setNow)
    if (timer === null) timer = window.setInterval(() => listeners.forEach((l) => l(Date.now())), 1000)
    return () => {
      listeners.delete(setNow)
      if (listeners.size === 0 && timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }
  }, [])
  return now
}
