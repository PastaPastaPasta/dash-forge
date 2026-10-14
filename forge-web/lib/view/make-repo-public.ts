/**
 * The copy of Settings → Danger zone → "Make this repo public" (mixed-visibility DESIGN §10, §4.10),
 * as pure functions over the engine's check (`lib/repo/make-public.ts`): what each mode makes
 * public, what stays private, the scan line, the cost, the steps and where a run stands. The facts
 * and their order are `dg repo make-public`'s (`print_check`, `everything_counts`, `print_secrets`).
 */

import { COPY, MAKE_PUBLIC_TOTAL_STEPS, MakePublicError, shortRef, type MakePublicCheck, type MakePublicMode, type MakePublicRef, type MakePublicStep } from '../repo/make-public'
import { errorMessage } from '../utils'
import { aboutDash } from './audience'
import { plural } from './format'

/** How the dialog names each mode. */
export const MODE_LABEL: Readonly<Record<MakePublicMode, string>> = { codeOnly: 'Code only', everything: 'Everything' }

/** The dialog's first line. */
export const MAKE_PUBLIC_FIRST_LINE = "Everyone will be able to see what you choose below. This can't be undone: the repo can never be private again."

/** Under Code only. */
export const CODE_ONLY_STAYS = 'Issues, pull requests, reviews and other branches stay members-only. You can make them public later.'

/** Under Everything, before its counts. */
export const EVERYTHING_TEXT =
  'Everything members could ever read until now: every issue, pull request, comment and review, every earlier edit, deleted and hidden comments, every branch ever pushed, releases, old settings, imported authors and links, and requests sent to bots.'

export const KEEPS_WORKING = 'Members-only content keeps working afterwards, without a pause.'

