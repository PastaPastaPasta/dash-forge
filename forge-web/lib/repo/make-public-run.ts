/**
 * Steps 1 to 7 of making a private repo public (mixed-visibility DESIGN §4.10; dg `convert`, with
 * 5A's decisions), each reading state first so a run that stops can be run again and finishes:
 *
 * 1. the typed confirmation, when the run publishes something this browser has no record of;
 * 2. the seal-off rotation while the repo is still private, never twice: a recorded seal-off epoch
 *    that is still current is kept, and one a node doesn't show yet stops the run (Platform hasn't
 *    caught up) rather than rotating again. The key is read again (up to about 10 s for a node
 *    behind) and the run stops if someone else rotated meanwhile; with Everything the check runs
 *    again over what is now final, and the gate stops the run before the flip. A recorded seal-off
 *    epoch is the run's boundary for good: once another rotation follows it, the run can't be
 *    finished (flipping then would state a later boundary, which every other client reads), and
 *    only a new run the owner starts on purpose ({@link MakePublicChoice.startOver}) continues;
 * 3. the flip (the owner): the `repo` with `visibility: "public"` and its default branch;
 * 4. the first public settings, unless they exist (any maintainer);
 * 5. the code: one fresh public pack of the refs not public yet, never a branch members pushed to
 *    after the flip, stored as a normal push stores it, then their public ref updates;
 * 6. nothing is signed: Forge apps tell members from the flip and the published keys;
 * 7. with Everything, the owner's history bundles not recorded yet (deterministic, so "recorded"
 *    is an owner kind-7 manifest of the same `packHash`, whichever client wrote it). Any
 *    maintainer finishes the rest of a run the owner started; this step stays the owner's.
 *
 * One cutoff holds for the whole run: what was sealed under the seal-off epoch or later (the lower
 * of the stated and the recorded one) is never read for publishing, by any check nor the history.
 *
 * Each step is told running → done (or `owner`: waits for the owner). `signal` aborted between
 * steps stops the run cleanly; it can be run again. Writes carry intents (idempotency keys), so a
 * retry after a lost answer never writes twice. The chain is reached through {@link MakePublicIo}
 * ({@link sdkMakePublicIo} in the app), so the decisions are tested without a network.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { decodeIdentifier } from '../auth/base58'
import { PACK_KIND } from '../constants'
import type { UploadPack } from '../merge/runner'
import { epochKeyBundles, EpochKeys, constantTimeEqual, openWithKey, type Anchor, type Conversion } from '../private'
import { isRc1BranchName } from '../rules/oid'
import { createDocumentIdempotent, readIdentityBalance, replaceDocumentIdempotent } from '../sdk'
import { storeArtifact } from '../storage/upload'
import type { RepoConfig } from './config'
import { DOC, withVis } from './contract'
import { contractVisibilityOneWay } from './contract-shape'
import { refTip } from './fork'
import {
  COPY,
  MAKE_PUBLIC_WORDS,
  MakePublicError,
  START_OVER_WORDS,
  cutoffOf,
  deleteMakePublicRecord,
  gateMakePublic,
  leftOutRefs,
  loadMakePublicRecord,
  recordRefs,
  refsOfRecord,
  sameRefs,
  recordedSealOff,
  saveMakePublicRecord,
  sealOffPassed,
  unpublishedRefs,
  type MakePublicMode,
  type MakePublicProgress,
  type MakePublicRecord,
  type MakePublicRef,
  type MakePublicStep,
} from './make-public'
import {
  inspect,
  privateSessionFor,
  privateViewOf,
  publicViewOf,
  readConversion,
  readMembersContinued,
  readOwnerBundles,
  readVisibility,
  type Inspection,
  type PackCache,
} from './make-public-check'
import { buildPack } from './make-public-objects'
import { invalidateRepoBundles } from './made-public'
import { ownRawEpochKey, rotateRepoKey, type PrivateWriteContext } from './private-members'
import { invalidatePrivateSession, isMaintainer, loadPrivateSessionUncached, sessionUnwrapper, type PrivateSession } from './private-session'
import { repoContentWritten, writePackManifest, writeRefUpdate } from './push'
import { configData, DEFAULT_CONFIG } from './settings'
import { readRefs } from './refs'

/** What the owner chose. */
export interface MakePublicChoice {
  readonly mode: MakePublicMode
  /** Code only's branches and tags by name (default: the check's, or this browser's record). */
  readonly refs?: readonly string[]
  /** Fingerprints of possible secrets to publish anyway. */
  readonly allowSecrets: readonly string[]
  /**
   * The typed words, `make ${repoLabel} public` (checked only when the run publishes something this
   * browser has no record of; a run that only finishes one may pass '').
   */
  readonly confirmation: string
  /** How the dialog names the repo (`owner/name`); default: any `make <owner>/<name> public`. */
  readonly repoLabel?: string
  /**
   * Continue the run this browser recorded ("Finish it"): its refs, no typed words (dg `--resume`).
   * Without it a run that publishes anything new needs the words, a record or not.
   */
  readonly resume?: boolean
  /**
   * Start a new run in place of the one this browser recorded, which can't be finished: the repo's
   * key changed after its own key change (dg `--start-over`). Only while the repo is private; what
   * members wrote since becomes public too, so the typed words are asked.
   */
  readonly startOver?: boolean
  /** Where the code pack goes (the merge's storage choice, `useMergeUpload`); default: Platform. */
  readonly upload?: UploadPack
  /** Told each phase of the check the run makes again before it signs (it can take minutes). */
  readonly onCheck?: (what: string) => void
}

