/**
 * Look-alike names (TS-24). DPNS normalises only `o`→`0` and `i`/`l`→`1`
 * (rs-dpp v5.0.0-beta.1 `util/strings.rs`), so `dashpay`, `dash-pay`, `dashpay2`, `dashpаy` (a
 * Cyrillic `а`) and `rnyname`/`myname` are all different names anyone can register, and a name
 * with a digit 2–9 avoids the masternode vote. A name is a look-alike of another when their
 * confusable skeletons match, or differ by one edit once both are five characters or more.
 *
 * The skeleton is a small, deliberate subset of Unicode's confusables (UTS #39): what a reader
 * mistakes in a Latin name on a Forge page. It folds case and accents, maps the Cyrillic and
 * Greek letters that look Latin, joins `rn`→`m`, `vv`→`w` and `cl`→`d`, treats `0`/`o` and
 * `1`/`i`/`l` as one, and drops separators. It is a warning heuristic, not an identity check:
 * the 7…5 id and the identicon tell two identities apart.
 *
 * Pure: no storage, no network.
 */

/** Letters from other scripts that read as Latin ones. */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ӏ: 'l', ԛ: 'q', ԝ: 'w', ɡ: 'g',
  // Greek
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
}

/** The name as a reader sees it, with look-alike characters made the same. */
export function skeleton(name: string): string {
  const folded = Array.from(name.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, ''))
    .map((c) => HOMOGLYPHS[c] ?? c)
    .join('')
  return folded
    .replace(/[\s._-]/g, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/cl/g, 'd')
    .replace(/0/g, 'o')
    .replace(/[1il|]/g, 'l')
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

/**
 * Whether `a` could be mistaken for `b`. The same name, as written, is not a look-alike: a page
 * names the same thing, and two identities never share a DPNS name.
 */
export function looksLike(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return false
  const [sa, sb] = [skeleton(a), skeleton(b)]
  if (sa === '' || sb === '') return false
  if (sa === sb) return true
  return Math.min(sa.length, sb.length) >= FUZZY_MIN && editDistance(sa, sb, 1) <= 1
}
