'use client'

/**
 * useInView — whether an element has come into the viewport, latched: true from the first time
 * it is seen (or at once where there is no IntersectionObserver). A card below the fold reads its
 * data only then, so a cold page load spends no requests on what nobody has looked at (S-1).
 */

import { useEffect, useRef, useState } from 'react'

export function useInView<T extends Element>(): readonly [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen) return
    const el = ref.current
    if (el === null || typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen] as const
}
