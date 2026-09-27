/**
 * A browser commit to a PR's source branch as a resumable chain of steps (review-parity §4.5,
 * M6): the merge runner's machinery with a branch target.
 *
 *   build (the page) → upload → packManifest → browse index → ref update of the source branch
 *   (prevOid = the PR head) → headUpdate on the PR
 *
 * The ref update needs write access to the SOURCE repo (usually the PR author's fork): consensus
 * refuses anyone else. The head update goes by the viewer's route on the base repo (the author's
 * `authorEvent`, or a member's `event`). A public source only: a private repo's pack must be
 * sealed, which the browser does not do yet (as the merge refuses).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { postTargetEvent, type RepoRef } from '../repo'
import { writePackManifest, writeRefUpdate } from '../repo/push'
import type { WriteAuth } from '../sdk'
import { formatBytes } from '../view/format'
import type { BranchCommit } from './branch-commit'
import type { StoredPack, UploadPack } from './runner'

export type BranchStepId = 'upload' | 'manifest' | 'index' | 'ref' | 'head'

export const BRANCH_STEPS: readonly { readonly id: BranchStepId; readonly label: string }[] = [
  { id: 'upload', label: 'Upload the pack to storage' },
  { id: 'manifest', label: 'Record the pack (packManifest)' },
  { id: 'index', label: 'Publish the browse index' },
  { id: 'ref', label: 'Move the PR branch (ref update)' },
  { id: 'head', label: 'Move the PR head (head update)' },
]

/** What is done so far; keep it across retries of the same commit only. */
export interface BranchRun {
  readonly commit: string
  readonly done: readonly BranchStepId[]
  readonly stored?: StoredPack
}

export interface BranchRunDeps {
  readonly sdk: EvoSDK
  readonly auth: WriteAuth
  /** The repo the PR targets (the head update is posted there). */
  readonly repo: RepoRef
  /** The PR's source repo (the pack and the ref update go there). */
  readonly source: RepoRef
  readonly pull: { readonly id: string; readonly number: number; readonly author: string; readonly headOid: string; readonly sourceRefName: string }
  /** The viewer is a maintainer or writer of the base repo (the head update's route). */
  readonly isMember: boolean
  readonly built: BranchCommit
  readonly upload: UploadPack | null
  readonly publishIndex: ((pack: Uint8Array, packHash: string) => Promise<string>) | null
  /** The source branch's tip now, read fresh just before moving it. */
  readonly readBranchTip: () => Promise<string | null>
  /**
   * The oids the new commit needs beyond the PR head that neither the pack nor the source repo's
   * OWN reader can produce (empty: complete). Checked before anything is uploaded; required, as
   * a branch must never move to objects nobody can fetch.
   */
  readonly verifyPack: (pack: Uint8Array, commit: string, have: string) => Promise<readonly string[]>
  readonly intent: string
}

export type BranchStepEvent = { readonly step: BranchStepId; readonly state: 'running' | 'done' | 'skipped'; readonly detail?: string }

/** A step failed: `run` is what was done before it. */
export class BranchStepError extends Error {
  constructor(
    readonly step: BranchStepId,
    reason: string,
    readonly run: BranchRun,
  ) {
    const moved = run.done.includes('ref')
    super(
      moved
        ? `The branch holds the new commit, but moving the PR head failed: ${reason}. Retry to move it (or run \`dg pr sync\`).`
        : `${run.done.includes('manifest') ? 'The pack is stored and recorded; ' : 'Nothing moved yet; '}the ${step === 'ref' ? 'ref update' : step} failed: ${reason}. Retry.`,
    )
  }
}

/** Not retryable: the branch moved, or the repo cannot be written from here. */
export class BranchStopped extends Error {}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Unfinished runs by action key, each with the very commit it was building. */
export type BranchRuns = Map<string, { readonly run: BranchRun; readonly built: BranchCommit }>

/**
 * Run the action `key`: resume its unfinished run with the commit that run built (a rebuild
 * would differ: its timestamp), or build a new commit. A step failure keeps the run under `key`
 * (Retry resumes it; running another action meanwhile does not drop it); success or a stop
 * drops it. `deps` is given the commit to run.
 */
export async function runKeyedBranchCommit(
  runs: BranchRuns,
  key: string,
  build: () => Promise<BranchCommit>,
  deps: (built: BranchCommit) => BranchRunDeps,
  onBuilt: (built: BranchCommit) => void,
  onStep: (e: BranchStepEvent) => void,
): Promise<BranchCommit> {
  const resume = runs.get(key)
  let built: BranchCommit | null = resume?.built ?? null
  try {
    if (built === null) {
      built = await build()
      onBuilt(built)
    }
    await runBranchCommit(deps(built), resume?.run ?? null, onStep)
    runs.delete(key)
    return built
  } catch (e) {
    if (e instanceof BranchStepError && built !== null) runs.set(key, { run: e.run, built })
    else runs.delete(key)
    throw e
  }
}

