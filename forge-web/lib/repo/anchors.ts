/**
 * Inline-comment anchors (`ux-dx-spec.md` §5.7).
 *
 * A `comment` on a PR line carries the optional contract fields `path`, `line`, `side`
 * (0 old / 1 new) and `commitOid` (forge-collab `comment`; forge-core `CommentAnchor`). Older
 * or other clients put the same anchor in a `<!-- forge-anchor {json} -->` block at the top of
 * `body` instead, so a reader accepts both: the fields win whenever any of them is present,
 * and the block is used only when they are all absent. The block is always stripped from the
 * rendered body.
 */

/** Where a comment points. */
export interface CommentAnchor {
  readonly path: string
  readonly line: number
  /** 0 = the old (base) side, 1 = the new (head) side. */
  readonly side: 0 | 1
  /** The head the comment was written against, hex (`''` when not recorded). */
  readonly commitOid: string
}

const BLOCK = /^\s*<!--\s*forge-anchor\s+(\{[^\n]*?\})\s*-->[ \t]*(?:\r?\n)?/

const HEX_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function isSide(v: unknown): v is 0 | 1 {
  return v === 0 || v === 1
}

function isLine(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff
}

/** The anchor a `<!-- forge-anchor -->` block at the top of `body` names, and the body without it. */
export function parseAnchorBlock(body: string): { anchor: CommentAnchor | null; body: string } {
  const m = BLOCK.exec(body)
  if (m === null) return { anchor: null, body }
  const rest = body.slice(m[0].length)
  let parsed: unknown
  try {
    parsed = JSON.parse(m[1] as string)
  } catch {
    // A malformed block is still a block: never render it as text.
    return { anchor: null, body: rest }
  }
  if (typeof parsed !== 'object' || parsed === null) return { anchor: null, body: rest }
  const o = parsed as Record<string, unknown>
  const commitOid = typeof o['commitOid'] === 'string' ? o['commitOid'].toLowerCase() : ''
  if (typeof o['path'] !== 'string' || o['path'] === '' || !isLine(o['line']) || !isSide(o['side'])) {
    return { anchor: null, body: rest }
  }
  if (commitOid !== '' && !HEX_OID.test(commitOid)) return { anchor: null, body: rest }
  return { anchor: { path: o['path'], line: o['line'], side: o['side'], commitOid }, body: rest }
}

/** A body carrying `anchor` in the fallback block (for clients that cannot write the fields). */
export function serializeAnchorBlock(anchor: CommentAnchor, body: string): string {
  const json = JSON.stringify({ path: anchor.path, line: anchor.line, side: anchor.side, commitOid: anchor.commitOid })
  // `-->` inside the JSON would end the comment early; a path cannot need it.
  if (json.includes('-->')) throw new Error('an anchor path cannot contain "-->"')
  return `<!-- forge-anchor ${json} -->\n${body}`
}

/** The anchor-bearing fields of a stored comment, as read (absent fields undefined). */
export interface AnchorFields {
  readonly path?: string
  readonly line?: number
  readonly side?: number
  /** hex, `''` when absent. */
  readonly commitOid?: string
  readonly body: string
}

/**
 * A comment's anchor and display body: the contract fields when any is present, else the
 * body block. The block is stripped from the body either way.
 */
export function readAnchor(fields: AnchorFields): { anchor: CommentAnchor | null; body: string } {
  const block = parseAnchorBlock(fields.body)
  const hasFields = fields.path !== undefined || fields.line !== undefined || fields.side !== undefined
  if (!hasFields) return block
  const { path, line, side } = fields
  const valid = typeof path === 'string' && path !== '' && isLine(line) && isSide(side)
  return {
    anchor: valid ? { path, line, side, commitOid: (fields.commitOid ?? '').toLowerCase() } : null,
    body: block.body,
  }
}
