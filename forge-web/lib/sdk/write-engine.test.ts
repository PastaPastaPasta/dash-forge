/**
 * The write engine's verdict handling, against a scripted SDK (the evo-sdk classes are stubbed:
 * what is tested is which nonce is signed, what counts as landed, and what reaches the ledger).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@dashevo/evo-sdk', () => {
  class Doc {
    id: { toBase58(): string }
    title: unknown
    constructor(o: { id?: string; title?: unknown }) {
      this.id = { toBase58: () => o.id ?? '' }
      this.title = o.title
    }
    toObject(): Record<string, unknown> {
      return { $id: this.id.toBase58() }
    }
    static generateId(_t: string, _o: string, _c: string, entropy: Uint8Array, nonce: bigint): Uint8Array {
      // Like Platform's: the nonce and the entropy (two writes at one nonce get two ids). All of
      // the entropy: one byte of it made two writes at one nonce share an id 1 run in 256.
      const id = Uint8Array.from(entropy)
      id[0] = Number(nonce % 250n) + 1
      return id
    }
    static fromObject(o: { $id: string; title?: unknown }): Doc {
      return new Doc({ id: o.$id, title: o.title })
    }
  }
  /** The title each signed nonce carries (what a broadcast of it would write). */
  const carried = (globalThis as unknown as { __carried: Map<bigint, unknown> }).__carried ?? new Map<bigint, unknown>()
  ;(globalThis as unknown as { __carried: Map<bigint, unknown> }).__carried = carried
  let lastTitle: unknown
  class ST {
    nonce = 0n
    title: unknown = lastTitle
    setIdentityContractNonce(n: bigint): void {
      this.nonce = n
      carried.set(n, this.title)
    }
    sign(): void {}
    toBytes(): Uint8Array {
      return new Uint8Array([Number(this.nonce)])
    }
    static fromBytes(b: Uint8Array): ST {
      // A transition here is one byte. Like wasm-dpp2's loose decoder, bytes after it are ignored;
      // no bytes at all do not decode.
      if (b.length === 0) throw new Error('platform deserialization error: unexpected end of input')
      const st = new ST()
      st.nonce = BigInt(b[0] ?? 0)
      st.title = carried.get(st.nonce)
      return st
    }
  }
  return {
    Document: Doc,
    StateTransition: ST,
    DocumentCreateTransition: class {
      constructor(readonly o: { document: Doc }) {
        lastTitle = o.document.title
      }
      toDocumentTransition(): unknown {
        return this
      }
    },
    BatchedTransition: class {
      constructor(readonly t: unknown) {}
    },
    BatchTransition: { fromBatchedTransitions: () => ({ toStateTransition: () => new ST() }) },
    PrivateKey: { fromWIF: () => ({ toBytes: () => new Uint8Array(32) }) },
    IdentitySigner: class {
      addKeyFromWif(): void {}
      free(): void {}
    },
  }
})

import {
  ConsensusRefusal,
  KeyUnusableError,
  SupersededWriteError,
  UnconfirmedWriteError,
  UNREADABLE_REFUSAL_CODE,
  contentHash,
  WAIT_SETTINGS,
  createDocumentIdempotent,
  deleteDocumentIdempotent,
  isNonceSpent,
  measurementsSettled,
  replaceDocumentIdempotent,
  setWriteClock,
  type SpendEvent,
  type WriteAuth,
} from './write'
import { inSpendScope } from './spend-scope'
import { encodeWif } from '../auth/wif'

const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
/** A well-formed WIF (the signing-key lookup decodes it); the fake key accepts any bytes. */
const TEST_WIF = encodeWif(new Uint8Array(32).fill(7), 'devnet')

interface Script {
  platformNonce: bigint
  broadcast: (st: { nonce: bigint; title?: unknown }) => void
  wait: (settings?: unknown) => Promise<unknown>
  /** The affected-state wait (an indexOnly write's); defaults to refusing, so a test sees which wait ran. */
  affected?: (settings?: unknown) => Promise<unknown>
  exists: (id: string) => Promise<unknown>
  del?: () => Promise<void>
  replace?: () => Promise<void>
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
      replace: async () => (s.replace ? s.replace() : undefined),
    },
    stateTransitions: {
      broadcastStateTransition: async (st: { nonce: bigint; title?: unknown }) => {
        signed.push(st.nonce)
        s.broadcast(st)
        balance -= 1000n
      },
      waitForResponse: async (_st: unknown, settings?: unknown) => s.wait(settings),
      waitForAffectedState: async (_st: unknown, settings?: unknown) => {
        if (!s.affected) throw new Error('the affected-state wait is only for an indexOnly write')
        return s.affected(settings)
      },
    },
    epoch: { current: async () => undefined },
    version: () => 14,
  } as unknown as EvoSDK
}

function auth(spends: SpendEvent[]): WriteAuth {
  return { identityId: OWNER, network: 'devnet', getSigningKeyWif: () => TEST_WIF, onSpend: (e) => spends.push(e) }
}

const write = { contractId: 'C', documentType: 'comment', data: { body: 'hi' }, confirmTimeoutMs: 0 }

/**
 * The SDK's two refusal shapes (wasm-sdk 4.2.0-beta.6 on, platform#5112): a refusal at the
 * broadcast check is kind Protocol with the node's code (-1 for an error the SDK could not
 * decode); a block's verdict from the result wait is kind StateTransitionBroadcastError.
 */
const sdkRefusal = (text: string, code = -1) => ({ name: 'Protocol', kind: 3, code, message: `Failed to broadcast: Protocol error: ${text}` })
const sdkVerdict = (text: string, code: number) => ({ name: 'StateTransitionBroadcastError', kind: 22, code, message: `state transition broadcast error: ${text}` })
const GATE_TEXT = 'referenced document Xyz not found for path repoId'
const UNREADABLE_TEXT = 'platform deserialization error: unable to deserialize ConsensusError: UnexpectedEnd { additional: 18 }'

/** A stored document as `documents.get` returns it, owned by OWNER, for a replace to read. */
const storedDoc = (title: string, revision = 1n) => ({
  revision,
  ownerId: { toBase58: () => OWNER },
  toObject: () => ({ $id: 'D', title }),
  toJSON: () => ({ $id: 'D', title }),
})