/** What a run did. */
export interface MakePublicOutcome {
  /** Every step is done (else the owner's history step waits). */
  readonly finished: boolean
  /** Branches and tags never published: members pushed to them after the flip. */
  readonly notPublished: string[]
  /** Credits spent, from the balance before and after (absent when it couldn't be read). */
  readonly spentCredits?: number
  /**
   * The repo states another boundary than this run's own key change: this browser keeps its record,
   * so the history it publishes stops at the lower one.
   */
  readonly boundaryKept?: boolean
}

/** The signer's standing in the private view's keys. */
export interface KeyStanding {
  readonly maintainer: boolean
  readonly currentEpoch: number | null
  /** Burned epochs (chain links only: nothing is sealed under them). */
  readonly burned?: readonly number[]
}

/** The chain as a run reaches it (see {@link sdkMakePublicIo}). */
export interface MakePublicIo {
  /** The signer (base58). */
  readonly me: string
  /** The repo's owner (base58). */
  readonly owner: string
  readonly repoId: string
  readonly repoName: string
  readVisibility(): Promise<'public' | 'private'>
  /** The conversion facts read now (null unless public and once private), the seal-off epoch among anchored epochs only. */
  readConversion(): Promise<Conversion | null>
  /** The `packHash`es (hex) of every make-public bundle (kind 7) the owner recorded, history or not. */
  ownerBundles(): Promise<Set<string>>
  /** The signer's standing on a fresh read of the private view's keys. */
  keys(): Promise<KeyStanding>
  /** The check (step 0) over a fresh session. */
  inspect(opts: { mode: MakePublicMode; refs?: readonly string[]; chosen?: readonly MakePublicRef[]; conversion: Conversion | null; below?: number; signal?: AbortSignal }): Promise<Inspection>
  /** The seal-off rotation: a fresh key wrapped to every member. Returns its epoch. */
  rotate(): Promise<number>
  /** Whether the contract lets the repo's visibility move once. */
  canFlip(): Promise<boolean>
  flip(defaultBranch: string): Promise<void>
  writeConfig(config: RepoConfig): Promise<void>
  /** The public refs (name → tip) and the members-only ones continued after the flip. */
  publicState(): Promise<{ readonly publicRefs: ReadonlyMap<string, string>; readonly membersOnly: ReadonlySet<string> }>
  /** Store the fresh pack of `todo` (without what `have` reaches) and write their public ref updates. */
  publishCode(inspection: Inspection, todo: readonly MakePublicRef[], have: readonly string[]): Promise<void>
  /** The history bundles of the keys below `sealOff` the signer holds (the caller wipes them). */
  historyBundles(sealOff: number): Promise<Uint8Array[]>
  storeBundle(bytes: Uint8Array): Promise<void>
  loadRecord(): Promise<MakePublicRecord | null>
  saveRecord(r: MakePublicRecord): Promise<void>
  deleteRecord(): Promise<void>
  /** The signer's balance (credits), or null. */
  balance(): Promise<number | null>
  sleep(ms: number): Promise<void>
}

