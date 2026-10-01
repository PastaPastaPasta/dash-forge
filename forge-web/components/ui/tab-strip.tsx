'use client'

/**
 * A row of tabs that scrolls sideways when it is wider than the screen (the repo tabs, a PR's
 * tabs). The active tab (`aria-current="page"` or `aria-selected="true"`) is scrolled into
 * view, and an edge fade marks each side that has more tabs (`data-more`), so a clipped tab is
 * never mistaken for the last one (L-58); it covers all of a tab the edge cuts (QW3-057).
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react'
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

/** How fast a fade narrows back to {@link MIN_FADE} as a cut tab's last pixels come into view. */
const FADE_PER_HIDDEN_PX = 6

/**
 * How wide each edge fade is: over the visible part of a tab the edge cuts, so a cut tab fades
 * out instead of showing a clipped count (QW3-057: "Pull requests 22" read "Pull requests 2" and
 * "Releases" read "Rele" under a 32 px fade), and at least {@link MIN_FADE} wherever more lies
 * beyond the edge; 0 where nothing does. It narrows smoothly to the minimum as the cut tab's last
 * pixels scroll in (no jump at the tab boundary). The active tab (`active`), and a tab cut at both
 * edges, keep the minimum, and each fade stays under half the strip: what is being read stays
 * readable.
 */
export function edgeFades(tabs: readonly TabBox[], scrollLeft: number, viewport: number, active = -1): { left: number; right: number } {
  const last = tabs[tabs.length - 1]
  if (last === undefined) return { left: 0, right: 0 }
  const right = scrollLeft + viewport
  const cutRight = tabs.findIndex((t) => t.left < right - 1 && t.left + t.width > right + 1)
  const cutLeft = tabs.findIndex((t) => t.left < scrollLeft - 1 && t.left + t.width > scrollLeft + 1)
  const cap = Math.max(MIN_FADE, Math.floor(viewport / 2) - 1)
  const width = (cut: number, visible: (t: TabBox) => number): number => {
    const t = tabs[cut]
    if (t === undefined || cut === active || cutLeft === cutRight) return MIN_FADE
    const shown = visible(t)
    return Math.min(cap, Math.max(MIN_FADE, Math.min(shown, MIN_FADE + FADE_PER_HIDDEN_PX * (t.width - shown))))
  }
  return {
    left: scrollLeft > 1 ? width(cutLeft, (t) => t.left + t.width - scrollLeft) : 0,
    right: last.left + last.width > right + 1 ? width(cutRight, (t) => right - t.left) : 0,
  }
}

/** The tabs' boxes along the strip `el` (all its children but `pad`), and the active one's index. */
function tabBoxes(el: HTMLElement, pad: HTMLElement | null): { boxes: TabBox[]; active: number } {
  const tabs = ([...el.children] as HTMLElement[]).filter((t) => t !== pad)
  const origin = tabs[0]?.offsetLeft ?? 0
  return {
    boxes: tabs.map((t) => ({ left: t.offsetLeft - origin, width: t.offsetWidth })),
    active: tabs.findIndex((t) => t.matches('[aria-current="page"], [aria-selected="true"]')),
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
  // The edge fades follow the scroll, so they are sized on the DOM (once a frame), not through
  // React state: a swipe re-renders nothing.
  const wrapRef = useRef<HTMLDivElement>(null)
  const leftFade = useRef<HTMLSpanElement>(null)
  const rightFade = useRef<HTMLSpanElement>(null)
  const paint = useCallback((boxes: readonly TabBox[], active: number) => {
    const el = ref.current
    if (!el) return
    const f = edgeFades(boxes, el.scrollLeft, el.clientWidth, active)
    for (const [span, w] of [[leftFade.current, f.left], [rightFade.current, f.right]] as const) {
      if (span === null) continue
      span.hidden = w === 0
      span.style.width = `${w}px`
    }
    const more = [f.left > 0 && 'left', f.right > 0 && 'right'].filter(Boolean).join(' ')
    if (more) wrapRef.current?.setAttribute('data-more', more)
    else wrapRef.current?.removeAttribute('data-more')
  }, [])
  const frame = useRef<number | null>(null)
  const measure = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const el = ref.current
      if (!el) return
      const { boxes, active } = tabBoxes(el, padRef.current)
      paint(boxes, active)
    })
  }, [paint])
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
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
      const { boxes, active: at } = tabBoxes(el, padRef.current)
      const on = boxes[at]
      const outOfView = on !== undefined && (on.left < el.scrollLeft - 1 || on.left + on.width > el.scrollLeft + el.clientWidth + 1)
      if (on !== undefined && (place || !userScrolled || outOfView)) {
        const next = stripScroll(boxes, at, el.clientWidth)
        if (padRef.current) padRef.current.style.width = `${next.pad}px`
        el.scrollLeft = next.left
      }
      paint(boxes, at)
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
  }, [activeKey, paint])
  // Opaque at the edge for a third of its width, so what the edge cuts (a count) is not legible;
  // it stops above the strip's bottom border, which stays whole.
  const fade = 'pointer-events-none absolute bottom-px top-0 from-anvil-50 from-35% to-transparent dark:from-anvil-950'
  const Tag = role === 'tablist' ? 'div' : 'nav'
  return (
    <div ref={wrapRef} className={cn('relative', className)}>
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
      <span ref={leftFade} hidden aria-hidden className={cn(fade, 'left-0 bg-gradient-to-r')} />
      <span ref={rightFade} hidden aria-hidden className={cn(fade, 'right-0 bg-gradient-to-l')} />
    </div>
  )
}
