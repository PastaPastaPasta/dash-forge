/**
 * The search box's tokenizer and free-text terms, shared by the Issues and Pull requests lists
 * (`lib/view/issue-query.ts`, which re-exports both) and the board query (`./boards`, design
 * `boards.md` §4.4). Pure, so the rules can use them without the view layer's DPNS reads.
 * forge-core `rules::search::{tokens, search_terms}` is the Rust half (vectors `search_*`).
 */

/** Split `text` into tokens, keeping `"quoted phrases"` (and `label:"two words"`) whole. */
export function searchTokens(text: string): string[] {
  const out: string[] = []
  const re = /(\S*?"[^"]*"\S*|\S+)/g
  for (const m of text.matchAll(re)) out.push(m[0])
  return out
}

/** One free-text search term: a word or a phrase, and whether a row must not hold it. */
export interface SearchTerm {
  readonly text: string
  /** `-word` or `-"a phrase"` (QW3-018); a `-` inside quotes (`"-x"`) is literal. */
  readonly not: boolean
}

/**
 * The free text's search terms (QW-021): a `"quoted phrase"` is one term, spaces and all, and
 * any other word is one term; lowercased, quotes never part of a term. A leading `-` outside
 * quotes negates the term (QW3-018); a lone `-` is a word.
 */
export function searchTerms(text: string): SearchTerm[] {
  const out: SearchTerm[] = []
  for (const m of text.toLowerCase().matchAll(/(-?)"([^"]*)"|(\S+)/g)) {
    if (m[2] !== undefined) {
      const phrase = m[2].trim()
      if (phrase !== '') out.push({ text: phrase, not: m[1] === '-' })
      continue
    }
    const word = (m[3] ?? '').replace(/"/g, '').trim()
    if (word === '') continue
    const not = word.length > 1 && word.startsWith('-')
    out.push({ text: not ? word.slice(1) : word, not })
  }
  return out
}
