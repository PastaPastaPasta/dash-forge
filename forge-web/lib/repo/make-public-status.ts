/**
 * Where making a repo public stands (mixed-visibility DESIGN §4.10, §10's progress, interrupted and
 * stalled rows), read without signing by any viewer: the flip and the first public settings from
 * the `repo` and `config` documents, the code from the public refs, the history from the owner's
 * make-public bundles (kind 7) that publish the repo's keys (a bundle making single posts public is
 * kind 7 too, and is no history), and this browser's record of the viewer's run under way. A member reading
 * through a members-key session (`repo.lane`) also learns which branches members continued after
 * the flip, which are never published.
 *
 * The steps are §4.10's: the typed confirmation is step 1, then {@link MAKE_PUBLIC_STEPS} are steps
 * 2 to 7 ("3 of 7 steps done"). {@link statusOf} decides from facts alone (tested); the reader
 * gathers them.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import type { Conversion } from '../private'
import type { PlainDocument } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { newestAt } from './conversion-status'
import { publishesHistory, readMakePublicBundles, repoConversion } from './converted'
import { refTip } from './fork'
import {
  MAKE_PUBLIC_STEPS,
  MAKE_PUBLIC_TOTAL_STEPS,
  loadMakePublicRecord,
  refsOfRecord,
  unpublishedRefs,
  type MakePublicRecord,
  type MakePublicStatus,
  type MakePublicStep,
  type StepState,
} from './make-public'
import { privateViewOf, publicViewOf, readMembersContinued, readRepoDoc } from './make-public-check'
import { blockHeightOf } from './private-content'
import { readRefs } from './refs'
import { readAllRows } from './source'

/** What a status is decided from. */
export interface StatusFacts {
  readonly visibility: 'public' | 'private'
  /** The conversion facts (null: never private, or still private). */
  readonly conversion: Conversion | null
  readonly record: MakePublicRecord | null
  /** The highest key epoch any `config` states (the current one, while private). */
  readonly highestEpoch: number | null
  /** When the config of the recorded seal-off epoch was written (ms), when known. */
  readonly sealOffAt: number | null
  /** The `repo` document's last change (ms): the flip, once public. */
  readonly flipAt: number | null
  /** The first public config (ms): the conversion marker. */
  readonly markerAt: number | null
  /** The public refs: name → tip and when it was set (ms). */
  readonly publicRefs: ReadonlyMap<string, { readonly oid: string; readonly at: number }>
  /** Branches and tags members continued after the flip (known to a member only). */
  readonly membersOnly: ReadonlySet<string>
  /** When each of the owner's history bundles was recorded (ms): {@link historyBundleTimes}. */
  readonly historyBundles: readonly number[]
  readonly viewer: string | null
  readonly owner: string
}

/** The status a run's facts show (module docs). */
export function statusOf(f: StatusFacts): MakePublicStatus {
  const record = f.record === null ? null : { mode: f.record.mode, refs: refsOfRecord(f.record), sealOff: f.record.sealOff }
  const mode = f.record?.mode ?? (f.historyBundles.length > 0 ? 'everything' : null)
  const steps = (s: Partial<Record<MakePublicStep, StepState>>, fill: StepState): Record<MakePublicStep, StepState> =>
    Object.fromEntries(MAKE_PUBLIC_STEPS.map((k) => [k, s[k] ?? fill])) as Record<MakePublicStep, StepState>
  const count = (phase: MakePublicStatus['phase'], st: Record<MakePublicStep, StepState>, confirmed: boolean): number =>
    (confirmed ? 1 : 0) + MAKE_PUBLIC_STEPS.filter((k) => st[k] === 'done' || (phase === 'public' && st[k] === 'skipped')).length
  if (f.visibility === 'private') {
    const sealed = f.record?.sealOff != null && f.record.sealOff === f.highestEpoch
    const st = steps({ sealOff: sealed ? 'done' : 'todo', history: f.record?.mode === 'codeOnly' ? 'skipped' : 'todo' }, 'todo')
    return {
      phase: 'private',
      converted: false,
      steps: st,
      doneCount: count('private', st, f.record !== null),
      totalSteps: MAKE_PUBLIC_TOTAL_STEPS,
      lastStepAt: f.record === null ? null : newestAt(f.record.startedAt, sealed ? f.sealOffAt : null),
      record,
      mode,
    }
  }
  if (f.conversion === null) {
    // never private: nothing to make public
    return { phase: 'public', converted: false, steps: steps({}, 'skipped'), doneCount: 0, totalSteps: MAKE_PUBLIC_TOTAL_STEPS, lastStepAt: null, record, mode }
  }
  const config: StepState = f.conversion.markerHeight !== null ? 'done' : 'todo'
  const publicTips = new Map([...f.publicRefs].map(([n, r]) => [n, r.oid]))
  const code: StepState =
    f.record !== null ? (unpublishedRefs(refsOfRecord(f.record), publicTips, f.membersOnly).length === 0 ? 'done' : 'todo') : f.publicRefs.size > 0 ? 'done' : 'todo'
  const history: StepState =
    mode === 'everything' ? (f.historyBundles.length > 0 ? 'done' : f.viewer === f.owner ? 'todo' : 'owner') : 'skipped'
  const st = steps({ sealOff: 'done', flip: 'done', config, code, notify: code === 'done' ? 'done' : 'todo', history }, 'todo')
  const finished = config === 'done' && code === 'done' && (history === 'done' || history === 'skipped')
  const phase = finished ? 'public' : 'made'
  return {
    phase,
    converted: true,
    steps: st,
    doneCount: count(phase, st, true),
    totalSteps: MAKE_PUBLIC_TOTAL_STEPS,
    lastStepAt: newestAt(f.flipAt, f.markerAt, ...[...f.publicRefs.values()].map((r) => r.at), ...f.historyBundles),
    record,
    mode,
  }
}

