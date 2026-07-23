/**
 * WriteEngine (browser / evo-sdk) — the idempotent state-transition write path.
 *
 * Ported from yappr's proven `state-transition-service` and adapted to the S0.1/S0.8 spike
 * findings and forge-core's on-chain doc encoding:
 *
 *  - **Manual ST assembly** (not `documents.create`): build `Document` → `DocumentCreateTransition`
 *    → `BatchedTransition` → `BatchTransition` → `StateTransition`, set the nonce, sign, and
 *    **broadcast-only** (`broadcastStateTransition`). `waitForResponse` / `broadcastAndWait`
 *    panic under Node/WASM (`time not implemented`, S0.3), so confirmation is a **documents.get
 *    poll**, exactly the broadcast+poll model the spike froze.
 *  - **DIP-30 nonce masking**: the identity-contract nonce carries a 24-bit missing-revision
 *    bitset in its high bits; mask to the low 40 before incrementing or the write desyncs.
 *  - **Idempotent retry**: the signed ST bytes are cached (localStorage) keyed by the
 *    deterministic document id; a retry re-broadcasts the *same* signed ST (no new nonce → no
 *    double post). An `AlreadyExists` / nonce-used error, or the doc appearing on a poll, is
 *    treated as success.
 *  - **Token gating**: WRITE/MAINTAIN-gated doc types carry a `TokenPaymentInfo` pinned to the
 *    contract-declared `tokenCost.create` (position + amount) so a later owner-side price change
 *    cannot overcharge — parity with forge-core's `token_payment_for`. Ungated types (issue /
 *    comment / event / patch / review, and the registry's star / follow / repoListing) carry none.
 *
 * Keys never enter React state or logs: the WIF is read from the network-scoped keystore only
 * here, wrapped in a `PrivateKey`, used to sign, and dropped.
 */

import {
  Document,
  DocumentCreateTransition,
  DocumentDeleteTransition,
  BatchedTransition,
  BatchTransition,
  StateTransition,
  PrivateKey,
  TokenPaymentInfo,
} from '@dashevo/evo-sdk'
import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { base58Encode } from '../auth/base58'

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
}
interface SdkFacades {
  identities: IdentitiesFacadeLike
  documents: DocumentsFacadeLike
  stateTransitions: StateTransitionsFacadeLike
}

function facades(sdk: EvoSDK): SdkFacades {
  return sdk as unknown as SdkFacades
}

/**
 * Find the identity's AUTHENTICATION public key that the given WIF controls, at a security
 * level that satisfies `requiredLevel` (a key of equal-or-higher privilege — i.e. equal or
 * lower level number — is accepted). Returns the matching WASM `IdentityPublicKey`, or null.
 */
