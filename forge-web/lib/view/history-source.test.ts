/** Which published history indexes count, and loading the one a tip needs. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { gzip, inflate as pakoInflate } from 'pako'
import { describe, expect, it } from 'vitest'

import type { PackManifest } from '../repo'
import { countCommits, walkCommitColumn } from './commit-log'
import { chainHistory, historySource, liveHistoryIndexes } from './history-source'

/** forge-core's fixture: a delta of tip ab… over the full index 5c5c…. */
const deltaBody = Uint8Array.from(
  Buffer.from(readFileSync(resolve(process.cwd(), '..', 'forge-contracts', 'fixtures', 'history-index.hex'), 'utf8').trim(), 'hex'),
)

/** The same body as a full index of `tip`: zero base. */
function fullOf(tip: string): Uint8Array {
  const b = Uint8Array.from(deltaBody)
  b.set(Buffer.from(tip, 'hex'), 5)
  b.fill(0, 25, 57)
  return gzip(b)
}

let seq = 0
function manifest(bytes: Uint8Array, tips: string[], over: Partial<PackManifest> = {}): PackManifest {
  seq++
  return {
    packHash: bytesToHex(sha256(bytes)),
    kind: 3,
    sizeBytes: bytes.length,
    objectCount: 1,
    chunkCount: 1,
    storage: 0,
    uris: [],
    tips,
    supersedes: [],
    createdAt: seq,
    documentId: `doc${seq}`,
    uploader: 'writer',
    ownerRole: 'writer',
    ...over,
  }
}

describe('liveHistoryIndexes', () => {
  it('counts only current members and drops what a member superseded', () => {
    const a = manifest(fullOf('aa'.repeat(20)), ['aa'.repeat(20)])
    const b = manifest(fullOf('bb'.repeat(20)), ['bb'.repeat(20)], { supersedes: [a.packHash] })
    const stranger = manifest(fullOf('cc'.repeat(20)), ['cc'.repeat(20)], { uploader: 'x', ownerRole: null })
    // A stranger cannot un-list a member's index by superseding it.
    const hostile = manifest(new Uint8Array([1]), ['dd'.repeat(20)], { uploader: 'y', ownerRole: null, supersedes: [b.packHash] })
    const live = liveHistoryIndexes([a, b, stranger, hostile])
    expect(live.map((e) => e.tip)).toEqual(['bb'.repeat(20)])
  })
})

