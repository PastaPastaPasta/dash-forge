/**
 * The author/committer-line classification shared with the Rust tools, and how those lines read:
 *
 *  - `RELAXED_FSCK_IDS` is exactly `RELAXED` in `crates/forge-core/src/pack/fsck.rs` (the helper's
 *    index-pack and the push check), so a history the CLI clones and pushes also merges here;
 *  - a malformed line reads its date as git's `parse_commit_date` does (the digits after the last
 *    `>`, leading whitespace skipped), so psf/requests' 5e6ecdad (`+051800`) shows its real date.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseCommit, RELAXED_FSCK_IDS } from './git-objects'

const FSCK_RS = join(__dirname, '../../../crates/forge-core/src/pack/fsck.rs')

describe('the relaxed fsck ids', () => {
  it('are the Rust list, in the same order', () => {
    const src = readFileSync(FSCK_RS, 'utf8')
    const list = /pub const RELAXED: &\[&str\] = &\[([^\]]*)\]/.exec(src)?.[1]
    expect(list, 'RELAXED not found in fsck.rs').toBeDefined()
    const rust = [...(list as string).matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1])
    expect(RELAXED_FSCK_IDS).toEqual(rust)
  })
})

describe('malformed author lines read as git reads them', () => {
  const T = '1'.repeat(40)
  const when = (ident: string): number => parseCommit(new TextEncoder().encode(`tree ${T}\nauthor ${ident}\ncommitter ${ident}\n\nm\n`)).committer.when

  it('psf/requests 5e6ecdad: a time zone git refuses still gives the date', () => {
    const c = parseCommit(new TextEncoder().encode(`tree ${T}\nauthor Shrikant Sharat Kandula <shrikantsharat.k@gmail.com> 1313584730 +051800\ncommitter Shrikant Sharat Kandula <shrikantsharat.k@gmail.com> 1313584730 +051800\n\nm\n`))
    expect(c.committer).toEqual({ name: 'Shrikant Sharat Kandula', email: 'shrikantsharat.k@gmail.com', when: 1313584730_000 })
  })

  it('no space before the date, extra spaces, a zero-padded date, no zone', () => {
    expect(when('A <a@b>1313584730 +0000')).toBe(1313584730_000)
    expect(when('A <a@b>   1313584730 +0000')).toBe(1313584730_000)
    expect(when('A <a@b> 01313584730 +0000')).toBe(1313584730_000)
    expect(when('A <a@b> 1313584730')).toBe(1313584730_000)
  })

  it('no date, or one past what a JS date holds, is 0 (unknown), never NaN', () => {
    expect(when('A <a@b> never +0000')).toBe(0)
    expect(when('A <a@b>')).toBe(0)
    expect(when('A 1313584730 +0000')).toBe(0)
    expect(when('A <a@b> 99999999999999999999 +0000')).toBe(0)
  })

  it('a well-formed line is unchanged', () => {
    const c = parseCommit(new TextEncoder().encode(`tree ${T}\nauthor A B <a@b.c> 1700000000 -0130\ncommitter A B <a@b.c> 1700000000 -0130\n\nm\n`))
    expect(c.author).toEqual({ name: 'A B', email: 'a@b.c', when: 1700000000_000 })
  })
})
