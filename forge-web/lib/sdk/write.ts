/**
 * WriteEngine (browser / evo-sdk) — the idempotent state-transition write path.
 *
 * Ported from yappr's proven `state-transition-service` and adapted to the S0.1/S0.8 spike
 * findings and forge-core's on-chain doc encoding:
 *
 *  - **Manual ST assembly** (not `documents.create`): build `Document` → `DocumentCreateTransition`
 *    → `BatchedTransition` → `BatchTransition` → `StateTransition`, set the nonce, sign,
 *    broadcast, then `waitForResponse` for the verdict (evo-sdk 4.2: it returns a proven
 *    result, or the consensus error with its code). A wait that fails for transport reasons
 *    falls back to a **documents.get poll**, the broadcast+poll model of the S0.3 spike.
 *  - **Deletes** go through the SDK's delete builder, which emits an `indexOnlyDelete`
 *    carrying the document's values for `indexOnly` types (star, follow).
 *  - **Nonces**: DIP-30 masking (the high 24 bits are a missing-revision bitset; use the low
 *    40), and `max(platform, last used here) + 1`, so a node a block behind never makes a
 *    write reuse a nonce. One writer per identity (a tab queue plus a cross-tab Web Lock).
 *  - **Idempotent retry**: the signed ST bytes are cached (localStorage) under the action's
 *    intent token; retrying that action re-broadcasts the *same* signed ST (no new nonce, no
 *    double post). Only "already in mempool/chain" or the doc appearing on a poll counts as
 *    landed; a write not seen landing throws `UnconfirmedWriteError`, never resolves.
 *
 * Keys never enter React state or logs: the WIF is read from the network-scoped keystore only
 * here, wrapped in a `PrivateKey`, used to sign, and dropped.
 */

// Type-only: every evo-sdk class is loaded via dynamic `import()` at call time so the ~9.4 MB
// WASM chunk never enters the initial bundle (it is pulled on the first write / login).
import type { EvoSDK, StateTransition } from '@dashevo/evo-sdk'

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import type { Network } from '../constants'
import { base58Encode } from '../auth/base58'
import { controlsKey } from '../auth/wif'
import { previewCreate, previewCredits, previewDelete, previewReplace, type CostPreview } from './cost'
import { base64ToBytes, bytesToBase64 } from './query'

export type { CostPreview } from './cost'

// ---------------------------------------------------------------------------
// Signing-key selection (via the WASM SDK — no separate secp256k1 dependency)
// ---------------------------------------------------------------------------

/** Platform security levels (lower number = higher privilege). */
export const SECURITY_LEVEL = {
  MASTER: 0,
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
} as const

const PURPOSE_AUTHENTICATION = 0

// A minimal structural view of the WASM IdentityPublicKey / Identity we depend on. The
// wasm-bindgen `.d.ts` types resolve loosely across builds; narrowing through these local
// shapes keeps call sites free of `any`.
interface WasmPublicKey {
  readonly keyId: number
  readonly purposeNumber: number
  readonly securityLevelNumber: number
  readonly disabledAt?: bigint
  readonly expiresAt?: bigint
  validatePrivateKey(privateKeyBytes: Uint8Array, network: string): boolean
}
interface WasmIdentity {
  readonly publicKeys: WasmPublicKey[]
  readonly balance: bigint
  getPublicKeyById(keyId: number): unknown
}
interface IdentitiesFacadeLike {
  fetch(identityId: string): Promise<WasmIdentity | undefined>
  contractNonce(identityId: string, contractId: string): Promise<bigint | undefined>
}
interface DocumentsFacadeLike {
  get(contractId: string, type: string, documentId: string): Promise<unknown>
}
interface StateTransitionsFacadeLike {
  broadcastStateTransition(st: StateTransition): Promise<void>
  waitForResponse(st: StateTransition, settings?: WaitSettings): Promise<unknown>
}

/**
 * The subset of evo-sdk's `PutSettings` the result wait takes. Never `waitTimeoutMs`: rs-sdk
 * runs it through `tokio::time::timeout`, which panics in the browser ("time not implemented
 * on this platform", `docs/research/spike-results.md`); the overall deadline is a JS race.
 */
interface WaitSettings {
  readonly retries?: number
  readonly timeoutMs?: number
  readonly banFailedAddress?: boolean
}
interface SdkFacades {
  identities: IdentitiesFacadeLike
  documents: DocumentsFacadeLike
  stateTransitions: StateTransitionsFacadeLike
  epoch: { current(): Promise<unknown> }
}

function facades(sdk: EvoSDK): SdkFacades {
  return sdk as unknown as SdkFacades
}

/**
 * Find the identity's AUTHENTICATION public key that the given WIF controls, at a security
 * level that satisfies `requiredLevel` (a key of equal-or-higher privilege — i.e. equal or
 * lower level number — is accepted). Returns the matching WASM `IdentityPublicKey`, or null.
 */
export async function findSigningKey(
  identity: WasmIdentity,
  wif: string,
  network: Network,
  requiredLevel: number,
): Promise<{ publicKey: unknown; keyId: number; securityLevel: number } | null> {
  for (const key of identity.publicKeys) {
    if (key.purposeNumber !== PURPOSE_AUTHENTICATION) continue
    // A disabled or expired key would be refused at signature validation; skip it so a
    // stale session reports "no usable key" instead of an opaque consensus error.
    if (key.disabledAt !== undefined) continue
    if (key.expiresAt !== undefined && key.expiresAt <= BigInt(Date.now())) continue
    if (!controlsKey(key, wif, network)) continue
    // MASTER (0) is not usable for document ops; require CRITICAL/HIGH range that is at
    // least as privileged as the requirement.
    if (key.securityLevelNumber === SECURITY_LEVEL.MASTER) continue
    if (key.securityLevelNumber > requiredLevel) continue
    const publicKey = identity.getPublicKeyById(key.keyId)
    if (publicKey === undefined || publicKey === null) continue
    return { publicKey, keyId: key.keyId, securityLevel: key.securityLevelNumber }
  }
  return null
}

// ---------------------------------------------------------------------------
// Signed-ST idempotency cache (localStorage; keyed by the action's intent)
// ---------------------------------------------------------------------------

