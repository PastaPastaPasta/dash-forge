/**
 * Bot push grants (mixed-visibility DESIGN §4.9 "Pushing", D42; `docs/security/private-repos.md`
 * §24): which of a bot's `pushGrant` documents a client may push under, and how readers mark a
 * bot's push. The Rust twin is forge-core `rules::push_grant`; the `bot_push__*` vectors hold the
 * two byte for byte (`push-grant.conformance.test.ts`).
 *
 * A maintainer's `pushGrant` (forge-core, the mainnet set only) names one Bot row of the repository
 * and either one **public ref prefix** (`prefix`, `refs/heads/bot/<bot name>/` by default; one
 * branch is granted as the prefix of its full name) or one **exact members-only ref** (`scope`, its
 * name hash under the branch key, phase 3F), with an `until` at most 90 days after it was written.
 * Consensus admits a bot's `refUpdate` (`r` 4) only under a grant it names (`pp` for a prefix
 * grant, `pg` for an exact one) that is live for this bot, this repo and this ref, whose granter is
 * still a maintainer (`grantor`), and an exact grant only for a sealed update.
 *
 * What consensus cannot say, clients and the runner do ({@link usable}): a grant written before the
 * bot's **current** member row does not count (a bot removed and added again does not get its push
 * back), and a grant whose granter is no longer a maintainer, or whose `until` passed, is not
 * offered. Readers mark a bot's push ({@link mark}) "outside the access @ci-bot was given" when it
 * named such an older grant, or when the access notice in force when it landed did not allow
 * pushing (a maintainer suspended it).
 *
 * Everything here is pure: callers read the grants, the member rows and the notices.
 */

/** The forge-core document type. */
export const DOC_PUSH_GRANT = 'pushGrant'
/** The `refUpdate` property naming an exact grant. */
export const EXACT_GRANT = 'pg'
/** The `refUpdate` property naming a prefix grant. */
export const PREFIX_GRANT = 'pp'
/** The `refUpdate` property naming the grant's granter (whose maintainer row must still exist). */
export const GRANTOR = 'grantor'
/** The `r` a bot's push documents claim (its writer row's role). */
export const BOT_PUSH_ROLE = 4

const DAY_MS = 86_400_000
/** A grant lasts at most this long after it is written (`ttl90`). */
export const MAX_TTL_MS = 90 * DAY_MS
/** How long a grant lasts when the maintainer does not say. */
export const DEFAULT_TTL_MS = 30 * DAY_MS
/** Clients offer "Renew" from this long before a grant ends. */
export const RENEW_WINDOW_MS = 14 * DAY_MS
/**
 * A grant's `until` is checked against the signer's clock before signing and the block's time at
 * consensus: a client asks for this much less than {@link MAX_TTL_MS} so the two never disagree.
 */
export const TTL_MARGIN_MS = 10 * 60_000
/** Every branch prefix starts here: a grant never covers a tag or another namespace. */
export const BRANCHES = 'refs/heads/'
/** The longest prefix the contract stores (`maxBytes`). */
export const PREFIX_MAX = 255

/** One `pushGrant` document (forge-core `PushGrant`). */
export interface PushGrant {
  /** Its document id (base58). */
  readonly id: string
  /** Its writer, the maintainer who gave the access (base58). */
  readonly granter: string
  /** The bot (base58). */
  readonly bot: string
  /** A public ref prefix, for a prefix grant. */
  readonly prefix?: string
  /** The members-only ref's name hash (hex), for an exact grant. */
  readonly scope?: string
  /** When it ends (ms). */
  readonly until: number
  /** When it was written (`$createdAt`, ms). */
  readonly createdAt: number
}

/** What a bot pushes: a public ref by its full name, or a members-only ref by its name hash under the branch key (hex). */
export type PushTarget = { readonly public: string } | { readonly exact: string }

