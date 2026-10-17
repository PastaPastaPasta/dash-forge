/**
 * Who can read what a composer posts, and what a reader who cannot read something is shown
 * (DESIGN §4.1, §10, D14, D25; product review H8, M3). Pure: no SDK, no React.
 *
 * Vocabulary (D25): **Public** and **Members** (the chip), **Maintainers**, **Writers and
 * maintainers** and **Specific people** (a message to people, sent when it is posted),
 * "members-only" (the adjective), "Turn on members-only content" (a repo), "Set up your
 * encryption key" (an identity). Never "letter" in what a user reads: a "message".
 */

import { creditsToDash } from '../sdk/cost'
import { postKeyLetterCredits } from '../env/write'
import { holdsMembersKey } from '../rules/roles'
import { MAX_LETTER_RECIPIENTS, inGroup, letterGroupLabel, letterGroupWhenSent, type LetterGroup, type LetterRefusal } from '../rules/letters'
import type { Membership, Role } from '../rules/v2'
import { LETTER_TITLE, type LetterFacts, type MembersOnlyItem } from '../repo/private-content'
import { BOT_WRITE_TEXT, NO_KEY_SHARED_TEXT } from '../repo/members-writes'
import type { MembersAccess } from './repo-view'
import { plural } from './format'
import { splitRefs } from './markdown'

/**
 * Who a composer writes for: everyone, the repo's members, or specific people (a role group
 * resolved when it is posted, or people named one by one: {@link LetterAsk}).
 */
export type ComposerAudience = 'public' | 'members' | 'specificPeople'

/** Whether an audience is anything but public (members-only or specific people). */
export function notPublic(a: ComposerAudience | undefined | null): boolean {
  return a === 'members' || a === 'specificPeople'
}

/**
 * Who a message to specific people goes to, as its composer asks (`letterPlan`'s input): a role
 * group (`group`, its people as they are when posted), people named one by one (`people`, the
 * writer aside), or, in a thread of messages to specific people, the picker's `exact` list (null:
 * the thread's people re-listed as they are now).
 */
export interface LetterAsk {
  readonly group: LetterGroup | null
  readonly people: readonly string[]
  readonly exact: readonly string[] | null
}

/** Nobody named yet, no group: the start of "Specific people…". */
export const NO_LETTER_ASK: LetterAsk = { group: null, people: [], exact: null }

/** The repo's members who hold its members key: how many, and how many are readers or CI bots. */
export interface MembersCount {
  readonly total: number
  readonly readers: number
  /** Runner identities that are also members (an owner made them one, DESIGN D23). */
  readonly bots: number
}

/** The identities of `members` who hold a repo's members key (each once). */
export function keyHolders(members: readonly Membership[]): Set<string> {
  return new Set(members.filter((m) => holdsMembersKey(m.role)).map((m) => m.identity))
}

/**
 * {@link MembersCount} of `members`: each key holder once, a reader counted as a reader only when
 * that is their only role, and `runners` (the repo's CI runner identities) counted when they are
 * members too. A runner is never a member by being a runner.
 */
export function membersCount(members: readonly Membership[], runners: Iterable<string> = []): MembersCount {
  const holders = keyHolders(members)
  const roles = new Map<string, Role[]>()
  for (const m of members) if (holders.has(m.identity)) roles.set(m.identity, [...(roles.get(m.identity) ?? []), m.role])
  const readers = [...roles.values()].filter((r) => r.every((x) => x === 'reader')).length
  const bots = new Set([...runners].filter((r) => holders.has(r))).size
  return { total: holders.size, readers, bots }
}

/** The chip's words: `Public`, `Members (12)` (a message to specific people: {@link letterChipLabel}). */
export function audienceLabel(audience: ComposerAudience, members: number | null): string {
  if (audience === 'public') return 'Public'
  if (audience === 'specificPeople') return 'Specific people'
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
  const extras = [c.readers > 0 ? `${c.readers} with Read access` : null, c.bots > 0 ? plural(c.bots, 'CI bot') : null].filter((x): x is string => x !== null)
  const counted = extras.length === 0 ? `${c.total}` : `${c.total}, including ${extras.join(' and ')}`
  return `Current and future members of this repo (${counted}). Members removed later keep what they could already read. Maintainers can make it public later.`
}

/** Why the Members option cannot be picked right now, or `ok`. */
export type MembersOption = 'ok' | 'turn-on' | 'ask-maintainer' | 'no-key' | 'locked' | 'no-key-shared' | 'former' | 'bot'

