/**
 * Blob view helpers: image previews, `#L` line anchors, and the windowing that keeps a huge
 * file from rendering every line (D-054, D-055). Pure functions, so they are unit-tested
 * without a DOM.
 */

/** Image types previewed inline, by extension, with the MIME type the `blob:` URL carries. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/** Images above this are not previewed (the Raw download still works). */
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024

/** Whether `bytes` start with `sig`. */
function startsWith(bytes: Uint8Array, sig: readonly number[], at = 0): boolean {
  return sig.every((b, i) => bytes[at + i] === b)
}

/** Raster formats are checked by their magic bytes, so a misnamed file is not "previewed". */
function rasterMatches(mime: string, bytes: Uint8Array): boolean {
  switch (mime) {
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff])
    case 'image/gif':
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38])
    case 'image/webp':
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
    default:
      return false
  }
}

/**
 * The MIME type to preview `bytes` as an image, or null. SVG is previewed only through an
 * `<img>` (a `blob:` URL of type image/svg+xml): an image context runs no script and loads no
 * external resource, unlike inline SVG or an `<object>`.
 */
export function imagePreviewType(filename: string, bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > IMAGE_PREVIEW_MAX_BYTES) return null
  const dot = filename.lastIndexOf('.')
  const mime = dot === -1 ? undefined : IMAGE_TYPES[filename.slice(dot + 1).toLowerCase()]
  if (mime === undefined) return null
  if (mime === 'image/svg+xml') {
    const head = new TextDecoder().decode(bytes.subarray(0, 4096)).toLowerCase()
    return head.includes('<svg') ? mime : null
  }
  return rasterMatches(mime, bytes) ? mime : null
}

/** A selected line range (1-based, inclusive). */
export interface LineRange {
  readonly start: number
  readonly end: number
}

/** Parse GitHub's `#L10` / `#L10-L20` fragment; null for anything else or out of range. */
export function parseLineHash(hash: string, lineCount: number): LineRange | null {
  const m = /^#?L(\d+)(?:-L?(\d+))?$/.exec(hash)
  if (m === null) return null
  const a = Number(m[1])
  const b = m[2] === undefined ? a : Number(m[2])
  const start = Math.min(a, b)
  const end = Math.max(a, b)
  if (start < 1 || start > lineCount) return null
  return { start, end: Math.min(end, lineCount) }
}

/** The fragment for a range: `L10` or `L10-L20`. */
export function lineHash(range: LineRange): string {
  return range.start === range.end ? `L${range.start}` : `L${range.start}-L${range.end}`
}

/**
 * The range after clicking line `line`: a plain click selects it, a shift-click extends the
 * current selection to it (as on GitHub).
 */
export function selectLine(current: LineRange | null, line: number, extend: boolean): LineRange {
  if (!extend || current === null) return { start: line, end: line }
  const anchor = line >= current.start ? current.start : current.end
  return { start: Math.min(anchor, line), end: Math.max(anchor, line) }
}

/** Files with more lines than this render through the window below, not all at once. */
export const VIRTUALIZE_LINES = 2000
/** Rows rendered above and below the visible ones. */
const OVERSCAN = 40

/**
 * The rows to render: those inside the viewport plus {@link OVERSCAN} each side. `top` is
 * where the list starts relative to the viewport's top (negative once scrolled past).
 */
export function visibleRows(total: number, rowHeight: number, top: number, viewport: number): { from: number; to: number } {
  const first = Math.floor(-top / rowHeight)
  const count = Math.ceil(viewport / rowHeight)
  const from = Math.max(0, Math.min(total, first - OVERSCAN))
  const to = Math.max(from, Math.min(total, first + count + OVERSCAN))
  return { from, to }
}

/** Text blobs above this ask before rendering (a "view raw" link is always offered). */
export const RENDER_CONFIRM_BYTES = 1024 * 1024

/**
 * How a blob is shown: an image preview, a text table, a "view raw / render anyway" prompt for
 * text over {@link RENDER_CONFIRM_BYTES} (until `renderLarge`), or the binary placeholder.
 */
export function blobDisplay(
  filename: string,
  bytes: Uint8Array,
  text: string | null,
  renderLarge: boolean,
): { kind: 'image'; type: string } | { kind: 'text' } | { kind: 'confirm-large' } | { kind: 'binary' } {
  const type = imagePreviewType(filename, bytes)
  if (type !== null) return { kind: 'image', type }
  if (text === null) return { kind: 'binary' }
  return bytes.length > RENDER_CONFIRM_BYTES && !renderLarge ? { kind: 'confirm-large' } : { kind: 'text' }
}
