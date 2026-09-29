/** Which published history indexes count, and loading the one a tip needs. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { gzip } from 'pako'
import { describe, expect, it } from 'vitest'

import type { PackManifest } from '../repo'
import { historySource, liveHistoryIndexes } from './history-source'

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
})
