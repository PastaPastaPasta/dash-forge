/**
 * The cost model against every charge measured on moutai (protocol 14, 2026-09-27; D-011):
 * each preview must be an upper bound, at most 30 % above the actual, both when the page
 * knows which subtrees exist and when it does not (every surcharge counted).
 */

import { describe, expect, it } from 'vitest'

import {
  STEADY,
  estimateChunkCredits,
  estimateCreateCredits,
  previewCreate,
  previewDelete,
  sumPreviews,
  type FirstWrite,
} from './cost'

const S = STEADY
const t = (n: number): string => 'x'.repeat(n)
const PR = { baseRefName: 'refs/heads/main', sourceRefName: 'refs/heads/feat' }

/** [label, type, data, what was first, measured credits]. */
const MEASURED: ReadonlyArray<readonly [string, string, Record<string, unknown>, FirstWrite, number]> = [
  ['issue, steady', 'issue', { title: t(9) }, S, 59_032_460],
  ['issue, steady', 'issue', { title: t(10) }, S, 59_117_220],
  ['issue + 1,000 B body', 'issue', { title: t(10), body: t(1000) }, S, 86_871_560],
  ['issue + 4,000 B body', 'issue', { title: t(10), body: t(4000) }, S, 169_118_860],
  ['issue, author first in the repo', 'issue', { title: t(10) }, { ...S, authorInRepo: true }, 68_965_360],
  ['issue, author first anywhere', 'issue', { title: t(11) }, { ...S, authorInRepo: true, author: true, contract: true }, 90_466_200],
  ['issue, repo first', 'issue', { title: t(10) }, { ...S, repo: true, authorInRepo: true }, 83_177_180],
  ['issue, repo and author first', 'issue', { title: t(9) }, { ...S, repo: true, authorInRepo: true, author: true, contract: true }, 101_499_020],
  ['issue, QA B-COST first issue (+75.8 % before)', 'issue', { title: t(14) }, { ...S, repo: true, authorInRepo: true, author: true, contract: true }, 101_610_620],
  ['comment, steady', 'comment', { body: t(10) }, S, 52_164_800],
  ['comment 1,000 B', 'comment', { body: t(1000) }, S, 81_914_740],
  ['comment 4,000 B', 'comment', { body: t(4000) }, S, 163_076_560],
  ['comment, thread first', 'comment', { body: t(10) }, { ...S, target: true }, 62_443_060],
  ['comment, thread first', 'comment', { body: t(10) }, { ...S, target: true }, 63_695_380],
  ['comment, author first', 'comment', { body: t(10) }, { ...S, author: true }, 61_841_920],
  ['comment, both first', 'comment', { body: t(10) }, { ...S, target: true, author: true }, 74_374_660],
  ['comment, QA B-COST first (+43.9 % before)', 'comment', { body: t(212) }, { ...S, target: true, author: true }, 76_432_800],
  ['event, steady', 'event', {}, S, 43_173_040],
  ['event label', 'event', { value: t(8) }, S, 43_263_200],
  ['event, thread first', 'event', {}, { ...S, target: true }, 51_271_180],
  ['event, thread and feed first', 'event', {}, { ...S, target: true, repo: true }, 59_253_160],
  ['authorEvent, steady', 'authorEvent', {}, S, 41_497_400],
  ['authorEvent, thread first', 'authorEvent', {}, { ...S, target: true }, 49_618_080],
  ['authorEvent, thread and feed first', 'authorEvent', {}, { ...S, target: true, repo: true }, 57_422_380],
  // C-1 (2026-09-28, beta.5): the ranked star, and the trending beat (platform-parity-spec §4.4)
  ['star, steady', 'star', {}, S, 17_789_160],
  ['star, steady', 'star', {}, S, 17_693_260],
  ['star, the starrer\'s first', 'star', {}, { ...S, author: true }, 26_934_380],
  ['star, repo first', 'star', {}, { ...S, repo: true }, 36_152_660],
  ['star, repo first', 'star', {}, { ...S, repo: true }, 35_991_480],
  ['star, repo and starrer first', 'star', {}, { ...S, repo: true, author: true }, 45_250_660],
  ['starBeat, steady', 'starBeat', {}, S, 15_293_260],
  ['starBeat, the identity\'s first', 'starBeat', {}, { ...S, author: true }, 21_730_680],
  ['follow, steady', 'follow', {}, S, 28_275_800],
  ['follow, author first', 'follow', {}, { ...S, author: true }, 38_412_260],
  ['follow, author and contract first', 'follow', {}, { ...S, author: true, contract: true }, 50_169_500],
  ['writer, member first', 'writer', {}, { ...S, member: true }, 46_786_280],
  ['writer, steady', 'writer', {}, S, 39_390_080],
  ['maintainer, steady', 'maintainer', {}, S, 39_738_540],
  ['patch, repo and author first', 'patch', { title: t(10), ...PR }, { ...S, repo: true, author: true, sourceRef: true }, 125_775_560],
  ['patch, repo first', 'patch', { title: t(10), ...PR }, { ...S, repo: true, sourceRef: true }, 116_227_740],
  ['patch, steady', 'patch', { title: t(10), ...PR }, S, 72_324_740],
  ['patch, new source branch', 'patch', { title: t(10), ...PR, sourceRefName: 'refs/heads/feat2' }, { ...S, sourceRef: true }, 82_114_280],
  ['review, PR first', 'review', {}, { ...S, target: true }, 41_920_980],
  ['review, PR first', 'review', {}, { ...S, target: true }, 40_152_240],
  ['review, steady', 'review', {}, S, 35_876_380],
  ['release, repo first', 'release', { tagName: 'v0.0.1' }, { ...S, repo: true }, 64_004_880],
  ['release, steady', 'release', { tagName: 'v0.0.2' }, S, 53_342_700],
  ['release + 200 B notes', 'release', { tagName: 'v0.0.3', notes: t(200) }, S, 58_413_140],
]

