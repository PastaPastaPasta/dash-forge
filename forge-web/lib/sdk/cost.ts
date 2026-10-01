/**
 * Write cost estimates — calibrated against measured forge-v2 costs on devnet moutai.
 *
 * evo-sdk 4.2 has no fee estimator for a document transition, so the preview is a model:
 *
 *   (steady-state base of the type + first-write surcharges + 27,500 credits per text byte)
 *   × {@link HEADROOM}
 *
 * - The base is what a document of the type costs when every index subtree it writes into
 *   already exists (a repo's tenth issue).
 * - A **first write** also creates subtrees: a repo's first issue creates the repo's issue
 *   subtrees, an author's first issue their `$ownerId` subtree, a thread's first comment its
 *   `targetId` subtree. Each adds storage. {@link FirstWrite} names which ones a write may
 *   create; the UI reads that cheaply where it can (`lib/repo/first-write.ts`) and otherwise
 *   leaves it unknown, which counts every surcharge. A preview is an upper bound either way.
 * - {@link HEADROOM} covers the few percent the same write varies by as the trees grow.
 *
 * Measured on moutai, protocol 14, 2026-09-27 (balance deltas, credits):
 *   issue 10 B title: steady 59.0M / 59.1M; + 1,000 B body 86.9M; + 4,000 B 169.1M;
 *     author's first in the repo 69.0M; author's first anywhere (and first forge-collab
 *     write) 90.5M; repo's first 83.2M; repo's and author's first 101.5M.
 *   comment 10 B: steady 52.2M; 1,000 B 81.9M; 4,000 B 163.1M; thread's first 62.4M / 63.7M;
 *     author's first 61.8M; both 74.4M.
 *   event: steady 43.2M; thread's first 51.3M; thread's and repo feed's first 59.3M.
 *   authorEvent: steady 41.5M; thread's first 49.6M; both 57.4M.
 *   star: 27.4M; repo's first 37.7M. Unstar refunds 22.0M (32.3M for the repo's last star).
 * Measured on moutai, protocol 14 (drive / evo-sdk 4.2.0-beta.5), 2026-09-28, the C-1 shapes
 * (platform-parity-spec §4.4):
 *   star with its ranked axis: steady 17.7M (the starrer's other stars exist), the starrer's
 *     first in the repo's value tree 27.0M, the repo's first 36.0M. Unstar refunds 12.3M
 *     (23.3M for the repo's last star).
 *   starBeat (trending): steady 14.4M–15.3M; the identity's first 20.7M–21.7M. Never refunded.
 *   watch: the star's shape without the ranked axis (17.4M steady, repo's first 27.6M).
 *   follow: 28.3M; author's first 38.4M; author's first and first forge-collab write 50.2M.
 *     Unfollow refunds 23.5M (34.1M for the last).
 *   repo + maintainer + config: 132.7M; the owner's first repo (first forge-core write) 159.7M.
 *     After the fresh forge-core of the beta.6 reset (repo documentsCountable, ranked forkOf:
 *     every repo also writes the null forkOf entry and the type-wide count), measured on moutai
 *     drive 4.2.0-beta.6, 2026-09-28, with dg: 136.9M, the owner's first 166.3M; the
 *     +4.2M is repo's, within the estimate's headroom.
 *   writer / maintainer grant: 38.9M–39.7M; the member's first 46.8M.
 *   patch (10 B title): 72.3M; new source branch 82.1M; repo's first 116.2M; author's first
 *     patch anywhere as well 125.8M. review: 35.9M; the PR's first 40.2M / 41.9M.
 *   release (6 B tag): 53.3M; repo's first 64.0M; + 200 B notes 58.4M.
 *   limited key: registering 44.1M–47.1M; renewing (register + disable the old one) 27.3M.
 * Measured on bonsia (drive 4.2.0-beta.7, QA wave 3, 2026-09-30; spend-ledger balance deltas,
 * QW3-037), where several types cost more or less than on moutai:
 *   repo (fork, 62 B description) 91.4M; a first repo 81.5M–88.5M. config: a repo's first 35.5M,
 *     a later one (Settings) 27.4M–28.1M. topic 61.7M–62.6M; the repo's first 72.9M.
 *   refUpdate: an existing ref 58.7M–59.0M; a new ref name 66.0M–66.4M; the repo's first 89.4M.
 *   packManifest: 85.5M–87.4M; the repo's first 134.3M. webhook: 77.2M; the repo's first 102.1M.
 *   transition: 47.3M–56.5M; a thread's first 63M; with the repo's first of its kind 74.2M.
 *   label 33.8M–35.1M; the repo's first 41.8M. review 49.6M–49.9M; a PR's first 69.7M–78.0M.
 *   follow 37.0M (an identity's first follow of someone). A replace: the repo's description and
 *     topics 5.8M, a comment's body 7.8M.
 *
 * Platform accepts a write only when the key budget and the balance cover what Drive
 * estimates it may take, which is more than it charges: see {@link Admission}. The pre-sign
 * check (`lib/view/funds.ts`) compares against that, not the preview.
 *
 * The post-write actual (the balance change) is recorded next to each estimate in the spend
 * ledger, so drift shows up there (`ux-dx-spec.md` §4 rule 2).
 */

