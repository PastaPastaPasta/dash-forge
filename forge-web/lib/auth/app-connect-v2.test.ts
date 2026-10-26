/**
 * App Connect v2 sign-in, offline: Forge's request against the vendored parser (bytes, callback,
 * renewal), and the poll against a simulated v2 wallet (`./wallet-sim` `answerV2`) on a fake
 * chain: the verifier's accepts and refusals, two answerers, and a key a node shows late.
 */

import * as secp from '@noble/secp256k1'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import { CREDITS_PER_DASH } from '../sdk/cost'
import { bytesToBase64 } from '../sdk/query'
import { AppConnectTlv, KeySecurityLevel, parseAppConnectUri } from '../vendor/platform-auth/app-connect'
import { AmbiguousWalletLogin, APP_CONNECT_CONTRACT_ID, RequestExpired } from './app-connect'
import {
  APP_CONNECT_LABEL,
  PollTrigger,
  TooManyAnswers,
  WalletGrantRefused,
  awaitV2Grant,
  forgeV2Request,
  newV2LoginRequest,
  type V2LoginRequest,
} from './app-connect-v2'
import { compareIds } from './app-connect-port'
import { base58Decode, base58Encode } from './base58'
import { isUnlimited } from './key-registration'
import { answerV2 } from './wallet-sim'
import { decodeWif } from './wif'

const FORGE: ForgeIds = {
  core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1',
  collab: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS',
  community: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS',
  group: '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC',
}
const OTHER_GROUP = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7'
const ALICE = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MALLORY = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const CONNECTION = new Uint8Array(16).fill(7)
const DAY = 24 * 60 * 60 * 1000

/** The TLVs after the fixed header (version, key, app id, label), as [type, value]. */
function tlvs(body: Uint8Array): [number, Uint8Array][] {
  let at = 1 + 33 + 32
  at += 1 + (body[at] as number)
  const out: [number, Uint8Array][] = []
  while (at < body.length) {
    const type = body[at] as number
    const len = body[at + 1] as number
    out.push([type, body.slice(at + 2, at + 2 + len)])
    at += 2 + len
  }
  return out
}

