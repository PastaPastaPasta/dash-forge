/**
 * Release asset file names (Rust `forge_core::rules::asset_name`): which recorded asset names a
 * download saves under as they are, and which a publish refuses to record.
 *
 * A recorded name is the publisher's data. `dg release download` saves under it only when it is
 * one plain file name that every common system saves as itself: never a path, a drive, a stream,
 * a Windows device, a hidden dotfile (`.git`, `.npmrc`, `.envrc`), a name that reads as a
 * command-line option, or one that hides what it says. The publish form refuses to record what a
 * download would refuse, and two assets of one release must not save as one file on a
 * case-insensitive file system. Vectors: `forge-contracts/vectors/asset_file_name__*`.
 */

/** The longest asset name, in UTF-8 bytes: most file systems' limit for one name. */
export const MAX_ASSET_NAME_BYTES = 255

/** Why a name is not saved as itself; the first in this order is the one named. */
export type AssetNameProblem =
  | 'notAName'
  | 'tooLong'
  | 'path'
  | 'reservedChar'
  | 'control'
  | 'dotfile'
  | 'leadingDash'
  | 'trailingDotOrSpace'
  | 'device'

/** Why, for an error message. */
export const ASSET_NAME_WHY: Readonly<Record<AssetNameProblem, string>> = {
  notAName: 'it is not a file name',
  tooLong: 'it is over 255 bytes',
  path: 'it is a path',
  reservedChar: 'it holds a character Windows refuses: : < > " | ? *',
  control: 'it holds control or text-direction characters',
  dotfile: 'it starts with a dot (a hidden file)',
  leadingDash: 'it starts with a dash (read as an option)',
  trailingDotOrSpace: 'it ends in a dot or a space, which Windows drops',
  device: 'it is a device name on Windows',
}

/** `/`, `\` and characters that look like them. */
const SEPARATORS = /[/\\\u2044\u2215\u29f5\u29f8\u29f9\uff0f\uff3c]/
/** What Windows refuses in a name, and characters that look like `:`. */
const RESERVED = /[:<>"|?*\ua789\uff1a]/
/**
 * Control characters (C0, DEL, C1), line and paragraph separators, bidi embeddings, overrides
 * and isolates, LRM, RLM and ALM: they disguise a name.
 */
const DISGUISING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/

const DEVICES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'])

/**
 * Whether `name` is a Windows device: its part before the first dot, trailing spaces dropped, is
 * `CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, or `COM`/`LPT` and one digit (`0`-`9`, `¹`,
 * `²`, `³`), in any ASCII case (only ASCII: `ı` does not upper-case to `I` here).
 */
function isDevice(name: string): boolean {
  const stem = (name.split('.')[0] ?? '').replace(/ +$/, '').replace(/[a-z]/g, (c) => c.toUpperCase())
  return DEVICES.has(stem) || /^(COM|LPT)[0-9¹²³]$/.test(stem)
}

const utf8 = (s: string): number => new TextEncoder().encode(s).length

/** Why `name` is not one plain file name that saves as itself on every common system, or null. */
export function assetNameProblem(name: string): AssetNameProblem | null {
  if (name === '' || name === '.' || name === '..') return 'notAName'
  if (utf8(name) > MAX_ASSET_NAME_BYTES) return 'tooLong'
  if (SEPARATORS.test(name)) return 'path'
  if (RESERVED.test(name)) return 'reservedChar'
  if (DISGUISING.test(name)) return 'control'
  if (name.startsWith('.')) return 'dotfile'
  if (name.startsWith('-')) return 'leadingDash'
  if (name.endsWith('.') || name.endsWith(' ')) return 'trailingDotOrSpace'
  if (isDevice(name)) return 'device'
  return null
}

/**
 * What two names that save as one file on a case-insensitive file system share: the name
 * upper-cased, then lower-cased, so that every case form of a letter meets (`ς` and `σ`, `ß` and
 * `SS`).
 */
export function sameFileKey(name: string): string {
  return name.toUpperCase().toLowerCase()
}

/** Why one release's assets cannot all be saved as themselves. */
export type AssetNamesProblem =
  | { readonly name: string; readonly problem: AssetNameProblem }
  /** `name` saves as the same file as the earlier `sameFileAs`. */
  | { readonly name: string; readonly sameFileAs: string }

/** The first name of `names` (in order) with a problem, or that saves as an earlier one; or null. */
export function assetNamesProblem(names: readonly string[]): AssetNamesProblem | null {
  const seen = new Map<string, string>()
  for (const name of names) {
    const problem = assetNameProblem(name)
    if (problem !== null) return { name, problem }
    const first = seen.get(sameFileKey(name))
    if (first !== undefined) return { name, sameFileAs: first }
    seen.set(sameFileKey(name), name)
  }
  return null
}
