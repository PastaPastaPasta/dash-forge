import { describe, expect, it } from 'vitest'

import { addDraftComment, draftCost, editDraftComment, newReviewDraft, partialSubmitMessage, reanchorDraft, removeDraftComment, setDraftVerdict, submitStarted } from './pending-review'

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
