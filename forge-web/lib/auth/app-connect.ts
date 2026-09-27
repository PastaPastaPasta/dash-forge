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
 * on the responder's identity and checks them ({@link verifyWalletKey}): live, AUTHENTICATION /
 * HIGH, inside Forge's contracts, not expired or spent. Keys that are not registered yet (a
 * legacy first login) come back as a `register` answer for the UI to show QR #2.
 *
 * Who answered is NOT proven by the response (`app-connect.md`, step 3): anyone who saw the QR
 * can answer from their own identity. So the flow shows the full identity id and DPNS name for
 * the user to confirm, and refuses when more than one identity answered. The pairing code is
 * shown for wallets that display one (the shipped ones do not yet: docs/upstream/).
 */

import * as secp from '@noble/secp256k1'
import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { DEPLOYMENTS, type ForgeIds } from '../deployments'
import { authSdk, sleep } from '../sdk/facade'
import { hash160 } from './asset-lock'
import { base58Decode, base58Encode } from './base58'
import { loginKeys, verifyWalletKey, UnusableWalletKey, type LoginKeys, type WalletKey } from './key-registration'
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
export function legacyKeyExchangeId(deploymentKey: string): string | null {
  const file = DEPLOYMENTS[deploymentKey] as { keyExchange?: { contractId?: string | null } } | undefined
  return file?.keyExchange?.contractId || null
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

function b64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}
function toB64(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b))
}

interface ResponseJson {
  $ownerId: string
  walletEphemeralPubKey: string
  encryptedPayload: string
  contractId?: string
}

/** Every response to `req` from `sources`. A read that fails yields nothing this round. */
export async function fetchResponses(sdk: EvoSDK, sources: readonly ResponseSource[], req: LoginRequest): Promise<WalletResponse[]> {
  const hash = toB64(req.appEphemeralPubKeyHash)
  const out: WalletResponse[] = []
  for (const source of sources) {
    const rows = source.kind === 'legacy' ? await legacyRows(sdk, source.contractId, req.contractId, hash) : await appConnectRows(sdk, hash)
    for (const j of rows) {
      // The legacy query is by contract; re-check it so a node cannot hand us another app's.
      if (source.kind === 'legacy' && j.contractId !== req.contractId) continue
      try {
        out.push({ source: source.kind, ownerId: j.$ownerId, walletEphemeralPub: b64(j.walletEphemeralPubKey), payload: b64(j.encryptedPayload) })
      } catch {
        /* malformed row */
      }
    }
  }
  return out
}

async function query(sdk: EvoSDK, q: unknown): Promise<ResponseJson[] | null> {
  try {
    const rows = await authSdk(sdk).documents.query(q)
    return [...rows.values()].filter(Boolean).map((r) => (r as { toJSON(): ResponseJson }).toJSON())
  } catch {
    return null
  }
}

/** The legacy contract: a unique (contractId, appEphemeralPubKeyHash) index — at most one row. */
async function legacyRows(sdk: EvoSDK, keyExchange: string, appContract: string, hash: string): Promise<ResponseJson[]> {
  return (
    (await query(sdk, {
      dataContractId: keyExchange,
      documentTypeName: 'loginKeyResponse',
      where: [
        ['contractId', '==', appContract],
        ['appEphemeralPubKeyHash', '==', hash],
      ],
      limit: 2,
    })) ?? []
  )
}

/** App Connect: one row per responding identity, paged by `$ownerId` (junk cannot hide ours). */
async function appConnectRows(sdk: EvoSDK, hash: string): Promise<ResponseJson[]> {
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
    if (batch === null) break
    out.push(...batch)
    if (batch.length < 50) break
    after = batch[batch.length - 1]?.$ownerId ?? null
  }
  return out
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
    super(`More than one identity answered this sign-in request (${identityIds.join(', ')}). Someone else saw the QR code. Start again and keep it private.`)
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
  try {
    const keys = await openEnvelope(req.appEphemeralPriv, r.walletEphemeralPub, r.payload)
    // The legacy contract carries exactly one key (its schema fixes the payload at 60 bytes).
    return r.source === 'legacy' && keys.length !== 1 ? null : keys
  } catch {
    return null
  }
}

/**
 * The ids of the live keys on `identityId` that `wif` controls. A disabled one does not count:
 * the wallet derives the same key for every login, so after a disable the only way back is to
 * register it again (QR #2; the iOS wallet re-adds a disabled login key).
 */