/**
 * Whether a composer's Members option is on offer to a viewer who can choose it, with members-only
 * content on in the repo: they are a member, whatever state their key is in (unlock or set one up
 * first). Not when it is still to be turned on, or the viewer is no member, a former one or a bot.
 */
export function membersChoiceOffered(choice: Pick<AudienceChoice, 'members'> | null): boolean {
  const m = choice?.members
  return m === 'ok' || m === 'locked' || m === 'no-key' || m === 'no-key-shared'
}

/**
 * Why the specific-people options (Maintainers, Writers and maintainers, Specific people…)
 * cannot be picked right now, or `ok`: `no-key`, this browser holds no encryption key; `locked`,
 * this tab must unlock first; `cant-reply`, a thread of messages to specific people this viewer
 * can't read (only the people it was sent to can reply).
 */
export type LetterOption = 'ok' | 'no-key' | 'locked' | 'cant-reply'

/** What a composer offers: a fixed audience, or a choice with each option's state. */
export interface AudienceChoice {
  /** The audience it starts on (the thread's: DESIGN §10 "the default is the context"). */
  readonly initial: ComposerAudience
  /** Members' state when the viewer may be offered it, else null (only Public, or only Members). */
  readonly members: MembersOption | null
  /** Public is offered (hidden inside a members-only thread: a public reply is refused, §3.3). */
  readonly publicAllowed: boolean
  /** The specific-people options' state when they are offered, else null. */
  readonly letters: LetterOption | null
  /**
   * Only Specific people is offered, and no role group (a thread of messages to specific
   * people: its people re-listed, DESIGN D26).
   */
  readonly lettersOnly: boolean
  /**
   * The thread was written while the repo (made public since) was private and stays
   * members-only, yet takes public replies (DESIGN §4.10, L3): a public reply says so
   * ({@link whilePrivateNote}). `member`: the writer may reply as Members too.
   */
  readonly whilePrivate?: { readonly member: boolean }
}

/** What a composer knows about messages to specific people (DESIGN §4.2, §10). */
export interface LetterOffer {
  /** This composer may write one (every issue, comment and review; not a new pull request). */
  readonly offered: boolean
  /** The viewer's encryption key in this browser (null: signed out, or not read yet). */
  readonly key: 'open' | 'locked' | 'none' | null
  /** The thread is a message to specific people: `open` when the viewer read it, else `unreadable`. */
  readonly thread?: 'open' | 'unreadable'
}

const NO_LETTERS: LetterOffer = { offered: false, key: null }

/**
 * The specific-people options' state for a viewer whose key here is `key`: offered only to one
 * who holds an encryption key in this browser (a member without one is told about it under
 * Members; nobody else is shown a picker only to hear they can't use it).
 */
function letterOptionOf(key: LetterOffer['key']): LetterOption | null {
  return key === 'open' ? 'ok' : key === 'locked' ? 'locked' : null
}

/**
 * What a composer offers (DESIGN §3.3, §10: "the default is the context"; options the context
 * forbids are hidden). `parent`: the thread's audience; `lane`: the viewer's members access
 * (`home.lane`, absent for a non-member or a signed-out viewer); `maintainer`: the viewer may
 * turn members-only content on; `letters`: what it knows about messages to specific people.
 *
 * - A public thread: everything, Public first. A members-only thread: no Public; Members first.
 * - A thread of messages to specific people: only Specific people, its people re-listed.
 * - A private repo (everything in it is members-only): null without the specific-people options
 *   (no chip); with them, Members first and no Public.
 */