export function findSigningKey(
  identity: WasmIdentity,
  wif: string,
  network: Network,
  requiredLevel: number,
): { publicKey: unknown; keyId: number; securityLevel: number } | null {
  const pkBytes = PrivateKey.fromWIF(wif).toBytes()
  for (const key of identity.publicKeys) {
    if (key.purposeNumber !== PURPOSE_AUTHENTICATION) continue
    let matches = false
    try {
      matches = key.validatePrivateKey(pkBytes, network)
    } catch {
      matches = false
    }
    if (!matches) continue
    // MASTER (0) is not usable for document/token ops; require CRITICAL/HIGH range that is at
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
// Token gate table (parity with forge-contracts/templates/repo-v1.json)
// ---------------------------------------------------------------------------

/** A doc type's `tokenCost.create`: token position (0 = WRITE, 1 = MAINTAIN) + amount. */
export interface TokenGate {
  readonly position: number
  readonly amount: number
}

/**
 * The repo-v1 `tokenCost.create` gates. Ungated types (issue / patch / comment / event /
 * review) are absent → no `TokenPaymentInfo`. Mirrors the template exactly (verified against
 * `repo-v1.json`); the registry types (star / follow / repoListing) are all ungated.
 */
export const REPO_CREATE_GATES: Readonly<Record<string, TokenGate>> = {
  config: { position: 1, amount: 1 },
  refUpdate: { position: 0, amount: 1 },
  protectedRefUpdate: { position: 1, amount: 1 },
  packManifest: { position: 0, amount: 1 },
  manifestPart: { position: 0, amount: 1 },
  chunk: { position: 0, amount: 1 },
  label: { position: 1, amount: 1 },
  release: { position: 1, amount: 1 },
  checkRun: { position: 0, amount: 1 },
  webhook: { position: 1, amount: 1 },
}

/** The token gate for a repo doc-type create, or undefined if the type is ungated. */
export function createGateFor(documentType: string): TokenGate | undefined {
  return REPO_CREATE_GATES[documentType]
}

// ---------------------------------------------------------------------------
// Cost preview (DASH) — heuristic pre-sign estimate for the confirm UI
// ---------------------------------------------------------------------------

/** 1 DASH = 1e11 credits (parity with forge-core `credits_to_dash`). */
export const CREDITS_PER_DASH = 100_000_000_000

/** Credit → DASH (display). */
export function creditsToDash(credits: number): number {
  return credits / CREDITS_PER_DASH
}

/**
 * Heuristic pre-sign credit estimates per write kind. Document writes are order-of-magnitude
 * (processing + storage); the repo contract-create figures come from the S0.7 measurement
 * (~0.24 DASH for a token contract) and the repo-v1 template's larger footprint (~1.18 DASH).
 * These drive the confirm dialog's "≈ Ð" preview; the exact fee settles at consensus.
 */
export const COST_ESTIMATE_CREDITS = {
  documentCreate: 20_000_000,
  documentDelete: 2_000_000,
  tokenAdmin: 15_000_000,
  repoCreate: 118_000_000_000,
} as const

/** A pre-sign cost preview for the confirm UI. */
export interface CostPreview {
  readonly credits: number
  readonly dash: number
  /** The token spend, when the action is token-gated (1 WRITE/MAINTAIN token), else 0. */
  readonly tokenAmount: number
  /** Token position spent (0 WRITE / 1 MAINTAIN), when gated. */
  readonly tokenPosition?: number
}

/** Build the cost preview for a repo document create (folds in any token gate). */
export function previewDocumentCreate(documentType: string): CostPreview {
  const gate = createGateFor(documentType)
  const credits = COST_ESTIMATE_CREDITS.documentCreate
  return {
    credits,
    dash: creditsToDash(credits),
    tokenAmount: gate?.amount ?? 0,
    ...(gate ? { tokenPosition: gate.position } : {}),
  }
}

/** Cost preview for a plain (untyped-cost) credit amount. */
export function previewCredits(credits: number): CostPreview {
  return { credits, dash: creditsToDash(credits), tokenAmount: 0 }
}

// ---------------------------------------------------------------------------
// Signed-ST idempotency cache (localStorage; keyed by deterministic document id)
// ---------------------------------------------------------------------------

const ST_CACHE_PREFIX = 'forge:pending-st:'
const ST_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface CachedST {
  data: string
  cachedAt: number
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number)
  return btoa(bin)
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function savePendingST(documentId: string, bytes: Uint8Array): void {
  if (typeof window === 'undefined') return
  try {
    const entry: CachedST = { data: bytesToBase64(bytes), cachedAt: Date.now() }
    window.localStorage.setItem(ST_CACHE_PREFIX + documentId, JSON.stringify(entry))
  } catch {
    // Non-fatal — retry safety is best-effort; the write still broadcasts.
  }
}
function loadPendingST(documentId: string): Uint8Array | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(ST_CACHE_PREFIX + documentId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedST
    if (Date.now() - parsed.cachedAt > ST_CACHE_MAX_AGE_MS) {
      window.localStorage.removeItem(ST_CACHE_PREFIX + documentId)
      return null
    }
    return base64ToBytes(parsed.data)
  } catch {
    return null
  }
}
function clearPendingST(documentId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(ST_CACHE_PREFIX + documentId)
  } catch {
    // Ignore.
  }
}

// ---------------------------------------------------------------------------
// Error classification (broadcast is best-effort; some "errors" mean success)
// ---------------------------------------------------------------------------

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/** An already-processed ST (mempool/chain/nonce-used) — the broadcast effectively succeeded. */
export function isAlreadyExistsError(e: unknown): boolean {
  const m = errorMessage(e).toLowerCase()
  return (
    m.includes('already in mempool') ||
    m.includes('already in chain') ||
    m.includes('nonce already present') ||
    m.includes('already exists') ||
    m.includes('invalid identity nonce')
  )
}

/** Raised when a required signing key is unavailable / does not match the identity. */
export class WriteAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WriteAuthError'
  }
}

