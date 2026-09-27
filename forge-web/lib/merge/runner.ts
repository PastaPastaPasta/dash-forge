/**
 * The browser merge as a resumable chain of steps (`ux-dx-spec.md` §5.7):
 *
 *   fetch base + head → merge → build pack → upload → packManifest → browse index →
 *   ref update → merge event
 *
 * Each step's result is kept in a {@link MergeRun} the caller holds, so a retry resumes at the
 * step that failed and pays for nothing twice, and a failure after the upload names exactly
 * which documents exist ("Pack stored and manifest written; the ref update failed: …").
 *
 * The merge and the pack are computed by the merge worker; the storage upload is injected
 * ({@link UploadPack}), so the runner does not care where the pack goes. A merge that adds no
 * objects (a fast-forward of a same-repo PR: the head is in the base repo's packs already)
 * skips the upload and the manifest, as the push helper does for an empty pack.
 *
 * The browse index (a kind-1 locator fragment for the new pack) is best effort, as in the
 * push helper: a failure there is reported and skipped, never a failed merge.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { addEvent, type PullView, type RepoRef } from '../repo'
import { writePackManifest, writeRefUpdate } from '../repo/push'
import type { WriteAuth } from '../sdk'
import type { MergeInput } from './engine'
import type { MergeResult } from './protocol'

export type MergeStepId = 'fetch' | 'merge' | 'pack' | 'upload' | 'manifest' | 'index' | 'ref' | 'event'

export const MERGE_STEPS: readonly { readonly id: MergeStepId; readonly label: string }[] = [
  { id: 'fetch', label: 'Fetch base and head' },
  { id: 'merge', label: 'Merge' },
  { id: 'pack', label: 'Build pack' },
  { id: 'upload', label: 'Upload pack to storage' },
  { id: 'manifest', label: 'Record the pack (packManifest)' },
  { id: 'index', label: 'Publish the browse index' },
  { id: 'ref', label: 'Move the base branch (ref update)' },
  { id: 'event', label: 'Record the merge (merge event)' },
]

/** Where an uploaded pack was stored, as its `packManifest` records it. */
export interface StoredPack {
  readonly storage: 0 | 1
  readonly chunkCount: number
  readonly uris: readonly string[]
}

/**
 * Store an artifact (the merge pack, then its index fragment) under the merger's storage
 * policy, or on Platform once they agree to the price. `null`: nothing can be uploaded.
 */
export type UploadPack = (bytes: Uint8Array, info: { readonly packHash: string; readonly objectCount: number }) => Promise<StoredPack>

/**
 * What has been done so far. Keep it across retries — for the same base tip and head only
 * ({@link runFor}): a run built on another tip must never be resumed.
 */
export interface MergeRun {
  /** The base tip and PR head this run merged (the ref update's `prevOid` is this tip). */
  readonly baseTip: string
  readonly headOid: string
  readonly done: readonly MergeStepId[]
  readonly result?: Extract<MergeResult, { kind: 'fast-forward' | 'merge' }>
  readonly stored?: StoredPack
  readonly manifestId?: string
  readonly refDocumentId?: string
  readonly eventId?: string
}

/** A fresh run for `input`. */
export function newRun(input: Pick<MergeInput, 'baseTip' | 'headOid'>): MergeRun {
  return { baseTip: input.baseTip, headOid: input.headOid, done: [] }
}

/** `run` when it is for `input`'s base tip and head, else a fresh run. */
export function runFor(run: MergeRun | null, input: Pick<MergeInput, 'baseTip' | 'headOid'>): MergeRun {
  return run !== null && run.baseTip === input.baseTip && run.headOid === input.headOid ? run : newRun(input)
}

export interface MergeRunDeps {
  readonly sdk: EvoSDK
  readonly auth: WriteAuth
  readonly repo: RepoRef
  readonly pull: Pick<PullView, 'id' | 'number' | 'baseRefName'>
  readonly input: MergeInput
  /** Runs the merge and builds the pack (the worker). */
  readonly merge: (input: MergeInput, onPhase: (phase: 'analyse' | 'merge' | 'pack') => void) => Promise<MergeResult>
  readonly upload: UploadPack | null
  /**
   * Publish the browse-index fragment for the recorded pack; resolves with a note for the step
   * list (published at packRef n, or why it was skipped). Best effort: a throw is reported.
   */
  readonly publishIndex: ((pack: Uint8Array, packHash: string) => Promise<string>) | null
  /**
   * The oids reachable from `tip` that are in neither `pack` nor the base repo (empty when the
   * pack is complete). Checked before the upload; a non-empty answer stops the merge.
   */
  readonly verifyPack: (pack: Uint8Array, tip: string) => Promise<readonly string[]>
  /** The base branch's current tip, read fresh (`''` when it has none), just before moving it. */
  readonly readBaseTip: () => Promise<string>
  /** The intent prefix for this merge's writes (one per PR head), so retries re-use them. */
  readonly intent: string
}

