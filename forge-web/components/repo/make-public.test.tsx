/** The make-public confirmations' words (DESIGN §10): an author's own post, a maintainer's bundle. */

import { describe, expect, it } from 'vitest'

import type { BundlePlan, BundledPost } from '@/lib/repo/make-public-bundle'

import { bundleWords, makePublicWords } from './make-public'

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

describe('bundleWords', () => {
  const post = (p: Partial<BundledPost>): BundledPost => ({ type: 'comment', id: 'c', author: 'alice', number: null, revisions: [1], recipients: null, text: '', earlier: 0, ...p })
  const plan = (posts: BundledPost[], leftOut: BundlePlan['leftOut'] = []): BundlePlan => ({ posts, leftOut, entries: posts.length, earlier: 0 })
  const name = (id: string): string => id

  it('a members-only pull request between public branches goes in like any post', () => {
    const w = bundleWords(plan([post({ type: 'patch', id: 'p', number: 12 }), post({ author: 'bob' })]), [], name)
    expect(w.title).toBe('Make 2 posts public?')
    expect(w.description).toBe("Words by alice and bob become public. They'll be notified. This can't be undone.")
    expect(w.leftOut).toEqual([])
  })

  it('a pull request of a members-only branch is left out, saying why and what its author can do', () => {
    const w = bundleWords(plan([post({ author: 'bob' })], [{ type: 'patch', id: 'p', author: 'alice', why: 'membersOnlyBranch' }]), [], name)
    expect(w.leftOut).toEqual([
      "A pull request of a members-only branch: making it public this way would also publish the branch's name and newest commit. Its author can make its title and description public.",
    ])
    expect(w.description).not.toContain('branch')
    expect(bundleWords(plan([], [{ type: 'patch', id: 'p', author: 'alice', why: 'membersOnlyBranch' }]), [], name).nothing).toBe('Nothing here can be made public.')
  })
})
