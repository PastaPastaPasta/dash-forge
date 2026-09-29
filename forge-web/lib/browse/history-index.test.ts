/** The history index decoder, against forge-core's own bytes (the shared fixture). */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzip } from 'pako'
import { describe, expect, it } from 'vitest'

import { MAX_INFLATED, overlayHistory, parseHistoryIndex, parseHistoryIndexOfKind, type HistoryIndex, type VersionList } from './history-index'

/** A body forge-core wrote to `forge-contracts/fixtures/<name>` (before gzip). */
const fixture = (name: string): Uint8Array =>
  Uint8Array.from(Buffer.from(readFileSync(resolve(process.cwd(), '..', 'forge-contracts', 'fixtures', name), 'utf8').trim(), 'hex'))

/** The body forge-core's `the_shared_decoder_fixture_matches` writes (before gzip): a v1 index. */
const body = fixture('history-index.hex')

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
      author: '',
    })
    // A v1 index has no version lists.
    expect(ix.versions).toBeNull()
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

  it('skips an extension section it does not know', () => {
    const v2 = Uint8Array.from([...body, 7, 3, 0xaa, 0xbb, 0xcc])
    v2[4] = 2
    expect(parseHistoryIndex(gzip(v2))).toEqual({ ...parseHistoryIndex(gzip(body)), format: 2 })
  })

  it('takes the format from the header only, and refuses one it does not know', () => {
    expect(parseHistoryIndex(gzip(body)).format).toBe(1)
    for (const v of [0, 3, 255]) {
      const b = Uint8Array.from(body)
      b[4] = v
      expect(() => parseHistoryIndex(gzip(b))).toThrow(`history index format ${v} is not one this client reads`)
    }
    // A column index (kind 3) is format 1 and version lists (kind 5) format 2 (forge-core
    // `HistoryIndex::parse_kind`); each is refused as the other kind.
    const v2 = Uint8Array.from(body)
    v2[4] = 2
    expect(parseHistoryIndexOfKind(gzip(body), 3).format).toBe(1)
    expect(parseHistoryIndexOfKind(gzip(v2), 5).format).toBe(2)
    expect(() => parseHistoryIndexOfKind(gzip(v2), 3)).toThrow(/kind-3 artifact must be format 1/)
    expect(() => parseHistoryIndexOfKind(gzip(body), 5)).toThrow(/kind-5 artifact must be format 2/)
    expect(() => parseHistoryIndexOfKind(gzip(body), 1)).toThrow(/not a history index kind/)
  })

  it('overlays a delta on its full index', () => {
    const delta = parseHistoryIndex(gzip(body))
    const full = { ...delta, base: null, paths: new Map([['old.txt', { oid: 'ff'.repeat(20), subject: 'old', when: 1, author: '' }]]) }
    const both = overlayHistory(full, delta)
    expect(both.base).toBeNull()
    expect(both.paths.get('old.txt')?.subject).toBe('old')
    expect(both.paths.get('src')?.subject).toBe('Merge #1234: refactor: tidy the wallet')
    expect(both.commitCount).toBe(delta.commitCount)
  })
})

/** Each list as `commit mode prefix` strings, with its completeness: comparable across indexes. */
function lists(versions: ReadonlyMap<string, VersionList> | null, only?: ReadonlyMap<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [path, l] of versions ?? []) {
    if (only !== undefined && !only.has(path)) continue
    out[path] = [...l.versions.map((v) => `${v.commit.oid} ${v.mode.toString(8)} ${v.oidPrefix}`), l.complete ? 'complete' : 'more']
  }
  return out
}

describe('the column index (kind 3) forge-core derives from a v2 index', () => {
  it('has the same paths and last changes in format 1, and no version lists', () => {
    const whole = parseHistoryIndexOfKind(gzip(fixture('history-index-v2.hex')), 5)
    const column = parseHistoryIndexOfKind(gzip(fixture('history-index-v2-column.hex')), 3)
    expect(column.format).toBe(1)
    expect(column.versions).toBeNull()
    expect([...column.paths.keys()]).toEqual([...whole.paths.keys()])
    for (const [path, c] of column.paths) {
      const w = whole.paths.get(path)
      expect({ oid: c.oid, subject: c.subject, when: c.when }).toEqual({ oid: w?.oid, subject: w?.subject, when: w?.when })
    }
    expect([column.tip, column.commitCount, column.firstParentCount]).toEqual([whole.tip, whole.commitCount, whole.firstParentCount])
  })
})

