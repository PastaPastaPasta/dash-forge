/**
 * App Connect v2's chain reads (the vendored verifier's and poller's ports,
 * `lib/vendor/platform-auth/app-connect`) over Forge's SDK connection, plus the chain clock the
 * request and the verifier use (`docs/design/wallet-login.md`, App Connect v2).
 *
 * Every read is a proved SDK read, and identity reads go to the network directly (the SDK keeps
 * no identity cache): a key a wallet added moments ago is exactly what the verifier checks.
 * Forge binds no contract group by request member list (its group trust is `./group-trust`), so
 * `groupInfo` has nothing to read; the verifier never calls it.
 */

import { hexToBytes } from '@noble/hashes/utils.js'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { authSdk, type WasmKey } from '../sdk/facade'
import { base64ToBytes, bytesToBase64 } from '../sdk/query'
import type {
  AppConnectCandidate,
  AppConnectIdentityKey,
  AppConnectIdentityPort,
  AppConnectKeyBounds,
  AppConnectResponsePort,
} from '../vendor/platform-auth/app-connect'
import { APP_CONNECT_CONTRACT_ID } from './app-connect'
import { base58Decode, decodeIdentifier } from './base58'

/** The latest block's time and protocol version, from a proved response's metadata. */
export interface ChainClock {
  readonly protocolVersion: number
  readonly timeMs: number
}

export interface AppConnectPort extends AppConnectIdentityPort, AppConnectResponsePort {
  chainClock(): Promise<ChainClock>
}

/** Bytes from a key's data as the SDK hands it back: hex (the wasm getter) or bytes. */
function keyData(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  return typeof value === 'string' && /^(?:[0-9a-f]{2})+$/i.test(value) ? hexToBytes(value) : null
}

/** A key's bounds; undefined when it has none, null when they cannot be read. */
function keyBounds(k: Pick<WasmKey, 'contractBounds'>): AppConnectKeyBounds | undefined | null {
  if (!k.contractBounds) return undefined
  let json: { $type?: unknown; id?: unknown; documentTypeName?: unknown }
  try {
    json = k.contractBounds.toJSON()
  } catch {
    return null
  }
  if (typeof json.id !== 'string') return null
  switch (json.$type) {
    case 'singleContract':
      return { kind: 'singleContract', contractId: json.id }
    case 'documentType':
      return typeof json.documentTypeName === 'string' ? { kind: 'documentType', contractId: json.id, documentTypeName: json.documentTypeName } : null
    case 'contractGroup':
      return { kind: 'contractGroup', groupId: json.id }
    default:
      return null
  }
}

/**
 * A wasm key in the verifier's shape (ported from EvoVote `keyMapping.ts`), or null when it
 * cannot be read faithfully (no key type, undecodable data, unknown bounds). The caller drops a
 * null key: an unreadable bound must never look unbound, so such a key can neither verify nor
 * be matched.
 */
export function toAppConnectKey(k: WasmKey): AppConnectIdentityKey | null {
  const data = keyData(k.data)
  const bounds = keyBounds(k)
  if (k.keyTypeNumber === undefined || data === null || bounds === null) return null
  return {
    id: k.keyId,
    type: k.keyTypeNumber,
    purpose: k.purposeNumber,
    securityLevel: k.securityLevelNumber,
    data,
    ...(k.disabledAt !== undefined ? { disabledAt: Number(k.disabledAt) } : {}),
    ...(bounds !== undefined ? { bounds } : {}),
    ...(k.totalBudget !== undefined ? { totalBudget: k.totalBudget } : {}),
    ...(k.expiresAt !== undefined ? { expiresAt: Number(k.expiresAt) } : {}),
  }
}

/** Every key mapped, the unreadable ones dropped. */
export function toAppConnectKeys(keys: readonly WasmKey[]): AppConnectIdentityKey[] {
  return keys.flatMap((k) => {
    const mapped = toAppConnectKey(k)
    return mapped ? [mapped] : []
  })
}

