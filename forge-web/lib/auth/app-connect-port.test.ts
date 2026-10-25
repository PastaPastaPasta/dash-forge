/**
 * The App Connect ports over fake wasm objects: how a key is read (and when it is dropped rather
 * than misread), answers sorted by owner whatever order the SDK hands them back in, and the
 * chain clock.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import type { WasmKey } from '../sdk/facade'
import { APP_CONNECT_CONTRACT_ID } from './app-connect'
import { appConnectPort, candidateOf, compareIds, toAppConnectKey, toAppConnectKeys } from './app-connect-port'
import { base58Encode } from './base58'

const GROUP = '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC'
const CONTRACT = 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1'

function wasmKey(over: Partial<WasmKey> & { bounds?: unknown } = {}): WasmKey {
  const { bounds, ...rest } = over
  return {
    keyId: 3,
    keyTypeNumber: 0,
    data: '02' + 'ab'.repeat(32),
    purposeNumber: 0,
    securityLevelNumber: 2,
    ...(bounds !== undefined ? { contractBounds: { toJSON: () => bounds as { $type: string; id: string } } } : {}),
    validatePrivateKey: () => false,
    ...rest,
  }
}

describe('reading keys for the verifier', () => {
  it('maps a group-bound V1 key with its limits', () => {
    const k = toAppConnectKey(wasmKey({ bounds: { $type: 'contractGroup', id: GROUP }, totalBudget: 5n, expiresAt: 1_800_000_000_000n, disabledAt: 1_700_000_000_000n }))
    expect(k).toEqual({
      id: 3,
      type: 0,
      purpose: 0,
      securityLevel: 2,
      data: new Uint8Array([2, ...new Array(32).fill(0xab)]),
      bounds: { kind: 'contractGroup', groupId: GROUP },
      totalBudget: 5n,
      expiresAt: 1_800_000_000_000,
      disabledAt: 1_700_000_000_000,
    })
  })

  it('maps every bounds kind, and an unbound key as unbound', () => {
    expect(toAppConnectKey(wasmKey({ bounds: { $type: 'singleContract', id: CONTRACT } }))?.bounds).toEqual({ kind: 'singleContract', contractId: CONTRACT })
    expect(toAppConnectKey(wasmKey({ bounds: { $type: 'documentType', id: CONTRACT, documentTypeName: 'profile' } }))?.bounds).toEqual({
      kind: 'documentType',
      contractId: CONTRACT,
      documentTypeName: 'profile',
    })
    const unbound = toAppConnectKey(wasmKey())
    expect(unbound).not.toBeNull()
    expect(unbound?.bounds).toBeUndefined()
  })

  it('drops a key it cannot read faithfully: an unreadable bound never looks unbound', () => {
    const unreadable = [
      wasmKey({ bounds: { $type: 'someFutureKind', id: GROUP } }),
      wasmKey({ bounds: { $type: 'documentType', id: CONTRACT } }),
      wasmKey({ bounds: { $type: 'contractGroup' } }),
      wasmKey({ keyTypeNumber: undefined }),
      wasmKey({ data: 'not hex' }),
      wasmKey({ data: undefined }),
      { ...wasmKey(), contractBounds: { toJSON: () => { throw new Error('freed') } } },
    ]
    for (const k of unreadable) expect(toAppConnectKey(k)).toBeNull()
    expect(toAppConnectKeys([...unreadable, wasmKey({ keyId: 9 })]).map((k) => k.id)).toEqual([9])
  })
})

describe('reading answers', () => {
  const ids = [new Uint8Array(32).fill(9), new Uint8Array(32).fill(1), new Uint8Array(32).fill(200)].map(base58Encode)

  it('orders owners by bytes, as Platform does (not as strings)', () => {
    // As strings '2…' < 'E…' < 'm…'; as bytes 0x01 < 0x09 < 0xc8.
    const sorted = [...ids].sort(compareIds)
    expect(sorted).toEqual([ids[1], ids[0], ids[2]])
  })

  it('pages the App Connect contract by request and owner, sorted by owner whatever the SDK order', async () => {
    const queries: unknown[] = []
    const sdk = {
      documents: {
        async query(q: unknown) {
          queries.push(q)
          return new Map(ids.map((id, i) => [String(i), { toJSON: () => ({ $ownerId: id, walletEphemeralPubKey: btoa('\x02'.repeat(33)), encryptedPayload: btoa('x'.repeat(60)) }) }]))
        },
      },
    } as unknown as EvoSDK
    const port = appConnectPort(sdk)
    const hash = new Uint8Array(20).fill(5)
    const got = await port.listCandidates(hash, undefined, ids[1], 10)
    expect(got.map((c) => c.ownerId)).toEqual([ids[1], ids[0], ids[2]])
    expect(got[0]!.encryptedPayload.length).toBe(60)
    expect(queries[0]).toMatchObject({
      dataContractId: APP_CONNECT_CONTRACT_ID,
      documentTypeName: 'loginKeyResponse',
      where: [
        ['appEphemeralPubKeyHash', '==', btoa(String.fromCharCode(...hash))],
        ['$ownerId', '>', ids[1]],
      ],
      limit: 10,
    })
    await port.listCandidates(hash, ids[2], undefined, 10)
    expect((queries[1] as { where: unknown[] }).where[1]).toEqual(['$ownerId', '==', ids[2]])
  })

  it('keeps an answer whose bytes do not read (the verifier refuses it), and fails a row without an owner', () => {
    const c = candidateOf({ $ownerId: ids[0], walletEphemeralPubKey: 42, encryptedPayload: '%%%' })
    expect(c.walletEphemeralPubKey.length).toBe(0)
    expect(c.encryptedPayload.length).toBe(0)
    expect(() => candidateOf({ walletEphemeralPubKey: '', encryptedPayload: '' })).toThrow(/no readable owner/)
    expect(() => candidateOf({ $ownerId: 'X', walletEphemeralPubKey: '', encryptedPayload: '' })).toThrow(/no readable owner/)
  })
})

describe('the other reads', () => {
  it('reads remaining budgets, contract keys and the chain clock', async () => {
    const sdk = {
      identities: {
        fetch: async () => ({ publicKeys: [wasmKey({ keyId: 4 }), wasmKey({ keyId: 5, keyTypeNumber: undefined })] }),
        keysRemainingBudgets: async () => new Map<number, bigint | null>([[4, 7n], [5, null]]),
        contractKeys: async () => [
          { identityId: { toBase58: () => 'someone else' }, keys: [wasmKey({ keyId: 1 })] },
          { identityId: { toBase58: () => 'me' }, keys: [wasmKey({ keyId: 2 })] },
        ],
      },
      protocol: { versionUpgradeStateWithProof: async () => ({ metadata: { protocolVersion: 14, timeMs: 1_800_000_000_000n } }) },
    } as unknown as EvoSDK
    const port = appConnectPort(sdk)
    expect((await port.getIdentityFresh('me'))?.publicKeys.map((k) => k.id)).toEqual([4])
    expect(await port.remainingBudgets('me', [4, 5])).toEqual(new Map([[4, 7n], [5, undefined]]))
    expect((await port.contractKeys('me', CONTRACT, 1)).map((k) => k.id)).toEqual([2])
    expect(await port.groupInfo(GROUP)).toBeNull()
    expect(await port.chainClock()).toEqual({ protocolVersion: 14, timeMs: 1_800_000_000_000 })
  })
})
