/**
 * The passkey vault's chain port over Forge's SDK connection: `vaultEntry` documents in
 * forge-meta, and the owner's keys, all read with proofs (the trusted connection proof-checks
 * every query, `lib/sdk/query.ts` {@link queryDocumentsWithProof}). Writes go through Forge's
 * write helpers, which already run as the identity's only writer (`serialized(identityId)`,
 * `lib/sdk/write.ts`) and settle a lost answer by reading back, so a retried action lands once.
 *
 * The signer is the session's {@link WriteAuth}: a write to forge-meta needs a key whose bounds
 * cover it (a group-bound Forge key does). A port built without one reads only.
 *
 * Every row is checked against the schema's sizes and its owner before the core sees it; a row
 * that does not read is an error, never an absent entry (a planted or unreadable entry must not
 * make the vault create a second one, or skip a cap).
 */

import { hexToBytes } from '@noble/hashes/utils.js'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { DOC } from '../../repo/contract'
import { authSdk, type WasmKey } from '../../sdk/facade'
import { base64ToBytes, bytesToBase64, queryDocumentsWithProof, type PlainDocument } from '../../sdk/query'
import { createDocumentIdempotent, deleteDocumentIdempotent, replaceDocumentIdempotent, type WriteAuth } from '../../sdk/write'
import {
  bytesEqual,
  MAX_CREDENTIAL_ID_LENGTH,
  MIN_CREDENTIAL_ID_LENGTH,
  type ContractBounds,
  type OnChainKey,
  type SealedVaultEntry,
  type VaultEntryRecord,
  type VaultPort,
} from '../../vendor/platform-auth/passkey-vault'
import { base58Encode, decodeIdentifier } from '../base58'

/** The most entries one read lists (Platform's page limit; the client's cap is 10). */
export const VAULT_LIST_LIMIT = 100

/** Bytes from a document field as the SDK's JSON gives them (base64), or as bytes. */
function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value.slice()
  if (typeof value !== 'string') return null
  try {
    return base64ToBytes(value)
  } catch {
    return null
  }
}

const isU32 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff
const msOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * A `vaultEntry` row as the core's record, checked against the schema (`forge-meta.json`) and
 * the owner asked for. Throws on anything else.
 */