/**
 * The engine's polls (the landed / gone checks, the balance read after a write) run on a
 * virtual clock: each sleep moves it on at once, so a poll spends its whole budget, as it would
 * against a chain that never shows the write, in no wall time and whatever the runner's load.
 */
beforeEach(() => {
  let now = 0
  setWriteClock({
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  })
})
afterEach(async () => {
  // A spend report still reading runs out on the virtual clock first: the next test's first write
  // waits for it (the identity's next write waits for the last one's measurement).
  await new Promise((r) => setTimeout(r, 0))
  setWriteClock(null)
})

/**
 * Let the spend report finish (it runs after the write resolves). Its balance reads and sleeps
 * are all promise jobs on the virtual clock, so one macrotask turn runs them to the end. (A real
 * timer: under vi.useFakeTimers this would never fire.)
 */
const reported = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

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
    await reported()
    expect(spends).toEqual([])
  })

  it('reports the fee of a refused write as refused:<type>', async () => {
    const spends: SpendEvent[] = []
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => {
        throw sdkVerdict('Document X has duplicate unique properties ["repoId", "number"] with other documents', 40105)
      },
      exists: async () => undefined,
    }
    await expect(createDocumentIdempotent(sdkOf(script, []), auth(spends), { ...write, contractId: 'N4' })).rejects.toBeInstanceOf(ConsensusRefusal)
    await reported()
    expect(spends.map((s) => s.kind)).toEqual(['refused:comment'])
    expect(spends[0]?.balanceBefore).toBe(1_000_000_000n)
  })

  it('an indexOnly create (star) waits with the affected-state wait and lands on its proof', async () => {
    let strict = 0
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => {
        strict += 1
        throw new Error('received a verified VerifiedDocuments snapshot for this transition family')
      },
      affected: async () => ({}),
      exists: async () => undefined,
    }
    const r = await createDocumentIdempotent(sdkOf(script, []), auth([]), { ...write, contractId: 'I1', documentType: 'star', probe: async () => true })
    expect(r.confirmed).toBe(true)
    expect(strict).toBe(0)
  })

  it('an indexOnly create refused in a block is a charged refusal, not a landing', async () => {
    const spends: SpendEvent[] = []
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => ({}),
      affected: async () => {
        throw sdkVerdict(GATE_TEXT, 40120)
      },
      exists: async () => undefined,
    }
    const err = await createDocumentIdempotent(sdkOf(script, []), auth(spends), { ...write, contractId: 'I2', documentType: 'star', probe: async () => false }).catch((e: unknown) => e)
    expect((err as ConsensusRefusal).code).toBe(40120)
    expect((err as ConsensusRefusal).feeCharged).toBe(true)
    await reported()
    expect(spends.map((s) => s.kind)).toEqual(['refused:star'])
  })

  it('an indexOnly delete (unstar) resolves on the SDK delete, with no snapshot to read', async () => {
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => ({}),
      exists: async () => ({}),
      del: async () => undefined,
    }
    const r = await deleteDocumentIdempotent(sdkOf(script, []), auth([]), {
      contractId: 'I3', documentType: 'star', documentId: 'S', document: { values: 'the star' }, probeGone: async () => false, confirmTimeoutMs: 0,
    })
    expect(r.deleted).toBe(true)
  })

  it('a replace whose refusal the SDK cannot decode has an unknown charge, never "nothing was charged"', async () => {
    const spends: SpendEvent[] = []
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => ({}),
      exists: async () => storedDoc('old'),
      replace: async () => {
        throw sdkRefusal(UNREADABLE_TEXT)
      },
    }
    const err = await replaceDocumentIdempotent(sdkOf(script, []), auth(spends), {
      contractId: 'I5', documentType: 'issue', documentId: 'D', changes: { title: 'new' }, confirmTimeoutMs: 0,
    }).catch((e: unknown) => e)
    expect((err as ConsensusRefusal).code).toBe(UNREADABLE_REFUSAL_CODE)
    expect((err as ConsensusRefusal).charged).toBeNull()
    expect((err as ConsensusRefusal).feeCharged).toBeNull()
  })

  it('a stored document never uses the affected-state wait', async () => {
    let affected = 0
    let strict = 0
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => {
        strict += 1
        return {}
      },
      affected: async () => {
        affected += 1
        return {}
      },
      exists: async () => ({}),
    }
    const r = await createDocumentIdempotent(sdkOf(script, []), auth([]), { ...write, contractId: 'I4' })
    expect(r.confirmed).toBe(true)
    expect(strict).toBe(1)
    expect(affected).toBe(0)
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

  /**
   * The moutai hang, in the browser: another writer (the CLI, another browser) signed with the
   * same nonce and won the block, and Tenderdash dropped this transition from its mempool, so
   * its result never comes and every re-broadcast only hears "tx already exists in cache".
   * After one bounded wait the engine sees the nonce is spent and the document absent, and
   * signs the action once more with the next nonce: it lands, and nothing waits for minutes.
   */
  it('a transition dropped after a same-nonce race is re-signed, not waited on', async () => {
    const signed: bigint[] = []
    const waits: unknown[] = []
    const landedIds = new Set<string>()
    let nonceOnChain = 1n
    const script: Script = {
      platformNonce: 1n,
      broadcast: (st) => {
        if (st.nonce === 2n && signed.filter((n) => n === 2n).length > 1) {
          throw new Error('tx already exists in cache')
        }
        if (st.nonce === 3n) landedIds.add('ours-3')
      },
      wait: async (settings) => {
        waits.push(settings)
        // Our nonce-2 transition: the other writer takes nonce 2 meanwhile; ours is dropped.
        if (signed[signed.length - 1] === 2n) {
          nonceOnChain = 2n
          throw new Error('Timeout expired')
        }
        nonceOnChain = 3n
        return {}
      },
      exists: async () => undefined,
    }
    const sdk = sdkOf(script, signed)
    ;(sdk as unknown as { identities: { contractNonce: () => Promise<bigint> } }).identities.contractNonce = async () =>
      nonceOnChain
    const r = await createDocumentIdempotent(sdk, auth([]), { ...write, contractId: 'N8' })
    expect(r.confirmed).toBe(true)
    // Nonce 2 once (dropped, never re-broadcast into the cache), then 3, which landed.
    expect(signed).toEqual([2n, 3n])
    // Every wait was the bounded one, with no wasm-side overall timeout (see WaitSettings).
    expect(waits.every((w) => w === WAIT_SETTINGS)).toBe(true)
    expect(Object.keys(WAIT_SETTINGS)).not.toContain('waitTimeoutMs')
  })

  it('a delete answered "already exists" is proven by the gone-poll, not assumed', async () => {
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => ({}),
      exists: async () => ({}), // still there
      del: async () => {
        throw new Error('tx already exists in cache')
      },
    }
    await expect(
      deleteDocumentIdempotent(sdkOf(script, []), auth([]), {
        contractId: 'N10',
        documentType: 'writer',
        documentId: 'X',
        confirmTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(UnconfirmedWriteError)
  })

  it('a silent wait whose nonce is still free re-broadcasts the same bytes and waits again', async () => {
    const signed: bigint[] = []
    let waited = 0
    const script: Script = {
      platformNonce: 4n,
      broadcast: () => undefined,
      wait: async () => {
        waited += 1
        if (waited === 1) throw new Error('Timeout expired') // a slow block
        return {}
      },
      exists: async () => undefined,
    }
    const r = await createDocumentIdempotent(sdkOf(script, signed), auth([]), { ...write, contractId: 'N9' })
    expect(r.confirmed).toBe(true)
    expect(signed).toEqual([5n, 5n])
  })
})

/** A localStorage for the pending-transition cache. */
function withStorage(): () => void {
  const store = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })
  return () => vi.unstubAllGlobals()
}

