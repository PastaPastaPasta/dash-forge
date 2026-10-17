/**
 * What a pull request page expects to find right after `/new/pull` opened it (#559).
 *
 * A draft PR is two writes: the `patch`, then its author's draft `transition` (kind 14). The PR
 * page's `created` param used to say only "this PR was just made, ride out a node one block
 * behind": it waited for the PR to exist and took the first read, which can fold the patch
 * without the transition (Open, not Draft), and then kept that until a reload. The param now also
 * says what the create wrote (`draft`), so the page keeps re-reading until the fold shows it.
 */

import { PR_DRAFT } from '../rules/transition'
import { SUBMIT_WAIT } from './pending-review'

/** `created` after a plain PR: just made, nothing else to wait for. */
export const CREATED_PLAIN = '1'
/** `created` after a PR opened as a draft: the draft mark was written too, and must show. */
export const CREATED_DRAFT = 'draft'

/** The `created` value for a PR whose create wrote (and confirmed) the draft mark or not. */
export function createdParamFor(draft: boolean): string {
  return draft ? CREATED_DRAFT : CREATED_PLAIN
}

/** Whether `created` says this PR was just made here (either value): retry a not-found read. */
export function isJustCreatedPull(param: string): boolean {
  return param === CREATED_PLAIN || param === CREATED_DRAFT
}

/** Whether `created` says the create also wrote the draft mark. */
export function createdAsDraft(param: string): boolean {
  return param === CREATED_DRAFT
}

/** The part of a PR thread the expectation reads. */
interface DraftFold {
  readonly pull: { readonly state: { readonly draft: boolean; readonly open: boolean } }
  readonly timeline: readonly { readonly kind: string; readonly transition?: { readonly kind: number } }[]
}

/**
 * The fold holds the draft mark the create wrote: the PR is a draft now, or a draft transition
 * (kind 14) is among its transitions. The second covers "draft, then a co-maintainer marked it
 * ready": the mark landed, and the PR is rightly shown as ready.
 */
export function draftMarkFolded(t: DraftFold): boolean {
  return t.pull.state.draft || t.timeline.some((i) => i.kind === 'transition' && i.transition?.kind === PR_DRAFT)
}

/**
 * The first read's wait for the draft mark: about 20 s at most (1.5 s, growing x1.5), then the page
 * opens with a note rather than blocking longer. The transition can land a block or more after
 * the patch.
 */
export const CREATED_DRAFT_WAIT = { ...SUBMIT_WAIT, attempts: 5 } as const

/** The wait after "Refresh" on that note: the longer submit wait (about 60 s). */
export const CREATED_DRAFT_RETRY_WAIT = SUBMIT_WAIT

/**
 * Whether the page must say the draft mark is still landing: the create wrote it, the wait ended,
 * and the fold has no draft mark while the PR is open. (A closed or merged PR shows its own
 * state: the draft mark is no longer the news.)
 */
export function draftStillLanding(expected: boolean, t: DraftFold): boolean {
  return expected && t.pull.state.open && !draftMarkFolded(t)
}

type Wait = { readonly attempts: number; readonly delayMs: number; readonly backoff: number; readonly maxDelayMs: number }

/**
 * The page's one-time expectation of a draft mark after `/new/pull` created a draft PR. It waits
 * once per page load: `done` consumes it (a later read never waits for it again), `cancel` drops it
 * (any other write on the page supersedes it), and `retry` asks for it again with the longer wait.
 */
export function createdDraftGate(param: string): {
  plan: () => { readonly want: (t: DraftFold) => boolean; readonly wait: Wait } | null
  done: (t: DraftFold) => boolean
  cancel: () => void
  retry: () => void
} {
  let pending = createdAsDraft(param)
  let wait: Wait = CREATED_DRAFT_WAIT
  return {
    plan: () => (pending ? { want: draftMarkFolded, wait } : null),
    done: (t) => {
      if (!pending) return false
      pending = false
      return draftStillLanding(true, t)
    },
    cancel: () => {
      pending = false
    },
    retry: () => {
      pending = true
      wait = CREATED_DRAFT_RETRY_WAIT
    },
  }
}