const ST_CACHE_PREFIX = 'forge:pending-st:v3:'
const ST_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface CachedST {
  /** The signed state transition, base64 (public data: a signed, broadcastable write). */
  data: string
  /** The document id that transition creates. */
  documentId: string
  /** The identity-contract nonce it was signed with (decimal); absent in older entries. */
  nonce?: string
  cachedAt: number
}

/**
 * A per-action intent token: made when the user starts an action (a confirm dialog opens, a
 * composer submits) and reused if they retry that same action. Two separate actions with
 * identical data — close, reopen, close again — get two tokens, so the second close can never
 * be answered by the first one's cached transition.
 */
export function newIntent(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
}

/** The cache key of one intent: owner, contract and type bound in, so a token cannot leak across. */
export function pendingWriteKey(ownerId: string, contractId: string, documentType: string, intent: string): string {
  const text = JSON.stringify([ownerId, contractId, documentType, intent])
  return ST_CACHE_PREFIX + bytesToHex(sha256(new TextEncoder().encode(text)))
}

function savePendingST(key: string, documentId: string, bytes: Uint8Array, nonce: bigint): void {
  if (typeof window === 'undefined') return
  try {
    const entry: CachedST = { data: bytesToBase64(bytes), documentId, nonce: nonce.toString(), cachedAt: Date.now() }
    window.localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    // Non-fatal — retry safety is best-effort; the write still broadcasts.
  }
}
function loadPendingST(key: string): { bytes: Uint8Array; documentId: string; nonce: bigint | null } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedST
    if (Date.now() - parsed.cachedAt > ST_CACHE_MAX_AGE_MS || !parsed.documentId) {
      window.localStorage.removeItem(key)
      return null
    }
    const nonce = typeof parsed.nonce === 'string' && /^[0-9]+$/.test(parsed.nonce) ? BigInt(parsed.nonce) : null
    return { bytes: base64ToBytes(parsed.data), documentId: parsed.documentId, nonce }
  } catch {
    return null
  }
}
function clearPendingST(key: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Ignore.
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  // wasm-bindgen rejections are plain objects (not Error); probe their string `message` /
  // `toString()` (each may throw on a freed pointer) so classification sees the real gRPC text.
  if (e && typeof e === 'object') {
    try {
      const m = (e as { message?: unknown }).message
      if (typeof m === 'string' && m.length > 0) return m
    } catch {
      /* freed-pointer getter — ignore */
    }
  }
  try {
    return JSON.stringify(e)
  } catch {
    /* circular / wasm object — fall through */
  }
  try {
    const s = (e as { toString?: () => unknown }).toString?.()
    if (typeof s === 'string' && s !== '[object Object]') return s
  } catch {
    /* ignore */
  }
  return 'unknown error'
}

/**
 * This exact transition is already in the mempool or the chain (a re-broadcast of cached
 * bytes, or a lost response). Only these mean "mine landed".
 */
export function isAlreadyExistsError(e: unknown): boolean {
  const m = errorMessage(e).toLowerCase()
  return m.includes('already in mempool') || m.includes('already in chain') || m.includes('already exists')
}

/**
 * The nonce was already used — by *another* transition. For bytes just signed this means the
 * nonce source lagged (a node a block behind); the write did not land.
 */
export function isNonceUsedError(e: unknown): boolean {
  const m = errorMessage(e).toLowerCase()
  return m.includes('nonce already present') || m.includes('invalid identity nonce') || m.includes('identity contract nonce')
}

/** Raised when a required signing key is unavailable / does not match the identity. */
export class WriteAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WriteAuthError'
  }
}

/**
 * Platform refused the write with a consensus error: the transition was checked and rejected
 * (a duplicate unique index, a membership gate, a spent key). `code` is the consensus error
 * code (`40105` duplicate unique properties, `40120` gate not satisfied, ...).
 */
export class ConsensusRefusal extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'ConsensusRefusal'
  }

  /** The key may not spend: budget exhausted/exceeded or expired (renew it, `ux-dx-spec.md` §4). */
  get isKeyLimit(): boolean {
    return KEY_LIMIT_CODES.has(this.code)
  }
}

/**
 * The write was broadcast but Platform has not shown it yet. It may still land: never report
 * it as done, and never as failed-and-safe-to-redo without checking.
 */
export class UnconfirmedWriteError extends Error {
  constructor(readonly documentId: string) {
    super("Sent, not yet visible on Platform — we'll keep checking. Reload in a moment before trying again.")
    this.name = 'UnconfirmedWriteError'
  }
}

/** Consensus codes for "this key may not spend": budget exhausted/exceeded, key expired. */
export const KEY_LIMIT_CODES: ReadonlySet<number> = new Set([20015, 20016, 40218])

/** Duplicate unique properties: someone already holds the unique slot (an issue number). */
export const DUPLICATE_UNIQUE_CODE = 40105

/** An `ownerRefersTo` gate was not satisfied (not a member, not the author). */
export const GATE_REFUSED_CODE = 40120

/** A replace named a revision other than the stored one + 1 (`InvalidDocumentRevisionError`). */
export const INVALID_REVISION_CODE = 40106

/** The numeric consensus code a wasm error carries, if any. */
function consensusCodeOf(e: unknown): number | null {
  if (e === null || typeof e !== 'object') return null
  try {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'number' && code >= 10000 && code < 50000) return code
  } catch {
    /* freed wasm pointer */
  }
  return null
}

/** The consensus refusal `e` is, or null when it is transport noise or unclassified. */
export function asConsensusRefusal(e: unknown): ConsensusRefusal | null {
  if (e instanceof ConsensusRefusal) return e
  const code = consensusCodeOf(e)
  return code === null ? null : new ConsensusRefusal(code, errorMessage(e))
}

/**
 * The SDK proves an indexOnly write (star, follow) by the state it affected, not by the
 * transition, and says so by rejecting the strict wait with this message. Only an indexOnly
 * write may read this as "landed".
 */
function isAffectedStateSnapshot(e: unknown): boolean {
  return errorMessage(e).includes('VerifiedDocuments snapshot')
}

