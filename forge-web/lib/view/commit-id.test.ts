/** D-057: short and odd-length commit ids in a commit URL resolve the way git resolves them. */

import { describe, expect, it } from 'vitest'

import { ObjectLocator, type GitObject } from '../browse'
import { serializeLocator } from '../browse/indexer'
import { CommitIdError, resolveCommitOid, type PrefixReader } from './commit-log'

const COMMIT_A = 'ce97e47a1111111111111111111111111111111a'
const COMMIT_B = 'ab12345000000000000000000000000000000001'
const BLOB_B = 'ab12345f00000000000000000000000000000002'
const COMMIT_C1 = '0dd1ce0000000000000000000000000000000001'
const COMMIT_C2 = '0dd1cef000000000000000000000000000000002'

function reader(): PrefixReader {
  const types = new Map<string, GitObject['type']>([
    [COMMIT_A, 'commit'],
    [COMMIT_B, 'commit'],
    [BLOB_B, 'blob'],
    [COMMIT_C1, 'commit'],
    [COMMIT_C2, 'commit'],
  ])
  const locator = ObjectLocator.parse(
    serializeLocator(
      // COMMIT_A is stored in two packs: its rows repeat, the match must not.
      [...types.keys(), COMMIT_A].map((oidHex, i) => ({ oidHex, packRef: i === 5 ? 1 : 0, offset: 12 + i, length: 1, deltaDepth: 0 })),
    ),
  )
  return {
    findByPrefix: (p, limit) => locator.findByPrefix(p, limit),
    locate: (oid) => locator.lookup(Uint8Array.from(oid.match(/../g) ?? [], (h) => parseInt(h, 16))),
    readObject: async (oid) => {
      const type = types.get(oid)
      if (type === undefined) throw new Error(`object not in locator: ${oid}`)
      return { type, bytes: new Uint8Array(0) }
    },
  }
}

describe('ObjectLocator.findByPrefix', () => {
  it('finds the run of OIDs sharing an even or odd-length prefix', () => {
    const r = reader()
    expect(r.findByPrefix?.('ce97e47')).toEqual([COMMIT_A])
    expect(r.findByPrefix?.('CE97E47A')).toEqual([COMMIT_A])
    expect(r.findByPrefix?.('ab12345', 5)).toEqual([COMMIT_B, BLOB_B])
    expect(r.findByPrefix?.('0dd1ce', 5)).toEqual([COMMIT_C1, COMMIT_C2])
    expect(r.findByPrefix?.('ffff')).toEqual([])
    expect(r.findByPrefix?.('zz')).toEqual([])
  })
})

describe('resolveCommitOid', () => {
  it('resolves the 7-character id the UI shows (odd length)', async () => {
    await expect(resolveCommitOid(reader(), 'ce97e47')).resolves.toBe(COMMIT_A)
  })

  it('passes a full id through', async () => {
    await expect(resolveCommitOid(reader(), COMMIT_A.toUpperCase())).resolves.toBe(COMMIT_A)
  })

  it('prefers the one commit when a prefix also matches a blob', async () => {
    await expect(resolveCommitOid(reader(), 'ab12345')).resolves.toBe(COMMIT_B)
  })

  it('reports an ambiguous prefix with the candidates', async () => {
    const e = await resolveCommitOid(reader(), '0dd1ce').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(CommitIdError)
    expect((e as CommitIdError).kind).toBe('ambiguous')
    expect((e as CommitIdError).candidates).toEqual([COMMIT_C1, COMMIT_C2])
  })

  it('says not found, and refuses non-hex or too-short ids, without a raw hex error', async () => {
    for (const [input, kind] of [
      ['ffff00', 'not-found'],
      ['zzzz', 'invalid'],
      ['ce9', 'invalid'],
      ['', 'invalid'],
    ] as const) {
      const e = await resolveCommitOid(reader(), input).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(CommitIdError)
      expect((e as CommitIdError).kind).toBe(kind)
      expect((e as Error).message).not.toMatch(/even length/)
    }
  })
})
