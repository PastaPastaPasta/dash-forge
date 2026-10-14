/**
 * The web's reader of a member's narrower branches (`branch-ring.ts`) over mocked reads and real
 * seals: every kind-10 letter fetched, checked against its `packHash` and opened as the reader;
 * letters to others, tampered bytes, unreadable copies and other letter types skipped; the
 * audience resolved now from the member documents; the per-session cache and its retry; and how
 * the product names an audience.
 */

import { getPublicKey } from '@noble/secp256k1'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import { BranchKey, branchKeyLetterToTyped, bytesToHex, sealKeyLetter, type BranchKeyLetter, type LetterReader, type OwnerKey, type TypedLetter } from '../private'
import type { Membership } from '../rules/v2'
import { NO_ACCESS_TEXT, RING_RETRY_MS, branchRingFor, narrowLabel, narrowerText, readBranchRing, type RingSources } from './branch-ring'
import type { RepoRef } from './contract'
import type { PackManifest } from './packs'
import type { PrivateSession } from './private-session'

const REPO = new Uint8Array(32).fill(0x11)
const REPO_ID = base58Encode(REPO)
const secret = (b: number) => new Uint8Array(32).fill(b)
const party = (b: number) => {
  const bytes = new Uint8Array(32).fill(b + 100)
  return { b, id: base58Encode(bytes), bytes, pub: getPublicKey(secret(b), true) }
}
const owner = party(1)
const mara = party(2) // a maintainer
const will = party(3) // a writer
const ids = (...ps: { id: string }[]) => ps.map((p) => p.id).sort()
const MEMBERS: Membership[] = [
  { identity: mara.id, role: 'maintainer', createdAt: 1 },
  { identity: will.id, role: 'writer', createdAt: 1 },
  { identity: party(9).id, role: 'bot', createdAt: 1 },
]
const FIX = 'refs/heads/sec/fix'

async function sha256Hex(b: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b))))
}

/** `from` seals `typed` to themselves and `to`, as a stored kind-10 manifest with its bytes. */
async function letter(n: number, from: ReturnType<typeof party>, to: ReturnType<typeof party>[], typed: TypedLetter): Promise<{ m: PackManifest; bytes: Uint8Array }> {
  const slots = [from, ...to].map((p) => ({ identityId: p.bytes, publicKey: p.pub }))
  const bytes = await sealKeyLetter(REPO, secret(from.b), 4, from.bytes, slots, typed)
  const m = { packHash: await sha256Hex(bytes), kind: 10, sizeBytes: bytes.length, documentId: `l${n}`, uploader: from.id, createdAtBlockHeight: 100 + n } as unknown as PackManifest
  return { m, bytes }
}

function sources(stored: { m: PackManifest; bytes: Uint8Array }[], reader: ReturnType<typeof party>, opts: { failFetch?: string } = {}): RingSources {
  const r: LetterReader = { identityId: reader.bytes, secrets: [secret(reader.b)] }
  return {
    manifests: async () => stored.map((s) => s.m),
    fetch: async (m) => {
      if (m.documentId === opts.failFetch) throw new Error('unreachable')
      return (stored.find((s) => s.m.documentId === m.documentId) as { bytes: Uint8Array }).bytes
    },
    ownerKeys: async (id): Promise<OwnerKey[]> => {
      const p = [owner, mara, will].find((x) => x.id === id)
      return p === undefined ? [] : [{ id: 4, purpose: 1, keyType: 0, data: p.pub }]
    },
    withReader: (use) => use(r),
  }
}

const maintainersLetter = (keys: BranchKey[], to: string[]): BranchKeyLetter => ({ name: FIX, keys, audience: { group: 'maintainers', also: [] }, to })

