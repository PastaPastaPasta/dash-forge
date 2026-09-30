/**
 * The survivability drill, browse side (roadmap Phase 1, launch criterion 3): the web reader
 * keeps browsing when one storage source disappears, and its source indicator (the trust
 * panel's "where the bytes came from" row, fed by the content-check ledger) names the one that
 * failed. The CLI side is forge-core `src/survivability_tests.rs`; the web host itself is
 * `e2e-drill/web-host.spec.ts`.
 *
 * Platform reads are mocked (a `chunk` query answers from memory, as in the other browse
 * tests); storage is REAL: packs are written with the web's own upload code (`putObject`,
 * `addVerified`, `orderUris`) to a bucket on the S3 fixture (RustFS, standing in for MinIO)
 * and to kubo, then read back through the real reader (`startFallback`: the in-browser clone,
 * and `artifactRangeFetch`: the indexed browse's ranged reads) over real HTTP. Each scenario
 * puts the source about to fail first in the policy, breaks it for real (the bucket deleted,
 * the kubo container stopped), and checks:
 *  - the files still read, from the remaining copy (production racing, then one URL at a time
 *    so the places named are exact);
 *  - the ledger names the copy that served them and the one that failed, and the trust panel's
 *    source row says so ("Unavailable, another copy served instead: …") without lowering any
 *    trust state (nothing is missing, every object was checked);
 *  - every request went to a recorded copy or the configured gateway: nothing else (no web
 *    host, no relay) is on the browse path.
 *
 * A pack stored on Platform too is read from its chunks first in the browser (proof-verified,
 * so no mirror can hold a browse hostage), so losing its bucket or gateway is invisible there.
 * The other way round, chunks that cannot be read (missing, or the node erroring) fall back to
 * the pack's bucket or gateway copy, and the source row names the chunks.
 *
 * The fixture is on loopback http, which the reader never follows from a manifest (only public
 * https): `lib/net`'s check is widened to the fixture's two origins here and nowhere else.
 *
 * Opt-in (`FORGE_DRILL=1`, see `e2e-drill/fixture.ts`): it deletes buckets and stops kubo.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { zlibSync } from 'fflate'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { base58Decode } from '../auth/base58'
import { gitOidHex } from '../browse'
import { T_BLOB, concat, objHeader, packFrame } from '../browse/pack-fixtures'
import { CHUNK_PAYLOAD_MAX } from '../constants'
import type { PackManifest, RepoRef } from '../repo'
import { bytesToBase64 } from '../sdk'
import { addVerified, gatewayUrl } from '../storage/ipfs'
import { putObject, publicObjectUrl, s3Uri, type S3Settings } from '../storage/s3'
import { orderUris } from '../storage/upload'
import {
  DRILL_ON,
  GATEWAY,
  KUBO_API,
  S3,
  createBucket,
  deleteBucket,
  requireFixture,
  stopKubo,
} from '../../e2e-drill/fixture'
import { startFallback } from './browse-fallback'
import { artifactRangeFetch, clearChunkCache, overrideMirrorRaceWidth, resetExternalFetchState } from './browse-source'
import { contentChecks, resetContentChecks } from './content-checks'
import { overrideDefaultGateways } from './storage-status'
import { deriveTrust } from './trust'

vi.mock('../net', async (importOriginal) => {
  const real = await importOriginal<typeof import('../net')>()
  const fixture = [process.env.FORGE_DRILL_S3 || 'http://127.0.0.1:9000', process.env.FORGE_DRILL_GATEWAY || 'http://127.0.0.1:8081'].map(
    (u) => new URL(u).origin,
  )
  const onFixture = (u: string): boolean => {
    try {
      return fixture.includes(new URL(u).origin)
    } catch {
      return false
    }
  }
  return { ...real, isPublicHttpsUrl: (u: string) => onFixture(u) || real.isPublicHttpsUrl(u) }
})

const S3_HOST = new URL(S3).host
const GATEWAY_HOST = new URL(GATEWAY).host

type Store = 's3' | 'ipfs' | 'platform'

let repoSeq = 0
/** A fresh repo each read: the session caches (the in-browser clone, the ledger) key by repo id. */
function freshRepo(label: string): RepoRef {
  repoSeq += 1
  return { forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'G' }, repoId: `drill-${label}-${repoSeq}`, ownerId: 'owner', name: label, visibility: 'public' }
}

