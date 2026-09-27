/**
 * Hang / ReDoS property tests for every renderer that walks untrusted text with loops or
 * regexes (D-900). Comments cannot be deleted and there is no moderation, so one input that
 * freezes a renderer freezes that page for everyone, permanently.
 *
 * Each batch runs in a worker with a hard deadline (see `fuzz-fixtures.ts`): a regression
 * that loops forever fails here instead of hanging CI. `FORGE_FUZZ_CASES` raises the case
 * count for a local soak (e.g. `FORGE_FUZZ_CASES=10000 pnpm vitest run render-fuzz`).
 */

import { describe, expect, it } from 'vitest'

import { nastyString, prng, runWithDeadline } from './fuzz-fixtures'

const CASES = Number(process.env.FORGE_FUZZ_CASES ?? 400)
/** Inputs up to 20 KB (UTF-16 units). */
const MAX_LEN = 20_000
/**
 * Per-input budget for inputs up to 20 KB. Locally the slowest is a few ms; the slack absorbs
 * GC pauses and slow shared CI runners. A regression back to polynomial time costs seconds.
 */
const PER_CALL_MS = 250
/** Budget for a 1 MiB worst case (the largest document that is parsed at all): ~50 ms locally. */
const MIB_CALL_MS = 3_000
/**
 * Heap for the deep-nesting case: a 1 MiB document nested 31 spans deep parses in
 * ~50 MB. Re-deriving per-span tables at every level took several hundred.
 */
const NESTING_HEAP_MB = 160
/** Hard wall clock for a whole batch (real batches take ~2 s), under vitest's own timeout. */
const BATCH_DEADLINE_MS = 60_000
const MIB = 1 << 20

const markdownUrl = new URL('./markdown.ts', import.meta.url)
const gitObjectsUrl = new URL('./git-objects.ts', import.meta.url)
const textDiffUrl = new URL('./text-diff.ts', import.meta.url)
const wildmatchUrl = new URL('../rules/matchesProtected.ts', import.meta.url)
const suggestionUrl = new URL('../rules/suggestion.ts', import.meta.url)

/** Run `calls` against `fn`, asserting the batch finishes and no single call exceeds budget. */
async function expectFast(
  url: URL,
  fn: string,
  calls: unknown[][],
  label: string,
  budgetMs = PER_CALL_MS,
): Promise<void> {
  const result = await runWithDeadline(url, fn, calls, BATCH_DEADLINE_MS)
  expect(result.timedOut, `${label}: batch did not finish (hang)`).toBe(false)
  if (result.timedOut) return
  const worst = JSON.stringify(calls[result.slowestIndex])?.slice(0, 300)
  expect(result.slowest, `${label}: slowest input ${result.slowest.toFixed(1)} ms: ${worst}`).toBeLessThan(budgetMs)
}

/** `count` random nasty strings from a fixed seed, so a failure reproduces. */
function corpus(seed: number, count: number, maxLen = MAX_LEN): string[] {
  const rand = prng(seed)
  return Array.from({ length: count }, () => nastyString(rand, maxLen))
}

