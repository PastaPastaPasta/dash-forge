/**
 * What to tell the user when a write fails, and which fix to open (D-007, D-042):
 *
 * - this browser's key may not sign (budget spent or short, expired, disabled): the renew /
 *   top-up-key sheet, with the shortfall when Platform named it;
 * - the identity's balance does not cover the write: the top-up sheet;
 * - anything Platform refused otherwise: a plain sentence, never "sent";
 * - only a write that really may still land says "Sent, not yet visible".
 *
 * Every message has the style guide's three beats (§C rule 8): what happened, whether you were
 * charged, what to do next. Platform's error code appears only where no sentence explains the
 * refusal, as the last words, so a bug report can quote it.
 */

import { isUnreachableError } from '../sdk/unreachable'
import {
  BUDGET_EXCEEDED_CODE,
  CONTEST_FULL_CODE,
  ConsensusRefusal,
  DELETE_RULE_REFUSED_CODE,
  DOCUMENT_EXPIRED_CODE,
  DUPLICATE_UNIQUE_CODE,
  GATE_REFUSED_CODE,
  INVALID_NONCE_CODE,
  INVALID_REVISION_CODE,
  KeyUnusableError,
  type KeyUnusableReason,
  MALFORMED_TRANSITION_CODE,
  UNREADABLE_REFUSAL_CODE,
  SupersededWriteError,
  UnconfirmedWriteError,
  WriterBusyError,
  isNonceUsedError,
} from '../sdk/write'
import { errorMessage } from '../utils'
import { refusedRule } from '../rules/transition'
import { creditsAsDash } from './format'

/** Which budget blocks a write, and by how much (credits): what the top-up / renew sheet shows. */
export interface TopUpReason {
  readonly blocker: 'balance' | 'key-budget' | 'key-expiry' | 'key-disabled' | 'key-missing' | 'key-level'
  readonly shortfall?: bigint
  /**
   * Opened ahead of any write (the low-funds banner, the funds pill, Settings' "Top up"): the
   * sheet then describes the funds as they stand, never "does not cover this write" (QW-047).
   */
  readonly proactive?: boolean
}

export interface WriteFailure {
  readonly message: string
  /** The sheet that fixes it (renew or top up), or null when there is none to offer. */
  readonly sheet: TopUpReason | null
}

const KEY_BLOCKER: Readonly<Record<KeyUnusableReason, TopUpReason['blocker']>> = {
  expired: 'key-expiry',
  disabled: 'key-disabled',
  missing: 'key-missing',
  level: 'key-level',
}

const EXPIRY_CODES: ReadonlySet<number> = new Set([20016, 40219])
const DISABLED_CODES: ReadonlySet<number> = new Set([20006, 40208])

/**
 * A completed check run's evidence (S1) and its set-once fields (D-5): forge-community's
 * conditional `immutable` entries on checkRun (`forge-contracts/schema/build.py`, Platform v5
 * `when` conditions).
 */
const CHECK_EVIDENCE: ReadonlySet<string> = new Set(['summary', 'detailsUrl', 'logUrl', 'logSha256', 'artifacts'])
const CHECK_SET_ONCE: ReadonlySet<string> = new Set(['startedAt', 'completedAt', 'conclusion', 'externalId'])

/** Why a replace was refused as changing an immutable property (40128), naming it when Platform did. */
function frozenField({ property, documentType }: ConsensusRefusal['figures']): string {
  if (!property) return "That field can't be changed once it's set."
  if (documentType === 'checkRun' && CHECK_EVIDENCE.has(property)) {
    return `This check run has finished, so its "${property}" can't change.`
  }
  if (documentType === 'checkRun' && CHECK_SET_ONCE.has(property)) {
    return `This check run's "${property}" is already set and can't change.`
  }
  return `Its "${property}" can't be changed once it's set.`
}

/**
 * What each rule only the mainnet registration has asks for (`build.py --mainnet`: its
 * `propertyConstraints`, 10422, and `deleteConstraints`, 40147), by rule name, in a user's words.
 * Parity: forge-core `user_error::MAINNET_RULE_EXPLANATIONS`.
 */
