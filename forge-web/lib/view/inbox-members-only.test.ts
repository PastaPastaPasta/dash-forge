/**
 * The inbox and members-only content in a public repo (DESIGN D14), with the document shapes
 * spike S2 wrote live on sakura (`spikes/mixed-visibility/s2/seal-fixture.mjs`): `vis: "public"`,
 * a v0x03 or v0x04 `enc`, `epoch` 0, and `asMember` on a member's write. S2 saw the shipped inbox
 * say "X commented" for a stranger's sealed comment; these pin the fix.
 */

import { describe, expect, it } from 'vitest'

import { audienceOf, membersOnlyTitle, toItems, type Feed, type ThreadSub } from './inbox'

const ME = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MEMBER = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'
const STRANGER = '57d7EsKBtYT3HnFyyhrvURGsvMzMcFDbeQ3o66u8eRju'
const REPO = { id: '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z', ownerId: ME, name: 'demo', private: false }
const PRIVATE = { ...REPO, private: true }

/** An S2-shaped `enc`: the version byte, then filler of the spike's length. */
const enc = (version: 3 | 4, length: number): Uint8Array => Uint8Array.from({ length }, (_, i) => (i === 0 ? version : (i * 37) % 251))

const thread = (over: Partial<ThreadSub> = {}): ThreadSub => ({
  id: 'CR1u2SvFB97NvTF5zoqtYjjP4t2M5PyKEgFqPkKVThZP',
  kind: 'issue',
  number: 12,
  title: 'Public issue one',
  repo: REPO,
  reason: 'author',
  since: 0,
  ...over,
})

let n = 0
const doc = (owner: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ $id: `d${++n}`, $ownerId: owner, $createdAt: 1000 + n, vis: 'public', ...extra })
const sealed = (owner: string, e: Uint8Array, extra: Record<string, unknown> = {}): Record<string, unknown> => doc(owner, { enc: e, epoch: 0, ...extra })
const asMember = (who: string): Record<string, unknown> => ({ asMember: who })

describe('the inbox and members-only content in a public repo (D14)', () => {
  it("makes no item of a stranger's members-only comment", () => {
    const t = thread()
    const f: Feed = { kind: 'comments', thread: t }
    const docs = [
      sealed(STRANGER, enc(3, 93), { targetId: t.id }),
      // A specific-people letter (v0x04) from a stranger: the same.
      sealed(STRANGER, enc(4, 234), { targetId: t.id }),
      // `asMember` naming someone else (consensus refuses it): still a stranger's.
      sealed(STRANGER, enc(3, 93), { targetId: t.id, ...asMember(MEMBER) }),
    ]
    expect(toItems(f, docs, ME)).toEqual([])
  })

  it("makes a content-free item of a member's members-only comment", () => {
    const t = thread()
    const f: Feed = { kind: 'comments', thread: t }
    const items = toItems(f, [sealed(MEMBER, enc(3, 93), { targetId: t.id, ...asMember(MEMBER) }), sealed(MEMBER, enc(4, 302), { targetId: t.id, ...asMember(MEMBER) })], ME)
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(item).toMatchObject({ kind: 'comment', actor: MEMBER, what: 'posted a members-only comment', target: { kind: 'issue', number: 12, title: 'Public issue one' } })
      expect(item.reason).toBeUndefined()
    }
    expect(JSON.stringify(items)).not.toMatch(/sealed|encrypted/i)
  })

  it('gives a members-only issue or pull request its numbered row, whoever opened it', () => {
    const issue = toItems({ kind: 'new', type: 'issue', repo: REPO }, [sealed(MEMBER, enc(3, 109), { repoId: REPO.id, number: 3, tk: 0, ...asMember(MEMBER) }), sealed(STRANGER, enc(3, 109), { repoId: REPO.id, number: 5, tk: 0 })], ME)
    expect(issue.map((i) => [i.target?.number, i.target?.title, i.what, i.actor])).toEqual([
      [3, 'Members-only issue', 'opened a members-only issue', MEMBER],
      [5, 'Members-only issue', 'opened a members-only issue', STRANGER],
    ])
    const [pull] = toItems({ kind: 'new', type: 'patch', repo: REPO }, [sealed(MEMBER, enc(3, 125), { repoId: REPO.id, number: 4, tk: 1, ...asMember(MEMBER) })], ME)
    expect(pull).toMatchObject({ kind: 'pull', what: 'opened a members-only pull request', target: { kind: 'pull', number: 4, title: membersOnlyTitle('pull') } })
  })

  it("keeps a member's members-only review verdict and drops a stranger's sealed review", () => {
    const t = thread({ kind: 'pull', number: 2, title: 'Add sub()' })
    const items = toItems(
      { kind: 'reviews', thread: t },
      [
        sealed(MEMBER, enc(3, 77), { patchId: t.id, verdict: 1, ...asMember(MEMBER) }),
        sealed(MEMBER, enc(3, 77), { patchId: t.id, verdict: 2, ...asMember(MEMBER) }),
        sealed(MEMBER, enc(3, 77), { patchId: t.id, verdict: 3, ...asMember(MEMBER) }),
        sealed(STRANGER, enc(3, 77), { patchId: t.id, verdict: 3 }),
      ],
      ME,
    )
    expect(items.map((i) => i.what)).toEqual(['approved in a members-only review', 'requested changes in a members-only review', 'posted a members-only review'])
    // The S2 feed of reviews on my PRs applies the same rule.
    const mine = toItems({ kind: 'myReviews', owner: ME, threads: [t] }, [sealed(STRANGER, enc(3, 77), { patchId: t.id, verdict: 3 }), sealed(MEMBER, enc(3, 77), { patchId: t.id, verdict: 1, ...asMember(MEMBER) })], ME)
    expect(mine.map((i) => [i.actor, i.what])).toEqual([[MEMBER, 'approved in a members-only review']])
  })

  it('leaves public comments and private repos as they were', () => {
    const t = thread()
    const pub = toItems({ kind: 'comments', thread: t }, [doc(STRANGER, { targetId: t.id, body: 'hi' })], ME)
    expect(pub.map((i) => i.what)).toEqual(['commented'])
    // A private repo seals everything, and only members can write there: every comment notifies.
    const p = thread({ repo: PRIVATE })
    const priv = toItems({ kind: 'comments', thread: p }, [sealed(MEMBER, enc(3, 93), { targetId: p.id, vis: 'private' })], ME)
    expect(priv.map((i) => i.what)).toEqual(['commented'])
    const [issue] = toItems({ kind: 'new', type: 'issue', repo: PRIVATE }, [sealed(MEMBER, enc(3, 109), { repoId: REPO.id, number: 1, vis: 'private' })], ME)
    expect(issue?.what).toBe('opened an issue')
    expect(audienceOf(PRIVATE, { enc: enc(3, 93), $ownerId: STRANGER })).toBe('public')
  })
})
