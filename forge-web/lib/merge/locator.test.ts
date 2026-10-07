import { hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { ObjectLocator } from '../browse'
import type { PackManifest } from '../repo'
import { Store } from '../view/diff-fixtures'
import { buildFragment, MAX_LOCATOR_FRAGMENTS, planFragment } from './locator'
import { writePack } from './pack-writer'

let seq = 0
function m(kind: 0 | 1, hash: string, createdAt: number): PackManifest {
  seq += 1
  return {
    packHash: hash,
    kind,
    sizeBytes: 1,
    objectCount: 1,
    chunkCount: 1,
    storage: 0,
    uris: [],
    tips: [],
    supersedes: [],
    createdAt,
    documentId: `doc${String(seq).padStart(4, '0')}`,
    uploader: 'U',
    ownerRole: 'maintainer',
  }
}
const h = (n: number): string => n.toString(16).padStart(2, '0').repeat(32)

describe('merge index fragment (forge-core plan_push_index)', () => {
  it("puts the fragment at the pack's position among the kind-0 packs, fragments not counted", () => {
    const list = [m(0, h(1), 1), m(1, h(90), 2), m(0, h(2), 3), m(1, h(91), 4), m(0, h(3), 5)]
    expect(planFragment(list, h(3))).toEqual({ kind: 'publish', packRef: 2 })
  })

  it('waits for a manifest not listed yet, and refuses a fragment space the list has moved past', () => {
    expect(planFragment([m(0, h(1), 1)], h(9))).toMatchObject({ kind: 'skip', retry: true })
    const tooMany = [m(0, h(1), 1), ...Array.from({ length: MAX_LOCATOR_FRAGMENTS }, (_, i) => m(1, h(100 + i), 2 + i)), m(0, h(2), 50)]
    expect(planFragment(tooMany, h(2))).toMatchObject({ kind: 'skip', retry: false })
  })

  it('counts a fragment retired only by a maintainer or writer fragment naming it, as forge-core does', () => {
    const frags = Array.from({ length: MAX_LOCATOR_FRAGMENTS }, (_, i) => m(1, h(100 + i), 2 + i))
    const fold = { ...m(1, h(200), 40), supersedes: frags.slice(0, 15).map((f) => f.packHash) }
    // The fold leaves two live fragments (its own and the newest): room for one more.
    expect(planFragment([m(0, h(1), 1), ...frags, fold, m(0, h(2), 50)], h(2))).toEqual({ kind: 'publish', packRef: 1 })
    // The same claims from a triage member, or on a git pack, retire nothing.
    const triage = { ...fold, ownerRole: 'triage' as const }
    expect(planFragment([m(0, h(1), 1), ...frags, triage, m(0, h(2), 50)], h(2))).toMatchObject({ kind: 'skip', retry: false })
    const gitClaim = { ...m(0, h(3), 41), supersedes: fold.supersedes }
    expect(planFragment([m(0, h(1), 1), ...frags, gitClaim, m(0, h(2), 50)], h(2))).toMatchObject({ kind: 'skip', retry: false })
  })

  it('builds a fragment whose rows address the pack at its packRef', async () => {
    const s = new Store()
    const c = s.commit(s.files({ 'a.txt': 'hello\n' }))
    const { bytes } = writePack([...s.objects.values()])
    const frag = await buildFragment(bytes, 7)
    expect(frag.objectCount).toBe(s.objects.size)
    const loc = ObjectLocator.parse(frag.bytes)
    expect([...loc.packRefsCovered()]).toEqual([7])
    expect(loc.lookup(hexToBytes(c))?.packRef).toBe(7)
  })
})