describe('the request Forge makes', () => {
  const chainNow = Date.UTC(2026, 9, 24)

  it('asks for one group-bound HIGH key with Forge’s default limits: 157 bytes', () => {
    const req = newV2LoginRequest('devnet', FORGE, { connectionId: CONNECTION, chainNow, now: chainNow + 5000 })
    const { request, requestBytes, network, callbackUrl } = parseAppConnectUri(req.qrUri)
    expect(network).toBe('devnet')
    expect(callbackUrl).toBeUndefined()
    expect(requestBytes.length).toBe(157)
    expect(request.label).toBe(APP_CONNECT_LABEL)
    expect(bytesToHex(request.appId)).toBe(bytesToHex(base58Decode(FORGE.core)))
    expect(request.encBindings).toEqual([])
    expect(request.authBindings).toHaveLength(1)
    const binding = request.authBindings[0]!
    expect(binding.kind).toBe('contractGroup')
    expect(bytesToHex(binding.id)).toBe(bytesToHex(base58Decode(FORGE.group)))
    expect(binding.securityLevel).toBe(KeySecurityLevel.HIGH)
    expect(binding.totalBudget).toBe(BigInt(0.05 * CREDITS_PER_DASH))
    // Expiry from chain time; CREATED_AT from this device's clock.
    expect(binding.expiresAt).toBe(chainNow + 90 * DAY)
    expect(request.createdAt).toBe(chainNow + 5000)
    expect(bytesToHex(request.connectionId!)).toBe(bytesToHex(CONNECTION))
    const types = tlvs(requestBytes).map(([t, v]) => [t, v.length + 2])
    expect(types).toEqual([
      [AppConnectTlv.AUTH_BINDING, 52],
      [AppConnectTlv.CONNECTION_ID, 18],
      [AppConnectTlv.CREATED_AT, 10],
    ])
    // Answers are stored under hash160 of the request's ephemeral key.
    expect(bytesToHex(req.requestHash)).toBe(bytesToHex(ripemd160(sha256(request.appEphemeralPubKey))))
    expect(req.expiresAt - req.createdAt).toBe(10 * 60 * 1000)
  })

  it('puts the callback on the deep link only', () => {
    let seen: Uint8Array | null = null
    const req = newV2LoginRequest('devnet', FORGE, {
      connectionId: CONNECTION,
      chainNow,
      callbackUrl: (hash) => {
        seen = hash
        return `https://forge.dashhq.org/connect/?r=${bytesToHex(hash)}`
      },
    })
    expect(bytesToHex(seen!)).toBe(bytesToHex(req.requestHash))
    expect(req.qrUri).not.toContain('cb=')
    const link = parseAppConnectUri(req.linkUri)
    expect(link.callbackUrl).toBe(`https://forge.dashhq.org/connect/?r=${bytesToHex(req.requestHash)}`)
    // One request: the same bytes behind both.
    expect(bytesToHex(link.requestBytes)).toBe(bytesToHex(parseAppConnectUri(req.qrUri).requestBytes))
    const none = newV2LoginRequest('devnet', FORGE, { connectionId: CONNECTION, chainNow, callbackUrl: () => null })
    expect(none.linkUri).toBe(none.qrUri)
  })

  it('renews with the identity as hint and the same connection id, and no MODE', () => {
    const login = forgeV2Request(FORGE, { appEphemeralPubKey: secp.getPublicKey(secp.utils.randomSecretKey(), true), connectionId: CONNECTION, chainNow, now: chainNow })
    const req = newV2LoginRequest('testnet', FORGE, { connectionId: CONNECTION, chainNow, identityHint: ALICE })
    const { request, requestBytes } = parseAppConnectUri(req.qrUri)
    expect(req.identityHint).toBe(ALICE)
    expect(bytesToHex(request.identityHint!)).toBe(bytesToHex(base58Decode(ALICE)))
    expect(bytesToHex(request.connectionId!)).toBe(bytesToHex(login.connectionId!))
    expect(request.mode).toBeUndefined()
    expect(tlvs(requestBytes).map(([t]) => t)).toEqual([AppConnectTlv.IDENTITY_HINT, AppConnectTlv.AUTH_BINDING, AppConnectTlv.CONNECTION_ID, AppConnectTlv.CREATED_AT])
    expect(requestBytes.length).toBe(157 + 34)
  })
})

// ---------------------------------------------------------------------------
// The poll against a simulated v2 wallet
// ---------------------------------------------------------------------------

interface ChainKey {
  keyId: number
  priv: Uint8Array
  bounds: { $type: string; id: string } | null
  securityLevelNumber?: number
  totalBudget?: bigint
  expiresAt?: bigint
  disabledAt?: bigint
}