import { isRoleGated } from '../rules/roles'

/** 1 DASH = 1e11 credits (parity with forge-core `credits_to_dash`). */
export const CREDITS_PER_DASH = 100_000_000_000

/** Measured marginal cost of one byte of document text (storage + the processing it adds). */
export const CREDITS_PER_TEXT_BYTE = 27_500

/** Estimates are scaled by this: the same write varies by a few percent as the trees grow. */
export const HEADROOM = 1.06

/**
 * What a document of each type costs with no text in steady state (every index subtree
 * already exists), in credits. Types never measured fall back to {@link DEFAULT_BASE_CREDITS}.
 */
export const BASE_CREDITS: Readonly<Record<string, number>> = {
  // forge-core (bonsia, QA wave 3: see the header)
  repo: 66_000_000,
  maintainer: 40_000_000,
  writer: 40_000_000,
  config: 27_000_000,
  release: 53_300_000,
  label: 34_000_000,
  // An update of an existing ref (its name's subtree exists); its byte fields (the oids) are in.
  refUpdate: 56_000_000,
  protectedRefUpdate: 56_000_000,
  // Its byte fields (the pack hash) are in; its URIs are text. A chunk's fixed cost is
  // `CHUNK_FEES.flat`; `estimateChunkCredits` prices its bytes too.
  packManifest: 76_000_000,
  chunk: 140_000_000,
  // forge-collab
  issue: 59_000_000,
  patch: 72_000_000,
  comment: 52_000_000,
  event: 43_000_000,
  authorEvent: 41_500_000,
  // Bonsia (QA wave 3): 47.3M–56.5M in a thread that has one; a thread's first, and the repo's
  // first of its kind, add their subtrees (74.1M for both, QA wave 2).
  transition: 53_500_000,
  // Bonsia (QA wave 3): 49.6M–49.9M; a PR's first review 69.7M–78.0M (35.9M on moutai).
  review: 47_500_000,
  policy: 34_000_000,
  // C-1: the ranked star, steady (the starrer holds stars, the repo has some): 17.8M on moutai,
  // 19.4M on bonsia (QA wave 2, N-17)
  star: 18_500_000,
  // 28.3M on moutai; 37.0M on bonsia (QA wave 3) for a follow whose subtrees are not all known.
  follow: 31_000_000,
  starBeat: 15_300_000,
  watch: 27_400_000,
  milestone: 45_000_000,
  checkRun: 45_000_000,
  // A member's consent, one unique index and a repo reference: 30.8M on bonsia (QA wave 2, N-17).
  consent: 29_500_000,
  // Bonsia (QA wave 3): a topic 61.7M–62.6M with its name; a webhook 77.2M, its secret and ids
  // being byte fields (`webhookCost` sizes them as text would not).
  topic: 59_000_000,
  webhook: 76_000_000,
}

/**
 * Whether a create of `documentType` stores an RC2 member-roles integer the measured costs above
 * predate: the claimed role `r` on a role-gated type, or a `writer` document's `role` (one stored
 * byte each, about one text byte's credits: `RECUT-OR-NEVER.md` §6). Priced on every network: an
 * upper bound either way.
 */
