/**
 * "Make this repo public" in the web (mixed-visibility DESIGN §4.10, §10, D36, D45; §13 R6, 5A): the
 * API the Settings → Danger zone dialog builds on, and the decisions it shares with `dg repo
 * make-public` (`crates/dg/src/repo_make_public.rs`), step for step:
 *
 * - {@link makePublicCheck} (`./make-public-check`): step 0, read without signing. What becomes
 *   public in each mode, what stays private, the secret scan, old-format environments (E812), the
 *   oldest Forge that can clone it, and the cost.
 * - {@link runMakePublic} (`./make-public-run`): steps 1 to 7. The typed confirmation, the seal-off
 *   rotation (never twice for one run: a recorded seal-off epoch that is still current is kept),
 *   the check again with Everything, the flip (the owner), the first public settings, the code,
 *   nothing signed to notify, and with Everything the owner's history bundles, published last.
 * - {@link readMakePublicStatus} (`./make-public-status`): where a run stands, for any viewer.
 *
 * This module holds the shared types, the copy of the refusals, the pure decisions (which refs
 * Code only publishes by default, which are still to publish, what stops a run before anything is
 * signed, the estimate) and the run's local record: this browser's IndexedDB keeps the mode, the
 * refs and their tips, and the seal-off epoch while a run is under way (never a key or a
 * plaintext), and drops it when the run finishes.
 */

import { CONVERTED_REPO_MIN_CLIENT_VERSION, sealOffBoundary, type ActiveSealOff } from '../private'
import { idbDelete, idbGet, idbPut } from '../idb'
import type { Network } from '../constants'
import { estimateChunkCredits } from '../sdk/cost'
import { FANOUT_LEN, LOCATOR_ROW_LEN } from '../browse/locator'
import { compareStrings } from '../rules/oid'

export { CONVERTED_REPO_MIN_CLIENT_VERSION }

/** What becomes public: the chosen branches and tags, or everything members could read until now. */
export type MakePublicMode = 'codeOnly' | 'everything'

/** A branch or tag and its tip. */
export interface MakePublicRef {
  /** `refs/heads/x` or `refs/tags/x`. */
  readonly name: string
  /** Its tip (hex). */
  readonly oid: string
}

/** One possible secret in what becomes public. */
export interface MakePublicSecret {
  /** Where it is: a path (with its line), or a post ("issue #3 body"). */
  readonly place: string
  /** The rule's id (`lib/secrets` `Rule`; `describeRule` says it in words). */
  readonly rule: string
  readonly fingerprint: string
  /** A high-confidence finding: it needs an explicit allow before anything is signed. */
  readonly refuses: boolean
}

/** The discussion Everything makes public (forge-core `Census`), counted with the member's keys. */
export interface MakePublicCensus {
  readonly issues: number
  readonly prs: number
  readonly comments: number
  readonly reviews: number
  /** Earlier versions of edited issues, pull requests and comments. */
  readonly revisions: number
  /** Content maintainers hid. */
  readonly hidden: number
  /** Requests sent to bots. */
  readonly botRequests: number
  readonly releases: number
  /** Messages to specific people: they stay private in both modes. */
  readonly letters: number
  /** Posts this member can't read themselves: they become public too, uncounted. */
  readonly unread: number
  /** Who wrote what becomes public (base58). */
  readonly authors: readonly string[]
  /** Imported authors (not Forge identities), by host. */
  readonly imported: readonly { readonly host: string; readonly author: string }[]
}