/** ASCII lowercase only, as Rust's `eq_ignore_ascii_case` compares. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** Whether `g` lets the bot push `target`. */
export function covers(g: PushGrant, target: PushTarget): boolean {
  if ('public' in target) return g.prefix !== undefined && g.scope === undefined && target.public.startsWith(g.prefix)
  return g.prefix === undefined && g.scope !== undefined && asciiLower(g.scope) === asciiLower(target.exact)
}

/** Whether `g` is an exact (members-only) grant. */
export function isExact(g: PushGrant): boolean {
  return g.scope !== undefined
}

/** Whether clients offer "Renew" at `now`: it is live and ends within {@link RENEW_WINDOW_MS}. */
export function renewDue(g: PushGrant, now: number): boolean {
  return now < g.until && g.until - now <= RENEW_WINDOW_MS
}

/**
 * Why a grant cannot be pushed under now: its `until` passed; its granter is no longer a
 * maintainer (the grant died with their row); the bot holds no Bot row here now; it was written
 * before the bot's current member row (a bot removed and added again does not get its push back).
 */
export type Unusable = 'expired' | 'granterGone' | 'notABot' | 'olderThanBotRow'

/** What {@link usable} judges a grant against. */
export interface GrantContext {
  /** Now (ms). */
  readonly now: number
  /** When the bot's current Bot row was written; null when it holds none. */
  readonly botRowAt: number | null
  /** The repository's current maintainers (base58). */
  readonly maintainers: ReadonlySet<string>
}

/**
 * Why grant `g` cannot be pushed under now, or null when it can: its bot holds a Bot row written no
 * later than the grant, its granter is a maintainer, and it has not ended. Checked in that order,
 * so the reason given is the one no renewal fixes first.
 */
export function usable(g: PushGrant, ctx: GrantContext): Unusable | null {
  if (ctx.botRowAt === null) return 'notABot'
  if (g.createdAt < ctx.botRowAt) return 'olderThanBotRow'
  if (!ctx.maintainers.has(g.granter)) return 'granterGone'
  if (ctx.now >= g.until) return 'expired'
  return null
}

/** Why no grant lets the bot push a ref: none covers it, or those that do are not usable (the newest one's reason). */
export type NoGrant = { readonly reason: 'notCovered' } | { readonly reason: 'unusable'; readonly why: Unusable }

