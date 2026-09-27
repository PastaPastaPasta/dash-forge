/**
 * The contract's text limits (`forge-contracts/contracts/forge-collab.json` `schemaDefs`), checked
 * before signing so an over-long issue, comment, PR or review is never sent to be refused at
 * consensus (D-049). A `body` holds at most 5,120 characters and 5,120 UTF-8 bytes; a `title`
 * 256 characters and 1,024 bytes. Characters are counted as the contract's JSON-schema
 * `maxLength` counts them: code points.
 */

export interface TextLimit {
  readonly chars: number
  readonly bytes: number
}

export const BODY_LIMIT: TextLimit = { chars: 5120, bytes: 5120 }
export const TITLE_LIMIT: TextLimit = { chars: 256, bytes: 1024 }

export interface TextUse {
  readonly chars: number
  readonly bytes: number
  /** Over either limit. */
  readonly over: boolean
  /** Within 10 % of the byte limit (the counter turns amber). */
  readonly near: boolean
}

export function textUse(text: string, limit: TextLimit): TextUse {
  const chars = [...text].length
  const bytes = new TextEncoder().encode(text).length
  const over = chars > limit.chars || bytes > limit.bytes
  return { chars, bytes, over, near: !over && bytes > limit.bytes * 0.9 }
}

/** A count as the counter and its messages show it: `5,120`. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/** The sentence a composer shows for an over-long field, or null when it fits. */
export function overLimitMessage(field: string, use: TextUse, limit: TextLimit): string | null {
  if (!use.over) return null
  if (use.bytes > limit.bytes) {
    return `The ${field} is ${formatCount(use.bytes)} bytes; Platform stores at most ${formatCount(limit.bytes)}. Shorten it by ${formatCount(use.bytes - limit.bytes)} bytes.`
  }
  return `The ${field} is ${formatCount(use.chars)} characters; Platform stores at most ${formatCount(limit.chars)}.`
}
