/**
 * What to tell the user when a write fails, and which fix to open (D-007, D-042):
 *
 * - this browser's key may not sign (budget spent or short, expired, disabled): the renew /
 *   top-up-key sheet, with the shortfall when Platform named it;
 * - the identity's balance does not cover the write: the top-up sheet;
 * - anything Platform refused otherwise: a plain sentence, never "sent";
 * - only a write that really may still land says "Sent, not yet visible".
 */

import {
  BUDGET_EXCEEDED_CODE,
  CONTEST_FULL_CODE,
  ConsensusRefusal,
  DOCUMENT_EXPIRED_CODE,
  DUPLICATE_UNIQUE_CODE,
  GATE_REFUSED_CODE,
  INVALID_NONCE_CODE,
  INVALID_REVISION_CODE,
  KeyUnusableError,
  type KeyUnusableReason,
  MALFORMED_TRANSITION_CODE,
  SupersededWriteError,
  UnconfirmedWriteError,
  WriterBusyError,
  isNonceUsedError,
} from '../sdk/write'
import { errorMessage } from '../utils'
import { creditsAsDash } from './format'

/** Which budget blocks a write, and by how much (credits): what the top-up / renew sheet shows. */
export interface TopUpReason {
  readonly blocker: 'balance' | 'key-budget' | 'key-expiry' | 'key-disabled' | 'key-missing' | 'key-level'
  readonly shortfall?: bigint
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

/** A plain sentence for a consensus refusal that no sheet fixes. */
function refusalSentence(r: ConsensusRefusal): string {
  const charged =
    r.feeCharged === true ? 'Its processing fee was charged.' : r.feeCharged === false ? 'Nothing was charged.' : 'Check Settings → Spend for any fee.'
  switch (r.code) {
    case GATE_REFUSED_CODE:
      return `Platform refused it: this write needs you to be a member of the repo (or the author). ${charged}`
    case DUPLICATE_UNIQUE_CODE:
      return `Platform refused it: that slot is already taken (someone else wrote the same number or name first). ${charged}`
    case INVALID_REVISION_CODE:
      return `Platform refused it: this was changed since you opened it. Reload and try again. ${charged}`
    case INVALID_NONCE_CODE:
      return 'Platform refused it: another write from this identity (another tab, device or the CLI) went first. Try again. Nothing was charged.'
    case 40127:
      return `Platform refused it: it points at a document from another repo or author. ${charged}`
    case 40128:
      return `Platform refused it: that field cannot be changed once written. ${charged}`
    case 10417:
    case 10421:
      return 'Platform refused it: a field is longer than the contract allows. Shorten it and try again. Nothing was charged.'
    case 10422:
      return `Platform refused it: it breaks one of the contract's rules for this kind of document (for example a sealed field sent in plain text, or a status without the field it needs). ${charged}`
    case 20014:
      return "Platform refused it: this browser's key is not allowed to sign for this contract. Nothing was charged."
    case MALFORMED_TRANSITION_CODE:
      return 'Platform could not read this write, so it was discarded. Nothing was charged. Try again to re-sign it; if it fails again, reload the page to pick up the current app version.'
    case DOCUMENT_EXPIRED_CODE:
      return `Platform refused it: this document has expired (its time to live ran out), so it can no longer be changed. Platform removes it shortly. ${charged}`
    case CONTEST_FULL_CODE:
      return `Platform refused it: that contest already has the most contenders it accepts, so this cannot join it. ${charged}`
    default:
      return `Platform refused it (consensus error ${r.code}). ${charged}`
  }
}

/** The sheet for `blocker`, with the shortfall when the figures name one (`required` above `has`). */
function sheetFor(blocker: TopUpReason['blocker'], has: bigint | undefined, required: bigint | undefined): TopUpReason {
  if (has === undefined || required === undefined || required <= has) return { blocker }
  return { blocker, shortfall: required - has }
}

/** `what` (a sentence start naming `has`), then what Platform needs; '' when a figure is missing. */
function neededDetail(what: (has: string) => string, has: bigint | undefined, required: bigint | undefined): string {
  if (has === undefined || required === undefined) return ''
  return ` ${what(creditsAsDash(Number(has)))}; Platform needs ${creditsAsDash(Number(required))} DASH available for this write.`
}

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
      if (EXPIRY_CODES.has(e.code)) return out("This browser's key has expired, so Platform refused the write. Nothing was charged. Renew the key to continue.", { blocker: 'key-expiry' })
      if (DISABLED_CODES.has(e.code)) return out("This browser's key was disabled on Platform. Nothing was charged. Renew the key to continue.", { blocker: 'key-disabled' })
      // Only a budget exceeded by this write names a shortfall; an exhausted budget has none.
      const detail = neededDetail((dash) => `It has ${dash} DASH left`, remaining, required)
      return out(
        `This browser's key does not have enough budget left, so Platform refused the write. Nothing was charged.${detail}`,
        sheetFor('key-budget', e.code === BUDGET_EXCEEDED_CODE ? remaining : undefined, required),
      )
    }
    if (e.isBalance) {
      const detail = neededDetail((dash) => `Your balance is ${dash} DASH`, balance, required)
      return out(`Your identity's balance is too low, so Platform refused the write. Nothing was charged.${detail}`, sheetFor('balance', balance, required))
    }
    return out(refusalSentence(e))
  }
  // A nonce taken by another write of this identity (another tab, device or the CLI) that
  // reached here unsettled: say so plainly, never as raw SDK text.
  if (isNonceUsedError(e)) return out(refusalSentence(new ConsensusRefusal(INVALID_NONCE_CODE, '')))
  return out(errorMessage(e, 'the write failed'))
}