/** A fake SDK: identities with keys (as wasm reads them), and App Connect answers. */
function fakeChain() {
  const identities = new Map<string, ChainKey[]>()
  const docs: Record<string, unknown>[] = []
  let queries = 0
  const sdk = {
    identities: {
      async fetch(id: string) {
        const keys = identities.get(id)
        if (!keys) return undefined
        return {
          balance: 10n ** 11n,
          revision: 1n,
          publicKeys: keys.map((k) => ({
            keyId: k.keyId,
            keyTypeNumber: 0,
            data: bytesToHex(secp.getPublicKey(k.priv, true)),
            purposeNumber: 0,
            securityLevelNumber: k.securityLevelNumber ?? 2,
            disabledAt: k.disabledAt,
            totalBudget: k.totalBudget,
            expiresAt: k.expiresAt,
            contractBounds: k.bounds ? { toJSON: () => k.bounds } : undefined,
            validatePrivateKey: (bytes: Uint8Array) => bytesToHex(bytes) === bytesToHex(k.priv),
          })),
        }
      },
      async keysRemainingBudgets(id: string, ids: number[]) {
        const keys = identities.get(id) ?? []
        return new Map(ids.map((i) => [i, keys.find((k) => k.keyId === i)?.totalBudget ?? null]))
      },
    },
    documents: {
      async query(q: { dataContractId: string; where: [string, string, string][]; limit?: number }) {
        queries++
        const hash = q.where.find((w) => w[0] === 'appEphemeralPubKeyHash')?.[2]
        const owner = q.where.find((w) => w[0] === '$ownerId' && w[1] === '==')?.[2]
        const after = q.where.find((w) => w[0] === '$ownerId' && w[1] === '>')?.[2]
        const rows = docs
          .filter((d) => q.dataContractId === APP_CONNECT_CONTRACT_ID && d['appEphemeralPubKeyHash'] === hash)
          .filter((d) => owner === undefined || d['$ownerId'] === owner)
          .filter((d) => after === undefined || compareIds(String(d['$ownerId']), after) > 0)
          .sort((a, b) => compareIds(String(a['$ownerId']), String(b['$ownerId'])))
          .slice(0, q.limit ?? 100)
        // Reversed: the port must not rely on the SDK's map order.
        return new Map(rows.reverse().map((r, i) => [String(i), { toJSON: () => r }]))
      },
    },
  }
  /**
   * A v2 wallet approving `uri` for `identityId`: registers a fresh key (unless `register` is
   * false) with the limits asked for, overridden by `register`, and publishes its answer.
   */
  async function approve(uri: string, identityId: string, register: Partial<ChainKey> | false = {}) {
    const { request } = parseAppConnectUri(uri)
    const binding = request.authBindings[0]!
    const priv = secp.utils.randomSecretKey()
    const keys = identities.get(identityId) ?? [{ keyId: 0, priv: new Uint8Array(32).fill(0x77), bounds: null, securityLevelNumber: 0 }]
    identities.set(identityId, keys)
    const chainKey: ChainKey = {
      keyId: keys.length,
      priv,
      bounds: { $type: 'contractGroup', id: FORGE.group },
      totalBudget: binding.totalBudget,
      expiresAt: BigInt(binding.expiresAt!),
      ...(register || {}),
    }
    if (register !== false) keys.push(chainKey)
    const answer = await answerV2(uri, { ownerId: identityId, slots: [priv] })
    docs.push({
      $ownerId: identityId,
      appEphemeralPubKeyHash: bytesToBase64(answer.requestHash),
      walletEphemeralPubKey: bytesToBase64(answer.walletEphemeralPubKey),
      encryptedPayload: bytesToBase64(answer.encryptedPayload),
    })
    return { priv, register: () => keys.push(chainKey) }
  }
  return { sdk: sdk as unknown as EvoSDK, identities, docs, approve, queries: () => queries }
}

const fast = { network: 'devnet' as const, forge: FORGE, intervalMs: 1, settleMs: 0 }
const request = (identityHint?: string): V2LoginRequest =>
  newV2LoginRequest('devnet', FORGE, { connectionId: CONNECTION, chainNow: Date.now(), ...(identityHint ? { identityHint } : {}) })