/**
 * One result wait: a single node, 20 s, no banning, and a 45 s hard deadline (proof checking
 * included; a JS race, see {@link WaitSettings}). A transition a node accepted can still never produce a result: when two writers
 * sign with one identity's contract nonce at once (this tab and the CLI, or another browser),
 * both pass CheckTx, the block takes one, and Tenderdash quietly drops the other from its
 * mempool. The SDK's default wait read that silence as a dead node and rotated through every
 * node at 30 s each (minutes); {@link settleUnanswered} finds out what happened instead.
 * Same bounds as forge-core's `WriteEngine::execute`.
 */
const WAIT_REQUEST_MS = 20_000
const WAIT_DEADLINE_MS = 45_000
export const WAIT_SETTINGS: WaitSettings = { retries: 0, timeoutMs: WAIT_REQUEST_MS, banFailedAddress: false }

/**
 * Wait for Platform's verdict on a broadcast transition: `'landed'` once proven, a thrown
 * {@link ConsensusRefusal} when consensus rejected it, `'unknown'` when the wait itself failed
 * (timeout, transport) — the caller then settles it ({@link settleUnanswered}).
 */
async function awaitOutcome(sdk: EvoSDK, st: StateTransition, indexOnly: boolean): Promise<'landed' | 'unknown'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      facades(sdk).stateTransitions.waitForResponse(st, WAIT_SETTINGS),
      // The overall deadline (proof verification can add a quorum fetch to the 20 s request).
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('result wait deadline exceeded')), WAIT_DEADLINE_MS)
      }),
    ])
    return 'landed'
  } catch (e) {
    if (indexOnly && isAffectedStateSnapshot(e)) return 'landed'
    const refusal = asConsensusRefusal(e)
    if (refusal !== null) throw refusal
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

const SEQUENCE_MASK = (1n << 40n) - 1n
const MAX_MISSING_REVISIONS = 24n

/**
 * Whether `nonce` can no longer be used, given the identity-contract nonce Platform holds
 * (`current`, raw: the low 40 bits are the sequence, the high 24 a bitmap of skipped ones).
 * Mirrors Drive's `validate_identity_nonce_update`: the tip itself, anything more than 24
 * behind it, and a skipped one that was since filled are spent.
 */
export function isNonceSpent(current: bigint, nonce: bigint): boolean {
  const tip = current & SEQUENCE_MASK
  if (nonce > tip) return false
  if (nonce === tip) return true
  const behind = tip - nonce
  if (behind > MAX_MISSING_REVISIONS) return true
  // Bit 40 + (behind - 1) marks a skipped nonce that is still free.
  return (current & (1n << (behind + 39n))) === 0n
}

/** Whether Platform's nonce says `nonce` is spent; `false` when the read fails. */
async function nonceSpent(sdk: EvoSDK, identityId: string, contractId: string, nonce: bigint): Promise<boolean> {
  try {
    return isNonceSpent((await facades(sdk).identities.contractNonce(identityId, contractId)) ?? 0n, nonce)
  } catch {
    return false
  }
}

/** How long a spent-nonce write is given to show up before it is called lost (a block). */
const LANDED_CHECK_MS = 15_000
/** Bounded waits after the first, each preceded by a re-broadcast of the same bytes. */
const SETTLE_ROUNDS = 2

/**
 * A broadcast transition whose result wait ended without an answer: find out what happened.
 *
 * - Its nonce is spent: it landed (the document shows up within {@link LANDED_CHECK_MS}) or
 *   another write by this identity took the nonce and it never will: `'lost'`, but only when
 *   the document is definitely absent. A failed read is `'unknown'`, never `'lost'`, so a
 *   caller never signs a second copy of a write that may be there.
 * - Its nonce is free: it is still pending (or was dropped for another reason). Re-broadcast
 *   the same bytes ("already exists in cache" means the node still has them) and wait again.
 */
async function settleUnanswered(
  sdk: EvoSDK,
  st: StateTransition,
  owner: { identityId: string; contractId: string; nonce: bigint },
  indexOnly: boolean,
  landed: (timeoutMs: number) => Promise<boolean>,
  absent: () => Promise<boolean>,
  confirmTimeoutMs: number,
): Promise<'landed' | 'lost' | 'unknown'> {
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    if (await nonceSpent(sdk, owner.identityId, owner.contractId, owner.nonce)) {
      if (await landed(Math.min(LANDED_CHECK_MS, confirmTimeoutMs))) return 'landed'
      return (await absent()) ? 'lost' : 'unknown'
    }
    try {
      await facades(sdk).stateTransitions.broadcastStateTransition(st)
    } catch (e) {
      const refusal = asConsensusRefusal(e)
      if (refusal !== null) throw refusal
      // A used nonce shows as spent on the next round; "already exists" means pending.
    }
    if ((await awaitOutcome(sdk, st, indexOnly)) === 'landed') return 'landed'
  }
  return (await landed(confirmTimeoutMs)) ? 'landed' : 'unknown'
}