export type StepEvent = { readonly step: MergeStepId; readonly state: 'running' | 'done' | 'skipped'; readonly detail?: string }

/** A merge that cannot go on (conflicts, nothing to merge): not retryable. */
export class MergeStopped extends Error {}

/** A step failed: `run` is what was done before it (resume from there). */
export class MergeStepError extends Error {
  constructor(
    readonly step: MergeStepId,
    readonly reason: string,
    readonly run: MergeRun,
  ) {
    super(failureMessage(run, step, reason))
  }
}

const DONE_PHRASES: Readonly<Partial<Record<MergeStepId, string>>> = {
  upload: 'Pack stored',
  manifest: 'manifest written',
  ref: 'base branch moved',
}

const FAILED_PHRASES: Readonly<Record<MergeStepId, string>> = {
  fetch: 'reading the base and head',
  merge: 'the merge',
  pack: 'building the pack',
  upload: 'the upload',
  manifest: 'the pack manifest',
  index: 'the browse index',
  ref: 'the ref update',
  event: 'the merge event',
}

const RETRY_LABEL: Readonly<Record<MergeStepId, string>> = {
  fetch: 'Retry',
  merge: 'Retry',
  pack: 'Retry',
  upload: 'Retry upload',
  manifest: 'Retry manifest',
  index: 'Retry',
  ref: 'Retry ref update',
  event: 'Retry merge event',
}

/** The retry button's label after `step` failed. */
export function retryLabel(step: MergeStepId): string {
  return RETRY_LABEL[step]
}

/**
 * What exists after `failed` failed, in words: "Pack stored and manifest written; the ref
 * update failed: <reason>. Retry ref update." Nothing on chain yet says so.
 */
export function failureMessage(run: MergeRun, failed: MergeStepId, reason: string): string {
  const existing = (['upload', 'manifest', 'ref'] as const).filter((s) => run.done.includes(s)).map((s) => DONE_PHRASES[s] as string)
  const what = FAILED_PHRASES[failed]
  const head = existing.length === 0 ? `Nothing was written; ${what} failed` : `${sentence(existing)}; ${what} failed`
  return `${head}: ${reason}. ${RETRY_LABEL[failed]}.`
}

