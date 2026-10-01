/**
 * Ref helpers (view glue) — surface the tip oid a browse view should read for a branch,
 * honoring the diverged-ref rule (`heads[0]`, the newest head in `resolveRef`'s order, is the
 * provisional tip).
 */

import type { ResolvedRef } from '../repo'
import type { RefState } from '../rules'
import { compareRefNames } from '../repo/ref-order'

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
 * A ref and path pasted from a GitHub URL with the host swapped (QW2-024): `/tree/feat/flatpak/doc`
 * cannot say where the ref ends, so the 404 shim reads its first segment as the ref (`feat`) and
 * the rest as the path (`flatpak/doc`). When `refParam` names no branch or tag, this is the
 * longest `refParam/…` made of the path's leading segments that does, and the path left after it
 * (`feat/flatpak`, `doc`), as GitHub resolves such a URL. Null when none does, or with no path.
 */
export function splitRefPath(
  branches: readonly ResolvedRef[],
  tags: readonly ResolvedRef[],
  refParam: string,
  path: string,
): { readonly ref: string; readonly path: string } | null {
  if (refParam === '') return null
  // Only a ref that is no branch or tag is split: a real one stays what the URL says.
  if (selectRef(branches, tags, '', refParam).ref !== undefined) return null
  const segments = path.split('/').filter((s) => s !== '')
  for (let n = segments.length; n >= 1; n--) {
    const ref = [refParam, ...segments.slice(0, n)].join('/')
    if (selectRef(branches, tags, '', ref).ref !== undefined) return { ref, path: segments.slice(n).join('/') }
  }
  return null
}

/**
 * The object a view of `selected` starts from: its pinned commit id, else its ref's tip (null:
 * none). Not always a full commit id: a short pinned id, or an annotated tag's id ({@link resolveTip}).
 */
export function selectedTip(selected: SelectedRef): string | null {
  return selected.pinned ?? tipOidOf(selected.ref)
}

/**
 * The ref whose proven tip a pinned commit is (the default branch first, then other branches,
 * then tags), for the Verification card: a permalink to a branch's tip is as verified as the
 * branch (QW3-043). Only a full commit id matches; a short one is resolved against objects, not
 * refs. Undefined when no ref's resolved tip is that commit.
 */
export function pinnedAt(
  pinned: string,
  branches: readonly ResolvedRef[],
  tags: readonly ResolvedRef[],
  defaultBranch: string,
): { readonly name: string; readonly state: RefState } | undefined {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pinned)) return undefined
  const named = (r: ResolvedRef): string => r.refName.replace(/^refs\/(?:heads|tags)\//, '')
  const ordered = [...branches.filter((b) => named(b) === defaultBranch), ...branches.filter((b) => named(b) !== defaultBranch), ...tags]
  const hit = ordered.find((r) => r.state.state === 'resolved' && r.state.oid === pinned)
  return hit === undefined ? undefined : { name: named(hit), state: hit.state }
}

/** The canonical `?ref=` param value for a ref: '' for the default branch, `tags/…` for tags. */
export function refParamFor(shortName: string, isTag: boolean, defaultBranch: string): string {
  if (isTag) return `tags/${shortName}`
  return shortName === defaultBranch ? '' : shortName
}

/**
 * Whether a ref's short name matches the ref switcher / tags / branches filter box (L-13,
 * L-14, L-53): case-insensitive substring, so typing "23.1" narrows a 575-tag list to those
 * containing it. An empty (or whitespace-only) query matches every name.
 */
export function matchesRefQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  return q === '' || name.toLowerCase().includes(q)
}

/* The New PR form's params (L-30, L-47): `?base=master&head=develop` as GitHub writes them. */

/** A branch name as a ref name: `develop`, `heads/develop` or `refs/heads/develop` → `refs/heads/develop`. */
export function branchRefName(param: string): string {
  const name = param.trim().replace(/^(refs\/)?heads\//, '')
  return name === '' ? '' : `refs/heads/${name}`
}

/**
 * The New PR form's head key (`<repoId>:refs/heads/<name>`) for a `?head=` param: a short or full
 * branch name of this repo, or already a key (`<repoId>:<branch>`, a fork's branch).
 */
export function headKeyOf(param: string, repoId: string): string {
  const p = param.trim()
  if (p === '') return ''
  const colon = p.indexOf(':')
  // A key names a repo id (base58, no slash) before the colon; a ref name never holds one.
  if (colon > 0 && !p.slice(0, colon).includes('/')) return `${p.slice(0, colon)}:${branchRefName(p.slice(colon + 1))}`
  return `${repoId}:${branchRefName(p)}`
}

/** Branches for a picker: the default branch first, then by name. */
export function sortBranches<T extends Pick<ResolvedRef, 'refName'>>(branches: readonly T[], defaultBranch: string): T[] {
  const def = `refs/heads/${defaultBranch}`
  return [...branches].sort((a, b) => {
    if (a.refName === def) return -1
    if (b.refName === def) return 1
    // The ref switcher's order (L-53), so both pickers list branches alike.
    return compareRefNames(a.refName, b.refName)
  })
}