/** Total order on two tuples of numbers and a final string (Rust's tuple `Ord`). */
function compareTuple(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number | string
    const y = b[i] as number | string
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

/**
 * The grant a bot pushes `target` under: of the usable grants that cover it, the one that ends
 * last (then the newest, then by id), so a renewal is used as soon as it exists.
 */
export function pick(grants: readonly PushGrant[], target: PushTarget, ctx: GrantContext): { readonly grant: PushGrant } | NoGrant {
  const covering = grants.filter((g) => covers(g, target))
  let best: PushGrant | undefined
  for (const g of covering) {
    if (usable(g, ctx) !== null) continue
    if (best === undefined || compareTuple([g.until, g.createdAt, g.id], [best.until, best.createdAt, best.id]) >= 0) best = g
  }
  if (best !== undefined) return { grant: best }
  let newest: PushGrant | undefined
  for (const g of covering) if (newest === undefined || compareTuple([g.createdAt, g.id], [newest.createdAt, newest.id]) >= 0) newest = g
  if (newest === undefined) return { reason: 'notCovered' }
  return { reason: 'unusable', why: usable(newest, ctx) as Unusable }
}

/**
 * Why a branch pattern cannot be granted: empty; outside `refs/heads/` (a tag or another
 * namespace); a glob other than one trailing `*` (only prefixes can be granted); longer than
 * {@link PREFIX_MAX} bytes, or with a control character, space, `..`, `//`, `\`, `~`, `^` or `:`.
 */
export type PatternRefusal = 'empty' | 'notABranch' | 'notAPrefix' | 'malformed'

// Rust's `str::trim` (Unicode White_Space), not JS's `trim` (which also strips U+FEFF and keeps U+0085).
const WS = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g')
// eslint-disable-next-line no-control-regex
const BAD_CHAR = /[\u0000-\u001f\u007f-\u009f \\~^:]/

/**
 * The prefix a branch pattern grants: `bot/ci-bot/*` and `bot/ci-bot/` grant everything under
 * `refs/heads/bot/ci-bot/`; `gh-pages` grants `refs/heads/gh-pages` (and every longer name that
 * starts with it, which the dialog says); a `refs/heads/…` spelling is taken as given. A glob other
 * than one trailing `*` is refused (consensus compares prefixes only), and so is anything outside
 * `refs/heads/`.
 */
export function prefixOf(pattern: string): { readonly prefix: string } | { readonly refused: PatternRefusal } {
  const p = pattern.replace(TRIM, '')
  if (p === '' || p === '*') return { refused: 'empty' }
  let full: string
  if (p.startsWith('refs/')) {
    if (!p.startsWith(BRANCHES)) return { refused: 'notABranch' }
    full = p
  } else {
    full = `${BRANCHES}${p}`
  }
  if (full.endsWith('*')) full = full.slice(0, -1)
  if (/[*?[]/.test(full)) return { refused: 'notAPrefix' }
  const bytes = new TextEncoder().encode(full).length
  if (bytes <= BRANCHES.length || bytes > PREFIX_MAX || full.includes('..') || full.includes('//') || BAD_CHAR.test(full)) return { refused: 'malformed' }
  return { prefix: full }
}

/** The prefix the grant dialog offers a bot by default: `refs/heads/bot/<name>/`, its name without a leading `@` (its id when it has no name). */
export function defaultPrefix(botName: string): string {
  return `${BRANCHES}bot/${botName.replace(/^@+/, '')}/`
}

/** A prefix as the product names it: the branch part (`bot/ci-bot/`). */
export function shortPrefix(prefix: string): string {
  return prefix.startsWith(BRANCHES) ? prefix.slice(BRANCHES.length) : prefix
}

/** Why an `until` cannot be granted: not after now, or more than 90 days ahead. */
export type UntilRefusal = 'past' | 'tooFar'

/**
 * The `until` a grant written at `now` asks for: `requested`, else {@link DEFAULT_TTL_MS} ahead;
 * refused when not after now or more than 90 days ahead. A request within {@link TTL_MARGIN_MS} of
 * the 90 days is brought in by that margin, so consensus (which judges against the block's time)
 * never refuses what the client accepted.
 */
export function untilFor(now: number, requested: number | null): { readonly until: number } | { readonly refused: UntilRefusal } {
  const latest = now + MAX_TTL_MS - TTL_MARGIN_MS
  if (requested === null) return { until: now + DEFAULT_TTL_MS }
  if (requested <= now) return { refused: 'past' }
  if (requested > now + MAX_TTL_MS) return { refused: 'tooFar' }
  return { until: Math.min(requested, latest) }
}

/**
 * How a reader marks a bot's push: under a grant that counted while its notice allowed pushing
 * (`granted`), or "outside the access @ci-bot was given" (`outside`): the grant it named was written
 * before the bot's current member row, or the notice in force did not allow pushing.
 */
export type PushMark = 'granted' | 'outside'

/**
 * How a reader marks a bot's push that landed at `at` naming `grant` (null when the grant no longer
 * reads: its granter deleted it later, which takes nothing back), given when the bot's current Bot
 * row was written and whether the notice in force at `at` allowed pushing (null: no notice at all,
 * which the grant alone then decides).
 */
export function mark(at: number, grant: PushGrant | null, botRowAt: number | null, noticeAllowsPush: boolean | null): PushMark {
  const older = grant !== null && botRowAt !== null && grant.createdAt < botRowAt
  const beforeRow = botRowAt !== null && at < botRowAt
  return (older && !beforeRow) || noticeAllowsPush === false ? 'outside' : 'granted'
}
