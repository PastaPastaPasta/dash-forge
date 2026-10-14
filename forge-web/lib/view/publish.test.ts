/** What the publish dialog lists and scans (`publish.ts`). */

import { describe, expect, it } from 'vitest'

import { gitOidHex, type GitObject } from '../browse'
import { AllowList } from '../secrets'
import type { FileChange } from './commit-log'
import { authorName, namesBranch, peopleText, publishListText, scanChanges, scanLine, withCoAuthors } from './publish'
import type { ObjectReader } from './tree-nav'

const enc = (s: string) => new TextEncoder().encode(s)

/** A reader over `blobs` (by their git ids). */
function readerOf(blobs: readonly Uint8Array[]): ObjectReader {
  const byOid = new Map(blobs.map((b) => [gitOidHex('blob', b), b]))
  return {
    async readObject(oid: string): Promise<GitObject> {
      const bytes = byOid.get(oid)
      if (bytes === undefined) throw new Error(`no ${oid}`)
      return { type: 'blob', bytes }
    },
  }
}

const change = (path: string, blob: Uint8Array | null, status: FileChange['status'] = 'added'): FileChange => ({
  path,
  status,
  baseOid: null,
  headOid: blob === null ? null : gitOidHex('blob', blob),
  baseMode: null,
  headMode: blob === null ? null : 0o100644,
  oid: blob === null ? '' : gitOidHex('blob', blob),
})

describe('the exact list', () => {
  it('names people as §10 does', () => {
    expect(peopleText(['alice'])).toBe('alice')
    expect(peopleText(['alice', 'bob', 'alice'])).toBe('alice and bob')
    expect(peopleText(['alice', 'bob', 'carol'])).toBe('alice, bob and carol')
    expect(peopleText(['a', 'b', 'c', 'd', 'e'])).toBe('a, b and 3 others')
    expect(publishListText(3, ['alice', 'bob'], 14)).toBe('3 commits by alice and bob · 14 files')
    expect(publishListText(1, [], 1, true)).toBe('1 commit · at least 1 file')
    expect(publishListText(null, [], null)).toBe('')
    expect(authorName('Alice Example <alice@example.org>')).toBe('Alice Example')
  })
})

describe('the scan of what becomes public', () => {
  it('finds a refused secret, skips deleted files, and reads no further than the scan cap', async () => {
    const env = enc('DB_PASSWORD=hunter2\n')
    const readme = enc('# hello\n')
    const scan = await scanChanges(readerOf([env, readme]), [change('.env', env), change('README.md', readme), change('old.txt', null, 'deleted')], AllowList.parse(''))
    expect(scan.scanned).toBe(2)
    expect(scan.findings).toEqual([{ path: '.env', line: null, rule: 'env_file', severity: 'refuse' }])
    expect(scanLine(scan)).toMatch(/^Possible secret in \.env \(.+\)\. Publish anyway\?$/)
  })

  it('says none were found, or that only the first files were read', async () => {
    const readme = enc('# hello\n')
    const scan = await scanChanges(readerOf([readme]), [change('README.md', readme)], AllowList.parse(''))
    expect(scanLine(scan)).toBe('No secrets found.')
    expect(scanLine({ ...scan, partial: true })).toBe('No secrets found in the first 1 files.')
  })

  it("takes the repo's allow list: a fingerprint silences its finding", async () => {
    const env = enc('DB_PASSWORD=hunter2\n')
    const first = await scanChanges(readerOf([env]), [change('.env', env)], AllowList.parse(''))
    expect(first.findings).toHaveLength(1)
    const { scanFile } = await import('../secrets')
    const fp = scanFile('.env', env)[0]?.fingerprint ?? ''
    const allowed = await scanChanges(readerOf([env]), [change('.env', env)], AllowList.parse(`${fp}\n`))
    expect(allowed.findings).toEqual([])
  })
})

describe('the commit message', () => {
  it('notices the members-only branch named in it, by its short or full name, as a word', () => {
    expect(namesBranch('Merge branch sec/fix', 'refs/heads/sec/fix')).toBe(true)
    expect(namesBranch('Fix refs/heads/sec/fix', 'refs/heads/sec/fix')).toBe(true)
    expect(namesBranch('#12', 'refs/heads/sec/fix')).toBe(false)
    expect(namesBranch('a prefix change', 'refs/heads/fix')).toBe(false)
    expect(namesBranch('fix: a bug', 'refs/heads/fix')).toBe(true)
  })

  it('adds co-author lines only when asked, and drops ones the default carried', () => {
    expect(withCoAuthors('#12\n\nCo-authored-by: bob <bob@example.org>', [])).toBe('#12')
    expect(withCoAuthors('#12', ['bob <bob@example.org>'])).toBe('#12\n\nCo-authored-by: bob <bob@example.org>')
  })
})