const over = (est: number, actual: number): number => est / actual - 1

describe('cost preview (D-011)', () => {
  it.each(MEASURED)('%s: an upper bound within +30 %% when the page knows the subtrees', (_l, type, data, first, actual) => {
    const est = estimateCreateCredits(type, data, first)
    expect(over(est, actual)).toBeGreaterThanOrEqual(0)
    expect(over(est, actual)).toBeLessThanOrEqual(0.3)
  })

  it.each(MEASURED)('%s: still an upper bound when nothing is known', (_l, type, data, _first, actual) => {
    expect(estimateCreateCredits(type, data)).toBeGreaterThanOrEqual(actual)
  })

  it('a repo creation (repo + maintainer + config) is bounded for a new and a returning owner', () => {
    const create = (first: FirstWrite) =>
      sumPreviews([
        previewCreate('repo', { name: 'cal2-mujwxyz', visibility: 'public' }, first),
        previewCreate('maintainer', {}, first),
        previewCreate('config', { defaultBranch: 'main' }, first),
      ]).credits
    // Measured: 132.7M (a returning owner, 13-byte name), 159.7M (the owner's first; QA +23.4 %).
    expect(over(create(S), 132_684_960)).toBeGreaterThanOrEqual(0)
    expect(over(create(S), 132_684_960)).toBeLessThanOrEqual(0.3)
    expect(create({})).toBeGreaterThanOrEqual(159_654_180)
    expect(over(create({}), 159_654_180)).toBeLessThanOrEqual(0.3)
  })

  it('previews an unstar and an unfollow as refunds no larger than measured (12.3M for the ranked star, 23.5M)', () => {
    expect(previewDelete('star').credits).toBeLessThan(0)
    expect(-previewDelete('star').credits).toBeLessThanOrEqual(12_251_828)
    expect(-previewDelete('follow').credits).toBeLessThanOrEqual(23_461_140)
  })
})

describe('admission (D-012)', () => {
  /** What Drive required, read from its refusals on moutai: [type, data, budget, balance]. */
  const REQUIRED: ReadonlyArray<readonly [string, Record<string, unknown>, number, number | null]> = [
    ['issue', { title: t(9) }, 99_792_000, 137_129_680],
    ['issue', { title: t(9), body: t(1000) }, 126_900_000, 164_645_680],
    ['issue', { title: t(9), body: t(4000) }, 99_792_000 + 4000 * 27_200, 246_864_480],
    ['comment', { body: t(10) }, 79_623_000, 193_644_600],
    ['comment', { body: t(1000) }, 106_434_000, 220_859_200],
    ['event', {}, 68_580_000, 132_556_980],
    ['event', { value: t(8) }, 68_823_000, 132_803_980],
    ['authorEvent', {}, 68_499_000, 93_364_380],
    ['star', {}, 47_790_000, 66_486_120],
    ['follow', {}, 48_654_000, 67_706_240],
    ['writer', {}, 55_242_000, 73_672_920],
    ['config', {}, 35_775_000, 127_529_000],
    ['patch', { title: t(10), ...PR }, 131_463_000, 177_801_200],
    ['review', {}, 45_846_000, 139_876_060],
    ['release', { tagName: 'v0.0.1' }, 66_744_000, 156_319_620],
  ]
  it.each(REQUIRED)('%s: covers what Drive requires of the key budget and the balance', (type, data, budget, balance) => {
    const { admit } = previewCreate(type, data, STEADY)
    expect(admit.budget).toBeGreaterThanOrEqual(budget)
    if (balance !== null) expect(admit.balance).toBeGreaterThanOrEqual(balance)
  })

  it('QA B-BUDGET3: a key with 90M left is refused an issue that needs 100.2M, so the check must block it', () => {
    expect(previewCreate('issue', { title: 'bob budget issue' }).admit.budget).toBeGreaterThan(100_224_000)
  })

  it('a sequence is admitted write by write, after the earlier ones spent theirs', () => {
    const a = previewCreate('star', {}, STEADY)
    const b = previewCreate('follow', {}, STEADY)
    const sum = sumPreviews([a, b])
    expect(sum.admit.budget).toBe(Math.max(a.admit.budget, a.credits + b.admit.budget))
  })
})

describe('chunk storage (review M7)', () => {
  // forge-core `cost::push_fees::chunks`, and chunks measured on moutai beta.5 (PR #127).
  it('matches the CLI and covers every measured chunk', () => {
    expect(estimateChunkCredits(1 << 20)).toBe(36_072_827_200)
    expect(estimateChunkCredits(0)).toBe(0)
    const measured: ReadonlyArray<readonly [number, number]> = [
      [15_023, 478_722_620],
      [6_627, 255_326_420],
      [1_617, 99_148_140],
      [525, 80_268_140],
    ]
    for (const [bytes, paid] of measured) {
      // A document's payload is at most 14,700 bytes; its transition carries the rest.
      expect(estimateChunkCredits(Math.min(bytes, 14_700))).toBeGreaterThanOrEqual(paid - 27_700 * Math.max(0, bytes - 14_700))
    }
    // 1 MiB measured ≈0.33 DASH; the quote stays above it.
    expect(estimateChunkCredits(1 << 20) / 1e11).toBeGreaterThan(0.33)
  })
})
