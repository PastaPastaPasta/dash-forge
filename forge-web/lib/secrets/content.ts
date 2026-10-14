/**
 * The content rules: what a file's text holds (twin of `crates/forge-secrets/src/content.rs`).
 * Offsets are JS string indices; only the line they fall on is ever used, and that is the same
 * as the Rust crate's byte offsets give.
 */

import {
  ASSIGNMENT_MAX_LEN,
  ASSIGNMENT_MIN_ENTROPY,
  ASSIGNMENT_MIN_LEN,
  AWS_ID_PREFIXES,
  GITHUB_FINE_GRAINED_PREFIX,
  GITHUB_PREFIXES,
  GITLAB_PREFIXES,
  PEM_MAX_MARKERS,
  PEM_MIN_BODY,
  PLACEHOLDER_WORDS,
  SECRET_NAME_WORDS,
  WIF_VERSIONS,
  type Rule,
} from './types'
import {
  BASE58,
  asciiLower,
  base58Decode,
  crc32,
  encodeBase,
  isAsciiAlnum,
  isAsciiDigit,
  isAsciiLower,
  isAsciiUpper,
  isRustWhitespace,
  lines,
  sha256d,
  shannonEntropy,
  trim,
  trimEndBy,
  trimStart,
  trimStartBy,
} from './util'

/** One content match: the rule, the offset where it starts, and the fingerprint material. */
export interface Match {
  readonly rule: Rule
  readonly offset: number
  readonly material: string
  /** Another offset the match covers (an AWS pair's secret), so no `secret_assignment` is reported on its line either. */
  readonly also: number | null
}

function match(rule: Rule, offset: number, material: string): Match {
  return { rule, offset, material, also: null }
}

/** Every content match in `text`, in no particular order (the caller sorts). */
export function scanText(text: string): Match[] {
  const out: Match[] = []
  privateKeys(text, out)
  awsPairs(text, out)
  githubTokens(text, out)
  gitlabTokens(text, out)
  wifs(text, out)
  assignments(text, out)
  return out
}

/** `line` without leading whitespace and an `export ` prefix. */
function stripExport(line: string): string {
  const l = trimStart(line)
  return l.startsWith('export ') ? trimStart(l.slice('export '.length)) : l
}

function isNameChar(c: number): boolean {
  return isAsciiAlnum(c) || c === 0x5f || c === 0x2e || c === 0x2d // _ . -
}

function isValueChar(c: number): boolean {
  // A-Za-z0-9 + / = _ - . ~
  return (
    isAsciiAlnum(c) ||
    c === 0x2b ||
    c === 0x2f ||
    c === 0x3d ||
    c === 0x5f ||
    c === 0x2d ||
    c === 0x2e ||
    c === 0x7e
  )
}

function allBy(s: string, pred: (c: number) => boolean): boolean {
  for (let i = 0; i < s.length; i++) if (!pred(s.charCodeAt(i))) return false
  return true
}

/**
 * Whether one line of `text` sets a variable to a non-empty value: `NAME=value`,
 * `export NAME=value` or `NAME: value` (a leading UTF-8 BOM ignored), where `NAME` starts with a
 * letter or `_` and holds letters, digits, `_`, `.` or `-`, and the value is not empty, `""` or `''`.
 */
export function setsAValue(text: string): boolean {
  const body = text.startsWith('\ufeff') ? text.slice(1) : text
  return lines(body).some((line) => {
    const l = stripExport(line)
    const at = l.search(/[=:]/)
    if (at < 0) return false
    const name = trimEndBy(l.slice(0, at), isRustWhitespace)
    const value = trim(l.slice(at + 1))
    const first = name.charCodeAt(0)
    const okName = name !== '' && (isAsciiAlnum(first) ? !isAsciiDigit(first) : first === 0x5f) && allBy(name, isNameChar)
    return okName && value !== '' && value !== '""' && value !== "''"
  })
}

// --- private keys -------------------------------------------------------------------------

const BEGIN = '-----BEGIN '
const DASHES = '-----'

function isPrivateKeyLabel(label: string): boolean {
  return (
    label.length <= 40 &&
    (label.endsWith('PRIVATE KEY') || label === 'PGP PRIVATE KEY BLOCK') &&
    allBy(label, (b) => isAsciiUpper(b) || isAsciiDigit(b) || b === 0x20)
  )
}

function isBase64Char(c: number): boolean {
  return isAsciiAlnum(c) || c === 0x2b || c === 0x2f || c === 0x3d
}

/**
 * The base64 body of a PEM block, when it is long enough to be a key: `\n`/`\r` escapes are
 * line breaks; each line is trimmed of spaces, quotes and commas; header lines (with `:`) and
 * empty lines are skipped; any other character outside base64 means it is not a key.
 */
