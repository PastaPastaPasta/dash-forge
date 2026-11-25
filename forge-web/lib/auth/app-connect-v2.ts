/**
 * "Use my Dash wallet" with App Connect v2 (`APP_CONNECT_PROFILE.md`; docs/design/wallet-login.md).
 *
 * One request asks for ONE key: AUTHENTICATION / HIGH, bound to the dash-forge contract group, with
 * Forge's default budget and expiry ({@link defaultLimits}, from chain time). It covers every Forge
 * contract, so no further grants are asked for. The request's app is forge-core (its owner is the
 * group's owner, as the profile's owner rule needs). Where forge-user is deployed
 * (docs/design/identity-synced-state.md §5) the app is forge-user instead, and the request also
 * asks for its ENCRYPTION key, the one key every wallet login of the identity derives alike: it
 * syncs settings. A response without it signs in all the same, without sync.
 *
 * A wallet that approves registers the key (disabling the key of its previous grant for this
 * browser's connection id, `./connection-id`) and publishes a `loginKeyResponse` in the App
 * Connect contract under its identity. The poll pages through every answer, opens each with the
 * request's ephemeral key and checks it with the vendored verifier (live key on the answering
 * identity, exactly the bounds, level and limits asked for, not about to expire or spent), then
 * once more with Forge's own rules ({@link findWalletKey}), which yields the {@link WalletKey} the
 * controller stores (`adoptWalletKeys`, origin `app-connect`) like any wallet key.
 *
 * Who answered is not proven (anyone who saw the QR can answer from their own identity): two
 * answers are refused, and without an identity hint the UI asks "Continue as …?". A renewal names
 * the identity (`IDENTITY_HINT`) and carries the same connection id, and no `MODE`: wallets do not
 * know `MODE` = renew yet, and its type is even, so a wallet that does not know it refuses the
 * whole request.
 *
 * Clocks: `CREATED_AT` is this device's clock (the wallet compares it with its own); the proposed
 * expiry and the verifier's "now" are chain time (the latest block's), falling back to this
 * device's clock when it cannot be read.
 */

import * as secp from '@noble/secp256k1'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { KeyPurpose, KeyType } from '../vendor/platform-auth/app-connect/types'
import { withTimeout } from '../timeout'
import type { ForgeIds } from '../deployments'
import {
  APP_CONNECT_MAX_REQUEST_AGE_MS,
  KeySecurityLevel,
  appConnectCandidateKey,
  appConnectPollDelayMs,
  appConnectRequestHash,
  buildAppConnectUri,
  listAppConnectCandidates,
  verifyAppConnectCandidate,
  type AppConnectGrant,
  type AppConnectRejectReason,
  type AppConnectRequest,
} from '../vendor/platform-auth/app-connect'
import { appConnectPort } from './app-connect-port'
import { decodeIdentifier } from './base58'
import { PLATFORM_READ_MS } from './connect'
import { findWalletKey, isUnlimited, RevokedWalletKey, UnusableWalletKey, type WalletKey } from './wallet-key'
import { defaultLimits } from './limited-key'
import { encodeWif } from './wif'

/** More than one identity answered the request: refuse (someone else saw the QR). */
export class AmbiguousWalletLogin extends Error {
  constructor(readonly identityIds: readonly string[]) {
    super(`More than one identity answered this sign-in request (${identityIds.join(', ')}). Someone else saw the QR code. Start again and keep the QR code private.`)
    this.name = 'AmbiguousWalletLogin'
  }
}

/** The request ran out before a wallet answered. */
export class RequestExpired extends Error {
  constructor() {
    super('This sign-in request expired. Start a new one.')
    this.name = 'RequestExpired'
  }
}

/** Why the poll is waiting, for the UI. */
export type PollStatus = 'waiting' | 'answered' | 'incomplete-read'

/** The name a wallet shows for Forge. */
export const APP_CONNECT_LABEL = 'Dash Forge'

/**
 * Whether a renewal carries `MODE` = renew. Off: no wallet supports it yet, and a wallet that
 * does not know the (even, so mandatory) type refuses the request. A renewal is a new grant for
 * the same identity and connection id instead, which disables the old key.
 */
export const RENEW_MODE = false

/** The App Connect contract and v2 requests exist from protocol 14. */
export const APP_CONNECT_MIN_PROTOCOL = 14

/** How far past the chain time Forge read a request may be dated: under the wallets' 2-minute skew. */
export const APP_CONNECT_CREATED_AT_LEAD_MS = 90_000

