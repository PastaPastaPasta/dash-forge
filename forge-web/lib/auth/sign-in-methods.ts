/**
 * Which ways in the sign-in sheet offers, in what order, and which one it recommends: one place
 * that decides, so the sheet only renders (docs/design/wallet-primary.md). The wallet leads only
 * where a wallet a newcomer can install finishes sign-in (`walletSignInReady`); elsewhere it is
 * listed last among existing identities, saying why.
 */

import type { Network } from '@/lib/constants'

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
  /**
   * App Connect v2 may be on offer here: the chain supports it, or Platform could not be asked
   * (the flow then names what failed). The wallet tile shows only then.
   */
  readonly walletAvailable: boolean
  /** App Connect v2 is on offer here (checked on chain). */
  readonly walletV2: boolean
  /** An identity creation started in this browser is unfinished. */
  readonly creating: boolean
}

/**
 * Whether a released wallet finishes sign-in here, which decides whether the sheet leads with the
 * wallet tile: wherever App Connect v2 is on offer on mainnet or testnet. DashPay for Android
 * 11.9.2 answers v2 at protocol 14 (checked on testnet with its released testnet build;
 * docs/design/wallet-primary.md); Dash Wallet for iOS 9.1.4 does per its release, with no
 * verified route to testnet. Not on a devnet: released wallets carry no devnet's settings.
 */
export function walletSignInReady(network: Network, v2Offered: boolean): boolean {
  return (network === 'mainnet' || network === 'testnet') && v2Offered
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
  const m = (id: SignInMethodId, group: SignInGroup, recommended = false): SignInMethod => ({ id, group, recommended })
  const wallet = (group: SignInGroup): SignInMethod[] => (ctx.walletAvailable ? [m('wallet', group, walletRecommended && !ctx.creating)] : [])
  return [
    ...(ctx.creating ? [m('resume-create', 'lead')] : []),
    ...(leads ? wallet('lead') : []),
    m('create', 'new', !walletRecommended && !ctx.creating),
    m('passkey', 'existing'),
    m('import', 'existing'),
    m('dg', 'existing'),
    ...(leads ? [] : wallet('existing')),
    m('raw-key', 'advanced'),
  ]
}
