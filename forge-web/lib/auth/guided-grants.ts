/**
 * The guided wallet grants at first sign-in (FEAT-04). A shipped wallet approves one Forge
 * contract per scan, so a session that signed in with the repositories grant still lacks
 * forge-collab, forge-community and (on a four-contract set) forge-meta. Instead of waiting for
 * a refused write to ask for each, the sign-in sheet walks through them once: "Step 2 of 3".
 * The user can skip any step; a skipped grant is asked for when a write first needs it, as
 * before. Pure state, so the sequence is testable apart from the sheet.
 */

import type { ForgeContractKind } from '../deployments'
import { missingGrants } from './key-registration'

/** What the wallet had not granted when the sequence started, and which steps are done or skipped. */
export interface GuidedGrants {
  /** The grants still missing at the start, in the order they are asked. */
  readonly wanted: readonly ForgeContractKind[]
  /** Steps the user finished or skipped: not asked again in this sequence. */
  readonly passed: readonly ForgeContractKind[]
}

/** The step to show: which contract to ask for, and where it falls in the sequence. */
export interface GuidedStep {
  readonly kind: ForgeContractKind
  /** 1-based; the sign-in itself (repositories and pushes) is step 1. */
  readonly step: number
  readonly of: number
}

/** The sequence for a session that just signed in; null when no grant is missing. */
export function startGuidedGrants(grants: Parameters<typeof missingGrants>[0]): GuidedGrants | null {
  const wanted = missingGrants(grants)
  return wanted.length === 0 ? null : { wanted, passed: [] }
}

/**
 * The next contract to ask for, or null when the sequence is over. A grant that arrived by
 * other means (another tab, an earlier step that covered two contracts) is not asked again.
 */
export function guidedStep(state: GuidedGrants, grants: Parameters<typeof missingGrants>[0]): GuidedStep | null {
  const missing = missingGrants(grants)
  const index = state.wanted.findIndex((k) => missing.includes(k) && !state.passed.includes(k))
  const kind = state.wanted[index]
  if (kind === undefined) return null
  return { kind, step: index + 2, of: state.wanted.length + 1 }
}

/** The sequence after `kind` was finished or skipped. */
export function passGuidedStep(state: GuidedGrants, kind: ForgeContractKind): GuidedGrants {
  return state.passed.includes(kind) ? state : { ...state, passed: [...state.passed, kind] }
}

/** The heading of a step: "Step 2 of 3: approve Forge collaboration". */
export function guidedStepTitle(s: GuidedStep, name: string): string {
  return `Step ${s.step} of ${s.of}: approve ${name}`
}