// ---------------------------------------------------------------------------
// The write context (who is acting; how to reach their key — never React state)
// ---------------------------------------------------------------------------

/** Identifies the acting identity and yields its signing key (WIF) on demand. */
export interface WriteAuth {
  readonly identityId: string
  readonly network: Network
  /** Return the acting identity's signing-key WIF, or throw {@link WriteAuthError}. */
  getSigningKeyWif(): string
}

/** The outcome of an idempotent write. */
export interface WriteResult {
  readonly documentId: string
  /** True once the document is query-visible on Platform (poll confirmed). */
  readonly confirmed: boolean
  /** The pre-sign cost preview shown to the user. */
  readonly cost: CostPreview
}

async function documentExists(
  sdk: EvoSDK,
  contractId: string,
  documentType: string,
  documentId: string,
): Promise<boolean> {
  try {
    const doc = await facades(sdk).documents.get(contractId, documentType, documentId)
    return doc !== undefined && doc !== null
  } catch (e) {
    const m = errorMessage(e).toLowerCase()
    if (m.includes('not found') || m.includes('no document') || m.includes('404')) return false
    // Transport hiccup — treat as "unknown", not "exists".
    return false
  }
}

const SEQUENCE_MASK = (1n << 40n) - 1n

async function nextContractNonce(
  sdk: EvoSDK,
  identityId: string,
  contractId: string,
): Promise<bigint> {
  const raw = (await facades(sdk).identities.contractNonce(identityId, contractId)) ?? 0n
  return (raw & SEQUENCE_MASK) + 1n
}

/** Poll `documents.get` until the document appears or the budget elapses. */
async function pollForDocument(
  sdk: EvoSDK,
  contractId: string,
  documentType: string,
  documentId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const step = 1500
  // First check is immediate; then poll on an interval until the deadline.
  for (;;) {
    if (await documentExists(sdk, contractId, documentType, documentId)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, step))
  }
}

/**
 * Create a document with idempotent retry. Builds + signs a broadcast-only state transition,
 * caches the signed bytes keyed by the deterministic document id, broadcasts, and polls for
 * confirmation. A cached ST from a prior timed-out attempt is re-broadcast verbatim; an
 * already-processed error, or the doc appearing on a poll, resolves as success.
 *
 * `requiredLevel` defaults to HIGH (document ops accept a HIGH-or-CRITICAL key).
 */
export async function createDocumentIdempotent(
  sdk: EvoSDK,
  auth: WriteAuth,
  params: {
    readonly contractId: string
    readonly documentType: string
    readonly data: Record<string, unknown>
    /** Explicit token payment. Defaults to the repo-v1 gate for `documentType`. */
    readonly gate?: TokenGate | null
    readonly requiredLevel?: number
    readonly confirmTimeoutMs?: number
  },
): Promise<WriteResult> {
  const { contractId, documentType, data } = params
  const requiredLevel = params.requiredLevel ?? SECURITY_LEVEL.HIGH
  const confirmTimeoutMs = params.confirmTimeoutMs ?? 30_000
  const gate = params.gate === undefined ? createGateFor(documentType) : params.gate ?? undefined
  const cost = previewDocumentCreate(documentType)

  const wif = auth.getSigningKeyWif()
  const ownerId = auth.identityId

  const identity = await facades(sdk).identities.fetch(ownerId)
  if (!identity) throw new WriteAuthError(`identity ${ownerId} not found on ${auth.network}`)
  const signing = findSigningKey(identity, wif, auth.network, requiredLevel)
  if (!signing) {
    throw new WriteAuthError(
      'no matching AUTHENTICATION key for the stored signing key at the required security level',
    )
  }

  // Deterministic document id from generated entropy — the idempotency anchor.
  const entropy = crypto.getRandomValues(new Uint8Array(32))
  const idBytes = Document.generateId(documentType, ownerId, contractId, entropy)
  const documentId = base58Encode(idBytes)

  // Re-broadcast a cached ST from a previous timed-out attempt (same nonce → no double post).
  const cached = loadPendingST(documentId)
  if (cached) {
    if (await documentExists(sdk, contractId, documentType, documentId)) {
      clearPendingST(documentId)
      return { documentId, confirmed: true, cost }
    }
  }

  const document = new Document({
    properties: data,
    documentTypeName: documentType,
    dataContractId: contractId,
    ownerId,
    revision: 1n,
    id: documentId,
    entropy,
  })

  let tokenPaymentInfo: TokenPaymentInfo | undefined
  if (gate) {
    tokenPaymentInfo = new TokenPaymentInfo({
      tokenContractPosition: gate.position,
      maximumTokenCost: BigInt(gate.amount),
    })
  }

  const nonce = await nextContractNonce(sdk, ownerId, contractId)
  const createTransition = new DocumentCreateTransition({
    document,
    identityContractNonce: nonce,
    ...(tokenPaymentInfo ? { tokenPaymentInfo } : {}),
  })
  const batched = new BatchedTransition(createTransition.toDocumentTransition())
  const batch = BatchTransition.fromBatchedTransitions([batched], ownerId, 0)
  const st = batch.toStateTransition()
  st.setIdentityContractNonce(nonce)

  const privateKey = PrivateKey.fromWIF(wif)
  st.sign(privateKey, signing.publicKey as Parameters<StateTransition['sign']>[1])

  savePendingST(documentId, st.toBytes())

  try {
    await facades(sdk).stateTransitions.broadcastStateTransition(st)
  } catch (e) {
    if (isAlreadyExistsError(e)) {
      const confirmed = await pollForDocument(sdk, contractId, documentType, documentId, 5_000)
      clearPendingST(documentId)
      return { documentId, confirmed, cost }
    }
    throw e
  }

  const confirmed = await pollForDocument(sdk, contractId, documentType, documentId, confirmTimeoutMs)
  if (confirmed) clearPendingST(documentId)
  return { documentId, confirmed, cost }
}