/** Hand-picked worst cases for each class of bug the audit found. */
const ADVERSARIAL: readonly string[] = [
  '<'.repeat(MAX_LEN),
  '<kbd>'.repeat(MAX_LEN / 5),
  '<a href="x">'.repeat(MAX_LEN / 12),
  '<details>\n'.repeat(MAX_LEN / 10),
  '<div>'.repeat(MAX_LEN / 5) + '\n' + '</div>'.repeat(MAX_LEN / 6),
  '[!['.repeat(MAX_LEN / 3),
  '[![a](b)]('.repeat(MAX_LEN / 10),
  '[a]: b\n'.repeat(MAX_LEN / 7) + '[a] '.repeat(MAX_LEN / 4),
  '[x]['.repeat(MAX_LEN / 4),
  '\\'.repeat(MAX_LEN),
  '&#'.repeat(MAX_LEN / 2),
  '  \n'.repeat(MAX_LEN / 3),
  'https://x.io/' + ')'.repeat(MAX_LEN),
  'https://x.io/' + '.'.repeat(MAX_LEN),
  '`['.repeat(MAX_LEN / 2),
  '# a' + ' '.repeat(MAX_LEN) + 'x',
  '<pre>\na' + '\n'.repeat(MAX_LEN) + 'b\n</pre>',
  'İ'.repeat(MAX_LEN / 2) + '<kbd>x</kbd>',
  '[a ['.repeat(MAX_LEN / 4) + '](x)',
  '<!--'.repeat(MAX_LEN / 4),
  '<!--\n'.repeat(MAX_LEN / 5),
  'a <!-- x '.repeat(MAX_LEN / 9),
  '![a]['.repeat(MAX_LEN / 5),
  'a__'.repeat(MAX_LEN / 3),
  '<a name="x">'.repeat(MAX_LEN / 12),
  '\u0001'.repeat(MAX_LEN / 2) + '[a](\u0001 x)',
  '# a\u2028',
  '# a\u2029',
  '## Feature\u2028\u2028- item',
  '- a\u2028',
  '1. a\u2029',
  '> a\u2028',
  '*\u2028*\u2028*',
  'a\rb\r# c\r',
  '['.repeat(MAX_LEN),
  '!['.repeat(MAX_LEN / 2),
  '[x'.repeat(MAX_LEN / 2),
  '[a](b'.repeat(MAX_LEN / 5),
  '![a](b'.repeat(MAX_LEN / 6),
  '[a]('.repeat(MAX_LEN / 4),
  '`x'.repeat(MAX_LEN / 2),
  '**x'.repeat(MAX_LEN / 3),
  '__x'.repeat(MAX_LEN / 3),
  '~~x'.repeat(MAX_LEN / 3),
  '*x'.repeat(MAX_LEN / 2),
  '_x'.repeat(MAX_LEN / 2),
  'http://'.repeat(MAX_LEN / 7),
  '>'.repeat(MAX_LEN),
  '> '.repeat(MAX_LEN / 2),
  '>\n'.repeat(MAX_LEN / 2),
  ('|'.repeat(100) + '\n').repeat(MAX_LEN / 101),
  'a|b\n'.repeat(MAX_LEN / 4),
  'a|b\n---|---\n' + '|'.repeat(MAX_LEN),
  '- '.repeat(MAX_LEN / 2),
  '-' + ' '.repeat(MAX_LEN),
  ' '.repeat(MAX_LEN) + 'x',
  '```\n'.repeat(MAX_LEN / 4),
  '\u2028'.repeat(MAX_LEN),
  'a|'.repeat(MAX_LEN / 2) + '\n' + '-|'.repeat(MAX_LEN / 2),
]

/** `unit` repeated to fill `size` characters (then `tail`). */
const fill = (size: number, unit: string, tail = ''): string =>
  unit.repeat(Math.floor((size - tail.length) / unit.length)) + tail

/** Units that stress each parser path when repeated to 1 MiB (SR-01: `[a](b` took 33 s at 10 KiB). */
const MIB_UNITS: readonly string[] = [
  '[a](b', '![a](b', '[a](b) ', '[', '![', '`x', '*x', '*x* ', '**x', '__*_a_*__ ', '~~x', 'http://',
  '- ', '>', '> ', '>\n', 'a|b\n', 'c|d\n', '- a\n', '1. a\n', '```\n', '# a\n', 'a\n\n', '\u2028', '\r', 'a|',
  '# a\u2028[b](c *d* `e` ~~f~~ | g\n> h\n- i\n',
  // D-051 / D-052: HTML, badges, references, escapes, entities, hard breaks, autolinks.
  '<kbd>', '<kbd>x', '</kbd>', '<a href="x">', '<', '<a ', '<img src="x" ', '<details>\n', '<p align="center">\n',
  '<div>\n\n', '<script>', '<!--', '[![a](b)](c) ', '[![', '[a][b] ', '[a]: x\n', '[a]\n', '\\*', '\\',
  '&amp;', '&#x', '&', 'a  \n', 'a\\\n', 'https://x.io/a." ', '<https://x.io>', '- [ ] a\n', '- [x] ',
  '<td>\n', '<table>\n<tr>\n<td>\n\n', '<pre>\n',
]

