/**
 * The file view's GitHub behaviours (QW-025, QW-060): a Markdown file opens rendered unless the URL
 * addresses its lines, and Blame is offered only for a text file it can read.
 */

import { describe, expect, it } from 'vitest'

import { BLAME_MAX_BYTES } from '@/lib/view/blame'
import { blameable, isMarkdownName, opensAsCode } from './blob-content'

describe('Markdown preview', () => {
  it('knows Markdown by its extension, in any case', () => {
    for (const name of ['README.md', 'dip-0001.md', 'NOTES.MARKDOWN', 'a.mdown', 'b.mkd']) expect(isMarkdownName(name), name).toBe(true)
    for (const name of ['md', 'x.mdx', 'readme.txt', 'a.md.orig']) expect(isMarkdownName(name), name).toBe(false)
  })

  it('opens the source for a line link or ?plain=1, the preview otherwise', () => {
    expect(opensAsCode('#L10', '')).toBe(true)
    expect(opensAsCode('#L10-L20', '?owner=o&name=n')).toBe(true)
    expect(opensAsCode('', '?owner=o&name=n&plain=1')).toBe(true)
    // A heading anchor from the rendered table of contents stays on the preview.
    expect(opensAsCode('#abstract', '')).toBe(false)
    expect(opensAsCode('#user-content-Lists', '')).toBe(false)
    expect(opensAsCode('', '?owner=o&name=n&path=README.md')).toBe(false)
  })
})

describe('Blame offered', () => {
  it('for text within the bound, not for a binary or a file too large', () => {
    expect(blameable(10, 'hello')).toBe(true)
    expect(blameable(BLAME_MAX_BYTES, 'x')).toBe(true)
    expect(blameable(1_000_000, null)).toBe(false)
    expect(blameable(BLAME_MAX_BYTES + 1, 'x')).toBe(false)
  })
})