const BUDGET_TEXT = `Identity ${OWNER} public key 5 has 90000000 credits of budget left, the state transition requires 100224000`

describe('refusals at broadcast (D-007)', () => {
  it('a key-budget refusal rejects as a ConsensusRefusal, is never "sent", and charges nothing', async () => {
    const restore = withStorage()
    try {
      const spends: SpendEvent[] = []
      const script: Script = {
        platformNonce: 1n,
        broadcast: () => {
          throw sdkRefusal(BUDGET_TEXT, 40218)
        },
        wait: async () => ({}),
        exists: async () => undefined,
      }
      const err = await createDocumentIdempotent(sdkOf(script, []), auth(spends), { ...write, contractId: 'R1', intent: 'i' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ConsensusRefusal)
      expect(err).not.toBeInstanceOf(UnconfirmedWriteError)
      expect((err as ConsensusRefusal).code).toBe(40218)
      expect((err as ConsensusRefusal).figures.required).toBe(100_224_000n)
      await reported()
      expect(spends).toEqual([])
    } finally {
      restore()
    }
  })

  it('a balance refusal likewise, and a retry signs afresh (nothing stays cached)', async () => {
    const restore = withStorage()
    try {
      const signed: bigint[] = []
      let refuse = true
      const script: Script = {
        platformNonce: 1n,
        broadcast: () => {
          if (refuse) throw sdkRefusal(`Insufficient identity ${OWNER} balance 111153640 required 137618340`, 40210)
        },
        wait: async () => ({}),
        exists: async () => ({}),
      }
      const sdk = sdkOf(script, signed)
      const params = { ...write, contractId: 'R2', intent: 'i' }
      const err = await createDocumentIdempotent(sdk, auth([]), params).catch((e: unknown) => e)
      expect((err as ConsensusRefusal).isBalance).toBe(true)
      refuse = false
      // After a top-up the same action is signed again. Refused at the broadcast check, the
      // first transition never consumed its nonce, so the new one takes the same nonce.
      await createDocumentIdempotent(sdk, auth([]), params)
      expect(signed).toEqual([2n, 2n])
    } finally {
      restore()
    }
  })

  it('a refusal in a block is charged and recorded; a key-limit one in a block is not', async () => {
    const spends: SpendEvent[] = []
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => {
        throw sdkVerdict(BUDGET_TEXT, 40218)
      },
      exists: async () => undefined,
    }
    await expect(createDocumentIdempotent(sdkOf(script, []), auth(spends), { ...write, contractId: 'R3' })).rejects.toBeInstanceOf(ConsensusRefusal)
    await reported()
    expect(spends).toEqual([])
  })
})