export function audienceChoice(input: {
  readonly visibility: 'public' | 'private'
  readonly parent: ComposerAudience
  readonly lane: MembersAccess | undefined
  readonly maintainer: boolean
  readonly letters?: LetterOffer
  /**
   * The thread was written while the repo (made public since) was private and is still
   * members-only (`writtenWhilePrivate` with audience Members): it takes public replies too.
   */
  readonly writtenWhilePrivate?: boolean
}): AudienceChoice | null {
  const offer = input.letters ?? NO_LETTERS
  const letters = offer.offered ? letterOptionOf(offer.key) : null
  if (input.parent === 'specificPeople') {
    return { initial: 'specificPeople', members: null, publicAllowed: false, letters: offer.thread === 'unreadable' ? 'cant-reply' : (letters ?? 'no-key'), lettersOnly: true }
  }
  if (input.visibility === 'private') {
    return letters === null ? null : { initial: 'members', members: 'ok', publicAllowed: false, letters, lettersOnly: false }
  }
  if (input.parent === 'members' && input.writtenWhilePrivate === true) {
    // An old members-only thread of a repo made public takes public and members-only replies
    // (DESIGN §4.10, L3): a member who can write members-only content stays on its audience; anyone
    // else replies in public, and is told so.
    const member = input.lane?.access === 'member'
    return {
      initial: member ? 'members' : 'public',
      members: input.lane === undefined ? null : member ? 'ok' : optionOf(input.lane, input.maintainer),
      publicAllowed: true,
      letters,
      lettersOnly: false,
      whilePrivate: { member },
    }
  }
  if (input.parent === 'members') {
    return { initial: 'members', members: input.lane?.access === 'member' ? 'ok' : optionOf(input.lane, input.maintainer), publicAllowed: false, letters, lettersOnly: false }
  }
  if (input.lane === undefined) return { initial: 'public', members: null, publicAllowed: true, letters, lettersOnly: false }
  return { initial: 'public', members: optionOf(input.lane, input.maintainer), publicAllowed: true, letters, lettersOnly: false }
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
    case 'former':
      return 'former'
    case 'bot':
      return 'bot'
    default:
      return maintainer ? 'turn-on' : 'ask-maintainer'
  }
}

/**
 * The label of a post written while the repo (made public since) was private (DESIGN §10, "Old
 * content"): public for everyone when the owner made everything written then public, else
 * members-only.
 */
export function writtenWhilePrivateLabel(members: boolean): string {
  return members ? 'Members-only · written while private' : 'Public · written while private'
}

/**
 * The line under a public reply to a thread written while the repo was private, which stays
 * members-only (DESIGN §4.10; dg's note on the same reply): for a member who chose Public, that
 * the reply is public while the thread stays members-only; for anyone else, whose reply is public
 * by default, that the thread was written while the repo was private.
 */
export function whilePrivateNote(member: boolean): string {
  return member
    ? 'Your reply is public: everyone can read it. This conversation stays members-only.'
    : 'This conversation was written while this repo was private. Your reply is public: everyone can read it.'
}

/** A members access that may unlock or set up a key to read (a member who can't read yet). */
export function memberCantRead(lane: MembersAccess | undefined): 'locked' | 'no-key' | 'no-key-shared' | null {
  const a = lane?.access
  return a === 'locked' || a === 'no-key' || a === 'no-key-shared' ? a : null
}

/**
 * Whether a reader who cannot open a thread of a repo whose visibility is `visibility` may reply
 * to it from its members-only page (DESIGN §4.10, L3): only a members-only thread written while
 * the repo (made public since) was private takes public replies, and the reply is public ("Public"
 * only, with {@link whilePrivateNote}). A thread written since takes members-only replies alone,
 * one to specific people only theirs, and a private repo none from a reader without its key.
 * Not to a member who may yet read it: their key session still loading (`laneLoading`), or a key
 * they have not unlocked, set up or been given (`lane`, {@link memberCantRead}); non-members,
 * former members and a member holding no key for that old thread are offered it.
 */
export function publicReplyOffered(
  visibility: 'public' | 'private',
  target: { readonly placeholder: { readonly audience: 'members' | 'specificPeople' }; readonly writtenWhilePrivate?: true },
  reader: { readonly lane?: MembersAccess | undefined; readonly laneLoading?: boolean | undefined } = {},
): boolean {
  if (reader.laneLoading === true || memberCantRead(reader.lane) !== null) return false
  return visibility === 'public' && target.writtenWhilePrivate === true && target.placeholder.audience === 'members'
}

/**
 * A member removed since, who still reads what was written while they were one (DESIGN §12 item
 * 6): why they can't write members-only content, or reply in a members-only thread.
 */
export const FORMER_MEMBER_TEXT = "You're no longer a member of this repo, so you can't write members-only content."

/** What the picker says under a Members option that cannot be picked. */
export const MEMBERS_OPTION_TEXT: Readonly<Record<Exclude<MembersOption, 'ok'>, string>> = {
  'turn-on': 'Members-only content is off in this repo.',
  'ask-maintainer': 'Ask a maintainer to turn on members-only content for this repo.',
  'no-key': 'Members-only content needs your encryption key in this browser.',
  locked: 'Unlock this tab to write members-only content.',
  // E311 (DESIGN §10): the one copy of it, as the repo banner and the write refusal say it.
  'no-key-shared': NO_KEY_SHARED_TEXT,
  former: FORMER_MEMBER_TEXT,
  bot: BOT_WRITE_TEXT,
}

