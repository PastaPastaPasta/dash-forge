/**
 * Pure ref-name ordering (tags, branches, versions) — no SDK/WASM imports, so this module can be
 * loaded standalone (e.g. by an e2e spec asserting against the real comparator) without pulling
 * in `lib/sdk` and its `import.meta`-using WASM loader, which Playwright's test loader cannot
 * transpile. Kept separate from `releases.ts` (which needs the SDK to read release documents) for
 * exactly that reason. Parity: forge-core `tag_version`, `natural`; `compareTagNames` here is what
 * the ref switcher and the tags page use, and it is *not* what `releases.ts`'s `releaseOrder`
 * uses (that sorts by publish date, L-78 — see its own doc comment for why they diverge).
 */

/**
 * A tag's version (`v1.2.3`, `1.2`, `jq-1.7.1`, `v0.9.13.15`, `v24.0.0-rc.1`): the
 * `digits(.digits)*` run starting at the tag's first digit, and the pre-release suffix after it,
 * if any. `null` when the tag holds no number. Parity: forge-core `tag_version`.
 */
export interface TagVersion {
  /** The numeric dot-separated parts (`[24, 0, 0]`). */
  readonly parts: readonly number[]
  /** The pre-release suffix (`rc.1`), `''` for a release. */
  readonly pre: string
}

export function tagVersion(tag: string): TagVersion | null {
  const m = /(\d+(?:\.\d+)*)(.*)$/.exec(tag)
  if (m === null) return null
  const parts = m[1]!.split('.').map(Number)
  // `-rc.1`, `-beta`, `rc1`, `a1`: a suffix is a pre-release; `+build` metadata is not.
  const pre = m[2]!.replace(/\+.*$/, '').replace(/^[-.]/, '')
  return { parts, pre }
}

/** Whether `tag` names a pre-release (a version with a suffix such as `-rc.1`, `-beta`). */
export function isPrerelease(tag: string): boolean {
  return (tagVersion(tag)?.pre ?? '') !== ''
}

/**
 * `a` vs `b` by their runs of digits and of other characters (`.`, `-`, `_` separate runs and
 * are dropped): digits compare as numbers and sort before text, text compares lower-cased. So
 * `rc.10` > `rc.9`, `rc.1` = `rc1`, `RC1` = `rc1`, `1` < `beta`. Case and the dropped separators
 * mean e.g. "foo-bar", "foo_bar" and "Foo.bar" compare equal (0) — exactly forge-core `natural`,
 * which is not itself a total order; a caller that needs one adds its own tie-break (see {@link
 * compareRefNames}) rather than this function inventing one, so a plain "natural order" caller
 * gets forge-core parity, not an extra rule. Exported for {@link compareRefNames} and {@link
 * compareTagNames}, and for anything that genuinely wants ties allowed.
 */
export function naturalRuns(a: string, b: string): number {
  const runs = (s: string): (number | string)[] =>
    (s.match(/\d+|[^\d._-]+/g) ?? []).map((r) => (/^\d/.test(r) ? Number(r) : r.toLowerCase()))
  const ra = runs(a)
  const rb = runs(b)
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const x = ra[i]!
    const y = rb[i]!
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y
    } else if (typeof x === 'number') return -1
    else if (typeof y === 'number') return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return ra.length - rb.length
}

/** Raw string order: {@link compareRefNames}'s last-resort tie-break after {@link naturalRuns}. */
function byRawString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** `a` vs `b` by version, highest first: numbers compared as numbers, a release above its pre-releases. */
export function versionDesc(a: TagVersion, b: TagVersion): number {
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const d = (b.parts[i] ?? 0) - (a.parts[i] ?? 0)
    if (d !== 0) return d
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return -1
  if (b.pre === '') return 1
  return naturalRuns(b.pre, a.pre)
}

/**
 * Compare two ref names for display order (L-13 ref switcher, L-53 tags/branches pages): a name
 * with a parseable version ({@link tagVersion}) sorts by version, highest first (`v23.1.10`
 * before `v23.1.8`, not string order); a name without one falls back to natural sort ({@link
 * naturalRuns}: digit runs compare as numbers). Mixed lists put every versioned name ahead of
 * every unversioned one. Equal versions (and unversioned names) fall back to {@link
 * compareRefNames}. Reused by the ref switcher and the tags page so both sort identically.
 * `releases.ts`'s `releaseOrder` deliberately does not use this — see its doc comment.
 */
export function compareTagNames(a: string, b: string): number {
  const va = tagVersion(a)
  const vb = tagVersion(b)
  if (va !== null && vb !== null) return versionDesc(va, vb) || compareRefNames(a, b)
  if (va !== null) return -1
  if (vb !== null) return 1
  return compareRefNames(a, b)
}

/**
 * Plain name order for refs that are usually not version-like (branch names; the "name" sort
 * mode on the branches/tags pages): {@link naturalRuns}, with {@link byRawString} breaking a tie
 * ("foo-bar"/"foo_bar"/"Foo.bar" all compare equal under `naturalRuns` alone) so the order is
 * fixed rather than whatever order the caller's list happened to arrive in. Shared by the ref
 * switcher's branch sort, `compareTagNames`'s tie-break, and the branches/tags pages' "name"
 * mode, so all three agree on unversioned order (L-53).
 */
export function compareRefNames(a: string, b: string): number {
  return naturalRuns(a, b) || byRawString(a, b)
}
