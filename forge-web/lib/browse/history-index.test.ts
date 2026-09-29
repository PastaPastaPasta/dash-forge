/** The history index decoder, against forge-core's own bytes (the shared fixture). */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzip } from 'pako'
import { describe, expect, it } from 'vitest'

import { MAX_INFLATED, overlayHistory, parseHistoryIndex } from './history-index'

/** The body forge-core's `the_shared_decoder_fixture_matches` writes (before gzip). */
const body = Uint8Array.from(
  Buffer.from(readFileSync(resolve(process.cwd(), '..', 'forge-contracts', 'fixtures', 'history-index.hex'), 'utf8').trim(), 'hex'),
)

describe('parseHistoryIndex', () => {
  it('reads what forge-core wrote', () => {
    const ix = parseHistoryIndex(gzip(body))
    expect(ix.tip).toBe('ab'.repeat(20))
    expect(ix.base).toBe('5c'.repeat(32))
    expect([ix.commitCount, ix.firstParentCount]).toEqual([33_553, 7_979])
    expect([ix.rootWhen, ix.tipWhen]).toEqual([1_325_376_000_000, 1_790_000_000_000])
    expect([...ix.paths.keys()]).toEqual(['README.md', 'src', 'src/wallet', 'src/wallet/db.cpp', 'src/walletx.h'])
    expect(ix.paths.get('src/wallet/db.cpp')).toEqual({
      oid: '01'.repeat(20),
      subject: 'Merge #1234: refactor: tidy the wallet',
      when: 1_700_000_000_000,
    })
    expect(ix.paths.get('src/walletx.h')?.subject).toBe('docs: naïve résumé ✓')
  })

  it('refuses truncated, torn or foreign bytes', () => {
    expect(() => parseHistoryIndex(gzip(body.subarray(0, body.length - 1)))).toThrow()
    expect(() => parseHistoryIndex(gzip(Uint8Array.from([...body, 7, 3, 0xaa])))).toThrow()
    const foreign = Uint8Array.from(body)
    foreign[0] = 0x58
    expect(() => parseHistoryIndex(gzip(foreign))).toThrow(/not a history index/)
  })

  it('refuses unsorted or duplicate paths, oversized varints and gzip bombs', () => {
    // A hand-built v1 index: one commit, then `paths` (each front-coded from nothing).
    const tiny = (paths: number[][]): Uint8Array => {
      const out = [0x44, 0x46, 0x48, 0x49, 1, ...new Array(52).fill(0), 1, 1, 0, 0, 1, ...new Array(20).fill(1), 0, 0]
      out.push(paths.length)
      for (const p of paths) out.push(0, p.length, ...p, 0)
      return Uint8Array.from(out)
    }
    expect(parseHistoryIndex(gzip(tiny([[0x61], [0x62]]))).paths.size).toBe(2)
    expect(() => parseHistoryIndex(gzip(tiny([[0x62], [0x61]])))).toThrow(/sorted/)
    expect(() => parseHistoryIndex(gzip(tiny([[0x61], [0x61]])))).toThrow(/sorted/)
    // Two invalid-UTF-8 byte strings that decode to the same replacement text.
    expect(() => parseHistoryIndex(gzip(tiny([[0xfe], [0xff]])))).toThrow(/duplicate/)
    const big = Uint8Array.from([0x44, 0x46, 0x48, 0x49, 1, ...new Array(52).fill(0), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])
    expect(() => parseHistoryIndex(gzip(big))).toThrow(/overflow/)
    expect(() => parseHistoryIndex(gzip(new Uint8Array(4097)), 4096)).toThrow(/size limit/)
    expect(MAX_INFLATED).toBe(64 * 1024 * 1024)
  })

  it('skips a later version\'s extension sections', () => {
    const v2 = Uint8Array.from([...body, 7, 3, 0xaa, 0xbb, 0xcc])
    v2[4] = 2
    expect(parseHistoryIndex(gzip(v2))).toEqual(parseHistoryIndex(gzip(body)))
  })

  it('overlays a delta on its full index', () => {
    const delta = parseHistoryIndex(gzip(body))
    const full = { ...delta, base: null, paths: new Map([['old.txt', { oid: 'ff'.repeat(20), subject: 'old', when: 1 }]]) }
    const both = overlayHistory(full, delta)
    expect(both.base).toBeNull()
    expect(both.paths.get('old.txt')?.subject).toBe('old')
    expect(both.paths.get('src')?.subject).toBe('Merge #1234: refactor: tidy the wallet')
    expect(both.commitCount).toBe(delta.commitCount)
  })
})