describe('v2 poll against a simulated wallet', () => {
  it('accepts a group-bound HIGH key with a budget and an expiry, as Forge’s own wallet key', async () => {
    const chain = fakeChain()
    const req = request()
    const { priv } = await chain.approve(req.qrUri, ALICE)
    const grant = await awaitV2Grant(chain.sdk, req, fast)
    expect(grant.identityId).toBe(ALICE)
    expect(grant.key.keyId).toBe(1)
    expect(grant.key.scope).toEqual({ core: true, collab: true, community: true, meta: true, unbounded: false })
    expect(isUnlimited(grant.key)).toBe(false)
    expect(grant.key.limits?.total).toBe(BigInt(0.05 * CREDITS_PER_DASH))
    expect(bytesToHex(decodeWif(grant.key.wif).privateKey)).toBe(bytesToHex(priv))
    // The request is spent.
    expect(req.appEphemeralPriv.every((b) => b === 0)).toBe(true)
  })

  it('takes a budget the wallet raised (its presets start at 0.1 DASH)', async () => {
    const chain = fakeChain()
    const req = request()
    await chain.approve(req.qrUri, ALICE, { totalBudget: BigInt(0.1 * CREDITS_PER_DASH) })
    const grant = await awaitV2Grant(chain.sdk, req, fast)
    expect(grant.key.limits?.total).toBe(BigInt(0.1 * CREDITS_PER_DASH))
  })

  it.each([
    ['a key without a budget', { totalBudget: undefined }, 'key-limits'],
    ['a CRITICAL key', { securityLevelNumber: 1 }, 'key-level'],
    ['a key bound to another group', { bounds: { $type: 'contractGroup', id: OTHER_GROUP } }, 'key-unmatched'],
    ['a key expiring within the hour', { expiresAt: BigInt(Date.now() + 30 * 60 * 1000) }, 'key-expired'],
    ['a disabled key', { disabledAt: 1n }, 'key-disabled'],
  ] as const)('refuses %s', async (_what, register, reason) => {
    const chain = fakeChain()
    const req = request()
    await chain.approve(req.qrUri, ALICE, register)
    const outcome = awaitV2Grant(chain.sdk, req, fast)
    await expect(outcome).rejects.toBeInstanceOf(WalletGrantRefused)
    await expect(outcome).rejects.toMatchObject({ reason })
  })

  it('refuses when two identities answer (someone else saw the QR)', async () => {
    const chain = fakeChain()
    const req = request()
    await chain.approve(req.qrUri, ALICE)
    await chain.approve(req.qrUri, MALLORY)
    await expect(awaitV2Grant(chain.sdk, req, fast)).rejects.toBeInstanceOf(AmbiguousWalletLogin)
  })

  it('waits out the settle window: a second answer inside it is refused', async () => {
    const chain = fakeChain()
    const req = request()
    await chain.approve(req.qrUri, ALICE)
    let late: Promise<unknown> | null = null
    const outcome = awaitV2Grant(chain.sdk, req, {
      ...fast,
      settleMs: 5_000,
      onStatus: (s) => {
        // ALICE's answer is verified; MALLORY answers while Forge waits for competitors.
        if (s === 'answered' && late === null) late = chain.approve(req.qrUri, MALLORY)
      },
    })
    await expect(outcome).rejects.toBeInstanceOf(AmbiguousWalletLogin)
    expect(late).not.toBeNull()
  })

  it('checks expiry against chain time, not this device’s clock', async () => {
    const chain = fakeChain()
    const req = request()
    await chain.approve(req.qrUri, ALICE)
    const expiresAt = Number(chain.identities.get(ALICE)![1]!.expiresAt)
    // The chain is 30 minutes from the key's expiry while this device's clock is 90 days before it.
    const late = { ...req, chainTimeAtCreation: expiresAt - 30 * 60 * 1000 }
    await expect(awaitV2Grant(chain.sdk, late, fast)).rejects.toMatchObject({ reason: 'key-expired' })
  })

  it('counts an answer whose key no node shows yet: a quick stranger does not win', async () => {
    const chain = fakeChain()
    const req = request()
    await chain.approve(req.qrUri, ALICE, false)
    await chain.approve(req.qrUri, MALLORY)
    await expect(awaitV2Grant(chain.sdk, req, fast)).rejects.toBeInstanceOf(AmbiguousWalletLogin)
  })

  it('checks again when the key is not shown yet (key-not-found), and accepts it once it is', async () => {
    const chain = fakeChain()
    const req = request()
    const { register } = await chain.approve(req.qrUri, ALICE, false)
    const statuses: string[] = []
    const grant = awaitV2Grant(chain.sdk, req, {
      ...fast,
      onStatus: (s) => {
        statuses.push(s)
        // A few polls later the node shows the key.
        if (statuses.length === 3) register()
      },
    })
    expect((await grant).identityId).toBe(ALICE)
    expect(statuses.slice(0, 3)).toEqual(['waiting', 'waiting', 'waiting'])
  })

  it('ignores answers not encrypted to this request', async () => {
    const chain = fakeChain()
    const req = request()
    const other = request()
    await chain.approve(other.qrUri, MALLORY)
    // MALLORY's answer to another request, relabelled as an answer to this one.
    chain.docs[0]!['appEphemeralPubKeyHash'] = bytesToBase64(req.requestHash)
    await chain.approve(req.qrUri, ALICE)
    expect((await awaitV2Grant(chain.sdk, req, fast)).identityId).toBe(ALICE)
  })

  it('a renewal reads only the named identity, and its refusal is final at once', async () => {
    const chain = fakeChain()
    const req = request(ALICE)
    await chain.approve(req.qrUri, MALLORY)
    await chain.approve(req.qrUri, ALICE)
    expect((await awaitV2Grant(chain.sdk, req, { ...fast, settleMs: 60_000 })).identityId).toBe(ALICE)

    const chain2 = fakeChain()
    const req2 = request(ALICE)
    await chain2.approve(req2.qrUri, ALICE, { securityLevelNumber: 1 })
    await expect(awaitV2Grant(chain2.sdk, req2, fast)).rejects.toMatchObject({ reason: 'key-level' })
  })

  it('stops when more answers arrive than it reads (junk)', async () => {
    const chain = fakeChain()
    const req = request()
    for (let i = 0; i < 21; i++) {
      const id = base58Encode(new Uint8Array(32).fill(i + 1))
      chain.docs.push({ $ownerId: id, appEphemeralPubKeyHash: bytesToBase64(req.requestHash), walletEphemeralPubKey: bytesToBase64(new Uint8Array(33)), encryptedPayload: bytesToBase64(new Uint8Array(60)) })
    }
    await expect(awaitV2Grant(chain.sdk, req, fast)).rejects.toBeInstanceOf(TooManyAnswers)
  })

  it('does not settle on a round that could not read the answers', async () => {
    const chain = fakeChain()
    const req = { ...request(), expiresAt: Date.now() + 60 }
    await chain.approve(req.qrUri, ALICE)
    ;(chain.sdk as unknown as { documents: { query: () => Promise<never> } }).documents.query = () => Promise.reject(new Error('node refused'))
    const statuses: string[] = []
    await expect(awaitV2Grant(chain.sdk, req, { ...fast, onStatus: (s) => statuses.push(s) })).rejects.toBeInstanceOf(RequestExpired)
    expect(statuses).toContain('incomplete-read')
  })

  it('polls at once when triggered, and expires', async () => {
    const chain = fakeChain()
    const trigger = new PollTrigger()
    const req = request()
    const before = chain.queries()
    const outcome = awaitV2Grant(chain.sdk, req, { network: 'devnet', forge: FORGE, trigger, settleMs: 0 })
    await new Promise((r) => setTimeout(r, 20))
    trigger.fire()
    await new Promise((r) => setTimeout(r, 20))
    // Two polls in well under the 2 s cadence: the second was the trigger's.
    expect(chain.queries() - before).toBe(2)
    await chain.approve(req.qrUri, ALICE)
    trigger.fire()
    expect((await outcome).identityId).toBe(ALICE)

    const stale = newV2LoginRequest('devnet', FORGE, { connectionId: CONNECTION, chainNow: Date.now(), now: Date.now() - 10 * 60 * 1000 - 1 })
    await expect(awaitV2Grant(chain.sdk, stale, fast)).rejects.toBeInstanceOf(RequestExpired)
    expect(stale.appEphemeralPriv.every((b) => b === 0)).toBe(true)
  })

  it('stops on abort', async () => {
    const chain = fakeChain()
    const ac = new AbortController()
    const outcome = awaitV2Grant(chain.sdk, request(), { network: 'devnet', forge: FORGE, signal: ac.signal })
    ac.abort()
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' })
  })
})
