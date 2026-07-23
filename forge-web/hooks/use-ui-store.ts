'use client'

/**
 * Cross-component UI state (Zustand) — the login modal and the transient trust-panel target.
 * Kept intentionally small: data lives in per-page hooks, this is only ephemeral chrome state.
 */

import { create } from 'zustand'

interface UiState {
  readonly loginOpen: boolean
  openLogin: () => void
  closeLogin: () => void
}

export const useUiStore = create<UiState>((set) => ({
  loginOpen: false,
  openLogin: () => set({ loginOpen: true }),
  closeLogin: () => set({ loginOpen: false }),
}))
