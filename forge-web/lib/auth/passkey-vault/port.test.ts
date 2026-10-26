/**
 * The passkey vault's port over a fake SDK: proved reads of `vaultEntry` rows checked against the
 * schema and their owner, identity keys in the core's shape (an unreadable bound drops the key),
 * and writes through Forge's write helpers (create, replace of the sealed fields only, delete).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { bytesToBase64 } from '../../sdk/query'
import type { WriteAuth } from '../../sdk/write'
import { base58Encode } from '../base58'
import { credentialBytes, credentialName, forgeVaultPort } from './port'

const writes = vi.hoisted(() => [] as { op: string; params: Record<string, unknown> }[])
vi.mock('../../sdk/write', async (orig) => ({
  ...(await orig<typeof import('../../sdk/write')>()),
  createDocumentIdempotent: async (_sdk: unknown, _auth: unknown, params: Record<string, unknown>) => void writes.push({ op: 'create', params }),
  replaceDocumentIdempotent: async (_sdk: unknown, _auth: unknown, params: Record<string, unknown>) => void writes.push({ op: 'replace', params }),
  deleteDocumentIdempotent: async (_sdk: unknown, _auth: unknown, params: Record<string, unknown>) => void writes.push({ op: 'delete', params }),
}))

const OWNER = new Uint8Array(32).fill(7)
const OTHER = new Uint8Array(32).fill(8)
const META = base58Encode(new Uint8Array(32).fill(3))
const GROUP = base58Encode(new Uint8Array(32).fill(4))
const CRED = new Uint8Array(20).fill(5)

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $id: 'doc1',
    $ownerId: base58Encode(OWNER),
    $revision: 2,
    $createdAt: 1000,
    $updatedAt: 2000,
    credentialId: bytesToBase64(CRED),
    recipientKey: bytesToBase64(new Uint8Array(32).fill(1)),
    version: 1,
    authKeyId: 4,
    enc: bytesToBase64(new Uint8Array(32).fill(2)),
    sealed: bytesToBase64(new Uint8Array(256).fill(3)),
    ...over,
  }
}

function fakeSdk(rows: Record<string, unknown>[], keys: unknown[] | null = []) {
  const queries: unknown[] = []
  const sdk = {
    version: () => 11,
    documents: {
      query: async (q: unknown) => {
        queries.push(q)
        return new Map(rows.map((r, i) => [String(i), { toJSON: () => r }]))
      },
    },
    identities: {
      fetch: async () => (keys === null ? undefined : { publicKeys: keys, balance: 0n }),
      keysRemainingBudgets: async (_id: string, ids: number[]) => new Map(ids.map((i) => [i, i === 4 ? 7n : null])),
    },
  } as unknown as EvoSDK
  return { sdk, queries }
}

const auth: WriteAuth = { identityId: base58Encode(OWNER), network: 'devnet', getSigningKeyWif: () => 'wif' }

beforeEach(() => {
  writes.length = 0
})

describe('the passkey vault port', () => {
  it('lists the owner’s entries from forge-meta with one proved read, checked against the schema', async () => {
    const { sdk, queries } = fakeSdk([row()])
    const [e] = await forgeVaultPort({ sdk, contractId: META }).list(OWNER)
    expect(queries).toEqual([
      { dataContractId: META, documentTypeName: 'vaultEntry', where: [['$ownerId', '==', base58Encode(OWNER)]], orderBy: [['credentialId', 'asc']], limit: 100 },
    ])
    expect(e).toMatchObject({ documentId: 'doc1', revision: 2, createdAt: 1000, updatedAt: 2000, version: 1, authKeyId: 4 })
    expect(e!.credentialId).toEqual(CRED)
    expect(e!.sealed).toHaveLength(256)
    expect(e!.ownerId).toEqual(OWNER)
  })

  it('reads one credential by the unique index, and says null only when none is there', async () => {
    const { sdk, queries } = fakeSdk([row()])
    expect(await forgeVaultPort({ sdk, contractId: META }).byCredential(OWNER, CRED)).not.toBeNull()
    expect((queries[0] as { where: unknown }).where).toEqual([
      ['$ownerId', '==', base58Encode(OWNER)],
      ['credentialId', '==', bytesToBase64(CRED)],
    ])
    expect(await forgeVaultPort({ sdk: fakeSdk([]).sdk, contractId: META }).byCredential(OWNER, CRED)).toBeNull()
  })

  it.each([
    ['another owner', { $ownerId: base58Encode(OTHER) }],
    ['a short recipient key', { recipientKey: bytesToBase64(new Uint8Array(31)) }],
    ['a short credential id', { credentialId: bytesToBase64(new Uint8Array(15)) }],
    ['an oversized ciphertext', { sealed: bytesToBase64(new Uint8Array(257)) }],
    ['no key id', { authKeyId: undefined }],
  ])('refuses a row with %s (an error, never an absent entry)', async (_what, over) => {
    const port = forgeVaultPort({ sdk: fakeSdk([row(over)]).sdk, contractId: META })
    await expect(port.list(OWNER)).rejects.toThrow()
    await expect(port.byCredential(OWNER, CRED)).rejects.toThrow()
  })

  it('reads the identity’s keys in the core’s shape, with remaining budgets; an unreadable bound drops the key', async () => {
    const keys = [
      { keyId: 0, purposeNumber: 0, securityLevelNumber: 0, keyTypeNumber: 0, data: '02'.padEnd(66, '1') },
      {
        keyId: 4,
        purposeNumber: 0,
        securityLevelNumber: 2,
        keyTypeNumber: 0,
        data: '03'.padEnd(66, '2'),
        totalBudget: 10n,
        expiresAt: 5000n,
        contractBounds: { toJSON: () => ({ $type: 'contractGroup', id: GROUP }) },
      },
      { keyId: 5, purposeNumber: 0, securityLevelNumber: 2, keyTypeNumber: 2, data: 'aa'.repeat(20), disabledAt: 1n, totalBudget: 1n },
      { keyId: 6, purposeNumber: 0, securityLevelNumber: 2, keyTypeNumber: 0, data: '02'.padEnd(66, '3'), contractBounds: { toJSON: () => ({ $type: 'mystery', id: GROUP }) } },
      { keyId: 7, purposeNumber: 0, securityLevelNumber: 2, data: '02'.padEnd(66, '3') },
    ]
    const got = await forgeVaultPort({ sdk: fakeSdk([], keys).sdk, contractId: META }).identityKeys(OWNER)
    expect(got?.map((k) => k.id)).toEqual([0, 4, 5])
    expect(got?.[1]).toMatchObject({ purpose: 0, securityLevel: 2, type: 0, disabled: false, expiresAt: 5000, totalBudget: 10n, remainingBudget: 7n })
    expect(got?.[1]?.contractBounds).toEqual({ kind: 'contractGroup', groupId: new Uint8Array(32).fill(4) })
    // A budgeted key whose remaining budget the node did not answer: unknown, not spent.
    expect(got?.[2]).toMatchObject({ disabled: true, type: 2 })
    expect(got?.[2]?.remainingBudget).toBeUndefined()
    expect(await forgeVaultPort({ sdk: fakeSdk([], null).sdk, contractId: META }).identityKeys(OWNER)).toBeNull()
  })

  it('creates, replaces only the sealed fields at the revision read, and deletes, as the session', async () => {
    const { sdk } = fakeSdk([row()])
    const port = forgeVaultPort({ sdk, contractId: META, auth })
    const existing = (await port.byCredential(OWNER, CRED))!
    const entry = { version: 1, credentialId: CRED, recipientKey: existing.recipientKey, authKeyId: 9, enc: new Uint8Array(32), sealed: new Uint8Array(256) }
    await port.put({ ownerId: OWNER, entry, existing: null })
    await port.put({ ownerId: OWNER, entry, existing })
    await port.remove({ ownerId: OWNER, entry: existing })
    expect(writes.map((w) => w.op)).toEqual(['create', 'replace', 'delete'])
    expect(writes[0]!.params).toMatchObject({ contractId: META, documentType: 'vaultEntry', data: { credentialId: CRED, authKeyId: 9, version: 1 } })
    expect(writes[1]!.params).toMatchObject({ documentId: 'doc1', expectedRevision: 2n })
    expect(Object.keys(writes[1]!.params['changes'] as object).sort()).toEqual(['authKeyId', 'enc', 'sealed', 'version'])
    expect(writes[2]!.params).toMatchObject({ contractId: META, documentType: 'vaultEntry', documentId: 'doc1' })
    // The recipient key is immutable: a replace to another is a bug, refused before signing.
    await expect(port.put({ ownerId: OWNER, entry: { ...entry, recipientKey: new Uint8Array(32) }, existing })).rejects.toThrow(/same passkey/)
  })

  it('writes nothing without a signer for that identity', async () => {
    const { sdk } = fakeSdk([row()])
    const entry = { version: 1, credentialId: CRED, recipientKey: new Uint8Array(32), authKeyId: 9, enc: new Uint8Array(32), sealed: new Uint8Array(256) }
    await expect(forgeVaultPort({ sdk, contractId: META }).put({ ownerId: OWNER, entry, existing: null })).rejects.toThrow(/cannot write/)
    await expect(forgeVaultPort({ sdk, contractId: META, auth }).put({ ownerId: OTHER, entry, existing: null })).rejects.toThrow(/cannot write/)
    expect(writes).toEqual([])
  })

  it('names credential ids in base64url and back', () => {
    const id = Uint8Array.from({ length: 33 }, (_, i) => i * 7 + 250)
    expect(credentialName(id)).not.toMatch(/[+/=]/)
    expect(credentialBytes(credentialName(id))).toEqual(id)
  })
})
