'use client'

/**
 * A row of tabs that scrolls sideways when it is wider than the screen (the repo tabs, a PR's
 * tabs). The active tab (`aria-current="page"` or `aria-selected="true"`) is scrolled into
 * view, and an edge fade marks each side that has more tabs (`data-more`), so a clipped tab is
 * never mistaken for the last one (L-58).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function TabStrip({
  activeKey,
  label,
  role,
  className,
  children,
}: {
  /** Changes when the active tab does (re-reveals it). */
  activeKey: string
  label: string
  /** `tablist` for in-page tabs; a `nav` landmark otherwise. */
  role?: 'tablist'
  className?: string
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const [more, setMore] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }))
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Keep the active tab inside the strip by scrolling the strip only (scrollIntoView would
    // also scroll the page, e.g. jump to the tabs when Back restores a scrolled position).
    const reveal = (): void => {
      const active = el.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]')
      if (active) {
        const t = active.getBoundingClientRect()
        const n = el.getBoundingClientRect()
        if (t.left < n.left) el.scrollLeft += t.left - n.left
        else if (t.right > n.right) el.scrollLeft += t.right - n.right
      }
      measure()
    }
    reveal()
    // Again whenever the strip or a tab resizes (a count that loads later widens its tab).
    const ro = new ResizeObserver(reveal)
    ro.observe(el)
    for (const tab of el.children) ro.observe(tab)
    return () => ro.disconnect()
  }, [activeKey, measure])
  const fade = 'pointer-events-none absolute inset-y-0 w-8 from-anvil-50 to-transparent dark:from-anvil-950'
  const Tag = role === 'tablist' ? 'div' : 'nav'
  return (
    <div className={cn('relative', className)} data-more={[more.left && 'left', more.right && 'right'].filter(Boolean).join(' ') || undefined}>
      <Tag
        ref={ref as React.RefObject<HTMLDivElement>}
        role={role}
        aria-label={label}
        onScroll={measure}
        className="flex gap-1 overflow-x-auto overscroll-x-contain border-b border-anvil-200 [scrollbar-width:none] dark:border-anvil-800 [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </Tag>
      {more.left ? <span aria-hidden className={cn(fade, 'left-0 bg-gradient-to-r')} /> : null}
      {more.right ? <span aria-hidden className={cn(fade, 'right-0 bg-gradient-to-l')} /> : null}
    </div>
  )
}