describe('renderers terminate quickly on hostile input', () => {
  it('parseMarkdown: adversarial cases', async () => {
    await expectFast(markdownUrl, 'parseMarkdown', ADVERSARIAL.map((s) => [s]), 'parseMarkdown')
  }, 120_000)

  it('parseMarkdown: 1 MiB nested and reference brackets stay under budget (review of #82)', async () => {
    const half = MIB / 2
    const calls = [
      // A failed `[` normalized its whole text as a reference label: O(n²).
      ['[a]: b\n\n' + '['.repeat(half) + ']'.repeat(half)],
      // `][ref]` labels and link destinations looked up from out-of-order positions.
      ['[a]: b\n\n[' + fill(MIB - 16, '[x][y]') + '][z]'],
      ['[' + fill(MIB - 4, '[a](b)') + ']( )'],
      ['[a]: b\n\n' + fill(MIB, '![x]')],
      ['[a]: b\n\n' + fill(MIB, '[![x][a]][a] ')],
    ]
    await expectFast(markdownUrl, 'parseMarkdown', calls, 'parseMarkdown nested brackets', MIB_CALL_MS)
  }, 120_000)

  it('parseMarkdown: 1 MiB nested spans share one set of lookups (bounded memory)', async () => {
    const depth = 31
    const body = (unit: string): string => fill(MIB - depth * 6, unit)
    const calls = [
      ['['.repeat(depth) + body('[x] ') + '](a)'.repeat(depth)],
      ['**'.repeat(depth) + body('[x] <b>y</b> ') + '**'.repeat(depth)],
      ['<b>'.repeat(depth) + body('[x] `c` ') + '</b>'.repeat(depth)],
    ]
    const result = await runWithDeadline(markdownUrl, 'parseMarkdown', calls, BATCH_DEADLINE_MS, false, NESTING_HEAP_MB)
    expect(result.timedOut).toBe(false)
    if (!result.timedOut) expect(result.slowest).toBeLessThan(MIB_CALL_MS)
  }, 120_000)

  it('parseMarkdown: 1 MiB worst cases stay under budget', async () => {
    const calls = MIB_UNITS.map((u) => [fill(MIB, u)])
    calls.push(['a|b\n---|---\n' + fill(MIB, 'c|d\n')], ['a|b\n---|---\n' + fill(MIB, '|')], [fill(MIB, '- ', 'x')])
    await expectFast(markdownUrl, 'parseMarkdown', calls, 'parseMarkdown 1 MiB', MIB_CALL_MS)
  }, 120_000)

  it(`parseMarkdown: ${CASES} random nasty inputs up to 20 KB`, async () => {
    await expectFast(markdownUrl, 'parseMarkdown', corpus(0xd900, CASES).map((s) => [s]), 'parseMarkdown')
  }, 120_000)

  it('parseCommit: hostile author/committer lines', async () => {
    const enc = new TextEncoder()
    const commit = (ident: string): Uint8Array => enc.encode(`tree x\nauthor ${ident}\ncommitter ${ident}\n\nmsg`)
    const idents = [
      ' <'.repeat(MAX_LEN),
      ' <a> 1'.repeat(MAX_LEN / 6),
      '<'.repeat(MAX_LEN) + '> 1 +0000',
      ...corpus(0xc0de, Math.ceil(CASES / 4)),
    ]
    await expectFast(gitObjectsUrl, 'parseCommit', idents.map((s) => [commit(s)]), 'parseCommit')
  }, 120_000)

  it('diffTextLines: nasty text on both sides', async () => {
    const texts = corpus(0xd1ff, Math.ceil(CASES / 4), 4_000)
    const calls = texts.map((s, i) => [s, texts[(i + 1) % texts.length] as string])
    // The diff has its own work bound (maxWork); this checks the line split around it.
    const result = await runWithDeadline(textDiffUrl, 'diffTextLines', calls, 60_000)
    expect(result.timedOut).toBe(false)
  }, 120_000)

  it('wildmatch: star-heavy protected patterns stay polynomial', async () => {
    // A pattern is at most 100 chars and a ref name 255 (the contract's maxLength).
    const calls: string[][] = [
      ['*a'.repeat(8) + '*b', 'a'.repeat(255)],
      ['*a'.repeat(49) + '*b', 'a'.repeat(255)],
      ['**/'.repeat(33), 'a/'.repeat(127)],
      ['*?'.repeat(50), 'a'.repeat(255)],
      ['[a-z]*'.repeat(16) + 'b', 'a'.repeat(255)],
      // Ref names have no length bound in resolveRef: a huge one must not allocate the full
      // pattern × text memo up front (100 × 1 MiB would be ~100 MiB).
      ['*a'.repeat(49) + '*b', 'refs/heads/' + 'a'.repeat(MAX_LEN * 5)],
    ]
    const rand = prng(0x61ab)
    const globAlphabet = ['*', '**', '?', '/', 'a', 'b', '[a-b]', '[!a]', '\\*', '{', '!']
    for (let n = 0; n < Math.ceil(CASES / 4); n++) {
      calls.push([nastyString(rand, 100, globAlphabet), nastyString(rand, 255, ['a', 'b', '/'])])
    }
    await expectFast(wildmatchUrl, 'wildmatch', calls, 'wildmatch')
  }, 120_000)
})

