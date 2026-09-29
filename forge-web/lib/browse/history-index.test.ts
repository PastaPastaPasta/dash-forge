/** The history index decoder, against forge-core's own bytes (the shared fixture). */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzip } from 'pako'
import { describe, expect, it } from 'vitest'

import { overlayHistory, parseHistoryIndex } from './history-index'

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
