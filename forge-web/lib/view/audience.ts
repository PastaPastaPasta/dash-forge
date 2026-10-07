/**
 * Who can read what a composer posts, and what a reader who cannot read something is shown
 * (DESIGN §4.1, §10, D14, D25; product review H8, M3). Pure: no SDK, no React.
 *
 * Vocabulary (D25): **Public** and **Members** (the chip), "members-only" (the adjective),
 * "Turn on members-only content" (a repo), "Set up your encryption key" (an identity). Specific
 * people and Maintainers are later options and are not offered here.
 */

import { creditsToDash } from '../sdk/cost'
import { holdsMembersKey } from '../rules/roles'
import type { Membership, Role } from '../rules/v2'
import { LETTER_TITLE, type MembersOnlyItem } from '../repo/private-content'
import { NO_KEY_SHARED_TEXT } from '../repo/members-writes'
import type { MembersAccess } from './repo-view'
import { plural } from './format'
import { splitRefs } from './markdown'

/** Who a composer writes for in this release: everyone, or the repo's members. */
export type ComposerAudience = 'public' | 'members'

/** The repo's members who hold its members key: how many, and how many are readers or CI bots. */
export interface MembersCount {
  readonly total: number
  readonly readers: number
  /** Runner identities that are also members (an owner made them one, DESIGN D23). */
  readonly bots: number
}

/** The identities of `members` who hold a repo's members key (each once). */
export function keyHolders(members: readonly Membership[], visibility: 'public' | 'private'): Set<string> {
  return new Set(members.filter((m) => holdsMembersKey(m.role, visibility)).map((m) => m.identity))
}

/**
 * {@link MembersCount} of `members`: each key holder once, a reader counted as a reader only when
 * that is their only role, and `runners` (the repo's CI runner identities) counted when they are
 * members too. A runner is never a member by being a runner.
 */
export function membersCount(members: readonly Membership[], visibility: 'public' | 'private', runners: Iterable<string> = []): MembersCount {
  const holders = keyHolders(members, visibility)
  const roles = new Map<string, Role[]>()
  for (const m of members) if (holders.has(m.identity)) roles.set(m.identity, [...(roles.get(m.identity) ?? []), m.role])
  const readers = [...roles.values()].filter((r) => r.every((x) => x === 'reader')).length
  const bots = new Set([...runners].filter((r) => holders.has(r))).size
  return { total: holders.size, readers, bots }
}

/** The chip's words: `Public`, `Members (12)`. */
export function audienceLabel(audience: ComposerAudience, members: number | null): string {
  if (audience === 'public') return 'Public'
  return members === null ? 'Members' : `Members (${members})`
}

/** The picker's question. */
export const AUDIENCE_QUESTION = 'Who can read this?'

/** The picker's line under Public. */
export const PUBLIC_SENTENCE = 'Anyone can read it, now and forever.'

/**
 * The picker's line under Members (DESIGN §10, product M3), with the counts said honestly: readers
 * and CI bots only when there are any.
 */
export function membersSentence(c: MembersCount): string {
  const extras = [c.readers > 0 ? plural(c.readers, 'reader') : null, c.bots > 0 ? plural(c.bots, 'CI bot') : null].filter((x): x is string => x !== null)
  const counted = extras.length === 0 ? `${c.total}` : `${c.total}, including ${extras.join(' and ')}`
  return `Current and future members of this repo (${counted}). Members removed later keep what they could already read. Maintainers can make it public later.`
}

/** Why the Members option cannot be picked right now, or `ok`. */
export type MembersOption = 'ok' | 'turn-on' | 'ask-maintainer' | 'no-key' | 'locked' | 'no-key-shared'

/** What a composer offers: a fixed audience, or a choice with the Members option's state. */
export interface AudienceChoice {
  /** The audience it starts on (the thread's: DESIGN §10 "the default is the context"). */
  readonly initial: ComposerAudience
  /** Members' state when the viewer may be offered it, else null (only Public, or only Members). */
  readonly members: MembersOption | null
  /** Public is offered (hidden inside a members-only thread: a public reply is refused, §3.3). */
  readonly publicAllowed: boolean
}

/**
 * What a public repo's composer offers (null for a private repo: everything in it is
 * members-only). `parent`: the thread's audience; `lane`: the viewer's members access
 * (`home.lane`, absent for a non-member or a signed-out viewer); `maintainer`: the viewer may
 * turn members-only content on.
 */
export function audienceChoice(input: {
  readonly visibility: 'public' | 'private'
  readonly parent: ComposerAudience
  readonly lane: MembersAccess | undefined
  readonly maintainer: boolean
}): AudienceChoice | null {
  if (input.visibility === 'private') return null
  if (input.parent === 'members') return { initial: 'members', members: input.lane?.access === 'member' ? 'ok' : optionOf(input.lane, input.maintainer), publicAllowed: false }
  if (input.lane === undefined) return { initial: 'public', members: null, publicAllowed: true }
  return { initial: 'public', members: optionOf(input.lane, input.maintainer), publicAllowed: true }
}