/** The line under a placeholder of a bot's post whose author is no bot here now, for a member who holds the key. */
export const NOT_A_BOT_TEXT = "Posted as a bot by someone who isn't a bot here now."

/** What the picker says under the specific-people options when they cannot be picked. */
export const LETTER_OPTION_TEXT: Readonly<Record<Exclude<LetterOption, 'ok'>, string>> = {
  'no-key': 'Sending to specific people needs your encryption key in this browser.',
  locked: 'Unlock this tab to send to specific people.',
  'cant-reply': 'Only the people this was sent to can reply.',
}

/** Set up your encryption key (an identity, D25): where the link goes. */
export const SET_UP_KEY = 'Set up your encryption key'

/** "Turn on members-only content" (a repo, D25). */
export const TURN_ON = 'Turn on members-only content'

/**
 * The measured cost of turning members-only content on for `holders` members, the signer
 * included: one settings-free anchor and one key wrap each (dg `keys::enable_estimate`, measured
 * on devnet sakura; about 0.00185 DASH for two members), and each of `bots` sent its key for
 * members-only posts (one letter each, §23).
 */
export const ENABLE_ANCHOR_CREDITS = 37_000_000
export const ENABLE_WRAP_CREDITS = 74_000_000
export function enableEstimate(holders: number, bots = 0): number {
  return ENABLE_ANCHOR_CREDITS + ENABLE_WRAP_CREDITS * Math.max(1, holders) + postKeyLetterCredits() * Math.max(0, bots)
}

/** A DASH amount for copy: two significant figures, as "about 0.0019 DASH" reads (style guide rule 6). */
export function aboutDash(credits: number): string {
  const dash = creditsToDash(credits)
  if (dash <= 0) return '0 DASH'
  return `${Number(dash.toPrecision(2)).toString()} DASH`
}

