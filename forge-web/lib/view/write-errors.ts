/**
 * What to tell the user when a write fails, and whether the failure is this browser's key
 * running out (budget spent, expired): those open the renew sheet instead of a raw error.
 */

import { ConsensusRefusal, UnconfirmedWriteError } from '../sdk/write'
import { errorMessage } from '../utils'

export function writeErrorMessage(e: unknown): { message: string; keyLimit: boolean } {
  if (e instanceof UnconfirmedWriteError) return { message: e.message, keyLimit: false }
  if (e instanceof ConsensusRefusal && e.isKeyLimit) {
    return { message: "This browser's key can't sign any more (budget spent or expired). Renew it to continue.", keyLimit: true }
  }
  if (e instanceof ConsensusRefusal && e.code === 40120) {
    return { message: "Platform refused it: you are not a member (or not the author) that this write needs. The fee was charged.", keyLimit: false }
  }
  return { message: errorMessage(e), keyLimit: false }
}