/**
 * Delete a document (broadcast-only, idempotent). Fetches the live `Document`, wraps it in a
 * `DocumentDeleteTransition`, signs, broadcasts, and polls for its disappearance. If the doc
 * is already gone this resolves as a no-op success. Used by unstar / unfollow.
 */
export async function deleteDocumentIdempotent(
  sdk: EvoSDK,
  auth: WriteAuth,
  params: {
    readonly contractId: string
    readonly documentType: string
    readonly documentId: string
    readonly gate?: TokenGate | null
    readonly requiredLevel?: number
    readonly confirmTimeoutMs?: number
  },
): Promise<{ deleted: boolean }> {
  const { contractId, documentType, documentId } = params
  const requiredLevel = params.requiredLevel ?? SECURITY_LEVEL.HIGH
  const confirmTimeoutMs = params.confirmTimeoutMs ?? 30_000

  const live = await facades(sdk).documents.get(contractId, documentType, documentId)
  if (live === undefined || live === null) return { deleted: true }

  const wif = auth.getSigningKeyWif()
  const ownerId = auth.identityId
  const identity = await facades(sdk).identities.fetch(ownerId)
  if (!identity) throw new WriteAuthError(`identity ${ownerId} not found on ${auth.network}`)
  const signing = findSigningKey(identity, wif, auth.network, requiredLevel)
  if (!signing) throw new WriteAuthError('no matching signing key for delete')

  const nonce = await nextContractNonce(sdk, ownerId, contractId)
  const deleteTransition = new DocumentDeleteTransition({
    document: live as ConstructorParameters<typeof DocumentDeleteTransition>[0]['document'],
    identityContractNonce: nonce,
  })
  const batched = new BatchedTransition(deleteTransition.toDocumentTransition())
  const batch = BatchTransition.fromBatchedTransitions([batched], ownerId, 0)
  const st = batch.toStateTransition()
  st.setIdentityContractNonce(nonce)
  const privateKey = PrivateKey.fromWIF(wif)
  st.sign(privateKey, signing.publicKey as Parameters<StateTransition['sign']>[1])

  try {
    await facades(sdk).stateTransitions.broadcastStateTransition(st)
  } catch (e) {
    if (!isAlreadyExistsError(e)) throw e
  }

  const deadline = Date.now() + confirmTimeoutMs
  for (;;) {
    if (!(await documentExists(sdk, contractId, documentType, documentId))) return { deleted: true }
    if (Date.now() >= deadline) return { deleted: false }
    await new Promise((r) => setTimeout(r, 1500))
  }
}

/** Read an identity's credit balance (for the auth surface / cost affordability checks). */
export async function readIdentityBalance(sdk: EvoSDK, identityId: string): Promise<bigint> {
  const identity = await facades(sdk).identities.fetch(identityId)
  return identity?.balance ?? 0n
}
