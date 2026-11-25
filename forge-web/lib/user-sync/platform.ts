/**
 * forge-user documents on Platform (`forge-contracts/contracts/user/forge-user.json`): every read
 * is proved, every row is checked against the schema and its owner before use, and writes go
 * through Forge's write helpers (one writer per identity, a lost answer settled by reading back,
 * the charge reported to the ledger and its toast).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { hexToBytes } from '@noble/hashes/utils.js'

import { authSdk } from '../sdk/facade'
import { base64ToBytes, queryDocumentsWithProof, type OrderByClause, type PlainDocument, type WhereClause } from '../sdk/query'
import { createDocumentIdempotent, deleteDocumentIdempotent, replaceDocumentIdempotent, type WriteAuth } from '../sdk/write'
import { base58Encode } from '../auth/base58'
import { KeyPurpose, KeyType } from '../vendor/platform-auth/app-connect/types'
import { NONCE_BYTES, PIECE_BYTES, WRAPPED_BYTES, type ShareFields, type StateFields } from './crypto'

export interface Stored<T> {
  readonly id: string
  readonly ownerId: string
  readonly revision?: bigint
  readonly fields: T
}

export interface GrantFields {
  readonly repoId: string
  readonly memberId: string
  readonly epoch: number
  readonly senderKeyId: number
  readonly recipientKeyId: number
  readonly wrapped: Uint8Array
}

/** An identity's live forge-user ENCRYPTION key: its id and 33-byte public key. */
export interface SyncPublicKey {
  readonly keyId: number
  readonly pub: Uint8Array
}

/** What sync reads and writes on Platform. A fake implements it in tests. */
export interface UserSyncPort {
  readState(ownerId: string, slot: string): Promise<Stored<StateFields> | null>
  writeState(fields: StateFields, existing: Stored<StateFields> | null): Promise<void>
  readShare(ownerId: string, repoId: string): Promise<Stored<ShareFields> | null>
  writeShare(repoId: string, fields: ShareFields, existing: Stored<ShareFields> | null): Promise<void>
  deleteShare(existing: Stored<ShareFields>): Promise<void>
  /** The grants `ownerId` made for `repoId`. */
  grantsOf(ownerId: string, repoId: string): Promise<Stored<GrantFields>[]>
  /** `ownerId`'s grant to `memberId` for `repoId` (the unique index: grants by others cannot crowd it out). */
  grantFor(ownerId: string, repoId: string, memberId: string): Promise<Stored<GrantFields> | null>
  writeGrant(fields: GrantFields, existing: Stored<GrantFields> | null): Promise<void>
  deleteGrant(existing: Stored<GrantFields>): Promise<void>
  /** `identityId`'s key `keyId` when it is a live forge-user ENCRYPTION key, else null. */
  syncKey(identityId: string, keyId?: number): Promise<SyncPublicKey | null>
}

const isU32 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value.slice()
  if (typeof value !== 'string') return null
  try {
    return base64ToBytes(value)
  } catch {
    return null
  }
}

function piece(value: unknown, min: number): Uint8Array | undefined | null {
  if (value === undefined || value === null) return undefined
  const b = bytesOf(value)
  return b !== null && b.length >= min && b.length <= PIECE_BYTES ? b : null
}

function storedOf<T>(doc: PlainDocument & { $id: string }, ownerId: string, fields: T): Stored<T> {
  const r = doc['$revision']
  return { id: doc.$id, ownerId, ...(typeof r === 'number' || typeof r === 'bigint' ? { revision: BigInt(r) } : {}), fields }
}

function idOf(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array && v.length === 32) return base58Encode(v)
  return null
}

const unreadable = (what: string): Error => new Error(`a ${what} on Platform does not read as one`)

export function stateOf(doc: PlainDocument, ownerId: string, slot: string): Stored<StateFields> {
  const n = bytesOf(doc['n'])
  const d0 = piece(doc['d0'], 17)
  const d1 = piece(doc['d1'], 1)
  const d2 = piece(doc['d2'], 1)
  const { v, keyId } = doc
  if (doc['$ownerId'] !== ownerId || doc['slot'] !== slot || typeof doc['$id'] !== 'string' || typeof v !== 'number' || !isU32(keyId) || n?.length !== NONCE_BYTES || !d0 || d1 === null || d2 === null) {
    throw unreadable('settings slot')
  }
  return storedOf(doc as PlainDocument & { $id: string }, ownerId, { slot, v, keyId, n, d0, ...(d1 ? { d1 } : {}), ...(d2 ? { d2 } : {}) })
}

export function shareOf(doc: PlainDocument, ownerId: string, repoId: string): Stored<ShareFields> {
  const n = bytesOf(doc['n'])
  const d0 = piece(doc['d0'], 17)
  const d1 = piece(doc['d1'], 1)
  const { epoch, keyId } = doc
  if (doc['$ownerId'] !== ownerId || idOf(doc['repoId']) !== repoId || typeof doc['$id'] !== 'string' || !isU32(epoch) || !isU32(keyId) || n?.length !== NONCE_BYTES || !d0 || d1 === null) {
    throw unreadable('storage share')
  }
  return storedOf(doc as PlainDocument & { $id: string }, ownerId, { epoch, keyId, n, d0, ...(d1 ? { d1 } : {}) })
}