/**
 * `CREATED_AT`: this device's clock, clamped to [chain time, chain time + 90 s]. A wallet judges it
 * against the latest block time Platform proves and refuses one more than 2 minutes ahead; blocks
 * can be minutes apart, so the device's clock alone reads as "dated ahead of the network's time".
 */
export function requestCreatedAt(now: number, chainNow: number): number {
  return Math.min(Math.max(now, chainNow), chainNow + APP_CONNECT_CREATED_AT_LEAD_MS)
}

/** The request Forge makes: one group-bound HIGH key with Forge's default limits. */
export function forgeV2Request(
  forge: ForgeIds,
  p: {
    readonly appEphemeralPubKey: Uint8Array
    readonly connectionId: Uint8Array
    /** Chain time (ms): the proposed expiry counts from it. */
    readonly chainNow: number
    /** This device's clock (ms); `CREATED_AT` is it clamped to chain time (see {@link requestCreatedAt}). */
    readonly now: number
    /** The identity a renewal is for. */
    readonly identityHint?: string
    /** Ask for forge-user's encryption key where it is deployed (default); false: the request of a build without sync. */
    readonly sync?: boolean
  },
): AppConnectRequest {
  const limits = defaultLimits(p.chainNow)
  const sync = syncContract(forge, p.sync)
  return {
    appEphemeralPubKey: p.appEphemeralPubKey,
    appId: decodeIdentifier(sync ?? forge.core),
    label: APP_CONNECT_LABEL,
    authBindings: [
      {
        kind: 'contractGroup',
        id: decodeIdentifier(forge.group),
        securityLevel: KeySecurityLevel.HIGH,
        totalBudget: limits.budgetCredits,
        expiresAt: limits.expiresAt,
      },
    ],
    encBindings: sync !== null ? [{ contractId: decodeIdentifier(sync), purpose: KeyPurpose.ENCRYPTION }] : [],
    createdAt: requestCreatedAt(p.now, p.chainNow),
    connectionId: p.connectionId,
    ...(p.identityHint !== undefined ? { identityHint: decodeIdentifier(p.identityHint) } : {}),
    ...(RENEW_MODE && p.identityHint !== undefined ? { mode: 'renew' as const } : {}),
  }
}

/** The contract whose encryption key a request asks for: forge-user where deployed, unless `sync` is false. */
export function syncContract(forge: ForgeIds, sync = true): string | null {
  return sync && forge.user !== undefined ? forge.user : null
}

/** Where the app of this browser's wallet grant for an identity is noted (removed with the vault). */
function grantedAppKey(networkKey: string, identityId: string): string {
  return `forge:user-sync:app:${networkKey}:${identityId}`
}

/** Note the app a stored grant's request named (`syncContract`: forge-user, or null for forge-core). */
export function recordGrantedApp(networkKey: string, identityId: string, syncContract: string | null): void {
  try {
    if (syncContract === null) localStorage.removeItem(grantedAppKey(networkKey, identityId))
    else localStorage.setItem(grantedAppKey(networkKey, identityId), syncContract)
  } catch {
    /* storage refused: a renewal then asks as before sync */
  }
}

/** The forge-user contract a stored grant's request named, or null (forge-core, or not noted). */
export function grantedApp(networkKey: string, identityId: string): string | null {
  try {
    return localStorage.getItem(grantedAppKey(networkKey, identityId))
  } catch {
    return null
  }
}

export interface V2LoginRequest {
  readonly request: AppConnectRequest
  /** forge-user, when the request asks for its encryption key; null otherwise. */
  readonly syncContract: string | null
  /** For the QR code: no callback (a shorter code, and the phone has no Forge tab to return to). */
  readonly qrUri: string
  /** For a wallet on this device: the same request, with the callback when one was given. */
  readonly linkUri: string
  /** `hash160(appEphemeralPub)`: what the answers are stored under (the callback's `r`). */
  readonly requestHash: Uint8Array
  /** When this device made the request (its clock, ms); the request's `CREATED_AT` is chain-clamped. */
  readonly createdAt: number
  /** When the poll stops: the protocol's 10 minutes after `createdAt`. */
  readonly expiresAt: number
  /** Chain time at `createdAt`: the verifier's clock is this plus the time elapsed here. */
  readonly chainTimeAtCreation: number
  /** The identity a renewal is for (`IDENTITY_HINT`); null for a sign-in. */
  readonly identityHint: string | null
  /** Held only in memory; zeroed by {@link disposeV2Request}. */
  readonly appEphemeralPriv: Uint8Array
}

/**
 * A fresh v2 request. `callbackUrl` builds the deep link's `cb` from the request hash (null:
 * none); only {@link V2LoginRequest.linkUri} carries it.
 */