/** Read a balance until it moves off `before` (a write's fee settles a block later). */
async function balanceAfter(sdk: EvoSDK, identityId: string, before: bigint): Promise<bigint | null> {
  for (let i = 0; i < 8; i++) {
    try {
      const now = (await facades(sdk).identities.fetch(identityId))?.balance
      if (now !== undefined && now !== before) return now
    } catch {
      /* transient read failure: try again */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

/** The credits a write took (negative: refunded), from the balance on each side of it. */
export async function measureActual(sdk: EvoSDK, identityId: string, before: bigint | null): Promise<number | null> {
  if (before === null) return null
  const after = await balanceAfter(sdk, identityId, before)
  return after === null ? null : Number(before - after)
}

// ---------------------------------------------------------------------------
// The write context (who is acting; how to reach their key — never React state)
// ---------------------------------------------------------------------------

/** One broadcast write, as the spend ledger records it. */
export interface SpendEvent {
  readonly identityId: string
  readonly network: Network
  /** `create:issue`, `delete:star`, `refused:issue` (a refused write still pays its fee), … */
  readonly kind: string
  /** The repo the write belongs to (base58 `repoId`), when it has one. */
  readonly repo: string | null
  readonly documentId: string
  readonly estimateCredits: number
  /** The balance change the write caused, or null when it could not be read in time. */
  readonly actualCredits: number | null
  /** The identity's balance right before the write (the ledger's reconciliation baseline). */
  readonly balanceBefore: bigint | null
}

/** Identifies the acting identity and yields its signing key (WIF) on demand. */
export interface WriteAuth {
  readonly identityId: string
  readonly network: Network
  /**
   * Return the acting identity's signing-key WIF for a write to `contractId`, or throw
   * {@link WriteAuthError}. (A session can hold one key per contract: a shipped wallet grants a
   * key bound to one contract.)
   */
  getSigningKeyWif(contractId?: string): string
  /** Told about every write that was charged (the local spend ledger listens here). */
  readonly onSpend?: (event: SpendEvent) => void
}

/** The outcome of a write. A write that did not confirm throws {@link UnconfirmedWriteError}. */
export interface WriteResult {
  readonly documentId: string
  /** True once Platform proved the write (or the document became query-visible). */
  readonly confirmed: boolean
  /** The pre-sign estimate shown to the user. */
  readonly cost: CostPreview
  /**
   * What the write took from the balance (credits; negative = refund). Measured after the
   * write, outside the per-identity lock: `null` here, reported through `onSpend`.
   */
  readonly actualCredits: number | null
}

/** The repo a write's data names (`repoId` bytes), for the ledger. */
function repoOf(data: Readonly<Record<string, unknown>>, contractId: string): string | null {
  const repoId = data['repoId']
  if (repoId instanceof Uint8Array && repoId.length === 32) return base58Encode(repoId)
  return contractId
}

/** Whether a stored document exists: `null` when the read failed (unknown is not "gone"). */
async function documentExists(sdk: EvoSDK, contractId: string, documentType: string, documentId: string): Promise<boolean | null> {
  try {
    const doc = await facades(sdk).documents.get(contractId, documentType, documentId)
    return doc !== undefined && doc !== null
  } catch {
    return null
  }
}

/** A read answered "not there" (a failed read is not an answer). */
async function definitelyAbsent(sdk: EvoSDK, contractId: string, documentType: string, documentId: string): Promise<boolean> {
  return (await documentExists(sdk, contractId, documentType, documentId)) === false
}


// ---------------------------------------------------------------------------
// One writer per identity (tab-wide queue + cross-tab Web Lock)
// ---------------------------------------------------------------------------

/**
 * One write at a time per identity. Each write takes a nonce and signs nonce + 1, and the
 * balance is identity-wide, so writes of one identity queue — in this tab through a promise
 * chain, across tabs through the Web Locks API where the browser has it.
 */
const writeLocks = new Map<string, Promise<unknown>>()

interface LockManagerLike {
  request<T>(name: string, cb: () => Promise<T>): Promise<T>
}

function crossTab<T>(identityId: string, run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined
  return locks ? locks.request(`dash-forge-writer:${identityId}`, run) : run()
}

/** Run `run` as this identity's only writer. */
export function serialized<T>(identityId: string, run: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(identityId) ?? Promise.resolve()
  const next = prev.then(
    () => crossTab(identityId, run),
    () => crossTab(identityId, run),
  )
  const tail = next.catch(() => undefined)
  writeLocks.set(identityId, tail)
  void tail.then(() => {
    if (writeLocks.get(identityId) === tail) writeLocks.delete(identityId)
  })
  return next
}

/**
 * The last identity-contract nonce this tab signed. A node one block behind answers the
 * nonce query with a value this tab already used; signing `max(platform, lastUsed) + 1`
 * never reuses one.
 */
const lastUsedNonce = new Map<string, bigint>()

async function nextContractNonce(sdk: EvoSDK, identityId: string, contractId: string): Promise<bigint> {
  const raw = (await facades(sdk).identities.contractNonce(identityId, contractId)) ?? 0n
  const platform = raw & SEQUENCE_MASK
  const used = lastUsedNonce.get(`${identityId}:${contractId}`) ?? 0n
  return (platform > used ? platform : used) + 1n
}

function markNonceUsed(identityId: string, contractId: string, nonce: bigint): void {
  const key = `${identityId}:${contractId}`
  if (nonce > (lastUsedNonce.get(key) ?? 0n)) lastUsedNonce.set(key, nonce)
}

/** Poll `documents.get` until the document appears or the budget elapses. */
function pollForDocument(sdk: EvoSDK, contractId: string, documentType: string, documentId: string, timeoutMs: number): Promise<boolean> {
  return pollUntil(async () => (await documentExists(sdk, contractId, documentType, documentId)) === true, timeoutMs)
}

/**
 * Build the `Document` a create transition carries, with byte fields kept as bytes.
 *
 * evo-sdk 4.2's `new Document({ properties })` (and the `properties` setter) converts the
 * properties through JSON, which turns every `Uint8Array` into an array of integers — Drive
 * then rejects the write with "not an array of bytes" for any byteArray field (`repoId`,
 * `refNameHash`, `newOid`, ...). `Document.fromObject` converts a `Uint8Array` to bytes, which
 * is what 4.0's constructor did: the signed transition is byte-identical to 4.0's for every
 * top-level field. So the system fields come from a property-less constructor call and the
 * content is merged in through `fromObject`.
 */
function documentForCreate(
  DocumentClass: typeof import('@dashevo/evo-sdk').Document,
  params: {
    readonly data: Record<string, unknown>
    readonly documentType: string
    readonly contractId: string
    readonly ownerId: string
    readonly documentId: string
    readonly entropy: Uint8Array
    readonly platformVersion: number
  },
): import('@dashevo/evo-sdk').Document {
  const base = new DocumentClass({
    properties: {},
    documentTypeName: params.documentType,
    dataContractId: params.contractId,
    ownerId: params.ownerId,
    revision: 1n,
    id: params.documentId,
    entropy: params.entropy,
  })
  const object = { ...base.toObject(), ...params.data }
  return DocumentClass.fromObject(
    object as Parameters<typeof DocumentClass.fromObject>[0],
    params.platformVersion,
  )
}

/** Report a charged write (after the lock is released: measuring takes up to 8 s). */
function reportSpend(
  sdk: EvoSDK,
  auth: WriteAuth,
  event: Omit<SpendEvent, 'actualCredits' | 'identityId' | 'network'>,
): void {
  if (!auth.onSpend) return
  void measureActual(sdk, auth.identityId, event.balanceBefore).then((actualCredits) =>
    auth.onSpend?.({ ...event, identityId: auth.identityId, network: auth.network, actualCredits }),
  )
}

/**
 * Create a document with idempotent retry. Builds + signs a state transition, caches the
 * signed bytes under the action's {@link newIntent intent token}, broadcasts, and waits for
 * Platform's verdict. Retrying the same action while its transition is pending re-broadcasts
 * those exact bytes (same nonce and id, so it can land at most once) instead of signing a
 * second document.
 *
 * The verdict: a proven result resolves; a consensus refusal (a duplicate issue number, a
 * membership gate, a spent key) throws {@link ConsensusRefusal} with its code, and its fee is
 * reported to the ledger as `refused:<type>`; a write not visible after the wait and a poll
 * throws {@link UnconfirmedWriteError}. It never resolves for a write it has not seen land.
 *
 * Nonces: `max(platform, last used) + 1`. A fresh transition refused because its nonce was
 * taken is re-signed once with the next nonce.
 */
export function createDocumentIdempotent(sdk: EvoSDK, auth: WriteAuth, params: CreateParams): Promise<WriteResult> {
  return serialized(auth.identityId, () => createDocumentUnlocked(sdk, auth, params)).then((r) => {
    reportSpend(sdk, auth, r.spend)
    return r.result
  })
}

export interface CreateParams {
  readonly contractId: string
  readonly documentType: string
  readonly data: Record<string, unknown>
  /** The action this write belongs to ({@link newIntent}); a fresh token when omitted. */
  readonly intent?: string
  readonly requiredLevel?: number
  readonly confirmTimeoutMs?: number
  /** Whether the write landed, for types `documents.get` cannot fetch (indexOnly). */
  readonly probe?: () => Promise<boolean>
}

type Spend = Omit<SpendEvent, 'actualCredits' | 'identityId' | 'network'>

async function createDocumentUnlocked(
  sdk: EvoSDK,
  auth: WriteAuth,
  params: CreateParams,
): Promise<{ result: WriteResult; spend: Spend }> {
  const { contractId, documentType, data } = params
  const requiredLevel = params.requiredLevel ?? SECURITY_LEVEL.HIGH
  const confirmTimeoutMs = params.confirmTimeoutMs ?? 30_000
  const indexOnly = params.probe !== undefined
  const cost: CostPreview = previewCreate(documentType, data)
  const landed = (documentId: string, timeoutMs: number): Promise<boolean> =>
    params.probe ? pollUntil(params.probe, timeoutMs) : pollForDocument(sdk, contractId, documentType, documentId, timeoutMs)
  /** Definitely not there: a read that answered "no" (a failed read is not an answer). */
  const absent = async (documentId: string): Promise<boolean> =>
    params.probe
      ? (await params.probe().catch(() => null)) === false
      : await definitelyAbsent(sdk, contractId, documentType, documentId)

  const wif = auth.getSigningKeyWif(contractId)
  const ownerId = auth.identityId
  const cacheKey = pendingWriteKey(ownerId, contractId, documentType, params.intent ?? newIntent())
  const identity = await facades(sdk).identities.fetch(ownerId)
  if (!identity) throw new WriteAuthError(`identity ${ownerId} not found on ${auth.network}`)
  const balanceBefore = identity.balance
  const spend = (kind: string, documentId: string): Spend => ({
    kind: `${kind}:${documentType}`,
    repo: repoOf(data, contractId),
    documentId,
    estimateCredits: cost.credits,
    balanceBefore,
  })

  const done = (documentId: string, confirmed: boolean): { result: WriteResult; spend: Spend } => {
    if (!confirmed) throw new UnconfirmedWriteError(documentId)
    clearPendingST(cacheKey)
    return { result: { documentId, confirmed, cost, actualCredits: null }, spend: spend('create', documentId) }
  }
  /** A refusal was charged (a paid consensus failure): record it, then rethrow. */
  const refused = (refusal: ConsensusRefusal, documentId: string): never => {
    clearPendingST(cacheKey)
    if (!refusal.isKeyLimit) reportSpend(sdk, auth, spend('refused', documentId))
    throw refusal
  }

  // A previous attempt at this same action timed out: finish it, never sign a second one —
  // unless its nonce is spent and its document definitely absent, when it can never land
  // (another write by this identity took the nonce) and the action is signed afresh below.
  const cached = loadPendingST(cacheKey)
  if (cached) {
    const { documentId } = cached
    let seen = await landed(documentId, 0)
    if (!seen) {
      const { StateTransition: StateTransitionClass } = await import('@dashevo/evo-sdk')
      try {
        await facades(sdk).stateTransitions.broadcastStateTransition(StateTransitionClass.fromBytes(cached.bytes))
      } catch (e) {
        // Refused: the cached bytes cannot land. A used nonce: they landed (the poll sees
        // them) or never will, so a retry may sign afresh. Already in, or a transport error:
        // the poll decides, and the bytes stay cached until it sees them.
        const refusal = asConsensusRefusal(e)
        if (refusal) {
          clearPendingST(cacheKey)
          throw refusal
        }
        if (isNonceUsedError(e)) clearPendingST(cacheKey)
      }
      seen = await landed(documentId, confirmTimeoutMs)
    }
    const { nonce } = cached
    const lost =
      !seen && nonce !== null && (await nonceSpent(sdk, ownerId, contractId, nonce)) && (await absent(documentId))
    if (!lost || nonce === null) return done(documentId, seen)
    clearPendingST(cacheKey)
    markNonceUsed(ownerId, contractId, nonce)
  }

  const signing = await findSigningKey(identity, wif, auth.network, requiredLevel)
  if (!signing) {
    throw new WriteAuthError('no usable AUTHENTICATION key for the stored signing key (it may be disabled or expired)')
  }

  const build = () => signCreate(sdk, { ownerId, contractId, documentType, data, wif, publicKey: signing.publicKey })

  let signed = await build()
  // A fresh transition whose nonce another write took after it was accepted is signed once
  // more (the first can never land); see settleUnanswered.
  for (let round = 0; ; round++) {
    for (let attempt = 0; ; attempt++) {
      savePendingST(cacheKey, signed.documentId, signed.bytes, signed.nonce)
      try {
        await facades(sdk).stateTransitions.broadcastStateTransition(signed.st)
        markNonceUsed(ownerId, contractId, signed.nonce)
        break
      } catch (e) {
        if (isAlreadyExistsError(e)) {
          markNonceUsed(ownerId, contractId, signed.nonce)
          return done(signed.documentId, await landed(signed.documentId, confirmTimeoutMs))
        }
        if (attempt === 0 && isNonceUsedError(e)) {
          // The nonce source lagged: that nonce belongs to an earlier write. Skip past it.
          markNonceUsed(ownerId, contractId, signed.nonce)
          signed = await build()
          continue
        }
        if (attempt === 0 && isStaleDocumentIdError(e)) {
          // Refused at basic validation (nothing landed): learn the network's version from a
          // proved read and prepare the write once more.
          await facades(sdk).epoch.current()
          signed = await build()
          continue
        }
        const refusal = asConsensusRefusal(e)
        if (refusal) refused(refusal, signed.documentId)
        if (isNonceUsedError(e) || isStaleDocumentIdError(e)) {
          clearPendingST(cacheKey)
          throw e
        }
        // Unclassified (a timeout, a dropped connection): the node may have taken the bytes and
        // lost the answer. Keep them cached and poll; unseen, the next retry rebroadcasts the
        // same bytes instead of signing a second document.
        markNonceUsed(ownerId, contractId, signed.nonce)
        return done(signed.documentId, await landed(signed.documentId, confirmTimeoutMs))
      }
    }

    const { documentId } = signed
    let outcome: 'landed' | 'lost' | 'unknown'
    try {
      outcome = await awaitOutcome(sdk, signed.st, indexOnly)
      if (outcome === 'unknown') {
        outcome = await settleUnanswered(
          sdk,
          signed.st,
          { identityId: ownerId, contractId, nonce: signed.nonce },
          indexOnly,
          (ms) => landed(documentId, ms),
          () => absent(documentId),
          confirmTimeoutMs,
        )
      }
    } catch (e) {
      // Consensus checked the transition and refused it: nothing will land under this id.
      return refused(e as ConsensusRefusal, documentId)
    }
    if (outcome === 'lost' && round === 0) {
      markNonceUsed(ownerId, contractId, signed.nonce)
      signed = await build()
      continue
    }
    return done(documentId, outcome === 'landed')
  }
}

/** Poll `check` until it holds or the budget elapses (one immediate check). */
async function pollUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await check()) return true
    } catch {
      /* a failed read is "not yet" */
    }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 1500))
  }
}