function pemBody(raw: string): string | null {
  const body = raw.split('\\n').join('\n').split('\\r').join('\n')
  const trimmable = (c: number): boolean => isRustWhitespace(c) || c === 0x22 || c === 0x27 || c === 0x2c
  let b64 = ''
  for (const line of lines(body)) {
    const l = trimEndBy(trimStartBy(line, trimmable), trimmable)
    if (l === '' || l.includes(':')) continue
    if (!allBy(l, isBase64Char)) return null
    b64 += l
  }
  return b64.length >= PEM_MIN_BODY ? b64 : null
}

function privateKeys(text: string, out: Match[]): void {
  // A label whose END marker is missing after some point is missing after every later one:
  // remembered, so unmatched BEGIN markers cost one search each, not one per pair.
  const unmatched: string[] = []
  let from = 0
  let markers = 0
  for (;;) {
    const start = text.indexOf(BEGIN, from)
    if (start < 0) break
    markers++
    if (markers > PEM_MAX_MARKERS) break
    const labelStart = start + BEGIN.length
    const labelEnd = text.indexOf(DASHES, labelStart)
    if (labelEnd < 0) break
    const label = text.slice(labelStart, labelEnd)
    from = labelEnd + DASHES.length
    if (!isPrivateKeyLabel(label) || unmatched.includes(label)) continue
    const end = `-----END ${label}-----`
    const bodyEnd = text.indexOf(end, from)
    if (bodyEnd < 0) {
      unmatched.push(label)
      continue
    }
    // Only a real key consumes its span: a body that is not one (a stray BEGIN whose END
    // belongs to a later block) must not hide the BEGIN of that later block.
    const material = pemBody(text.slice(from, bodyEnd))
    if (material !== null) {
      out.push(match('private_key', start, material))
      from = bodyEnd + end.length
    }
  }
}

// --- words --------------------------------------------------------------------------------

/** Every maximal run of ASCII characters satisfying `inWord`, with its start offset. */
function words(text: string, inWord: (c: number) => boolean): Array<[number, string]> {
  const out: Array<[number, string]> = []
  let i = 0
  while (i < text.length) {
    if (!inWord(text.charCodeAt(i))) {
      i++
      continue
    }
    const start = i
    while (i < text.length && inWord(text.charCodeAt(i))) i++
    out.push([start, text.slice(start, i)])
  }
  return out
}

// --- AWS ----------------------------------------------------------------------------------

function isAwsIdChar(b: number): boolean {
  return isAsciiUpper(b) || (b >= 0x32 && b <= 0x37) // A-Z, 2-7
}

function isAwsId(w: string): boolean {
  if (w.length !== 20 || w.includes('EXAMPLE')) return false
  return AWS_ID_PREFIXES.some(
    (p) => w.startsWith(p) && allBy(w.slice(p.length), (b) => isAwsIdChar(b) || (p === 'A3T' && isAsciiDigit(b))),
  )
}

function isHexDigit(b: number): boolean {
  return isAsciiDigit(b) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)
}

function isAwsSecret(w: string): boolean {
  if (w.length !== 40 || w.includes('EXAMPLE')) return false
  let upper = false
  let lower = false
  let digitOrSymbol = false
  for (let i = 0; i < w.length; i++) {
    const c = w.charCodeAt(i)
    if (isAsciiUpper(c)) upper = true
    if (isAsciiLower(c)) lower = true
    if (isAsciiDigit(c) || c === 0x2f || c === 0x2b) digitOrSymbol = true
  }
  return upper && lower && digitOrSymbol && !allBy(w, isHexDigit)
}

function awsPairs(text: string, out: Match[]): void {
  const ids = words(text, isAsciiAlnum).filter(([, w]) => isAwsId(w))
  if (ids.length === 0) return
  const secret = words(text, (b) => isAsciiAlnum(b) || b === 0x2f || b === 0x2b).find(([, w]) => isAwsSecret(w))
  if (secret === undefined) return
  const [secretAt, secretWord] = secret
  for (const [offset, id] of ids) {
    out.push({ rule: 'aws_key_pair', offset, material: `${id}:${secretWord}`, also: secretAt })
  }
}

// --- GitHub -------------------------------------------------------------------------------

/** Base62 digits in the order `0-9A-Za-z`. */
const BASE62_UPPER_FIRST = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** Base62 digits in the order `0-9a-zA-Z`. */
const BASE62_LOWER_FIRST = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * Whether a GitHub token (`ghp_` and 36 alphanumerics) carries a valid checksum.
 *
 * Format source: GitHub, "Behind GitHub's new authentication token formats" (2021-04-05):
 * a three-letter prefix and `_`, 30 random base62 characters, then a CRC32 checksum in the last
 * 6 characters, base62 with leading zeros. The post does not say which characters the CRC covers
 * or the order of the base62 alphabet, so all four readings are accepted (CRC of the 30 random
 * characters, or of the prefix and them; `0-9A-Za-z` or `0-9a-zA-Z`).
 */