/** The "Turn on members-only content?" sheet's paragraphs (DESIGN §10, one idea per sentence). */
export function turnOnText(holders: number, bots = 0): readonly string[] {
  // Bots get no members key, only a key for their own members-only posts.
  const withBots = bots > 0 ? `, and a key for members-only posts for ${plural(bots, 'bot')},` : ''
  return [
    'Members of this repo will be able to post comments, reviews and issues only members can read. Everyone can still see that something was posted, by whom and when.',
    // Only the maintainer turning it on holds the key so far: say so, rather than "1 member".
    holders <= 1
      ? `You're the only member so far. Setting up your key${withBots} costs about ${aboutDash(enableEstimate(1, bots))}.`
      : `Setting up keys for ${plural(holders, 'member')}${withBots} costs about ${aboutDash(enableEstimate(holders, bots))}. Each later removal costs about the same again.`,
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

/** "3 people", "1 person". */
export function peopleCount(n: number): string {
  return plural(n, 'person', 'people')
}

/**
 * "Members-only comment", "Members-only pull request"; a specific-people one with its public
 * recipient count, "Comment to 3 people", "Pull request to 1 person" (DESIGN D14, §2.3), else
 * {@link LETTER_TITLE}.
 */
export function membersOnlyTitle(type: MembersOnlyItem['type'], audience: MembersOnlyItem['audience'] = 'members', recipients?: number): string {
  if (audience !== 'specificPeople') return `Members-only ${membersOnlyNoun(type)}`
  if (recipients === undefined || recipients < 1) return LETTER_TITLE
  const noun = membersOnlyNoun(type)
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} to ${peopleCount(recipients)}`
}

/** A placeholder's title: {@link membersOnlyTitle} of its type, audience and recipient count. */
export function placeholderTitle(item: Pick<MembersOnlyItem, 'type' | 'why' | 'audience' | 'recipientCount'>): string {
  return membersOnlyTitle(item.type, isLetter(item) ? 'specificPeople' : 'members', item.recipientCount)
}

/** Whether a placeholder stands for a specific-people document rather than a members-only one. */
export function isLetter(item: Pick<MembersOnlyItem, 'why' | 'audience'>): boolean {
  return item.why === 'letter' || item.audience === 'specificPeople'
}

/**
 * A labelled count that includes members-only items: "5 comments (4 members-only)", or
 * "5 comments"; messages to specific people are said apart ("Issues 3 (1 members-only, 1 to
 * specific people)"), never as members-only.
 */
export function countWithMembersOnly(total: number, membersOnly: number, one: string, many = `${one}s`, letters = 0): string {
  const base = plural(total, one, many)
  const parts = [membersOnly > 0 ? `${membersOnly} members-only` : null, letters > 0 ? `${letters} to specific people` : null].filter((x): x is string => x !== null)
  return parts.length > 0 ? `${base} (${parts.join(', ')})` : base
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
  /** Who reads it: the members key's holders, or a message's recipients. */
  readonly holders: ReadonlySet<string>
  /** The holders' names (DPNS labels, lower case), for matching @mentions. */
  readonly holderNames: ReadonlySet<string>
  readonly thread: { readonly author: string; readonly authorName: string; readonly kind: 'issue' | 'pull' } | null
}): string[] {
  if (!notPublic(input.audience)) return []
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

// ---------------------------------------------------------------------------
// Messages to specific people (DESIGN §4.2, §10)
// ---------------------------------------------------------------------------

/** The picker's role-group options, in order. */
export const LETTER_GROUPS: readonly LetterGroup[] = ['maintainers', 'writers']

/** A role group's option label with its people now: "Maintainers (3)". */
export function groupLabel(group: LetterGroup, count: number | null): string {
  return count === null ? letterGroupLabel(group) : `${letterGroupLabel(group)} (${count})`
}

/** The picker's line under a role group (DESIGN §10). */
export function groupSentence(group: LetterGroup, count: number): string {
  return group === 'maintainers'
    ? `Sent to the ${count} current maintainers. People who become maintainers later see it only if someone adds them.`
    : `Sent to the ${count} people with Write access or more right now.`
}

/** The picker's label of the one-by-one option. */
export const SPECIFIC_PEOPLE = 'Specific people…'

/** The picker's line under Specific people… (DESIGN §10). */
export const SPECIFIC_PEOPLE_SENTENCE = `You're always included. Up to ${MAX_LETTER_RECIPIENTS} people. Replying with someone added lets them read from that reply on, not earlier ones.`

/** A group too big to send to (DESIGN §10): "Writers and maintainers is 23 people. …". */
export function tooManyText(group: LetterGroup | null, count: number): string {
  const most = `A message can go to at most ${MAX_LETTER_RECIPIENTS}.`
  return group === null ? `That's ${peopleCount(count)}. ${most} Choose All members or fewer people.` : `${letterGroupLabel(group)} is ${peopleCount(count)}. ${most} Choose All members or pick people.`
}

/** What the people picker says of someone whose browser identity has no usable encryption key. */
export const NO_KEY_PERSON = "can't receive members-only messages yet"

/** "@a", "@a and @b", "@a, @b and @c". */
function mentions(people: readonly string[], nameOf: (id: string) => string): string {
  return listWords(people.map((p) => `@${nameOf(p)}`))
}

/** "a", "a and b", "a, b and c". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** Why a message to specific people can't be sent as asked (DESIGN §10; `letterPlan`'s refusal). */
export function letterRefusalText(r: LetterRefusal, nameOf: (id: string) => string, group: LetterGroup | null = null): string {
  switch (r.error) {
    case 'noRecipients':
      return 'Choose who to send it to.'
    case 'tooMany':
      return tooManyText(group, r.count)
    case 'narrower':
      return `Replies can't leave out people who could read earlier messages: ${mentions(r.people, nameOf)}.`
    case 'noEncryptionKey':
      return `${mentions(r.people, nameOf)} can't receive members-only messages yet.`
    case 'notMembers':
      return r.people.length === 1
        ? `${mentions(r.people, nameOf)} isn't a member of this repo, so they can't be added to a members-only conversation.`
        : `${mentions(r.people, nameOf)} aren't members of this repo, so they can't be added to a members-only conversation.`
  }
}

/** The plan's people left out for want of a key: "dana has no encryption key and won't receive it." */
export function skippedText(people: readonly string[], nameOf: (id: string) => string): string | null {
  if (people.length === 0) return null
  const who = listWords(people.map(nameOf))
  return people.length === 1 ? `${who} has no encryption key and won't receive it.` : `${who} have no encryption key and won't receive it.`
}

/** A person added to a thread's people (DESIGN D26): "frank will see messages from now on, not earlier ones." */
export function wideningText(person: string): string {
  return `${person} will see messages from now on, not earlier ones.`
}

/** Replying in a thread of messages to specific people the viewer can't read. */
export const ONLY_RECIPIENTS_REPLY = 'Only the people this was sent to can reply.'

/** The tooltip of an opened message's list of people (DESIGN §4.2 reader rule). */
export const AS_LISTED = 'as listed by the sender'

/**
 * Who an opened message to specific people is visible to (DESIGN §10; the reader rule's list,
 * "as listed by the sender"): every recipient by name, the viewer as "you" placed last, "alice,
 * bob and you". A role-group message names the people it went to as the group, then the group
 * when sent, "alice, bob, carol (maintainers when sent)"; its writer is among them while they
 * are still in that group, else follows: " and dana", or " and you" when the viewer wrote it.
 * `nameOf`: a display name (DPNS label, else a short id); `writerInGroup`: whether the writer
 * (slot 0) is in the group now.
 */
export function letterLabel(input: {
  readonly letter: LetterFacts
  readonly viewer: string | null
  readonly nameOf: (id: string) => string
  readonly writerInGroup?: boolean
}): string {
  const { letter, viewer, nameOf } = input
  const named = (ids: readonly string[]): string[] => {
    const others = ids.filter((id) => id !== viewer).map(nameOf)
    return ids.some((id) => id === viewer) ? [...others, 'you'] : others
  }
  if (letter.group === null) return listWords(named(letter.recipients))
  const writer = letter.recipients[0]
  const inGroupNow = input.writerInGroup === true
  const listed = inGroupNow || writer === undefined ? letter.recipients : letter.recipients.slice(1)
  const base = `${named(listed).join(', ')} (${letterGroupWhenSent(letter.group)})`
  if (inGroupNow || writer === undefined) return base
  return `${base} and ${writer === viewer ? 'you' : nameOf(writer)}`
}

/** Whether `writer` is in `group` now (the owner always is). */
export function inGroupNow(group: LetterGroup, writer: string, owner: string, members: readonly Membership[]): boolean {
  return writer === owner || members.some((m) => m.identity === writer && inGroup(group, m.role))
}

/** The chip's words for a message being written to specific people: `Maintainers (3)`, `alice, bob and you`. */
export function letterChipLabel(ask: LetterAsk, input: { readonly recipients: readonly string[] | null; readonly groupCount: number | null; readonly viewer: string | null; readonly nameOf: (id: string) => string }): string {
  if (ask.exact === null && ask.group !== null && ask.people.length === 0) return groupLabel(ask.group, input.groupCount)
  const people = input.recipients ?? [...(input.viewer === null ? [] : [input.viewer]), ...(ask.exact ?? ask.people)]
  return people.length === 0 ? 'Specific people' : listWords([...people.filter((p) => p !== input.viewer).map(input.nameOf), ...(input.viewer !== null && people.includes(input.viewer) ? ['you'] : [])])
}

/** The cap of a message to specific people that does not fit (no long body for one: its slots are in `enc`). */
export function letterTooLongText(recipients: number): string {
  return `This message is too long to send to ${peopleCount(recipients)}: shorten it or send it to fewer people.`
}

/** An edit of a message whose recipient can no longer receive it. */
export function letterEditKeylessText(people: readonly string[], nameOf: (id: string) => string): string {
  return `${mentions(people, nameOf)} can't receive it any more, so this message can't be edited.`
}

/** An event with a value on a message to specific people (decided for 2A: refused before signing). */
export const LETTER_EVENT_VALUE_TEXT = "Labels, milestones and assignees can't be set on a message to specific people yet."

/**
 * "Forward to…" (DESIGN D26): the quoted text with attribution, as a reply's start: `> @alice
 * wrote:` and then each line quoted.
 */
export function forwardText(authorName: string, body: string): string {
  const quoted = body.split('\n').map((l) => (l === '' ? '>' : `> ${l}`))
  return [`> @${authorName} wrote:`, '>', ...quoted, '', ''].join('\n')
}

/** The quote confirmation (DESIGN §3.3, product H8), word for word. */
export const QUOTE_CONFIRM = "You're quoting a members-only comment into a public reply. Everyone will be able to read the quoted text."

export { QuoteIndex, quoteIndex, quotesMembersText, type MembersTexts } from './quote-check'

/**
 * What a write makes public, for `quotesMembersText`: its text, or null when it is
 * members-only by its own audience (`own`: the chip's, or the edited item's) or by its thread's
 * (`thread`: a members-only issue or PR keeps everything in it members-only).
 */
export function publicTextOf(text: string, own: ComposerAudience | undefined, thread?: ComposerAudience): string | null {
  return (own ?? 'public') === 'public' && (thread ?? 'public') === 'public' ? text : null
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
  if (input.verdict !== 'requestChanges' || !notPublic(input.audience) || reads(input.holders, input.author)) return null
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
