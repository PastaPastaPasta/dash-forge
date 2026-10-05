/**
 * The `env_snapshot__*` vectors (`tools/private-repos-vectors/env.py`), run byte for byte, as the
 * Rust harness (`crates/forge-core/src/env/conformance.rs`) runs them.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EpochKeys, bytesToHex, hexToBytes, type EpochKeyring, type OwnerKey } from '../private'
import { sealLetterArtifactWith, sealPackWithFileId } from '../private/testing'
import { exposureOf, resolveSnapshots, type SnapshotRef } from './chain'
import { openSnapshot, recipientsMatch, SnapshotOpenError } from './codec'
import { decodeSnapshot, defaultAudience, encodeSnapshot, type EnvVar, type Snapshot } from './format'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Obj = { [k: string]: Json }

interface Vector {
  readonly name: string
  readonly case: string
  readonly rules: string
  readonly input: Obj
  readonly expected: Json
}

const VECTORS_DIR = resolve(process.cwd(), '..', 'forge-contracts', 'vectors')
const FILES = readdirSync(VECTORS_DIR)
  .filter((f) => f.startsWith('env_snapshot') && f.endsWith('.json'))
  .sort()

const o = (j: Json | undefined): Obj => j as Obj
const arr = (j: Json | undefined): Json[] => j as Json[]
const s = (j: Json | undefined): string => j as string
const n = (j: Json | undefined): number => j as number

function snapshotOf(v: Obj): Snapshot {
  const vars = new Map<string, EnvVar>()
  for (const [k, e] of Object.entries(o(v.vars))) {
    const x = o(e)
    vars.set(k, { type: s(x.type) as EnvVar['type'], value: s(x.value), note: s(x.note ?? '') })
  }
  return {
    env: s(v.env),
    audience: s(v.audience) as Snapshot['audience'],
    generatedAt: n(v.generatedAt),
    to: v.to === undefined ? [] : arr(v.to).map(s),
    vars,
  }
}

function snapshotJson(snap: Snapshot): Obj {
  const vars: Obj = {}
  for (const [k, v] of snap.vars) Object.defineProperty(vars, k, { value: { type: v.type, value: v.value, note: v.note }, enumerable: true })
  const out: Obj = { env: snap.env, audience: snap.audience, generatedAt: snap.generatedAt, vars }
  if (snap.audience === 'maintainers') out.to = [...snap.to]
  return out
}

const ownerKeys = (j: Json | undefined): OwnerKey[] =>
  arr(j).map((k) => ({ id: n(o(k).id), purpose: n(o(k).purpose), keyType: n(o(k).keyType), data: hexToBytes(s(o(k).data)) }))

async function epochKeyring(repoId: Uint8Array, j: Json | undefined): Promise<EpochKeyring> {
  const m = new Map<number, EpochKeys>()
  for (const e of arr(j)) m.set(n(o(e).epoch), await EpochKeys.import(repoId, n(o(e).epoch), hexToBytes(s(o(e).key))))
  return m
}

async function openOne(repoId: Uint8Array, manifest: Obj, sealed: Uint8Array, okeys: OwnerKey[], reader: Obj, epochKeys: Json | undefined): Promise<Obj> {
  try {
    const snap = await openSnapshot(
      { ownerId: s(manifest.ownerId), packHash: s(manifest.packHash), sizeBytes: n(manifest.sizeBytes) },
      sealed,
      {
        repoId,
        ownerKeys: okeys,
        reader: { identityId: hexToBytes(s(reader.identityId)), secrets: arr(reader.keys).map((k) => hexToBytes(s(k))) },
        epochKeys: await epochKeyring(repoId, epochKeys),
      },
    )
    return { snapshot: snapshotJson(snap) }
  } catch (e) {
    if (e instanceof SnapshotOpenError) return { error: e.code }
    throw e
  }
}

async function runOpen(inp: Obj): Promise<Obj> {
  const repoId = hexToBytes(s(inp.repoId))
  if (inp.cases !== undefined) {
    const results: Json[] = []
    for (const c of arr(inp.cases).map(o)) {
      results.push(await openOne(repoId, o(c.manifest), hexToBytes(s(c.sealed)), ownerKeys(c.ownerKeys), o(c.reader), c.epochKeys))
    }
    return { results }
  }
  const sealed = hexToBytes(s(inp.sealed))
  const out: Obj = {}
  if (inp.seal !== undefined) {
    const seal = o(inp.seal)
    const snap = snapshotOf(o(inp.snapshot))
    const pt = encodeSnapshot(snap)
    out.plaintextHex = bytesToHex(pt)
    let resealed: Uint8Array
    if (seal.epochKey !== undefined) {
      const keys = await EpochKeys.import(repoId, n(seal.epoch), hexToBytes(s(seal.epochKey)))
      resealed = await sealPackWithFileId(keys, pt, hexToBytes(s(seal.fileId)))
    } else {
      const sender = o(seal.sender)
      const recipients = arr(seal.recipients).map((r) => ({ identityId: hexToBytes(s(o(r).identityId)), publicKey: hexToBytes(s(o(r).pub)) }))
      const ownerId = hexToBytes(s(sender.identityId))
      expect(recipientsMatch(snap, ownerId, recipients)).toBe(true)
      resealed = await sealLetterArtifactWith(
        repoId,
        hexToBytes(s(arr(sender.keys)[0])),
        n(seal.senderKeyId),
        ownerId,
        recipients,
        pt,
        hexToBytes(s(seal.kObj)),
        hexToBytes(s(seal.fileId)),
        arr(seal.ivs).map((i) => hexToBytes(s(i))),
      )
    }
    expect(bytesToHex(resealed)).toBe(bytesToHex(sealed))
    out.packHash = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(sealed))))
  }
  const results: Json[] = []
  for (const r of arr(inp.readers).map(o)) {
    results.push(await openOne(repoId, o(inp.manifest), sealed, ownerKeys(inp.ownerKeys), o(r.reader), r.epochKeys))
  }
  out.results = results
  return out
}

function runResolve(inp: Obj): Json {
  const maintainers = new Set(arr(inp.maintainers).map(s))
  const manifests: SnapshotRef[] = arr(inp.manifests).map((m) => ({
    id: s(o(m).id),
    ownerId: s(o(m).ownerId),
    packHash: s(o(m).packHash),
    supersedes: arr(o(m).supersedes).map(s),
    createdAt: n(o(m).createdAt),
  }))
  const opened = o(inp.opened)
  const r = resolveSnapshots(maintainers, manifests, (h) => {
    const e = opened[h]
    return e !== undefined && o(e).env !== undefined ? s(o(e).env) : null
  })
  return JSON.parse(JSON.stringify(r)) as Json
}

function runExposure(inp: Obj): Json {
  const snap = (v: Json): Snapshot => {
    const x = o(v)
    const vars = new Map<string, EnvVar>(Object.entries(o(x.vars)).map(([k, val]) => [k, { value: s(val), type: 'secret', note: '' }]))
    return { env: 'x', audience: s(x.audience) as Snapshot['audience'], generatedAt: 0, to: x.to === undefined ? [] : arr(x.to).map(s), vars }
  }
  const envs = arr(inp.environments).map((e) => ({
    env: s(o(e).env),
    heads: arr(o(e).heads).map(snap),
    snapshots: arr(o(e).snapshots).map(snap),
  }))
  return {
    results: arr(inp.cases).map((c) => JSON.parse(JSON.stringify(exposureOf(envs, s(o(c).removed), o(c).heldMembersKey === true))) as Json),
  }
}

async function run(v: Vector): Promise<Json> {
  const inp = v.input
  switch (inp.op) {
    case 'format':
      return {
        results: arr(inp.cases).map((c): Json => {
          try {
            const pt = encodeSnapshot(snapshotOf(o(o(c).snapshot)))
            return { plaintextHex: bytesToHex(pt), sizeBytes: pt.length }
          } catch {
            return { tooLarge: true }
          }
        }),
      }
    case 'decode':
      return {
        results: arr(inp.cases).map((c): Json => {
          const snap = decodeSnapshot(hexToBytes(s(o(c).plaintextHex)))
          return snap === null ? { name: o(c).name ?? null, error: 'malformed' } : { name: o(c).name ?? null, snapshot: snapshotJson(snap) }
        }),
      }
    case 'open':
      return runOpen(inp)
    case 'resolve':
      return runResolve(inp)
    case 'exposure':
      return runExposure(inp)
    case 'defaultAudience':
      return { results: arr(inp.names).map((x) => defaultAudience(s(x))) }
    default:
      throw new Error(`unknown env_snapshot op ${String(inp.op)}`)
  }
}

describe('env_snapshot conformance vectors', () => {
  it('finds the corpus', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(20)
  })
  for (const f of FILES) {
    it(f, async () => {
      const v = JSON.parse(readFileSync(resolve(VECTORS_DIR, f), 'utf8')) as Vector
      expect(v.case).toBe('env_snapshot')
      expect(await run(v)).toEqual(v.expected)
    })
  }
})
