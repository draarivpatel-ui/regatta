// The size of an element, kept up to date, for layout that needs the number and not only CSS: where the
// picture sits inside the player, how many ruler labels fit.

import { useEffect, useRef, useState } from 'react'

export interface Size {
  width: number
  height: number
}

/** A ref to hand to an element, and that element's size in CSS pixels (0 by 0 until it is measured). */
export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, Size] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => {
      const box = el.getBoundingClientRect()
      setSize((prev) => (prev.width === box.width && prev.height === box.height ? prev : { width: box.width, height: box.height }))
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, size]
}