describe('replace and delete refusals carry the charge the SDK says (wasm-sdk 4.2.0-beta.6)', () => {
  const MAX_BYTES = 'Property title is 2000 bytes in UTF-8, over its maxBytes of 1024'

  it('a replace refused at the broadcast check (Protocol, coded) charged nothing and records nothing', async () => {
    const spends: SpendEvent[] = []
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => ({}),
      exists: async () => storedDoc('old'),
      replace: async () => {
        throw sdkRefusal(MAX_BYTES, 10421)
      },
    }
    const err = await replaceDocumentIdempotent(sdkOf(script, []), auth(spends), {
      contractId: 'P1', documentType: 'issue', documentId: 'D', changes: { title: 'x'.repeat(2000) }, confirmTimeoutMs: 0,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConsensusRefusal)
    expect((err as ConsensusRefusal).code).toBe(10421)
    expect((err as ConsensusRefusal).feeCharged).toBe(false)
    await reported()
    expect(spends).toEqual([])
  })

  it("a replace refused in a block (the wait's verdict) is charged and recorded", async () => {
    const spends: SpendEvent[] = []
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => ({}),
      exists: async () => storedDoc('old'),
      replace: async () => {
        throw sdkVerdict(GATE_TEXT, 40120)
      },
    }
    const err = await replaceDocumentIdempotent(sdkOf(script, []), auth(spends), {
      contractId: 'P2', documentType: 'issue', documentId: 'D', changes: { title: 'new' }, confirmTimeoutMs: 0,
    }).catch((e: unknown) => e)
    expect((err as ConsensusRefusal).code).toBe(40120)
    expect((err as ConsensusRefusal).feeCharged).toBe(true)
    await reported()
    expect(spends.map((s) => s.kind)).toEqual(['refused:issue'])
  })

  it('a delete refused at the broadcast check charged nothing; one refused in a block did', async () => {
    for (const [thrown, charged] of [
      [sdkRefusal(GATE_TEXT, 40120), false],
      [sdkVerdict(GATE_TEXT, 40120), true],
    ] as const) {
      const spends: SpendEvent[] = []
      const script: Script = {
        platformNonce: 1n,
        broadcast: () => undefined,
        wait: async () => ({}),
        exists: async () => ({}),
        del: async () => {
          throw thrown
        },
      }
      const err = await deleteDocumentIdempotent(sdkOf(script, []), auth(spends), { contractId: 'P3', documentType: 'writer', documentId: 'X', confirmTimeoutMs: 0 }).catch((e: unknown) => e)
      expect((err as ConsensusRefusal).feeCharged).toBe(charged)
      await reported()
      expect(spends.map((s) => s.kind)).toEqual(charged ? ['refused:writer'] : [])
    }
  })

  it('a refusal of another kind has an unknown charge, and says nothing was charged only when known', async () => {
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => ({}),
      exists: async () => ({}),
      del: async () => {
        throw { name: 'Generic', kind: 18, code: 40120, message: GATE_TEXT }
      },
    }
    const err = await deleteDocumentIdempotent(sdkOf(script, []), auth([]), { contractId: 'P4', documentType: 'writer', documentId: 'X', confirmTimeoutMs: 0 }).catch((e: unknown) => e)
    expect((err as ConsensusRefusal).charged).toBeNull()
    expect((err as ConsensusRefusal).feeCharged).toBeNull()
  })

  it('an undecodable verdict from the result wait has an unknown charge', async () => {
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => {
        throw sdkRefusal(UNREADABLE_TEXT)
      },
      exists: async () => undefined,
    }
    const err = await createDocumentIdempotent(sdkOf(script, []), auth([]), { ...write, contractId: 'P5' }).catch((e: unknown) => e)
    expect((err as ConsensusRefusal).code).toBe(UNREADABLE_REFUSAL_CODE)
    expect((err as ConsensusRefusal).charged).toBeNull()
  })
})

describe('a stale document id (10405) is re-prepared, then thrown as is', () => {
  const STALE = 'Invalid document transition id 9x, expected 8y'

  it('a coded 10405 on the first attempt re-prepares the write and lands', async () => {
    const signed: bigint[] = []
    let calls = 0
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => {
        calls += 1
        if (calls === 1) throw sdkRefusal(STALE, 10405)
      },
      wait: async () => ({}),
      exists: async () => ({}),
    }
    const r = await createDocumentIdempotent(sdkOf(script, signed), auth([]), { ...write, contractId: 'S1' })
    expect(r.confirmed).toBe(true)
    expect(signed).toEqual([2n, 2n])
  })

  it('a coded refusal whose figures contain "10405" is a refusal, not a stale id', async () => {
    const restore = withStorage()
    try {
      const signed: bigint[] = []
      const script: Script = {
        platformNonce: 1n,
        broadcast: () => {
          throw sdkRefusal(`Insufficient identity ${OWNER} balance 1 required 104050000`, 40210)
        },
        wait: async () => ({}),
        exists: async () => undefined,
      }
      const err = await createDocumentIdempotent(sdkOf(script, signed), auth([]), { ...write, contractId: 'S3', intent: 'i' }).catch((e: unknown) => e)
      expect((err as ConsensusRefusal).code).toBe(40210)
      expect((err as ConsensusRefusal).isBalance).toBe(true)
      // Refused once, never re-prepared as a stale id
      expect(signed).toEqual([2n])
    } finally {
      restore()
    }
  })

  it('a coded 10405 again on the second attempt is the stale-id error, not a plain refusal', async () => {
    const restore = withStorage()
    try {
      const spends: SpendEvent[] = []
      const script: Script = {
        platformNonce: 1n,
        broadcast: () => {
          throw sdkRefusal(STALE, 10405)
        },
        wait: async () => ({}),
        exists: async () => undefined,
      }
      const err = await createDocumentIdempotent(sdkOf(script, []), auth(spends), { ...write, contractId: 'S2', intent: 'i' }).catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(ConsensusRefusal)
      expect((err as { code: number }).code).toBe(10405)
      await reported()
      expect(spends).toEqual([])
    } finally {
      restore()
    }
  })
})