/** Run (or resume) the chain. */
export async function runBranchCommit(deps: BranchRunDeps, from: BranchRun | null, onStep: (e: BranchStepEvent) => void): Promise<BranchRun> {
  if (deps.source.visibility !== 'public' || deps.repo.visibility !== 'public') {
    throw new BranchStopped('Private repositories are changed with the CLI for now (`dg pr suggestion apply`, `dg pr update-branch`).')
  }
  const { built } = deps
  let run: BranchRun = from !== null && from.commit === built.commit ? from : { commit: built.commit, done: [] }
  const mark = (step: BranchStepId, patch: Partial<BranchRun> = {}, state: 'done' | 'skipped' = 'done', detail?: string): void => {
    run = { ...run, ...patch, done: [...run.done, step] }
    onStep({ step, state, ...(detail ? { detail } : {}) })
  }
  const attempt = async <T>(step: BranchStepId, work: () => Promise<T>): Promise<T> => {
    onStep({ step, state: 'running' })
    try {
      return await work()
    } catch (e) {
      if (e instanceof BranchStopped) throw e
      throw new BranchStepError(step, reasonOf(e), run)
    }
  }

  if (!run.done.includes('upload')) {
    let missing: readonly string[]
    onStep({ step: 'upload', state: 'running' })
    try {
      missing = await deps.verifyPack(built.pack.bytes, built.commit, deps.pull.headOid)
    } catch (e) {
      // Too large to walk here, or a read failed: retrying would walk the same history again.
      throw new BranchStopped(`The commit's pack could not be checked complete (${reasonOf(e)}); nothing was written. Use the CLI (\`dg pr suggestion apply\`, \`dg pr update-branch\`).`)
    }
    if (missing.length > 0) {
      throw new BranchStopped(
        `The commit's pack would leave ${missing.length} object(s) unfetchable (${missing
          .slice(0, 3)
          .map((o) => o.slice(0, 9))
          .join(', ')}); nothing was written. Use the CLI (\`dg pr suggestion apply\`, \`dg pr update-branch\`).`,
      )
    }
  }
  if (!run.done.includes('upload')) {
    const upload = deps.upload
    const stored = await attempt('upload', async () => {
      if (upload === null) throw new Error('your storage settings are not unlocked yet')
      return upload(built.pack.bytes, { packHash: built.pack.packHash, objectCount: built.pack.objectCount })
    })
    mark('upload', { stored }, 'done', `${formatBytes(built.pack.bytes.length)}, ${built.pack.objectCount} objects`)
  }
  if (!run.done.includes('manifest')) {
    const stored = run.stored as StoredPack
    await attempt('manifest', () =>
      writePackManifest(
        deps.sdk,
        deps.auth,
        deps.source,
        { packHash: built.pack.packHash, kind: 0, sizeBytes: built.pack.bytes.length, objectCount: built.pack.objectCount, ...stored },
        `${deps.intent}:manifest`,
      ),
    )
    mark('manifest')
  }
  if (!run.done.includes('index')) {
    const publish = deps.publishIndex
    if (publish === null) mark('index', {}, 'skipped', 'not available')
    else {
      onStep({ step: 'index', state: 'running' })
      try {
        mark('index', {}, 'done', await publish(built.pack.bytes, built.pack.packHash))
      } catch (e) {
        mark('index', {}, 'skipped', `not published (${reasonOf(e)}); the fork browses by the in-browser clone until the next push`)
      }
    }
  }
  if (!run.done.includes('ref')) {
    const tip = await attempt('ref', () => deps.readBranchTip())
    if (tip !== null && tip.toLowerCase() === built.commit) {
      mark('ref', {}, 'done', 'already there')
    } else {
      if (tip === null || tip.toLowerCase() !== deps.pull.headOid.toLowerCase()) {
        throw new BranchStopped(
          tip === null
            ? 'The PR branch no longer exists; nothing was moved.'
            : `The PR branch moved to ${tip.slice(0, 9)} since this page read it; update the PR head first, then try again. The pack stays stored and unused.`,
        )
      }
      await attempt('ref', () => writeRefUpdate(deps.sdk, deps.auth, deps.source, { refName: deps.pull.sourceRefName, newOid: built.commit, prevOid: deps.pull.headOid }, { intent: `${deps.intent}:ref` }))
      mark('ref')
    }
  }
  if (!run.done.includes('head')) {
    await attempt('head', () =>
      postTargetEvent(deps.sdk, deps.auth, deps.repo, {
        target: { id: deps.pull.id, number: deps.pull.number },
        kind: 'headUpdate',
        author: deps.pull.author,
        isMember: deps.isMember,
        payload: { oidHex: built.commit },
        intent: `${deps.intent}:head`,
      }),
    )
    mark('head')
  }
  return run
}
