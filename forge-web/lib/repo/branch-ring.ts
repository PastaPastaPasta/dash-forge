/**
 * The narrower branches a member holds keys for, in the web (mixed-visibility DESIGN §4.3
 * "Narrower branches (phase 3F)", D34; forge-core `narrow::read_ring`): every kind-10 key letter of
 * the repo is fetched, checked against its manifest's `packHash` and opened as the signed-in reader
 * (`openKeyLetter`, the sender key from the manifest owner's identity only); the `branchKey` ones
 * fold into a {@link BranchRing} whose audience-now resolves against the member documents (the
 * owner in every group, as an environment's). A letter counts only when its sender (the manifest's
 * uploader) is in the audience as it resolves now, and only when its `to` lists exactly its
 * recipients, the reader among them (the next re-lettering trusts it for who holds the key); the
 * fold keeps a branch on its first chain, the keys of letters that do not count stay read-only, and
 * a letter that does not open is skipped.
 *
 * One read per members-key session ({@link branchRingFor}), ended with it; a read that fails is
 * `null` (narrower branches stay unopened, the page goes on) and is tried again after a short
 * while. Nothing it opens is stored.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { fetchIdentityKeys, ownerKeysOf, withLetterReader } from '../auth/encryption-key'
import { PACK_KIND } from '../constants'
import type { Audience } from '../env/format'
import { resolvePeople } from '../env/view'
import {
  BranchRing,
  branchKeyLetterFromTyped,
  foldBranchLetters,
  hexToBytes,
  openKeyLetter,
  privateId,
  type BranchLetterIn,
  type LetterReader,
  type OwnerKey,
} from '../private'
import type { Membership } from '../rules/v2'
import { mapPooled } from '../view/pool'
import { membersLane, type RepoRef } from './contract'
import { readManifestsOfKind, type PackManifest } from './packs'
import { onPrivateSessionsClosed, type PrivateSession } from './private-session'

/** Letters fetched at once (forge-core `narrow::FETCH_WINDOW`). */
const FETCH_WINDOW = 8
/** How long a failed read stays `null` before a page may try again. */
export const RING_RETRY_MS = 15_000

/** What a ring read makes (bound to the SDK in {@link sdkRingSources}). */
export interface RingSources {
  /** Every kind-10 manifest of the repo. */
  readonly manifests: () => Promise<readonly PackManifest[]>
  /** One manifest's stored bytes (checked against its `packHash` again when opened). */
  readonly fetch: (m: PackManifest) => Promise<Uint8Array>
  /** An identity's public keys as the letter rule takes them (`[]` when it does not exist). */
  readonly ownerKeys: (identityId: string) => Promise<readonly OwnerKey[]>
  /** Runs `use` with the reader's identity and every encryption key this browser holds for it. */
  readonly withReader: <T>(use: (reader: LetterReader) => Promise<T>) => Promise<T>
}

