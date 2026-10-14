/**
 * Access notices (kind 11; mixed-visibility DESIGN §4.9 "Access notices", D33,
 * `docs/security/private-repos.md` §22.1): what a maintainer lets a bot do in one repository, who
 * may ask it, which AI service processes what it is given and until when. The Rust twin is
 * `crates/forge-core/src/private/access_notice.rs`; the `access_notice__*` vectors hold the two
 * byte for byte (`access-notice.conformance.test.ts`).
 *
 * A notice is a typed JSON object in the key letters' canonical form (`./key-letter`: keys sorted,
 * no whitespace, integers only, padded with spaces to a multiple of 512 bytes):
 *
 * ```text
 * {"askers":"writers"|"maintainers","bot":hex32,"may":["ciMembersBranches","post",…],
 *  "note":TEXT,"processor":TEXT|null,"revokes":[packHash,…],"threads":"all"|[n,…],
 *  "type":"accessNotice","until":ms|null,"v":1}
 * ```
 *
 * In a public repository the bytes are stored as they are. In a private repository they are
 * stored twice: under the members key (DFPK 0x01) for members, and as a DFPK 0x02 letter to the bot
 * and the writer (the bot never holds the members key).
 *
 * Which notice counts ({@link currentNotices}): per bot, the newest whose manifest's `$ownerId` is
 * a **current** maintainer or the owner. A notice past its `until` allows nothing. Fields a later
 * version adds (phase 4E's `push`, `pushPolicy`) are kept in `extra` and ignored; abilities this
 * client does not know are kept in `may` and grant nothing here.
 */

import { bytesToHex, type Bytes } from './bytes'
import { compareBytes } from './ids'
import { decodeKeyLetter, encodeKeyLetter, hexExact, KeyLetterError, type JsonValue, type TypedLetter } from './key-letter'

/** `"type": "accessNotice"`. */
export const TYPE_ACCESS_NOTICE = 'accessNotice'
/** `packManifest.kind` of an access notice. */
export const KIND_ACCESS_NOTICE = 11

/** `may`: post comments and reviews. */
export const MAY_POST = 'post'
/** `may`: post members-only replies on threads it is asked about (phase 4A). */
export const MAY_POST_MEMBERS_ONLY = 'postMembersOnly'
/** `may`: read pull requests and issues it is asked about (a `read` letter per request). */
export const MAY_READ_ON_REQUEST = 'readOnRequest'
/** `may`: run checks on members-only branches (phase 4C). */
export const MAY_CI_MEMBERS_BRANCHES = 'ciMembersBranches'

/** The longest `processor` name, in characters. */
export const PROCESSOR_MAX = 100
/** The longest `note`, in characters. */
export const NOTE_MAX = 500
/** The most threads a notice lists. */
export const THREADS_MAX = 100
/** The most earlier notices a notice names in `revokes`. */
export const REVOKES_MAX = 64
/** The longest ability name a reader keeps. */
const ABILITY_MAX = 40
const U32_MAX = 0xffff_ffff

/** Who may ask the bot: members with Write access, maintainers and the owner; or maintainers and the owner. */
export type Askers = 'writers' | 'maintainers'

/** Which threads the bot may be asked about: every issue and pull request, or these numbers (sorted, each once, at least one). */
export type Threads = 'all' | readonly number[]

/** An access notice (version 1): see the module documentation. */
export interface AccessNotice {
  /** The bot's identity id (32 bytes). */
  readonly bot: Uint8Array
  /** What it may do (sorted, each once; unknown abilities are kept and grant nothing). */
  readonly may: readonly string[]
  readonly askers: Askers
  readonly threads: Threads
  /** The AI service that processes what the bot is given, if any. */
  readonly processor: string | null
  /** When the access ends (ms), if it does. */
  readonly until: number | null
  /** The `packHash`es of earlier notices for this bot this one replaces (a record only). */
  readonly revokes: readonly Uint8Array[]
  /** A maintainer's note (may be empty). */
  readonly note: string
  /** Fields a later version adds: kept so the bytes re-encode, never read here. */
  readonly extra: { readonly [k: string]: JsonValue }
}

/** The fields this version reads, sorted. */
const FIELDS = ['askers', 'bot', 'may', 'note', 'processor', 'revokes', 'threads', 'until']

/** A notice for `bot` allowing nothing, asked by writers, on every thread (`dg bot revoke`'s, with `revokes`). */
export function emptyNotice(bot: Uint8Array): AccessNotice {
  return { bot, may: [], askers: 'writers', threads: 'all', processor: null, until: null, revokes: [], note: '', extra: {} }
}