/** Consensus refused a create because its id was derived at another protocol version. */
export function isStaleDocumentIdError(e: unknown): boolean {
  const m = errorMessage(e).toLowerCase()
  return m.includes('invalid document transition id') || m.includes('10405')
}

/** Build and sign one document-create transition (fresh entropy and nonce). */
async function signCreate(
  sdk: EvoSDK,
  p: {
    readonly ownerId: string
    readonly contractId: string
    readonly documentType: string
    readonly data: Record<string, unknown>
    readonly wif: string
    readonly publicKey: unknown
  },
): Promise<{ st: StateTransition; bytes: Uint8Array; documentId: string; nonce: bigint }> {
  const { ownerId, contractId, documentType, data } = p
  const { Document, DocumentCreateTransition, BatchedTransition, BatchTransition, PrivateKey } = await import('@dashevo/evo-sdk')

  // The nonce is fetched once and used for both the id and the transition. From protocol 14
  // the document id commits to it (protocol 13: entropy only), and the create transition
  // re-derives the id at the version it is given — so the id, the `Document` and the
  // transition all use this nonce and one version: the SDK's latest learned one. Drive refuses
  // a stale-version id and the caller retries; it is never silently misreported.
  const nonce = await nextContractNonce(sdk, ownerId, contractId)
  const platformVersion = sdk.version()

  const entropy = crypto.getRandomValues(new Uint8Array(32))
  const idBytes = Document.generateId(documentType, ownerId, contractId, entropy, nonce, platformVersion)
  const documentId = base58Encode(idBytes)

  const document = documentForCreate(Document, { data, documentType, contractId, ownerId, documentId, entropy, platformVersion })

  // `platformVersion` is load-bearing: without it the transition re-derives the id at the
  // SDK's latest compiled version (14), which on a protocol-13 network is an id Drive does not
  // recompute, and the create is rejected.
  const createTransition = new DocumentCreateTransition({
    document,
    identityContractNonce: nonce,
    platformVersion,
  })
  if (document.id.toBase58() !== documentId) {
    throw new Error(
      `document id drifted while building the create transition (${documentId}); ` +
        'refusing to broadcast a write whose id the idempotency cache does not know',
    )
  }
  const batched = new BatchedTransition(createTransition.toDocumentTransition())
  const batch = BatchTransition.fromBatchedTransitions([batched], ownerId, 0)
  const st = batch.toStateTransition()
  st.setIdentityContractNonce(nonce)
  st.sign(PrivateKey.fromWIF(p.wif), p.publicKey as Parameters<StateTransition['sign']>[1])
  return { st, bytes: st.toBytes(), documentId, nonce }
}