describe('readBranchRing', () => {
  it('opens the letters addressed to the reader and folds them; skips the rest', async () => {
    const k0 = BranchKey.fromBytes(new Uint8Array(32).fill(7))
    const good = await letter(1, owner, [mara], branchKeyLetterToTyped(maintainersLetter([k0], ids(owner, mara))))
    // to someone else: not a recipient
    const other = await letter(2, owner, [will], branchKeyLetterToTyped({ name: 'refs/heads/other', keys: [BranchKey.fromBytes(new Uint8Array(32).fill(8))], audience: { group: null, also: [will.id] }, to: ids(owner, will) }))
    // bytes that don't hash to the manifest's packHash
    const tampered = await letter(3, owner, [mara], branchKeyLetterToTyped({ ...maintainersLetter([k0], ids(owner, mara)), name: 'refs/heads/tampered' }))
    const last = tampered.bytes.length - 1
    tampered.bytes = tampered.bytes.slice()
    tampered.bytes[last] = (tampered.bytes[last] as number) ^ 1
    // a copy that can't be fetched, and a key letter of another type
    const unfetched = await letter(4, owner, [mara], branchKeyLetterToTyped({ ...maintainersLetter([k0], ids(owner, mara)), name: 'refs/heads/gone' }))
    const otherType = await letter(5, owner, [mara], { type: 'note', v: 1, fields: { text: 'hi' } })
    const held = await readBranchRing(REPO_ID, owner.id, MEMBERS, sources([good, other, tampered, unfetched, otherType], mara, { failFetch: 'l4' }))
    expect([...held.ring.branches.keys()]).toEqual([FIX])
    expect(held.ring.get(FIX)?.holders).toEqual(ids(owner, mara))
    // Maintainers now: the owner and the maintainers, never a writer or a bot
    expect([...(held.people.get(FIX) ?? [])].sort()).toEqual(ids(owner, mara))
    expect(held.ring.writeKeys(FIX)?.gen).toBe(0)
  })

  it('a reader with no letter holds nothing', async () => {
    const k0 = BranchKey.fromBytes(new Uint8Array(32).fill(7))
    const good = await letter(1, owner, [mara], branchKeyLetterToTyped(maintainersLetter([k0], ids(owner, mara))))
    const held = await readBranchRing(REPO_ID, owner.id, MEMBERS, sources([good], will))
    expect(held.ring.isEmpty).toBe(true)
  })

  it('a later generation from the same chain extends it; one from another chain is ignored', async () => {
    const k0 = BranchKey.fromBytes(new Uint8Array(32).fill(7))
    const k1 = BranchKey.fromBytes(new Uint8Array(32).fill(9))
    const first = await letter(1, owner, [mara], branchKeyLetterToTyped(maintainersLetter([k0], ids(owner, mara))))
    const next = await letter(2, owner, [], branchKeyLetterToTyped(maintainersLetter([k0, k1], ids(owner))))
    const rogue = await letter(3, will, [owner], branchKeyLetterToTyped(maintainersLetter([BranchKey.fromBytes(new Uint8Array(32).fill(3))], ids(owner, will))))
    const held = await readBranchRing(REPO_ID, owner.id, MEMBERS, sources([first, next, rogue], owner))
    const b = held.ring.get(FIX)
    expect(b?.gen).toBe(1)
    expect(b?.holders).toEqual(ids(owner))
    expect(held.ring.ignored.map((i) => i.reason)).toEqual(['otherChain'])
  })
})

describe('branchRingFor', () => {
  afterEach(() => vi.useRealTimers())

  const repoWith = (laneId: string): RepoRef =>
    ({ repoId: REPO_ID, ownerId: owner.id, visibility: 'public', lane: { id: laneId, closed: false, members: MEMBERS, network: 'devnet', reader: mara.id } as unknown as PrivateSession }) as unknown as RepoRef

  it('reads once per members-key session, and is null without one', async () => {
    const k0 = BranchKey.fromBytes(new Uint8Array(32).fill(7))
    const good = await letter(1, owner, [mara], branchKeyLetterToTyped(maintainersLetter([k0], ids(owner, mara))))
    let reads = 0
    const src = (): RingSources => {
      reads++
      return sources([good], mara)
    }
    const repo = repoWith('lane-a')
    const a = await branchRingFor({} as never, repo, src)
    const b = await branchRingFor({} as never, repo, src)
    expect(a).toBe(b)
    expect(reads).toBe(1)
    expect(a?.ring.get(FIX)).toBeDefined()
    expect(await branchRingFor({} as never, { ...repo, lane: undefined }, src)).toBeNull()
  })

  it('a failed read is null, and read again after a while', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let fail = true
    const src = (): RingSources => ({
      ...sources([], mara),
      manifests: async () => {
        if (fail) throw new Error('node down')
        return []
      },
    })
    const repo = repoWith('lane-b')
    expect(await branchRingFor({} as never, repo, src)).toBeNull()
    fail = false
    expect(await branchRingFor({} as never, repo, src)).toBeNull()
    vi.setSystemTime(Date.now() + RING_RETRY_MS + 1)
    expect((await branchRingFor({} as never, repo, src))?.ring.isEmpty).toBe(true)
  })
})

describe('how an audience is named', () => {
  it('as narrow.rs labels it, and as a branch row says it', () => {
    expect(narrowLabel({ group: 'maintainers', also: [] })).toBe('Maintainers')
    expect(narrowLabel({ group: 'writers', also: [] })).toBe('Writers and maintainers')
    expect(narrowLabel({ group: 'members', also: [will.id] })).toBe('All members + 1 person')
    expect(narrowLabel({ group: null, also: [will.id, mara.id] })).toBe('2 people')
    expect(narrowerText({ group: 'maintainers', also: [] }, 3)).toBe('Maintainers only · visible to 3 people')
    expect(narrowerText({ group: 'writers', also: [mara.id] }, 1)).toBe('Writers and maintainers + 1 person only · visible to 1 person')
    expect(narrowerText({ group: null, also: [will.id, mara.id] }, 2)).toBe('Specific people only · visible to 2 people')
    expect(NO_ACCESS_TEXT).toBe("A branch you don't have access to")
  })
})