function storesRoleByte(documentType: string): boolean {
  return isRoleGated(documentType) || documentType === 'writer'
}

/** Which index subtrees a create may be the first to write. Unknown fields count as first. */
export interface FirstWrite {
  /**
   * The identity's first write to this contract: Drive then also stores its identity-contract
   * nonce ({@link CONTRACT_FIRST_CREDITS}).
   */
  readonly contract?: boolean
  /** The thread's first of this type (a comment, event or review on one issue or PR). */
  readonly target?: boolean
  /** The repo's first of this type (issue, PR, event feed, star, release). */
  readonly repo?: boolean
  /** The author's first of this type in this repo (the author index's repo level). */
  readonly authorInRepo?: boolean
  /** The author's (or owner's) first of this type anywhere. */
  readonly author?: boolean
  /** The member's first membership of this role anywhere (`byMember`). */
  readonly member?: boolean
  /** The PR's source branch has no PR yet (`sourceRef`). */
  readonly sourceRef?: boolean
}

type Surcharge = Readonly<Partial<Record<keyof FirstWrite, number>>>

/** What each first subtree adds, by type (credits; measured, see the header). */
export const FIRST_WRITE_CREDITS: Readonly<Record<string, Surcharge>> = {
  issue: { repo: 14_500_000, authorInRepo: 10_500_000, author: 9_500_000 },
  comment: { target: 11_700_000, author: 10_600_000 },
  event: { target: 8_300_000, repo: 8_000_000 },
  authorEvent: { target: 8_100_000, repo: 7_800_000 },
  // C-1: the repo's first star builds its ranked value tree (+18.3M); the starrer's first star
  // their byOwner value tree (+9.2M)
  star: { repo: 18_500_000, author: 9_400_000 },
  starBeat: { author: 6_400_000 },
  watch: { repo: 10_400_000 },
  // `target`: the first follow of an identity builds its byTarget value tree, ranked since C-1
  // (not re-measured; priced like the ranked star's repo-first tree)
  follow: { author: 10_200_000, target: 18_500_000 },
  repo: { author: 9_000_000 },
  maintainer: { member: 7_400_000 },
  writer: { member: 7_400_000 },
  patch: { repo: 34_100_000, author: 9_600_000, sourceRef: 9_800_000 },
  // A PR's first review builds both of its `patchId` subtrees (bonsia, QA wave 3).
  review: { target: 20_000_000 },
  release: { repo: 10_700_000 },
  // `target`: the thread's first transition (`perTarget`); `repo`: the repo's first of its kind.
  transition: { target: 11_000_000, repo: 11_000_000 },
  label: { repo: 8_000_000 },
  config: { repo: 8_600_000 },
  topic: { repo: 10_000_000 },
  webhook: { repo: 20_000_000 },
  // `target`: the first update of this ref name (its `refState` subtree); `repo`: the repo's first
  // ref update (its `reflog` and pusher subtrees too).
  refUpdate: { target: 7_000_000, repo: 23_000_000 },
  protectedRefUpdate: { target: 7_000_000, repo: 23_000_000 },
  packManifest: { repo: 47_000_000 },
}

/** An identity's first write to a contract also stores its identity-contract nonce. */
export const CONTRACT_FIRST_CREDITS = 12_000_000

/**
 * Whether every first-write answer is known. A field left out (not read yet: `useFirstWrite`
 * answers `{}` until its reads land; or a read that failed, which `lib/repo/first-write.ts` leaves
 * out) counts its surcharge, so the preview is still the upper bound.
 */
export function firstWriteRead(first: FirstWrite): boolean {
  return (Object.keys(STEADY) as (keyof FirstWrite)[]).every((k) => first[k] !== undefined)
}

/** Nothing is a first write: every subtree exists. */
export const STEADY: FirstWrite = {
  contract: false,
  target: false,
  repo: false,
  authorInRepo: false,
  author: false,
  member: false,
  sourceRef: false,
}

/**
 * A write into a repo that already holds documents of its type and, for a ref update, a ref of
 * that name (a merge's pack and base-branch update): no repo or ref subtree to build. Whether the
 * signer has written to the contract stays unknown.
 */