/** A grant row, or null when it does not read as one (a reader skips it). */
export function grantOf(doc: PlainDocument): Stored<GrantFields> | null {
  const ownerId = doc['$ownerId']
  const repoId = idOf(doc['repoId'])
  const memberId = idOf(doc['memberId'])
  const wrapped = bytesOf(doc['wrapped'])
  const { epoch, senderKeyId, recipientKeyId } = doc
  if (typeof ownerId !== 'string' || typeof doc['$id'] !== 'string' || !repoId || !memberId || !isU32(epoch) || !isU32(senderKeyId) || !isU32(recipientKeyId) || wrapped?.length !== WRAPPED_BYTES) return null
  return storedOf(doc as PlainDocument & { $id: string }, ownerId, { repoId, memberId, epoch, senderKeyId, recipientKeyId, wrapped })
}

/** The most grants one read lists (a repo's maintainers are far fewer). */
const GRANT_LIMIT = 100

/** The port over Forge's SDK connection; `auth` signs writes (a group-bound key covers forge-user). */
export function forgeUserPort(sdk: EvoSDK, contractId: string, auth: WriteAuth | null): UserSyncPort {
  const signer = (): WriteAuth => {
    // copy-lint-ignore: a developer error (a write through a read-only port)
    if (auth === null) throw new Error('this sync port reads only')
    return auth
  }
  const one = async (type: string, where: WhereClause[], orderBy: OrderByClause[]): Promise<PlainDocument | null> => {
    const { documents } = await queryDocumentsWithProof(sdk, { dataContractId: contractId, documentTypeName: type, where, orderBy, limit: 1 })
    return documents[0] ?? null
  }
  const grants = async (where: WhereClause[], orderBy: OrderByClause[]): Promise<Stored<GrantFields>[]> => {
    const { documents } = await queryDocumentsWithProof(sdk, { dataContractId: contractId, documentTypeName: 'grant', where, orderBy, limit: GRANT_LIMIT })
    return documents.flatMap((d) => grantOf(d) ?? [])
  }
  /** Create `data`, or replace `existing` (at the revision read) with `changes`: an undefined property is removed. */
  const put = async (documentType: string, existing: Stored<unknown> | null, data: Record<string, unknown>, changes: Record<string, unknown>): Promise<void> => {
    if (existing === null) {
      await createDocumentIdempotent(sdk, signer(), { contractId, documentType, data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) })
      return
    }
    await replaceDocumentIdempotent(sdk, signer(), { contractId, documentType, documentId: existing.id, changes, ...(existing.revision !== undefined ? { expectedRevision: existing.revision } : {}) })
  }
  return {
    async readState(ownerId, slot) {
      const doc = await one('state', [['$ownerId', '==', ownerId], ['slot', '==', slot]], [['slot', 'asc']])
      return doc ? stateOf(doc, ownerId, slot) : null
    },
    async writeState(f, existing) {
      const changes = { v: f.v, keyId: f.keyId, n: f.n, d0: f.d0, d1: f.d1, d2: f.d2 }
      await put('state', existing, { slot: f.slot, ...changes }, changes)
    },
    async readShare(ownerId, repoId) {
      const doc = await one('share', [['$ownerId', '==', ownerId], ['repoId', '==', repoId]], [['repoId', 'asc']])
      return doc ? shareOf(doc, ownerId, repoId) : null
    },
    async writeShare(repoId, f, existing) {
      const changes = { epoch: f.epoch, keyId: f.keyId, n: f.n, d0: f.d0, d1: f.d1 }
      await put('share', existing, { repoId, ...changes }, changes)
    },
    grantsOf: (ownerId, repoId) => grants([['$ownerId', '==', ownerId], ['repoId', '==', repoId]], [['repoId', 'asc'], ['memberId', 'asc']]),
    async grantFor(ownerId, repoId, memberId) {
      const doc = await one('grant', [['$ownerId', '==', ownerId], ['repoId', '==', repoId], ['memberId', '==', memberId]], [['repoId', 'asc'], ['memberId', 'asc']])
      const g = doc ? grantOf(doc) : null
      return g !== null && g.ownerId === ownerId && g.fields.repoId === repoId && g.fields.memberId === memberId ? g : null
    },
    async writeGrant(f, existing) {
      await put('grant', existing, { ...f }, { epoch: f.epoch, senderKeyId: f.senderKeyId, recipientKeyId: f.recipientKeyId, wrapped: f.wrapped })
    },
    async deleteShare(existing) {
      await deleteDocumentIdempotent(sdk, signer(), { contractId, documentType: 'share', documentId: existing.id })
    },
    async deleteGrant(existing) {
      await deleteDocumentIdempotent(sdk, signer(), { contractId, documentType: 'grant', documentId: existing.id })
    },
    async syncKey(identityId, keyId) {
      const identity = await authSdk(sdk).identities.fetch(identityId)
      if (!identity) return null
      const live = identity.publicKeys.filter((k) => {
        if (k.disabledAt !== undefined || k.purposeNumber !== KeyPurpose.ENCRYPTION || k.keyTypeNumber !== KeyType.ECDSA_SECP256K1) return false
        if (keyId !== undefined && k.keyId !== keyId) return false
        try {
          const b = k.contractBounds?.toJSON()
          return b?.$type === 'singleContract' && b.id === contractId
        } catch {
          return false
        }
      })
      const best = live.sort((a, b) => b.keyId - a.keyId)[0]
      if (!best || typeof best.data !== 'string' || !/^(?:[0-9a-f]{2}){33}$/i.test(best.data)) return null
      return { keyId: best.keyId, pub: hexToBytes(best.data) }
    },
  }
}