function optionOf(lane: MembersAccess | undefined, maintainer: boolean): MembersOption {
  switch (lane?.access) {
    case 'member':
      return 'ok'
    case 'no-key':
      return 'no-key'
    case 'locked':
      return 'locked'
    case 'no-key-shared':
      return 'no-key-shared'
    default:
      return maintainer ? 'turn-on' : 'ask-maintainer'
  }
}

/** What the picker says under a Members option that cannot be picked. */
export const MEMBERS_OPTION_TEXT: Readonly<Record<Exclude<MembersOption, 'ok'>, string>> = {
  'turn-on': 'Members-only content is off in this repo.',
  'ask-maintainer': 'Ask a maintainer to turn on members-only content for this repo.',
  'no-key': 'Members-only content needs your encryption key in this browser.',
  locked: 'Unlock this tab to write members-only content.',
  // E311 (DESIGN §10): the one copy of it, as the repo banner and the write refusal say it.
  'no-key-shared': NO_KEY_SHARED_TEXT,
}

/** Set up your encryption key (an identity, D25): where the link goes. */
export const SET_UP_KEY = 'Set up your encryption key'

/** "Turn on members-only content" (a repo, D25). */
export const TURN_ON = 'Turn on members-only content'

/**
 * The measured cost of turning members-only content on for `holders` members, the signer
 * included: one settings-free anchor and one key wrap each (dg `keys::enable_estimate`, measured
 * on devnet sakura; about 0.00185 DASH for two members).
 */
export const ENABLE_ANCHOR_CREDITS = 37_000_000
export const ENABLE_WRAP_CREDITS = 74_000_000
export function enableEstimate(holders: number): number {
  return ENABLE_ANCHOR_CREDITS + ENABLE_WRAP_CREDITS * Math.max(1, holders)
}

/** A DASH amount for copy: two significant figures, as "about 0.0019 DASH" reads (style guide rule 6). */
export function aboutDash(credits: number): string {
  const dash = creditsToDash(credits)
  if (dash <= 0) return '0 DASH'
  return `${Number(dash.toPrecision(2)).toString()} DASH`
}

/** The "Turn on members-only content?" sheet's paragraphs (DESIGN §10, one idea per sentence). */
export function turnOnText(holders: number): readonly string[] {
  return [
    'Members of this repo will be able to post comments, reviews and issues only members can read. Everyone can still see that something was posted, by whom and when.',
    // Only the maintainer turning it on holds the key so far: say so, rather than "1 member".
    holders <= 1
      ? `You're the only member so far. Setting up your key costs about ${aboutDash(enableEstimate(1))}.`
      : `Setting up keys for ${plural(holders, 'member')} costs about ${aboutDash(enableEstimate(holders))}. Each later removal costs about the same again.`,
    'People using older Forge builds will see fewer things until they update.',
  ]
}

/** How a placeholder names what it stands for. */
export function membersOnlyNoun(type: MembersOnlyItem['type']): string {
  switch (type) {
    case 'issue':
      return 'issue'
    case 'patch':
      return 'pull request'
    case 'review':
      return 'review'
    default:
      return 'comment'
  }
}

export { LETTER_TITLE }

/** "Members-only comment", "Members-only pull request"; a specific-people one, {@link LETTER_TITLE}. */
export function membersOnlyTitle(type: MembersOnlyItem['type'], audience: MembersOnlyItem['audience'] = 'members'): string {
  return audience === 'specificPeople' ? LETTER_TITLE : `Members-only ${membersOnlyNoun(type)}`
}

/** Whether a placeholder stands for a specific-people document rather than a members-only one. */
export function isLetter(item: Pick<MembersOnlyItem, 'why' | 'audience'>): boolean {
  return item.why === 'letter' || item.audience === 'specificPeople'
}

/** A labelled count that includes members-only items: "5 comments (4 members-only)", or "5 comments". */
export function countWithMembersOnly(total: number, membersOnly: number, one: string, many = `${one}s`): string {
  const base = plural(total, one, many)
  return membersOnly > 0 ? `${base} (${membersOnly} members-only)` : base
}

/** The locked member's one line: "3 members-only comments" (DESIGN §4.8, §10). */
export function lockedCount(items: readonly Pick<MembersOnlyItem, 'type'>[]): string {
  const comments = items.filter((i) => i.type === 'comment' || i.type === 'review').length
  return plural(comments, 'members-only comment')
}

/** Whether `id` can read members-only content of the repo whose key holders are `holders`. */
function reads(holders: ReadonlySet<string>, id: string): boolean {
  return holders.has(id)
}

/**
 * The composer's warnings (product H8): who can't read what is being written. With Members
 * chosen, the thread's author and every @mentioned name that is not a key holder's
 * (`holderNames`: the holders' names as this tab knows them). Public text has none.
 */
