/**
 * Which ways in the sign-in sheet offers, in what order, and which one it recommends: one place
 * that decides, so the sheet only renders (docs/design/wallet-primary.md). The wallet leads only
 * where a wallet a newcomer can install finishes sign-in (`walletSignInReady`); elsewhere it is
 * listed last among existing identities, saying why. On mainnet, where it leads, a newcomer is sent
 * to DashPay to create the identity, and the in-page create moves under "Other ways to sign in"
 * (decision 3).
 */

import type { Network } from '@/lib/constants'
import { walletSignInReady } from '@/lib/auth/app-connect'

export type SignInMethodId = 'resume-create' | 'wallet' | 'get-dashpay' | 'create' | 'passkey' | 'import' | 'dg' | 'raw-key'

/** Where a method sits: above the groups, for newcomers, for existing identities, under Other ways, or under Advanced. */
export type SignInGroup = 'lead' | 'new' | 'existing' | 'other' | 'advanced'

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

/** Whether the wallet tile leads rather than sitting last, muted (recommended too, except on testnet). */
export function walletLeads(ctx: Pick<SignInContext, 'network' | 'walletV2'>): boolean {
  return walletSignInReady(ctx.network, ctx.walletV2)
}

/** The sheet's methods, in order. */
export function signInMethods(ctx: SignInContext): readonly SignInMethod[] {
  const leads = walletLeads(ctx)
  // On testnet the wallet leads for people who have DashPay's testnet build (a sideloaded APK),
  // but a newcomer is still pointed at creating an identity (wallet-primary.md, decision 3).
  const walletRecommended = leads && ctx.network !== 'testnet'
  // On mainnet a newcomer gets DashPay and creates the identity there; only where the wallet can
  // then sign them in, so the newcomer's first step is never a dead end.
  const dashpayFirst = leads && ctx.network === 'mainnet' && ctx.walletAvailable
  const m = (id: SignInMethodId, group: SignInGroup, recommended = false): SignInMethod => ({ id, group, recommended })
  const wallet = (group: SignInGroup): SignInMethod[] => (ctx.walletAvailable ? [m('wallet', group, walletRecommended && !ctx.creating)] : [])
  return [
    ...(ctx.creating ? [m('resume-create', 'lead')] : []),
    ...(leads ? wallet('lead') : []),
    dashpayFirst ? m('get-dashpay', 'new') : m('create', 'new', !walletRecommended && !ctx.creating),
    m('passkey', 'existing'),
    m('import', 'existing'),
    m('dg', 'existing'),
    ...(leads ? [] : wallet('existing')),
    ...(dashpayFirst ? [m('create', 'other')] : []),
    m('raw-key', 'advanced'),
  ]
}
