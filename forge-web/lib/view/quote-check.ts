/**
 * Whether public text repeats members-only text (DESIGN §3.3, §4.1; product H8). Pure: no SDK, no
 * React.
 *
 * Both sides are compared in one canonical form, so a copy from the rendered page matches the
 * stored Markdown and the other way round: NFKC, invisible characters dropped, smart quotes
 * folded, each line's quote, list, task and heading markers dropped, links and images reduced to
 * their text, HTML tags and code fences dropped, lower case, and then only the words (runs of
 * letters, marks and digits) kept, one space apart. Emphasis, code spans and punctuation fall
 * away with that.
 *
 * Public text repeats members-only text when, in that form:
 * - any {@link RUN_WORDS} consecutive words of it are consecutive words of a members-only text;
 * - any {@link SPAN_CHARS} characters of it, starting at a word, are in a members-only text,
 *   starting at a word (a long token, a key or a hash, has few words);
 * - a quoted line (`> …`) of at least {@link QUOTED_MIN} characters, or any line of at least
 *   {@link LINE_MIN}, is in a members-only text, whole words;
 * - a whole members-only text of at least {@link WHOLE_MIN} characters is in it, whole words (a
 *   short secret posted on its own), when it carries two content words of {@link WHOLE_CONTENT_MIN}
 *   characters together, or a word that looks like a secret (letters and digits, 8 or more), so a
 *   short ordinary remark ("Same issue on windows") does not ask;
 * - a whole line of a members-only text, of at least {@link WHOLE_LINE_MIN} characters and worth it
 *   on its own (as above), is in it: a token or a sentence on its own line copied into a longer one;
 * - a word of a members-only text that looks like a secret (letters and digits, 8 or more, and not
 *   only hex digits, which a commit id is) is in it;
 * - the address of a link or image in a members-only text (with a path) is in it: the canonical
 *   form keeps a link's text only, and the address is often the confidential part.
 * Runs, lines and texts made only of filler words (thanks, LGTM, "looks good to me") never count,
 * so common replies do not ask. An edit counts only what it adds: a match the text before the edit
 * already had is not asked about again (`before`).
 *
 * Out of scope (a stated limit): members-only text of another repo, or one opened only in another
 * tab, and a secret shorter than {@link WHOLE_MIN} characters, or one copied out of a longer text
 * with fewer than the run lengths around it that is neither on its own line nor secret-looking.
 */

/** Consecutive words that count as copied. */
export const RUN_WORDS = 6
/** Characters, from the start of a word, that count as copied. */
export const SPAN_CHARS = 32
/** The shortest quoted line (`> …`) that counts. */
export const QUOTED_MIN = 8
/** The shortest plain line that counts on its own. */
export const LINE_MIN = 24
/** The shortest whole members-only text found inside public text that counts. */
export const WHOLE_MIN = 8
/** Content characters (letters and digits outside filler words) a match needs. */
const CONTENT_MIN = 6
/** Content characters a whole short members-only text needs, across two content words or more. */
export const WHOLE_CONTENT_MIN = 12
/** The shortest line of a members-only text found whole inside public text that counts. */
export const WHOLE_LINE_MIN = 16
/** The shortest word that can look like a secret. */
const SECRET_WORD_MIN = 8

