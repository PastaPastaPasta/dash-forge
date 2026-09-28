import { describe, expect, it } from 'vitest'

import {
  addDraftComment,
  draftCost,
  draftIsEmpty,
  editDraftComment,
  newReviewDraft,
  partialSubmitMessage,
  reanchorDraft,
  removeDraftComment,
  setDraftVerdict,
  splitDraftComments,
  startSubmit,
  submitStarted,
} from './pending-review'

const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)
const base = () => newReviewDraft({ draftId: 'd', network: 'devnet', identity: 'me', repoId: 'r', prId: 'p', headOid: H1, private: false, now: 1 })

describe('pending review edits', () => {
  it('adds, edits and removes comments, and sets the verdict; the submit writes 1 + n', () => {
    let d = addDraftComment(base(), 'a', { path: 'src/a.rs', line: 5, startLine: 3, side: 1, commitOid: H1 }, ' three lines ')
    d = addDraftComment(d, 'b', { path: 'src/a.rs', line: 9, side: 1 }, 'one line')
    d = editDraftComment(d, 'b', 'one line, edited')
    d = setDraftVerdict(d, 'requestChanges', 'A few things.')
    expect(d.comments.map((c) => c.body)).toEqual(['three lines', 'one line, edited'])
    expect(d.comments[0]?.anchor.commitOid).toBeUndefined()
    expect(d.verdict).toBe('requestChanges')
    expect(draftCost(d).documents).toBe(3)
    d = removeDraftComment(d, 'a')
    expect(draftCost(d).documents).toBe(2)
    expect(() => addDraftComment(d, 'c', { path: 'x', line: 1, side: 1 }, '  ')).toThrow()
  })

  it('freezes once a submit began, and says what landed', () => {
    let d = addDraftComment(base(), 'a', { path: 'x', line: 1, side: 1 }, 'hi')
    d = addDraftComment(d, 'b', { path: 'x', line: 2, side: 1 }, 'there')
    const started = { ...d, attemptedAt: 5, reviewId: 'R', comments: [{ ...d.comments[0]!, landedId: 'C1' }, d.comments[1]!] }
    expect(submitStarted(started)).toBe(true)
    expect(() => editDraftComment(started, 'b', 'x')).toThrow(/being submitted/)
    expect(partialSubmitMessage(started, 'Request changes')).toBe('Your Request changes is recorded with 1 of 2 comments; 1 is still pending in this browser. Retry to finish it: nothing is written twice.')
    expect(draftCost(started).documents).toBe(1)
  })

  it('re-anchors what still exists on the new head and strands the rest on the old one', () => {
    let d = addDraftComment(base(), 'a', { path: 'x', line: 5, startLine: 3, side: 1 }, 'range')
    d = addDraftComment(d, 'b', { path: 'y', line: 1, side: 0 }, 'gone')
    const { draft, stranded } = reanchorDraft(d, H2, (path, _side, line) => path === 'x' && line >= 3 && line <= 5)
    expect(stranded).toBe(1)
    expect(draft.headOid).toBe(H2)
    expect(draft.comments[0]?.anchor.commitOid).toBeUndefined()
    expect(draft.comments[1]?.anchor.commitOid).toBe(H1)
  })
})

describe('what a pending review keeps', () => {
  it('keeps a summary alone, or a chosen verdict alone: only a blank default draft is empty', () => {
    expect(draftIsEmpty(base())).toBe(true)
    expect(draftIsEmpty(setDraftVerdict(base(), 'comment', 'Looks close.'))).toBe(false)
    expect(draftIsEmpty(setDraftVerdict(base(), 'approve', ''))).toBe(false)
    expect(draftIsEmpty(setDraftVerdict(base(), 'comment', '   '))).toBe(true)
    expect(draftIsEmpty({ ...base(), attemptedAt: 5 })).toBe(false)
  })

  it('puts comments on the current head on their lines and lists the rest apart', () => {
    let d = addDraftComment(base(), 'a', { path: 'x', line: 5, side: 1 }, 'on the draft head')
    d = addDraftComment(d, 'b', { path: 'y', line: 1, side: 0 }, 'stranded')
    // The PR moved: re-anchoring keeps `a` (its line exists) and strands `b` on H1.
    const { draft } = reanchorDraft(d, H2, (path) => path === 'x')
    expect(splitDraftComments(draft, H2)).toEqual({ onLines: [draft.comments[0]], elsewhere: [draft.comments[1]] })
    // Not re-anchored yet: every comment belongs to H1, so none is placed on H2's lines.
    expect(splitDraftComments(d, H2)).toEqual({ onLines: [], elsewhere: d.comments })
    expect(splitDraftComments(d, H1)).toEqual({ onLines: d.comments, elsewhere: [] })
    expect(splitDraftComments(null, H1)).toEqual({ onLines: [], elsewhere: [] })
  })
})

describe('a submit and a moved head', () => {
  it('freezes the draft the moment a submit begins, with the trimmed summary', () => {
    const d = addDraftComment(base(), 'a', { path: 'x', line: 1, side: 1 }, 'hi')
    const s = startSubmit(d, 'approve', 'Looks good.\n', 42)
    expect(submitStarted(s)).toBe(true)
    expect(s).toMatchObject({ attemptedAt: 42, verdict: 'approve', summary: 'Looks good.' })
    expect(() => editDraftComment(s, 'a', 'x')).toThrow(/being submitted/)
    // A retry keeps the first attempt's time and words.
    expect(startSubmit(s, 'comment', 'other', 99)).toBe(s)
  })

  it('files a comment made on a newer head under that head, not a line of the old one', () => {
    let d = addDraftComment(base(), 'a', { path: 'x', line: 3, side: 1, commitOid: H1 }, 'on the draft head')
    d = addDraftComment(d, 'b', { path: 'x', line: 3, side: 1, commitOid: H2 }, 'on the moved head')
    expect(d.comments[0]?.anchor.commitOid).toBeUndefined()
    expect(d.comments[1]?.anchor.commitOid).toBe(H2)
    // Shown on H2's lines, and listed apart while the diff shows H1.
    expect(splitDraftComments(d, H2).onLines.map((c) => c.localId)).toEqual(['b'])
    expect(splitDraftComments(d, H1).onLines.map((c) => c.localId)).toEqual(['a'])
  })
})
