/**
 * Where a browser merge (or a commit to a PR branch) will store its pack, decided before it
 * starts, so the question is never asked mid-run (review-parity follow-up, approved design):
 *
 * - the merge box shows a Storage row with the repo's resolved policy and an upper-bound price;
 * - when Platform may be used, "Allow storing on Platform, up to ≈X DASH" is offered, checked by
 *   default only when the policy itself lists Platform;
 * - the run passes that answer as a cap (`preAgreedCredits`): a Platform copy within it is not
 *   asked about again; over it, or with no pre-answer, the run's upload step waits inline for
 *   the choice ("Waiting for your choice"), with the price, never behind a modal.
 */

import { estimateChunkCredits } from '../sdk/cost'
import { FANOUT_LEN, LOCATOR_ROW_LEN } from '../browse'
import type { StoragePolicy, StorageProfile } from './profiles'

/** An upper bound on a pack the run will store, from the merge check (bytes and object count). */
export interface PackEstimate {
  readonly bytes: number
  readonly objectCount: number
}

/** When a pack may land on Platform, and why (the sentence the row shows). */
export type PlatformUse =
  /** No storage configured: Platform is the only place (the policy's default). */
  | { readonly kind: 'only'; readonly reason: string }
  /** The policy lists a Platform target. */
  | { readonly kind: 'policy'; readonly reason: string }
  /** The policy's targets are external; Platform only if they fail and the fallback is on. */
  | { readonly kind: 'fallback'; readonly reason: string }
  /** Platform is never used. */
  | { readonly kind: 'never' }

/** The Storage row: what the merge box says before the merge starts. */
export interface StorageChoice {
  /** Where the pack goes, as the row names it. */
  readonly label: string
  readonly platform: PlatformUse
  /** The Platform price for the pack and its browse index, upper bound (credits), or null when Platform is never used. */
  readonly platformCredits: number | null
  /** The pre-answer's default: checked only when the policy itself lists Platform (or there is nothing else). */
  readonly allowByDefault: boolean
}

/** The browse index fragment a merge stores next to its pack: fanout plus a row per object. */
export function fragmentBytes(objectCount: number): number {
  return FANOUT_LEN + LOCATOR_ROW_LEN * objectCount
}

/** Where `policy` would store a pack of `estimate`, and what Platform would cost. */
export function storageChoice(
  policy: StoragePolicy | null,
  profiles: readonly StorageProfile[],
  estimate: PackEstimate | null,
): StorageChoice {
  const byName = new Map(profiles.map((p) => [p.name, p]))
  const isPlatform = (name: string): boolean => byName.get(name)?.settings.kind === 'platform'
  const price = estimate === null ? null : estimateChunkCredits(estimate.bytes) + estimateChunkCredits(fragmentBytes(estimate.objectCount))
  if (policy === null || policy.targets.length === 0) {
    return {
      label: 'Dash Platform (no storage configured)',
      platform: { kind: 'only', reason: 'No storage is configured for browser pushes to this repo.' },
      platformCredits: price,
      allowByDefault: true,
    }
  }
  const onChain = policy.targets.filter(isPlatform)
  const names = policy.targets.join(', ')
  if (onChain.length > 0) {
    return {
      label: names,
      platform: { kind: 'policy', reason: `Your storage policy for this repo includes Dash Platform (${onChain.join(', ')}).` },
      platformCredits: price,
      allowByDefault: true,
    }
  }
  if (policy.platformFallback) {
    return {
      label: `${names}, with Dash Platform as a fallback`,
      platform: { kind: 'fallback', reason: `Only if ${names} cannot confirm the copies your policy needs.` },
      platformCredits: price,
      allowByDefault: false,
    }
  }
  return { label: names, platform: { kind: 'never' }, platformCredits: null, allowByDefault: false }
}

/**
 * Whether a Platform copy of `neededCredits` may go ahead without asking: the merger allowed up
 * to `preAgreedCredits` before the run (null: no pre-answer). Over the cap (the real pack came
 * out larger than the estimate) the run asks, inline.
 */
export function withinPreAgreement(preAgreedCredits: number | null, neededCredits: number): boolean {
  return preAgreedCredits !== null && neededCredits <= preAgreedCredits
}

/**
 * What is left of a pre-answer after a copy: the cap covers the whole run (the pack and its
 * index fragment together), so each Platform copy spends from it. Null stays null (no pre-answer).
 */
export function remainingPreAgreement(preAgreedCredits: number | null, spentCredits: number): number | null {
  return preAgreedCredits === null ? null : Math.max(0, preAgreedCredits - spentCredits)
}

/**
 * The check's estimate, widened for what the check could not know: it wrote its trial commit
 * with a placeholder identity and the message of the moment, while the real commit carries the
 * merger's identity (author and committer) and the message as it is now. Adding their full size
 * (and zlib's worst-case overhead on it) keeps the bound.
 */
export function widenEstimate(estimate: PackEstimate | null, commitText: string): PackEstimate | null {
  if (estimate === null) return null
  const n = new TextEncoder().encode(commitText).length
  return { bytes: estimate.bytes + n + (n >>> 12) + 64, objectCount: estimate.objectCount }
}