export const EXISTING: FirstWrite = { repo: false, target: false }

const DEFAULT_BASE_CREDITS = 50_000_000
/** A delete of a type never measured: a conservative refund estimate. */
const DEFAULT_DELETE_CREDITS = -20_000_000

/**
 * What deleting a document gives back at least, in credits (negative = a refund). Measured on
 * moutai: unstar 22.0M (32.3M for the repo's last star), unfollow 23.5M (34.1M for the last),
 * revoking a writer 20.8M. The preview shows the smaller refund, so it never promises more.
 */
export const DELETE_CREDITS: Readonly<Record<string, number>> = {
  // C-1 measured 12.3M for an unstar that is not the repo's last (the ranked axis re-keys).
  star: -12_000_000,
  watch: -12_000_000,
  milestone: -25_000_000,
  follow: -23_000_000,
  maintainer: -20_800_000,
  writer: -20_800_000,
  release: -30_000_000,
  label: -25_000_000,
  comment: -25_000_000,
  review: -20_000_000,
  // Deleting a webhook revision (its URL and sealed secret) refunded 81.8M on bonsia (QA wave 2,
  // collab); it was promised the 20M default.
  webhook: -70_000_000,
}

/**
 * An `IdentityKeyLimitsUpdate` (top up a key's budget / expiry), signed by the master key and
 * paid from the identity balance. Measured on moutai (2026-09-26): 2,267,600 credits.
 */
export const KEY_LIMITS_UPDATE_CREDITS = 2_300_000

/**
 * Disabling a key (Settings → "Revoke on chain"): one master-key `IdentityUpdate` that only
 * disables. Measured on bonsia (QA wave 3): 1.7M–2.3M credits; the preview is the upper bound.
 */
export const KEY_DISABLE_CREDITS = 2_300_000

/**
 * An `IdentityUpdate` that adds this browser's limited key (a renewal also disables the old one
 * in the same update), signed by the master key and paid from the identity balance. Platform
 * meters it (storage + processing, no flat fee; the key's budget is a cap, not escrow), so the
 * cost depends on what the identity already holds. Measured on moutai (2026-09-27):
 * - the identity's first budgeted, contract-bound key added by an update: 44.1M (a minted
 *   identity) and 47.1M (QA B-COST sign-in);
 * - a later one, or a renewal (register + disable the old key): 27.2M-27.4M (the mobile QA
 *   pass, three registrations; a renewal here, 27.3M); on bonsia (beta.7, QA wave 2) a sign-in's
 *   key 26.8M-27.8M.
 * The preview is the upper bound for each case; the ledger records the measured actual.
 * (Disabling alone, a revoke, is {@link KEY_DISABLE_CREDITS}.)
 */
export const KEY_REGISTER_CREDITS = 48_000_000
/** Adding a key when the identity already holds a budgeted one, e.g. a renewal (see above). */
export const KEY_RENEW_CREDITS = 28_000_000
/**
 * The least adding this browser's key was measured to cost (bonsia, a sign-in's key: 26.8M): the
 * low end of a key registration's range in Settings → Spend (QW-043).
 */
export const KEY_ADD_FLOOR_CREDITS = 26_500_000

/**
 * What copy quotes for "an issue" (L-73): the preview a newcomer's first issue gets — a short
 * title and a paragraph, with every first-write surcharge, as the New issue form shows before
 * it is signed (so the sign-in sheet and the form never disagree). A steady-state issue by an
 * author who has written before costs about half this. Derived, not measured separately:
 * {@link previewCreate} is the one model.
 */
export function typicalIssueCredits(): number {
  return previewCreate('issue', { title: 'A typical issue title', body: 'x'.repeat(300) }).credits
}

/**
 * What Drive requires to be available before it accepts a write (`validate_fees_of_event`
 * v1, rs-drive-abci 4.2.0-beta.4), which is more than the write then costs:
 * - `budget`: what the signing key's remaining budget must cover (the estimated storage fee);
 * - `balance`: what the identity's balance must cover (the whole estimated fee).
 * A write short of either is refused before it runs, and nothing is charged.
 */