export function newV2LoginRequest(
  network: Network,
  forge: ForgeIds,
  p: {
    readonly connectionId: Uint8Array
    readonly chainNow: number
    readonly identityHint?: string
    readonly now?: number
    readonly callbackUrl?: (requestHash: Uint8Array) => string | null
    readonly sync?: boolean
  },
): V2LoginRequest {
  const now = p.now ?? Date.now()
  const priv = secp.utils.randomSecretKey()
  const request = forgeV2Request(forge, {
    appEphemeralPubKey: secp.getPublicKey(priv, true),
    connectionId: p.connectionId,
    chainNow: p.chainNow,
    now,
    ...(p.identityHint !== undefined ? { identityHint: p.identityHint } : {}),
    ...(p.sync !== undefined ? { sync: p.sync } : {}),
  })
  const requestHash = appConnectRequestHash(request)
  const callback = p.callbackUrl?.(requestHash)
  const qrUri = buildAppConnectUri(request, network)
  return {
    request,
    syncContract: syncContract(forge, p.sync),
    qrUri,
    linkUri: callback ? buildAppConnectUri(request, network, callback) : qrUri,
    requestHash,
    createdAt: now,
    expiresAt: now + APP_CONNECT_MAX_REQUEST_AGE_MS,
    chainTimeAtCreation: p.chainNow,
    identityHint: p.identityHint ?? null,
    appEphemeralPriv: priv,
  }
}

export function disposeV2Request(req: V2LoginRequest): void {
  req.appEphemeralPriv.fill(0)
}

/** Chain time (ms) and protocol version; this device's clock and null when the read fails. */
export async function readChainClock(sdk: EvoSDK): Promise<{ readonly timeMs: number; readonly protocolVersion: number | null }> {
  try {
    const clock = await withTimeout(appConnectPort(sdk).chainClock(), PLATFORM_READ_MS, 'Reading the time on Platform')
    if (Number.isSafeInteger(clock.timeMs) && clock.timeMs > 0) return clock
  } catch {
    /* fall back below */
  }
  return { timeMs: Date.now(), protocolVersion: null }
}

/**
 * Whether a v2 request can be offered here: Forge is deployed on the network (its contract group
 * exists) and the chain runs protocol 14 or later; null when Platform could not be read. The
 * caller also runs the group check (`AuthController.checkGroup`) before showing a code.
 */
export async function appConnectV2Available(sdk: EvoSDK, network: Network): Promise<boolean | null> {
  if (NETWORKS[network].v2 === null) return false
  const { protocolVersion } = await readChainClock(sdk)
  return protocolVersion === null ? null : protocolVersion >= APP_CONNECT_MIN_PROTOCOL
}

/** Why Forge refused a wallet's v2 answer, in a user's words. */
const REFUSED: Partial<Record<AppConnectRejectReason, string>> = {
  'key-disabled': 'The key your wallet sent is already disabled.',
  'key-expired': 'The key your wallet sent expires within the hour.',
  'budget-exhausted': 'The key your wallet sent has no budget left.',
  'key-limits': 'The key your wallet sent has no spending limit or no expiry.',
  'key-level': 'The key your wallet sent can do more than Forge asked for.',
  'key-master': 'Your wallet sent its master key.',
  'key-unmatched': 'The key your wallet sent is for something other than Dash Forge.',
  'key-unbound': 'The key your wallet sent is not limited to Dash Forge.',
}

/** A wallet's v2 answer that Forge will not use (the verifier's `reason`). */
export class WalletGrantRefused extends UnusableWalletKey {
  constructor(readonly reason: AppConnectRejectReason) {
    super(`${REFUSED[reason] ?? "Your wallet's answer doesn't match what Forge asked for."} Forge didn't use it. Start again; if it happens again, sign in another way.`)
    this.name = 'WalletGrantRefused'
  }
}

/** More answers reached the request than Forge reads (junk): it cannot tell which is the user's. */
export class TooManyAnswers extends Error {
  constructor() {
    super("So many answers reached this sign-in request that Forge can't check them all. Start again and keep the QR code private.")
    this.name = 'TooManyAnswers'
  }
}

/**
 * Cuts the poll's wait short: the UI fires it when the tab regains focus or the wallet's callback
 * page says it answered. A fire while nothing waits makes the next wait return at once.
 */
export class PollTrigger {
  private wake: (() => void) | null = null
  private pending = false

  fire(): void {
    if (this.wake) this.wake()
    else this.pending = true
  }

