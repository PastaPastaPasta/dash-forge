/**
 * "Use my Dash wallet" (`ux-dx-spec.md` §2.2 tile 1; docs/design/wallet-login.md).
 *
 * The app draws an ephemeral secp256k1 key and shows a `dash-key:` request (QR, or a deep link
 * on a phone) naming ONE Forge contract, in the exact layout the shipped Dash wallets parse
 * ({@link ./wallet-protocol}). A wallet that approves publishes a `loginKeyResponse`, under its
 * identity, keyed by `hash160(appEphemeralPub)`, in one of two places:
 *
 *   - the legacy key-exchange contract (yappr's, `7Uaq…` on testnet; a copy on devnets): what
 *     the shipped wallets publish to. One response per (contract, request), a single 32-byte
 *     login key, and the wallet registers its keys only when the app asks (QR #2, `dash-st:`,
 *     {@link ./key-registration});
 *   - the App Connect system contract (protocol 14, every network): one response per
 *     (request, identity), one or more login keys, registered before publishing.
 *
 * The app polls every source this network has, decrypts, derives the auth key(s), finds them
 * on the responder's identity and checks them ({@link findWalletKey}): live, AUTHENTICATION /
 * HIGH, inside Forge's contracts, not expired or spent. Keys that are not registered yet (a
 * legacy first login) come back as a `register` answer for the UI to show QR #2; a key that
 * was registered and then disabled is refused (the wallet would re-add the same key).
 *
 * Who answered is NOT proven by the response (`app-connect.md`, step 3): anyone who saw the QR
 * can answer from their own identity. On App Connect, two answers are visible and refused. On
 * the legacy contract they are not: its unique index keeps the FIRST answer only, so someone
 * who saw the QR and answers first is the one shown. The defence there is the confirmation
 * step (full id, DPNS name, identity age, a mismatch with this device's stored identity, and
 * "compare with your wallet"), and never settling on a round that could not read every source.
 * The pairing code is shown for wallets that display one (the shipped ones do not yet).
 */

import * as secp from '@noble/secp256k1'
import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { DEPLOYMENTS, type ForgeIds } from '../deployments'
import { authSdk, sleep } from '../sdk/facade'
import { base64ToBytes, bytesToBase64 } from '../sdk/query'
import { hash160 } from './asset-lock'
import { base58Decode } from './base58'
import { findWalletKey, loginKeys, scopeCovers, UnusableWalletKey, type LoginKeys, type WalletKey } from './key-registration'
import { encodeWif } from './wif'
import { authKeyFromLogin, encodeKeyRequest, openEnvelope, pairingCode, protocolUri } from './wallet-protocol'

/** The App Connect system contract (the same id on every network, protocol 14). */
export const APP_CONNECT_CONTRACT_ID = 'H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ'

/** How long a request is shown before it must be renewed. */
export const REQUEST_TTL_MS = 5 * 60 * 1000

/** Where a network's wallets publish login responses. */
export interface ResponseSource {
  readonly kind: 'legacy' | 'app-connect'
  readonly contractId: string
}

/**
 * The legacy key-exchange contract recorded for a deployment (`keyExchange.contractId` in
 * `forge-contracts/deployments/<key>.json`), or null.
 */
function legacyKeyExchangeId(deploymentKey: string): string | null {
  return DEPLOYMENTS[deploymentKey]?.keyExchange?.contractId || null
}

/** The sources that exist on chain here (checked, so a missing contract hides nothing else). */
export async function responseSources(sdk: EvoSDK, deploymentKey: string): Promise<ResponseSource[]> {
  const candidates: ResponseSource[] = [{ kind: 'app-connect', contractId: APP_CONNECT_CONTRACT_ID }]
  const legacy = legacyKeyExchangeId(deploymentKey)
  if (legacy) candidates.unshift({ kind: 'legacy', contractId: legacy })
  const found = await Promise.all(
    candidates.map(async (s) => {
      try {
        return (await authSdk(sdk).contracts.fetch(s.contractId)) ? s : null
      } catch {
        return null
      }
    }),
  )
  return found.filter((s): s is ResponseSource => s !== null)
}

export interface LoginRequest {
  /** The `dash-key:` URI to show as a QR and a deep link. */
  readonly uri: string
  /** The contract the wallet is asked to bind its key to (forge-core or forge-collab). */
  readonly contractId: string
  /** Six digits a wallet that shows a pairing code must show too. */
  readonly pairingCode: string
  readonly appEphemeralPubKeyHash: Uint8Array
  /** When the request stops being polled (ms). */
  readonly expiresAt: number
  /** Held only in memory; zeroed by {@link disposeRequest}. */
  readonly appEphemeralPriv: Uint8Array
}