describe('history index v2: version lists', () => {
  it('reads the versions section forge-core wrote: authors, modes, prefixes, whole and cut lists', () => {
    const ix = parseHistoryIndex(gzip(fixture('history-index-v2.hex')))
    expect(ix.versionLimit).toBe(2)
    // Authors come with the lists, decoded on first read.
    expect(ix.paths.get('README.md')?.author).toBe('')
    expect(ix.versions?.size).toBe(3)
    expect(ix.paths.get('README.md')?.author).toBe('Zoë Ångström')
    expect(ix.paths.get('src')?.author).toBe('Wladimir J. van der Laan')
    expect(lists(ix.versions)).toEqual({
      'README.md': [`${'02'.repeat(20)} 100644 010203040506`, `${'03'.repeat(20)} 100755 070707070707`, 'complete'],
      src: [`${'01'.repeat(20)} 40000 `, `${'03'.repeat(20)} 40000 `, 'more'],
      'src/wallet.cpp': [`${'01'.repeat(20)} 120000 fefefefefefe`, 'more'],
    })
    // The column still reads as v1 did.
    expect(ix.paths.get('src/wallet.cpp')?.subject).toBe('Merge #1234: refactor: tidy the wallet')
  })

  it('overlays a delta on its base as a full index of the delta tip lists (forge-core computed all three from git)', () => {
    const base = parseHistoryIndex(gzip(fixture('history-index-v2-base.hex')))
    const delta = parseHistoryIndex(gzip(fixture('history-index-v2-delta.hex')))
    const tip = parseHistoryIndex(gzip(fixture('history-index-v2-tip.hex')))
    const both = overlayHistory(base, delta)
    // Every path of the tip: the same list, the same completeness (lists hold 3 here).
    expect(lists(both.versions, tip.paths)).toEqual(lists(tip.versions))
    expect(both.versionLimit).toBe(3)
    // README gained two edits over its two: cut to 3, so no longer whole.
    expect(lists(both.versions)['README.md']?.at(-1)).toBe('more')
  })

  it('mixes v1 and v2: a v1 delta leaves its changed paths unknown, a v1 base leaves only the delta lists', () => {
    const base = parseHistoryIndex(gzip(fixture('history-index-v2-base.hex')))
    const delta = parseHistoryIndex(gzip(fixture('history-index-v2-delta.hex')))
    const asV1 = (ix: HistoryIndex): HistoryIndex => ({ ...ix, versions: null, versionLimit: 0 })
    const v1Delta = overlayHistory(base, asV1(delta))
    for (const path of delta.paths.keys()) expect(v1Delta.versions?.has(path)).toBe(false)
    const unchanged = [...base.paths.keys()].find((p) => !delta.paths.has(p)) as string
    expect(v1Delta.versions?.get(unchanged)).toEqual(base.versions?.get(unchanged))
    const v1Base = overlayHistory(asV1(base), delta)
    expect([...(v1Base.versions?.keys() ?? [])].sort()).toEqual([...delta.paths.keys()].sort())
    expect(overlayHistory(asV1(base), asV1(delta)).versions).toBeNull()
  })

  it('refuses hostile version sections: every count, index and length is bounded', () => {
    // One commit, one path "a", then the section (forge-core `hostile_version_sections_are_refused`).
    const head = (section: number[]): Uint8Array =>
      gzip(Uint8Array.from([0x44, 0x46, 0x48, 0x49, 2, ...new Array(52).fill(0), 1, 1, 0, 0, 1, ...new Array(20).fill(9), 0, 0, 1, 0, 1, 0x61, 0, 1, section.length, ...section]))
    const good = [4, 6, 1, 1, 0x78, 0, 3, 0, 0xa4, 0x83, 0x02, 1, 2, 3, 4, 5, 6]
    const ok = parseHistoryIndex(head(good))
    expect(ok.versions?.get('a')?.versions[0]).toMatchObject({ mode: 0o100644, oidPrefix: '010203040506' })
    expect(ok.paths.get('a')?.author).toBe('x')
    const at = (i: number, b: number): number[] => good.map((x, j) => (j === i ? b : x))
    expect(() => parseHistoryIndex(head(at(0, 0))).versions).toThrow(/limit is out of range/)
    expect(() => parseHistoryIndex(head([0x81, 0x40, ...good.slice(1)])).versions).toThrow(/limit is out of range/)
    expect(() => parseHistoryIndex(head(at(1, 3))).versions).toThrow(/prefix length/)
    expect(() => parseHistoryIndex(head(at(1, 21))).versions).toThrow(/prefix length/)
    expect(() => parseHistoryIndex(head(at(5, 1))).versions).toThrow(/names an author/)
    expect(() => parseHistoryIndex(head(at(6, 11))).versions).toThrow(/longer than its limit/)
    expect(() => parseHistoryIndex(head(at(7, 1))).versions).toThrow(/names a commit/)
    expect(() => parseHistoryIndex(head(good.slice(0, -1))).versions).toThrow(/truncated/)
    expect(() => parseHistoryIndex(head([...good, 0])).versions).toThrow(/trailing bytes/)
    expect(() => parseHistoryIndex(head([4, 6, 0x81, 0x92, 0xf4, 0x01])).versions).toThrow(/too many rows/)
    // As forge-core: a mode past 32 bits, and a subject or author that is not UTF-8 (review L6).
    expect(() => parseHistoryIndex(head([4, 6, 1, 1, 0x78, 0, 3, 0, 0x80, 0x80, 0x80, 0x80, 0x10])).versions).toThrow(/mode overflows/)
    expect(() => parseHistoryIndex(head([4, 6, 1, 1, 0xff, 0, 3, 0, 0xa4, 0x83, 0x02, 1, 2, 3, 4, 5, 6])).versions).toThrow(/author is not UTF-8/)
    // A malformed lists section costs Blame and History their lists, not the column its commits.
    const torn = parseHistoryIndex(head(at(7, 1)))
    expect(torn.paths.get('a')?.oid).toBe('09'.repeat(20))
    expect(torn.versionLimit).toBe(4)
    expect(() => torn.versions).toThrow(/names a commit/)
    // And the inflate cap holds for a v2 body.
    expect(() => parseHistoryIndex(head(good), 64)).toThrow(/size limit/)
  })
})