describe('retry after an edit (D-008)', () => {
  let contract = 0
  let current = 'E0'
  const issue = (title: string) => ({ contractId: current, documentType: 'issue', data: { title }, confirmTimeoutMs: 0, intent: 'draft-1' })
  beforeEach(() => {
    current = `E${++contract}`
  })

  it('the edited content lands, never the cached bytes of the old content', async () => {
    const restore = withStorage()
    try {
      const signed: bigint[] = []
      const broadcastTitles: unknown[] = []
      const onChain = new Map<string, unknown>()
      let lose = true
      const script: Script = {
        platformNonce: 1n,
        broadcast: (st) => {
          broadcastTitles.push(st.title)
          // The first attempt's answer is lost (a timeout): it may or may not have landed.
          if (lose) {
            lose = false
            throw new Error('grpc: deadline exceeded')
          }
          onChain.set(`n${st.nonce}`, st.title)
        },
        wait: async () => ({}),
        exists: async () => (onChain.size > 0 ? {} : undefined),
      }
      const sdk = sdkOf(script, signed)
      const first = await createDocumentIdempotent(sdk, auth([]), issue('RETRY-TITLE-A')).catch((e: unknown) => e)
      expect(first).toBeInstanceOf(UnconfirmedWriteError)
      // The user edits the title and submits the same draft again.
      const r = await createDocumentIdempotent(sdk, auth([]), issue('RETRY-TITLE-B'))
      expect(r.confirmed).toBe(true)
      expect([...onChain.values()]).toEqual(['RETRY-TITLE-B'])
      expect(broadcastTitles).toEqual(['RETRY-TITLE-A', 'RETRY-TITLE-B'])
      // Re-signed with the first attempt's nonce: at most one of the two could ever land.
      expect(signed).toEqual([2n, 2n])
    } finally {
      restore()
    }
  })

  it('an unchanged retry still rebroadcasts the same bytes (no second document)', async () => {
    const restore = withStorage()
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
      await createDocumentIdempotent(sdk, auth([]), issue('same')).catch(() => undefined)
      await createDocumentIdempotent(sdk, auth([]), issue('same'))
      expect(signed).toEqual([2n, 2n])
    } finally {
      restore()
    }
  })

  it('when the old attempt landed after all, the edit is not posted as a second document', async () => {
    const restore = withStorage()
    try {
      let calls = 0
      const script: Script = {
        platformNonce: 1n,
        broadcast: () => {
          calls += 1
          if (calls === 1) throw new Error('grpc: deadline exceeded')
        },
        wait: async () => ({}),
        // Unseen at first; then the old attempt shows up.
        exists: async () => (calls >= 1 ? {} : undefined),
      }
      const sdk = sdkOf(script, [])
      let seen = false
      ;(sdk as unknown as { documents: { get: () => Promise<unknown> } }).documents.get = async () => {
        const r = seen ? {} : undefined
        seen = true
        return r
      }
      await createDocumentIdempotent(sdk, auth([]), issue('OLD')).catch(() => undefined)
      await expect(createDocumentIdempotent(sdk, auth([]), issue('NEW'))).rejects.toBeInstanceOf(SupersededWriteError)
      expect(calls).toBe(1)
    } finally {
      restore()
    }
  })

  it('contentHash tells content apart and is stable across key order', () => {
    expect(contentHash('issue', { title: 'A', body: 'x' })).toBe(contentHash('issue', { body: 'x', title: 'A' }))
    expect(contentHash('issue', { title: 'A' })).not.toBe(contentHash('issue', { title: 'B' }))
    expect(contentHash('issue', { repoId: new Uint8Array([1]) })).not.toBe(contentHash('issue', { repoId: new Uint8Array([2]) }))
  })
})

/** Drive's real text for a nonce already taken, as the SDK throws it at broadcast. */
const NONCE_TEXT = `Identity ${OWNER} is trying to set an invalid identity nonce. The current identity nonce is 2, we are setting 2, error is nonce already present at tip`

describe('a nonce refusal is never a "refused, try again" (review C1)', () => {
  it('a cached rebroadcast answered with the real nonce text is settled by reading the chain', async () => {
    const restore = withStorage()
    try {
      const signed: bigint[] = []
      let calls = 0
      let visible = false
      const script: Script = {
        platformNonce: 1n,
        broadcast: () => {
          calls += 1
          // First attempt: the answer is lost, though it lands (read a moment later).
          if (calls === 1) throw new Error('grpc: deadline exceeded')
          // The retry's rebroadcast of the same bytes: Drive says the nonce is taken (by itself).
          throw sdkRefusal(NONCE_TEXT, 40204)
        },
        wait: async () => ({}),
        exists: async () => {
          const r = visible ? {} : undefined
          visible = calls >= 2
          return r
        },
      }
      const sdk = sdkOf(script, signed)
      const params = { ...write, contractId: 'C1', intent: 'i', confirmTimeoutMs: 3000 }
      await createDocumentIdempotent(sdk, auth([]), params).catch(() => undefined)
      const r = await createDocumentIdempotent(sdk, auth([]), params)
      expect(r.confirmed).toBe(true)
      // One transition, sent twice; never a second document.
      expect(signed).toEqual([2n, 2n])
    } finally {
      restore()
    }
  })

  it('in settleUnanswered, a rebroadcast answered with the nonce text is not thrown as a refusal', async () => {
    const signed: bigint[] = []
    let nonceOnChain = 1n
    let waits = 0
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => {
        if (signed.length > 1) throw sdkRefusal(NONCE_TEXT, 40204)
      },
      wait: async () => {
        waits += 1
        if (waits === 1) {
          nonceOnChain = 1n
          throw new Error('Timeout expired')
        }
        nonceOnChain = 2n
        throw new Error('Timeout expired')
      },
      exists: async () => (nonceOnChain === 2n ? {} : undefined),
    }
    const sdk = sdkOf(script, signed)
    ;(sdk as unknown as { identities: { contractNonce: () => Promise<bigint> } }).identities.contractNonce = async () => nonceOnChain
    const r = await createDocumentIdempotent(sdk, auth([]), { ...write, contractId: 'C1b', confirmTimeoutMs: 3000 })
    expect(r.confirmed).toBe(true)
  })
})

describe('a superseded attempt is remembered until settled (review C2)', () => {
  it('A times out, the user edits, B times out, A lands: the retry never posts B beside A', async () => {
    const restore = withStorage()
    try {
      const signed: { nonce: bigint; title: unknown }[] = []
      const onChain = new Map<bigint, unknown>()
      let nonceOnChain = 1n
      let phase: 'A' | 'B' | 'retry' = 'A'
      let aId = ''
      const script: Script = {
        platformNonce: 1n,
        broadcast: (st) => {
          signed.push({ nonce: st.nonce, title: st.title })
          if (phase !== 'retry') throw new Error('grpc: deadline exceeded')
        },
        wait: async () => ({}),
        exists: async (id: string) => (onChain.has(2n) && id === aId ? {} : undefined),
      }
      const sdk = sdkOf(script, [])
      ;(sdk as unknown as { identities: { contractNonce: () => Promise<bigint> } }).identities.contractNonce = async () => nonceOnChain
      const issue = (title: string) => ({ contractId: 'C2', documentType: 'issue', data: { title }, confirmTimeoutMs: 0, intent: 'draft-c2' })
      const a = await createDocumentIdempotent(sdk, auth([]), issue('A')).catch((e: unknown) => e)
      aId = (a as UnconfirmedWriteError).documentId
      phase = 'B'
      await createDocumentIdempotent(sdk, auth([]), issue('B')).catch(() => undefined)
      // A lands after all: its nonce (2) is taken and its document is there.
      onChain.set(2n, 'A')
      nonceOnChain = 2n
      phase = 'retry'
      const err = await createDocumentIdempotent(sdk, auth([]), issue('B')).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SupersededWriteError)
      // A and B were both signed with nonce 2, so at most one can land (the retry re-sends B's
      // cached bytes, which the taken nonce refuses); nothing was ever signed at nonce 3.
      expect(signed.every((s) => s.nonce === 2n)).toBe(true)
      expect(signed.map((s) => s.title)).toEqual(['A', 'B', 'B'])
    } finally {
      restore()
    }
  })
})

