/**
 * "Use my Dash wallet" with App Connect v2 (`APP_CONNECT_PROFILE.md`; docs/design/wallet-login.md,
 * "Upgrade path"), beside the v1 flow in {@link ./app-connect}, which stays as it is: a wallet that
 * speaks only v1 refuses a `v=2` request, so the two never share a QR code.
 *
 * One request asks for ONE key: AUTHENTICATION / HIGH, bound to the dash-forge contract group, with
 * Forge's default budget and expiry ({@link defaultLimits}, from chain time). It covers every Forge
 * contract, so no further grants are asked for. The request's app is forge-core (its owner is the
 * group's owner, as the profile's owner rule needs); no encryption key is asked for, since no Forge
 * contract allows a wallet-issued one (members-only content is set up in Settings).
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
import { AmbiguousWalletLogin, RequestExpired, type PollStatus } from './app-connect'
import { appConnectPort } from './app-connect-port'
import { decodeIdentifier } from './base58'
import { PLATFORM_READ_MS } from './connect'
import { findWalletKey, isUnlimited, RevokedWalletKey, UnusableWalletKey, type WalletKey } from './key-registration'
import { defaultLimits } from './limited-key'
import { encodeWif } from './wif'

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

/** The request Forge makes: one group-bound HIGH key with Forge's default limits. */
export function forgeV2Request(
  forge: ForgeIds,
  p: {
    readonly appEphemeralPubKey: Uint8Array
    readonly connectionId: Uint8Array
    /** Chain time (ms): the proposed expiry counts from it. */
    readonly chainNow: number
    /** This device's clock (ms): `CREATED_AT`. */
    readonly now: number
    /** The identity a renewal is for. */
    readonly identityHint?: string
  },
): AppConnectRequest {
  const limits = defaultLimits(p.chainNow)
  return {
    appEphemeralPubKey: p.appEphemeralPubKey,
    appId: decodeIdentifier(forge.core),
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
    encBindings: [],
    createdAt: p.now,
    connectionId: p.connectionId,
    ...(p.identityHint !== undefined ? { identityHint: decodeIdentifier(p.identityHint) } : {}),
    ...(RENEW_MODE && p.identityHint !== undefined ? { mode: 'renew' as const } : {}),
  }
}

export interface V2LoginRequest {
  readonly request: AppConnectRequest
  /** For the QR code: no callback (a shorter code, and the phone has no Forge tab to return to). */
  readonly qrUri: string
  /** For a wallet on this device: the same request, with the callback when one was given. */
  readonly linkUri: string
  /** `hash160(appEphemeralPub)`: what the answers are stored under (the callback's `r`). */
  readonly requestHash: Uint8Array
  /** `CREATED_AT`, this device's clock (ms). */
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
  })
  const requestHash = appConnectRequestHash(request)
  const callback = p.callbackUrl?.(requestHash)
  const qrUri = buildAppConnectUri(request, network)
  return {
    request,
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
 * exists) and the chain runs protocol 14 or later. The caller also runs the group check
 * (`AuthController.checkGroup`) before showing a code.
 */
export async function appConnectV2Available(sdk: EvoSDK, network: Network): Promise<boolean> {
  if (NETWORKS[network].v2 === null) return false
  const { protocolVersion } = await readChainClock(sdk)
  return protocolVersion !== null && protocolVersion >= APP_CONNECT_MIN_PROTOCOL
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
}

/** Rejections that mean "not an answer to this request" (another request's, or tampered). */
const NOT_AN_ANSWER: ReadonlySet<AppConnectRejectReason> = new Set(['decrypt', 'framing', 'hint-mismatch'])

/**
 * The verifier's grant as a {@link V2Grant}: its key as a WIF, read back and checked with
 * {@link findWalletKey} (group-bound, AUTHENTICATION / HIGH, live, with its budget and expiry).
 * Null when the node read does not show the key yet. The grant's private keys are zeroed.
 */
async function grantOf(sdk: EvoSDK, grant: AppConnectGrant, p: { readonly network: Network; readonly forge: ForgeIds }): Promise<V2Grant | null> {
  try {
    const [main, ...others] = grant.authKeys
    if (!main || others.length > 0 || grant.encryptionKeys.length > 0 || main.role !== 'contractGroup') throw new WalletGrantRefused('framing')
    let key: WalletKey | null
    try {
      key = await findWalletKey(sdk, { identityId: grant.identityId, wif: encodeWif(main.privateKey, p.network), forge: p.forge, network: p.network })
    } catch (e) {
      // Disabled since the verifier read it: v1's wording (a key derived the same every time) is wrong here.
      throw e instanceof RevokedWalletKey ? new WalletGrantRefused('key-disabled') : e
    }
    if (key === null) return null
    if (key.keyId !== main.key.id || isUnlimited(key) || key.scope.unbounded) throw new WalletGrantRefused('key-limits')
    return { identityId: grant.identityId, key }
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
          if (verdict.ok) answer = await grantOf(sdk, verdict.grant, { network: p.network, forge: p.forge })
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
        return only
      }
      const delay = p.intervalMs ?? appConnectPollDelayMs(t - req.createdAt)
      if (t >= req.expiresAt || delay === null) throw new RequestExpired()
      await trigger.wait(delay, p.signal)
    }
  } finally {
    disposeV2Request(req)
  }
}
