/**
 * Which ways in the sign-in sheet offers, in what order, and which one it recommends: one place
 * that decides, so the sheet only renders (docs/design/wallet-primary.md). The wallet leads only
 * where a wallet a newcomer can install finishes sign-in (`walletSignInReady`); elsewhere it is
 * listed under "Other ways to sign in", saying why. On mainnet, where it leads, a newcomer is sent
 * to DashPay to create the identity (decision 3): a "Get DashPay" link under the wallet tile, which
 * shows the install step before any code. Every way in that types a recovery phrase (import,
 * create here) sits under Advanced there.
 */

import type { Network } from '@/lib/constants'

export type SignInMethodId = 'resume-create' | 'wallet' | 'get-dashpay' | 'create' | 'passkey' | 'import' | 'dg' | 'raw-key'

/**
 * Where a method sits: shown (`primary`, at most the wallet and the passkey where the wallet leads,
 * plus the Get DashPay link on mainnet),
 * inside the one collapsed "Other ways to sign in" (`more`), or under its Advanced (`advanced`).
 */
export type SignInGroup = 'primary' | 'more' | 'advanced'

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
  /** A released wallet reads this chain's protocol (`releasedWalletReads`). */
  readonly releasedWallet: boolean
  /** An identity creation started in this browser is unfinished. */
  readonly creating: boolean
}

/**
 * Whether a released wallet finishes sign-in here, which decides whether the sheet leads with the
 * wallet tile: wherever App Connect v2 is on offer on mainnet or testnet and the chain runs a
 * protocol released wallets read. DashPay for Android 11.9.2 answers v2 at protocol 14 (checked on
 * testnet with its released testnet build; docs/design/wallet-primary.md) and fails at 15; Dash
 * Wallet for iOS 9.1.4 does per its release, with no verified route to testnet. Not on a devnet:
 * released wallets carry no devnet's settings.
 */
export function walletSignInReady(network: Network, v2Offered: boolean, releasedWallet: boolean): boolean {
  return (network === 'mainnet' || network === 'testnet') && v2Offered && releasedWallet
}

/** Whether the wallet tile leads, recommended, rather than sitting under Other ways, muted. */
export function walletLeads(ctx: Pick<SignInContext, 'network' | 'walletV2' | 'releasedWallet'>): boolean {
  return walletSignInReady(ctx.network, ctx.walletV2, ctx.releasedWallet)
}

/**
 * The sheet's methods, in order. Where the wallet leads, it and the passkey are all that shows;
 * everything else waits under "Other ways to sign in". Elsewhere creating an identity is shown
 * beside the passkey, as no released wallet can finish there.
 */
export function signInMethods(ctx: SignInContext): readonly SignInMethod[] {
  const leads = walletLeads(ctx) && ctx.walletAvailable
  // On mainnet a newcomer gets DashPay and creates the identity there; only where the wallet can
  // then sign them in, so the newcomer's first step is never a dead end.
  const dashpayFirst = leads && ctx.network === 'mainnet'
  const m = (id: SignInMethodId, group: SignInGroup, recommended = false): SignInMethod => ({ id, group, recommended })
  const wallet = (group: SignInGroup): SignInMethod[] => (ctx.walletAvailable ? [m('wallet', group, leads && !ctx.creating)] : [])
  // Mainnet: typing a recovery phrase into a web page is a developer path, never a suggested one.
  const phrase: SignInGroup = ctx.network === 'mainnet' ? 'advanced' : 'more'
  return [
    ...(ctx.creating ? [m('resume-create', 'primary')] : []),
    ...(leads ? wallet('primary') : [m('create', 'primary', !ctx.creating)]),
    ...(dashpayFirst ? [m('get-dashpay', 'primary')] : []),
    m('passkey', 'primary'),
    m('import', phrase),
    m('dg', 'more'),
    ...(leads ? [] : wallet('more')),
    ...(leads ? [m('create', phrase)] : []),
    m('raw-key', 'advanced'),
  ]
}