/** The narrower branches a reader holds, with who each is for now. */
export interface HeldBranches {
  readonly ring: BranchRing
  /** Each held branch's audience resolved now (base58), by full name. */
  readonly people: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * How the product names a narrower audience (DESIGN §10; forge-core `narrow::label`):
 * "Maintainers", "Writers and maintainers", "All members + 1 person", "2 people".
 */
export function narrowLabel(a: Audience): string {
  const people = (n: number): string => (n === 1 ? '1 person' : `${n} people`)
  const group = a.group === 'maintainers' ? 'Maintainers' : a.group === 'writers' ? 'Writers and maintainers' : a.group === 'members' ? 'All members' : null
  if (group === null) return people(a.also.length)
  return a.also.length === 0 ? group : `${group} + ${people(a.also.length)}`
}

/** A members-only branch row a member can't open (DESIGN §10): no name, tip or link. */
export const NO_ACCESS_TEXT = "A branch you don't have access to"

/** What goes before "only" for a narrower audience: {@link narrowLabel}, or "Specific people" for people alone. */
export function narrowWho(a: Audience): string {
  return a.group === null ? 'Specific people' : narrowLabel(a)
}

/**
 * Who a narrower branch is for, as its row says it (DESIGN §10): "Maintainers only · visible to 3
 * people". An audience of people only reads "Specific people only · visible to 2 people".
 */
export function narrowerText(a: Audience, people: number): string {
  return `${narrowWho(a)} only · visible to ${people === 1 ? '1 person' : `${people.toLocaleString('en-US')} people`}`
}

/** Who `audience` is for now (forge-core `narrow::resolve_now`): its group's people, the owner among them, and its people. */
export function resolveNow(audience: Audience, owner: string, members: readonly Membership[]): Set<string> {
  return resolvePeople(audience, { owner, members: [...members] })
}

/**
 * Every `branchKey` letter of repo `repoId` (base58) addressed to the reader, opened and folded
 * into a ring, each branch's audience resolved now against `members` (the repo owned by `owner`).
 * A letter that can't be fetched, doesn't open or isn't a `branchKey` v1 body is skipped; an
 * owner whose keys can't be read fails the read (as forge-core's).
 */
export async function readBranchRing(repoId: string, owner: string, members: readonly Membership[], src: RingSources): Promise<HeldBranches> {
  const id = decodeIdentifier(repoId)
  const manifests = await src.manifests()
  const fetched = await mapPooled(manifests, FETCH_WINDOW, async (m) => src.fetch(m).catch(() => null))
  const owners = [...new Set(manifests.filter((_, i) => fetched[i] !== null).map((m) => m.uploader))]
  const ownerKeys = new Map<string, readonly OwnerKey[]>(await Promise.all(owners.map(async (o) => [o, await src.ownerKeys(o)] as const)))
  const opened: BranchLetterIn[] = []
  if (owners.length > 0) {
    await src.withReader(async (reader) => {
      for (const [i, m] of manifests.entries()) {
        const sealed = fetched[i]
        if (sealed === null || sealed === undefined) continue
        const got = await openKeyLetter(id, { packHash: hexToBytes(m.packHash.toLowerCase()), sizeBytes: m.sizeBytes }, sealed, ownerKeys.get(m.uploader) ?? [], reader)
        if ('error' in got) continue
        const letter = branchKeyLetterFromTyped(got.letter)
        if (letter === null || letter === 'malformed') continue
        // `to` must list exactly the letter's recipients, the reader among them (forge-core `narrow::read_ring`)
        if (letter.to.length !== got.recipients || !letter.to.includes(base58Encode(reader.identityId))) continue
        opened.push({ id: m.documentId, height: m.createdAtBlockHeight ?? 0, sender: m.uploader, letter })
      }
    })
  }
  const fold = foldBranchLetters(opened, (sender, a) => resolveNow(a, owner, members).has(sender))
  const people = new Map<string, ReadonlySet<string>>()
  for (const [name, b] of fold.branches) people.set(name, resolveNow(b.audience, owner, members))
  const ring = await BranchRing.create(id, fold, (b) => [...(people.get(b.name) ?? [])].map((p) => privateId(p)))
  return { ring, people }
}

/** {@link RingSources} of `repo` for the reader of members-key session `lane` (its network and identity). */
export function sdkRingSources(sdk: EvoSDK, repo: RepoRef, lane: PrivateSession): RingSources {
  return {
    manifests: () => readManifestsOfKind(sdk, repo, PACK_KIND.KEY_LETTER),
    fetch: async (m) => {
      // the stored bytes, never opened as a pack (lazily: the browse plane imports this module's callers)
      const { loadStoredArtifactBytes } = await import('../view/browse-source')
      return loadStoredArtifactBytes(sdk, repo, m)
    },
    ownerKeys: async (id) => ownerKeysOf((await fetchIdentityKeys(sdk, id)) ?? []),
    withReader: (use) => withLetterReader(lane.network, lane.reader, use),
  }
}

/**
 * The narrower branches the member reading `repo` holds, read now (no cache: a role change plans
 * from the letters as they are); `null` without a members-key session. Rejects when the read fails.
 */
export async function readHeldBranches(sdk: EvoSDK, repo: RepoRef): Promise<HeldBranches | null> {
  const lane = membersLane(repo)
  if (lane === undefined || lane.closed) return null
  return readBranchRing(repo.repoId, repo.ownerId, lane.members, sdkRingSources(sdk, repo, lane))
}

/** Ring reads of this tab, by members-key session id: a session's reader, members and lifetime. */
const rings = new Map<string, { readonly read: Promise<HeldBranches | null>; failedAt?: number }>()
// Decrypted keys go with the sessions that read them (the vault locked, the key changed).
onPrivateSessionsClosed(() => rings.clear())

/**
 * The narrower branches the member reading `repo` holds (a public repo read through its
 * members-key session, {@link membersLane}), read once per session; `null` without a session, or
 * when the read failed (the letters stay unopened until a later try). Never rejects.
 */
export function branchRingFor(sdk: EvoSDK, repo: RepoRef, src: (lane: PrivateSession) => RingSources = (lane) => sdkRingSources(sdk, repo, lane)): Promise<HeldBranches | null> {
  const lane = membersLane(repo)
  if (lane === undefined || lane.closed) return Promise.resolve(null)
  const hit = rings.get(lane.id)
  if (hit !== undefined && (hit.failedAt === undefined || Date.now() - hit.failedAt < RING_RETRY_MS)) return hit.read
  const entry: { read: Promise<HeldBranches | null>; failedAt?: number } = { read: Promise.resolve(null) }
  entry.read = readBranchRing(repo.repoId, repo.ownerId, lane.members, src(lane)).catch(() => {
    entry.failedAt = Date.now()
    return null
  })
  rings.set(lane.id, entry)
  return entry.read
}