/** Zero-width and other invisible format characters a copy can carry. */
const INVISIBLE = /[­͏᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g
const SINGLE_QUOTES = /[‘’‚‛′‵]/g
const DOUBLE_QUOTES = /[“”„‟″‶«»]/g
/** One marker at the start of a line: a quote, a list item, a task box, a heading. */
const LINE_MARKER = /^\s*(?:>|[-*+](?=\s)|\d{1,9}[.)](?=\s)|\[[ xX]\](?=\s)|#{1,6}(?=\s))\s*/
const QUOTED = /^\s*>/
const FENCE = /^\s*(?:```|~~~)/
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g
const LINK = /\[([^\]]*)\]\([^)]*\)/g
const REF_LINK = /\[([^\]]+)\]\[[^\]]*\]/g
const AUTOLINK = /<((?:https?|mailto):[^>\s]+)>/gi
const TAG = /<\/?[A-Za-z][^>]*>/g
const WORD = /[\p{L}\p{M}\p{N}]+/gu
/** A Markdown link's or image's address: `[text](url "title")`, `![alt](<url>)`. */
const LINK_HREF = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g

/**
 * Words that say nothing on their own: a run, a line or a text made only of them (and short
 * words) is a common reply, never treated as a copy.
 */
const FILLER: ReadonlySet<string> = new Set(
  (
    'a an the and or but so to of in on at by for with from into onto about over after before up out as if then than ' +
    'it its is are was were be been am has have had do does did will would can could should may might must shall ' +
    'i im me my we us our you your he him his she her they them their this that these those there here what which who why how when ' +
    'not no yes yeah yep nope ok okay sure fine cool nice great good well thanks thank thx ty please pls ' +
    'lgtm sgtm ptal ack nack nit nits agree agreed same too also just now again still yet all any some one more less ' +
    'looks look see seen above below done fixed fix fixes fixing will do sounds sound right hi hello hey lol ' +
    'rebase rebased master main update updated updating address addressed feedback change changes changed typo ci test tests passing green ' +
    'approve approved approving merge merged merging review reviewed comment comments pr issue t s re ve ll d m'
  ).split(' '),
)

/** One line, canonical: markers, links, tags and punctuation gone; its words, lower case. */
function lineWords(raw: string): string[] {
  let line = raw
  for (let prev = ''; prev !== line; ) {
    prev = line
    line = line.replace(LINE_MARKER, '')
  }
  line = line.replace(IMAGE, ' $1 ').replace(LINK, ' $1 ').replace(REF_LINK, ' $1 ').replace(AUTOLINK, ' $1 ').replace(TAG, ' ')
  return line.toLowerCase().match(WORD) ?? []
}

/** A text's lines, canonical (fence lines dropped), with whether each was quoted. */
function canonicalLines(text: string): { readonly words: string[]; readonly quoted: boolean }[] {
  const clean = text.normalize('NFKC').replace(INVISIBLE, '').replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"')
  return clean
    .split(/\r?\n/)
    .filter((l) => !FENCE.test(l))
    .map((l) => ({ words: lineWords(l), quoted: QUOTED.test(l) }))
}

/** `text` in canonical form: its words, lower case, one space apart. */
export function canonicalText(text: string): string {
  return canonicalLines(text)
    .flatMap((l) => l.words)
    .join(' ')
}

/** Whether `words` carry enough that is not filler to count as a copy. */
function meaningful(words: readonly string[]): boolean {
  let content = 0
  for (const w of words) if (!FILLER.has(w)) content += w.length
  return content >= CONTENT_MIN
}

/**
 * Whether a whole members-only text is worth looking for on its own: two content words with
 * {@link WHOLE_CONTENT_MIN} characters together, or one that looks like a secret.
 */
function wholeWorthy(words: readonly string[]): boolean {
  let count = 0
  let chars = 0
  for (const w of words) {
    if (FILLER.has(w)) continue
    if (secretLike(w)) return true
    count += 1
    chars += w.length
  }
  return count >= 2 && chars >= WHOLE_CONTENT_MIN
}

/** Whether a canonical word looks like a secret: letters and digits, 8 or more, not only hex digits (a commit id). */
function secretLike(w: string): boolean {
  return w.length >= SECRET_WORD_MIN && /\p{L}/u.test(w) && /\p{N}/u.test(w) && !/^[0-9a-f]+$/.test(w)
}

/** The addresses of `text`'s links and images that name more than a site (a path, a query). */
function linkAddresses(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(LINK_HREF)) {
    const href = m[1] ?? ''
    try {
      const u = new URL(href)
      if (u.pathname.replace(/\/+$/, '') !== '' || u.search !== '' || u.hash !== '') out.push(href)
    } catch {
      // A relative address: only a path, kept when it says something.
      if (/[\p{L}\p{N}]/u.test(href)) out.push(href)
    }
  }
  return out
}

/** Every run of {@link RUN_WORDS} words of `words` that is meaningful. */
function runsOf(words: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i + RUN_WORDS <= words.length; i++) {
    const run = words.slice(i, i + RUN_WORDS)
    if (meaningful(run)) out.push(run.join(' '))
  }
  return out
}

/** Every span of {@link SPAN_CHARS} characters of `words` (one space apart) starting at a word, when meaningful. */
function spansOf(words: readonly string[]): string[] {
  const joined = words.join(' ')
  const out: string[] = []
  let at = 0
  for (const w of words) {
    if (at + SPAN_CHARS > joined.length) break
    const span = joined.slice(at, at + SPAN_CHARS)
    if (meaningful(span.split(' '))) out.push(span)
    at += w.length + 1
  }
  return out
}

/** Whether `needle` (canonical) is in `hay` (canonical), whole words. */
function hasWords(hay: string, needle: string): boolean {
  return ` ${hay} `.includes(` ${needle} `)
}

/**
 * Members-only texts prepared for {@link quotesMembersText}: build it once for a page's texts
 * (it is rebuilt only when they change), not on every keystroke.
 */
export class QuoteIndex {
  /** Every meaningful run of {@link RUN_WORDS} words. */
  readonly runs: ReadonlySet<string>
  /** Every meaningful span of {@link SPAN_CHARS} characters starting at a word. */
  readonly spans: ReadonlySet<string>
  /** Each text, canonical. */
  readonly texts: readonly string[]
  /**
   * What the reverse check looks for whole: each text of at least {@link WHOLE_MIN} characters, and
   * each line of at least {@link WHOLE_LINE_MIN}, worth it on their own.
   */
  readonly whole: readonly string[]
  /** Every word that looks like a secret. */
  readonly secrets: ReadonlySet<string>

  /** `texts`: members-only texts, as stored (Markdown); their link addresses are looked for too. */
  constructor(texts: readonly string[]) {
    const runs = new Set<string>()
    const spans = new Set<string>()
    const canon = new Set<string>()
    const whole = new Set<string>()
    const secrets = new Set<string>()
    for (const t of [...texts, ...texts.flatMap(linkAddresses)]) {
      const lines = canonicalLines(t)
      const words = lines.flatMap((l) => l.words)
      if (words.length === 0) continue
      const c = words.join(' ')
      if (canon.has(c)) continue
      canon.add(c)
      for (const r of runsOf(words)) runs.add(r)
      for (const s of spansOf(words)) spans.add(s)
      if (c.length >= WHOLE_MIN && meaningful(words) && wholeWorthy(words)) whole.add(c)
      for (const l of lines) {
        const line = l.words.join(' ')
        if (line.length >= WHOLE_LINE_MIN && meaningful(l.words) && wholeWorthy(l.words)) whole.add(line)
      }
      for (const w of words) if (secretLike(w)) secrets.add(w)
    }
    this.runs = runs
    this.spans = spans
    this.texts = [...canon]
    this.whole = [...whole]
    this.secrets = secrets
  }

  /** Whether there is no members-only text to check against. */
  get empty(): boolean {
    return this.texts.length === 0
  }
}

/** Members-only text to check against: prepared, or plain texts (prepared on the spot). */
export type MembersTexts = QuoteIndex | readonly string[]

const NO_INDEX = new QuoteIndex([])

/** `m` prepared. */
export function quoteIndex(m: MembersTexts): QuoteIndex {
  if (m instanceof QuoteIndex) return m
  return m.length === 0 ? NO_INDEX : new QuoteIndex(m)
}

/** The parts of a draft a match is looked for in. */
interface DraftParts {
  readonly words: string[]
  readonly joined: string
  readonly lines: { readonly words: string[]; readonly quoted: boolean }[]
}

function partsOf(text: string): DraftParts {
  const lines = canonicalLines(text)
  const words = lines.flatMap((l) => l.words)
  return { words, joined: words.join(' '), lines }
}

/** Whether `draft` repeats a text of `index`, leaving out what `before` already repeated. */
function matches(draft: DraftParts, index: QuoteIndex, before: DraftParts | null): boolean {
  if (index.empty || draft.words.length === 0) return false
  const was = (needle: string): boolean => before !== null && hasWords(before.joined, needle)
  // A span may end inside a word: it was there before when it starts at a word there.
  const spanWas = (span: string): boolean => before !== null && ` ${before.joined}`.includes(` ${span}`)
  for (const r of runsOf(draft.words)) if (index.runs.has(r) && !was(r)) return true
  for (const s of spansOf(draft.words)) if (index.spans.has(s) && !spanWas(s)) return true
  for (const line of draft.lines) {
    const l = line.words.join(' ')
    if (l.length < (line.quoted ? QUOTED_MIN : LINE_MIN) || !meaningful(line.words)) continue
    if (index.texts.some((t) => hasWords(t, l)) && !was(l)) return true
  }
  for (const w of index.whole) if (w.length <= draft.joined.length && hasWords(draft.joined, w) && !was(w)) return true
  for (const w of draft.words) if (index.secrets.has(w) && !was(w)) return true
  return false
}

/**
 * Whether public text (`draft`) repeats members-only text (`members`; see the module comment for
 * what counts). `before`: an edit's text before it, whose matches are not asked about again;
 * `extra`: more members-only text, such as the writer's own unposted members-only text.
 */
export function quotesMembersText(draft: string, members: MembersTexts, opts: { readonly before?: string; readonly extra?: readonly string[] } = {}): boolean {
  const index = quoteIndex(members)
  const extra = opts.extra === undefined || opts.extra.length === 0 ? null : new QuoteIndex(opts.extra)
  if (index.empty && (extra === null || extra.empty)) return false
  const parts = partsOf(draft)
  const before = opts.before === undefined ? null : partsOf(opts.before)
  return matches(parts, index, before) || (extra !== null && matches(parts, extra, before))
}
