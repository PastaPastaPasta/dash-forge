/**
 * The write engine's verdict handling, against a scripted SDK (the evo-sdk classes are stubbed:
 * what is tested is which nonce is signed, what counts as landed, and what reaches the ledger).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@dashevo/evo-sdk', () => {
  class Doc {
    id: { toBase58(): string }
    constructor(o: { id?: string }) {
      this.id = { toBase58: () => o.id ?? '' }
    }
    toObject(): Record<string, unknown> {
      return { $id: this.id.toBase58() }
    }
    static generateId(_t: string, _o: string, _c: string, _e: Uint8Array, nonce: bigint): Uint8Array {
      return new Uint8Array(32).fill(Number(nonce % 250n) + 1)
    }
    static fromObject(o: { $id: string }): Doc {
      return new Doc({ id: o.$id })
    }
  }
  class ST {
    nonce = 0n
    setIdentityContractNonce(n: bigint): void {
      this.nonce = n
    }
    sign(): void {}
    toBytes(): Uint8Array {
      return new Uint8Array([Number(this.nonce)])
    }
    static fromBytes(b: Uint8Array): ST {
      const st = new ST()
      st.nonce = BigInt(b[0] ?? 0)
      return st
    }
  }
  return {
    Document: Doc,
    StateTransition: ST,
    DocumentCreateTransition: class {
      constructor(readonly o: { document: Doc }) {}
      toDocumentTransition(): unknown {
        return this
      }
    },
    BatchedTransition: class {
      constructor(readonly t: unknown) {}
    },
    BatchTransition: { fromBatchedTransitions: () => ({ toStateTransition: () => new ST() }) },
    PrivateKey: { fromWIF: () => ({ toBytes: () => new Uint8Array(32) }) },
    TokenPaymentInfo: class {},
    IdentitySigner: class {
      addKeyFromWif(): void {}
      free(): void {}
    },
  }
})

import {
  ConsensusRefusal,
  UnconfirmedWriteError,
  createDocumentIdempotent,
  deleteDocumentIdempotent,
  type SpendEvent,
  type WriteAuth,
} from './write'

const OWNER = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'

interface Script {
  platformNonce: bigint
  broadcast: (st: { nonce: bigint }) => void
  wait: () => Promise<unknown>
  exists: (id: string) => Promise<unknown>
  del?: () => Promise<void>
}

function sdkOf(s: Script, signed: bigint[]): EvoSDK {
  let balance = 1_000_000_000n
  return {
    identities: {
      fetch: async () => ({
        balance,
        publicKeys: [{ keyId: 1, purposeNumber: 0, securityLevelNumber: 2, validatePrivateKey: () => true }],
        getPublicKeyById: () => ({}),
      }),
      contractNonce: async () => s.platformNonce,
    },
    documents: {
      get: async (_c: string, _t: string, id: string) => s.exists(id),
      delete: async () => (s.del ? s.del() : undefined),
    },
    stateTransitions: {
      broadcastStateTransition: async (st: { nonce: bigint }) => {
        signed.push(st.nonce)
        s.broadcast(st)
        balance -= 1000n
      },
      waitForResponse: async () => s.wait(),
    },
    epoch: { current: async () => undefined },
    version: () => 14,
  } as unknown as EvoSDK
}

function auth(spends: SpendEvent[]): WriteAuth {
  return { identityId: OWNER, network: 'devnet', getSigningKeyWif: () => 'cWIF', onSpend: (e) => spends.push(e) }
}

const write = { contractId: 'C', documentType: 'comment', data: { body: 'hi' }, confirmTimeoutMs: 0 }

beforeEach(() => {
  vi.useRealTimers()
})

describe('write engine', () => {
  it('never reuses a nonce when the node answers a block behind', async () => {
    const signed: bigint[] = []
    const script: Script = { platformNonce: 5n, broadcast: () => undefined, wait: async () => ({}), exists: async () => ({}) }
    const sdk = sdkOf(script, signed)
    await createDocumentIdempotent(sdk, auth([]), { ...write, contractId: 'N1' })
    // The node has not seen nonce 6 yet and still answers 5.
    await createDocumentIdempotent(sdk, auth([]), { ...write, contractId: 'N1' })
    expect(signed).toEqual([6n, 7n])
  })

  it('re-signs once with the next nonce when the fresh one was already taken', async () => {
    const signed: bigint[] = []
    let first = true
    const script: Script = {
      platformNonce: 9n,
      broadcast: () => {
        if (first) {
          first = false
          throw new Error('invalid identity nonce: nonce already present')
        }
      },
      wait: async () => ({}),
      exists: async () => ({}),
    }
    await createDocumentIdempotent(sdkOf(script, signed), auth([]), { ...write, contractId: 'N2' })
    expect(signed).toEqual([10n, 11n])
  })

  it('throws UnconfirmedWriteError when the write is never seen, and records nothing', async () => {
    const spends: SpendEvent[] = []
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => {
        throw new Error('timeout')
      },
      exists: async () => undefined,
    }
    await expect(createDocumentIdempotent(sdkOf(script, []), auth(spends), { ...write, contractId: 'N3' })).rejects.toBeInstanceOf(UnconfirmedWriteError)
    expect(spends).toEqual([])
  })

  it('reports the fee of a refused write as refused:<type>', async () => {
    const spends: SpendEvent[] = []
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => {
        throw Object.assign(new Error('duplicate unique properties'), { code: 40105 })
      },
      exists: async () => undefined,
    }
    await expect(createDocumentIdempotent(sdkOf(script, []), auth(spends), { ...write, contractId: 'N4' })).rejects.toBeInstanceOf(ConsensusRefusal)
    await vi.waitFor(() => expect(spends.map((s) => s.kind)).toEqual(['refused:comment']), { timeout: 3000 })
    expect(spends[0]?.balanceBefore).toBe(1_000_000_000n)
  })

  it('does not read an index-only snapshot as landed for a stored document', async () => {
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => {
        throw new Error('received a verified VerifiedDocuments snapshot for this transition family')
      },
      exists: async () => undefined,
    }
    await expect(createDocumentIdempotent(sdkOf(script, []), auth([]), { ...write, contractId: 'N5' })).rejects.toBeInstanceOf(UnconfirmedWriteError)
  })

  it('a lost broadcast answer keeps the signed bytes: the retry rebroadcasts them, never a second document', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    })
    try {
      const signed: bigint[] = []
      let calls = 0
      let landed = false
      const script: Script = {
        platformNonce: 1n,
        broadcast: () => {
          calls += 1
          if (calls === 1) throw new Error('grpc: deadline exceeded')
          landed = true
        },
        wait: async () => ({}),
        exists: async () => (landed ? {} : undefined),
      }
      const sdk = sdkOf(script, signed)
      const params = { ...write, contractId: 'N7', intent: 'post-1' }
      const err = await createDocumentIdempotent(sdk, auth([]), params).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(UnconfirmedWriteError)
      const r = await createDocumentIdempotent(sdk, auth([]), params)
      expect(r.documentId).toBe((err as UnconfirmedWriteError).documentId)
      // The retry rebroadcast the cached bytes (same nonce) instead of signing a new document.
      expect(signed).toEqual([2n, 2n])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a delete whose existence check fails does not report success without broadcasting', async () => {
    let deleted = false
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => ({}),
      exists: async () => {
        throw new Error('transport error')
      },
      del: async () => {
        deleted = true
      },
    }
    const r = await deleteDocumentIdempotent(sdkOf(script, []), auth([]), { contractId: 'N6', documentType: 'writer', documentId: 'X', confirmTimeoutMs: 0 })
    expect(deleted).toBe(true)
    expect(r.deleted).toBe(true)
  })
})
