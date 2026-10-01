/**
 * The object a browse view starts from (L-01, L-32): what a `?ref=` names, peeled.
 *
 * A ref's tip is whatever was pushed: a commit for a branch or a lightweight tag, an annotated tag
 * object for most release tags (`v23.1.8`), rarely a tag of a tree or a blob. A `?ref=` may also
 * be a commit's short id. {@link resolveTip} turns any of those into the object to read: a short
 * id through the locator's prefix index, then through any annotated tags to the commit (or tree,
 * or blob) they name.
 *
 * Cost: one object read per tag followed, plus the read of the object the chain ends on, which the
 * view reads next anyway (the reader memoizes it, and a commit is primed into the history memo).
 * The answer is cached for the session: an object id names the same bytes in every repo (they are
 * hash-checked), so a tag's target is a fact about the id, and a warm view paints with it at once
 * ({@link peekTip}). Only `{ oid, type }` is kept: never a tag's name or message, which in a
 * private repo is decrypted content.
 */

import { MissingObjectError } from '../browse'
import { CommitIdError, resolveCommitOid, type PrefixReader } from './commit-log'
import { MalformedObjectError, OID_HEX } from './git-objects'
import { primeCommit } from './path-history'
import { trimOldest } from './pool'
import { commitRootTree, ObjectTypeError, peel, readCommit, type ObjectReader, type Peeled } from './tree-nav'

/** What a full id peels to: the object's id and type, nothing a tag says about itself. */
export type PeeledTip = Pick<Peeled, 'oid' | 'type'>

/** Ids kept per cache (under a hundred bytes each: a tags list of a big repo fits). */
const KEEP = 4000
/** Verified answers: the chain was read to its end. */
const verified = new Map<string, PeeledTip>()
/**
 * Listing answers (the tags list): a tag's DECLARED target type, trusted without reading the
 * target. Kept apart so a view never takes one for a verified answer.
 */
const declared = new Map<string, PeeledTip>()
const inflight = new Map<string, Promise<PeeledTip>>()
/** Short ids resolved, per set of readers of one repo context (a short id is repo-relative). */
const shortIds = new WeakMap<object, Map<string, string>>()
/** The same, by repo, for lookups made with no reader at hand (the About card). */
const shortIdsByRepo = new Map<string, Map<string, string>>()

/** A cache hit, moved to the newest end so a long session drops what it has not used lately. */
function hit(cache: Map<string, PeeledTip>, id: string): PeeledTip | undefined {
  const known = cache.get(id)
  if (known !== undefined) {
    cache.delete(id)
    cache.set(id, known)
  }
  return known
}

function remember(cache: Map<string, PeeledTip>, id: string, { oid, type }: Peeled): PeeledTip {
  const tip: PeeledTip = { oid, type }
  cache.set(id, tip)
  trimOldest(cache, KEEP)
  return tip
}

/** The full id a short one resolved to in this reader's repo, if it has been. */
function fullIdOf(reader: ObjectReader, tip: string): string | undefined {
  const id = tip.toLowerCase()
  return OID_HEX.test(id) ? id : shortIds.get(reader.memoScope ?? reader)?.get(id)
}

/** What `tip` peels to, when that is verified already (a warm view paints with it at once). */
export function peekTip(reader: ObjectReader, tip: string): PeeledTip | undefined {
  const id = fullIdOf(reader, tip)
  return id === undefined ? undefined : hit(verified, id)
}

/** What a tag declares it names, from a listing's peel or a verified one (the tags list's chips). */
export function peekDeclared(tip: string): PeeledTip | undefined {
  return hit(verified, tip) ?? hit(declared, tip)
}

/**
 * The commit `tip` is known to peel to (a short id through what `repoKey`'s views resolved it to),
 * else `tip` itself: for lookups keyed by a view's commit (the About card's facts) made where no
 * reader is at hand. Null stays null.
 */
export function peeledCommitOf(tip: string | null, repoKey?: string): string | null {
  if (tip === null) return null
  const id = tip.toLowerCase()
  const full = OID_HEX.test(id) ? id : (repoKey === undefined ? undefined : shortIdsByRepo.get(repoKey)?.get(id))
  if (full === undefined) return tip
  const known = verified.get(full)
  return known?.type === 'commit' ? known.oid : full
}

/**
 * Resolve a view's starting object: a short id to the one commit or tag it names (failing with a
 * `CommitIdError` when it names none, or several), then through any annotated tags. The result
 * is a commit, a tree or a blob; {@link rootTreeOf} reads a tree from the first two. `repoKey`
 * records a short id's answer for {@link peeledCommitOf}; `pinned` says the id came from the URL,
 * not from a ref, so one the repo does not hold is "Commit not found", not a missing object.
 */