/** A one-blob pack holding `text`, and the blob's git id. */
function blobPack(text: string): { pack: Uint8Array; oid: string; body: Uint8Array } {
  const body = new TextEncoder().encode(text)
  return { pack: packFrame(concat(objHeader(T_BLOB, body.length), zlibSync(body))), oid: gitOidHex('blob', body), body }
}

/** Platform, mocked: each pack's `chunk` documents, split at CHUNK_PAYLOAD_MAX. */
function mockSdk(packs: ReadonlyMap<string, Uint8Array>): EvoSDK {
  return {
    documents: {
      query: (q: { where?: readonly (readonly unknown[])[] }): Promise<Map<string, unknown>> => {
        const packClause = (q.where ?? []).find((w) => w[0] === 'packHash')
        const seqClause = (q.where ?? []).find((w) => w[0] === 'seq')
        const bytes = packs.get(bytesToHex(base58Decode(String(packClause?.[2] ?? ''))))
        const map = new Map<string, unknown>()
        if (bytes === undefined) return Promise.resolve(map)
        for (const seq of (seqClause?.[2] as number[]) ?? []) {
          const from = seq * CHUNK_PAYLOAD_MAX
          if (from >= bytes.length) continue
          map.set(`c${seq}`, { seq, d0: bytesToBase64(bytes.subarray(from, Math.min(from + CHUNK_PAYLOAD_MAX, bytes.length))) })
        }
        return Promise.resolve(map)
      },
    },
  } as unknown as EvoSDK
}

const s3Settings = (bucket: string): S3Settings => ({
  kind: 's3',
  provider: 'minio',
  endpoint: S3,
  region: 'us-east-1',
  bucket,
  pathStyle: true,
  publicUrl: `${S3}/${bucket}`,
  prefix: '',
})
const S3_SECRETS = { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }

/** A pushed pack: its manifest, the S3 keys it wrote, and the bytes Platform holds. */
interface Pushed {
  readonly manifest: PackManifest
  readonly keys: string[]
  readonly chunks: Map<string, Uint8Array>
}

/** Store `pack` on every one of `stores` (in policy order) with the web's upload code; the manifest a push records. */
async function push(pack: Uint8Array, stores: readonly Store[], bucket: string): Promise<Pushed> {
  const hash = bytesToHex(sha256(pack))
  const groups: string[][] = []
  const keys: string[] = []
  const chunks = new Map<string, Uint8Array>()
  const s3 = s3Settings(bucket)
  for (const store of stores) {
    if (store === 's3') {
      const key = `packs/${hash}.pack`
      await putObject(s3, S3_SECRETS, key, pack)
      keys.push(key)
      groups.push([publicObjectUrl(s3, key), s3Uri(s3, key)])
    } else if (store === 'ipfs') {
      const cid = await addVerified({ kind: 'ipfs-kubo', provider: 'kubo', api: KUBO_API, gateway: GATEWAY, publicGateway: GATEWAY, pinningEndpoint: '' }, {}, pack)
      groups.push([gatewayUrl(GATEWAY, cid), `ipfs://${cid}`])
    } else {
      chunks.set(hash, pack)
      groups.push([`platform://CORE/REPO/owner/${hash}`])
    }
  }
  const onChain = stores.includes('platform')
  return {
    manifest: {
      packHash: hash,
      kind: 0,
      sizeBytes: pack.length,
      objectCount: 1,
      chunkCount: onChain ? Math.ceil(pack.length / CHUNK_PAYLOAD_MAX) : 0,
      storage: onChain ? 0 : 1,
      uris: orderUris(groups),
      tips: [],
      supersedes: [],
      createdAt: 1,
      documentId: `m-${hash.slice(0, 8)}`,
      uploader: 'owner',
    },
    keys,
    chunks,
  }
}

/** Every URL `fetch` is asked for from here on (passed through to the network). */
function recordFetches(): string[] {
  const real = globalThis.fetch
  const seen: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(input instanceof Request ? input.url : String(input))
    return real(input, init)
  })
  return seen
}

/** What a browse of `p` saw: the ledger's sources and failed places, and the trust panel's rows. */
interface Browsed {
  readonly sources: readonly string[]
  /** Recorded copies that failed while another served. */
  readonly fellBack: readonly string[]
  /** Places that served nothing at all (a pack missing): must stay empty. */
  readonly unreachable: readonly string[]
  readonly source: { readonly state: string; readonly detail: string }
  readonly content: string
}

/**
 * Browse `blob` from pushed pack `p` twice — the in-browser clone (whole pack) and a ranged
 * read (the indexed path) — each on a fresh repo, checking the bytes; what each reported.
 */