/** What the check found (step 0). */
export interface MakePublicCheck {
  /** The adopted or clamped epoch cutoff used by the check and publication. */
  readonly publicationCutoff?: number
  /** User copy; non-empty: nothing may run before the flip. */
  readonly blockers: readonly string[]
  readonly notes: readonly string[]
  /** Live branches and tags written while private (what Everything publishes). */
  readonly allRefs: readonly MakePublicRef[]
  /** Code only's refs: the default branch and the tags on it, or the ones chosen. */
  readonly codeRefs: readonly MakePublicRef[]
  /** Branches deleted while private, and force-pushes (Everything opens them). */
  readonly deleted: number
  readonly forced: number
  /** Null when not computed (Code only after the flip). */
  readonly census: MakePublicCensus | null
  /** Former members whose words become public (base58). */
  readonly former: readonly string[]
  readonly codeSecrets: readonly MakePublicSecret[]
  /** Everything's scan: every object written while private, and the posts as they read now. */
  readonly everythingSecrets: readonly MakePublicSecret[]
  readonly environments: number
  /** Environments still holding values saved in the old format, by name (E812 for Everything). */
  readonly oldFormat: readonly string[]
  /** An environment this member can't read holds old-format values (E812 too). */
  readonly oldFormatUnreadable: boolean
  /** Stored copies of the code written while private that could not be fetched (Everything stops). */
  readonly unfetched: number
  /**
   * Objects each mode's branches and tags reach that this member can't read (a copy not fetched,
   * or stored under a key nobody holds now): that mode stops (E503), never publishes part of them.
   */
  readonly missingObjects: Readonly<Record<MakePublicMode, number>>
  readonly size: Readonly<Record<MakePublicMode, { readonly bytes: number; readonly objects: number }>>
  readonly estimate: Readonly<Record<MakePublicMode, { readonly credits: number; readonly storageCredits: number }>>
  /** Branches only some members can read: they stay private. */
  readonly narrowerBranches: number
  readonly minClientVersion: string
  /** The default branch (short name). */
  readonly defaultBranch: string
}

/** The signed steps after the typed confirmation (§4.10 steps 2 to 7). */
export type MakePublicStep = 'sealOff' | 'flip' | 'config' | 'code' | 'notify' | 'history'
export type StepState = 'done' | 'todo' | 'running' | 'owner' | 'skipped'

/** The steps in order. */
export const MAKE_PUBLIC_STEPS: readonly MakePublicStep[] = ['sealOff', 'flip', 'config', 'code', 'notify', 'history']

/** Where a run stands (read without signing; any viewer, members learn more). */
export interface MakePublicStatus {
  /** `made`: flipped, not finished; `public`: finished, or never private. */
  readonly phase: 'private' | 'made' | 'public'
  /** Public now and was private once. */
  readonly converted: boolean
  readonly steps: Readonly<Record<MakePublicStep, StepState>>
  /** "3 of 7 steps done": the typed confirmation is step 1, the signed steps 2 to 7. */
  readonly doneCount: number
  readonly totalSteps: number
  /** The newest conversion write seen (ms): the flip, the first public settings, a public ref, a history bundle. */
  readonly lastStepAt: number | null
  /** This browser's record of a run under way. */
  readonly record: { readonly mode: MakePublicMode; readonly refs: readonly MakePublicRef[]; readonly sealOff: number | null; readonly sealOffAt?: number | null } | null
  /**
   * The repo's key changed after the recorded run's own key change while it is still private: that
   * run can't be finished (its boundary would move), only started again on purpose.
   */
  readonly sealOffPassed: boolean
  /** Owner marker found without relying on this browser's local record. */
  readonly sealOffMarker?: Extract<ActiveSealOff, { kind: 'active' }>
  /** The record's mode, else Everything when the owner published history, else unknown. */
  readonly mode: MakePublicMode | null
}

/** One step's progress during a run. */
export interface MakePublicProgress {
  readonly step: MakePublicStep
  readonly state: StepState
  readonly detail?: string
}

/** The words the owner types to confirm (step 1). */
export const MAKE_PUBLIC_WORDS = (repoLabel: string): string => `make ${repoLabel} public`

/** The words the owner types to start a run again in place of one that can't be finished. */
export const START_OVER_WORDS = (repoLabel: string): string => `start over making ${repoLabel} public`

/** The 7 steps of §4.10 (the confirmation and the six signed ones). */
export const MAKE_PUBLIC_TOTAL_STEPS = 7