/** The non-zero counts of what Everything makes readable, in dg's order and words (`everything_counts`). */
export function everythingCounts(check: Pick<MakePublicCheck, 'census' | 'allRefs' | 'deleted' | 'forced'>): string {
  const c = check.census
  const parts: string[] = (
    [
      [c?.issues ?? 0, 'issue', 'issues'],
      [c?.prs ?? 0, 'pull request', 'pull requests'],
      [c?.comments ?? 0, 'comment', 'comments'],
      [c?.reviews ?? 0, 'review', 'reviews'],
      [c?.revisions ?? 0, 'earlier edit', 'earlier edits'],
      [c?.hidden ?? 0, 'hidden item', 'hidden items'],
      [check.allRefs.length, 'live branch or tag', 'live branches and tags'],
      [check.deleted, 'deleted branch', 'deleted branches'],
      [check.forced, 'force-push', 'force-pushes'],
      [c?.releases ?? 0, 'release', 'releases'],
      [c?.botRequests ?? 0, 'request sent to bots', 'requests sent to bots'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => plural(n, one, many))
  const imported = c?.imported ?? []
  if (imported.length > 0) {
    const hosts = [...new Set(imported.map((i) => i.host))].sort()
    parts.push(`imported posts by ${plural(imported.length, 'person', 'people')} from ${hosts.join(', ')}`)
  }
  return parts.length === 0 ? 'nothing written yet' : parts.join(', ')
}

/** "That is …." under Everything. */
export function everythingThatIs(check: Pick<MakePublicCheck, 'census' | 'allRefs' | 'deleted' | 'forced'>): string {
  return `That is ${everythingCounts(check)}.`
}

/** Posts the checker can't read, which become public too, uncounted (null when none). */
export function unreadLine(check: Pick<MakePublicCheck, 'census'>): string | null {
  const n = check.census?.unread ?? 0
  return n > 0 ? `${plural(n, 'post')} you can't read yourself aren't counted.` : null
}

/** "Words by 7 people, including 2 former members, become public." (null when nobody wrote anything). */
export function wordsLine(check: Pick<MakePublicCheck, 'census' | 'former'>): string | null {
  const n = check.census?.authors.length ?? 0
  if (n === 0) return null
  const former = check.former.length > 0 ? `, including ${plural(check.former.length, 'former member')},` : ''
  return `Words by ${plural(n, 'person', 'people')}${former} become public.`
}

/** The scan line when nothing was found, per mode (dg `print_secrets`). */
export function noSecretsLine(mode: MakePublicMode): string {
  return mode === 'everything'
    ? "No secrets found in the code and the posts as they read now. Earlier edits, deleted comments, long posts kept in storage and releases aren't checked."
    : "No secrets found in what you're publishing."
}

/** One finding. */
export function secretLine(place: string): string {
  return `Possible secret in ${place}`
}

/** "Stays private: …, and everything members write from now on." */
export function staysPrivateLine(check: Pick<MakePublicCheck, 'census' | 'environments' | 'narrowerBranches'>): string {
  const letters = plural(check.census?.letters ?? 0, 'message to specific people', 'messages to specific people')
  const narrower =
    check.narrowerBranches > 0 ? `, ${plural(check.narrowerBranches, 'branch only some members can read', 'branches only some members can read')}` : ''
  return `Stays private: ${letters}, ${plural(check.environments, 'environment')}${narrower}, and everything members write from now on.`
}

/** Clients that can't read a repo made public. */
export function oldClientsLine(minClientVersion: string): string {
  return `People on Forge older than ${minClientVersion} can't clone it until they update.`
}

/** The cost of a mode: its writes, plus the code's storage on Platform. */
export function costLine(estimate: { readonly credits: number; readonly storageCredits: number }): string {
  return `Costs about ${aboutDash(estimate.credits)}, plus storing the code: about ${aboutDash(estimate.storageCredits)} on Platform, or nothing extra with your own storage.`
}

/** E812 for one environment (DESIGN §10), and the commands that fix it. */
export function oldFormatLine(env: string): string {
  return `Can't make everything public: environment ${env} has values saved in the old format, which would become public.`
}
export function oldFormatFix(env: string): { readonly resave: string; readonly markChanged: string } {
  return { resave: `dg env resave --env ${env}`, markChanged: `dg env mark-changed --env ${env}` }
}

/** Code only with no branch or tag ticked. */
export const NO_REFS_CHOSEN = 'Choose at least one branch or tag to make public.'

// --- the branches and tags Code only offers ---------------------------------------------------

/** Code only's choices: the default branch with its tags (one box), and every other branch and tag. */
export interface RefChoices {
  /** The default branch, when it has commits. */
  readonly branch: MakePublicRef | null
  /** Its tags (Code only's default), ticked and unticked with it. */
  readonly tags: readonly MakePublicRef[]
  /** Every other branch, then every other tag, by name. */
  readonly others: readonly MakePublicRef[]
}

/** {@link RefChoices} from the check's live refs and its default choice (the default branch and its tags). */
export function refChoices(allRefs: readonly MakePublicRef[], defaults: readonly MakePublicRef[], defaultBranch: string): RefChoices {
  const branch = defaults.find((r) => r.name === `refs/heads/${defaultBranch}`) ?? null
  const tags = defaults.filter((r) => r.name.startsWith('refs/tags/'))
  const taken = new Set([...(branch === null ? [] : [branch.name]), ...tags.map((r) => r.name)])
  const rest = allRefs.filter((r) => !taken.has(r.name))
  const branches = rest.filter((r) => r.name.startsWith('refs/heads/'))
  return { branch, tags, others: [...branches, ...rest.filter((r) => !r.name.startsWith('refs/heads/'))] }
}

/** "main and its 12 tags". */
export function defaultGroupLabel(branch: MakePublicRef, tags: number): string {
  return tags > 0 ? `${shortRef(branch.name)} and its ${plural(tags, 'tag')}` : shortRef(branch.name)
}

/** "9 other branches", "3 tags", "2 other branches and 3 tags". */
export function othersLabel(refs: readonly MakePublicRef[]): string {
  const branches = refs.filter((r) => r.name.startsWith('refs/heads/')).length
  const tags = refs.length - branches
  const b = branches > 0 ? plural(branches, 'other branch', 'other branches') : ''
  const t = tags > 0 ? plural(tags, 'tag') : ''
  return b !== '' && t !== '' ? `${b} and ${t}` : b + t
}

/** How many other branches and tags are listed one by one before the rest fold into one box. */
export const OTHERS_SHOWN = 3

// --- the run --------------------------------------------------------------------------------

/** A row of the step list: the typed confirmation, then the signed steps. */
export type MakePublicRow = 'confirm' | MakePublicStep

/** Each step in plain words. */
export const STEP_LABEL: Readonly<Record<MakePublicRow, string>> = {
  confirm: 'Check and confirm',
  sealOff: 'Give members a fresh key',
  flip: 'Make the repo public',
  config: 'Publish the settings',
  code: 'Publish the code',
  notify: 'Tell members',
  history: 'Publish the history',
}

/** "Making o/r public: 3 of 7 steps done. You can close this page and continue later." */
export function progressLine(label: string, done: number): string {
  return `Making ${label} public: ${done} of ${MAKE_PUBLIC_TOTAL_STEPS} steps done. You can close this page and continue later.`
}

export function interruptedLine(label: string): string {
  return `Making ${label} public was interrupted.`
}

/** The command that finishes it from a terminal. */
export function resumeCommand(label: string): string {
  return `dg repo make-public ${label} --resume`
}

/** What a maintainer reads when only the owner's history step is left. */
export function ownerHistoryLine(label: string): string {
  return `The owner publishes the history: they finish it here or with ${resumeCommand(label)}.`
}

/** "o/r is public (Code only)." */
export function doneLine(label: string, mode: MakePublicMode): string {
  return `${label} is public (${MODE_LABEL[mode]}).`
}

/** What finished, with the owner's history step still to come. */
export function doneButHistoryLine(label: string): string {
  return `${label} is public. The owner publishes the history: they finish it here or with ${resumeCommand(label)}.`
}

/** Branches members pushed to after the flip, never published (null when none). */
export function notPublishedLine(refs: readonly string[]): string | null {
  if (refs.length === 0) return null
  return `Not published: ${refs.map(shortRef).join(', ')}: members-only commits were pushed to ${refs.length === 1 ? 'it' : 'them'} after the repo was made public.`
}

/** The owner, as the non-owner row names them: "@carol", else a short id. */
export function ownerOnlyLine(owner: string): string {
  return `Only the owner (${owner}) can make this repo public.`
}

/** While a step of an earlier run is still signing (the dialog was closed mid-step). */
export const STILL_WORKING = 'Still working on the last step…'

// --- Everything, after Code only -------------------------------------------------------------

/** The Danger zone row of a repo made public with Code only: its owner may publish the rest. */
export const EVERYTHING_LATER_TITLE = 'Make everything public'
export const EVERYTHING_LATER_TEXT =
  "Publish everything members could read while this repo was private: issues, pull requests, reviews, every branch and the history. It can't be undone."

/** The dialog's title. */
export function everythingLaterTitle(label: string): string {
  return `Make everything in ${label} public?`
}

/** The dialog's first line. */
export const EVERYTHING_LATER_FIRST_LINE = "Everyone will be able to see everything written while this repo was private. This can't be undone."

// --- a run that stops ---------------------------------------------------------------------------

/** Words the screen never shows (DESIGN D25, and the internals a raw error may carry). */
const INTERNAL_WORDS =
  /\b(epochs?|anchors?|anchored|unanchored|sealed|seal-?off|lanes?|named|restricted|reveal\w*|wraps?|wrapped|key letters?|disclosures?|grants?|documents?|manifests?|bundles?)\b|\bE\d{3}\b/i

/** A raw error's message as one short sentence the screen may show, or null when it can't. */
function plainReason(raw: string): string | null {
  const first = (raw.split('\n')[0] ?? '').trim()
  if (first === '' || INTERNAL_WORDS.test(first)) return null
  return first.length > 160 ? `${first.slice(0, 157).trimEnd()}…` : first
}

export const RUN_ERRORS = {
  keyRace: "Another maintainer changed the repo's key at the same time. The repo is still private. Run it again to continue.",
  keyUnfinished: "The repo's key change didn't finish. Open Repair on the repo page, then run this again.",
  noEncryptionKey: 'Your identity has no usable encryption key in this browser. Add your current one in Settings → Members-only and private content, then try again.',
  membersChanging: 'The member list is still changing on Platform. Try again in a minute.',
} as const

/**
 * What the dialog says when a run (or its check, `what`) stops: the refusal's own copy, the
 * membership errors of the seal-off rotation in plain words, else "That step didn't finish: …"
 * with the reason only when it holds no internal word (D25).
 */
export function runErrorText(e: unknown, what = "That step didn't finish"): string {
  if (e instanceof MakePublicError) return e.message
  const o = typeof e === 'object' && e !== null ? (e as { name?: unknown; code?: unknown; outcome?: unknown }) : {}
  if (o.name === 'MembersUnsettledError') return RUN_ERRORS.membersChanging
  if (o.name === 'PrivateMembersError') {
    if (o.outcome === 'lost' || o.outcome === 'preempted') return RUN_ERRORS.keyRace
    if (o.code === 'E306') return RUN_ERRORS.noEncryptionKey
    if (o.code === 'E307') return COPY.notKeyHolder
    if (o.code === 'E310' || o.outcome === 'mismatch') return RUN_ERRORS.keyUnfinished
  }
  const reason = plainReason(errorMessage(e, ''))
  return reason === null ? `${what}. Try again.` : `${what}: ${reason}`
}
