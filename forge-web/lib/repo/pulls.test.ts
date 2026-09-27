/**
 * The PR-side pure logic: comment anchors (fields and the body-block fallback), inline thread
 * placement, the review fold summary, and the byte encodings of `patch`, `packManifest` and
 * ref updates, which must match forge-core (`collab::v2::patch_props`,
 * `RepoService::write_pack_manifest` / `write_ref_update`).
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { base58Decode } from '../auth/base58'
import { RoleOracle, type Review } from '../rules/v2'
import type { CommentView } from '../view/issues-view'
import { placeThreads } from '../view/inline-threads'
import { approverPhrase, summarizeReviews } from '../view/review-fold'
import { parseAnchorBlock, readAnchor, serializeAnchorBlock, writeAnchor } from './anchors'
import { refUpdateData, refUpdateType } from './push'
import { patchData } from './writes'

const HEAD = 'ab'.repeat(20)
const OLD = 'cd'.repeat(20)
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'

describe('comment anchors', () => {
  it('round-trips the body block and strips it from the rendered body', () => {
    const anchor = { path: 'src/a.ts', line: 12, side: 1 as const, commitOid: HEAD }
    const body = serializeAnchorBlock(anchor, 'Nit: rename this.')
    expect(body.startsWith('<!-- forge-anchor {')).toBe(true)
    expect(parseAnchorBlock(body)).toEqual({ anchor, body: 'Nit: rename this.' })
  })

  it('reads a block written by another client (spacing, CRLF, upper-case oid)', () => {
    const body = `  <!--forge-anchor {"path":"x.md","line":3,"side":0,"commitOid":"${HEAD.toUpperCase()}"} -->\r\nhi`
    expect(parseAnchorBlock(body)).toEqual({ anchor: { path: 'x.md', line: 3, side: 0, commitOid: HEAD }, body: 'hi' })
  })

  it('never renders a malformed block, and ignores blocks that are not at the top', () => {
    expect(parseAnchorBlock('<!-- forge-anchor {"path":1} -->\nbody')).toEqual({ anchor: null, body: 'body' })
    expect(parseAnchorBlock('<!-- forge-anchor {not json} -->\nbody')).toEqual({ anchor: null, body: 'body' })
    expect(parseAnchorBlock('<!-- forge-anchor {"path":"a","line":1,"side":2} -->\nb')).toEqual({ anchor: null, body: 'b' })
    const later = 'text\n<!-- forge-anchor {"path":"a","line":1,"side":1} -->'
    expect(parseAnchorBlock(later)).toEqual({ anchor: null, body: later })
  })

  it('prefers the contract fields; the block is used only when every field is absent', () => {
    const block = serializeAnchorBlock({ path: 'block.ts', line: 1, side: 0, commitOid: OLD }, 'text')
    expect(readAnchor({ path: 'field.ts', line: 9, side: 1, commitOid: HEAD, body: block })).toEqual({
      anchor: { path: 'field.ts', line: 9, side: 1, commitOid: HEAD },
      body: 'text',
    })
    expect(readAnchor({ commitOid: '', body: block })).toEqual({
      anchor: { path: 'block.ts', line: 1, side: 0, commitOid: OLD },
      body: 'text',
    })
    // Fields present but incomplete: no anchor, and the block does not fill the gap.
    expect(readAnchor({ path: 'f.ts', body: block }).anchor).toBeNull()
    expect(readAnchor({ body: 'plain' })).toEqual({ anchor: null, body: 'plain' })
  })

  it('writes the contract fields (commitOid as bytes) and reads them back through the same adapter', () => {
    const anchor = { path: 'src/a.ts', line: 7, side: 0 as const, commitOid: HEAD }
    const { fields, body } = writeAnchor(anchor, 'hi')
    expect(Object.keys(fields)).toEqual(['path', 'line', 'side', 'commitOid'])
    expect(bytesToHex(fields['commitOid'] as Uint8Array)).toBe(HEAD)
    expect(readAnchor({ path: 'src/a.ts', line: 7, side: 0, commitOid: bytesToHex(fields['commitOid'] as Uint8Array), body })).toEqual({ anchor, body: 'hi' })
    expect('commitOid' in writeAnchor({ ...anchor, commitOid: '' }, '').fields).toBe(false)
  })

  it('refuses to serialize a path that would close the comment early', () => {
    expect(() => serializeAnchorBlock({ path: 'a-->b', line: 1, side: 1, commitOid: '' }, '')).toThrow()
  })
})

function comment(id: string, extra: Partial<CommentView> = {}): CommentView {
  return { id, author: 'A', body: id, createdAt: Number(id.replace(/\D/g, '')) || 0, replyTo: null, anchor: null, ...extra }
}

describe('inline thread placement', () => {
  const on = (path: string, line: number, commitOid = HEAD, side: 0 | 1 = 1) => ({ anchor: { path, line, side, commitOid } })

  it('shows threads on the current head under their line, replies included', () => {
    const cs = [comment('c1', on('a.ts', 3)), comment('c2', { replyTo: 'c1' }), comment('c3', { replyTo: 'c2' }), comment('c4')]
    const placed = placeThreads(cs, HEAD, () => true)
    const t = placed.current.get('1:3:a.ts')
    expect(t?.map((x) => [x.root.id, x.replies.map((r) => r.id)])).toEqual([['c1', ['c2', 'c3']]])
    expect(placed.outdated).toEqual([])
    expect(placed.general.map((c) => c.id)).toEqual(['c4'])
  })

  it('collapses comments on an older head, or on a line the diff no longer shows, and counts them', () => {
    const cs = [
      comment('c1', on('a.ts', 3, OLD)),
      comment('c2', { replyTo: 'c1' }),
      comment('c3', on('a.ts', 99)),
      comment('c4', on('b.ts', 1, '')),
    ]
    const placed = placeThreads(cs, HEAD, (path, _side, line) => path === 'a.ts' && line < 50)
    expect(placed.current.size).toBe(0)
    expect(placed.outdated.map((t) => t.root.id)).toEqual(['c1', 'c3', 'c4'])
    expect(placed.outdatedCount).toBe(4)
  })

  it('keeps sides apart and survives a reply cycle', () => {
    const cs = [comment('c1', on('a.ts', 3, HEAD, 0)), comment('c2', on('a.ts', 3, HEAD, 1)), comment('c3', { replyTo: 'c4' }), comment('c4', { replyTo: 'c3' })]
    const placed = placeThreads(cs, HEAD, null)
    expect([...placed.current.keys()].sort()).toEqual(['0:3:a.ts', '1:3:a.ts'])
    expect(placed.general.map((c) => c.id)).toEqual(['c3', 'c4'])
  })
})

describe('review fold summary', () => {
  const M1 = 'maint-1'
  const M2 = 'maint-2'
  const W = 'writer-1'
  const S = 'stranger'
  const oracle = new RoleOracle([
    { identity: M1, role: 'maintainer', createdAt: 1 },
    { identity: M2, role: 'maintainer', createdAt: 1 },
    { identity: W, role: 'writer', createdAt: 50 },
  ])
  const r = (id: string, reviewer: string, verdict: number, commitOid: string, createdAt: number): Review => ({ id, reviewer, verdict, commitOid, createdAt })

  it('shows the fold exactly: counted, stale, non-member and author approvals', () => {
    const reviews = [
      r('r1', M1, 1, HEAD, 10),
      r('r2', M2, 1, HEAD, 11),
      r('r3', W, 2, OLD, 60), // a member, but on an older head: stale
      r('r4', S, 1, HEAD, 12), // never a member
      r('r5', W, 1, HEAD, 20), // before W joined (50): doesn't count
      r('r6', W, 3, HEAD, 70), // comment-only: neither counts nor clears
    ]
    const s = summarizeReviews(reviews, oracle, HEAD, M2)
    expect(s.approvedBy).toEqual({ maintainers: 2, writers: 0 })
    expect(approverPhrase(s.approvedBy)).toBe('2 maintainers')
    expect(s.rows).toEqual([
      { reviewer: M1, standing: { kind: 'approved', role: 'maintainer', self: false } },
      { reviewer: M2, standing: { kind: 'approved', role: 'maintainer', self: true } },
      { reviewer: W, standing: { kind: 'stale', verdict: 'changes', commitOid: OLD } },
      { reviewer: S, standing: { kind: 'not-member', verdict: 'approve' } },
    ])
  })

  it('a newer request for changes replaces an approval', () => {
    const s = summarizeReviews([r('r1', M1, 1, HEAD, 10), r('r2', M1, 2, HEAD, 11)], oracle, HEAD, 'someone')
    expect(s.changesRequestedBy).toEqual([M1])
    expect(s.rows).toEqual([{ reviewer: M1, standing: { kind: 'changes', role: 'maintainer' } }])
    expect(approverPhrase({ maintainers: 1, writers: 1 })).toBe('1 maintainer and 1 writer')
  })
})

describe('document encodings (forge-core parity; packManifest is covered with lib/storage)', () => {
  const enc = (s: string) => new TextEncoder().encode(s)

  it('patch: ref-name hashes are sha256 of the names; head and source repo are raw bytes', () => {
    const data = patchData({
      title: 'Fix it',
      body: '',
      baseRefName: 'refs/heads/main',
      sourceRepoId: REPO,
      sourceRefName: 'refs/heads/my-fix',
      headOid: HEAD,
    })
    expect(Object.keys(data)).toEqual(['title', 'baseRefNameHash', 'baseRefName', 'sourceRepoId', 'sourceRefNameHash', 'sourceRefName', 'headOid'])
    expect(bytesToHex(data['baseRefNameHash'] as Uint8Array)).toBe(bytesToHex(sha256(enc('refs/heads/main'))))
    expect(bytesToHex(data['sourceRefNameHash'] as Uint8Array)).toBe(bytesToHex(sha256(enc('refs/heads/my-fix'))))
    expect(data['sourceRepoId']).toEqual(base58Decode(REPO))
    expect(bytesToHex(data['headOid'] as Uint8Array)).toBe(HEAD)
    expect(() => patchData({ title: ' ', body: '', baseRefName: 'refs/heads/main', sourceRepoId: REPO, sourceRefName: 'x', headOid: HEAD })).toThrow()
    expect(() => patchData({ title: 't', body: '', baseRefName: 'refs/heads/a b', sourceRepoId: REPO, sourceRefName: 'x', headOid: HEAD })).toThrow()
  })

  it('ref update: sha256 name hash, raw oids, force, and protected routing', () => {
    const d = refUpdateData({ refName: 'refs/heads/main', newOid: HEAD, prevOid: OLD })
    expect(bytesToHex(d['refNameHash'] as Uint8Array)).toBe(bytesToHex(sha256(enc('refs/heads/main'))))
    expect(bytesToHex(d['newOid'] as Uint8Array)).toBe(HEAD)
    expect(bytesToHex(d['prevOid'] as Uint8Array)).toBe(OLD)
    expect(d['force']).toBe(false)
    expect('prevOid' in refUpdateData({ refName: 'refs/heads/x', newOid: HEAD })).toBe(false)
    expect(() => refUpdateData({ refName: 'refs/heads/a\nb', newOid: HEAD })).toThrow()
    expect(refUpdateType('refs/heads/main', ['refs/heads/main'])).toBe('protectedRefUpdate')
    expect(refUpdateType('refs/heads/release/1', ['refs/heads/release/*'])).toBe('protectedRefUpdate')
    expect(refUpdateType('refs/heads/dev', ['refs/heads/main'])).toBe('refUpdate')
  })
})

