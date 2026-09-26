'use client'

/**
 * Toasts — the post-write actuals (`ux-dx-spec.md` §4 rule 2): "Issue #43 created · 0.00038
 * DASH". A tiny global queue; `<Toaster>` in the app shell renders it.
 */

import { create } from 'zustand'

export interface Toast {
  readonly id: number
  readonly title: string
  /** What the write took (credits; negative = refunded), or null when it could not be read. */
  readonly credits?: number | null
  readonly tone?: 'ok' | 'warn' | 'error'
  readonly detail?: string
}

interface ToastState {
  readonly toasts: readonly Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
}

let next = 1

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = next++
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 8000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}))

/** Push a toast from outside React. */
export function toast(t: Omit<Toast, 'id'>): void {
  useToasts.getState().push(t)
}