export interface Admission {
  readonly budget: number
  readonly balance: number
}

/**
 * Drive's requirement per type with no text, read from its refusals on moutai (2026-09-27):
 * `IdentityPublicKeyBudgetExceededError` and `IdentityInsufficientBalanceError` name it. Text
 * adds {@link ADMISSION_PER_TEXT_BYTE} to both (27.2k / 27.8k measured).
 */
export const ADMISSION_CREDITS: Readonly<Record<string, Admission>> = {
  issue: { budget: 99_600_000, balance: 136_900_000 },
  comment: { budget: 79_400_000, balance: 193_400_000 },
  event: { budget: 68_600_000, balance: 132_600_000 },
  authorEvent: { budget: 68_500_000, balance: 93_400_000 },
  star: { budget: 47_800_000, balance: 66_500_000 },
  follow: { budget: 48_700_000, balance: 67_800_000 },
  maintainer: { budget: 55_300_000, balance: 73_700_000 },
  writer: { budget: 55_300_000, balance: 73_700_000 },
  repo: { budget: 77_100_000, balance: 585_000_000 },
  config: { budget: 35_800_000, balance: 127_600_000 },
  patch: { budget: 130_400_000, balance: 176_700_000 },
  review: { budget: 45_900_000, balance: 140_000_000 },
  release: { budget: 66_600_000, balance: 156_200_000 },
}
/** What one byte of text adds to both requirements (measured 27.2k budget, 27.8k balance). */
export const ADMISSION_PER_TEXT_BYTE = 28_000
/** Margin on the measured requirements (they grow slowly with the trees, like the costs). */
const ADMISSION_MARGIN = 1.05
/** For a type never measured: requirements as a multiple of its preview (the largest seen). */
const DEFAULT_ADMISSION_FACTOR: Admission = { budget: 2, balance: 5 }

/**
 * What a small `git push` costs on Platform, in DASH, by where its packs go: the web's single
 * source for push costs (repository page, storage settings, cost card). `byo`: the pack
 * manifest, the ref update and the browse-index publish, packs in the pusher's own storage.
 * `platform`: the same plus the packs as Platform chunks, which add about `perMib` for each
 * MiB stored (≈0.0046–0.0050 DASH per 15 KB measured, 0.0055 quoted). Earlier copy said ~0.0003, the manifest-plus-ref estimate
 * without the per-document base fees (ledger D-009/D-010).
 *
 * Measured on moutai beta.5, 2026-09-27, see PR #127 (P-6; per-write balance deltas): a small push
 * 0.0021–0.0028 DASH with own storage, 0.0040–0.0046 with Platform storage; 15 KB on Platform
 * 0.0047 DASH. The G7 quick-start walkthrough agrees (0.0021 own storage; 0.0033–0.0044 Platform).
 *
 * Re-measured on bonsia (drive 4.2.0-beta.7, 2026-09-30, QA wave cli-dx; QW-080), where a push to
 * the default branch also writes its history index: own storage 0.0052 (first) and 0.0041;
 * packs on Platform 0.0040 (a tag), 0.0052 (a branch), 0.0102 and 0.0088 (the default branch,
 * whose index is a chunk too). These ranges follow bonsia.
 */
export const PUSH_COST_DASH = {
  byo: { min: 0.004, max: 0.0055 },
  platform: { min: 0.004, max: 0.011 },
  /**
   * DASH per MiB of packs on Platform, to two decimals: derived from {@link estimateChunkCredits},
   * the same calibrated chunk fees `dg` (`fmt::platform_rate`) and `git push` quote, so the web,
   * the CLI and docs/guides/costs.md say one number (~0.39 since the beta.6 chunk-tree fit).
   */
  get perMib(): number {
    return Math.round((estimateChunkCredits(1 << 20) / CREDITS_PER_DASH) * 100) / 100
  },
} as const

/** A `min–max` DASH range for copy: `0.002–0.003`. */
export function dashRange({ min, max }: { readonly min: number; readonly max: number }): string {
  return `${min}–${max}`
}