describe('after "your earlier attempt was posted" (review N1, N4)', () => {
  it('a second retry with the same intent is answered at once and signs nothing', async () => {
    const restore = withStorage()
    try {
      const signed: bigint[] = []
      let aId = ''
      let aLanded = false
      const script: Script = {
        platformNonce: 1n,
        broadcast: () => {
          throw new Error('grpc: deadline exceeded')
        },
        wait: async () => ({}),
        exists: async (id: string) => (aLanded && id === aId ? {} : undefined),
      }
      const sdk = sdkOf(script, signed)
      let nonceOnChain = 1n
      ;(sdk as unknown as { identities: { contractNonce: () => Promise<bigint> } }).identities.contractNonce = async () => nonceOnChain
      const issue = (title: string) => ({ contractId: 'N1', documentType: 'issue', data: { title }, confirmTimeoutMs: 0, intent: 'draft-n1' })
      const a = await createDocumentIdempotent(sdk, auth([]), issue('A')).catch((e: unknown) => e)
      aId = (a as UnconfirmedWriteError).documentId
      aLanded = true
      nonceOnChain = 2n
      await expect(createDocumentIdempotent(sdk, auth([]), issue('B'))).rejects.toBeInstanceOf(SupersededWriteError)
      const before = signed.length
      // The composer kept the draft (a dialog whose intent lives on): the same click again.
      await expect(createDocumentIdempotent(sdk, auth([]), issue('B'))).rejects.toBeInstanceOf(SupersededWriteError)
      expect(signed.length).toBe(before)
    } finally {
      restore()
    }
  })

  it('an edited retry refused for a disabled key is not replayed once the key is renewed', async () => {
    const restore = withStorage()
    try {
      const signed: { nonce: bigint; title: unknown }[] = []
      let phase: 'A' | 'B' | 'renewed' = 'A'
      const script: Script = {
        platformNonce: 1n,
        broadcast: (st) => {
          signed.push({ nonce: st.nonce, title: st.title })
          if (phase === 'A') throw new Error('grpc: deadline exceeded')
          if (phase === 'B') throw sdkRefusal('Identity key 5 is disabled', 20006)
        },
        wait: async () => ({}),
        exists: async () => undefined,
      }
      const sdk = sdkOf(script, [])
      let nonceOnChain = 1n
      ;(sdk as unknown as { identities: { contractNonce: () => Promise<bigint> } }).identities.contractNonce = async () => nonceOnChain
      const issue = (title: string) => ({ contractId: 'N4', documentType: 'issue', data: { title }, confirmTimeoutMs: 0, intent: 'draft-n4' })
      await createDocumentIdempotent(sdk, auth([]), issue('A')).catch(() => undefined)
      phase = 'B'
      await expect(createDocumentIdempotent(sdk, auth([]), issue('B'))).rejects.toBeInstanceOf(ConsensusRefusal)
      // Another write took the nonce meanwhile (A never landed); the key is renewed.
      nonceOnChain = 2n
      phase = 'renewed'
      const r = await createDocumentIdempotent(sdk, auth([]), issue('B'))
      expect(r.confirmed).toBe(true)
      // Signed afresh past every nonce used so far: the refused bytes (nonce 2) were not replayed.
      const last = signed[signed.length - 1]!
      expect(last.title).toBe('B')
      expect(last.nonce > 2n).toBe(true)
    } finally {
      restore()
    }
  })

  it('a refusal from the result wait is a block verdict: its fee goes to the ledger (N3)', async () => {
    const spends: SpendEvent[] = []
    const script: Script = {
      platformNonce: 1n,
      broadcast: () => undefined,
      wait: async () => {
        throw sdkVerdict(GATE_TEXT, 40120)
      },
      exists: async () => undefined,
    }
    await expect(createDocumentIdempotent(sdkOf(script, []), auth(spends), { ...write, contractId: 'N3' })).rejects.toBeInstanceOf(ConsensusRefusal)
    await reported()
    expect(spends.map((s) => s.kind)).toEqual(['refused:comment'])
  })
})

