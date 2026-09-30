'use client'

/**
 * A row of tabs that scrolls sideways when it is wider than the screen (the repo tabs, a PR's
 * tabs). The active tab (`aria-current="page"` or `aria-selected="true"`) is scrolled into
 * view, and an edge fade marks each side that has more tabs (`data-more`), so a clipped tab is
 * never mistaken for the last one (L-58).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A tab's box along the strip, from the strip's content start. */
export interface TabBox {
  readonly left: number
  readonly width: number
}

/**
 * Where to scroll a strip: the active tab whole, with as many whole tabs before it as fit, the
 * first of them flush with the left edge, so the tabs cut off are cut whole and the edge fade
 * lies over a tab's lead-in rather than leaving part of one, such as a bare count (QW2-072: on
 * a phone, Files changed showed "93" where "Commits 93" had been cut). When the tabs after the
 * active one are too few to scroll that far, `pad` is the room to add after the last tab.
 */
export function stripScroll(tabs: readonly TabBox[], active: number, viewport: number): { left: number; pad: number } {
  const last = tabs[tabs.length - 1]
  const on = tabs[active]
  if (last === undefined || on === undefined) return { left: 0, pad: 0 }
  const contentRight = last.left + last.width
  if (contentRight <= viewport) return { left: 0, pad: 0 }
  const activeRight = on.left + on.width
  // The first tab from which the run up to the active one fits (the active one alone if none).
  const first = tabs.slice(0, active).findIndex((t) => activeRight - t.left <= viewport)
  const left = (first === -1 ? on : tabs[first] ?? on).left
  return { left, pad: Math.max(0, Math.ceil(left - (contentRight - viewport))) }
}

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
  // Room after the last tab, so the strip can scroll far enough (see `stripScroll`); sized in
  // `reveal`, in the same layout pass as the scroll.
  const padRef = useRef<HTMLSpanElement>(null)
  const [more, setMore] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - (padRef.current?.offsetWidth ?? 0) - 1
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }))
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Keep the active tab inside the strip by scrolling the strip only (scrollIntoView would
    // also scroll the page, e.g. jump to the tabs when Back restores a scrolled position). On a
    // new active tab it is placed by `stripScroll`, and placed again on a resize (a count that
    // loads later widens its tab) unless the user has swiped the strip since, in which case
    // only an active tab pushed out of view brings it back.
    let placedAt: number | null = null
    const reveal = (place: boolean): void => {
      const tabs = ([...el.children] as HTMLElement[]).filter((t) => t !== padRef.current)
      const at = tabs.findIndex((t) => t.matches('[aria-current="page"], [aria-selected="true"]'))
      const origin = tabs[0]?.offsetLeft ?? 0
      const boxes = tabs.map((t) => ({ left: t.offsetLeft - origin, width: t.offsetWidth }))
      const on = boxes[at]
      const untouched = placedAt !== null && Math.abs(el.scrollLeft - placedAt) <= 1
      if (on !== undefined && (place || untouched || on.left < el.scrollLeft - 1 || on.left + on.width > el.scrollLeft + el.clientWidth + 1)) {
        const next = stripScroll(boxes, at, el.clientWidth)
        if (padRef.current) padRef.current.style.width = `${next.pad}px`
        el.scrollLeft = next.left
        placedAt = el.scrollLeft
      }
      measure()
    }
    reveal(true)
    const ro = new ResizeObserver(() => reveal(false))
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
        {/* -ml-1 cancels the gap before it: at width 0 it adds nothing. */}
        <span ref={padRef} aria-hidden className="-ml-1 w-0 shrink-0" />
      </Tag>
      {more.left ? <span aria-hidden className={cn(fade, 'left-0 bg-gradient-to-r')} /> : null}
      {more.right ? <span aria-hidden className={cn(fade, 'right-0 bg-gradient-to-l')} /> : null}
    </div>
  )
}
