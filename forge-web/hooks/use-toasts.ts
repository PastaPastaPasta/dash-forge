'use client'

/**
 * Toasts — the post-write actuals (`ux-dx-spec.md` §4 rule 2): "Issue #43 created · 0.00038
 * DASH". A tiny global queue; `<Toaster>` in the app shell renders it.
 *
 * One action that signs several writes (a repo's creation: its repo, maintainer and config
 * documents) shows one toast for all of them: a toast pushed with the `group` of one still showing
 * takes its place, with the writes' credits summed (QW2-034: "Repository created · 0.000817 DASH"
 * gave the first write's cost for a 0.001652 DASH create).
 */

import { create } from 'zustand'

export interface Toast {
  readonly id: number
  readonly title: string
  /** What the write took (credits; negative = refunded), or null when it could not be read. */
  readonly credits?: number | null
  readonly tone?: 'ok' | 'warn' | 'error'
  readonly detail?: string
  /** One action's writes share a group: a later one updates the same toast. */
  readonly group?: string
  /** How many writes the toast totals (1 unless grouped). */
  readonly writes?: number
  /** The group's action has more writes to come: the toast waits for them. */
  readonly pending?: boolean
}

interface ToastState {
  readonly toasts: readonly Toast[]
  push: (t: Omit<Toast, 'id' | 'writes'>) => void
  dismiss: (id: number) => void
}

let next = 1
const TOAST_MS = 8000
/**
 * A grouped toast waits this long for its action's next write: one step of a repo's creation (its
 * reads, broadcast, confirmation and charge measurement) takes longer than a plain toast shows.
 */
const GROUP_WAIT_MS = 60_000
const timers = new Map<number, ReturnType<typeof setTimeout>>()

/** Two writes' credits together; unknown when either could not be read. */
function sumCredits(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null || b == null ? null : a + b
}

export const useToasts = create<ToastState>((set, get) => {
  const expire = (id: number, ms: number): void => {
    clearTimeout(timers.get(id))
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
      }, ms),
    )
  }
  return {
    toasts: [],
    push: (t) => {
      const prev = t.group === undefined ? undefined : get().toasts.find((x) => x.group === t.group)
      if (prev) {
        const merged: Toast = { ...t, id: prev.id, credits: sumCredits(prev.credits, t.credits), writes: (prev.writes ?? 1) + 1 }
        set((s) => ({ toasts: s.toasts.map((x) => (x.id === prev.id ? merged : x)) }))
        expire(prev.id, t.pending ? GROUP_WAIT_MS : TOAST_MS)
        return
      }
      const id = next++
      set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id, writes: 1 }] }))
      expire(id, t.pending ? GROUP_WAIT_MS : TOAST_MS)
    },
    dismiss: (id) => {
      clearTimeout(timers.get(id))
      timers.delete(id)
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
    },
  }
})

/** Push a toast from outside React. */
export function toast(t: Omit<Toast, 'id' | 'writes'>): void {
  useToasts.getState().push(t)
}

/** The toast of `group` still showing, if any. */
export function liveToast(group: string): Toast | undefined {
  return useToasts.getState().toasts.find((x) => x.group === group)
}
