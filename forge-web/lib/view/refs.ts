/**
 * Ref helpers (view glue) — surface the tip oid a browse view should read for a branch,
 * honoring the diverged-ref rule (`heads[0]`, the newest head in `resolveRef`'s order, is the
 * provisional tip).
 */

import type { ResolvedRef } from '../repo'

/** The provisional tip oid of a resolved ref (diverged → newest head), or null if unborn. */
export function tipOidOf(ref: ResolvedRef | undefined): string | null {
  if (!ref) return null
  const s = ref.state
  if (s.state === 'resolved') return s.oid
  if (s.state === 'diverged') return s.heads[0]?.oid ?? null
  return null
}

/** Whether a resolved ref is in the diverged state (surface a warning in the UI). */
export function isDiverged(ref: ResolvedRef | undefined): boolean {
  return ref?.state.state === 'diverged'
}

/**
 * Whether a ref currently points at a commit. Enumeration surfaces every ref name that ever
 * had a push — an unborn result there means the ref was deleted (a null-oid update; Platform
 * history is append-only, so the name persists). Live-only is what browse surfaces show.
 */
export function isLive(ref: ResolvedRef): boolean {
  return tipOidOf(ref) !== null
}

/** Find a branch ref by short name (`main`) within a resolved ref list. */
export function findBranch(
  branches: readonly ResolvedRef[],
  name: string,
): ResolvedRef | undefined {
  return branches.find((b) => b.refName === `refs/heads/${name}`)
}

/** The ref a browse view displays: name, its resolved ref (undefined = no such ref), kind. */
export interface SelectedRef {
  /** The short name shown in the switcher (`main`, `v1.0`; a pinned commit's short id). */
  readonly name: string
  readonly ref: ResolvedRef | undefined
  readonly isTag: boolean
  /**
   * A commit pinned by its id (`?ref=<4 to 40 hex>`, a permalink) that no branch or tag is
   * named. A short id is resolved against the repo's objects by the view ({@link resolveTip}),
   * which says so when it matches nothing or several. It is read by id and hash-checked like any
   * object, so a permalink can only show what the repo holds; it is not checked against any ref.
   */
  readonly pinned?: string
}

/**
 * Resolve the `?ref=` URL param against the repo's refs, falling back to the default branch
 * when the param is empty. A bare name matches branches first, then tags; a `heads/…` or
 * `tags/…` (optionally `refs/`-prefixed) param pins the kind, which is how a tag sharing a
 * branch's name stays addressable. A commit id (full, or a prefix of 4+ hex digits) no ref is
 * named is a pinned commit ({@link SelectedRef.pinned}). `ref` stays undefined when nothing
 * matches — the caller surfaces "ref not found" unless the commit is pinned.
 *
 * The tip of a ref ({@link selectedTip}) may be an annotated tag's id, not a commit's: views peel
 * it ({@link resolveTip}) before reading a tree or a history from it.
 */
export function selectRef(
  branches: readonly ResolvedRef[],
  tags: readonly ResolvedRef[],
  defaultBranch: string,
  refParam: string,
): SelectedRef {
  const param = refParam || defaultBranch
  const branchOnly = /^(refs\/)?heads\//.test(param)
  const tagOnly = /^(refs\/)?tags\//.test(param)
  const name = param.replace(/^(refs\/)?(heads|tags)\//, '')
  if (!tagOnly) {
    const branch = findBranch(branches, name)
    if (branch) return { name, ref: branch, isTag: false }
  }
  if (!branchOnly) {
    const tag = tags.find((t) => t.refName === `refs/tags/${name}`)
    if (tag) return { name, ref: tag, isTag: true }
  }
  if (/^[0-9a-f]{4,40}$/i.test(param)) {
    const pinned = param.toLowerCase()
    return { name: pinned.slice(0, 7), ref: undefined, isTag: false, pinned }
  }
  return { name, ref: undefined, isTag: false }
}

/**
 * The object a view of `selected` starts from: its pinned commit id, else its ref's tip (null:
 * none). Not always a full commit id: a short pinned id, or an annotated tag's id ({@link resolveTip}).
 */
export function selectedTip(selected: SelectedRef): string | null {
  return selected.pinned ?? tipOidOf(selected.ref)
}

/** The canonical `?ref=` param value for a ref: '' for the default branch, `tags/…` for tags. */
export function refParamFor(shortName: string, isTag: boolean, defaultBranch: string): string {
  if (isTag) return `tags/${shortName}`
  return shortName === defaultBranch ? '' : shortName
}
