'use client'

/**
 * ScrollRegion — a scroll container keyboard users can scroll (WCAG 2.1.1; axe
 * `scrollable-region-focusable`). It joins the Tab order, as a labelled region, only while its
 * content overflows: a short code block or a narrow table adds no stop.
 */

import { createElement, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'

export function ScrollRegion({
  as = 'div',
  label,
  className,
  children,
  ...rest
}: {
  as?: 'div' | 'pre'
  /** What the region holds (`Code block`, `Changes to src/main.rs`), for screen readers. */
  label: string
  className?: string
  children: ReactNode
} & Omit<HTMLAttributes<HTMLElement>, 'tabIndex' | 'role'>): JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const [overflows, setOverflows] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const measure = (): void =>
      setOverflows(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [])
  return createElement(
    as,
    {
      ...rest,
      ref,
      className,
      ...(overflows ? { tabIndex: 0, role: 'region', 'aria-label': label } : {}),
    },
    children,
  )
}
