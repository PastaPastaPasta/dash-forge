'use client'

/**
 * A row of tabs that scrolls sideways when it is wider than the screen (the repo tabs, a PR's
 * tabs). The active tab (`aria-current="page"` or `aria-selected="true"`) is scrolled into
 * view, and an edge fade marks each side that has more tabs (`data-more`), so a clipped tab is
 * never mistaken for the last one (L-58); it covers all of a tab the edge cuts (QW3-057).
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

/** The narrowest an edge fade is: enough to read as "more this way". */
export const MIN_FADE = 32

/**
 * How wide each edge fade is: over the whole visible part of a tab the edge cuts, so a cut tab
 * fades out entirely instead of showing a clipped count (QW3-057: "Pull requests 22" read
 * "Pull requests 2" and "Releases" read "Rele" under a 32 px fade), and at least
 * {@link MIN_FADE} wherever more lies beyond the edge. 0: nothing beyond that edge.
 */
export function edgeFades(tabs: readonly TabBox[], scrollLeft: number, viewport: number): { left: number; right: number } {
  const last = tabs[tabs.length - 1]
  if (last === undefined) return { left: 0, right: 0 }
  const right = scrollLeft + viewport
  const moreLeft = scrollLeft > 1
  const moreRight = last.left + last.width > right + 1
  const cutRight = tabs.find((t) => t.left < right - 1 && t.left + t.width > right + 1)
  const cutLeft = tabs.find((t) => t.left < scrollLeft - 1 && t.left + t.width > scrollLeft + 1)
  // Never more than half the strip: the active tab stays readable.
  const cap = Math.max(MIN_FADE, Math.floor(viewport / 2))
  const width = (cut: TabBox | undefined, visible: (t: TabBox) => number): number => Math.min(cap, Math.max(MIN_FADE, cut ? visible(cut) : 0))
  return {
    left: moreLeft ? width(cutLeft, (t) => t.left + t.width - scrollLeft) : 0,
    right: moreRight ? width(cutRight, (t) => right - t.left) : 0,
  }
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
  // Each edge fade's width (0: nothing beyond that edge), from `edgeFades`.
  const [more, setMore] = useState<{ left: number; right: number }>({ left: 0, right: 0 })
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const tabs = ([...el.children] as HTMLElement[]).filter((t) => t !== padRef.current)
    const origin = tabs[0]?.offsetLeft ?? 0
    const next = edgeFades(
      tabs.map((t) => ({ left: t.offsetLeft - origin, width: t.offsetWidth })),
      el.scrollLeft,
      el.clientWidth,
    )
    setMore((m) => (m.left === next.left && m.right === next.right ? m : next))
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Keep the active tab inside the strip by scrolling the strip only (scrollIntoView would
    // also scroll the page, e.g. jump to the tabs when Back restores a scrolled position). On a
    // new active tab it is placed by `stripScroll`, and placed again on a resize (a count that
    // loads later widens its tab) until the user scrolls the strip themselves; after that only
    // an active tab pushed out of view brings it back.
    let userScrolled = false
    const touched = (): void => {
      userScrolled = true
    }
    const reveal = (place: boolean): void => {
      const tabs = ([...el.children] as HTMLElement[]).filter((t) => t !== padRef.current)
      const at = tabs.findIndex((t) => t.matches('[aria-current="page"], [aria-selected="true"]'))
      const origin = tabs[0]?.offsetLeft ?? 0
      const boxes = tabs.map((t) => ({ left: t.offsetLeft - origin, width: t.offsetWidth }))
      const on = boxes[at]
      const outOfView = on !== undefined && (on.left < el.scrollLeft - 1 || on.left + on.width > el.scrollLeft + el.clientWidth + 1)
      if (on !== undefined && (place || !userScrolled || outOfView)) {
        const next = stripScroll(boxes, at, el.clientWidth)
        if (padRef.current) padRef.current.style.width = `${next.pad}px`
        el.scrollLeft = next.left
      }
      measure()
    }
    reveal(true)
    const ro = new ResizeObserver(() => reveal(false))
    ro.observe(el)
    for (const tab of el.children) ro.observe(tab)
    const gestures = ['pointerdown', 'wheel', 'keydown'] as const
    for (const g of gestures) el.addEventListener(g, touched, { passive: true })
    return () => {
      ro.disconnect()
      for (const g of gestures) el.removeEventListener(g, touched)
    }
  }, [activeKey, measure])
  // Opaque at the edge for a third of its width, so what the edge cuts (a count) is not legible.
  const fade = 'pointer-events-none absolute inset-y-0 from-anvil-50 from-35% to-transparent dark:from-anvil-950'
  const Tag = role === 'tablist' ? 'div' : 'nav'
  return (
    <div className={cn('relative', className)} data-more={[more.left > 0 && 'left', more.right > 0 && 'right'].filter(Boolean).join(' ') || undefined}>
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
      {more.left > 0 ? <span aria-hidden className={cn(fade, 'left-0 bg-gradient-to-r')} style={{ width: more.left }} /> : null}
      {more.right > 0 ? <span aria-hidden className={cn(fade, 'right-0 bg-gradient-to-l')} style={{ width: more.right }} /> : null}
    </div>
  )
}