export function githubChecksumOk(token: string): boolean {
  const prefix = GITHUB_PREFIXES.find((p) => token.startsWith(p))
  if (prefix === undefined) return false
  const body = token.slice(prefix.length)
  if (body.length !== 36 || !allBy(body, isAsciiAlnum)) return false
  const random = body.slice(0, 30)
  const check = body.slice(30)
  return [random, prefix + random].some((covered) => {
    const crc = crc32(covered)
    return [BASE62_UPPER_FIRST, BASE62_LOWER_FIRST].some((alphabet) => encodeBase(crc, alphabet, 6) === check)
  })
}

/** Whether offset `i` of `text` starts a token: at the start, or after a character that cannot be part of one. */
function atTokenStart(text: string, i: number): boolean {
  if (i === 0) return true
  const b = text.charCodeAt(i - 1)
  return !(isAsciiAlnum(b) || b === 0x5f || b === 0x2d)
}

/** Every occurrence of `prefix` in `text` at a token start, with the run satisfying `inToken` that begins there. */
function prefixed(text: string, prefix: string, inToken: (c: number) => boolean): Array<[number, string]> {
  const out: Array<[number, string]> = []
  let from = 0
  for (;;) {
    const start = text.indexOf(prefix, from)
    if (start < 0) break
    from = start + prefix.length
    if (!atTokenStart(text, start)) continue
    let end = start + prefix.length
    while (end < text.length && inToken(text.charCodeAt(end))) end++
    out.push([start, text.slice(start, end)])
  }
  return out
}

function githubTokens(text: string, out: Match[]): void {
  for (const prefix of GITHUB_PREFIXES) {
    for (const [offset, token] of prefixed(text, prefix, isAsciiAlnum)) {
      if (token.length !== prefix.length + 36) continue
      out.push(match(githubChecksumOk(token) ? 'github_token' : 'unverified_token', offset, token))
    }
  }
  const p = GITHUB_FINE_GRAINED_PREFIX
  for (const [offset, token] of prefixed(text, p, (b) => isAsciiAlnum(b) || b === 0x5f)) {
    const rest = token.slice(p.length)
    let shaped = rest.length === 82 && rest.charAt(22) === '_'
    for (let i = 0; shaped && i < rest.length; i++) {
      if (i !== 22 && !isAsciiAlnum(rest.charCodeAt(i))) shaped = false
    }
    if (shaped) out.push(match('unverified_token', offset, token))
  }
}

// --- GitLab -------------------------------------------------------------------------------

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

function isBase64Url(b: number): boolean {
  return isAsciiAlnum(b) || b === 0x5f || b === 0x2d
}

function isBase36(s: string): boolean {
  return allBy(s, (b) => isAsciiDigit(b) || isAsciiLower(b))
}

/**
 * Whether a GitLab routable token's length field and CRC agree.
 *
 * Format source: GitLab, "Cells: Routable Tokens" design document:
 * `<prefix><base64-payload>.<token-version>.<base64-payload-length><crc32>`, each number in
 * base36 left-padded with `0`: the version and the length in 2 characters, the CRC32 in 7. The
 * document says the CRC covers `<prefix><base64-payload>.<base64-payload-length>`; GitLab's
 * generator also covers the version. Both are accepted, and so is the earlier form without a
 * version segment (`<prefix><payload>.<length><crc32>`).
 */
export function gitlabChecksumOk(token: string): boolean {
  return routable(token) === true
}

/** `null` when `token` is not shaped like a routable token; else whether its length and CRC agree. */
function routable(token: string): boolean | null {
  const prefix = GITLAB_PREFIXES.find((p) => token.startsWith(p))
  if (prefix === undefined) return null
  const rest = token.slice(prefix.length)
  const dot = rest.indexOf('.')
  if (dot < 0) return null
  const payload = rest.slice(0, dot)
  const tail = rest.slice(dot + 1)
  if (payload.length < 27 || payload.length > 300 || !allBy(payload, isBase64Url)) return null
  let version: string | null = null
  let lenCrc = tail
  const dot2 = tail.indexOf('.')
  if (dot2 >= 0) {
    if (dot2 !== 2) return null
    version = tail.slice(0, dot2)
    lenCrc = tail.slice(dot2 + 1)
  }
  if (lenCrc.length !== 9 || !isBase36(lenCrc) || (version !== null && !isBase36(version))) return null
  const len = lenCrc.slice(0, 2)
  const crc = lenCrc.slice(2)
  if (encodeBase(payload.length, BASE36, 2) !== len) return false
  const covered = [`${prefix}${payload}.${len}`]
  if (version !== null) covered.push(`${prefix}${payload}.${version}.${len}`)
  return covered.some((c) => encodeBase(crc32(c), BASE36, 7) === crc)
}