export const MAINNET_RULE_SENTENCES: Readonly<Record<string, string>> = {
  audMember: 'Only members can write members-only posts.',
  encFraming: "This post's encryption doesn't fit who it's for.",
  authorNoVerdict: "You can't approve or request changes on your own pull request. Post it as a comment instead.",
  tAudSealed: 'A change to a members-only issue or pull request stays members-only.',
  retargetValue: 'A base branch change needs the new base, and nothing else carries one.',
  sealedNoText: "A members-only or private check run can't show a summary, links or artifacts.",
  maintKinds: 'Only a maintainer can make posts public, save environments or send access notices.',
  botPack: 'A bot can push only code, browse indexes and long texts, and never replaces what others pushed.',
  botGrant: "A bot can push only under a maintainer's push grant.",
  grantPrefix: 'This branch is outside the branches the push grant allows.',
  ttl90: 'A push grant has to end after now and within 90 days.',
  oneScope: 'A push grant covers one members-only branch or one public branch prefix, not both.',
  targetOnPublish: 'A public release points at the commit its tag points at, and an encrypted one at none.',
  ownerRowStays: "The owner's own Maintain access can't be removed.",
  keepVerdicts: 'An approval or a change request stays on record. Dismiss it instead.',
  headsOnly: 'A push grant can cover branches only (refs/heads/…), never tags.',
  keepCompleted: 'A finished check run stays on record.',
  rClaim: "Your role in this repo can't make this change.",
  mrClaim: 'A repository key is shared only with maintainers, writers, triage members and readers.',
  k_kinds: "This kind of state change isn't one Forge knows.",
}

/** "You weren't charged." or what was: the second beat of every refusal. */
export function chargedSentence(feeCharged: boolean | null | undefined): string {
  return feeCharged === true ? 'You paid a small processing fee.' : feeCharged === false ? "You weren't charged." : 'Check Settings → Spend for any fee.'
}

/** A plain sentence for a consensus refusal that no sheet fixes. */
function refusalSentence(r: ConsensusRefusal): string {
  const charged = chargedSentence(r.feeCharged)
  switch (r.code) {
    case GATE_REFUSED_CODE:
      return `Only members of this repo, or the author, can do this. ${charged}`
    case DUPLICATE_UNIQUE_CODE:
      return `Someone else took that number or name first. ${charged} Reload and try again.`
    case INVALID_REVISION_CODE:
      return `Someone changed this while you were editing. ${charged} Reload and try again.`
    case INVALID_NONCE_CODE:
      return `Another change from your identity (another tab, device or the CLI) went first. ${chargedSentence(false)} Try again.`
    case 40127:
      return `This belongs to a different repo or author than this page. ${charged} Reload the page and try again.`
    case 40128:
      return `${frozenField(r.figures)} ${charged}`
    case 10417:
    case 10421:
      return `That text is too long. ${charged} Shorten it and try again.`
    case 10422: {
      const why = MAINNET_RULE_SENTENCES[refusedRule(r.message) ?? '']
      if (why !== undefined) return `${why} ${charged}`
      return `Forge couldn't save this. ${charged} Reload to get the latest version of the app, then try again. Error code 10422.`
    }
    case DELETE_RULE_REFUSED_CODE: {
      const why = MAINNET_RULE_SENTENCES[refusedRule(r.message) ?? '']
      return why !== undefined ? `${why} ${charged}` : `This can't be deleted. ${charged} Error code ${DELETE_RULE_REFUSED_CODE}.`
    }
    case 20014:
      return `This browser's key isn't allowed to make this kind of change. ${charged} Error code 20014.`
    case UNREADABLE_REFUSAL_CODE:
      return `Platform refused this, and this version of the app can't read why. ${charged} Reload to get the latest version. If it still fails, report it.`
    case MALFORMED_TRANSITION_CODE:
      return `Platform couldn't read this change, so it was discarded. ${chargedSentence(false)} Try again. If it fails again, reload to get the latest version of the app.`
    case DOCUMENT_EXPIRED_CODE:
      return `This has expired and can't be changed any more. Platform removes it shortly. ${charged}`
    case CONTEST_FULL_CODE:
      return `This contest is full and accepts no more entries. ${charged}`
    default:
      return `Platform refused this change. ${charged} Error code ${r.code}.`
  }
}