  /** Wait `ms`, or until fired; rejects with AbortError on `signal`. */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('cancelled', 'AbortError'))
        return
      }
      if (this.pending) {
        this.pending = false
        resolve()
        return
      }
      const end = (): void => {
        clearTimeout(t)
        signal?.removeEventListener('abort', onAbort)
        this.wake = null
      }
      const onAbort = (): void => {
        end()
        reject(new DOMException('cancelled', 'AbortError'))
      }
      const t = setTimeout(() => {
        end()
        resolve()
      }, ms)
      this.wake = () => {
        end()
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** A verified v2 grant: the answering identity and its key, checked by Forge's own rules. */
export interface V2Grant {
  readonly identityId: string
  readonly key: WalletKey
  /** forge-user's encryption key (settings sync), when the request asked and the wallet sent it; the holder wipes `secret`. */
  readonly syncKey?: { readonly keyId: number; readonly secret: Uint8Array }
}

/** Wipe a grant's sync key (once stored, or when the grant is dropped). */
export function wipeGrant(grant: V2Grant | null): void {
  grant?.syncKey?.secret.fill(0)
}

/**
 * Whether a granted encryption key is forge-user's sync key: ECDSA_SECP256K1, ENCRYPTION, bound to
 * forge-user alone, not disabled, and its public key is the private key's. (The vendored verifier
 * checked the same and that Platform resolves it as the contract's current key; checked again
 * here because this is what Forge relies on.)
 */
export function isSyncKey(granted: AppConnectGrant['encryptionKeys'][number], contract: string): boolean {
  const k = granted.key
  if (granted.role !== 'encryption' || k.purpose !== KeyPurpose.ENCRYPTION || k.type !== KeyType.ECDSA_SECP256K1) return false
  if (k.disabledAt !== undefined || k.bounds?.kind !== 'singleContract' || k.bounds.contractId !== contract) return false
  try {
    const pub = secp.getPublicKey(granted.privateKey, true)
    return pub.length === k.data.length && pub.every((b, i) => b === k.data[i])
  } catch {
    return false
  }
}

/** Rejections that mean "not an answer to this request" (another request's, or tampered). */
const NOT_AN_ANSWER: ReadonlySet<AppConnectRejectReason> = new Set(['decrypt', 'framing', 'hint-mismatch'])

/**
 * The verifier's grant as a {@link V2Grant}: its key as a WIF, read back and checked with
 * {@link findWalletKey} (group-bound, AUTHENTICATION / HIGH, live, with its budget and expiry).
 * Null when the node read does not show the key yet. The grant's private keys are zeroed.
 */
async function grantOf(
  sdk: EvoSDK,
  grant: AppConnectGrant,
  p: { readonly network: Network; readonly forge: ForgeIds; readonly syncContract: string | null },
): Promise<V2Grant | null> {
  try {
    const [main, ...others] = grant.authKeys
    if (!main || others.length > 0 || main.role !== 'contractGroup') throw new WalletGrantRefused('framing')
    const [enc, ...moreEnc] = grant.encryptionKeys
    if (moreEnc.length > 0 || (enc !== undefined && (p.syncContract === null || !isSyncKey(enc, p.syncContract)))) throw new WalletGrantRefused('framing')
    let key: WalletKey | null
    try {
      key = await findWalletKey(sdk, { identityId: grant.identityId, wif: encodeWif(main.privateKey, p.network), forge: p.forge, network: p.network })
    } catch (e) {
      // Disabled since the verifier read it: said in the verifier's words.
      throw e instanceof RevokedWalletKey ? new WalletGrantRefused('key-disabled') : e
    }
    if (key === null) return null
    if (key.keyId !== main.key.id || isUnlimited(key) || key.scope.unbounded) throw new WalletGrantRefused('key-limits')
    return { identityId: grant.identityId, key, ...(enc !== undefined ? { syncKey: { keyId: enc.key.id, secret: enc.privateKey.slice() } } : {}) }
  } finally {
    for (const g of [...grant.authKeys, ...grant.encryptionKeys]) g.privateKey.fill(0)
  }
}

/**
 * Poll the App Connect contract until an identity's answer to `req` is verified, then keep
 * polling for `settleMs` for a competing answer before returning it; only rounds that read every
 * answer count towards that window. Refuses ({@link AmbiguousWalletLogin}) when two identities
 * answered: every answer that opens with this request's key counts, accepted or not, so an
 * attacker's quick answer cannot win over the user's slow one. More answers than the poller reads
 * is {@link TooManyAnswers}.
 *
 * A renewal (`req.identityHint`) reads only that identity's answer, so nothing can compete with
 * it: no settle window, and its refusal is final at once. An answer whose key a node does not
 * show yet (or whose budget it has not seen) is checked again on the next poll.
 *
 * Polls on the protocol's cadence ({@link appConnectPollDelayMs}: every 2 s for a minute, then
 * every 4 s), at once when `trigger` fires. Rejects with {@link RequestExpired} after 10 minutes,
 * AbortError on `signal`, {@link WalletGrantRefused} (or another {@link UnusableWalletKey}) for
 * the sole answer Forge will not use. The request is spent either way ({@link disposeV2Request}).
 */
export async function awaitV2Grant(
  sdk: EvoSDK,
  req: V2LoginRequest,
  p: {
    readonly network: Network
    readonly forge: ForgeIds
    readonly signal?: AbortSignal
    readonly trigger?: PollTrigger
    readonly intervalMs?: number
    readonly settleMs?: number
    readonly now?: () => number
    readonly onStatus?: (status: PollStatus) => void
  },
): Promise<V2Grant> {
  const now = p.now ?? Date.now
  const hint = req.identityHint ?? undefined
  const settleMs = hint !== undefined ? 0 : (p.settleMs ?? 3000)
  const trigger = p.trigger ?? new PollTrigger()
  const port = appConnectPort(sdk)
  /** Per answering identity: its grant, null (check again), or why Forge will not use it. */
  const answered = new Map<string, V2Grant | UnusableWalletKey | null>()
  /** Every identity whose answer opened with this request's key. */
  const responders = new Set<string>()
  /** Answers already found not to be answers to this request, by exact contents. */
  const notAnswers = new Set<string>()
  let cleanSince = 0
  let firstAt = 0
  let returned: V2Grant | null = null
  try {
    for (;;) {
      if (p.signal?.aborted) throw new DOMException('cancelled', 'AbortError')
      // A failed read is never "no answers": the round does not count towards the settle window.
      const page = await listAppConnectCandidates(port, req.requestHash, hint !== undefined ? { hint } : {}).catch(() => null)
      if (page?.truncated) throw new TooManyAnswers()
      const complete = page !== null
      for (const c of page?.candidates ?? []) {
        const prior = answered.get(c.ownerId)
        if (prior !== undefined && prior !== null) continue
        const contents = appConnectCandidateKey(c)
        if (notAnswers.has(contents)) continue
        let answer: V2Grant | UnusableWalletKey | null = null
        try {
          const chainNow = req.chainTimeAtCreation + (now() - req.createdAt)
          const verdict = await verifyAppConnectCandidate({ request: req.request, appEphemeralPrivateKey: req.appEphemeralPriv, candidate: c, identity: port, now: chainNow })
          if (!verdict.ok && NOT_AN_ANSWER.has(verdict.reason)) {
            notAnswers.add(contents)
            continue
          }
          // It opened: this identity saw the QR and answered, whatever its key turns out to be.
          responders.add(c.ownerId)
          if (verdict.ok) answer = await grantOf(sdk, verdict.grant, { network: p.network, forge: p.forge, syncContract: req.syncContract })
          else if (!verdict.retryable) answer = new WalletGrantRefused(verdict.reason)
        } catch (e) {
          // Only reads fail past the decryption: this identity answered; check it again next poll.
          responders.add(c.ownerId)
          if (e instanceof UnusableWalletKey) answer = e
        }
        // The one identity a renewal listens to: its refusal is final.
        if (answer instanceof UnusableWalletKey && hint !== undefined) throw answer
        answered.set(c.ownerId, answer)
        if (answer !== null && firstAt === 0) firstAt = now()
      }
      if (responders.size > 1) throw new AmbiguousWalletLogin([...responders])
      const t = now()
      if (complete) {
        if (cleanSince === 0) cleanSince = t
      } else {
        cleanSince = 0
      }
      p.onStatus?.(!complete ? 'incomplete-read' : firstAt !== 0 ? 'answered' : 'waiting')
      const only = [...answered.values()].find((a) => a !== null)
      if (only && cleanSince !== 0 && t - Math.max(firstAt, cleanSince) >= settleMs) {
        if (only instanceof UnusableWalletKey) throw only
        returned = only
        return only
      }
      const delay = p.intervalMs ?? appConnectPollDelayMs(t - req.createdAt)
      if (t >= req.expiresAt || delay === null) throw new RequestExpired()
      await trigger.wait(delay, p.signal)
    }
  } finally {
    disposeV2Request(req)
    for (const a of answered.values()) if (a !== returned && a !== null && !(a instanceof UnusableWalletKey)) wipeGrant(a)
  }
}
