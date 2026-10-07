/**
 * The browser's environments reader (`readEnvironments`) replayed over the `env_snapshot__*`
 * vectors, so the page resolves exactly as forge-core's `Environments::read` does:
 * - every `resolve` vector: the loader's own resolution (authorization, fetching only current
 *   maintainers' snapshots, the chain) must equal the vector's expected resolution;
 * - every `open` vector: the loader's fetch → `packHash` check → open, per reader, must give the
 *   vector's snapshot or refusal.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { EpochKeys, hexToBytes, type EpochKeyring, type EpochResolution, type OwnerKey } from '../private'
import { SnapshotOpenError, type ManifestCheck } from './codec'
import type { Snapshot } from './format'
import { readEnvironments, type EnvKeys, type EnvManifest, type EnvSources, type Opened } from './loader'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Obj = { [k: string]: Json }

const VECTORS_DIR = resolve(process.cwd(), '..', 'forge-contracts', 'vectors')
const load = (op: string): [string, Obj, Json][] =>
  readdirSync(VECTORS_DIR)
    .filter((f) => f.startsWith('env_snapshot__') && f.endsWith('.json'))
    .sort()
    .map((f) => [f, JSON.parse(readFileSync(resolve(VECTORS_DIR, f), 'utf8')) as Obj] as const)
    .filter(([, v]) => (v.input as Obj).op === op)
    .map(([f, v]): [string, Obj, Json] => [f, v.input as Obj, v.expected as Json])

const o = (j: Json | undefined): Obj => j as Obj
const arr = (j: Json | undefined): Json[] => j as Json[]
const s = (j: Json | undefined): string => j as string
const n = (j: Json | undefined): number => j as number

/** No anchors, no burned epochs: nothing is late, as in the codec's own vectors. */
const NO_STANDING = { anchors: new Map(), members: new Set(), burned: new Set() } as unknown as EpochResolution

function sources(manifests: readonly EnvManifest[], maintainers: readonly string[], bytes: (m: EnvManifest) => Uint8Array, keys: readonly OwnerKey[] = []) {
  const src = {
    manifests: async () => manifests,
    maintainers: async () => maintainers,
    fetch: vi.fn(async (m: EnvManifest) => bytes(m)),
    ownerKeys: async () => keys,
  } satisfies EnvSources
  return src
}

describe('readEnvironments over the resolve vectors', () => {
  const vectors = load('resolve')
  it('finds them', () => expect(vectors.length).toBeGreaterThanOrEqual(10))
  for (const [file, inp, expected] of vectors) {
    it(file, async () => {
      const maintainers = arr(inp.maintainers).map(s)
      const manifests: EnvManifest[] = arr(inp.manifests).map((m, i) => ({
        id: s(o(m).id),
        ownerId: s(o(m).ownerId),
        packHash: s(o(m).packHash),
        supersedes: arr(o(m).supersedes).map(s),
        height: n(o(m).height),
        createdAt: 1_759_651_200_000 + i,
        sizeBytes: 9,
      }))
      // a Maintainers-shaped header: the loader reaches the opener, which replays `opened`
      const src = sources(manifests, maintainers, () => new Uint8Array([0x44, 0x46, 0x50, 0x4b, 0x02, 0, 0, 0, 1]))
      const opened = o(inp.opened)
      const open = async (m: ManifestCheck): Promise<Snapshot> => {
        const e = opened[m.packHash]
        if (e === undefined || o(e).env === undefined) throw new SnapshotOpenError('notARecipient')
        return { env: s(o(e).env), audience: 'members', generatedAt: 0, to: [], vars: new Map() }
      }
      const keys: EnvKeys = { repoId: new Uint8Array(32), members: null, withReader: (use) => use(null), hasReader: true }
      const book = await readEnvironments(src, keys, open)
      expect(JSON.parse(JSON.stringify(book.resolution))).toEqual(expected)
      // D24: only a current maintainer's snapshot is fetched, and each packHash once
      const fetched = src.fetch.mock.calls.map(([m]) => m)
      expect(fetched.every((m) => maintainers.includes(m.ownerId))).toBe(true)
      expect(new Set(fetched.map((m) => m.packHash)).size).toBe(fetched.length)
    })
  }
})

async function epochKeyring(repoId: Uint8Array, j: Json | undefined): Promise<EpochKeyring> {
  const m = new Map<number, EpochKeys>()
  for (const e of arr(j ?? [])) m.set(n(o(e).epoch), await EpochKeys.import(repoId, n(o(e).epoch), hexToBytes(s(o(e).key))))
  return m
}

function resultOf(o: Opened | undefined): Json {
  if (o?.kind === 'snapshot') {
    const snap = o.snapshot
    const vars: Obj = {}
    for (const [k, v] of snap.vars) Object.defineProperty(vars, k, { value: { type: v.type, value: v.value, note: v.note }, enumerable: true })
    const out: Obj = { env: snap.env, audience: snap.audience, generatedAt: snap.generatedAt, vars }
    if (snap.audience === 'maintainers') out.to = [...snap.to]
    if (snap.savedFor !== undefined) out.savedFor = snap.savedFor
    return { snapshot: out }
  }
  if (o?.kind === 'refused') return { error: o.code }
  return { other: o?.kind ?? 'none' }
}

/** One reader opening one sealed snapshot through the whole loader. */
async function openThroughLoader(repoId: Uint8Array, manifest: Obj, sealed: Uint8Array, owner: OwnerKey[], reader: Obj, epochKeys: Json | undefined): Promise<Json> {
  const m: EnvManifest = {
    id: 'vector',
    ownerId: s(manifest.ownerId),
    packHash: s(manifest.packHash),
    supersedes: [],
    height: 1000,
    createdAt: 1_759_651_200_000,
    sizeBytes: n(manifest.sizeBytes),
  }
  const keys: EnvKeys = {
    repoId,
    members: { keys: await epochKeyring(repoId, epochKeys), resolution: NO_STANDING },
    withReader: (use) => use({ identityId: hexToBytes(s(reader.identityId)), secrets: arr(reader.keys).map((k) => hexToBytes(s(k))) }),
    hasReader: true,
  }
  const book = await readEnvironments(sources([m], [m.ownerId], () => sealed, owner), keys)
  return resultOf(book.opened.get('vector'))
}

const ownerKeysOf = (j: Json | undefined): OwnerKey[] =>
  arr(j).map((k) => ({ id: n(o(k).id), purpose: n(o(k).purpose), keyType: n(o(k).keyType), data: hexToBytes(s(o(k).data)) }))

describe('readEnvironments over the open vectors', () => {
  const vectors = load('open')
  it('finds them', () => expect(vectors.length).toBeGreaterThanOrEqual(4))
  for (const [file, inp, expected] of vectors) {
    it(file, async () => {
      const repoId = hexToBytes(s(inp.repoId))
      const results: Json[] = []
      if (inp.cases !== undefined) {
        for (const c of arr(inp.cases).map(o)) {
          results.push(await openThroughLoader(repoId, o(c.manifest), hexToBytes(s(c.sealed)), ownerKeysOf(c.ownerKeys), o(c.reader), c.epochKeys))
        }
      } else {
        for (const r of arr(inp.readers).map(o)) {
          results.push(await openThroughLoader(repoId, o(inp.manifest), hexToBytes(s(inp.sealed)), ownerKeysOf(inp.ownerKeys), o(r.reader), r.epochKeys))
        }
      }
      expect(results).toEqual(o(expected).results)
    })
  }
})