/**
 * A push's cost for copy that cannot know where the packs go (sign-in, /start, funding): both
 * figures, each named, so it never reads as a second price for the same push (QW3-038: "0.004–0.0055
 * per push" there, "a small push ≈ 0.004–0.011" on an empty repo).
 */
export function pushCostPhrase(): string {
  return `${dashRange(PUSH_COST_DASH.byo)} DASH per push with your own storage, up to ${PUSH_COST_DASH.platform.max} with packs on Platform`
}

/** A pre-sign cost preview for the confirm UI. */
export interface CostPreview {
  /** Estimated credits (an upper bound); negative when the action refunds storage. */
  readonly credits: number
  /**
   * The low end, when the charge is known to range far below `credits` (an edit pays only for
   * the text it adds): the preview then shows `min–max`, as Settings → Spend does (QW3-037).
   */
  readonly minCredits?: number
  readonly dash: number
  /** What Platform needs available to accept it (see {@link Admission}). */
  readonly admit: Admission
}

/** Credit → DASH (display). */
export function creditsToDash(credits: number): number {
  return credits / CREDITS_PER_DASH
}

/**
 * A preview for a plain credit amount. `admit` defaults to the amount itself (a master-key
 * update, say, where no key budget is involved).
 */
export function previewCredits(credits: number, admit?: Admission): CostPreview {
  const need = Math.max(0, credits)
  return { credits, dash: creditsToDash(credits), admit: admit ?? { budget: need, balance: need } }
}

/** UTF-8 bytes of every string in `data` (the text a document stores beyond its fixed shape). */
export function textBytes(data: Readonly<Record<string, unknown>>): number {
  const encoder = new TextEncoder()
  let total = 0
  const walk = (v: unknown): void => {
    if (typeof v === 'string') total += encoder.encode(v).length
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) Object.values(v).forEach(walk)
  }
  walk(data)
  return total
}

/** The first-write surcharge of `documentType` for `first` (an unknown field counts). */
export function firstWriteCredits(documentType: string, first: FirstWrite = {}): number {
  const table = FIRST_WRITE_CREDITS[documentType] ?? {}
  let total = first.contract === false ? 0 : CONTRACT_FIRST_CREDITS
  for (const [k, credits] of Object.entries(table) as [keyof FirstWrite, number][]) {
    if (first[k] !== false) total += credits
  }
  return total
}

/**
 * Estimated credits to create one `documentType` document holding `data` (an upper bound).
 * `first` says which subtrees it may create; omitted, all of them.
 */
export function estimateCreateCredits(
  documentType: string,
  data: Readonly<Record<string, unknown>> = {},
  first: FirstWrite = {},
): number {
  const base = (BASE_CREDITS[documentType] ?? DEFAULT_BASE_CREDITS) + (storesRoleByte(documentType) ? CREDITS_PER_TEXT_BYTE : 0)
  return Math.ceil((base + firstWriteCredits(documentType, first) + CREDITS_PER_TEXT_BYTE * textBytes(data)) * HEADROOM)
}

/** What Drive needs available to accept one `documentType` document holding `bytes` of text. */
export function admissionFor(documentType: string, bytes: number, credits: number): Admission {
  const measured = ADMISSION_CREDITS[documentType]
  if (!measured) {
    return { budget: Math.ceil(credits * DEFAULT_ADMISSION_FACTOR.budget), balance: Math.ceil(credits * DEFAULT_ADMISSION_FACTOR.balance) }
  }
  const text = ADMISSION_PER_TEXT_BYTE * bytes
  return {
    budget: Math.ceil((measured.budget + text) * ADMISSION_MARGIN),
    balance: Math.ceil((measured.balance + text) * ADMISSION_MARGIN),
  }
}

/** Preview for creating one document (an upper bound; see {@link estimateCreateCredits}). */
export function previewCreate(
  documentType: string,
  data: Readonly<Record<string, unknown>> = {},
  first: FirstWrite = {},
): CostPreview {
  const credits = estimateCreateCredits(documentType, data, first)
  return previewCredits(credits, admissionFor(documentType, textBytes(data), credits))
}

