/**
 * Release provenance (epic E5, TS-04): what a release's tag pointed at when the release was
 * first published, and whether the tag or the release's assets changed since. Everything comes
 * from the chain: the tag's ref updates and config timeline (non-deletable), and the release's
 * revisions (no deletes; an edit is a new revision).
 *
 * A release names no commit of its own on a public repo, so its baseline is the tag's tip when
 * its first revision was published, folded by {@link resolveRef} over the updates written by
 * then. A tag first pushed after the release (an import that wrote the release before the
 * code) takes its first tip as the baseline, and says so. A release that records its commit
 * (`pin`: a sealed release's `targetOid`, or a later `release.targetOid`) is judged against
 * that only when the tag named nothing at the first publish (pushed later, or deleted or racing
 * then): the tag's own history otherwise wins, because it names what the tag ref held, and an
 * annotated tag's ref names a tag object rather than the pinned commit. (A pin is compared to
 * the tag ref's tip unpeeled, so a late annotated tag reads as moved against it.) A tag deleted
 * or racing at the first publish is not a late tag: its later tip is no baseline, so a push
 * after the publish reads as a move.
 *
 * A public release records its tag's tip at publish (`target`: the first published revision's
 * `release.targetOid`). It is the baseline only when the tag named nothing then, like a pin.
 * When the tag did name something, the two must agree: a record that names another commit than
 * the tag's history (`recordDiffers`) is an altered release. A sealed pin is not compared,
 * because it may name the commit an annotated tag points at.
 *
 * Parity: forge-core `rules::release_provenance` (vectors `release_provenance__*`).
 */

import { isNullOid } from './oid'
import { resolveRef, validRefUpdates } from './resolveRef'
import type { ConfigDoc, RefState, RefUpdate } from './types'

/** One revision of a release, as provenance needs it. */
export interface ProvenanceRevision {
  readonly id: string
  readonly createdAt: number
  /** +1 a publish, 0 an edit or yank, −1 an unpublish. */
  readonly delta: number
  readonly publisher: string
  readonly assets: readonly { readonly name: string; readonly sha256: string }[]
}

export interface ProvenanceInput {
  /** `sha256(refs/tags/<tag>)`, hex. */
  readonly refNameHash: string
  /** The tag's updates, both types, any order. */
  readonly updates: readonly RefUpdate[]
  readonly configs: readonly ConfigDoc[]
  /** Every revision of the release's tag, any order. */
  readonly revisions: readonly ProvenanceRevision[]
  /** The commit (or tag object) a sealed release records, when it records one. */
  readonly pin?: string | null
  /** The tag tip a public release records (its first published revision's `targetOid`). */
  readonly target?: string | null
}

/** A tip and the update that set it. */
export interface ProvenanceTip {
  readonly oid: string
  readonly by: string
  readonly at: number
}

/** A later update that moved the tag: `to` null is a deletion. */
export interface TagMove {
  readonly id: string
  readonly at: number
  readonly by: string
  readonly from: string | null
  readonly to: string | null
}

/**
 * - `unchanged`: the tag points where it did, and never moved since.
 * - `restored`: it moved since, and points where it did again.
 * - `moved`: it points at something else now.
 * - `deleted`: it no longer exists.
 * - `diverged`: two tips race; it points nowhere for sure.
 * - `missing`: it never existed.
 */
export type TagVerdict = 'unchanged' | 'restored' | 'moved' | 'deleted' | 'diverged' | 'missing'

export interface AssetChanges {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  /** Same name, another SHA-256. */
  readonly replaced: readonly string[]
}

export interface ReleaseProvenance {
  /** The first published revision: who, when. Null when the tag has no published revision. */
  readonly published: { readonly id: string; readonly at: number; readonly by: string } | null
  /** What the tag pointed at when the release was published (or the release's own pin). */
  readonly baseline: ProvenanceTip | null
  /** `release`: the baseline is the release's own record; `tag`: the tag's history. */
  readonly pinnedBy: 'release' | 'tag'
  /** The tag was first pushed after the release was published. */
  readonly lateTag: boolean
  /** Where the tag points now; null when deleted, diverged or never pushed. */
  readonly current: ProvenanceTip | null
  /** Updates that moved the tag after the baseline was set, oldest first. */
  readonly moves: readonly TagMove[]
  readonly tag: TagVerdict
  /** The newest revision's assets against the first published revision's. */
  readonly assets: AssetChanges
  /** The tag tip a public release records (`target`), lower-cased; a sealed pin is not listed (never compared). */
  readonly recorded: string | null
  /** The release records (`target`) another tip than the tag held at the first publish. */
  readonly recordDiffers: boolean
}

