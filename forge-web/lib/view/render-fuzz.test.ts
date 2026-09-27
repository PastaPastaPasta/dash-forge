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
/** Hard wall clock for a whole batch (real batches take ~2 s), under vitest's own timeout. */
const BATCH_DEADLINE_MS = 60_000
const MIB = 1 << 20

const markdownUrl = new URL('./markdown.ts', import.meta.url)
const gitObjectsUrl = new URL('./git-objects.ts', import.meta.url)
const textDiffUrl = new URL('./text-diff.ts', import.meta.url)
const wildmatchUrl = new URL('../rules/matchesProtected.ts', import.meta.url)

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
]

describe('renderers terminate quickly on hostile input', () => {
  it('parseMarkdown: adversarial cases', async () => {
    await expectFast(markdownUrl, 'parseMarkdown', ADVERSARIAL.map((s) => [s]), 'parseMarkdown')
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