/** The sheet for `blocker`, with the shortfall when the figures name one (`required` above `has`). */
function sheetFor(blocker: TopUpReason['blocker'], has: bigint | undefined, required: bigint | undefined): TopUpReason {
  if (has === undefined || required === undefined || required <= has) return { blocker }
  return { blocker, shortfall: required - has }
}

/** `what` (a sentence start naming `has`), then what Platform needs; '' when a figure is missing. */
// Refusal errors stay DASH-only; the confirmation already priced the write with fiat.
function neededDetail(what: (has: string) => string, has: bigint | undefined, required: bigint | undefined): string {
  if (has === undefined || required === undefined) return ''
  return ` ${what(creditsAsDash(Number(has)))}, and this change needs ${creditsAsDash(Number(required))} DASH.`
}

/**
 * A failure no node answered: the browser's fetch failed, the connection dropped, or the request
 * timed out. Narrower than {@link isUnreachableError}, whose "transport error" also wraps a node's
 * answer (a gRPC InvalidArgument refusal travels the same way).
 */
const NO_ANSWER = /failed to fetch|fetch failed|networkerror|network error|load failed|connection (?:refused|reset)|internet disconnected|\bunavailable\b|deadline exceeded|timed out|timeout/i

/** A write that could not reach Platform ({@link NO_ANSWER}). */
export const UNREACHABLE_WRITE = "Couldn't reach Dash Platform, so this change may not have been sent. Check your connection, then try again."

export function writeFailure(e: unknown): WriteFailure {
  const out = (message: string, sheet: TopUpReason | null = null): WriteFailure => ({ message, sheet })
  // Plain sentences of their own: may still land, was superseded, or another write holds the lock.
  if (e instanceof UnconfirmedWriteError || e instanceof SupersededWriteError || e instanceof WriterBusyError) return out(e.message)
  if (e instanceof KeyUnusableError) {
    return out(e.message, { blocker: KEY_BLOCKER[e.reason] })
  }
  if (e instanceof ConsensusRefusal) {
    const { remaining, balance, required } = e.figures
    if (e.isKeyLimit) {
      if (EXPIRY_CODES.has(e.code)) return out("This browser's key has expired. You weren't charged. Renew the key to continue.", { blocker: 'key-expiry' })
      if (DISABLED_CODES.has(e.code)) return out("This browser's key was disabled. You weren't charged. Renew the key to continue.", { blocker: 'key-disabled' })
      // Only a budget exceeded by this write names a shortfall; an exhausted budget has none.
      const detail = neededDetail((dash) => `It has ${dash} DASH left`, remaining, required)
      return out(
        `This browser's key doesn't have enough budget left. You weren't charged.${detail}`,
        sheetFor('key-budget', e.code === BUDGET_EXCEEDED_CODE ? remaining : undefined, required),
      )
    }
    if (e.isBalance) {
      const detail = neededDetail((dash) => `Your balance is ${dash} DASH`, balance, required)
      return out(`Your balance is too low for this change. You weren't charged.${detail}`, sheetFor('balance', balance, required))
    }
    return out(refusalSentence(e))
  }
  // A nonce taken by another write of this identity (another tab, device or the CLI) that
  // reached here unsettled: say so plainly, never as raw SDK text.
  if (isNonceUsedError(e)) return out(refusalSentence(new ConsensusRefusal(INVALID_NONCE_CODE, '')))
  // Nothing answered (a transport error, "Failed to fetch"): say so, never the raw gRPC text. A
  // delete or replace whose read-back timed out may still land, so it says "may not".
  if (isUnreachableError(e) && NO_ANSWER.test(errorMessage(e, ''))) return out(UNREACHABLE_WRITE)
  return out(errorMessage(e, 'the write failed'))
}