/** The tag or the assets differ from what was first published: a reader shows it in red. */
export function provenanceAltered(p: ReleaseProvenance): boolean {
  return (
    p.tag === 'moved' ||
    p.tag === 'deleted' ||
    p.tag === 'diverged' ||
    p.tag === 'missing' ||
    p.assets.added.length + p.assets.removed.length + p.assets.replaced.length > 0 ||
    p.recordDiffers
  )
}

const byKey = (a: { readonly createdAt: number; readonly id: string }, b: { readonly createdAt: number; readonly id: string }): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const tipOf = (s: RefState): ProvenanceTip | null => (s.state === 'resolved' ? { oid: s.oid, by: s.author, at: s.createdAt } : null)

const sameAncestry = (a: string, b: string): boolean => a === b

/** Code-point order, as Rust orders a `String` (UTF-16 `<` differs above U+FFFF). */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0) as number)
  const y = Array.from(b, (c) => c.codePointAt(0) as number)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number)
  return x.length - y.length
}

function assetChanges(first: ProvenanceRevision, newest: ProvenanceRevision): AssetChanges {
  const was = new Map(first.assets.map((a) => [a.name, a.sha256.toLowerCase()]))
  const now = new Map(newest.assets.map((a) => [a.name, a.sha256.toLowerCase()]))
  const sorted = (xs: string[]): string[] => xs.sort(byCodePoint)
  return {
    added: sorted([...now.keys()].filter((n) => !was.has(n))),
    removed: sorted([...was.keys()].filter((n) => !now.has(n))),
    replaced: sorted([...now.entries()].filter(([n, h]) => was.has(n) && was.get(n) !== h).map(([n]) => n)),
  }
}

export function releaseProvenance(input: ProvenanceInput): ReleaseProvenance {
  const revisions = [...input.revisions].sort(byKey)
  const live = revisions.filter((r) => r.delta >= 0)
  const first = live[0]
  const newest = live[live.length - 1]
  const assets = first !== undefined && newest !== undefined ? assetChanges(first, newest) : { added: [], removed: [], replaced: [] }
  const valid = validRefUpdates(input.updates, input.configs, input.refNameHash)
  const nowState = resolveRef(input.updates, input.configs, input.refNameHash, sameAncestry)
  const current = tipOf(nowState)
  const publishedAt = first?.createdAt ?? Number.POSITIVE_INFINITY

  // The baseline: the release's own pin, else the tag's tip at the first publish, else (a tag
  // pushed later) its first tip.
  const before = valid.filter((u) => u.createdAt <= publishedAt)
  const atPublish = tipOf(resolveRef(before, input.configs, input.refNameHash, sameAncestry))
  const later = valid.filter((u) => u.createdAt > publishedAt)
  const firstLater = later.find((u) => !isNullOid(u.newOid))
  const lateTag = before.length === 0 && firstLater !== undefined
  const record = (o: string | null | undefined): string | null => (o && !isNullOid(o) ? o.toLowerCase() : null)
  const recorded = record(input.target)
  // A public record must agree with the tag's history at the first publish.
  const recordDiffers = recorded !== null && atPublish !== null && recorded !== atPublish.oid.toLowerCase()
  // The release's own record counts only when the tag named nothing at the first publish.
  const pin = atPublish === null ? (recorded ?? record(input.pin)) : null
  const tagBaseline = lateTag ? { oid: firstLater.newOid, by: firstLater.author, at: firstLater.createdAt } : atPublish
  const baseline = pin !== null ? { oid: pin, by: first?.publisher ?? '', at: publishedAt } : tagBaseline

  // Moves: each later update that changed the tip, walked in the causal order.
  const moves: TagMove[] = []
  let tip: string | null = tagBaseline?.oid ?? null
  for (const u of lateTag ? later.slice(later.indexOf(firstLater as RefUpdate) + 1) : later) {
    const to = isNullOid(u.newOid) ? null : u.newOid
    if (to === tip) continue
    moves.push({ id: u.id, at: u.createdAt, by: u.author, from: tip, to })
    tip = to
  }

  let tag: TagVerdict
  if (valid.length === 0) tag = 'missing'
  else if (nowState.state === 'diverged') tag = 'diverged'
  else if (current === null) tag = 'deleted'
  else if (baseline === null || current.oid !== baseline.oid) tag = 'moved'
  else tag = moves.length > 0 ? 'restored' : 'unchanged'

  return {
    published: first ? { id: first.id, at: first.createdAt, by: first.publisher } : null,
    baseline,
    pinnedBy: pin !== null ? 'release' : 'tag',
    lateTag,
    current,
    moves,
    tag,
    assets,
    recorded,
    recordDiffers,
  }
}
