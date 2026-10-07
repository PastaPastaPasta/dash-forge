/**
 * The profile rules both clients share (`docs/contracts/forge-v2.md` §2, forge-community
 * `profile`): what a profile edit may hold, how it is normalized before it is signed, and how
 * a reader interprets `avatarConfig`. The Rust half is `forge_core::rules::profile`; the
 * `profile_input` and `avatar_config` vectors in `forge-contracts/vectors/` hold them equal.
 *
 * The contract bounds each field (characters and UTF-8 bytes) and pins `links` to https. The
 * client rules here add: surrounding whitespace is trimmed and an empty field is absent; no
 * control characters (a bio may hold line breaks and tabs); links are deduplicated, and a
 * link holds no whitespace at all (the contract's `[:space:]` is ASCII only); `avatarConfig`
 * is one of the conventions {@link avatarSpec} reads.
 *
 * Pure: no SDK, no network.
 */

/** The profile's text fields a person edits, in the order every report lists them. */
export const PROFILE_FIELDS = ['displayName', 'bio', 'avatarConfig', 'links', 'location', 'company'] as const
export type ProfileField = (typeof PROFILE_FIELDS)[number]

/** The contract's bounds: characters (Unicode scalar values) and UTF-8 bytes. */
export const PROFILE_LIMITS = {
  displayName: { chars: 60, bytes: 240 },
  bio: { chars: 500, bytes: 1000 },
  avatarConfig: { chars: 200, bytes: 200 },
  location: { chars: 60, bytes: 240 },
  company: { chars: 60, bytes: 240 },
  /** One link. */
  link: { chars: 200, bytes: 800 },
} as const

/** At most this many links (`links.maxItems`). */
export const MAX_LINKS = 4

/** What a profile edit sets; an absent, null or blank field is not set. */
export interface ProfileInput {
  readonly displayName?: string | null
  readonly bio?: string | null
  readonly avatarConfig?: string | null
  readonly links?: readonly string[] | null
  readonly location?: string | null
  readonly company?: string | null
}

/** A normalized profile: only the fields that are set. */
export interface ProfileFields {
  displayName?: string
  bio?: string
  avatarConfig?: string
  links?: string[]
  location?: string
  company?: string
}

/** The result the `profile_input` vectors pin. */
export interface ProfileCheck {
  readonly valid: boolean
  /** The fields that break a rule, in {@link PROFILE_FIELDS} order. */
  readonly invalid: readonly ProfileField[]
  /** The fields to store when valid, else null. */
  readonly normalized: ProfileFields | null
}

/**
 * Unicode `White_Space` (what Rust's `char::is_whitespace` tests). `String.prototype.trim`
 * also strips U+FEFF, which is not `White_Space`, so the two clients would disagree on it.
 */
const WHITE_SPACE = '\\t\\n\\u000B\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000'
const TRIM = new RegExp(`^[${WHITE_SPACE}]+|[${WHITE_SPACE}]+$`, 'g')
const HAS_WHITE = new RegExp(`[${WHITE_SPACE}]`)

/** `s` without leading and trailing Unicode `White_Space`. */
export function trimWhite(s: string): string {
  return s.replace(TRIM, '')
}

const isControl = (cp: number): boolean => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)

/** Characters (Unicode scalar values), as the contract's `maxLength` counts them. */
export function charCount(s: string): number {
  let n = 0
  for (const _ of s) n += 1
  return n
}

/** UTF-8 bytes, as the contract's `maxBytes` counts them. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * Whether `s` is a link a profile may hold: `https://`, a host part (up to the first `/`, `?` or
 * `#`) that is not empty and holds no `@`, no whitespace anywhere, no control characters, at
 * most 200 characters. The contract's pattern `^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$`
 * accepts every link this accepts.
 */
