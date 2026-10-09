/** The make-public confirmation's words (DESIGN §10). */

import { describe, expect, it } from 'vitest'

import { makePublicWords } from './make-public'

describe('makePublicWords', () => {
  it('says what §10 says for an own post, an inline comment and a review', () => {
    expect(makePublicWords('comment', null)).toEqual({
      title: 'Make your comment public?',
      description: "Everyone will be able to read it as you save it now. Earlier versions stay members-only. This can't be undone.",
      label: 'Make public',
    })
    expect(makePublicWords('comment', null, true).description).toContain("Its file name can't be made public, so the comment will show without it.")
    expect(makePublicWords('review', null)).toMatchObject({
      title: "Make your review's text public?",
      description: "It's added as a public comment on your review. This can't be undone.",
    })
  })

  it('asks "anyway" when the text quotes someone else’s members-only words', () => {
    const quoted = "Your comment quotes @bob's members-only comment. Everyone will be able to read the quoted text."
    const w = makePublicWords('comment', quoted)
    expect(w.description.endsWith(quoted)).toBe(true)
    expect(w.label).toBe('Make public anyway')
  })
})
