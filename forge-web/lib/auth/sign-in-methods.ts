/**
 * Which ways in the sign-in sheet offers, in what order, and which one it recommends: one place
 * that decides, so the sheet only renders (docs/design/wallet-primary.md). The wallet leads only
 * where a wallet a newcomer can install finishes sign-in (`walletSignInReady`); elsewhere it is
 * listed last among existing identities, saying why.
 */

import type { Network } from '@/lib/constants'
import { walletSignInReady } from '@/lib/auth/app-connect'

export type SignInMethodId = 'resume-create' | 'wallet' | 'create' | 'passkey' | 'import' | 'dg' | 'raw-key'

/** Where a method sits: above the groups, for newcomers, for existing identities, or under Advanced. */
export type SignInGroup = 'lead' | 'new' | 'existing' | 'advanced'

export interface SignInMethod {
  readonly id: SignInMethodId
  readonly group: SignInGroup
  /** The one method badged "Recommended", if any. */
  readonly recommended: boolean
}

export interface SignInContext {
  readonly network: Network
  /** A wallet answer source exists here (or Platform could not be asked). */
  readonly walletAvailable: boolean
  /** App Connect v2 is on offer here. */
  readonly walletV2: boolean
  /** An identity creation started in this browser is unfinished. */
  readonly creating: boolean
}

/** Whether the wallet tile leads (and is recommended) rather than sitting last, muted. */
export function walletLeads(ctx: Pick<SignInContext, 'network' | 'walletV2'>): boolean {
  return walletSignInReady(ctx.network, ctx.walletV2)
}

/** The sheet's methods, in order. */
export function signInMethods(ctx: SignInContext): readonly SignInMethod[] {
  const leads = walletLeads(ctx)
  const m = (id: SignInMethodId, group: SignInGroup, recommended = false): SignInMethod => ({ id, group, recommended })
  const wallet = (group: SignInGroup): SignInMethod[] => (ctx.walletAvailable ? [m('wallet', group, leads && !ctx.creating)] : [])
  return [
    ...(ctx.creating ? [m('resume-create', 'lead')] : []),
    ...(leads ? wallet('lead') : []),
    m('create', 'new', !leads && !ctx.creating),
    m('passkey', 'existing'),
    m('import', 'existing'),
    m('dg', 'existing'),
    ...(leads ? [] : wallet('existing')),
    m('raw-key', 'advanced'),
  ]
}