/** How long a run waits, at most, for a node to show its own rotation. */
const ROTATION_WAIT = { attempts: 5, ms: 2000 }

/** Whether `typed` is the confirmation for the repo named `label` (or for any `<owner>/<name>` of `name`). */
export function confirms(typed: string, name: string, label?: string): boolean {
  if (label !== undefined) return typed === MAKE_PUBLIC_WORDS(label)
  const named = /^make (\S+) public$/.exec(typed)?.[1]
  return named !== undefined && named.endsWith(`/${name}`) && named.length > name.length + 1
}

/**
 * The hashes (hex) of the history bundles the owner recorded (dg `history_bundles`): the owner's
 * kind-7 manifests whose `packHash` is one of the bundles of the keys the signer holds below
 * `cutoff`, as every run builds them. A bundle making single posts public (§4.6) is kind 7 too and
 * never counts, so an owner who made one comment public has not started publishing the history.
 */
async function recordedHistory(io: MakePublicIo, cutoff: number | undefined): Promise<Set<string>> {
  if (cutoff === undefined) return new Set()
  const owner = await io.ownerBundles()
  if (owner.size === 0) return new Set()
  const bundles = await io.historyBundles(cutoff)
  try {
    return new Set(bundles.map((b) => bytesToHex(sha256(b))).filter((h) => owner.has(h)))
  } finally {
    for (const b of bundles) b.fill(0)
  }
}

/**
 * Why the key epoch read now (`current`) is not this run's seal-off epoch: a node behind (lower,
 * or none yet: never rotate again then), or another rotation after it (higher: the run's boundary
 * is passed, and the run can't be finished).
 */
function epochMismatch(current: number | null, sealOff: number, mode: MakePublicMode): MakePublicError {
  return new MakePublicError(lagging(current, sealOff) ? COPY.lagging : COPY.sealOffPassed(mode), 'E310')
}

/** Whether a node shows a key epoch below `sealOff` (or none): it hasn't caught up with this run's rotation. */
function lagging(current: number | null, sealOff: number): boolean {
  return current === null || current < sealOff
}

/** `keys` read again, for as long as a node still lags behind `sealOff`'s rotation (a few tries, then as it is). */
async function keysShowing(io: MakePublicIo, keys: KeyStanding, sealOff: number): Promise<KeyStanding> {
  let now = keys
  for (let i = 0; i < ROTATION_WAIT.attempts && lagging(now.currentEpoch, sealOff); i++) {
    await io.sleep(ROTATION_WAIT.ms)
    now = await io.keys()
  }
  return now
}