async function keyIdsFor(sdk: EvoSDK, identityId: string, wif: string, network: Network): Promise<number[]> {
  const { PrivateKey } = await import('@dashevo/evo-sdk')
  const identity = await authSdk(sdk).identities.fetch(identityId)
  const pk = PrivateKey.fromWIF(wif)
  const bytes = pk.toBytes()
  pk.free()
  try {
    return (identity?.publicKeys ?? [])
      .filter((k) => {
        if (k.disabledAt !== undefined) return false
        try {
          return k.validatePrivateKey(bytes, network)
        } catch {
          return false
        }
      })
      .map((k) => k.keyId)
  } finally {
    bytes.fill(0)
  }
}

/**
 * Turn a decrypted response into an answer, or null when it cannot be used yet (an App Connect
 * key not visible on chain yet: the next poll retries). Throws {@link UnusableWalletKey} when
 * the key is there but Forge must not use it.
 */
async function answerFor(sdk: EvoSDK, r: WalletResponse, loginKeysRaw: Uint8Array[], p: { network: Network; forge: ForgeIds; contractId: string }): Promise<WalletAnswer | null> {
  const found: WalletKey[] = []
  let unregistered: { keys: LoginKeys; wif: string } | null = null
  for (const login of loginKeysRaw) {
    const auth = authKeyFromLogin(login, r.ownerId)
    const wif = encodeWif(auth, p.network)
    auth.fill(0)
    const ids = await keyIdsFor(sdk, r.ownerId, wif, p.network)
    if (ids.length === 0) {
      if (r.source === 'legacy') unregistered = { keys: loginKeys(login, r.ownerId), wif }
      continue
    }
    found.push(await verifyWalletKey(sdk, { identityId: r.ownerId, keyId: ids[0] as number, wif, forge: p.forge, network: p.network }))
  }
  for (const k of loginKeysRaw) k.fill(0)
  if (found.length > 0) {
    // The key for the contract asked for first.
    const covers = (k: WalletKey): boolean => (p.contractId === p.forge.core ? k.scope.core : k.scope.collab)
    found.sort((a, b) => Number(covers(b)) - Number(covers(a)))
    return { kind: 'keys', identityId: r.ownerId, keys: found, source: r.source }
  }
  if (unregistered) return { kind: 'register', identityId: r.ownerId, ...unregistered, source: 'legacy' }
  return null
}

/**
 * Poll every source until an identity's answer is usable, then wait one more interval for a
 * competing answer before returning it. Refuses when two identities answered. With
 * `identityId`, answers from any other identity are ignored (a second grant for a signed-in
 * identity). Rejects with {@link RequestExpired} at `req.expiresAt`, AbortError on `signal`,
 * {@link UnusableWalletKey} when the wallet's key cannot be used here.
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
  },
): Promise<WalletAnswer> {
  const now = p.now ?? Date.now
  const answered = new Map<string, WalletAnswer | null>()
  let firstAt = 0
  try {
    for (;;) {
      if (p.signal?.aborted) throw new DOMException('cancelled', 'AbortError')
      for (const r of await fetchResponses(sdk, p.sources, req)) {
        if (p.identityId !== undefined && r.ownerId !== p.identityId) continue
        if (answered.get(r.ownerId)) continue
        const keys = await decrypt(req, r)
        if (keys === null) continue
        let answer: WalletAnswer | null = null
        try {
          answer = await answerFor(sdk, r, keys, { network: p.network, forge: p.forge, contractId: req.contractId })
        } catch (e) {
          if (e instanceof UnusableWalletKey) throw e
          // A read failed: try this response again next round.
        }
        answered.set(r.ownerId, answer)
        if (answer && firstAt === 0) firstAt = now()
      }
      if (answered.size > 1) throw new AmbiguousWalletLogin([...answered.keys()])
      const ready = [...answered.values()].find((a): a is WalletAnswer => a !== null)
      if (ready && now() - firstAt >= (p.settleMs ?? 3000)) return ready
      if (now() >= req.expiresAt) throw new RequestExpired()
      await sleep(p.intervalMs ?? 3000, p.signal)
    }
  } finally {
    disposeRequest(req)
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
    const ids = await keyIdsFor(sdk, p.identityId, p.wif, p.network).catch(() => [])
    if (ids.length > 0) return verifyWalletKey(sdk, { identityId: p.identityId, keyId: ids[0] as number, wif: p.wif, forge: p.forge, network: p.network })
    if (Date.now() >= p.until) throw new RequestExpired()
    await sleep(p.intervalMs ?? 3000, p.signal)
  }
}

/** Whether any response source exists here (hide the wallet tile otherwise). */
export async function walletLoginAvailable(sdk: EvoSDK, deploymentKey: string): Promise<boolean> {
  return (await responseSources(sdk, deploymentKey)).length > 0
}

export { base58Encode }