/** Whether `n` lists ability `name`. */
export function noticeMay(n: AccessNotice, name: string): boolean {
  return n.may.includes(name)
}

/** Whether `n` still allows anything at `now` (ms): before its `until`. */
export function noticeLiveAt(n: AccessNotice, now: number): boolean {
  return n.until === null || now < n.until
}

/** Whether thread `number` is among `n`'s threads. */
export function noticeCovers(n: AccessNotice, number: number): boolean {
  return n.threads === 'all' || n.threads.includes(number)
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/

/**
 * Whether `s` is empty or only white space as Rust's `str::trim` sees it (Unicode White_Space: not
 * U+FEFF, which JS's `trim` also strips, and U+0085, which it does not), so both stacks agree.
 */
export function isBlank(s: string): boolean {
  return /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/.test(s)
}

/** At most `max` characters (code points), and no control character (but a newline when allowed). */
export function textOk(s: string, max: number, newline: boolean): boolean {
  return [...s].length <= max && !(newline ? CONTROL_BUT_NEWLINE : CONTROL).test(s)
}

const isU32 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= U32_MAX
const isNat = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** Whether each of `xs` is `less` than the next (sorted, each once). */
function ascending<T>(xs: readonly T[], less: (a: T, b: T) => boolean): boolean {
  return xs.every((x, i) => i === 0 || less(xs[i - 1] as T, x))
}

function wellFormed(n: AccessNotice): boolean {
  const may = n.may.every((m) => m.length > 0 && m.length <= ABILITY_MAX && /^[A-Za-z0-9]+$/.test(m)) && ascending(n.may, (a, b) => a < b)
  const threads =
    n.threads === 'all' || (n.threads.length > 0 && n.threads.length <= THREADS_MAX && n.threads.every(isU32) && (n.threads[0] as number) >= 1 && ascending(n.threads, (a, b) => a < b))
  const processor = n.processor === null || (!isBlank(n.processor) && textOk(n.processor, PROCESSOR_MAX, false))
  const revokes = n.revokes.length <= REVOKES_MAX && n.revokes.every((h) => h.length === 32) && ascending(n.revokes, (a, b) => compareBytes(a, b) < 0)
  const until = n.until === null || isNat(n.until)
  return n.bot.length === 32 && may && threads && processor && revokes && textOk(n.note, NOTE_MAX, true) && until
}

/**
 * The typed letter of `n`, or `null` for what a writer never makes (unsorted or repeated `may`,
 * threads or revokes, an empty processor, text past its bounds or with control characters, a
 * thread 0, a field of this version among `extra`). forge-core `AccessNotice::to_typed`.
 */
export function noticeToTyped(n: AccessNotice): TypedLetter | null {
  if (!wellFormed(n) || FIELDS.some((k) => k in n.extra)) return null
  return {
    type: TYPE_ACCESS_NOTICE,
    v: 1,
    fields: {
      ...n.extra,
      askers: n.askers,
      bot: bytesToHex(n.bot),
      may: [...n.may],
      note: n.note,
      processor: n.processor,
      revokes: n.revokes.map(bytesToHex),
      threads: n.threads === 'all' ? 'all' : [...n.threads],
      until: n.until,
    },
  }
}

/** The padded plaintext a public repository stores. Throws {@link KeyLetterError}. */
export function encodeNotice(n: AccessNotice): Bytes {
  const t = noticeToTyped(n)
  if (t === null) throw new KeyLetterError('invalid')
  return encodeKeyLetter(t)
}

/**
 * A notice of version 1 read from `t`, or `null`: another type or version, a field of this version
 * missing or of the wrong shape, or anything {@link noticeToTyped} refuses.
 * forge-core `AccessNotice::from_typed`.
 */
export function noticeFromTyped(t: TypedLetter): AccessNotice | null {
  if (t.type !== TYPE_ACCESS_NOTICE || t.v !== 1) return null
  const f = t.fields
  if (!FIELDS.every((k) => k in f)) return null
  const bot = hexExact(f.bot, 32)
  if (bot === null) return null
  if (!Array.isArray(f.may) || !(f.may as readonly JsonValue[]).every((m) => typeof m === 'string')) return null
  let threads: Threads
  if (f.threads === 'all') threads = 'all'
  else if (Array.isArray(f.threads) && (f.threads as readonly JsonValue[]).every(isU32)) threads = [...(f.threads as readonly number[])]
  else return null
  if (!Array.isArray(f.revokes)) return null
  const revokes: Uint8Array[] = []
  for (const h of f.revokes as readonly JsonValue[]) {
    const b = hexExact(h, 32)
    if (b === null) return null
    revokes.push(b)
  }
  const until = f.until === null || isNat(f.until) ? f.until : undefined
  const processor = f.processor === null || typeof f.processor === 'string' ? f.processor : undefined
  if (until === undefined || processor === undefined || typeof f.note !== 'string') return null
  if (f.askers !== 'writers' && f.askers !== 'maintainers') return null
  const extra: { [k: string]: JsonValue } = {}
  // an own property even for a key like `__proto__`, which plain assignment would not keep
  for (const [k, v] of Object.entries(f)) if (!FIELDS.includes(k)) Object.defineProperty(extra, k, { value: v, enumerable: true, writable: true, configurable: true })
  const notice: AccessNotice = {
    bot,
    may: [...(f.may as readonly string[])],
    askers: f.askers,
    threads,
    processor,
    until,
    revokes,
    note: f.note,
    extra,
  }
  return wellFormed(notice) ? notice : null
}

/** Read a notice's padded plaintext (the exact canonical form only), or `null`. */
export function decodeNotice(plain: Uint8Array): AccessNotice | null {
  const t = decodeKeyLetter(plain)
  return t === null ? null : noticeFromTyped(t)
}

/** One notice as a repository holds it: its manifest and what it says. */
export interface NoticeEntry {
  /** The kind-11 manifest's document id (base58). */
  readonly id: string
  /** Its `$ownerId` (base58): who wrote it. */
  readonly writer: string
  /** Its `$createdAt` (ms). */
  readonly createdAt: number
  /** Its `packHash`, lowercase hex. */
  readonly packHash: string
  readonly notice: AccessNotice
}

/**
 * The notice that counts for each bot (by its id, lowercase hex): the newest (by `$createdAt`,
 * then manifest id) among those whose writer `isMaintainer` says is a current maintainer or the
 * owner. Notices from anyone else are left out. forge-core `access_notice::current`.
 */
export function currentNotices(entries: readonly NoticeEntry[], isMaintainer: (writer: string) => boolean): Map<string, NoticeEntry> {
  const out = new Map<string, NoticeEntry>()
  for (const e of entries) {
    if (!isMaintainer(e.writer)) continue
    const bot = bytesToHex(e.notice.bot)
    const old = out.get(bot)
    if (old === undefined || e.createdAt > old.createdAt || (e.createdAt === old.createdAt && e.id > old.id)) out.set(bot, e)
  }
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `ms` as the access copy writes a date: `30 Nov 2026` (UTC). forge-core `access_notice::date_words`. */
export function dateWords(ms: number): string {
  const d = new Date(ms)
  // past what a JS date holds (a notice may say up to 2^53 - 1 ms)
  if (Number.isNaN(d.getTime())) return 'a date far in the future'
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`
}

/** `a`, `a and b`, `a, b and c`. */
function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`
}

/**
 * The line everyone reads about a bot's access (DESIGN §10 "Public line"), for `bot` as the copy
 * names it (`@ci-bot`), at `now` (ms): "@ci-bot can post here and read pull requests and issues
 * it's asked about. Asked by writers and maintainers. Processed by <service>. Until 30 Nov 2026."
 * A notice that allows nothing, or has ended, says so. forge-core `access_notice::public_line`.
 */
export function publicLine(n: AccessNotice, bot: string, now: number): string {
  if (n.until !== null && !noticeLiveAt(n, now)) return `${bot}'s access ended on ${dateWords(n.until)}.`
  const can: string[] = []
  if (noticeMay(n, MAY_POST)) can.push('post here')
  if (noticeMay(n, MAY_POST_MEMBERS_ONLY)) can.push("post members-only replies on threads it's asked about")
  if (noticeMay(n, MAY_READ_ON_REQUEST)) can.push("read pull requests and issues it's asked about")
  if (noticeMay(n, MAY_CI_MEMBERS_BRANCHES)) can.push('run checks on members-only branches')
  if (can.length === 0) return `${bot} has no access here.`
  let out = `${bot} can ${listWords(can)}.`
  out += n.askers === 'writers' ? ' Asked by writers and maintainers.' : ' Asked by maintainers.'
  if (n.threads !== 'all') out += ` Only on ${listWords(n.threads.map((t) => `#${t}`))}.`
  if (n.processor !== null) out += ` Processed by ${n.processor}.`
  if (n.until !== null) out += ` Until ${dateWords(n.until)}.`
  return out
}