describe('a damaged cached transition, and 10002 (protocol 14)', () => {
  /**
   * A write whose first answer is lost, so its signed bytes stay cached under the intent. The
   * chain is tracked per document: a broadcast lands the document last saved for its nonce
   * (unless `onRebroadcast` throws), so a test sees exactly which documents are on Platform.
   */
  const lostAttempt = (store: Map<string, string>, onRebroadcast: () => void = () => undefined) => {
    let calls = 0
    const onChain = new Set<string>()
    const signed: bigint[] = []
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    })
    /** The document the cache last recorded for `nonce` (saved just before each broadcast). */
    const savedFor = (nonce: bigint): string | undefined => {
      for (const raw of store.values()) {
        const e = JSON.parse(raw) as { documentId?: string; nonce?: string }
        if (e.documentId && e.nonce === nonce.toString()) return e.documentId
      }
      return undefined
    }
    const script: Script = {
      platformNonce: 1n,
      broadcast: (st) => {
        calls += 1
        if (calls === 1) throw new Error('grpc: deadline exceeded')
        if (calls === 2) onRebroadcast()
        const id = savedFor(st.nonce)
        if (id) onChain.add(id)
      },
      wait: async () => ({}),
      exists: async (id: string) => (onChain.has(id) ? {} : undefined),
    }
    const cachedEntry = (): { key: string; entry: { data: string; documentId: string } } => {
      const [key, raw] = [...store.entries()][0]!
      return { key, entry: JSON.parse(raw) as { data: string; documentId: string } }
    }
    return { sdk: sdkOf(script, signed), signed, onChain, cachedEntry }
  }

  it('padded cached bytes (the SDK would decode them) are never broadcast: re-signed on the same nonce, one document', async () => {
    const store = new Map<string, string>()
    const { sdk, signed, onChain, cachedEntry } = lostAttempt(store)
    try {
      const params = { ...write, contractId: 'T1', intent: 'pad-1' }
      const first = await createDocumentIdempotent(sdk, auth([]), params).catch((e: unknown) => e)
      expect(first).toBeInstanceOf(UnconfirmedWriteError)
      const { key, entry } = cachedEntry()
      // A byte left over after the transition: the loose decoder reads it; the round-trip does not.
      store.set(key, JSON.stringify({ ...entry, data: btoa(atob(entry.data) + '\xab') }))
      const r = await createDocumentIdempotent(sdk, auth([]), params)
      expect(r.confirmed).toBe(true)
      // A fresh transition (a new id), pinned to the lost attempt's still-free nonce.
      expect(r.documentId).not.toBe((first as UnconfirmedWriteError).documentId)
      expect(signed).toEqual([2n, 2n])
      expect([...onChain]).toEqual([r.documentId])
      expect(store.has(key)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('an entry with corrupt base64 still settles the attempt it recorded: when that landed, nothing is re-signed', async () => {
    const store = new Map<string, string>()
    const { sdk, signed, onChain, cachedEntry } = lostAttempt(store)
    try {
      const params = { ...write, contractId: 'T3', intent: 'b64-1' }
      await createDocumentIdempotent(sdk, auth([]), params).catch(() => undefined)
      const { key, entry } = cachedEntry()
      store.set(key, JSON.stringify({ ...entry, data: '%%not base64%%' }))
      // The original attempt was sent intact and lands after all; its nonce is now spent.
      onChain.add(entry.documentId)
      ;(sdk as unknown as { identities: { contractNonce: () => Promise<bigint> } }).identities.contractNonce = async () => 2n
      const err = await createDocumentIdempotent(sdk, auth([]), params).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SupersededWriteError)
      expect((err as SupersededWriteError).documentId).toBe(entry.documentId)
      // Nothing was signed after the first attempt: never a second document.
      expect(signed).toEqual([2n])
      expect([...onChain]).toEqual([entry.documentId])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a rebroadcast Drive refuses as 10002 is discarded, not replayed, and the retry signs afresh', async () => {
    const store = new Map<string, string>()
    const { sdk, signed } = lostAttempt(store, () => {
      throw sdkRefusal('Parsing of serialized object failed due to: unable to deserialize dpp::state_transition::StateTransition: 1 bytes left over after the value', 10002)
    })
    try {
      const params = { ...write, contractId: 'T2', intent: 'pad-2' }
      await createDocumentIdempotent(sdk, auth([]), params).catch(() => undefined)
      const err = await createDocumentIdempotent(sdk, auth([]), params).catch((e: unknown) => e)
      expect((err as ConsensusRefusal).code).toBe(10002)
      expect((err as ConsensusRefusal).unpaid).toBe(true)
      expect(store.size).toBe(0)
      await createDocumentIdempotent(sdk, auth([]), params)
      expect(signed).toEqual([2n, 2n, 3n])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a refusal whose reason the SDK cannot decode (a newer error variant) is discarded, never left pending', async () => {
    const store = new Map<string, string>()
    const { sdk, signed } = lostAttempt(store, () => {
      throw sdkRefusal(UNREADABLE_TEXT)
    })
    try {
      const params = { ...write, contractId: 'T3', intent: 'undecodable' }
      await createDocumentIdempotent(sdk, auth([]), params).catch(() => undefined)
      const err = await createDocumentIdempotent(sdk, auth([]), params).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ConsensusRefusal)
      expect(err).not.toBeInstanceOf(UnconfirmedWriteError)
      expect((err as ConsensusRefusal).code).toBe(UNREADABLE_REFUSAL_CODE)
      expect((err as ConsensusRefusal).feeCharged).toBe(false)
      expect(store.size).toBe(0)
      await createDocumentIdempotent(sdk, auth([]), params)
      // The refused bytes are never re-sent: the retry signs a new transition, one nonce on
      expect(signed).toHaveLength(3)
      expect(signed[2]).toBe(signed[1]! + 1n)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('an unusable key (D-042)', () => {
  it('an expired key throws KeyUnusableError("expired"), not a raw "no usable AUTHENTICATION key"', async () => {
    const script: Script = { platformNonce: 1n, broadcast: () => undefined, wait: async () => ({}), exists: async () => ({}) }
    const sdk = sdkOf(script, [])
    ;(sdk as unknown as { identities: { fetch: () => Promise<unknown> } }).identities.fetch = async () => ({
      balance: 10n ** 11n,
      publicKeys: [{ keyId: 5, purposeNumber: 0, securityLevelNumber: 2, expiresAt: BigInt(Date.now() - 1000), validatePrivateKey: () => true }],
      getPublicKeyById: () => ({}),
    })
    const err = await createDocumentIdempotent(sdk, auth([]), { ...write, contractId: 'K1' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KeyUnusableError)
    expect((err as KeyUnusableError).reason).toBe('expired')
  })
})

describe('isNonceSpent (Drive validate_identity_nonce_update)', () => {
  const skipped = (behind: bigint) => 1n << (behind - 1n + 40n)
  it('is free above the tip and spent at it', () => {
    expect(isNonceSpent(10n, 11n)).toBe(false)
    expect(isNonceSpent(10n, 40n)).toBe(false)
    expect(isNonceSpent(10n, 10n)).toBe(true)
  })
  it('is spent below the tip unless it is a skipped one', () => {
    expect(isNonceSpent(10n, 9n)).toBe(true)
    expect(isNonceSpent(10n | skipped(1n), 9n)).toBe(false)
    expect(isNonceSpent(10n | skipped(2n), 9n)).toBe(true)
    expect(isNonceSpent(10n | skipped(2n), 8n)).toBe(false)
  })
  it('is spent more than 24 behind the tip', () => {
    expect(isNonceSpent(100n | skipped(24n), 76n)).toBe(false)
    expect(isNonceSpent(100n, 75n)).toBe(true)
  })
})

/**
 * The ledger's per-write charge (D-2): a review with inline comments is several writes in a row,
 * and a node's balance lags a block behind the proof. Each row must be that write's own fee,
 * and the rows must add up to the balance change.
 */
describe('spend measurement across back-to-back writes (D-2)', () => {
  const START = 1_000_000_000n
  /** How long a fee takes to show in a balance read (the proof comes back before that). */
  const LAG = 1500

  /**
   * A chain whose balance reads lag the proof by {@link LAG} on the virtual clock. `stale(n)`:
   * the next n reads come from a node far behind (they see none of the fees yet).
   */
  function laggingChain(fees: bigint[], verdicts: ReadonlyArray<unknown> = []) {
    let now = 0
    setWriteClock({
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })
    const charged: Array<{ fee: bigint; at: number }> = []
    let staleReads = 0
    const visible = (lag: number) => charged.filter((c) => c.at + lag <= now).reduce((b, c) => b - c.fee, START)
    let nonce = 1n
    const sdk = {
      identities: {
        fetch: async () => {
          const lag = staleReads > 0 ? Number.MAX_SAFE_INTEGER : LAG
          if (staleReads > 0) staleReads -= 1
          return {
            balance: visible(lag),
            publicKeys: [{ keyId: 1, purposeNumber: 0, securityLevelNumber: 2, validatePrivateKey: () => true }],
            getPublicKeyById: () => ({}),
          }
        },
        contractNonce: async () => nonce,
      },
      documents: { get: async () => ({}) },
      stateTransitions: {
        broadcastStateTransition: async () => {
          nonce += 1n
          charged.push({ fee: fees[charged.length] ?? 0n, at: now })
        },
        // The i-th write's verdict: a block's refusal (its fee paid) when `verdicts[i]` is set.
        waitForResponse: async () => {
          const verdict = verdicts[charged.length - 1]
          if (verdict !== undefined) throw verdict
          return {}
        },
      },
      epoch: { current: async () => undefined },
      version: () => 14,
    } as unknown as EvoSDK
    return {
      sdk,
      stale: (n: number) => {
        staleReads = n
      },
      /** The balance once every fee has settled. */
      settled: () => charged.reduce((b, c) => b - c.fee, START),
    }
  }

  const doc = (documentType: string, contractId: string) => ({ contractId, documentType, data: { body: documentType }, confirmTimeoutMs: 0 })

  it('a review with an inline comment records each document at its own fee, and the ledger adds up', async () => {
    const chain = laggingChain([700n, 800n])
    const spends: SpendEvent[] = []
    await createDocumentIdempotent(chain.sdk, auth(spends), doc('comment', 'D2a'))
    await createDocumentIdempotent(chain.sdk, auth(spends), doc('review', 'D2a'))
    await reported()
    await reported()
    expect(spends.map((s) => [s.kind, s.actualCredits])).toEqual([
      ['create:comment', 700],
      ['create:review', 800],
    ])
    const ledger = spends.reduce((sum, s) => sum + (s.actualCredits ?? 0), 0)
    expect(BigInt(ledger)).toBe(spends[0]!.balanceBefore! - chain.settled())
  })

  it('three writes in a row (a repo create, a merge) sum to the balance change', async () => {
    const chain = laggingChain([500n, 600n, 900n])
    const spends: SpendEvent[] = []
    for (const t of ['repo', 'refUpdate', 'packManifest']) await createDocumentIdempotent(chain.sdk, auth(spends), doc(t, 'D2b'))
    for (let i = 0; i < 3; i++) await reported()
    expect(spends.map((s) => s.actualCredits)).toEqual([500, 600, 900])
    expect(spends.map((s) => s.balanceBefore)).toEqual([START, START - 500n, START - 1100n])
  })

  it('a write made inside an action carries its id, however late its charge is measured (QW3-039)', async () => {
    const chain = laggingChain([500n, 600n, 900n])
    const spends: SpendEvent[] = []
    await inSpendScope('action:fork', async () => {
      await createDocumentIdempotent(chain.sdk, auth(spends), doc('repo', 'D2t'))
      // A signer that names its own action (one running beside the dialog) keeps it.
      await createDocumentIdempotent(chain.sdk, { ...auth(spends), spendAction: 'action:merge' }, doc('refUpdate', 'D2t'))
    })
    // Outside any action now: the action's last write still reports under it.
    await measurementsSettled()
    await createDocumentIdempotent(chain.sdk, auth(spends), doc('packManifest', 'D2t'))
    for (let i = 0; i < 3; i++) await reported()
    expect(spends.map((s) => s.action)).toEqual(['action:fork', 'action:merge', undefined])
  })

  it('a balance read from a node still behind an earlier write is not taken for the next write’s', async () => {
    const chain = laggingChain([700n, 800n])
    const spends: SpendEvent[] = []
    await createDocumentIdempotent(chain.sdk, auth(spends), doc('comment', 'D2c'))
    await reported()
    expect(spends[0]?.actualCredits).toBe(700)
    // The review's "before" read and its first "after" read both hit a node that has not seen
    // the comment's fee yet.
    chain.stale(2)
    await createDocumentIdempotent(chain.sdk, auth(spends), doc('review', 'D2c'))
    await reported()
    expect(spends.map((s) => s.actualCredits)).toEqual([700, 800])
    expect(spends[1]?.balanceBefore).toBe(START - 700n)
  })

  it('a write refused in a block (its fee paid) and the write after it are each recorded at their own fee', async () => {
    const duplicate = sdkVerdict('Document X has duplicate unique properties ["repoId", "number"] with other documents', 40105)
    const chain = laggingChain([300n, 800n], [duplicate])
    const spends: SpendEvent[] = []
    await expect(createDocumentIdempotent(chain.sdk, auth(spends), doc('issue', 'D2d'))).rejects.toBeInstanceOf(ConsensusRefusal)
    await createDocumentIdempotent(chain.sdk, auth(spends), doc('issue', 'D2d'))
    await reported()
    await reported()
    expect(spends.map((s) => [s.kind, s.actualCredits])).toEqual([
      ['refused:issue', 300],
      ['create:issue', 800],
    ])
  })
})
