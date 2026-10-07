/**
 * The browser's environments reader (`loader.ts`) and what the page shows (`view.ts`), over real
 * seals: a maintainer reads production (Maintainers) and dev (Members), a writer reads dev only, an
 * outsider counts both and fetches nothing, a writer's change is ignored with the warning, two
 * maintainers' changes conflict, and the removal checklist names what a member could read.
 */

import { describe, expect, it, vi } from 'vitest'
import { getPublicKey } from '@noble/secp256k1'

import { base58Encode } from '../auth/base58'
import { EpochKeys, type EpochResolution, type LetterReader, type OwnerKey } from '../private'
import { sealMaintainersSnapshot, sealMembersSnapshot } from './codec'
import type { EnvVar, Snapshot } from './format'
import { MAX_SEALED, currentOf, readEnvironments, type EnvKeys, type EnvManifest, type EnvSources } from './loader'
import { conflictHeadline, environmentsView, exposureLine, hiddenLine, ignoredWarning, removalView, unreadableLine, utc } from './view'

const repoId = new Uint8Array(32).fill(0x11)
const secret = (b: number) => new Uint8Array(32).fill(b)
const party = (b: number) => ({ identityId: new Uint8Array(32).fill(b + 100), publicKey: getPublicKey(secret(b), true) })
const alice = party(1) // maintainer
const carol = party(3) // maintainer
const bob = party(2) // writer
const eve = party(4) // outsider
const id = (p: { identityId: Uint8Array }) => base58Encode(p.identityId)
const A = id(alice)
const B = id(bob)
const C = id(carol)

const v = (value: string): EnvVar => ({ value, type: 'secret', note: '' })
function snap(env: string, vars: Record<string, string>, over: Partial<Snapshot> = {}): Snapshot {
  return { env, audience: 'members', generatedAt: 1, to: [], vars: new Map(Object.entries(vars).map(([k, x]) => [k, v(x)])), ...over }
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(b))).toString('hex')
}

interface Stored {
  readonly manifest: EnvManifest
  readonly bytes: Uint8Array
}

let seq = 0
async function store(owner: string, bytes: Uint8Array, height: number, supersedes: readonly Stored[] = []): Promise<Stored> {
  seq += 1
  const manifest: EnvManifest = {
    id: `m${String(seq).padStart(3, '0')}${'x'.repeat(40)}`,
    ownerId: owner,
    packHash: await sha256Hex(bytes),
    supersedes: supersedes.map((s) => s.manifest.packHash),
    height,
    createdAt: 1_759_651_200_000 + height * 60_000,
    sizeBytes: bytes.length,
  }
  return { manifest, bytes }
}

const ownerKeys = new Map<string, OwnerKey[]>([
  [A, [{ id: 4, purpose: 1, keyType: 0, data: alice.publicKey }]],
  [C, [{ id: 2, purpose: 1, keyType: 0, data: carol.publicKey }]],
  [B, [{ id: 3, purpose: 1, keyType: 0, data: bob.publicKey }]],
])

function sources(all: readonly Stored[], maintainers = [A, C]): EnvSources & { fetch: ReturnType<typeof vi.fn> } {
  const byId = new Map(all.map((s) => [s.manifest.id, s.bytes]))
  return {
    manifests: async () => all.map((s) => s.manifest),
    maintainers: async () => maintainers,
    fetch: vi.fn(async (m: EnvManifest) => byId.get(m.id) as Uint8Array),
    ownerKeys: async (o) => ownerKeys.get(o) ?? [],
  }
}

async function membersKeys(): Promise<Map<number, EpochKeys>> {
  return new Map([[0, await EpochKeys.import(repoId, 0, secret(9))]])
}

/** A viewer: who they are, whether they hold the members key, and whether their encryption key is unlocked. */
async function viewer(p: { identityId: Uint8Array } | null, b: number, holdsMembersKey: boolean): Promise<EnvKeys> {
  const reader: LetterReader | null = p === null ? null : { identityId: p.identityId, secrets: [secret(b)] }
  return {
    repoId,
    members: holdsMembersKey ? { keys: await membersKeys(), resolution: { anchors: new Map(), members: new Set(), burned: new Set() } as unknown as EpochResolution } : null,
    withReader: (use) => use(reader),
    hasReader: reader !== null,
  }
}

