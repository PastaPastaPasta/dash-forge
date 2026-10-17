import { describe, expect, it } from 'vitest'

import { CREATED_DRAFT_RETRY_WAIT, CREATED_DRAFT_WAIT, createdAsDraft, createdDraftGate, createdParamFor, draftMarkFolded, draftStillLanding, isJustCreatedPull } from './created-pull'
import { SUBMIT_WAIT } from './pending-review'
import { readUntil } from './retry'

const DRAFT = 14
const READY = 15
interface Fold {
  pull: { state: { draft: boolean; open: boolean } }
  timeline: { kind: string; transition?: { kind: number } }[]
}
/** A fold: the PR's state now, and the transition kinds in its timeline. */
const fold = (draft: boolean, kinds: number[] = [], open = true): Fold => ({
  pull: { state: { draft, open } },
  timeline: [{ kind: 'comment' }, ...kinds.map((kind) => ({ kind: 'transition', transition: { kind } }))],
})

describe('the created param carries what the create wrote (#559)', () => {
  it('says draft only for a PR opened as a draft', () => {
    expect(createdParamFor(true)).toBe('draft')
    expect(createdParamFor(false)).toBe('1')
  })

  it('both values mean "just created here"; only draft expects the mark', () => {
    for (const p of ['1', 'draft']) expect(isJustCreatedPull(p)).toBe(true)
    for (const p of ['', '0', 'true']) expect(isJustCreatedPull(p)).toBe(false)
    expect(createdAsDraft('draft')).toBe(true)
    expect(createdAsDraft('1')).toBe(false)
    expect(createdAsDraft('')).toBe(false)
  })
})

describe('the draft mark in the fold', () => {
  it('counts when the PR is a draft, or a draft transition is folded', () => {
    expect(draftMarkFolded(fold(true, [DRAFT]))).toBe(true)
    expect(draftMarkFolded(fold(false, [DRAFT, READY]))).toBe(true)
    expect(draftMarkFolded(fold(false, []))).toBe(false)
    expect(draftMarkFolded(fold(false, [READY]))).toBe(false)
  })

  it('draft then ready (a co-maintainer) is satisfied at once and gets no note', () => {
    const t = fold(false, [DRAFT, READY])
    expect(draftStillLanding(true, t)).toBe(false)
  })

  it('says the mark is still landing only for an open PR created as a draft with no mark folded', () => {
    expect(draftStillLanding(true, fold(false))).toBe(true)
    expect(draftStillLanding(true, fold(true, [DRAFT]))).toBe(false)
    expect(draftStillLanding(false, fold(false))).toBe(false)
    expect(draftStillLanding(true, fold(false, [], false))).toBe(false)
  })
})

describe('the waits', () => {
  it('a first read without the draft transition is re-read until the mark is folded', async () => {
    const reads = [fold(false), fold(false), fold(true, [DRAFT])]
    let n = 0
    const out = await readUntil(async () => reads[n++]!, [draftMarkFolded], { ...CREATED_DRAFT_WAIT, delayMs: 0 })
    expect(out?.pull.state.draft).toBe(true)
    expect(n).toBe(3)
  })

  it('without the expectation the first (open) read is taken as is: the bug', async () => {
    let n = 0
    const out = await readUntil(async () => (n++, fold(false)), [], { delayMs: 0 })
    expect(out?.pull.state.draft).toBe(false)
    expect(n).toBe(1)
  })

  it('the first wait is capped near 20 s and then gives up', async () => {
    let n = 0
    const out = await readUntil(async () => (n++, fold(false)), [draftMarkFolded], { ...CREATED_DRAFT_WAIT, delayMs: 0 })
    expect(out?.pull.state.draft).toBe(false)
    expect(n).toBe(CREATED_DRAFT_WAIT.attempts + 1)
    let total = 0
    let wait: number = CREATED_DRAFT_WAIT.delayMs
    for (let i = 0; i < CREATED_DRAFT_WAIT.attempts; i++) {
      total += wait
      wait = Math.min(CREATED_DRAFT_WAIT.maxDelayMs, wait * CREATED_DRAFT_WAIT.backoff)
    }
    expect(total).toBeLessThanOrEqual(21_000)
    expect(CREATED_DRAFT_RETRY_WAIT).toBe(SUBMIT_WAIT)
  })

  it('stops at once when the load is aborted (unmount, or the page changed)', async () => {
    let n = 0
    const signal = { aborted: false }
    await readUntil(
      async () => {
        if (++n === 2) signal.aborted = true
        return fold(false)
      },
      [draftMarkFolded],
      { ...CREATED_DRAFT_WAIT, delayMs: 0, signal },
    )
    expect(n).toBe(2)
  })
})

describe('createdDraftGate: one wait per page load', () => {
  it('a plain create (created=1) never waits', () => {
    expect(createdDraftGate('1').plan()).toBeNull()
    expect(createdDraftGate('').plan()).toBeNull()
  })

  it('a draft create waits on the first load with the capped wait, then never again', () => {
    const gate = createdDraftGate('draft')
    expect(gate.plan()?.wait).toBe(CREATED_DRAFT_WAIT)
    expect(gate.done(fold(true, [DRAFT]))).toBe(false)
    // A later read (a comment, "Mark ready") has no draft expectation to wait for.
    expect(gate.plan()).toBeNull()
  })

  it('reports the note when the wait ended without the mark, and Refresh waits again, longer', () => {
    const gate = createdDraftGate('draft')
    expect(gate.done(fold(false))).toBe(true)
    expect(gate.plan()).toBeNull()
    gate.retry()
    expect(gate.plan()?.wait).toBe(SUBMIT_WAIT)
    expect(gate.done(fold(true, [DRAFT]))).toBe(false)
    expect(gate.plan()).toBeNull()
  })

  it('another write on the page cancels it', () => {
    const gate = createdDraftGate('draft')
    gate.cancel()
    expect(gate.plan()).toBeNull()
    expect(gate.done(fold(false))).toBe(false)
  })
})
