/**
 * Ref helpers (view glue) — surface the tip oid a browse view should read for a branch,
 * honoring the diverged-ref rule (the newest-by-createdAt head is the provisional tip).
 */

import type { ResolvedRef } from '../repo'

/** The provisional tip oid of a resolved ref (diverged → newest head), or null if unborn. */
export function tipOidOf(ref: ResolvedRef | undefined): string | null {
  if (!ref) return null
  const s = ref.state
  if (s.state === 'resolved') return s.oid
  if (s.state === 'diverged') {
    const newest = [...s.heads].sort((a, b) => b.createdAt - a.createdAt)[0]
    return newest?.oid ?? null
  }
  return null
}

/** Whether a resolved ref is in the diverged state (surface a warning in the UI). */
export function isDiverged(ref: ResolvedRef | undefined): boolean {
  return ref?.state.state === 'diverged'
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
  /** The short name shown in the switcher (`main`, `v1.0`). */
  readonly name: string
  readonly ref: ResolvedRef | undefined
  readonly isTag: boolean
}

/**
 * Resolve the `?ref=` URL param against the repo's refs, falling back to the default branch
 * when the param is empty. A bare name matches branches first, then tags; a `heads/…` or
 * `tags/…` (optionally `refs/`-prefixed) param pins the kind, which is how a tag sharing a
 * branch's name stays addressable. `ref` stays undefined when nothing matches — the caller
 * surfaces "ref not found".
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
  return { name, ref: undefined, isTag: false }
}

/** The canonical `?ref=` param value for a ref: '' for the default branch, `tags/…` for tags. */
export function refParamFor(shortName: string, isTag: boolean, defaultBranch: string): string {
  if (isTag) return `tags/${shortName}`
  return shortName === defaultBranch ? '' : shortName
}
