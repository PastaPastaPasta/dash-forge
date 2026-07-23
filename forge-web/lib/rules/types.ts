/**
 * FORGE_RULES_V1 — shared type definitions.
 *
 * These are the TypeScript half of the cross-client-parity contract. Every type here
 * mirrors a struct in `crates/forge-core/src/rules.rs` and deserializes the same
 * `forge-contracts/vectors/*.json` shapes (camelCase, `createdAt` in ms). The rules are
 * PURE: callers fetch documents (refUpdate / config / event / token-history / flatIndex)
 * and hand them in as plain objects; the only clock is the consensus `createdAt`.
 */

/** A git object id, hex-encoded. All-zero (any length) or empty string = the null oid. */
export type Oid = string

/** A single append-only `refUpdate` / `protectedRefUpdate` document, flattened. */
export interface RefUpdate {
  /** Document `$id` — the deterministic tiebreak when two updates share `createdAt`. */
  readonly id: string
  /** `sha256(refName)`, hex — the indexed key a ref is looked up by. */
  readonly refNameHash: string
  /** The ref name itself, e.g. `refs/heads/main` — matched against protected globs. */
  readonly refName: string
  /** Recorded previous tip (hex; null/empty = create). Pivot for divergence detection. */
  readonly prevOid?: Oid
  /** New tip (hex; null = delete). */
  readonly newOid: Oid
  /** The pusher set the force flag. */
  readonly force?: boolean
  /** `true` iff this arrived via the MAINTAIN-gated `protectedRefUpdate` type. */
  readonly protected?: boolean
  /** Document `$ownerId` — the pusher, surfaced as the resolved tip's author. */
  readonly author: string
  /** Consensus `$createdAt` (ms). The clock for ordering and as-of protection. */
  readonly createdAt: number
}

/** A `config` document, flattened to what protection resolution needs. */
export interface ConfigDoc {
  /** Document `$id` — tiebreak when two configs share `createdAt`. */
  readonly id?: string
  /** Consensus `$createdAt` (ms). */
  readonly createdAt: number
  /** git-`wildmatch` globs; empty means nothing is protected as-of this config. */
  readonly protectedPatterns?: readonly string[]
}

/** One live tip of a diverged ref. */
export interface RefHead {
  /** Document `$id` of the update that set this tip (total-order tiebreak). */
  readonly id: string
  /** The tip commit. */
  readonly oid: Oid
  /** Pusher of the update that set this tip. */
  readonly author: string
  /** `createdAt` of that update. */
  readonly createdAt: number
}

/** The resolved state of a single ref after folding its update history. */
export type RefState =
  | { readonly state: 'unborn' }
  | {
      readonly state: 'resolved'
      readonly oid: Oid
      readonly author: string
      readonly createdAt: number
    }
  | { readonly state: 'diverged'; readonly heads: readonly RefHead[] }

/** Which repo token a history record concerns (§2.1). */
export type TokenKind = 'write' | 'maintain'

/** A token-history operation (§2.1 grant/suspend/revoke lifecycle). */
export type TokenOp = 'mint' | 'freeze' | 'unfreeze' | 'destroy'

/** One record from the system token-history contract. */
export interface TokenRecord {
  /** Record `$id` — tiebreak for equal `createdAt`. */
  readonly id?: string
  /** The affected identity. */
  readonly identity: string
  /** Which token. */
  readonly token: TokenKind
  /** What happened. */
  readonly op: TokenOp
  /** Consensus `$createdAt` (ms). */
  readonly createdAt: number
}

/** Whether an identity can *spend* WRITE / MAINTAIN at a point in time. */
export interface Holdings {
  /** Holds an unfrozen WRITE balance (can push). */
  readonly write: boolean
  /** Holds an unfrozen MAINTAIN balance (can protected-push / configure). */
  readonly maintain: boolean
}

/** A collaboration `event` kind (§2.3 numeric kinds 1–10, string-tagged in vectors). */
export type EventKind =
  | 'close'
  | 'reopen'
  | 'merge'
  | 'labelAdd'
  | 'labelRemove'
  | 'assign'
  | 'unassign'
  | 'retarget'
  | 'draft'
  | 'ready'

/** A single `event` document (§2.3), flattened for the fold. */
export interface Event {
  /** Document `$id` — tiebreak for equal `createdAt`. */
  readonly id?: string
  /** The issue/PR this event targets. */
  readonly targetId?: string
  /** What happened. */
  readonly kind: EventKind
  /** Document `$ownerId` — the actor whose authorization is checked as-of `createdAt`. */
  readonly actor: string
  /** Kind-dependent payload: label name, assignee id, or retarget base ref. */
  readonly value?: string | null
  /** Merge commit oid (kind `merge` only). */
  readonly oid?: Oid | null
  /** Consensus `$createdAt` (ms). */
  readonly createdAt: number
}

/** Resolved issue state after folding its `event` log. `labels`/`assignees` sorted+deduped. */
export interface IssueState {
  readonly open: boolean
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
}

/** Resolved PR state after folding its `event` log. */
export interface PrState {
  readonly open: boolean
  readonly merged: boolean
  readonly draft: boolean
  readonly baseRef: string | null
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
}

/** One row of a `flatIndex` browse artifact (a full recursive tree listing entry). */
export interface FlatIndexEntry {
  /** Repo-relative path. */
  readonly path: string
  /** Object id at that path. */
  readonly oid: Oid
  /** git file mode (e.g. `100644`, `100755`, `40000`, `160000`). */
  readonly mode: number
  /** Blob size in bytes (0 for trees/gitlinks). */
  readonly size?: number
}

/** A `flatIndex` snapshot: the recursive tree at `tip`, path-sorted. */
export interface FlatIndex {
  /** The commit whose tree this indexes. */
  readonly tip: Oid
  /** Path-sorted entries. */
  readonly entries: readonly FlatIndexEntry[]
}

/** A single path change within a commit's tree diff. */
export type PathChange =
  | { readonly op: 'upsert'; readonly path: string; readonly oid: Oid; readonly mode: number; readonly size?: number }
  | { readonly op: 'delete'; readonly path: string }

/** One commit's worth of tree changes, to be layered on a flatIndex in order. */
export interface TreeDiff {
  /** The commit these changes produce — becomes the overlaid tip once applied. */
  readonly commit: Oid
  /** Path add/modify/delete changes introduced by this commit. */
  readonly changes?: readonly PathChange[]
}

/**
 * The commit-graph ancestry relation, supplied by the caller as a predicate.
 * `isAncestor(a, b)` is true iff `a === b` or `a` is a transitive ancestor of `b`.
 */
export type IsAncestor = (ancestor: string, descendant: string) => boolean

/** Build an {@link IsAncestor} predicate from an explicit `[ancestor, descendant]` closure. */
export function ancestryFromPairs(pairs: ReadonlyArray<readonly [string, string]>): IsAncestor {
  return (a, d) => a === d || pairs.some(([pa, pd]) => pa === a && pd === d)
}
