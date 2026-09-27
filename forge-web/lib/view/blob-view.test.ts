import { describe, expect, it } from 'vitest'

import { blobDisplay, RENDER_CONFIRM_BYTES, imagePreviewType, lineHash, parseLineHash, selectLine, visibleRows, IMAGE_PREVIEW_MAX_BYTES } from './blob-view'

const bytes = (...b: number[]): Uint8Array => new Uint8Array([...b, ...new Array(16).fill(0)])
const text = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('imagePreviewType (D-054)', () => {
  it('previews PNG, JPEG, GIF and WebP whose bytes match the extension', () => {
    expect(imagePreviewType('doc/logo.png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
    expect(imagePreviewType('a.JPG', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(imagePreviewType('a.jpeg', bytes(0xff, 0xd8, 0xff, 0xe1))).toBe('image/jpeg')
    expect(imagePreviewType('tiny.gif', bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif')
    expect(imagePreviewType('a.webp', bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe('image/webp')
  })

  it('does not preview a file whose bytes are not the named format', () => {
    expect(imagePreviewType('fake.png', text('not a png at all'))).toBeNull()
    expect(imagePreviewType('a.gif', bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull()
  })

  it('previews an SVG only when it contains an svg element', () => {
    expect(imagePreviewType('doc/logo.svg', text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
    expect(imagePreviewType('x.svg', text('hello'))).toBeNull()
  })

  it('does not preview other files, empty files or huge ones', () => {
    expect(imagePreviewType('a.pdf', text('%PDF-1.4'))).toBeNull()
    expect(imagePreviewType('Makefile', text('all:'))).toBeNull()
    expect(imagePreviewType('a.png', new Uint8Array(0))).toBeNull()
    const big = new Uint8Array(IMAGE_PREVIEW_MAX_BYTES + 1)
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(imagePreviewType('a.png', big)).toBeNull()
  })
})

describe('line anchors (D-054)', () => {
  it('parses #L10 and #L10-L20 as GitHub writes them', () => {
    expect(parseLineHash('#L10', 100)).toEqual({ start: 10, end: 10 })
    expect(parseLineHash('#L10-L20', 100)).toEqual({ start: 10, end: 20 })
    expect(parseLineHash('#L20-L10', 100)).toEqual({ start: 10, end: 20 })
    expect(parseLineHash('#L90-L200', 100)).toEqual({ start: 90, end: 100 })
  })

  it('ignores other fragments and lines past the end', () => {
    for (const h of ['', '#', '#readme', '#L', '#L0', '#Lx', '#L101', '#L5-', '#l5']) {
      expect(parseLineHash(h, 100)).toBeNull()
    }
  })

  it('round-trips a range to its fragment', () => {
    expect(lineHash({ start: 7, end: 7 })).toBe('L7')
    expect(lineHash({ start: 7, end: 9 })).toBe('L7-L9')
  })

  it('selects a line on click and extends on shift-click', () => {
    expect(selectLine(null, 5, true)).toEqual({ start: 5, end: 5 })
    expect(selectLine({ start: 5, end: 5 }, 9, false)).toEqual({ start: 9, end: 9 })
    expect(selectLine({ start: 5, end: 5 }, 9, true)).toEqual({ start: 5, end: 9 })
    expect(selectLine({ start: 5, end: 9 }, 2, true)).toEqual({ start: 2, end: 9 })
  })
})

describe('visibleRows (D-055)', () => {
  it('renders the rows in view plus an overscan, never the whole file', () => {
    // 81k lines of 20 px, viewport 900 px, scrolled 1,000 rows down.
    const { from, to } = visibleRows(81_000, 20, -20_000, 900)
    expect(from).toBe(960)
    expect(to).toBe(1085)
    expect(to - from).toBeLessThan(200)
  })

  it('clamps at both ends', () => {
    // The list starts 500 px down: 20 rows show, plus the overscan.
    expect(visibleRows(5000, 20, 500, 900)).toEqual({ from: 0, to: 60 })
    expect(visibleRows(5000, 20, -5000 * 20, 900)).toEqual({ from: 4960, to: 5000 })
  })
})

describe('blobDisplay (D-055)', () => {
  it('asks before rendering text over 1 MB, and renders it once asked', () => {
    const big = new Uint8Array(RENDER_CONFIRM_BYTES + 1).fill(0x61)
    expect(blobDisplay('po/bg.po', big, 'a'.repeat(big.length), false)).toEqual({ kind: 'confirm-large' })
    expect(blobDisplay('po/bg.po', big, 'a'.repeat(big.length), true)).toEqual({ kind: 'text' })
    expect(blobDisplay('small.txt', text('hi'), 'hi', false)).toEqual({ kind: 'text' })
  })

  it('previews images first and leaves other binary files to Raw', () => {
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(blobDisplay('a.svg', svg, '<svg xmlns="http://www.w3.org/2000/svg"/>', false)).toEqual({ kind: 'image', type: 'image/svg+xml' })
    expect(blobDisplay('a.bin', bytes(0, 1, 2), null, false)).toEqual({ kind: 'binary' })
  })
})