/** The run (dg `run` + `convert`) over `io`. */
export async function runMakePublicWith(io: MakePublicIo, choice: MakePublicChoice, onProgress: (p: MakePublicProgress) => void, signal?: AbortSignal): Promise<MakePublicOutcome> {
  const stop = (): void => signal?.throwIfAborted()
  const report = (step: MakePublicStep, state: MakePublicProgress['state'], detail?: string): void => onProgress({ step, state, ...(detail !== undefined ? { detail } : {}) })
  const { mode } = choice
  // nothing is chosen for the owner: with no mode, nothing runs
  if (mode !== 'codeOnly' && mode !== 'everything') throw new MakePublicError(COPY.noMode, 'E201')
  const isOwner = io.me === io.owner
  stop()
  const visibility = await io.readVisibility()
  const conversion = visibility === 'public' ? await io.readConversion() : null
  if (visibility === 'public' && conversion === null) throw new MakePublicError(COPY.publicAlready, 'E201')
  const flipped = conversion !== null
  let standing = await io.keys()
  if (!isOwner && !standing.maintainer) throw new MakePublicError(COPY.notOwner, 'E601')
  const startOver = choice.startOver === true
  if (startOver && flipped) throw new MakePublicError(COPY.startOverPublic, 'E201')
  const loaded = await io.loadRecord()
  // A seal-off rotation that landed but was never recorded is found again: only ever earlier.
  // (it shows as `from + 1`: a node behind is waited for a few seconds first)
  if (loaded !== null && loaded.sealOff === null && loaded.sealOffFrom != null) standing = await keysShowing(io, standing, loaded.sealOffFrom + 1)
  const recordedSeal = loaded === null ? null : recordedSealOff(loaded.sealOff, loaded.sealOffFrom, standing.currentEpoch, standing.burned)
  // While private, a recorded seal-off epoch is the run's boundary for good. Above the one a node
  // shows: the node hasn't caught up with this run's own rotation, so wait a little, then stop
  // (rotating again would seal off twice). Below it: another rotation followed, and the run can't
  // be finished; only starting again on purpose sets the record aside. (Anyone but the owner is
  // refused below, before any step.)
  let replaced = false
  if (!flipped && recordedSeal !== null && isOwner) {
    standing = await keysShowing(io, standing, recordedSeal)
    if (lagging(standing.currentEpoch, recordedSeal)) throw new MakePublicError(COPY.lagging, 'E310')
    const passed = sealOffPassed(recordedSeal, standing.currentEpoch)
    if (!startOver && passed) throw new MakePublicError(COPY.sealOffPassed(loaded?.mode ?? mode), 'E310')
    replaced = startOver && passed
  }
  // only a record whose boundary is passed is set aside: one whose rotation may have landed never is
  if (startOver && !replaced) throw new MakePublicError(COPY.startOverUnfinished, 'E201')
  const saved = startOver || loaded === null ? null : { ...loaded, sealOff: recordedSeal }
  const savedSeal = saved?.sealOff ?? null
  // One cutoff for the whole run: what was sealed under it or later is never published. Once
  // public, the lower of the stated and the recorded seal-off epochs; while private, the recorded
  // one (current, as read above), else none yet (the rotation makes it).
  const cutoff = flipped ? cutoffOf(conversion.sealOffEpoch, savedSeal) : (savedSeal ?? undefined)
  // a run that started Everything (some history published) finishes as Everything
  const historyNow = flipped ? await recordedHistory(io, cutoff) : new Set<string>()
  const historyStarted = historyNow.size > 0
  if (historyStarted && mode === 'codeOnly') throw new MakePublicError(COPY.historyStarted, 'E201')
  // only the owner flips, and only the owner chooses Everything
  if (!isOwner && (!flipped || (mode === 'everything' && !historyStarted))) throw new MakePublicError(COPY.notOwner, 'E601')
  const savedMode = saved !== null && saved.mode === mode
  const named = choice.refs !== undefined && choice.refs.length > 0
  const chosen = savedMode && !named ? refsOfRecord(saved) : undefined
  if (flipped && !isOwner && mode === 'codeOnly' && !savedMode && !named) throw new MakePublicError(COPY.sayRefs, 'E201')
  stop()
  const below = cutoff !== undefined ? { below: cutoff } : {}
  let inspection = await io.inspect({ mode, conversion, ...(named ? { refs: choice.refs } : {}), ...(chosen !== undefined ? { chosen } : {}), ...below, ...(signal !== undefined ? { signal } : {}) })
  if (!flipped) {
    const b = inspection.blockers[0]
    if (b !== undefined) throw b
  }
  // This browser's record stands for the run only with its own refs: refs named that are not
  // exactly the record's are a new choice (the typed words and the scan).
  const savedHere = savedMode && (!named || sameRefs(inspection.check.codeRefs, refsOfRecord(saved)))
  let wanted: readonly MakePublicRef[] = mode === 'codeOnly' ? inspection.check.codeRefs : inspection.check.allRefs
  // what is public already, and what members continued after the flip (never published)
  const before = flipped ? await io.publicState() : { publicRefs: new Map<string, string>(), membersOnly: new Set<string>() }
  const todoNow = unpublishedRefs(wanted, before.publicRefs, before.membersOnly)
  const publishesHistory = mode === 'everything' && isOwner
  // a publication this browser has no confirmation of: refs not public yet, or the history
  const newPublication = !flipped || (todoNow.length > 0 && !savedHere) || (publishesHistory && historyNow.size === 0 && !savedHere)
  // The scan stands before anything new is published, a recorded run too: nothing scans the code
  // when it is stored (a push's check runs in `dg`, not here).
  if (newPublication || publishesHistory || todoNow.length > 0) {
    const refusal = gateMakePublic(inspection.check, mode, choice.allowSecrets)
    if (refusal !== null) throw refusal
  }
  // the words, unless this continues the run this browser recorded, with its refs (dg `--resume`);
  // starting again has its own words, never skipped
  const resuming = choice.resume === true && savedHere
  if (replaced) {
    if (choice.repoLabel === undefined || choice.confirmation !== START_OVER_WORDS(choice.repoLabel)) {
      throw new MakePublicError(`${COPY.startOver(null, mode)} ${COPY.words(START_OVER_WORDS(choice.repoLabel ?? `<owner>/${io.repoName}`))}`, 'E802')
    }
  } else if (newPublication && !resuming && !confirms(choice.confirmation, io.repoName, choice.repoLabel)) {
    throw new MakePublicError(COPY.words(MAKE_PUBLIC_WORDS(choice.repoLabel ?? `<owner>/${io.repoName}`)), 'E802')
  }
  stop()
  const startBalance = await io.balance()
  let record: MakePublicRecord = {
    mode,
    refs: recordRefs(wanted),
    sealOff: saved?.sealOff ?? null,
    sealOffFrom: saved?.sealOffFrom ?? null,
    startedAt: saved?.startedAt ?? Date.now(),
  }
  await io.saveRecord(record)
  // 2. seal off, 3. flip
  if (flipped) {
    report('sealOff', 'done')
    report('flip', 'done')
  } else {
    // Never a second rotation: a recorded one is read again just below, and one that landed
    // unrecorded is found again. The epoch it starts from is kept before it is signed.
    const resumed = record.sealOff === null && record.sealOffFrom != null
    const at = await keysShowing(io, await io.keys(), record.sealOff ?? (record.sealOffFrom != null ? record.sealOffFrom + 1 : 0))
    const found = recordedSealOff(record.sealOff, record.sealOffFrom, at.currentEpoch, at.burned)
    if (found !== null) {
      record = { ...record, sealOff: found }
      await io.saveRecord(record)
      report('sealOff', 'done')
    } else {
      record = { ...record, sealOffFrom: at.currentEpoch }
      await io.saveRecord(record)
      report('sealOff', 'running')
      const epoch = await io.rotate()
      record = { ...record, sealOff: epoch }
      await io.saveRecord(record)
      report('sealOff', 'done')
    }
    // The check ran before the run knew its boundary (a rotation that landed unrecorded, found
    // only now): what it chose may hold refs written at or after it. The next run checks below it.
    // A fresh run's own rotation comes after its check (dg `checked_before_boundary`).
    if (record.sealOff !== (cutoff ?? null) && (resumed || cutoff !== undefined)) throw new MakePublicError(COPY.runAgain, 'E310')
    stop()
    const sealOff = record.sealOff as number
    // a node a block behind may not show the rotation yet
    const now = await keysShowing(io, await io.keys(), sealOff)
    if (now.currentEpoch !== sealOff) throw epochMismatch(now.currentEpoch, sealOff, mode)
    if (mode === 'everything') {
      // What Everything publishes is final now (everything below the seal-off rotation): check
      // it again, since members may have written or pushed since the first check.
      inspection = await io.inspect({ mode, conversion: null, chosen: wanted, below: sealOff, ...(signal !== undefined ? { signal } : {}) })
      const refusal = gateMakePublic(inspection.check, mode, choice.allowSecrets)
      if (refusal !== null) throw new MakePublicError(`${refusal.message} ${COPY.stillPrivate}`, refusal.code, refusal.secrets)
      wanted = inspection.check.allRefs
      record = { ...record, refs: recordRefs(wanted) }
      await io.saveRecord(record)
    }
    stop()
    report('flip', 'running')
    // the second check can take minutes: the key is read again right before the point of no return
    const atFlip = (await io.keys()).currentEpoch
    if (atFlip !== sealOff) throw epochMismatch(atFlip, sealOff, mode)
    if (!(await io.canFlip())) throw new MakePublicError(COPY.frozen, 'E103')
    await io.flip(inspection.check.defaultBranch)
    report('flip', 'done')
  }
  stop()
  // 4. the first public settings. The boundary the repo states is not this run's own (a key
  // change landed right before the flip, or the record is not the run's): the history published
  // here still stops at the lower one, and the record is kept so a later run here does too.
  const stated = await io.readConversion()
  const boundaryKept = record.sealOff !== null && stated !== null && stated.sealOffEpoch !== record.sealOff
  if (stated?.markerHeight == null) {
    report('config', 'running')
    await io.writeConfig(inspection.config ?? DEFAULT_CONFIG)
  }
  report('config', 'done')
  stop()
  // 5. the code
  const state = await io.publicState()
  const todo = unpublishedRefs(wanted, state.publicRefs, state.membersOnly)
  const notPublished = leftOutRefs(wanted, state.publicRefs, state.membersOnly)
  if (todo.length > 0) {
    report('code', 'running', todo.map((r) => r.name).join(', '))
    await io.publishCode(inspection, todo, [...state.publicRefs.values()])
  }
  report('code', 'done')
  // 6. notifications: Forge apps read them from the flip and the published keys
  report('notify', 'done')
  stop()
  // 7. the history
  let finished = true
  if (mode === 'everything') {
    // the run's cutoff: never at or above this run's own seal-off epoch, even if a rotation slipped in before the flip
    const sealOff = cutoffOf((await io.readConversion())?.sealOffEpoch, record.sealOff) ?? 0
    const recordedNow = await io.ownerBundles()
    const bundles = await io.historyBundles(sealOff)
    try {
      const left = bundles.filter((b) => !recordedNow.has(bytesToHex(sha256(b))))
      if (left.length === 0) report('history', 'done')
      else if (!isOwner) {
        finished = false
        report('history', 'owner')
      } else {
        report('history', 'running')
        for (const b of left) {
          stop()
          await io.storeBundle(b)
        }
        report('history', 'done')
      }
    } finally {
      for (const b of bundles) b.fill(0)
    }
  } else {
    report('history', 'skipped')
  }
  const endBalance = await io.balance()
  if (finished && !boundaryKept) await io.deleteRecord()
  return {
    finished,
    notPublished,
    ...(startBalance !== null && endBalance !== null ? { spentCredits: Math.max(0, startBalance - endBalance) } : {}),
    ...(boundaryKept ? { boundaryKept } : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// The history's keys
// ---------------------------------------------------------------------------------------------

/** Whether raw key `raw` of `epoch` commits to `anchor`. */
async function commitsTo(repoId: Uint8Array, epoch: number, raw: Uint8Array, anchor: Anchor | undefined): Promise<boolean> {
  if (anchor?.commit == null) return false
  const keys = await EpochKeys.import(repoId, epoch, raw)
  return constantTimeEqual(keys.commit, anchor.commit)
}

/** The fields of `anchor` opened with the session's key of its epoch (null: not readable). */
async function openAnchorFields(session: PrivateSession, anchor: Anchor): Promise<{ prevEpoch?: number; prevEpochKey?: Uint8Array; skipEpochKey?: Uint8Array } | null> {
  const keys = session.resolution.keys.get(anchor.config.epoch)
  if (keys === undefined) return null
  const c = anchor.config
  const opened = await openWithKey({ type: 'config', ownerId: c.owner, epoch: c.epoch, id: c.id, createdAtBlockHeight: c.createdAtBlockHeight, enc: c.enc }, keys, true)
  return opened.status === 'readable' ? opened.fields : null
}

/**
 * The raw keys of every epoch below `sealOff` the signer reads (forge-core `epoch_keys_below`),
 * each taken where the session's chain walk found it: the next anchor's `prevEpochKey`, a later
 * anchor's `skipEpochKey` over a burned run, else the signer's own wrap; each checked against its
 * anchor. The caller wipes them.
 */
export async function rawKeysBelow(session: PrivateSession, sealOff: number, ownWrap: (epoch: number) => Promise<Uint8Array>): Promise<Map<number, Uint8Array>> {
  const r = session.resolution
  const out = new Map<number, Uint8Array>()
  const readable = [...r.keys.keys()].filter((e) => e < sealOff).sort((a, b) => a - b)
  const opened = new Map<number, Awaited<ReturnType<typeof openAnchorFields>>>()
  const fieldsOf = async (e: number) => {
    if (!opened.has(e)) {
      const a = r.anchors.get(e)
      opened.set(e, a === undefined ? null : await openAnchorFields(session, a))
    }
    return opened.get(e) ?? null
  }
  try {
    for (const e of readable) {
      const anchor = r.anchors.get(e)
      let raw: Uint8Array | null = null
      const next = await fieldsOf(e + 1)
      if (next?.prevEpoch === e && next.prevEpochKey !== undefined && (await commitsTo(session.repoId, e, next.prevEpochKey, anchor))) raw = next.prevEpochKey.slice()
      for (const a of r.anchors.keys()) {
        if (raw !== null) break
        if (a <= e + 1 || !r.keys.has(a)) continue
        const f = await fieldsOf(a)
        if (f?.skipEpochKey !== undefined && (await commitsTo(session.repoId, e, f.skipEpochKey, anchor))) raw = f.skipEpochKey.slice()
      }
      if (raw === null) raw = await ownWrap(e).catch(() => null)
      if (raw !== null) out.set(e, raw)
    }
  } finally {
    for (const f of opened.values()) {
      f?.prevEpochKey?.fill(0)
      f?.skipEpochKey?.fill(0)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The app's chain
// ---------------------------------------------------------------------------------------------

/** Intents of this run's writes (the run's idempotency keys). */
function intentOf(repoId: string, what: string): string {
  return `make-public:${repoId}:${what}`
}

/** The chain of `c` (a member's write context; `c.repo` either view of the repo). */
export function sdkMakePublicIo(c: PrivateWriteContext, opts: { readonly upload?: UploadPack; readonly label?: string; readonly onCheck?: (what: string) => void } = {}): MakePublicIo {
  const { sdk, auth } = c
  const repo = c.repo
  const priv = privateViewOf(repo)
  const pub = publicViewOf(repo)
  const packCache: PackCache = new Map()
  const fresh = <T>(use: (s: PrivateSession) => Promise<T>): Promise<T> =>
    privateSessionFor(c).then(async (s) => {
      try {
        return await use(s)
      } finally {
        s.close()
      }
    })
  const written = (): void => {
    invalidatePrivateSession(repo)
    repoContentWritten(pub)
  }
  // Platform only: every reader, anonymous and the gateway included, must find it.
  const storeOnPlatform = (bytes: Uint8Array): ReturnType<typeof storeArtifact> => storeArtifact(sdk, auth, pub, bytes, { policy: null, profiles: [], confirmPlatform: async () => true })
  const upload: UploadPack =
    opts.upload ??
    (async (bytes) => {
      const s = await storeOnPlatform(bytes)
      return { storage: s.storage, chunkCount: s.chunkCount, uris: s.uris }
    })
  return {
    me: auth.identityId,
    owner: repo.ownerId,
    repoId: repo.repoId,
    repoName: repo.name,
    readVisibility: () => readVisibility(sdk, repo),
    readConversion: () => fresh((s) => readConversion(sdk, repo, (e) => s.resolution.anchors.has(e))),
    ownerBundles: () => readOwnerBundles(sdk, repo),
    keys: () => fresh(async (s) => ({ maintainer: isMaintainer(s, auth.identityId), currentEpoch: s.resolution.currentEpoch, burned: [...s.resolution.burned] })),
    inspect: (o) =>
      fresh((s) =>
        inspect(c, s, {
          ...o,
          packCache,
          ...(opts.label !== undefined ? { label: opts.label } : {}),
          ...(opts.onCheck !== undefined ? { onProgress: opts.onCheck } : {}),
        }),
      ),
    rotate: async () => {
      try {
        return await rotateRepoKey({ ...c, repo: priv }, [], intentOf(repo.repoId, 'seal-off'))
      } finally {
        invalidatePrivateSession(repo)
      }
    },
    canFlip: () => contractVisibilityOneWay(sdk, repo.forge.core),
    flip: async (defaultBranch) => {
      // copy-lint-ignore: checked against the repo's own settings before signing
      if (!isRc1BranchName(defaultBranch)) throw new MakePublicError(COPY.badBranch(defaultBranch), 'E201')
      try {
        await replaceDocumentIdempotent(sdk, auth, {
          contractId: repo.forge.core,
          documentType: DOC.repo,
          documentId: repo.repoId,
          changes: { visibility: 'public', defaultBranch },
          repo: repo.repoId,
        })
      } finally {
        written()
      }
    },
    writeConfig: async (config) => {
      try {
        await createDocumentIdempotent(sdk, auth, {
          contractId: repo.forge.core,
          documentType: DOC.config,
          data: withVis('public', DOC.config, { repoId: decodeIdentifier(repo.repoId), ...configData(config) }),
          intent: intentOf(repo.repoId, 'config'),
        })
      } finally {
        written()
      }
    },
    publicState: async () => {
      const publicRefs = new Map<string, string>()
      for (const r of await readRefs(sdk, pub)) {
        const tip = refTip(r)
        if (tip !== null) publicRefs.set(r.refName, tip)
      }
      const lane = await loadPrivateSessionUncached(sdk, pub, c.network, auth.identityId, sessionUnwrapper(c.ops))
      try {
        return { publicRefs, membersOnly: await readMembersContinued(sdk, pub, lane) }
      } finally {
        lane.close()
      }
    },
    publishCode: async (inspection, todo, have) => {
      const pack = await buildPack(inspection.store, todo.map((r) => r.oid), have, opts.label)
      if (pack !== null) {
        const stored = await upload(pack.bytes, { packHash: pack.packHash, objectCount: pack.objectCount })
        await writePackManifest(sdk, auth, pub, { packHash: pack.packHash, kind: PACK_KIND.GIT_PACK, sizeBytes: pack.bytes.length, objectCount: pack.objectCount, ...stored }, intentOf(repo.repoId, `code:${pack.packHash}`))
        // the browse index only makes it browse faster: best effort, as a push's
        try {
          const { publishMergeIndex } = await import('../merge/locator')
          await publishMergeIndex(sdk, auth, pub, pack.bytes, pack.packHash, upload, intentOf(repo.repoId, `index:${pack.packHash}`))
        } catch {
          // the repo browses by the in-browser clone until the next push
        }
      }
      for (const r of todo) await writeRefUpdate(sdk, auth, pub, { refName: r.name, newOid: r.oid }, { intent: intentOf(repo.repoId, `ref:${r.name}:${r.oid}`) })
      written()
    },
    historyBundles: (sealOff) =>
      fresh(async (s) => {
        const keys = await rawKeysBelow(s, sealOff, (e) => ownRawEpochKey(s, { ...c, repo: priv }, e))
        try {
          return epochKeyBundles(decodeIdentifier(repo.repoId), keys)
        } finally {
          for (const k of keys.values()) k.fill(0)
        }
      }),
    storeBundle: async (bytes) => {
      try {
        const s = await storeOnPlatform(bytes)
        await writePackManifest(
          sdk,
          auth,
          pub,
          { kind: PACK_KIND.MAKE_PUBLIC, objectCount: 0, packHash: s.packHash, sizeBytes: s.sizeBytes, chunkCount: s.chunkCount, storage: s.storage, uris: s.uris },
          intentOf(repo.repoId, `history:${s.packHash}`),
        )
      } finally {
        invalidateRepoBundles(pub)
        written()
      }
    },
    loadRecord: () => loadMakePublicRecord(c.network, auth.identityId, repo.repoId),
    saveRecord: (r) => saveMakePublicRecord(c.network, auth.identityId, repo.repoId, r),
    deleteRecord: () => deleteMakePublicRecord(c.network, auth.identityId, repo.repoId),
    balance: async () => {
      try {
        return Number(await readIdentityBalance(sdk, auth.identityId))
      } catch {
        return null
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/**
 * Make `c.repo` public (steps 1 to 7, module docs) as the owner chose: `choice.mode`, Code only's
 * `refs`, the possible secrets allowed, and the typed words. The owner starts a run; after the
 * flip any maintainer finishes it (the history step stays the owner's: `finished: false` and the
 * step reported `owner`). Throws {@link MakePublicError} for every refusal, before anything is
 * signed where it can be (E103, E201, E307, E310, E503, E601, E802, E807, E812), and whatever a
 * write throws. `signal` aborted stops it between steps: run it again to continue.
 */
export async function runMakePublic(
  c: PrivateWriteContext,
  choice: MakePublicChoice,
  onProgress: (p: MakePublicProgress) => void,
  signal?: AbortSignal,
): Promise<MakePublicOutcome> {
  return runMakePublicWith(
    sdkMakePublicIo(c, {
      ...(choice.upload !== undefined ? { upload: choice.upload } : {}),
      ...(choice.repoLabel !== undefined ? { label: choice.repoLabel } : {}),
      ...(choice.onCheck !== undefined ? { onCheck: choice.onCheck } : {}),
    }),
    choice,
    onProgress,
    signal,
  )
}