export function entryOf(doc: PlainDocument, ownerId: Uint8Array): VaultEntryRecord {
  const owner = doc['$ownerId']
  const credentialId = bytesOf(doc['credentialId'])
  const recipientKey = bytesOf(doc['recipientKey'])
  const enc = bytesOf(doc['enc'])
  const sealed = bytesOf(doc['sealed'])
  const { version, authKeyId } = doc
  const id = doc['$id']
  const ok =
    typeof owner === 'string' &&
    bytesEqual(decodeIdentifier(owner), ownerId) &&
    typeof id === 'string' &&
    credentialId !== null &&
    credentialId.length >= MIN_CREDENTIAL_ID_LENGTH &&
    credentialId.length <= MAX_CREDENTIAL_ID_LENGTH &&
    recipientKey?.length === 32 &&
    enc?.length === 32 &&
    sealed !== null &&
    sealed.length >= 32 &&
    sealed.length <= 256 &&
    typeof version === 'number' &&
    isU32(authKeyId)
  // copy-lint-ignore: a developer error (the SDK answered a row the schema forbids)
  if (!ok) throw new Error('a passkey entry on Platform does not read as one')
  const revision = msOf(doc['$revision'])
  const createdAt = msOf(doc['$createdAt'])
  const updatedAt = msOf(doc['$updatedAt'])
  return {
    ownerId: ownerId.slice(),
    documentId: id,
    version,
    credentialId,
    recipientKey,
    authKeyId,
    enc,
    sealed,
    ...(revision !== undefined ? { revision } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  }
}

/** A key's bounds in the core's shape: undefined when it has none, null when they do not read. */
function boundsOf(k: Pick<WasmKey, 'contractBounds'>): ContractBounds | undefined | null {
  if (!k.contractBounds) return undefined
  let json: { $type?: unknown; id?: unknown; documentTypeName?: unknown }
  try {
    json = k.contractBounds.toJSON()
  } catch {
    return null
  }
  if (typeof json.id !== 'string') return null
  let id: Uint8Array
  try {
    id = decodeIdentifier(json.id)
  } catch {
    return null
  }
  switch (json.$type) {
    case 'singleContract':
      return { kind: 'singleContract', contractId: id }
    case 'documentType':
      return typeof json.documentTypeName === 'string' ? { kind: 'singleContractDocumentType', contractId: id, documentType: json.documentTypeName } : null
    case 'contractGroup':
      return { kind: 'contractGroup', groupId: id }
    default:
      return null
  }
}

/**
 * An identity key in the core's shape, or null when it cannot be read faithfully (no key type,
 * undecodable data, unreadable bounds): such a key is dropped, never shown as unbound.
 */
export function onChainKeyOf(k: WasmKey, remainingBudget?: bigint | null): OnChainKey | null {
  const bounds = boundsOf(k)
  if (k.keyTypeNumber === undefined || typeof k.data !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(k.data) || bounds === null) return null
  return {
    id: k.keyId,
    purpose: k.purposeNumber,
    securityLevel: k.securityLevelNumber,
    type: k.keyTypeNumber,
    data: hexToBytes(k.data),
    disabled: k.disabledAt !== undefined,
    ...(bounds !== undefined ? { contractBounds: bounds } : {}),
    ...(k.expiresAt !== undefined ? { expiresAt: Number(k.expiresAt) } : {}),
    ...(k.totalBudget !== undefined ? { totalBudget: k.totalBudget } : {}),
    // Drive keeps a remaining budget for every budgeted key: none read is a node behind (unknown).
    ...(remainingBudget !== undefined && remainingBudget !== null ? { remainingBudget } : {}),
  }
}

/** The fields a `vaultEntry` stores (bytes stay bytes: the write path keeps them binary). */
function entryData(entry: SealedVaultEntry): Record<string, unknown> {
  return { credentialId: entry.credentialId, recipientKey: entry.recipientKey, version: entry.version, authKeyId: entry.authKeyId, enc: entry.enc, sealed: entry.sealed }
}

export interface ForgeVaultPortOptions {
  readonly sdk: EvoSDK
  /** forge-meta, the contract `vaultEntry` lives in. */
  readonly contractId: string
  /** The session's signer; without it the port reads only. */
  readonly auth?: WriteAuth | null
}

/** The passkey vault's port over `sdk`. */
export function forgeVaultPort({ sdk, contractId, auth = null }: ForgeVaultPortOptions): VaultPort {
  const query = (ownerId: Uint8Array, credentialId?: Uint8Array) =>
    queryDocumentsWithProof(sdk, {
      dataContractId: contractId,
      documentTypeName: DOC.vaultEntry,
      // The unique `byCredential [$ownerId, credentialId]` index serves both reads.
      where: [['$ownerId', '==', base58Encode(ownerId)], ...(credentialId ? [['credentialId', '==', bytesToBase64(credentialId)] as const] : [])],
      orderBy: [['credentialId', 'asc']],
      limit: credentialId ? 1 : VAULT_LIST_LIMIT,
    })
  const signer = (ownerId: Uint8Array): WriteAuth => {
    // copy-lint-ignore: a developer error (a write through a read-only port, or for another identity)
    if (auth === null || auth.identityId !== base58Encode(ownerId)) throw new Error('this passkey vault port cannot write for that identity')
    return auth
  }
  const byCredential = async (ownerId: Uint8Array, credentialId: Uint8Array): Promise<VaultEntryRecord | null> => {
    const { documents } = await query(ownerId, credentialId)
    return documents.map((d) => entryOf(d, ownerId)).find((e) => bytesEqual(e.credentialId, credentialId)) ?? null
  }
  return {
    async list(ownerId) {
      const { documents } = await query(ownerId)
      return documents.map((d) => entryOf(d, ownerId))
    },

    byCredential,

    async identityKeys(ownerId) {
      const id = base58Encode(ownerId)
      const api = authSdk(sdk)
      const identity = await api.identities.fetch(id)
      if (!identity) return null
      const budgeted = identity.publicKeys.filter((k) => k.totalBudget !== undefined).map((k) => k.keyId)
      const budgets = budgeted.length > 0 ? await api.identities.keysRemainingBudgets(id, budgeted) : new Map<number, bigint | null>()
      return identity.publicKeys.flatMap((k) => {
        const key = onChainKeyOf(k, budgets.get(k.keyId))
        return key ? [key] : []
      })
    },

    async put({ ownerId, entry, existing }) {
      const writer = signer(ownerId)
      if (existing === null) {
        await createDocumentIdempotent(sdk, writer, { contractId, documentType: DOC.vaultEntry, data: entryData(entry) })
        return
      }
      // credentialId and recipientKey are immutable: only the sealed fields and the key id change.
      // copy-lint-ignore: a developer error (the core never asks for this)
      if (!bytesEqual(existing.credentialId, entry.credentialId) || !bytesEqual(existing.recipientKey, entry.recipientKey) || existing.documentId === undefined) {
        throw new Error('a passkey entry can only be replaced by one for the same passkey')
      }
      await replaceDocumentIdempotent(sdk, writer, {
        contractId,
        documentType: DOC.vaultEntry,
        documentId: existing.documentId,
        changes: { version: entry.version, authKeyId: entry.authKeyId, enc: entry.enc, sealed: entry.sealed },
        ...(existing.revision !== undefined ? { expectedRevision: BigInt(existing.revision) } : {}),
      })
    },

    async remove({ ownerId, entry }) {
      const writer = signer(ownerId)
      const documentId = entry.documentId ?? (await byCredential(ownerId, entry.credentialId))?.documentId
      if (documentId === undefined) return
      await deleteDocumentIdempotent(sdk, writer, { contractId, documentType: DOC.vaultEntry, documentId })
    },
  }
}

/** A credential id as the UI names it (base64url, no padding). */
export function credentialName(credentialId: Uint8Array): string {
  return bytesToBase64(credentialId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The bytes of a credential id {@link credentialName} named. */
export function credentialBytes(name: string): Uint8Array {
  const b64 = name.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}