/** A fresh request for a key bound to `contractId`. */
export function newLoginRequest(network: Network, contractId: string, label = 'Dash Forge', now = Date.now()): LoginRequest {
  const priv = secp.utils.randomSecretKey()
  const pub = secp.getPublicKey(priv, true)
  return {
    uri: protocolUri('dash-key', encodeKeyRequest(pub, base58Decode(contractId), label), network),
    contractId,
    pairingCode: pairingCode(pub),
    appEphemeralPubKeyHash: hash160(pub),
    expiresAt: now + REQUEST_TTL_MS,
    appEphemeralPriv: priv,
  }
}

export function disposeRequest(req: LoginRequest): void {
  req.appEphemeralPriv.fill(0)
}

/** One response, from either source. */
export interface WalletResponse {
  readonly source: ResponseSource['kind']
  readonly ownerId: string
  readonly walletEphemeralPub: Uint8Array
  readonly payload: Uint8Array
}

interface ResponseJson {
  $ownerId: string
  walletEphemeralPubKey: string
  encryptedPayload: string
  contractId?: string
}

/**
 * Every response to `req` from `sources`, and whether every source was read in full. A failed
 * or cut-short read is never "no answers": the poll does not settle on a round that missed one.
 */
async function fetchResponses(sdk: EvoSDK, sources: readonly ResponseSource[], req: LoginRequest): Promise<{ responses: WalletResponse[]; complete: boolean }> {
  const hash = bytesToBase64(req.appEphemeralPubKeyHash)
  const responses: WalletResponse[] = []
  let complete = true
  for (const source of sources) {
    const rows = source.kind === 'legacy' ? await legacyRows(sdk, source.contractId, req.contractId, hash) : await appConnectRows(sdk, hash)
    if (rows === null) {
      complete = false
      continue
    }
    for (const j of rows) {
      // The legacy query is by contract; re-check it so a node cannot hand us another app's.
      if (source.kind === 'legacy' && !sameIdentifier(j.contractId, req.contractId)) continue
      try {
        responses.push({ source: source.kind, ownerId: j.$ownerId, walletEphemeralPub: base64ToBytes(j.walletEphemeralPubKey), payload: base64ToBytes(j.encryptedPayload) })
      } catch {
        /* malformed row */
      }
    }
  }
  return { responses, complete }
}

/**
 * Whether a document's identifier field (`toJSON` renders it base58; some SDK builds render
 * byte fields base64) is `expected` (base58), compared as bytes.
 */
export function sameIdentifier(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') return false
  const want = base58Decode(expected)
  const candidates: (() => Uint8Array)[] = [() => base58Decode(value), () => base64ToBytes(value)]
  return candidates.some((decode) => {
    try {
      const got = decode()
      return got.length === 32 && got.every((b, i) => b === want[i])
    } catch {
      return false
    }
  })
}

async function query(sdk: EvoSDK, q: unknown): Promise<ResponseJson[] | null> {
  try {
    const rows = await authSdk(sdk).documents.query(q)
    return [...rows.values()].filter(Boolean).map((r) => (r as { toJSON(): ResponseJson }).toJSON())
  } catch {
    return null
  }
}

/**
 * The legacy contract: a unique (contractId, appEphemeralPubKeyHash) index, so at most ONE row
 * per request. The first identity to answer holds it: a second answerer cannot be seen here,
 * which is why the confirmation step matters (docs/design/wallet-login.md). Null: read failed.
 */
async function legacyRows(sdk: EvoSDK, keyExchange: string, appContract: string, hash: string): Promise<ResponseJson[] | null> {
  return query(sdk, {
    dataContractId: keyExchange,
    documentTypeName: 'loginKeyResponse',
    where: [
      ['contractId', '==', appContract],
      ['appEphemeralPubKeyHash', '==', hash],
    ],
    limit: 1,
  })
}