/**
 * A run or check that stops, with the copy to show and the CLI's code (`docs/errors.md`): E103 the
 * network can't, E201 a choice to make, E307 a key not held, E310 a key change pending or under
 * way, E503 code not fetched, E601 not the owner, E802 the typed words, E807 a possible secret,
 * E812 old-format environment values, E102 an unknown branch or tag; E103 also for a repo too large to make public in the browser.
 */
export class MakePublicError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    /** Possible secrets to allow (E807), each with its fingerprint. */
    readonly secrets?: readonly MakePublicSecret[],
  ) {
    super(message)
    this.name = 'MakePublicError'
  }
}

// ---------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------

export const COPY = {
  frozen: "This network's Forge can't make a private repository public yet.",
  notKeyHolder: "You don't hold this repo's current key. Ask a maintainer to repair it from the repo page.",
  markerUnreadable: "An owner config can't be opened. Repair the repo's keys before making it public (dg repo keys repair).",
  markerSize: 'Shorten the protected patterns before making this repo public.',
  markerLower: 'The local record and the owner marker differ. Publishing stops at the earliest boundary still in force.',
  repairFirst: "This repo's key needs a repair first. Repair it from the repo page, then try again.",
  noCode: 'Code only would publish no code: this repo has no default branch with commits. Choose branches and tags, or choose Everything.',
  unreadableHistory: "Some history written while private can't be published: nobody holds its key any more. It stays unreadable to everyone.",
  notOwner: 'Only the owner can make this repo public.',
  publicAlready: 'This repo is public already.',
  historyStarted: "This repo is being made public with everything: its history is published already, so Code only can't follow. Finish it with Everything.",
  sayRefs: "This browser has no record of the run that made it public: choose the branches and tags the owner chose.",
  noMode: 'Choose what becomes public: Code only or Everything.',
  sealOffPassed: (mode: MakePublicMode) =>
    mode === 'codeOnly'
      ? "The repo's key changed after this run's own key change, so finishing it would let a later Everything publish what members wrote since, which is meant to stay members-only. The repo is still private. To include that, start again."
      : "The repo's key changed after this run's own key change, so finishing it would publish what members wrote since, which is meant to stay members-only. The repo is still private. To include that, start again.",
  startOver: (at: number | null, mode: MakePublicMode) =>
    `This starts over: the earlier run's key change${at === null ? '' : ` (${new Date(at).toISOString().slice(0, 10)})`} no longer marks where publishing stops. ${mode === 'codeOnly' ? 'With Code only, what members wrote since stays members-only for now, but a later Everything would make it public.' : 'With Everything, what members wrote since then becomes public too.'}`,
  boundaryKept:
    "The repo's settings state another boundary than this run's own key change. The history published from this browser stops at the lower one, so this browser keeps its record of the run.",
  startOverUnfinished: 'This run can still be finished: choose Finish instead of starting again.',
  markerChanged: "The owner marker's boundary changed during this run. The repo is still private. Run it again to check what becomes public below that boundary.",
  runAgain: "This run found its own key change only after its check. The repo is still private. Run it again to check what becomes public below it.",
  changedSince: (ref: string) => `Not published: ${ref} changed after this run's key change.`,
  startOverPublic: 'This repo is public already, so its run can only be finished, not started again.',
  lagging: "Platform hasn't caught up yet; try again in a minute. The repo is still private.",
  stillPrivate: 'The repo is still private. Fix this, then continue.',
  words: (words: string) => `Type "${words}" to continue.`,
  tooLarge: (label: string) => `This repo is too large to make public in the browser. Use the command line: dg repo make-public ${label}`,
  oldFormat: (env: string) =>
    `Can't make everything public: environment ${env} has values saved in the old format, which would become public. Save it again, change every listed value, then mark them changed. Or choose Code only.`,
  oldFormatUnreadable:
    "Can't make everything public: an environment you can't read has values saved in the old format, which would become public. Ask its maintainers to save it again and mark its values changed.",
  unfetched: (n: number) => `Can't make everything public: ${n === 1 ? '1 stored copy' : `${n} stored copies`} of the code written while private couldn't be fetched, so they weren't checked for secrets. Try again later.`,
  secret: (place: string) => `This would publish a possible secret in ${place}. Allow it only if it isn't a secret.`,
  unknownRef: (ref: string) => `${ref} is not a branch or tag of this repo.`,
  missingObject: "Some of the code written while private couldn't be read, so it can't be published. Try again later.",
  badBranch: (b: string) => `The default branch ${b} can't be a public branch name.`,
} as const

