'use client'

/**
 * Cross-component UI state (Zustand): the sign-in sheet and the top-up sheet. Kept small: data
 * lives in per-page hooks, this is only ephemeral chrome state.
 */

import { create } from 'zustand'

/** Why the top-up sheet opened: which budget blocks, and by how much (credits). */
export interface TopUpReason {
  readonly blocker: 'balance' | 'key-budget' | 'key-expiry'
  readonly shortfall?: bigint
}

/** A sign-in sheet view to open on directly (e.g. `import` to renew this browser's key). */
export type LoginView = 'import' | 'create' | 'wallet'

interface UiState {
  readonly loginOpen: boolean
  /** The view the sheet should open on, or null for its default (Unlock / the tiles). */
  readonly loginView: LoginView | null
  openLogin: (view?: LoginView) => void
  closeLogin: () => void
  readonly topUp: TopUpReason | null
  openTopUp: (reason?: TopUpReason) => void
  closeTopUp: () => void
}

export const useUiStore = create<UiState>((set) => ({
  loginOpen: false,
  loginView: null,
  openLogin: (view) => set({ loginOpen: true, loginView: view ?? null }),
  closeLogin: () => set({ loginOpen: false, loginView: null }),
  topUp: null,
  openTopUp: (reason = { blocker: 'balance' }) => set({ topUp: reason }),
  closeTopUp: () => set({ topUp: null }),
}))