async function fixture(): Promise<{ prod1: Stored; dev1: Stored; all: Stored[] }> {
  const ek = (await membersKeys()).get(0) as EpochKeys
  const to = [A, C]
  const prod1 = await store(
    A,
    await sealMaintainersSnapshot(repoId, secret(1), 4, alice.identityId, [alice, carol], snap('production', { DB_URL: 'QAMARK-prod-db', STRIPE_KEY: 'QAMARK-stripe' }, { audience: 'maintainers', to })),
    10,
  )
  const dev1 = await store(A, await sealMembersSnapshot(ek, snap('dev', { API_TOKEN: 'QAMARK-dev-token' })), 11)
  return { prod1, dev1, all: [prod1, dev1] }
}

// The members key chain's late-content rule reads anchors; a height-0 manifest is late before it does.
describe('readEnvironments', () => {
  it('a maintainer reads production and dev', async () => {
    const { all } = await fixture()
    const book = await readEnvironments(sources(all), await viewer(alice, 1, true))
    const view = environmentsView(book)
    expect(view.hidden).toBe(0)
    expect(view.cards.map((c) => [c.env, c.kind, c.audience])).toEqual([
      ['dev', 'current', 'members'],
      ['production', 'current', 'maintainers'],
    ])
    const prod = view.cards[1]
    expect(prod?.readers).toEqual([A, C])
    expect(prod?.entries.map((e) => [e.name, e.value])).toEqual([
      ['DB_URL', 'QAMARK-prod-db'],
      ['STRIPE_KEY', 'QAMARK-stripe'],
    ])
    expect(prod?.updated?.author).toBe(A)
  })

  it('a writer holding the members key reads dev and counts production', async () => {
    const { all } = await fixture()
    const book = await readEnvironments(sources(all), await viewer(bob, 2, true))
    const view = environmentsView(book)
    expect(view.cards.map((c) => c.env)).toEqual(['dev'])
    expect(view.hidden).toBe(1)
    expect(hiddenLine(view.hidden, view.cards.length)).toBe("1 more environment you can't read")
    expect(JSON.stringify([...book.opened.values()])).not.toContain('QAMARK-prod')
  })

  it('an outsider counts every environment and fetches nothing', async () => {
    const { all } = await fixture()
    const src = sources(all)
    const book = await readEnvironments(src, await viewer(null, 0, false))
    const view = environmentsView(book)
    expect(src.fetch).not.toHaveBeenCalled()
    expect(view.cards).toEqual([])
    expect(view.empty).toBe(false)
    expect(hiddenLine(view.hidden, 0)).toBe('2 environments')
  })

  it('a signed-in outsider with a key opens nothing', async () => {
    const { all } = await fixture()
    const view = environmentsView(await readEnvironments(sources(all), await viewer(eve, 4, false)))
    expect(view.cards).toEqual([])
    expect(view.hidden).toBe(2)
  })

  it('a repo without environments is empty', async () => {
    const view = environmentsView(await readEnvironments(sources([]), await viewer(alice, 1, true)))
    expect(view.empty).toBe(true)
  })

  it("ignores a writer's change and warns once, naming it", async () => {
    const { prod1, all } = await fixture()
    const forged = await store(B, await sealMaintainersSnapshot(repoId, secret(2), 3, bob.identityId, [bob, alice], snap('production', { DB_URL: 'evil' }, { audience: 'maintainers', to: [B, A] })), 20, [prod1])
    const src = sources([...all, forged])
    const book = await readEnvironments(src, await viewer(alice, 1, true))
    const prod = environmentsView(book).cards.find((c) => c.env === 'production')
    expect(prod?.kind).toBe('current')
    expect(prod?.entries.find((e) => e.name === 'DB_URL')?.value).toBe('QAMARK-prod-db')
    expect(prod?.ignored?.head.id).toBe(forged.manifest.id)
    // never fetched: only a current maintainer's snapshot is
    expect(src.fetch.mock.calls.map(([m]) => (m as EnvManifest).id)).not.toContain(forged.manifest.id)
    expect(ignoredWarning('production', prod!.ignored!, 'bob')).toBe(
      `production has a newer change by bob at ${utc(forged.manifest.createdAt)} (${forged.manifest.id.slice(0, 10)}), who isn't a maintainer now; it was ignored. Ask a maintainer to check production's values.`,
    )
    expect(environmentsView(book).ignored).toBe(1)
  })

  it('two maintainers changing production at once is a conflict naming both versions', async () => {
    const { prod1, all } = await fixture()
    const seal = (who: typeof alice, b: number, kid: number, val: string) =>
      sealMaintainersSnapshot(repoId, secret(b), kid, who.identityId, who === alice ? [alice, carol] : [carol, alice], snap('production', { DB_URL: val }, { audience: 'maintainers', to: who === alice ? [A, C] : [C, A] }))
    const x = await store(A, await seal(alice, 1, 4, 'QAMARK-x'), 30, [prod1])
    const y = await store(C, await seal(carol, 3, 2, 'QAMARK-y'), 30, [prod1])
    const book = await readEnvironments(sources([...all, x, y]), await viewer(alice, 1, true))
    const prod = environmentsView(book).cards.find((c) => c.env === 'production')
    expect(prod?.kind).toBe('conflict')
    expect(prod?.entries).toEqual([])
    expect(prod?.conflict?.headline).toBe('2 people changed production at the same time')
    expect(prod?.conflict?.versions.map((ver) => ver.entries?.[0]?.value)).toEqual(
      [x, y].sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1)).map((s) => (s === x ? 'QAMARK-x' : 'QAMARK-y')),
    )
    const cur = currentOf(book, 'production')
    expect(cur.ok).toBe(false)
  })

  it('fails closed on an unreadable latest change', async () => {
    const { prod1, all } = await fixture()
    // carol saves production for herself only: alice can name production but not read its head
    const only = await store(C, await sealMaintainersSnapshot(repoId, secret(3), 2, carol.identityId, [carol], snap('production', { DB_URL: 'z' }, { audience: 'maintainers', to: [C] })), 40, [prod1])
    const view = environmentsView(await readEnvironments(sources([...all, only]), await viewer(alice, 1, true)))
    const prod = view.cards.find((c) => c.env === 'production')
    expect(prod?.kind).toBe('unreadable')
    expect(prod?.unreadable?.reason).toBe('it was not sent to you')
    expect(prod?.entries).toEqual([])
  })

  it('treats a Members snapshot with no block height as late', async () => {
    const ek = (await membersKeys()).get(0) as EpochKeys
    const late = await store(A, await sealMembersSnapshot(ek, snap('dev', { A: '1' })), 0)
    const book = await readEnvironments(sources([late]), await viewer(alice, 1, true))
    expect(book.opened.get(late.manifest.id)).toEqual({ kind: 'late' })
    expect(environmentsView(book).hidden).toBe(1)
  })

  it('does not fetch a manifest larger than a snapshot can be', async () => {
    const { dev1 } = await fixture()
    const big = { ...dev1, manifest: { ...dev1.manifest, sizeBytes: MAX_SEALED + 1 } }
    const src = sources([big])
    const book = await readEnvironments(src, await viewer(alice, 1, true))
    expect(src.fetch).not.toHaveBeenCalled()
    expect(book.opened.get(dev1.manifest.id)).toEqual({ kind: 'refused', code: 'sizeMismatch' })
  })
})