/** The outcome of a delete. A delete that did not confirm throws {@link UnconfirmedWriteError}. */
export interface DeleteResult {
  /** True once the document is gone (proven, or cleanly no longer found). */
  readonly deleted: boolean
  /** Measured after the lock; reported through `onSpend`. */
  readonly actualCredits: number | null
}

interface DocumentsDeleteFacadeLike {
  delete(options: { document: unknown; identityKey: unknown; signer: unknown; settings?: unknown }): Promise<void>
}

/**
 * Delete one of the signer's own documents through the SDK's delete builder, which picks the
 * transition kind from the document type: a stored document is deleted by id; an `indexOnly`
 * one (`star`, `follow`) has no stored row, so its delete must carry the document's values,
 * and Drive checks them against the committed index entry (`indexOnlyDelete`, protocol 14).
 *
 * - Stored types: pass `documentId`; the live document is checked first and a delete of a
 *   document cleanly not found resolves as a no-op success (a failed read does not).
 * - indexOnly types: pass `document`, the wasm `Document` a query returned (its values are the
 *   delete), and `probeGone` to confirm it disappeared.
 *
 * The SDK takes the nonce from its own cache; `identityNonceStaleTimeS: 0` makes it re-read
 * the chain each time (its max-merge then steps past nonces this module's creates used).
 */
