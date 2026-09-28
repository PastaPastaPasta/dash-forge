'use client'

/**
 * The rows of a long line table to render (D-055): only those near the viewport once the table has
 * more than {@link VIRTUALIZE_LINES} rows, all of them otherwise. Rows are {@link ROW_PX} tall and
 * never wrap, so a row's position is its index times the row height (the blob and blame views).
 */

import { useLayoutEffect, useState, type RefObject } from 'react'
import { visibleRows, VIRTUALIZE_LINES } from '@/lib/view'

/** Row height of a line table (13px text, leading-5). */
export const ROW_PX = 20

/** `[from, to)`: the rows to render. */
export function useRowWindow(tableRef: RefObject<HTMLElement>, total: number): { readonly from: number; readonly to: number } {
  const virtual = total > VIRTUALIZE_LINES
  const [win, setWin] = useState({ from: 0, to: 200 })
  useLayoutEffect(() => {
    if (!virtual) return
    let frame = 0
    const update = (): void => {
      frame = 0
      const el = tableRef.current
      if (el === null) return
      const next = visibleRows(total, ROW_PX, el.getBoundingClientRect().top, window.innerHeight)
      setWin((w) => (w.from === next.from && w.to === next.to ? w : next))
    }
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [tableRef, virtual, total])
  return virtual ? win : { from: 0, to: total }
}

/** Scroll the page so row `line` (1-based) of `table` sits a third of the way down the viewport. */
export function scrollToRow(table: HTMLElement | null, line: number): void {
  if (table === null) return
  const top = table.getBoundingClientRect().top + window.scrollY + (line - 1) * ROW_PX
  window.scrollTo({ top: Math.max(0, top - window.innerHeight / 3) })
}