// ---------------------------------------------------------------------------------------------
// Pure decisions (each is dg's function of the same name)
// ---------------------------------------------------------------------------------------------

/** The full names `r` may mean: itself when it is one, else the branch, then the tag (dg `candidates`). */
export function refCandidates(r: string): string[] {
  return r.startsWith('refs/') ? [r] : [`refs/heads/${r}`, `refs/tags/${r}`]
}

/**
 * Code only's refs as the owner named them, each a branch or tag of `allRefs` (dg
 * `named_code_refs`); a name that is neither is an error (E102).
 */
export function namedCodeRefs(allRefs: readonly MakePublicRef[], named: readonly string[]): MakePublicRef[] {
  return named.map((r) => {
    const full = refCandidates(r)
    const found = full.map((n) => allRefs.find((a) => a.name === n)).find((a) => a !== undefined)
    if (found === undefined) throw new MakePublicError(COPY.unknownRef(r), 'E102')
    return found
  })
}

/**
 * Code only's default (dg `default_code_refs`): the default branch `defaultRef` of `allRefs`, and
 * the tags whose commit is on it. `onTip(tag, tip)`: whether the tag's commit is an ancestor of
 * (or equal to) the branch's tip.
 */
export async function defaultCodeRefs(
  allRefs: readonly MakePublicRef[],
  defaultRef: string,
  onTip: (tagOid: string, tip: string) => Promise<boolean>,
): Promise<MakePublicRef[]> {
  const picked = allRefs.filter((r) => r.name === defaultRef)
  const branch = picked[0]
  if (branch === undefined) return picked
  for (const r of allRefs) {
    if (r.name.startsWith('refs/tags/') && (await onTip(r.oid, branch.oid))) picked.push(r)
  }
  return picked
}

/** The refs of `wanted` still to publish: not public yet, and not continued by members after the flip (dg `unpublished_refs`). */
export function unpublishedRefs(wanted: readonly MakePublicRef[], publicRefs: ReadonlyMap<string, string>, membersOnly: ReadonlySet<string>): MakePublicRef[] {
  return wanted.filter((r) => !publicRefs.has(r.name) && !membersOnly.has(r.name))
}

/** The refs of `wanted` never published: members pushed to them after the flip (dg's `left_out`). */
export function leftOutRefs(wanted: readonly MakePublicRef[], publicRefs: ReadonlyMap<string, string>, membersOnly: ReadonlySet<string>): string[] {
  return wanted.filter((r) => membersOnly.has(r.name) && !publicRefs.has(r.name)).map((r) => r.name)
}

/** What the mode's scan found: the code's, plus everything else's with Everything, each (place, fingerprint) once (dg `secrets_of`). */
export function secretsOf(check: Pick<MakePublicCheck, 'codeSecrets' | 'everythingSecrets'>, mode: MakePublicMode): MakePublicSecret[] {
  return uniqueSecrets(mode === 'everything' ? [...check.codeSecrets, ...check.everythingSecrets] : check.codeSecrets)
}