/** App Connect: one row per responding identity, paged by `$ownerId`. Null: a page failed. */
async function appConnectRows(sdk: EvoSDK, hash: string): Promise<ResponseJson[] | null> {
  const out: ResponseJson[] = []
  let after: string | null = null
  for (let page = 0; page < 20; page++) {
    const batch = await query(sdk, {
      dataContractId: APP_CONNECT_CONTRACT_ID,
      documentTypeName: 'loginKeyResponse',
      where: [['appEphemeralPubKeyHash', '==', hash], ...(after ? [['$ownerId', '>', after]] : [])],
      orderBy: [
        ['appEphemeralPubKeyHash', 'asc'],
        ['$ownerId', 'asc'],
      ],
      limit: 50,
    })
    if (batch === null) return null
    out.push(...batch)
    if (batch.length < 50) return out
    after = batch[batch.length - 1]?.$ownerId ?? null
  }
  // A thousand answers to one request is junk flooding: do not call that a complete read.
  return null
}

/** What a response amounts to once decrypted and checked against the chain. */
export type WalletAnswer =
  /** Keys Forge verified on chain (first: the one for the requested contract, when there is one). */
  | { readonly kind: 'keys'; readonly identityId: string; readonly keys: readonly WalletKey[]; readonly source: ResponseSource['kind'] }
  /** A legacy wallet's first login here: its keys must be registered (QR #2) before use. */
  | { readonly kind: 'register'; readonly identityId: string; readonly keys: LoginKeys; readonly wif: string; readonly source: 'legacy' }

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

/** Decrypt a response: its login keys, or null when it was not encrypted to this request. */
async function decrypt(req: LoginRequest, r: WalletResponse): Promise<Uint8Array[] | null> {
  let keys: Uint8Array[]
  try {
    keys = await openEnvelope(req.appEphemeralPriv, r.walletEphemeralPub, r.payload)
  } catch {
    return null
  }
  // The legacy contract carries exactly one key (its schema fixes the payload at 60 bytes).
  if (r.source === 'legacy' && keys.length !== 1) {
    for (const k of keys) k.fill(0)
    return null
  }
  return keys
}

/**
 * Turn a decrypted response into an answer, or null when it cannot be used yet (an App Connect
 * key not visible on chain yet: the next poll retries). Throws {@link UnusableWalletKey} when
 * the key is there but Forge must not use it ({@link RevokedWalletKey}: it was disabled). The
 * login keys are zeroed whatever happens.
 */
async function answerFor(sdk: EvoSDK, r: WalletResponse, loginKeysRaw: Uint8Array[], p: { network: Network; forge: ForgeIds; contractId: string }): Promise<WalletAnswer | null> {
  const found: WalletKey[] = []
  let unregistered: { keys: LoginKeys; wif: string } | null = null
  /** A key of this answer Forge must not use; thrown only if the answer has no usable key. */
  let refused: UnusableWalletKey | null = null
  try {
    for (const login of loginKeysRaw) {
      const auth = authKeyFromLogin(login, r.ownerId)
      const wif = encodeWif(auth, p.network)
      auth.fill(0)
      let key: WalletKey | null
      try {
        key = await findWalletKey(sdk, { identityId: r.ownerId, wif, forge: p.forge, network: p.network })
      } catch (e) {
        if (!(e instanceof UnusableWalletKey)) throw e
        refused = e
        continue
      }
      if (key) found.push(key)
      else if (r.source === 'legacy') unregistered = { keys: loginKeys(login, r.ownerId), wif }
    }
  } catch (e) {
    zeroLoginKeys(unregistered?.keys)
    throw e
  } finally {
    for (const k of loginKeysRaw) k.fill(0)
  }
  if (found.length > 0) {
    zeroLoginKeys(unregistered?.keys)
    // The key for the contract asked for first.
    found.sort((a, b) => Number(scopeCovers(b.scope, p.forge, p.contractId)) - Number(scopeCovers(a.scope, p.forge, p.contractId)))
    return { kind: 'keys', identityId: r.ownerId, keys: found, source: r.source }
  }
  if (refused) {
    zeroLoginKeys(unregistered?.keys)
    throw refused
  }
  if (unregistered) return { kind: 'register', identityId: r.ownerId, ...unregistered, source: 'legacy' }
  return null
}

function zeroLoginKeys(k: LoginKeys | undefined): void {
  k?.authPriv.fill(0)
  k?.encPriv.fill(0)
}

/** Why the poll is waiting, for the UI. */
export type PollStatus = 'waiting' | 'answered' | 'incomplete-read'

