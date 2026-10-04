/**
 * Release provenance (epic E5, TS-04): what a release's tag pointed at when the release was
 * first published, and whether the tag or the release's assets changed since. Everything comes
 * from the chain: the tag's ref updates and config timeline (non-deletable), and the release's
 * revisions (no deletes; an edit is a new revision).
 *
 * A release names no commit of its own on a public repo, so its baseline is the tag's tip when
 * its first revision was published, folded by {@link resolveRef} over the updates written by
 * then. A release that records its commit (`pin`: a sealed release's `target`, or a later
 * `release.targetOid`) is judged against that instead. A tag first pushed after the release
 * (an import that wrote the release before the code) takes its first tip as the baseline, and
 * says so.
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
  /** The commit (or tag object) the release itself records, when it records one. */
  readonly pin?: string | null
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
}

/** The tag or the assets differ from what was first published: a reader shows it in red. */
export function provenanceAltered(p: ReleaseProvenance): boolean {
  return (
    p.tag === 'moved' ||
    p.tag === 'deleted' ||
    p.tag === 'diverged' ||
    p.tag === 'missing' ||
    p.assets.added.length + p.assets.removed.length + p.assets.replaced.length > 0
  )
}

const byKey = (a: { readonly createdAt: number; readonly id: string }, b: { readonly createdAt: number; readonly id: string }): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const tipOf = (s: RefState): ProvenanceTip | null => (s.state === 'resolved' ? { oid: s.oid, by: s.author, at: s.createdAt } : null)

const sameAncestry = (a: string, b: string): boolean => a === b

function assetChanges(first: ProvenanceRevision, newest: ProvenanceRevision): AssetChanges {
  const was = new Map(first.assets.map((a) => [a.name, a.sha256.toLowerCase()]))
  const now = new Map(newest.assets.map((a) => [a.name, a.sha256.toLowerCase()]))
  const sorted = (xs: string[]): string[] => xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
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
  const atPublish = tipOf(resolveRef(valid.filter((u) => u.createdAt <= publishedAt), input.configs, input.refNameHash, sameAncestry))
  const later = valid.filter((u) => u.createdAt > publishedAt)
  const firstLater = later.find((u) => !isNullOid(u.newOid))
  const pin = input.pin && !isNullOid(input.pin) ? input.pin.toLowerCase() : null
  const lateTag = atPublish === null && firstLater !== undefined
  const tagBaseline = atPublish ?? (firstLater ? { oid: firstLater.newOid, by: firstLater.author, at: firstLater.createdAt } : null)
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
  }
}