describe('historySource', () => {
  it('loads a delta overlaid on its base, verifying tips', async () => {
    const tip = 'ab'.repeat(20)
    const baseTip = '11'.repeat(20)
    const full = fullOf(baseTip)
    const fullM = manifest(full, [baseTip])
    // The delta names its base by the full index's packHash.
    const body = Uint8Array.from(deltaBody)
    body.set(Buffer.from(fullM.packHash, 'hex'), 25)
    const delta = gzip(body)
    const deltaM = manifest(delta, [tip, baseTip])
    const bytes = new Map([
      [fullM.packHash, full],
      [deltaM.packHash, delta],
    ])
    let fetched = 0
    const src = historySource([deltaM, fullM], async (m) => (fetched++, bytes.get(m.packHash) as Uint8Array))
    expect(src).not.toBeNull()
    expect([...(src?.byTip.keys() ?? [])].sort()).toEqual([baseTip, tip].sort())
    const ix = await src!.load(tip)
    expect(ix.tip).toBe(tip)
    expect(ix.base).toBeNull()
    expect(ix.commitCount).toBe(33_553)
    expect(ix.paths.get('src/wallet/db.cpp')?.subject).toMatch(/tidy the wallet/)
    await src!.load(tip)
    expect(fetched).toBe(2)
  })

  it('refuses an index whose bytes describe another tip than its manifest', async () => {
    const bytes = fullOf('ee'.repeat(20))
    const m = manifest(bytes, ['ff'.repeat(20)])
    const src = historySource([m], async () => bytes)
    await expect(src!.load('ff'.repeat(20))).rejects.toThrow(/another tip/)
  })

  it('a delta without a live base covers nothing; of two full indexes of one tip, the newer', () => {
    const tip = 'ab'.repeat(20)
    const orphan = manifest(new Uint8Array([7]), [tip, '99'.repeat(20)])
    expect(historySource([orphan, manifest(new Uint8Array([8]), ['00'.repeat(20)])], async () => new Uint8Array())?.covers(tip)).toBe(false)
    const older = manifest(new Uint8Array([1]), [tip])
    const newer = manifest(new Uint8Array([2]), [tip])
    const src = historySource([newer, older], async () => new Uint8Array())
    expect(src?.byTip.get(tip)?.manifest.packHash).toBe(newer.packHash)
  })

  it('is null for a repository with no history index', () => {
    expect(historySource([manifest(new Uint8Array([1]), [], { kind: 1 })], async () => new Uint8Array())).toBeNull()
  })

  it('prefers a full index at a tip over a delta', () => {
    const tip = 'bb'.repeat(20)
    const base = manifest(fullOf('aa'.repeat(20)), ['aa'.repeat(20)])
    const delta = manifest(fullOf('cc'.repeat(20)), [tip, 'aa'.repeat(20)])
    const full = manifest(fullOf(tip), [tip])
    const src = historySource([base, delta, full], () => Promise.reject(new Error('unused')))
    expect(src?.byTip.get(tip)?.baseTip).toBeNull()
    expect(historySource([base, delta], () => Promise.reject(new Error('unused')))?.byTip.get(tip)?.baseTip).toBe('aa'.repeat(20))
  })

  it('reads the column index for the file list and the counts, and never the version lists', async () => {
    const tip = 'ab'.repeat(20)
    // The column index (kind 3, format 1) and the version lists (kind 5, format 2) of one tip.
    const columnBytes = fullOf(tip)
    const lists = (() => {
      const b = pakoInflate(columnBytes)
      b[4] = 2
      return gzip(b)
    })()
    const column = manifest(columnBytes, [tip])
    const versions = manifest(lists, [tip], { kind: 5 })
    const fetched: number[] = []
    const src = historySource([column, versions], async (m) => {
      fetched.push(m.kind)
      return m.packHash === column.packHash ? columnBytes : lists
    })
    if (src === null) throw new Error('a history source')
    expect(src.covers(tip) && src.coversVersions(tip)).toBe(true)
    // The file list's column and the ref bar's count, as the pages ask for them.
    const reader = { memoScope: {} } as never
    const names = [...(await src.load(tip)).paths.keys()].filter((p) => !p.includes('/'))
    await walkCommitColumn(reader, tip, names, () => undefined, { history: src })
    const count = await countCommits(reader, tip, 1000, { history: src })
    expect(count.fromIndex).toBe(true)
    expect(fetched).toEqual([3])
    // Blame and History read the version lists, which the column index never carries.
    expect((await src.load(tip)).format).toBe(1)
    expect((await src.loadVersions(tip)).format).toBe(2)
    expect(fetched).toEqual([3, 5])
  })

  it('refuses an artifact whose format is not its kind\'s', async () => {
    const tip = 'ab'.repeat(20)
    const column = manifest(fullOf(tip), [tip], { kind: 5 })
    const src = historySource([column], async () => fullOf(tip))
    await expect(src?.loadVersions(tip)).rejects.toThrow(/kind-5 artifact must be format 2/)
  })
})

describe('chainHistory', () => {
  // A fork reads its parent's history indexes for the tips it shares (QW-023), its own first.
  it("answers from the fork's own index first, then its parent's", async () => {
    const own = 'aa'.repeat(20)
    const shared = 'bb'.repeat(20)
    const ownBytes = fullOf(own)
    const parentBytes = fullOf(shared)
    const mine = historySource([manifest(ownBytes, [own])], async () => ownBytes)
    const parents = historySource([manifest(parentBytes, [shared])], async () => parentBytes)
    const src = chainHistory(mine, parents)
    if (src === null) throw new Error('a history source')
    expect(src.covers(own) && src.covers(shared)).toBe(true)
    expect(src.covers('cc'.repeat(20))).toBe(false)
    expect([...src.byTip.keys()].sort()).toEqual([own, shared])
    expect((await src.load(own)).tip).toBe(own)
    expect((await src.load(shared)).tip).toBe(shared)
    expect(chainHistory(null, parents)).toBe(parents)
    expect(chainHistory(mine, null)).toBe(mine)
  })
})