function sentence(parts: readonly string[]): string {
  const s = parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Run (or resume) the merge chain from `run`. Resolves with the finished run; rejects with a
 * {@link MergeStepError} (carrying the run so far) or a {@link MergeStopped}.
 */
export async function runMergeSteps(deps: MergeRunDeps, from: MergeRun, onStep: (e: StepEvent) => void): Promise<MergeRun> {
  if (from.baseTip !== deps.input.baseTip || from.headOid !== deps.input.headOid) {
    throw new MergeStopped('the base branch or the PR head changed since this merge started; merge again')
  }
  let run: MergeRun = from
  const mark = (step: MergeStepId, patch: Partial<MergeRun> = {}, state: 'done' | 'skipped' = 'done', detail?: string): void => {
    run = { ...run, ...patch, done: [...run.done, step] }
    onStep({ step, state, ...(detail ? { detail } : {}) })
  }
  const attempt = async <T>(step: MergeStepId, work: () => Promise<T>): Promise<T> => {
    onStep({ step, state: 'running' })
    try {
      return await work()
    } catch (e) {
      if (e instanceof MergeStopped) throw e
      throw new MergeStepError(step, reasonOf(e), run)
    }
  }

  if (run.result === undefined) {
    // fetch, merge and pack run together in the worker; its phases mark the steps, and a
    // failure is reported against the phase it happened in.
    let phase: MergeStepId = 'fetch'
    onStep({ step: 'fetch', state: 'running' })
    let result: MergeResult
    try {
      result = await deps.merge(deps.input, (p) => {
        if (p === 'merge' || p === 'pack') {
          if (!run.done.includes('fetch')) mark('fetch')
          if (p === 'pack' && !run.done.includes('merge')) mark('merge')
          phase = p
          onStep({ step: p, state: 'running' })
        }
      })
    } catch (e) {
      throw new MergeStepError(phase, reasonOf(e), run)
    }
    if (result.kind === 'conflict') throw new MergeStopped(`the merge has conflicts${result.paths.length ? ` in ${result.paths.join(', ')}` : ''}`)
    if (result.kind === 'up-to-date') throw new MergeStopped('the base branch already contains this head')
    if (result.kind === 'unrelated') throw new MergeStopped('the head and the base branch share no history')
    for (const s of ['fetch', 'merge'] as const) if (!run.done.includes(s)) mark(s)
    const built = result
    // The hard safety net: the pack plus the base repo must hold the new tip's whole closure,
    // or the branch would move to objects nobody can fetch. Checked before anything is paid for.
    const missing = await attempt('pack', () => deps.verifyPack(built.pack, built.newTip))
    if (missing.length > 0) {
      throw new MergeStopped(`the merge pack would leave ${missing.length} object(s) unfetchable (${missing.slice(0, 3).map((o) => o.slice(0, 9)).join(', ')}); nothing was written. Merge with \`dg pr merge\``)
    }
    mark('pack', { result: built }, 'done', `${built.objectCount} objects · ${built.pack.length} bytes · complete`)
  }
  const result = run.result as NonNullable<MergeRun['result']>
  const empty = result.objectCount === 0

  if (!run.done.includes('upload')) {
    if (empty) {
      mark('upload', {}, 'skipped', 'nothing new to store')
    } else {
      const upload = deps.upload
      const stored = await attempt('upload', async () => {
        if (upload === null) throw new Error('this build cannot upload packs from the browser yet; merge with `dg pr merge`')
        return upload(result.pack, { packHash: result.packHash, objectCount: result.objectCount })
      })
      mark('upload', { stored })
    }
  }

  if (!run.done.includes('manifest')) {
    if (empty) {
      mark('manifest', {}, 'skipped')
    } else {
      const stored = run.stored as StoredPack
      const w = await attempt('manifest', () =>
        writePackManifest(
          deps.sdk,
          deps.auth,
          deps.repo,
          { packHash: result.packHash, kind: 0, sizeBytes: result.pack.length, objectCount: result.objectCount, ...stored },
          `${deps.intent}:manifest`,
        ),
      )
      mark('manifest', { manifestId: w.documentId })
    }
  }

  if (!run.done.includes('index')) {
    const publish = deps.publishIndex
    if (empty || publish === null) {
      mark('index', {}, 'skipped', empty ? 'nothing new to index' : 'not available')
    } else {
      onStep({ step: 'index', state: 'running' })
      try {
        mark('index', {}, 'done', await publish(result.pack, result.packHash))
      } catch (e) {
        mark('index', {}, 'skipped', `not published (${reasonOf(e)}); the repo browses by the in-browser clone until the next push`)
      }
    }
  }

  if (!run.done.includes('ref')) {
    // The merge was built on `run.baseTip`: if the branch has moved since, moving it now would
    // drop the commits pushed in between.
    const tipNow = await attempt('ref', () => deps.readBaseTip())
    if (tipNow !== run.baseTip) {
      throw new MergeStopped(`the base branch moved to ${tipNow.slice(0, 9) || '(deleted)'} since this merge was built; the pack stays stored and unused. Merge again`)
    }
    const w = await attempt('ref', () =>
      writeRefUpdate(
        deps.sdk,
        deps.auth,
        deps.repo,
        { refName: deps.pull.baseRefName, newOid: result.newTip, ...(run.baseTip ? { prevOid: run.baseTip } : {}) },
        // The protected patterns are read fresh: a stale list could route a protected ref as an
        // inert plain refUpdate.
        { intent: `${deps.intent}:ref` },
      ),
    )
    mark('ref', { refDocumentId: w.documentId }, 'done', w.documentType)
  }

  if (!run.done.includes('event')) {
    const w = await attempt('event', () =>
      addEvent(deps.sdk, deps.auth, deps.repo, {
        target: { id: deps.pull.id, number: deps.pull.number },
        kind: 'merge',
        oidHex: result.newTip,
        intent: `${deps.intent}:event`,
      }),
    )
    mark('event', { eventId: w.documentId })
  }
  return run
}
