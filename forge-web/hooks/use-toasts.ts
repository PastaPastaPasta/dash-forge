'use client'

/**
 * Toasts — the post-write actuals (`ux-dx-spec.md` §4 rule 2): "Issue #43 created · 0.00038
 * DASH". A tiny global queue; `<Toaster>` in the app shell renders it.
 *
 * One action that signs several writes (a repo's creation, a fork) shows one toast for all of
 * them (`lib/spend-toast.ts`): `show` puts its latest state, total included, in the place of its
 * group's toast (QW2-034, QW3-039).
 */

import { create } from 'zustand'

export interface Toast {
  readonly id: number
  readonly title: string
  /** What the write took (credits; negative = refunded), or null when it could not be read. */
  readonly credits?: number | null
  readonly tone?: 'ok' | 'warn' | 'error'
  readonly detail?: string
  /** One action's toast: a later `show` of the group updates it in place. */
  readonly group?: string
  /** How many writes the toast totals (1 unless grouped). */
  readonly writes?: number
  /** The group's action has more writes to come: the toast waits for them. */
  readonly pending?: boolean
}

interface ToastState {
  readonly toasts: readonly Toast[]
  push: (t: Omit<Toast, 'id' | 'writes' | 'group'>) => void
  /** Show a group's toast as `t` (its figures as given), in place of the one showing, if any. */
  show: (t: Omit<Toast, 'id'> & { readonly group: string }) => void
  dismiss: (id: number) => void
}

let next = 1
const TOAST_MS = 8000
/**
 * An action's toast waits this long for its next write: one step of a fork (its reads, broadcast,
 * confirmation and charge measurement) takes longer than a plain toast shows.
 */
const GROUP_WAIT_MS = 60_000
const timers = new Map<number, ReturnType<typeof setTimeout>>()

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
      const id = next++
      set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id, writes: 1 }] }))
      expire(id, t.pending ? GROUP_WAIT_MS : TOAST_MS)
    },
    show: (t) => {
      const prev = get().toasts.find((x) => x.group === t.group)
      const id = prev?.id ?? next++
      const shown: Toast = { ...t, id }
      set((s) => (prev ? { toasts: s.toasts.map((x) => (x.id === id ? shown : x)) } : { toasts: [...s.toasts.slice(-3), shown] }))
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
export function toast(t: Omit<Toast, 'id' | 'writes' | 'group'>): void {
  useToasts.getState().push(t)
}