/**
 * When each of the owner's make-public bundles `bundles` that publishes the keys of `repoId` was
 * recorded (ms): the history. Read from the bundles themselves, so anyone can tell, no key needed.
 */
export function historyBundleTimes(repoId: string, bundles: readonly { readonly at: number; readonly bytes: Uint8Array }[]): number[] {
  return bundles.filter((b) => publishesHistory(repoId, [b.bytes])).map((b) => b.at)
}

function numberOf(d: PlainDocument, field: string): number | null {
  const v = d[field]
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null
}

/**
 * Where making `repo` public stands, read now without signing (module docs). `viewer`: the
 * signed-in identity (base58), or null. A member reading with a members-key session on `repo`
 * (`repo.lane`) also sees which branches members continued after the flip; this browser's record
 * of the viewer's run is read too (a record that can't be read counts as none here: the run itself
 * refuses).
 */
export async function readMakePublicStatus(sdk: EvoSDK, repo: RepoRef, network: Network, viewer: string | null): Promise<MakePublicStatus> {
  const [doc, record] = await Promise.all([readRepoDoc(sdk, repo), viewer === null ? null : loadMakePublicRecord(network, viewer, repo.repoId).catch(() => null)])
  const visibility = doc?.['visibility'] === 'public' ? 'public' : 'private'
  const rows = await readAllRows(sdk, visibility === 'public' ? publicViewOf(repo) : privateViewOf(repo), DOC.config)
  const epochs = rows.map((d) => numberOf(d, 'epoch')).filter((e): e is number => e !== null)
  const highestEpoch = epochs.length === 0 ? null : Math.max(...epochs)
  const sealOffAt = record?.sealOff == null ? null : (rows.filter((d) => numberOf(d, 'epoch') === record.sealOff).map((d) => numberOf(d, '$createdAt') ?? 0)[0] ?? null)
  const base = { record, highestEpoch, sealOffAt, viewer, owner: repo.ownerId }
  const none = { flipAt: null, markerAt: null, publicRefs: new Map(), membersOnly: new Set<string>(), historyBundles: [] }
  if (visibility === 'private') return statusOf({ ...base, ...none, visibility, conversion: null })
  const pub = publicViewOf(repo)
  const conversion = repoConversion(pub, rows)
  if (conversion === null) return statusOf({ ...base, ...none, visibility, conversion })
  const marker = rows.filter((d) => d['vis'] !== 'private' && (blockHeightOf(d) ?? 0) > 0).map((d) => numberOf(d, '$createdAt') ?? 0)
  const [refs, bundles, members] = await Promise.all([
    readRefs(sdk, pub),
    readMakePublicBundles(sdk, pub),
    repo.lane !== undefined ? readMembersContinued(sdk, pub, repo.lane).catch(() => null) : Promise.resolve(null),
  ])
  const publicRefs = new Map<string, { oid: string; at: number }>()
  for (const r of refs) {
    const oid = refTip(r)
    if (oid !== null) publicRefs.set(r.refName, { oid, at: r.state.state === 'resolved' ? r.state.createdAt : 0 })
  }
  return statusOf({
    ...base,
    visibility,
    conversion,
    flipAt: doc === null ? null : (numberOf(doc, '$updatedAt') ?? null),
    markerAt: marker.length === 0 ? null : Math.min(...marker),
    publicRefs,
    membersOnly: members ?? new Set<string>(),
    historyBundles: historyBundleTimes(repo.repoId, bundles),
  })
}