/** `secrets` with each (place, fingerprint) once, the first kept. */
export function uniqueSecrets(secrets: readonly MakePublicSecret[]): MakePublicSecret[] {
  const seen = new Set<string>()
  return secrets.filter((s) => {
    const k = `${s.place}\0${s.fingerprint.toLowerCase()}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * What stops publishing in `mode` before anything is signed, beyond the check's blockers (dg
 * `gate`): with Everything, old-format environments (E812, also one this member can't read) and
 * code that could not be fetched (E503); in both modes code the mode publishes that can't be read
 * (E503), and a possible secret not allowed (E807).
 * `allowed`: fingerprints, any case.
 */
export function gateMakePublic(
  check: Pick<MakePublicCheck, 'codeSecrets' | 'everythingSecrets' | 'oldFormat' | 'oldFormatUnreadable' | 'unfetched'> & { readonly missingObjects?: MakePublicCheck['missingObjects'] },
  mode: MakePublicMode,
  allowed: readonly string[],
): MakePublicError | null {
  if (mode === 'everything') {
    const env = check.oldFormat[0]
    if (env !== undefined) return new MakePublicError(COPY.oldFormat(env), 'E812')
    if (check.oldFormatUnreadable) return new MakePublicError(COPY.oldFormatUnreadable, 'E812')
    if (check.unfetched > 0) return new MakePublicError(COPY.unfetched(check.unfetched), 'E503')
  }
  // the code the mode publishes must be whole: dg's `git rev-list` fails the same way
  if ((check.missingObjects?.[mode] ?? 0) > 0) return new MakePublicError(COPY.missingObject, 'E503')
  const ok = new Set(allowed.map((f) => f.toLowerCase()))
  const blocking = secretsOf(check, mode).filter((s) => s.refuses && !ok.has(s.fingerprint.toLowerCase()))
  const first = blocking[0]
  return first === undefined ? null : new MakePublicError(COPY.secret(first.place), 'E807', blocking)
}

// --- the estimate (dg `estimate`, forge-core `cost::push_fees`) -------------------------------

/** About what the flip costs: DESIGN §4.10's 0.0004 DASH (dg `FLIP_ESTIMATE_CREDITS`). */
export const FLIP_ESTIMATE_CREDITS = 40_000_000
/** About what the first public settings cost (dg `CONFIG_ESTIMATE_CREDITS`). */
export const CONFIG_ESTIMATE_CREDITS = 40_000_000
/** A repository's first `packManifest` of a kind (forge-core `MANIFEST_FIRST`; testnet rc.4: 129.46M measured, 2026-10-17). */
export const MANIFEST_FIRST_CREDITS = 140_000_000
/** A ref's first update (forge-core `REF_FIRST`). */
export const REF_FIRST_CREDITS = 92_000_000
/** A repository's first manifest of a new kind adds its subtree (forge-core `HISTORY_FIRST_EXTRA`). */
export const HISTORY_FIRST_EXTRA_CREDITS = 40_000_000

/** The bytes of a browse-index fragment over `objects` objects (forge-core `locator_bytes`). */
export function locatorBytes(objects: number): number {
  return FANOUT_LEN + 76 + LOCATOR_ROW_LEN * objects
}

/** What a public push writes (forge-core `estimate_push`, plaintext, Platform storing it): (metadata, chunks). */
export function estimatePush(packBytes: number, objects: number, refs: number): { readonly metadata: number; readonly chunks: number } {
  return {
    metadata: MANIFEST_FIRST_CREDITS * 2 + REF_FIRST_CREDITS * refs,
    chunks: estimateChunkCredits(packBytes) + estimateChunkCredits(locatorBytes(objects)),
  }
}

/** What the run in `mode` costs (dg `estimate`): the push's metadata, the rotation and the flip while private, the settings until they exist, and with Everything the history; and the code's storage on Platform. */
export function estimateMakePublic(input: {
  readonly mode: MakePublicMode
  readonly size: { readonly bytes: number; readonly objects: number }
  readonly refs: number
  /** Not flipped yet. */
  readonly private: boolean
  /** The first public settings exist. */
  readonly marked: boolean
  /** The seal-off rotation's estimate (credits). */
  readonly rotationCredits: number
  /** Epochs this member reads (each a history entry). */
  readonly readableEpochs: number
}): { readonly credits: number; readonly storageCredits: number } {
  const push = estimatePush(input.size.bytes, input.size.objects, input.refs)
  let credits = push.metadata
  if (input.private) credits += input.rotationCredits + FLIP_ESTIMATE_CREDITS
  if (!input.marked) credits += CONFIG_ESTIMATE_CREDITS
  if (input.mode === 'everything') credits += estimateChunkCredits(7 + 69 * input.readableEpochs + 64) + MANIFEST_FIRST_CREDITS + HISTORY_FIRST_EXTRA_CREDITS
  return { credits, storageCredits: push.chunks }
}

/** `refs` sorted by name (code points, as dg's ordered map). */
export function byName<T extends { readonly name: string }>(refs: readonly T[]): T[] {
  return [...refs].sort((a, b) => compareStrings(a.name, b.name))
}

// ---------------------------------------------------------------------------------------------
// The run's record (this browser's IndexedDB; dg's state.json)
// ---------------------------------------------------------------------------------------------

/** A run under way, as this browser keeps it: no key and no plaintext. */
export interface MakePublicRecord {
  readonly mode: MakePublicMode
  /** `[name, tip]`, as the check found them. */
  readonly refs: readonly (readonly [string, string])[]
  /** The epoch the seal-off rotation created, once it ran. */
  readonly sealOff: number | null
  /**
   * The current epoch when the seal-off rotation began, kept before it is signed: a rotation that
   * landed but whose answer was lost is found again ({@link recordedSealOff}), never made twice.
   */
  readonly sealOffFrom?: number | null
  readonly startedAt: number
  /** Hex of the marker's random 16-byte run id, never a key. */
  readonly conversionId?: string
  /** Kept until marker confirmation too, so an interrupted start-over can finish its follow-up. */
  readonly replacesEpoch?: number
}

/** One record per network, signer and repo: another identity signed in here never continues it (an older key without the signer is ignored). */
function recordKey(network: Network, signer: string, repoId: string): string {
  return `make-public:${network}:${signer}:${repoId}`
}

/**
 * This browser's record of `signer`'s run on `repoId`, or null. One that can't be read is an
 * error, never "no record": a run that forgot its seal-off rotation would rotate again.
 */
export async function loadMakePublicRecord(network: Network, signer: string, repoId: string): Promise<MakePublicRecord | null> {
  const r = await idbGet<unknown>('journal', recordKey(network, signer, repoId))
  if (r === undefined || r === null) return null
  const o = r as Partial<MakePublicRecord>
  const okMode = o.mode === 'codeOnly' || o.mode === 'everything'
  const okRefs = Array.isArray(o.refs) && o.refs.every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string')
  const epochOk = (e: unknown): boolean => e === null || e === undefined || (typeof e === 'number' && Number.isInteger(e) && e >= 0)
  const okSeal = (o.sealOff === null || (typeof o.sealOff === 'number' && Number.isInteger(o.sealOff) && o.sealOff >= 0)) && epochOk(o.sealOffFrom)
  const okId = o.conversionId === undefined || (typeof o.conversionId === 'string' && /^[0-9a-f]{32}$/.test(o.conversionId))
  // copy-lint-ignore: a corrupt local record, reported as is
  if (!okMode || !okRefs || !okSeal || !okId || !epochOk(o.replacesEpoch)) throw new MakePublicError("This browser's record of making this repo public can't be read. If no run is under way, clear the site's storage.", 'E201')
  return {
    mode: o.mode as MakePublicMode,
    refs: o.refs as MakePublicRecord['refs'],
    sealOff: o.sealOff ?? null,
    sealOffFrom: o.sealOffFrom ?? null,
    ...(typeof o.conversionId === 'string' && /^[0-9a-f]{32}$/.test(o.conversionId) ? { conversionId: o.conversionId } : {}),
    ...(typeof o.replacesEpoch === 'number' ? { replacesEpoch: o.replacesEpoch } : {}),
    startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
  }
}

/** Keep `record` (replacing an earlier one whole). */
export function saveMakePublicRecord(network: Network, signer: string, repoId: string, record: MakePublicRecord): Promise<void> {
  return idbPut('journal', recordKey(network, signer, repoId), { ...record, refs: record.refs.map(([n, o]) => [n, o]) })
}

/** Drop the record (a run that finished). */
export function deleteMakePublicRecord(network: Network, signer: string, repoId: string): Promise<void> {
  return idbDelete('journal', recordKey(network, signer, repoId))
}

/** `refs` as the record keeps them, and back. */
export function recordRefs(refs: readonly MakePublicRef[]): [string, string][] {
  return refs.map((r) => [r.name, r.oid])
}
export function refsOfRecord(record: Pick<MakePublicRecord, 'refs'>): MakePublicRef[] {
  return record.refs.map(([name, oid]) => ({ name, oid }))
}

/** Whether `a` and `b` are the same branches and tags at the same tips, in any order. */
export function sameRefs(a: readonly MakePublicRef[], b: readonly MakePublicRef[]): boolean {
  const key = (r: MakePublicRef): string => `${r.name}\0${r.oid.toLowerCase()}`
  const set = new Set(a.map(key))
  return set.size === new Set(b.map(key)).size && b.every((r) => set.has(key(r)))
}

/**
 * The run's seal-off epoch (dg `recorded_seal_off`): the one recorded, else, when a rotation
 * began from epoch `from` and its answer was lost, the first epoch after `from` that isn't burned,
 * once the key read now (`current`) shows one: the run's own rotation, or an earlier boundary.
 * Null while none shows (the rotation is made, or resumed with the same key).
 */
export function recordedSealOff(sealOff: number | null, from: number | null | undefined, current: number | null, burned: ReadonlySet<number> | readonly number[] = [], marker: ActiveSealOff = { kind: 'none' }): number | null {
  let recorded = sealOff
  if (recorded === null && from != null && current !== null) {
    const skip = new Set(burned)
    for (let e = from + 1; e <= current; e++) {
      if (!skip.has(e)) { recorded = e; break }
    }
  }
  return sealOffBoundary(recorded, marker)
}

/**
 * Whether another rotation followed the recorded seal-off epoch `recorded` (the key epoch read now
 * is `current`): that run's boundary is passed, so it can't be finished, only started again.
 */
export function sealOffPassed(recorded: number | null, current: number | null, marker: ActiveSealOff = { kind: 'none' }): boolean {
  const boundary = sealOffBoundary(recorded, marker)
  return boundary !== null && current !== null && current > boundary
}

/**
 * The refs of `chosen` (an earlier choice, with the tips it recorded) that `allRefs` (the refs as
 * they were before the run's boundary) still holds at that tip or a later one, and the names of
 * the rest (dg `within_boundary`): a recorded tip written at or after the boundary is never
 * published.
 */
export async function withinBoundary(
  chosen: readonly MakePublicRef[],
  allRefs: readonly MakePublicRef[],
  isAncestor: (ancestor: string, tip: string) => Promise<boolean>,
): Promise<{ kept: MakePublicRef[]; dropped: string[] }> {
  const kept: MakePublicRef[] = []
  const dropped: string[] = []
  for (const r of chosen) {
    const now = allRefs.find((a) => a.name === r.name)
    if (now !== undefined && (now.oid === r.oid || (await isAncestor(r.oid, now.oid)))) kept.push(r)
    else dropped.push(r.name)
  }
  return { kept, dropped }
}

/** The lowest of the seal-off epochs known, or undefined when none is: one cutoff for a whole run. */
export function cutoffOf(...epochs: readonly (number | null | undefined)[]): number | undefined {
  const known = epochs.filter((e): e is number => typeof e === 'number')
  return known.length === 0 ? undefined : Math.min(...known)
}