/** Estimated credits for a document that also stores `byteLen` bytes of byte-array fields. */
export function estimateBytesCredits(
  documentType: string,
  byteLen: number,
  data: Readonly<Record<string, unknown>> = {},
  first: FirstWrite = {},
): number {
  return estimateCreateCredits(documentType, data, first) + Math.ceil(CREDITS_PER_TEXT_BYTE * byteLen * HEADROOM)
}

/** The measured `chunk` fees, forge-core `cost::push_fees` (moutai beta.5, PR #127; the flat
 * re-fitted on the beta.6 showcase imports, where each chunk also pays for its levels of the
 * network-wide chunk tree). */
export const CHUNK_FEES = {
  /** Credits per byte of a chunk's signed transition. */
  perByte: 27_700,
  /** A chunk's cost beyond its bytes: its index entries and 16 levels of the chunk tree. */
  flat: 140_000_000,
  /**
   * Bytes a chunk's transition carries beyond its payload. Held equal to forge-core's
   * `CHUNK_OVERHEAD_BYTES` (the CLI quotes the same bound); RC2's `r` adds one byte, within the
   * fit's headroom.
   */
  overheadBytes: 130,
  /** Payload bytes per chunk document (three 4,900-byte fields, forge-core `pack::split`). */
  payload: 4900 * 3,
} as const

/**
 * Estimated credits to store `bytes` as Platform `chunk` documents: forge-core
 * `cost::push_fees::chunks`, so the web and `git push` quote the same upper bound (≈0.39 DASH
 * per MiB; measured ≈0.33). Platform storage is permanent.
 */
export function estimateChunkCredits(bytes: number): number {
  const { perByte, flat, overheadBytes, payload } = CHUNK_FEES
  const doc = (b: number) => perByte * (b + overheadBytes) + flat
  const full = Math.floor(bytes / payload)
  const rest = bytes % payload
  return full * doc(payload) + (rest > 0 ? doc(rest) : 0)
}

/**
 * What a replace (an edit) costs: the processing of a document write plus the storage of the
 * changed text. Measured on moutai (2026-09-27): a patch title replaced with one of the same
 * length 17.0M credits, a comment body grown by 10 bytes 3.9M; on bonsia (QA wave 3) the repo's
 * description and topics 5.8M, a comment's body 7.8M. The estimate is the larger fixed part plus
 * every changed byte, an upper bound: text that replaces as much text pays only for the
 * difference, so the charge is usually far below it.
 */
export const REPLACE_BASE_CREDITS = 17_000_000
/**
 * The least a replace was measured to cost (3.9M, moutai): the low end of its range in Settings →
 * Spend, so an edit charged a fraction of its upper bound is not flagged as a miss (QW3-037).
 */
export const REPLACE_MIN_CREDITS = 3_500_000

/** Preview for replacing a document's `changes`: a range, from {@link REPLACE_MIN_CREDITS}. */
export function previewReplace(documentType: string, changes: Readonly<Record<string, unknown>> = {}): CostPreview {
  const bytes = textBytes(changes)
  const credits = REPLACE_BASE_CREDITS + CREDITS_PER_TEXT_BYTE * bytes
  // Drive estimates a replace like a create of the document; its requirement is at most that.
  const measured = ADMISSION_CREDITS[documentType]
  return { ...previewCredits(credits, measured ? admissionFor(documentType, bytes, credits) : undefined), minCredits: REPLACE_MIN_CREDITS }
}

/** Preview for deleting one document of `documentType` (usually a refund: negative credits). */
export function previewDelete(documentType: string): CostPreview {
  return previewCredits(DELETE_CREDITS[documentType] ?? DEFAULT_DELETE_CREDITS)
}

/**
 * The sum of several previews written one after another (a repo creation is three
 * documents): the credits add up, and each write must be admitted after the ones before it
 * have spent theirs.
 */
export function sumPreviews(parts: readonly CostPreview[]): CostPreview {
  let credits = 0
  let spent = 0
  let budget = 0
  let balance = 0
  for (const p of parts) {
    budget = Math.max(budget, spent + p.admit.budget)
    balance = Math.max(balance, spent + p.admit.balance)
    credits += p.credits
    spent += Math.max(0, p.credits)
  }
  return previewCredits(credits, { budget, balance })
}