export function deleteDocumentIdempotent(sdk: EvoSDK, auth: WriteAuth, params: DeleteParams): Promise<DeleteResult> {
  return serialized(auth.identityId, () => deleteDocumentUnlocked(sdk, auth, params)).then((r) => {
    if (r.spend) reportSpend(sdk, auth, r.spend)
    return r.result
  })
}

export interface DeleteParams {
  readonly contractId: string
  readonly documentType: string
  readonly documentId: string
  /** The repo the document belongs to, for the ledger. */
  readonly repo?: string | null
  /** The wasm `Document` to delete by its values (indexOnly types). */
  readonly document?: unknown
  /** Whether the document is gone, for types `documents.get` cannot fetch (indexOnly). */
  readonly probeGone?: () => Promise<boolean>
  readonly requiredLevel?: number
  readonly confirmTimeoutMs?: number
}

async function deleteDocumentUnlocked(
  sdk: EvoSDK,
  auth: WriteAuth,
  params: DeleteParams,
): Promise<{ result: DeleteResult; spend: Spend | null }> {
  const { contractId, documentType, documentId } = params
  const requiredLevel = params.requiredLevel ?? SECURITY_LEVEL.HIGH
  const confirmTimeoutMs = params.confirmTimeoutMs ?? 30_000
  const indexOnly = params.document !== undefined
  const gone = params.probeGone ?? (() => definitelyAbsent(sdk, contractId, documentType, documentId))

  if (!indexOnly && (await definitelyAbsent(sdk, contractId, documentType, documentId))) {
    return { result: { deleted: true, actualCredits: 0 }, spend: null }
  }

  const wif = auth.getSigningKeyWif(contractId)
  const ownerId = auth.identityId
  const identity = await facades(sdk).identities.fetch(ownerId)
  if (!identity) throw new WriteAuthError(`identity ${ownerId} not found on ${auth.network}`)
  const signing = await findSigningKey(identity, wif, auth.network, requiredLevel)
  if (!signing) {
    throw new WriteAuthError('no usable AUTHENTICATION key for the stored signing key (it may be disabled or expired)')
  }
  const spend = (kind: string): Spend => ({
    kind: `${kind}:${documentType}`,
    repo: params.repo ?? null,
    documentId,
    estimateCredits: previewDelete(documentType).credits,
    balanceBefore: identity.balance,
  })

  const { IdentitySigner } = await import('@dashevo/evo-sdk')
  const signer = new IdentitySigner()
  signer.addKeyFromWif(wif)
  const document = params.document ?? { id: documentId, ownerId, dataContractId: contractId, documentTypeName: documentType }
  let proven = false
  try {
    await (sdk as unknown as { documents: DocumentsDeleteFacadeLike }).documents.delete({
      document,
      identityKey: signing.publicKey,
      signer,
      // Bounded waits (at most 3 × 20 s) rather than the SDK's rotation through every node at
      // 30 s each, which a transition dropped from the mempool (a same-nonce race) would sit
      // through; the gone-poll below then decides. No `waitTimeoutMs`: see WaitSettings.
      settings: { identityNonceStaleTimeS: 0, timeoutMs: WAIT_REQUEST_MS, retries: 2 },
    })
    proven = true
  } catch (e) {
    if (indexOnly && isAffectedStateSnapshot(e)) proven = true
    else {
      const refusal = asConsensusRefusal(e)
      if (refusal !== null) {
        if (!refusal.isKeyLimit) reportSpend(sdk, auth, spend('refused'))
        throw refusal
      }
      // Anything else ("already exists in cache", a bounded wait that ran out): the gone-poll
      // decides. Still there: an unclassified error stands, and "already exists" (which a
      // transition dropped after a same-nonce race also answers) is unconfirmed.
      if (!(await pollUntil(gone, confirmTimeoutMs))) {
        if (isAlreadyExistsError(e)) throw new UnconfirmedWriteError(documentId)
        throw e
      }
      proven = true
    }
  } finally {
    signer.free()
  }
  if (!(proven || (await pollUntil(gone, confirmTimeoutMs)))) throw new UnconfirmedWriteError(documentId)
  return { result: { deleted: true, actualCredits: null }, spend: spend('delete') }
}

/** The outcome of a replace. A replace that did not confirm throws {@link UnconfirmedWriteError}. */
export interface ReplaceResult {
  readonly documentId: string
  /** The revision the replace wrote. */
  readonly revision: bigint
  readonly cost: CostPreview
  /** Measured after the lock; reported through `onSpend`. */
  readonly actualCredits: number | null
}

interface DocumentsReplaceFacadeLike {
  replace(options: { document: unknown; identityKey: unknown; signer: unknown; settings?: unknown }): Promise<void>
}

interface FetchedDocumentLike {
  readonly revision?: bigint
  readonly ownerId: { toBase58(): string }
  toObject(): Record<string, unknown>
  /** String identifiers, base64 byte arrays (what {@link sameValue} compares). */
  toJSON(platformVersion?: number): Record<string, unknown>
}

export interface ReplaceParams {
  readonly contractId: string
  readonly documentType: string
  readonly documentId: string
  /**
   * The properties to change (merged over the stored document). A property set to
   * `undefined` is removed (for example a `reviewId` whose review was deleted).
   */
  readonly changes: Readonly<Record<string, unknown>>
  /** The revision the caller read; a replace against a newer stored revision is refused. */
  readonly expectedRevision?: bigint | undefined
  /** The repo the document belongs to, for the ledger. */
  readonly repo?: string | null
  readonly requiredLevel?: number
  readonly confirmTimeoutMs?: number
}

