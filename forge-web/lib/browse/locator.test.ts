/**
 * objectLocator merge semantics — the reader half of fragmented index publication.
 *
 * A push publishes a locator over just the pack it stored (36 bytes per object ADDED, not a
 * whole-index republish per push — forge-core `RepoService::publish_push_locator`), so a repo
 * between repacks has several live fragments and the reader folds them. These pin the two
 * properties the fold has to have: total coverage, and rows that never move.
 *
 * Parity: forge-core `pack::ObjectLocator::merge` (same earliest-wins rule).
 */

import { describe, expect, it } from 'vitest'

import { serializeLocator, type IndexedObject } from './indexer'
import { ObjectLocator } from './locator'

const oid = (n: number): string => n.toString(16).padStart(40, '0')

function fragment(packRef: number, objects: readonly (readonly [number, number])[]): ObjectLocator {
  const rows: IndexedObject[] = objects.map(([n, offset]) => ({
    oidHex: oid(n),
    packRef,
    offset,
    length: 10 + n,
    deltaDepth: 0,
  }))
  return ObjectLocator.parse(serializeLocator(rows))
}

const bytes = (oidHex: string): Uint8Array =>
  Uint8Array.from((oidHex.match(/../g) ?? []).map((b) => parseInt(b, 16)))

describe('ObjectLocator.merge', () => {
  it('covers every fragment and keeps each row with its own pack', () => {
    const a = fragment(0, [
      [0x10, 100],
      [0x30, 300],
    ])
    const b = fragment(1, [
      [0x20, 200],
      [0x40, 400],
    ])
    const merged = ObjectLocator.merge([a, b])

    expect(merged.count).toBe(4)
    expect(merged.lookup(bytes(oid(0x10)))).toMatchObject({ packRef: 0, offset: 100 })
    expect(merged.lookup(bytes(oid(0x20)))).toMatchObject({ packRef: 1, offset: 200 })
    expect(merged.lookup(bytes(oid(0x30)))).toMatchObject({ packRef: 0, offset: 300 })
    expect(merged.lookup(bytes(oid(0x40)))).toMatchObject({ packRef: 1, offset: 400 })
    expect([...merged.packRefsCovered()].sort()).toEqual([0, 1])
  })

  it('keeps the EARLIEST row for an OID carried by more than one fragment', () => {
    // The same object can be stored in two packs (a force-push re-sending it, say). Both
    // are live and either reads correctly, but the set a reader resolves must not shift as
    // fragments accumulate — so the earliest fragment's row wins.
    const a = fragment(0, [[0x10, 100]])
    const b = fragment(1, [
      [0x10, 999],
      [0x20, 200],
    ])
    const merged = ObjectLocator.merge([a, b])

    expect(merged.count).toBe(2)
    expect(merged.lookup(bytes(oid(0x10)))).toMatchObject({ packRef: 0, offset: 100 })
    expect(merged.lookup(bytes(oid(0x20)))).toMatchObject({ packRef: 1, offset: 200 })
  })

  it('is idempotent: folding in a fragment already covered changes nothing', () => {
    const a = fragment(0, [
      [0x10, 100],
      [0x30, 300],
    ])
    const b = fragment(1, [[0x20, 200]])
    const once = ObjectLocator.merge([a, b])
    const twice = ObjectLocator.merge([once, a, b])
    expect(twice.count).toBe(once.count)
    for (const n of [0x10, 0x20, 0x30]) {
      expect(twice.lookup(bytes(oid(n)))).toEqual(once.lookup(bytes(oid(n))))
    }
  })

  it('keeps rows sorted so the fanout binary search still finds every OID', () => {
    // Interleaved OIDs across fragments: a merge that simply concatenated would leave the
    // rows unsorted, and `lookup` — a binary search inside a fanout slice — would miss.
    const a = fragment(0, [
      [0x0102, 1],
      [0x0104, 2],
      [0x0106, 3],
    ])
    const b = fragment(1, [
      [0x0101, 4],
      [0x0103, 5],
      [0x0105, 6],
    ])
    const merged = ObjectLocator.merge([a, b])
    for (const n of [0x0101, 0x0102, 0x0103, 0x0104, 0x0105, 0x0106]) {
      expect(merged.lookup(bytes(oid(n))), `oid ${n.toString(16)}`).not.toBeNull()
    }
    // A reparse of the serialized bytes must agree — the fanout has to match the rows.
    const reparsed = ObjectLocator.parse(merged.asBytes())
    expect(reparsed.count).toBe(merged.count)
    expect(reparsed.lookup(bytes(oid(0x0105)))).toMatchObject({ packRef: 1 })
  })

  it('returns a single fragment unchanged', () => {
    const a = fragment(2, [[0x10, 100]])
    expect(ObjectLocator.merge([a])).toBe(a)
    expect([...a.packRefsCovered()]).toEqual([2])
  })
})
