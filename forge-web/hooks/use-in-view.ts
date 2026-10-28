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
  return [ref, seen]
}

/** How long a section already in view on load waits, with nobody scrolling to it, before it reads. */
export const DEFERRED_READ_MS = 8_000

/**
 * {@link useInView}, deferred past the page's own load: true once the element is in view and the
 * reader has scrolled the page, pointed at the element or focused into it since it mounted, or
 * else once {@link DEFERRED_READ_MS} have passed and the browser is idle. A sidebar section a tall
 * window shows at once then costs a cold page load no request (its read comes after the page's
 * own, past the budget's settle), and one the reader scrolls to reads at once.
 */
export function useDeferredInView<T extends HTMLElement>(): readonly [React.RefObject<T>, boolean] {
  const [ref, seen] = useInView<T>()
  const [nudged, setNudged] = useState(false)
  useEffect(() => {
    if (nudged) return
    const go = (): void => setNudged(true)
    const el = ref.current
    // capture: a scroll of any scrolling container counts, not only the window's
    document.addEventListener('scroll', go, { passive: true, capture: true })
    el?.addEventListener('pointerenter', go)
    el?.addEventListener('focusin', go)
    let idle: number | null = null
    const timer = setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(go, { timeout: 2_000 })
      else go()
    }, DEFERRED_READ_MS)
    return () => {
      document.removeEventListener('scroll', go, { capture: true })
      el?.removeEventListener('pointerenter', go)
      el?.removeEventListener('focusin', go)
      clearTimeout(timer)
      if (idle !== null && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle)
    }
  }, [nudged, ref])
  return [ref, seen && nudged]
}