/**
 * Replace one of the signer's own mutable documents (edit an issue/PR title or body, a
 * comment's body) through the SDK's replace builder: read the stored document, merge
 * `changes`, write revision + 1.
 *
 * Idempotent by content: when the stored document already holds every change (an earlier
 * attempt landed and only its answer was lost), nothing is signed. A replace whose wait ended
 * without an answer is settled by reading the document back: its revision and the changed
 * values decide, and an unanswered, unseen replace throws {@link UnconfirmedWriteError}.
 * Consensus enforces the rest: only the owner may replace, `immutable` properties may not
 * change (40128), and every reference is re-validated.
 */
export function replaceDocumentIdempotent(sdk: EvoSDK, auth: WriteAuth, params: ReplaceParams): Promise<ReplaceResult> {
  return serialized(auth.identityId, () => replaceDocumentUnlocked(sdk, auth, params)).then((r) => {
    if (r.spend) reportSpend(sdk, auth, r.spend)
    return r.result
  })
}

/**
 * Whether a stored value (from the document's JSON form: identifiers base58, other byte arrays
 * base64) equals a wanted one. Bytes are compared by content; an identifier's wanted bytes
 * also match its base58 form.
 */
function sameValue(stored: unknown, wanted: unknown): boolean {
  if (wanted === undefined) return stored === undefined || stored === null
  if (wanted instanceof Uint8Array) {
    if (typeof stored !== 'string') return false
    if (wanted.length === 32 && stored === base58Encode(wanted)) return true
    try {
      const bytes = base64ToBytes(stored)
      return bytes.length === wanted.length && bytes.every((b, i) => b === wanted[i])
    } catch {
      return false
    }
  }
  return stored === wanted
}

async function replaceDocumentUnlocked(
  sdk: EvoSDK,
  auth: WriteAuth,
  params: ReplaceParams,
): Promise<{ result: ReplaceResult; spend: Spend | null }> {
  const { contractId, documentType, documentId, changes } = params
  const requiredLevel = params.requiredLevel ?? SECURITY_LEVEL.HIGH
  const confirmTimeoutMs = params.confirmTimeoutMs ?? 30_000
  const cost = previewReplace(documentType, changes)

  const read = async (): Promise<FetchedDocumentLike | null> => {
    const doc = await facades(sdk).documents.get(contractId, documentType, documentId)
    return (doc ?? null) as FetchedDocumentLike | null
  }
  const current = await read()
  if (current === null) throw new Error(`${documentType} ${documentId} was not found`)
  if (current.ownerId.toBase58() !== auth.identityId) throw new WriteAuthError('only the author can edit this')
  const stored = current.toObject()
  const revision = current.revision ?? 1n
  const holds = (doc: FetchedDocumentLike) => {
    const json = doc.toJSON(sdk.version())
    return Object.entries(changes).every(([k, v]) => sameValue(json[k], v))
  }
  if (holds(current)) {
    return { result: { documentId, revision, cost: previewCredits(0), actualCredits: 0 }, spend: null }
  }
  if (params.expectedRevision !== undefined && params.expectedRevision !== revision) {
    throw new Error(`this ${documentType} changed since you opened it (revision ${revision}); reload and edit again`)
  }

  const wif = auth.getSigningKeyWif(contractId)
  const identity = await facades(sdk).identities.fetch(auth.identityId)
  if (!identity) throw new WriteAuthError(`identity ${auth.identityId} not found on ${auth.network}`)
  const signing = await findSigningKey(identity, wif, auth.network, requiredLevel)
  if (!signing) {
    throw new WriteAuthError('no usable AUTHENTICATION key for the stored signing key (it may be disabled or expired)')
  }
  const next = revision + 1n
  const spend = (kind: string): Spend => ({
    kind: `${kind}:${documentType}`,
    repo: params.repo ?? null,
    documentId,
    estimateCredits: cost.credits,
    balanceBefore: identity.balance,
  })

  const { Document, IdentitySigner } = await import('@dashevo/evo-sdk')
  const merged: Record<string, unknown> = { ...stored, $revision: next }
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }
  const document = Document.fromObject(merged as Parameters<typeof Document.fromObject>[0], sdk.version())
  const signer = new IdentitySigner()
  signer.addKeyFromWif(wif)
  const landed = async (): Promise<boolean> => {
    const doc = await read().catch(() => null)
    return doc !== null && (doc.revision ?? 0n) >= next && holds(doc)
  }
  try {
    await (sdk as unknown as { documents: DocumentsReplaceFacadeLike }).documents.replace({
      document,
      identityKey: signing.publicKey,
      signer,
      settings: { identityNonceStaleTimeS: 0, timeoutMs: WAIT_REQUEST_MS, retries: 2 },
    })
  } catch (e) {
    const refusal = asConsensusRefusal(e)
    // A revision refusal on a retry: an earlier attempt of this edit may have landed (its answer
    // lost), leaving the stored revision already at `next`. Re-read; if the content matches, the
    // edit is done.
    if (refusal !== null && refusal.code === INVALID_REVISION_CODE && (await landed())) {
      return { result: { documentId, revision: next, cost, actualCredits: null }, spend: null }
    }
    if (refusal !== null) {
      if (!refusal.isKeyLimit) reportSpend(sdk, auth, spend('refused'))
      throw refusal
    }
    if (!(await pollUntil(landed, confirmTimeoutMs))) {
      if (isAlreadyExistsError(e)) throw new UnconfirmedWriteError(documentId)
      throw e
    }
  } finally {
    signer.free()
  }
  return { result: { documentId, revision: next, cost, actualCredits: null }, spend: spend('replace') }
}

/** Read an identity's credit balance (for the auth surface / cost affordability checks). */
export async function readIdentityBalance(sdk: EvoSDK, identityId: string): Promise<bigint> {
  const identity = await facades(sdk).identities.fetch(identityId)
  return identity?.balance ?? 0n
}
