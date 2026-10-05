/**
 * The mirror back-link (forge-v2.md §6.4, Rust `forge_core::rules::mirror`): a file at the root
 * of the source repository that names its Forge mirrors by repo id.
 *
 * A repo's description saying `Mirror of github.com/o/r` is the mirror owner's own claim, and
 * anyone can write it. Only someone who can push to github.com/o/r can add
 * `.dash-forge.json` there, so a mirror the file lists is one the source's maintainers vouch
 * for. A reader fetches the file from the source host and checks the list here.
 *
 * ```json
 * {"mirrors":["<repo id>"]}
 * ```
 *
 * The file is read leniently: other keys are ignored (later versions may add some), and so is
 * any entry of `mirrors` that is not a string. Matching is exact: repo ids are case-sensitive
 * base58. Vectors: `forge-contracts/vectors/mirror_backlink__*`.
 */

/** The file's name, at the root of the source's default branch. */
export const BACKLINK_FILE = '.dash-forge.json'

/** Larger files are not read: a list of mirrors fits easily, and a reader fetches it unasked. */
export const BACKLINK_MAX_BYTES = 4096

/**
 * Deeper nesting is not read. JSON parsers differ in how deep they go (serde_json stops at
 * 128), so both readers refuse a file nested deeper than this before parsing it.
 */
export const BACKLINK_MAX_DEPTH = 64

/** How deeply `text`'s arrays and objects nest, brackets inside strings not counted. */
function nesting(text: string): number {
  let depth = 0
  let deepest = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '[' || c === '{') deepest = Math.max(deepest, ++depth)
    else if (c === ']' || c === '}') depth--
  }
  return deepest
}

/** What a back-link file says about one repo. */
export interface Backlink {
  /** The file is a JSON object whose `mirrors` is a list, within {@link BACKLINK_MAX_BYTES} and {@link BACKLINK_MAX_DEPTH}. */
  readonly valid: boolean
  /** It lists `repoId` (never true when the file is not valid). */
  readonly listed: boolean
}

/** Read a back-link file's text for `repoId`. */
export function readBacklink(text: string, repoId: string): Backlink {
  const invalid = { valid: false, listed: false }
  if (new TextEncoder().encode(text).length > BACKLINK_MAX_BYTES || nesting(text) > BACKLINK_MAX_DEPTH) return invalid
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return invalid
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return invalid
  const mirrors = (parsed as Record<string, unknown>)['mirrors']
  if (!Array.isArray(mirrors)) return invalid
  return { valid: true, listed: repoId !== '' && mirrors.some((m) => m === repoId) }
}

/** The file that lists `repoIds`, as a mirror's owner adds it to the source. */
export function backlinkFile(repoIds: readonly string[]): string {
  return `${JSON.stringify({ mirrors: repoIds })}\n`
}
