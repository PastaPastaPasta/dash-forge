/**
 * What a failed connect or read says, in plain words, naming the part that failed (QW-056,
 * QW-057). Every Platform answer is checked against quorum public keys from one HTTPS service
 * (`quorums.<net>.networks.dash.org`), so "Platform is down", "the key service is down", "the
 * key service lags a rotation" (#212) and "the answer failed its proof" are four different
 * states. The raw error stays behind Details in every one. Pure: callers pass the message.
 */

import { QUORUM_KEY_ENDPOINT, type Network } from '../constants'
import { isProofFailure, isQuorumMiss, isQuorumServiceError } from '../sdk/unreachable'
import { urlHost } from './format'

export interface FailureCopy {
  readonly title: string
  readonly body: string
}

/** The quorum key service's host for `network`, for copy. */
function keyHost(network: Network): string {
  return urlHost(QUORUM_KEY_ENDPOINT[network]) || 'the quorum key service'
}

/**
 * The connect failed (the SDK status is `error`). `cached`: the page still shows what this tab
 * read and checked earlier.
 */
export function connectFailureCopy(message: string, { network, cached }: { network: Network; cached: boolean }): FailureCopy {
  const keep = cached
    ? 'Showing what this tab already read and checked. It is not being re-checked until the connection comes back.'
    : 'Nothing can be read or checked until the connection comes back.'
  if (isQuorumServiceError(message)) {
    return {
      title: "Can't reach the quorum key service right now",
      body: `This app checks every Platform answer against quorum keys from ${keyHost(network)}, and that service isn't answering. Dash Platform itself may be up, but without the keys nothing it returns can be checked. ${keep}`,
    }
  }
  return { title: "Can't reach Dash Platform right now", body: keep }
}

/** A read that nothing answered ({@link isUnreachableError}), for the retrying state. */
export function unreachableReadCopy(message: string, { network, offline }: { network: Network; offline: boolean }): FailureCopy {
  if (offline) return { title: "You're offline", body: 'This page will load as soon as your connection is back.' }
  if (isQuorumMiss(message)) {
    return {
      title: 'Waiting for new quorum keys',
      body: `Platform answered, but its proof is signed by a quorum whose key this app hasn't got from ${keyHost(network)} yet, so the answer can't be checked. That service lists a new quorum a little after the network starts using it. This page will try again by itself.`,
    }
  }
  return { title: "Couldn't reach Dash Platform", body: 'Nothing answered this read. It will try again by itself in a few seconds.' }
}

/** The copy for a read whose answer failed its proof check, or null for any other error. */
export function proofFailureCopy(error: unknown): FailureCopy | null {
  if (!isProofFailure(error)) return null
  return {
    title: "Verification failed: Platform's answer did not match its proof",
    body: 'A node returned data that its cryptographic proof does not back, so none of it is shown. A faulty or dishonest node can cause this. Try again; if it keeps failing, use the CLI against a node you run.',
  }
}