export function audienceWarnings(input: {
  readonly audience: ComposerAudience
  readonly text: string
  readonly holders: ReadonlySet<string>
  /** The holders' names (DPNS labels, lower case), for matching @mentions. */
  readonly holderNames: ReadonlySet<string>
  readonly thread: { readonly author: string; readonly authorName: string; readonly kind: 'issue' | 'pull' } | null
}): string[] {
  if (input.audience !== 'members') return []
  const out: string[] = []
  const said = new Set<string>()
  const t = input.thread
  if (t !== null && !reads(input.holders, t.author)) {
    out.push(`@${t.authorName} opened this ${t.kind === 'pull' ? 'PR' : 'issue'} and won't be able to read this.`)
    said.add(t.authorName.toLowerCase())
  }
  for (const p of splitRefs(input.text)) {
    if (p.t !== 'mention') continue
    const name = p.name.replace(/\.dash$/, '')
    if (said.has(name) || input.holderNames.has(name)) continue
    said.add(name)
    out.push(`@${p.label} won't be able to read this.`)
  }
  return out
}

/** The quote confirmation (DESIGN §3.3, product H8), word for word. */
export const QUOTE_CONFIRM = "You're quoting a members-only comment into a public reply. Everyone will be able to read the quoted text."

/** One line of a draft, as a quote check compares it: no quote markers, spaces collapsed. */
function normalized(line: string): string {
  return line.replace(/^\s*(>\s*)+/, '').replace(/\s+/g, ' ').trim()
}

/** Shortest quoted line (`> …`) and shortest plain line that count as copied text. */
const QUOTED_MIN = 4
const COPIED_MIN = 24

/**
 * Whether a public draft repeats members-only text this page shows (`membersTexts`): a quoted
 * line (`> …`) of at least {@link QUOTED_MIN} characters, or any line of at least
 * {@link COPIED_MIN}, found in one of them. Posting it publicly needs a confirmation.
 */
export function quotesMembersText(draft: string, membersTexts: readonly string[]): boolean {
  if (membersTexts.length === 0) return false
  const haystacks = membersTexts.map((t) => t.replace(/\s+/g, ' '))
  for (const raw of draft.split('\n')) {
    const quoted = /^\s*>/.test(raw)
    const line = normalized(raw)
    if (line.length < (quoted ? QUOTED_MIN : COPIED_MIN)) continue
    if (haystacks.some((h) => h.includes(line))) return true
  }
  return false
}

/**
 * What a write makes public, for {@link quotesMembersText}: its text, or null when it is
 * members-only by its own audience (`own`: the chip's, or the edited item's) or by its thread's
 * (`thread`: a members-only issue or PR keeps everything in it members-only).
 */
export function publicTextOf(text: string, own: ComposerAudience | 'specificPeople' | undefined, thread?: ComposerAudience | 'specificPeople'): string | null {
  return (own ?? 'public') === 'public' && (thread ?? 'public') === 'public' ? text : null
}

/**
 * What an edit adds: the lines of `after` that `before` did not have. An edit is checked for
 * quotes on these alone, so fixing a typo in text a members-only reply quotes never asks.
 */
export function addedText(before: string, after: string): string {
  const had = new Set(before.split('\n').map((l) => l.trim()))
  return after
    .split('\n')
    .filter((l) => !had.has(l.trim()))
    .join('\n')
}

/** A pending review's comments by audience: "Submitting 1 members-only and 2 public comments" (product H8). */
export function submitSummary(counts: { readonly members: number; readonly public: number }): string | null {
  if (counts.members === 0) return null
  if (counts.public === 0) return `Submitting ${plural(counts.members, 'members-only comment')}`
  return `Submitting ${counts.members} members-only and ${plural(counts.public, 'public comment')}`
}

/**
 * The blocking-review question (product H8): a request for changes whose text is members-only on
 * a public PR whose author can't read it. Null when it does not apply: a members-only PR (its
 * thread takes no public line, and its author reads it or can't read the PR at all), or members
 * not read yet (`holders` empty: nobody is known to be unable to read it).
 */
export function publicLineQuestion(input: {
  readonly verdict: 'approve' | 'requestChanges' | 'comment'
  readonly audience: ComposerAudience
  /** The PR itself is members-only. */
  readonly prMembersOnly?: boolean
  readonly author: string
  readonly authorName: string
  readonly holders: ReadonlySet<string>
}): string | null {
  if (input.prMembersOnly === true || input.holders.size === 0) return null
  if (input.verdict !== 'requestChanges' || input.audience !== 'members' || reads(input.holders, input.author)) return null
  return `This review blocks the PR, but its text is members-only and @${input.authorName} can't read it. Add one public line?`
}

/** The "View as public" banner (DESIGN §10). */
export const VIEWING_AS_PUBLIC = 'Viewing as the public sees it.'

/**
 * What a member being removed could read, in plain words, for the removal dialog (stream 1F).
 * `extras`: lines other features add (environments, from stream 1I).
 */
export function removalReads(lane: boolean, extras: readonly string[] = []): string[] {
  return [...(lane ? ['Members-only issues, comments and reviews posted so far'] : []), ...extras]
}