async function browse(
  p: Pushed,
  blob: { oid: string; body: Uint8Array },
  sdk: EvoSDK = mockSdk(p.chunks),
): Promise<{ clone: Browsed; range: Browsed }> {
  const seen = (repo: RepoRef): Browsed => {
    const checks = contentChecks(repo.repoId)
    const trust = deriveTrust({ network: 'devnet', connection: 'trusted', tip: 'missing', checks, configuredBackend: 'your storage' })
    return {
      sources: checks.sources,
      fellBack: checks.fellBackFrom,
      unreachable: checks.unreachable,
      source: { state: trust.source.state, detail: trust.source.detail },
      content: trust.content.state,
    }
  }
  const cloned = freshRepo('clone')
  const ctx = await startFallback(sdk, cloned, [p.manifest])
  expect(ctx.unavailable).toEqual([])
  expect(Array.from((await ctx.reader.readObject(blob.oid)).bytes)).toEqual(Array.from(blob.body))
  const ranged = freshRepo('range')
  const bytes = await artifactRangeFetch(sdk, ranged, p.manifest)(0, p.manifest.sizeBytes)
  expect(bytesToHex(sha256(bytes))).toBe(p.manifest.packHash)
  return { clone: seen(cloned), range: seen(ranged) }
}

/** Every request went to the S3 fixture or the gateway: the only places the packs are. */
function expectOnlyStorage(seen: readonly string[]): void {
  expect(seen.length).toBeGreaterThan(0)
  for (const url of seen) expect([S3_HOST, GATEWAY_HOST], url).toContain(new URL(url).host)
}