export async function resolveTip(
  reader: PrefixReader,
  tip: string,
  { repoKey, pinned = false }: { readonly repoKey?: string; readonly pinned?: boolean } = {},
): Promise<PeeledTip> {
  let id = fullIdOf(reader, tip)
  if (id === undefined) {
    id = await resolveCommitOid(reader, tip)
    const scope = reader.memoScope ?? reader
    const map = shortIds.get(scope) ?? new Map<string, string>()
    shortIds.set(scope, map)
    map.set(tip.toLowerCase(), id)
    if (repoKey !== undefined) {
      const byRepo = shortIdsByRepo.get(repoKey) ?? new Map<string, string>()
      shortIdsByRepo.set(repoKey, byRepo)
      byRepo.set(tip.toLowerCase(), id)
      trimOldest(byRepo, KEEP)
    }
  } else if (pinned && !reader.incomplete && (await reader.locate?.(id)) === null) {
    // A full id in the URL that no pack holds: say so as the commit page does.
    throw new CommitIdError('not-found', tip)
  }
  const result = await peelCached(reader, id)
  if (result.type === 'commit') {
    // Into the history memo through this reader: the walks that start here skip a cold read.
    await primeCommit(reader, result.oid).catch((e: unknown) => {
      if (!(e instanceof MissingObjectError)) throw e
    })
  }
  return result
}

/**
 * {@link peel} a full lowercase id through the session caches (concurrent calls share one read).
 * `verify: false` trusts a tag's declared target type (a listing of many tags: one read per tag),
 * and its answer goes to the listing cache only, never to the verified one.
 */
export function peelCached(reader: ObjectReader, key: string, { verify = true }: { readonly verify?: boolean } = {}): Promise<PeeledTip> {
  const known = verify ? hit(verified, key) : peekDeclared(key)
  if (known !== undefined) return Promise.resolve(known)
  const flight = `${verify ? 'v' : 'd'}:${key}`
  let p = inflight.get(flight)
  if (p === undefined) {
    // A chain with no tag in it is verified whichever way it was read.
    p = peel(reader, key, { verify }).then((r) => remember(verify || r.tags.length === 0 ? verified : declared, key, r))
    inflight.set(flight, p)
    const clear = (): void => {
      if (inflight.get(flight) === p) inflight.delete(flight)
    }
    p.then(clear, clear)
  }
  return p
}

/**
 * The root tree a peeled tip shows: a commit's tree, or the tree a tag names. A tag of a blob has
 * none ({@link ObjectTypeError}).
 */
export async function rootTreeOf(reader: ObjectReader, tip: PeeledTip): Promise<string> {
  if (tip.type === 'tree') return tip.oid
  if (tip.type === 'commit') return (await commitRootTree(reader, tip.oid)).tree
  throw new ObjectTypeError(tip.oid, tip.type, 'tree')
}

/**
 * A read failure that reading again cannot fix (L-63): the object is hash-checked, so a wrong
 * type or a malformed object stays that way, and an id that is ambiguous or names no commit
 * keeps doing so. A view shows these without "Try again". A missing object or commit is not one
 * of them: a push can bring it, and "Try again" re-resolves the repo.
 */
export function isPermanentReadError(e: unknown): boolean {
  if (e instanceof ObjectTypeError || e instanceof MalformedObjectError) return true
  return e instanceof CommitIdError && e.kind !== 'not-found'
}

/** Tip dates read, by the tip's id (a fact about the id, as a peel is). */
const dates = new Map<string, Promise<number>>()

/**
 * When a ref's tip was made, for the branches and tags lists (QW2-023, GitHub's "Updated"): an
 * annotated tag's tagger date (the outermost tag that has one), else the commit's committer date
 * (a branch, a lightweight tag, an old tag without a tagger line). 0 when it has none (a tag of a
 * tree or a blob, with no tagger). The tip is peeled as the tags list peels it ({@link peel},
 * trusting a tag's declared commit), then its commit read when no tag dates it; cached for the
 * session. Rejects when the tip cannot be read.
 */
export function tipDateCached(reader: ObjectReader, tip: string): Promise<number> {
  const key = tip.toLowerCase()
  let p = dates.get(key)
  if (p === undefined) {
    p = tipDate(reader, key)
    dates.set(key, p)
    p.catch(() => {
      if (dates.get(key) === p) dates.delete(key)
    })
    trimOldest(dates, KEEP)
  }
  return p
}

async function tipDate(reader: ObjectReader, tip: string): Promise<number> {
  const peeled = await peel(reader, tip, { verify: false })
  const tagged = peeled.tags.find((t) => (t.tagger?.when ?? 0) > 0)?.tagger?.when
  if (tagged !== undefined) return tagged
  return peeled.type === 'commit' ? (await readCommit(reader, peeled.oid)).committer.when : 0
}

/** Test hook. */
export function resetTipCache(): void {
  verified.clear()
  declared.clear()
  inflight.clear()
  shortIdsByRepo.clear()
  dates.clear()
}