describe('the removal checklist', () => {
  it('a writer who held the members key could read dev, not production', async () => {
    const { all } = await fixture()
    const book = await readEnvironments(sources(all), await viewer(alice, 1, true))
    const r = removalView(book, B, true)
    expect(r.exposures).toEqual([{ env: 'dev', audience: 'members', names: ['API_TOKEN'] }])
    expect(r.unreadable).toBe(0)
    expect(exposureLine('bob', r.exposures[0]!)).toBe('bob could read 1 dev value (and every past value of it). Rotate it at its source: API_TOKEN')
    expect(removalView(book, B, false).exposures).toEqual([])
  })

  it('a former maintainer named in production lists its values', async () => {
    const { all } = await fixture()
    const book = await readEnvironments(sources(all), await viewer(alice, 1, true))
    const r = removalView(book, C, false)
    expect(r.exposures).toEqual([{ env: 'production', audience: 'maintainers', names: ['DB_URL', 'STRIPE_KEY'] }])
    expect(exposureLine('carol', r.exposures[0]!)).toBe('carol could read 2 production values. Rotate them at their source: DB_URL, STRIPE_KEY')
  })

  it('names how many environments the remover cannot read', async () => {
    const { all } = await fixture()
    const r = removalView(await readEnvironments(sources(all), await viewer(bob, 2, true)), 'x', true)
    expect(r.unreadable).toBe(1)
    expect(unreadableLine('dave', 1)).toBe("You can't read 1 environment here, so it isn't listed. dave may have been able to read values there.")
  })
})

describe('copy', () => {
  it('formats times as dg does', () => {
    expect(utc(0)).toBe('1970-01-01 00:00 UTC')
    expect(utc(20_725 * 86_400_000 + 3_661_000)).toBe('2026-09-29 01:01 UTC')
  })

  it('names conflicts as dg does', () => {
    const h = (author: string) => ({ id: 'x', author, createdAt: 0 })
    expect(conflictHeadline('production', [h('a'), h('a')], false)).toBe('production was changed 2 times at the same time')
    expect(conflictHeadline('production', [h('a'), h('b')], true)).toBe('production has 2 separate histories')
  })
})
