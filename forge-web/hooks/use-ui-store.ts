'use client'

/**
 * Cross-component UI state (Zustand): the sign-in sheet and the top-up sheet. Kept small: data
 * lives in per-page hooks, this is only ephemeral chrome state.
 */

import { create } from 'zustand'
import type { ForgeContractKind } from '@/lib/deployments'

import type { TopUpReason } from '@/lib/view/write-errors'

/** Why the top-up sheet opened: which budget blocks, and by how much (credits). */
export type { TopUpReason }

/**
 * A sign-in sheet view to open on directly (e.g. `import` to renew this browser's key; `grant`
 * asks the signed-in identity's wallet for a key on the contract named with it, when the
 * session lacks one).
 */
export type LoginView = 'import' | 'create' | 'wallet' | 'grant' | 'unlock'

/**
 * What a signed-out click asked to do (L-62): the sheet says "Sign in to star this repo" and what
 * that costs, rather than a generic prompt. `credits`: the write's preview (an upper bound).
 */
export interface SignInIntent {
  /** Completes "Sign in to …": `star this repo`, `fork this repo`, `open an issue`. */
  readonly action: string
  readonly credits?: number
}

interface UiState {
  readonly loginOpen: boolean
  /** The view the sheet should open on, or null for its default (Unlock / the tiles). */
  readonly loginView: LoginView | null
  /** With `grant`: which Forge contract to ask the wallet for (captured when the sheet opens). */
  readonly loginGrantFor: ForgeContractKind | null
  /** Why the sheet opened, when a write asked for it. */
  readonly loginIntent: SignInIntent | null
  openLogin: (view?: LoginView, grantFor?: ForgeContractKind, intent?: SignInIntent) => void
  closeLogin: () => void
  /**
   * "Sign in" was asked for while it was not yet known whether this browser's session resumes
   * (a tap before hydration, or on the session-check placeholder). AppHeader opens the sheet once
   * that settles, if nobody is signed in, and clears this.
   */
  readonly signInPending: boolean
  requestSignIn: () => void
  clearSignInRequest: () => void
  readonly topUp: TopUpReason | null
  openTopUp: (reason?: TopUpReason) => void
  closeTopUp: () => void
}

/**
 * What to do with a pending "Sign in" request: wait while the session check runs, then open the
 * sheet only if nobody is signed in (a session that resumed needs none); either way it is done.
 */
export function signInRequestOutcome(i: { pending: boolean; settled: boolean; signedIn: boolean }): 'wait' | 'open' | 'drop' | 'none' {
  if (!i.pending) return 'none'
  if (!i.settled) return 'wait'
  return i.signedIn ? 'drop' : 'open'
}

export const useUiStore = create<UiState>((set) => ({
  loginOpen: false,
  loginView: null,
  loginGrantFor: null,
  loginIntent: null,
  openLogin: (view, grantFor, intent) =>
    set({ loginOpen: true, loginView: view ?? null, loginGrantFor: grantFor ?? null, loginIntent: intent ?? null }),
  closeLogin: () => set({ loginOpen: false, loginView: null, loginGrantFor: null, loginIntent: null }),
  signInPending: false,
  requestSignIn: () => set({ signInPending: true }),
  clearSignInRequest: () => set({ signInPending: false }),
  topUp: null,
  openTopUp: (reason = { blocker: 'balance' }) => set({ topUp: reason }),
  closeTopUp: () => set({ topUp: null }),
}))
