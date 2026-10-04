/**
 * Look-alike names (TS-24). DPNS labels and repo names are ASCII letters, digits and `-`
 * (dpns-contract-documents.json `label`, forge-core `repo.name`), and DPNS normalises only
 * `o`→`0` and `i`/`l`→`1` (rs-dpp v5.0.0-beta.1 `util/strings.rs`). So `dashpay`, `dash-pay`,
 * `dashpay2`, `dashpai` and `rnyname`/`myname` are all different names anyone can register, and
 * a name with a digit 2–9 avoids the masternode vote. A name is a look-alike of another when
 * their skeletons match, or differ by one edit once both are five characters or more.
 *
 * The skeleton folds case, drops `-`, treats `0`/`o` and `1`/`i`/`l` as one, then joins `rn`→`m`,
 * `vv`→`w` and `cl`→`d`: what a reader mistakes in a name on a Forge page. It is a warning
 * heuristic, not an identity check: the 7…5 id and the identicon tell two identities apart.
 *
 * Pure: no storage, no network.
 */

/** The name as a reader sees it, with look-alike letters made the same. */
export function skeleton(name: string): string {
  return name
    .toLowerCase()
    .replace(/-/g, '')
    .replace(/0/g, 'o')
    .replace(/[1i]/g, 'l')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/cl/g, 'd')
}

/** Levenshtein distance, stopping once it passes `max`. */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1))
      row.push(v)
      best = Math.min(best, v)
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length] as number
}

/** Shorter skeletons are compared exactly only: one edit apart, `dash` and `dish` are just two words. */
const FUZZY_MIN = 5

/** A name ready to compare against many: its skeleton is computed once. */
export interface Comparable {
  readonly name: string
  readonly skeleton: string
}

export function comparable(name: string): Comparable {
  return { name, skeleton: skeleton(name) }
}

/**
 * Whether `a` could be mistaken for `b`. The same name, as written, is not a look-alike unless
 * `sameCounts` (two repos may share a name; two identities never share a DPNS name).
 */
export function looksLike(a: Comparable | string, b: string, sameCounts = false): boolean {
  const ca = typeof a === 'string' ? comparable(a) : a
  if (ca.name.toLowerCase() === b.toLowerCase()) return sameCounts && b !== ''
  const sb = skeleton(b)
  if (ca.skeleton === '' || sb === '') return false
  if (ca.skeleton === sb) return true
  return Math.min(ca.skeleton.length, sb.length) >= FUZZY_MIN && editDistance(ca.skeleton, sb, 1) <= 1
}