/** Byte order of two base58 ids, as Platform orders `$ownerId`. */
export function compareIds(a: string, b: string): number {
  const left = base58Decode(a)
  const right = base58Decode(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const d = (left[i] ?? 0) - (right[i] ?? 0)
    if (d !== 0) return d
  }
  return left.length - right.length
}

interface ResponseJson {
  $ownerId?: unknown
  walletEphemeralPubKey?: unknown
  encryptedPayload?: unknown
}

function bytesOr(value: unknown): Uint8Array {
  if (typeof value !== 'string') return new Uint8Array(0)
  try {
    return base64ToBytes(value)
  } catch {
    return new Uint8Array(0)
  }
}

/**
 * A `loginKeyResponse` row as a candidate. A row whose bytes do not read is still returned, with
 * empty bytes (the verifier refuses it as `framing`): dropping it would shorten the page, and
 * the poller takes a short page for the last one. A row without a readable owner (only a node
 * that lies can return one) is a read Forge cannot use: it throws, so the round counts as
 * incomplete rather than as one more identity answering.
 */
export function candidateOf(json: ResponseJson): AppConnectCandidate {
  if (typeof json.$ownerId !== 'string' || !isIdentifier(json.$ownerId)) throw new Error('an App Connect answer has no readable owner')
  return { ownerId: json.$ownerId, walletEphemeralPubKey: bytesOr(json.walletEphemeralPubKey), encryptedPayload: bytesOr(json.encryptedPayload) }
}

function isIdentifier(id: string): boolean {
  try {
    decodeIdentifier(id)
    return true
  } catch {
    return false
  }
}

/** The App Connect ports over `sdk`. */
export function appConnectPort(sdk: EvoSDK): AppConnectPort {
  const api = authSdk(sdk)
  return {
    async getIdentityFresh(identityId) {
      const identity = await api.identities.fetch(identityId)
      // A proved fetch by id: the identity returned is the one asked for.
      return identity ? { id: identityId, publicKeys: toAppConnectKeys(identity.publicKeys) } : null
    },

    async remainingBudgets(identityId, keyIds) {
      const budgets = await api.identities.keysRemainingBudgets(identityId, keyIds)
      const out = new Map<number, bigint | undefined>()
      for (const [keyId, remaining] of budgets) out.set(Number(keyId), remaining ?? undefined)
      return out
    },

    async contractKeys(identityId, contractId, purpose) {
      const entries = await api.identities.contractKeys({ identityIds: [identityId], contractId, purposes: [purpose] })
      const entry = entries.find((e) => e.identityId.toBase58() === identityId)
      return entry ? toAppConnectKeys(entry.keys) : []
    },

    async groupInfo() {
      return null
    },

    async listCandidates(requestHash, hint, startAfter, limit) {
      const where: unknown[][] = [['appEphemeralPubKeyHash', '==', bytesToBase64(requestHash)]]
      if (hint !== undefined) where.push(['$ownerId', '==', hint])
      else if (startAfter !== undefined) where.push(['$ownerId', '>', startAfter])
      const rows = await api.documents.query({
        dataContractId: APP_CONNECT_CONTRACT_ID,
        documentTypeName: 'loginKeyResponse',
        where,
        // The (appEphemeralPubKeyHash, $ownerId) index, as the v1 poll reads it (`./app-connect`).
        orderBy: [
          ['appEphemeralPubKeyHash', 'asc'],
          ['$ownerId', 'asc'],
        ],
        limit,
      })
      const candidates = [...rows.values()].filter(Boolean).map((r) => candidateOf((r as { toJSON(): ResponseJson }).toJSON()))
      // The poller relies on owner order; Platform returns it, but a Map's order is the SDK's.
      return candidates.sort((a, b) => compareIds(a.ownerId, b.ownerId))
    },

    async chainClock() {
      const { metadata } = await api.protocol.versionUpgradeStateWithProof()
      return { protocolVersion: metadata.protocolVersion, timeMs: Number(metadata.timeMs) }
    },
  }
}