/** Hand-picked worst cases for the suggestion parser: fences, fence-looking runs, whitespace. */
const SUGGESTION_ADVERSARIAL: readonly string[] = [
  // An info string that starts with a word, then a long space run, then a word: a
  // `/^\s+|\s+$/` trim retries its trailing branch at every space (quadratic).
  '```x' + ' '.repeat(MAX_LEN) + 'y',
  '```suggestion' + ' '.repeat(MAX_LEN) + 'y',
  '```' + ' '.repeat(MAX_LEN),
  '```' + ' '.repeat(MAX_LEN) + 'x',
  '```suggestion' + '\t'.repeat(MAX_LEN),
  '```suggestion\n' + '``' + ' '.repeat(MAX_LEN),
  '```suggestion\n' + '```' + ' '.repeat(MAX_LEN) + 'x',
  '`'.repeat(MAX_LEN),
  '~'.repeat(MAX_LEN),
  '```\n'.repeat(MAX_LEN / 4),
  '```suggestion\n'.repeat(MAX_LEN / 14),
  '```suggestion\nx\n```\n'.repeat(MAX_LEN / 20),
  '   ```suggestion\n' + '   x\n'.repeat(MAX_LEN / 5),
  '````suggestion\n```\n'.repeat(MAX_LEN / 20),
  '\r'.repeat(MAX_LEN),
  '\r\n'.repeat(MAX_LEN / 2),
  '```suggestion \t\r'.repeat(MAX_LEN / 17),
  ' '.repeat(3) + '`'.repeat(MAX_LEN - 3),
]

/** 1 MiB units for the suggestion parser. */
const SUGGESTION_MIB_UNITS: readonly string[] = [' ', '`', '~', '```\n', '```suggestion\n', '```suggestion\nx\n```\n', '\r', '\r\n', '\t', '   ```\n']

describe('suggestion parsing terminates quickly on hostile input', () => {
  it('parseSuggestions: adversarial cases', async () => {
    await expectFast(suggestionUrl, 'parseSuggestions', SUGGESTION_ADVERSARIAL.map((s) => [s]), 'parseSuggestions')
  }, 120_000)

  it('parseSuggestions: 1 MiB worst cases stay under budget', async () => {
    const calls = SUGGESTION_MIB_UNITS.map((u) => [fill(MIB, u)])
    calls.push(
      ['```' + fill(MIB - 4, ' ', 'x')],
      ['```x' + fill(MIB - 5, ' ', 'y')],
      ['```suggestion\n```' + fill(MIB - 20, ' ', 'x')],
    )
    await expectFast(suggestionUrl, 'parseSuggestions', calls, 'parseSuggestions 1 MiB', MIB_CALL_MS)
  }, 120_000)

  it(`parseSuggestions: ${CASES} random nasty inputs up to 20 KB`, async () => {
    const alphabet = ['```', '~~~', '`', '~', 'suggestion', ' ', '\t', '\r', '\n', '\r\n', 'x', '   ', '````']
    const rand = prng(0x5ec0)
    const calls = corpus(0x5ec1, CASES).map((s) => [s])
    for (let n = 0; n < CASES; n++) calls.push([nastyString(rand, MAX_LEN, alphabet)])
    await expectFast(suggestionUrl, 'parseSuggestions', calls, 'parseSuggestions')
  }, 120_000)

  it('applySuggestion: large files and replacements stay linear', async () => {
    const big = fill(MIB, 'line\n')
    const lines = Math.floor(MIB / 5)
    const calls: unknown[][] = [
      [big, 1, lines, ''],
      [big, 1, 1, fill(MIB, '\n')],
      [big, lines, lines, fill(MIB, 'x\r\n')],
      [fill(MIB, 'a\r\n'), 2, 3, 'b'],
      [fill(MIB, '\n'), 1, 1, 'x'],
    ]
    await expectFast(suggestionUrl, 'applySuggestion', calls, 'applySuggestion 1 MiB', MIB_CALL_MS)
  }, 120_000)
})