// Stopping and restarting a container takes longer than vitest's 5 s default on a CI runner.
describe.runIf(DRILL_ON)('survivability drill: browse', { timeout: 120_000 }, () => {
  beforeAll(requireFixture)

  afterEach(() => {
    vi.unstubAllGlobals()
    resetContentChecks()
    resetExternalFetchState()
    clearChunkCache()
    overrideDefaultGateways(null)
    overrideMirrorRaceWidth(null)
  })

  it('a deleted bucket: the gateway serves the S3 + IPFS pack and the panel names the bucket', async () => {
    overrideDefaultGateways([GATEWAY])
    const bucket = await createBucket('bucket')
    const a = blobPack('s3 first, then ipfs\n')
    const b = blobPack('s3 first, then platform\n')
    const s3Ipfs = await push(a.pack, ['s3', 'ipfs'], bucket)
    const s3Chain = await push(b.pack, ['s3', 'platform'], bucket)
    for (const width of [null, 1]) {
      overrideMirrorRaceWidth(width)
      const before = await browse(s3Ipfs, a)
      expect(before.clone.fellBack, 'nothing is down yet').toEqual([])
      expect(before.range.fellBack).toEqual([])
      expect(before.range.sources).toEqual([S3_HOST])
    }
    expect((await browse(s3Chain, b)).clone.sources).toEqual(['platform'])

    await deleteBucket(bucket, [...s3Ipfs.keys, ...s3Chain.keys])
    resetExternalFetchState()

    // A deleted bucket answers an anonymous read 403 (RustFS; AWS without list rights) or 404.
    const bucketGone = new RegExp(`^${S3_HOST.replace(/\./g, '\\.')} \\((access denied|not found)\\)$`)
    // Racing (production): the files still read, and anything named is the bucket.
    overrideMirrorRaceWidth(null)
    const seen = recordFetches()
    const raced = await browse(s3Ipfs, a)
    for (const place of [...raced.clone.fellBack, ...raced.range.fellBack]) expect(place).toMatch(bucketGone)
    // One URL at a time: exactly which copy served, and which failed.
    overrideMirrorRaceWidth(1)
    resetExternalFetchState()
    const after = await browse(s3Ipfs, a)
    for (const read of [after.clone, after.range]) {
      expect(read.sources).toEqual([GATEWAY_HOST])
      expect(read.fellBack).toHaveLength(1)
      expect(read.fellBack[0]).toMatch(bucketGone)
      expect(read.unreachable).toEqual([])
      expect(read.source.detail).toContain(`${GATEWAY_HOST}. Unavailable, another copy served instead: ${read.fellBack[0]}.`)
    }
    // Every object was read and hash-checked: a lost copy lowers no trust state.
    expect(after.clone.content).toBe('verified')
    expect(after.clone.source.state).toBe('verified')
    // On Platform too: its chunks are read first, and the lost bucket is never needed.
    const chain = await browse(s3Chain, b)
    expect(chain.clone.sources).toEqual(['platform'])
    expect(chain.clone.fellBack).toEqual([])
    expectOnlyStorage(seen)
  })

  it('a stopped gateway: the bucket serves the IPFS + S3 pack and the panel names the gateway', async () => {
    overrideDefaultGateways([GATEWAY])
    const bucket = await createBucket('gateway')
    const a = blobPack('ipfs first, then s3\n')
    const b = blobPack('ipfs first, then platform\n')
    const ipfsS3 = await push(a.pack, ['ipfs', 's3'], bucket)
    const ipfsChain = await push(b.pack, ['ipfs', 'platform'], bucket)
    for (const width of [null, 1]) {
      overrideMirrorRaceWidth(width)
      const before = await browse(ipfsS3, a)
      expect(before.clone.fellBack, 'nothing is down yet').toEqual([])
      expect(before.range.fellBack).toEqual([])
      expect(before.range.sources).toEqual([GATEWAY_HOST])
    }

    const restart = await stopKubo()
    try {
      const gatewayGone = `ipfs gateway ${GATEWAY_HOST} (didn't answer)`
      resetExternalFetchState()
      overrideMirrorRaceWidth(null)
      const seen = recordFetches()
      const raced = await browse(ipfsS3, a)
      for (const place of [...raced.clone.fellBack, ...raced.range.fellBack]) expect(place).toBe(gatewayGone)
      overrideMirrorRaceWidth(1)
      resetExternalFetchState()
      const after = await browse(ipfsS3, a)
      for (const read of [after.clone, after.range]) {
        expect(read.sources).toEqual([S3_HOST])
        expect(read.fellBack).toEqual([gatewayGone])
        expect(read.unreachable).toEqual([])
        expect(read.source.detail).toContain(`${S3_HOST}. Unavailable, another copy served instead: ${gatewayGone}.`)
      }
      expect(after.clone.source.state).toBe('verified')
      const chain = await browse(ipfsChain, b)
      expect(chain.clone.sources).toEqual(['platform'])
      expect(chain.clone.fellBack).toEqual([])
      expectOnlyStorage(seen)
    } finally {
      await restart()
    }
    await deleteBucket(bucket, ipfsS3.keys)
  })

  it('unreadable Platform chunks: the bucket and the gateway serve the on-chain packs and the panel names the chunks', async () => {
    overrideDefaultGateways([GATEWAY])
    const bucket = await createBucket('chunks')
    const a = blobPack('platform first, then s3\n')
    const b = blobPack('platform first, then ipfs\n')
    const chainS3 = await push(a.pack, ['platform', 's3'], bucket)
    const chainIpfs = await push(b.pack, ['platform', 'ipfs'], bucket)
    // Readable chunks serve both, and nothing is fetched from the bucket or the gateway.
    const quiet = recordFetches()
    for (const [p, blob] of [[chainS3, a], [chainIpfs, b]] as const) {
      const before = await browse(p, blob)
      for (const read of [before.clone, before.range]) {
        expect(read.sources).toEqual(['platform'])
        expect(read.fellBack, 'nothing is down yet').toEqual([])
      }
    }
    expect(quiet).toEqual([])

    // The chunk documents gone (the query answers none of them), and the Platform node erroring.
    const missing = mockSdk(new Map())
    const erroring = { documents: { query: () => Promise.reject(new Error('platform node unreachable')) } } as unknown as EvoSDK
    const seen = recordFetches()
    const cases = [
      { p: chainS3, blob: a, sdk: missing, host: S3_HOST, chunks: 'chunks on Platform (missing)' },
      { p: chainIpfs, blob: b, sdk: erroring, host: GATEWAY_HOST, chunks: "chunks on Platform (didn't answer)" },
    ]
    for (const { p, blob, sdk, host, chunks } of cases) {
      clearChunkCache()
      const after = await browse(p, blob, sdk)
      for (const read of [after.clone, after.range]) {
        expect(read.sources).toEqual([host])
        expect(read.fellBack).toEqual([chunks])
        expect(read.unreachable).toEqual([])
        expect(read.source.detail).toContain(`${host}. Unavailable, another copy served instead: ${chunks}.`)
      }
      // Every object was read and hash-checked: the lost chunks lower no trust state.
      expect(after.clone.content).toBe('verified')
      expect(after.clone.source.state).toBe('verified')
    }
    expectOnlyStorage(seen)
    await deleteBucket(bucket, chainS3.keys)
  })
})