function gitlabTokens(text: string, out: Match[]): void {
  for (const prefix of GITLAB_PREFIXES) {
    for (const [offset, run] of prefixed(text, prefix, (b) => isBase64Url(b) || b === 0x2e)) {
      const token = trimEndBy(run, (c) => c === 0x2e)
      const r = routable(token)
      if (r === true) {
        out.push(match('gitlab_token', offset, token))
      } else if (r === false) {
        out.push(match('unverified_token', offset, token))
      } else if (prefix === 'glpat-' && token.length === prefix.length + 20 && allBy(token.slice(prefix.length), isBase64Url)) {
        // The legacy personal access token: `glpat-` and 20 characters, no checksum.
        out.push(match('unverified_token', offset, token))
      }
    }
  }
}

// --- WIF ----------------------------------------------------------------------------------

/**
 * Whether `w` is a WIF private key: base58 that decodes to a {@link WIF_VERSIONS} byte, 32 key
 * bytes, an optional `0x01` (compressed), and the first 4 bytes of SHA-256(SHA-256(the rest)).
 */
function isWif(w: string): boolean {
  if (w.length < 51 || w.length > 52 || !allBy(w, (b) => BASE58.includes(String.fromCharCode(b)))) return false
  const raw = base58Decode(w)
  if (raw === null) return false
  const shaped = raw.length === 37 || (raw.length === 38 && raw[33] === 0x01)
  if (!shaped || !WIF_VERSIONS.includes(raw[0] as number)) return false
  const payload = raw.subarray(0, raw.length - 4)
  const check = raw.subarray(raw.length - 4)
  const digest = sha256d(payload)
  return check.every((b, i) => digest[i] === b)
}

function wifs(text: string, out: Match[]): void {
  for (const [offset, w] of words(text, isAsciiAlnum)) {
    if (isWif(w)) out.push(match('wif', offset, w))
  }
}

// --- assignments --------------------------------------------------------------------------

/**
 * `[name, value]` when `line` is one assignment: optional `export `, a name (optionally quoted),
 * `=`, `:`, `:=` or `=>`, then a value (optionally quoted) that ends the line or is followed by a
 * space, `,`, `;` or its closing quote.
 */
function assignment(line: string): [string, string] | null {
  let l = stripExport(line)
  if (l === '') return null
  const first = l.charAt(0)
  let name: string
  if (first === '"' || first === "'") {
    const close = l.indexOf(first, 1)
    if (close < 0) return null
    name = l.slice(1, close)
    l = l.slice(close + 1)
  } else {
    let end = 0
    while (end < l.length && isNameChar(l.charCodeAt(end))) end++
    name = l.slice(0, end)
    l = l.slice(end)
  }
  if (name === '' || !allBy(name, isNameChar)) return null
  l = trimStart(l)
  const sep = ['=>', ':=', '=', ':'].find((s) => l.startsWith(s))
  if (sep === undefined) return null
  l = trimStart(l.slice(sep.length))
  let quote: string | null = null
  if (l.startsWith('"') || l.startsWith("'")) {
    quote = l.charAt(0)
    l = l.slice(1)
  }
  let end = 0
  while (end < l.length && isValueChar(l.charCodeAt(end))) end++
  const value = l.slice(0, end)
  const after = l.slice(end)
  const endsWell =
    quote !== null
      ? after.startsWith(quote)
      : after === '' || isRustWhitespace(after.charCodeAt(0)) || after.startsWith(',') || after.startsWith(';')
  return endsWell ? [name, value] : null
}

function isSecretValue(value: string): boolean {
  const lower = asciiLower(value)
  return (
    value.length >= ASSIGNMENT_MIN_LEN &&
    value.length <= ASSIGNMENT_MAX_LEN &&
    !PLACEHOLDER_WORDS.some((w) => lower.includes(w)) &&
    shannonEntropy(value) >= ASSIGNMENT_MIN_ENTROPY
  )
}

function assignments(text: string, out: Match[]): void {
  let offset = 0
  while (offset < text.length) {
    const nl = text.indexOf('\n', offset)
    const next = nl < 0 ? text.length : nl + 1
    const line = trimEndBy(text.slice(offset, next), (c) => c === 0x0a || c === 0x0d)
    const found = assignment(line)
    if (found !== null) {
      const [name, value] = found
      const lower = asciiLower(name)
      if (SECRET_NAME_WORDS.some((w) => lower.includes(w)) && isSecretValue(value)) {
        out.push(match('secret_assignment', offset, `${name}=${value}`))
      }
    }
    offset = next
  }
}