/**
 * Poll every source until an identity's answer is usable, then keep polling for `settleMs` for
 * a competing answer before returning it; only rounds that read every source in full count
 * towards that window. Refuses when two identities answered (App Connect; the legacy contract
 * holds one answer per request, so there a second answerer cannot be seen). With `identityId`,
 * answers from any other identity are ignored (a second grant for a signed-in identity).
 *
 * An answerer whose key Forge must not use ({@link UnusableWalletKey}) is skipped but still
 * counted towards "more than one answered"; if it is the only answer when the window closes,
 * its reason is thrown. Rejects with {@link RequestExpired} at `req.expiresAt` and AbortError
 * on `signal`. `onStatus` reports incomplete reads ("couldn't read all answer sources").
 */
export async function awaitWalletAnswer(
  sdk: EvoSDK,
  req: LoginRequest,
  p: {
    network: Network
    forge: ForgeIds
    sources: readonly ResponseSource[]
    identityId?: string
    signal?: AbortSignal
    intervalMs?: number
    settleMs?: number
    now?: () => number
    onStatus?: (status: PollStatus) => void
  },
): Promise<WalletAnswer> {
  const now = p.now ?? Date.now
  const settleMs = p.settleMs ?? 3000
  /** Per answering identity: its answer, null (retry), or why it cannot be used. */
  const answered = new Map<string, WalletAnswer | UnusableWalletKey | null>()
  /** When the current run of complete reads began (0 while the last read was incomplete). */
  let cleanSince = 0
  let firstAt = 0
  let result: WalletAnswer | null = null
  try {
    for (;;) {
      if (p.signal?.aborted) throw new DOMException('cancelled', 'AbortError')
      const round = await fetchResponses(sdk, p.sources, req)
      for (const r of round.responses) {
        if (p.identityId !== undefined && r.ownerId !== p.identityId) continue
        const prior = answered.get(r.ownerId)
        if (prior !== undefined && prior !== null) continue
        const keys = await decrypt(req, r)
        if (keys === null) continue
        let answer: WalletAnswer | UnusableWalletKey | null = null
        try {
          answer = await answerFor(sdk, r, keys, { network: p.network, forge: p.forge, contractId: req.contractId })
        } catch (e) {
          if (e instanceof UnusableWalletKey) {
            // The one identity a grant listens to: its answer is final.
            if (p.identityId !== undefined) throw e
            answer = e
          }
          // Otherwise a read failed: try this response again next round.
        }
        answered.set(r.ownerId, answer)
        if (answer !== null && firstAt === 0) firstAt = now()
      }
      // Only decided answers count (usable or refused); one still waiting for a read does not.
      const decided = [...answered.entries()].filter(([, a]) => a !== null)
      if (decided.length > 1) throw new AmbiguousWalletLogin(decided.map(([id]) => id))
      const t = now()
      if (round.complete) {
        if (cleanSince === 0) cleanSince = t
      } else {
        cleanSince = 0
      }
      p.onStatus?.(!round.complete ? 'incomplete-read' : firstAt ? 'answered' : 'waiting')
      const only = decided[0]?.[1]
      if (only && cleanSince !== 0 && t - Math.max(firstAt, cleanSince) >= settleMs) {
        if (only instanceof UnusableWalletKey) throw only
        result = only
        return only
      }
      if (t >= req.expiresAt) throw new RequestExpired()
      await sleep(p.intervalMs ?? 3000, p.signal)
    }
  } finally {
    disposeRequest(req)
    // Registration keys of answers not handed back.
    for (const a of answered.values()) if (a && !(a instanceof Error) && a !== result && a.kind === 'register') zeroLoginKeys(a.keys)
  }
}

/**
 * After QR #2: wait until the login key's auth key is live on `identityId`, then verify it.
 * The wallet rebuilds the update itself, so the key may land under a different id than the one
 * QR #2 proposed.
 */
export async function awaitRegisteredKey(
  sdk: EvoSDK,
  p: { identityId: string; wif: string; network: Network; forge: ForgeIds; until: number; signal?: AbortSignal; intervalMs?: number },
): Promise<WalletKey> {
  for (;;) {
    if (p.signal?.aborted) throw new DOMException('cancelled', 'AbortError')
    let key: WalletKey | null = null
    try {
      key = await findWalletKey(sdk, p)
    } catch (e) {
      if (e instanceof UnusableWalletKey) throw e
    }
    if (key) return key
    if (Date.now() >= p.until) throw new RequestExpired()
    await sleep(p.intervalMs ?? 3000, p.signal)
  }
}

/** Whether any response source exists here (hide the wallet tile otherwise). */
export async function walletLoginAvailable(sdk: EvoSDK, deploymentKey: string): Promise<boolean> {
  return (await responseSources(sdk, deploymentKey)).length > 0
}