export function isProfileLink(s: string): boolean {
  if (!s.startsWith('https://')) return false
  if (charCount(s) > PROFILE_LIMITS.link.chars || utf8Bytes(s) > PROFILE_LIMITS.link.bytes) return false
  for (const ch of s) {
    if (isControl(ch.codePointAt(0) as number) || HAS_WHITE.test(ch)) return false
  }
  const rest = s.slice('https://'.length)
  const end = rest.search(/[/?#]/)
  const host = end === -1 ? rest : rest.slice(0, end)
  return host !== '' && !host.includes('@')
}

/** An identicon seed: 1-64 of `A-Z a-z 0-9 . _ -`. */
const SEED = /^[A-Za-z0-9._-]{1,64}$/

/** How a reader draws an identity's avatar from `profile.avatarConfig`. */
export type AvatarSpec =
  /** No `avatarConfig`: the identicon of the identity id. */
  | { readonly kind: 'default' }
  /** `identicon` or `identicon:<seed>`: a pattern drawn here from the seed (the identity id by default). */
  | { readonly kind: 'identicon'; readonly seed: string }
  /** An https image URL: loaded only when the viewer asks (it tells the host who looked). */
  | { readonly kind: 'url'; readonly url: string }
  /** Anything else: drawn as the default, and refused by every writer. */
  | { readonly kind: 'invalid' }

/** The {@link AvatarSpec} `config` (a stored `avatarConfig`, or none) names for `identityId`. */
export function avatarSpec(config: string | null | undefined, identityId: string): AvatarSpec {
  if (config === null || config === undefined || config === '') return { kind: 'default' }
  if (charCount(config) > PROFILE_LIMITS.avatarConfig.chars || utf8Bytes(config) > PROFILE_LIMITS.avatarConfig.bytes) return { kind: 'invalid' }
  if (config === 'identicon') return { kind: 'identicon', seed: identityId }
  if (config.startsWith('identicon:')) {
    const seed = config.slice('identicon:'.length)
    return SEED.test(seed) ? { kind: 'identicon', seed } : { kind: 'invalid' }
  }
  if (isProfileLink(config)) return { kind: 'url', url: config }
  return { kind: 'invalid' }
}

/** A text field's value after trimming, or null when it is blank. */
function text(v: string | null | undefined, multiline: boolean): string | null {
  if (v === null || v === undefined) return null
  const t = trimWhite(multiline ? v.replace(/\r\n?/g, '\n') : v)
  return t === '' ? null : t
}

/** Why a text field's (trimmed, non-blank) value is refused, or null. */
function textProblem(field: Exclude<ProfileField, 'links' | 'avatarConfig'>, value: string): string | null {
  const { chars, bytes } = PROFILE_LIMITS[field]
  const multiline = field === 'bio'
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number
    if (isControl(cp) && !(multiline && (ch === '\n' || ch === '\t'))) {
      return multiline ? 'holds a control character (line breaks and tabs are fine)' : 'holds a line break or another control character'
    }
  }
  if (charCount(value) > chars) return `is longer than ${chars} characters`
  if (utf8Bytes(value) > bytes) return `is longer than ${bytes} bytes (UTF-8)`
  return null
}

/** The trimmed, non-blank, deduplicated links of `links`, in order. */
function linkList(links: readonly string[] | null | undefined): string[] {
  const out: string[] = []
  for (const l of links ?? []) {
    const t = trimWhite(l)
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  return out
}

/** Why each field of `input` is refused (a sentence fragment after the field's name), by field. */
export function profileProblems(input: ProfileInput): Partial<Record<ProfileField, string>> {
  const out: Partial<Record<ProfileField, string>> = {}
  for (const f of ['displayName', 'bio', 'location', 'company'] as const) {
    const v = text(input[f], f === 'bio')
    const p = v === null ? null : textProblem(f, v)
    if (p !== null) out[f] = p
  }
  const avatar = text(input.avatarConfig, false)
  if (avatar !== null && avatarSpec(avatar, '').kind === 'invalid') {
    out.avatarConfig = 'is not `identicon`, `identicon:<seed>` (1-64 of A-Z, a-z, 0-9, ., _, -) or an https image link of at most 200 characters'
  }
  const links = linkList(input.links)
  if (links.length > MAX_LINKS) out.links = `are more than ${MAX_LINKS}`
  else {
    const bad = links.find((l) => !isProfileLink(l))
    if (bad !== undefined) out.links = `include ${JSON.stringify(bad)}, which is not an https:// link of at most 200 characters with no spaces`
  }
  return out
}

/** Check and normalize a profile edit: what the `profile_input` vectors pin. */
export function checkProfile(input: ProfileInput): ProfileCheck {
  const problems = profileProblems(input)
  const invalid = PROFILE_FIELDS.filter((f) => problems[f] !== undefined)
  if (invalid.length > 0) return { valid: false, invalid, normalized: null }
  const normalized: ProfileFields = {}
  for (const f of ['displayName', 'bio', 'avatarConfig', 'location', 'company'] as const) {
    const v = text(input[f], f === 'bio')
    if (v !== null) normalized[f] = v
  }
  const links = linkList(input.links)
  if (links.length > 0) normalized.links = links
  return { valid: true, invalid, normalized }
}

/**
 * A profile's `bot` claim: on a bot's profile, the identity that operates it (`operator`); on an
 * operator's, the bots it operates (`operates`, at most 8). Identity ids, base58.
 */
export interface BotClaim {
  readonly operator?: string | null
  readonly operates?: readonly string[] | null
}

/** The most bots one profile lists (`bot.operates` maxItems). */
export const MAX_OPERATED_BOTS = 8

/**
 * The operator of `botId` when both sides agree: the bot's profile names an operator, that is
 * another identity, and the operator's profile lists the bot. Null otherwise: a one-sided claim
 * earns no badge, so nobody can label someone else a bot, and no bot can claim an operator who
 * does not vouch for it. Parity: forge-core `rules::profile::bot_operator` (vectors `profile_bot__*`).
 */
export function botOperator(botId: string, bot: BotClaim | null | undefined, operator: BotClaim | null | undefined): string | null {
  const claimed = bot?.operator
  if (!claimed || claimed === botId) return null
  return (operator?.operates ?? []).includes(botId) ? claimed : null
}
