'use client'

/**
 * A row of tabs that scrolls sideways when it is wider than the screen (the repo tabs, a PR's
 * tabs). The active tab (`aria-current="page"` or `aria-selected="true"`) is scrolled into
 * view, and an edge fade marks each side that has more tabs (`data-more`), so a clipped tab is
 * never mistaken for the last one (L-58).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
  const [more, setMore] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  // Room after the last tab, so the strip can scroll far enough (see `stripScroll`).
  const [pad, setPad] = useState(0)
  const pendingScroll = useRef<number | null>(null)
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - pad - 1
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }))
  }, [pad])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Keep the active tab inside the strip by scrolling the strip only (scrollIntoView would
    // also scroll the page, e.g. jump to the tabs when Back restores a scrolled position).
    const reveal = (): void => {
      const tabs = ([...el.children] as HTMLElement[]).filter((t) => !t.hasAttribute('data-strip-pad'))
      const at = tabs.findIndex((t) => t.matches('[aria-current="page"], [aria-selected="true"]'))
      if (at >= 0) {
        const next = stripScroll(
          tabs.map((t) => ({ left: t.offsetLeft - el.offsetLeft, width: t.offsetWidth })),
          at,
          el.clientWidth,
        )
        pendingScroll.current = next.left
        setPad(next.pad)
        el.scrollLeft = next.left
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
  // The pad renders after `reveal` asked for it: scroll there once it is in the layout.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || pendingScroll.current === null) return
    el.scrollLeft = pendingScroll.current
    pendingScroll.current = null
    measure()
  }, [pad, measure])
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
        {pad > 0 ? <span aria-hidden data-strip-pad className="shrink-0" style={{ width: pad }} /> : null}
      </Tag>
      {more.left ? <span aria-hidden className={cn(fade, 'left-0 bg-gradient-to-r')} /> : null}
      {more.right ? <span aria-hidden className={cn(fade, 'right-0 bg-gradient-to-l')} /> : null}
    </div>
  )
}
