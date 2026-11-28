import { HEADROOM, previewCredits, type CostPreview } from '../sdk/cost'

/**
 * A member's own `forge-org` writes, measured on testnet (2026-11-28, forge-org 61dAELEs…, the QA
 * org's first connect, publish, sign and finish): an `orgMember` with its `orgShare` 124.8M credits
 * for the two; a request's four messages (two proposals, two signatures) 227.8M; a small proposal
 * alone 63.7M; signatures and send records about 43M each. Previews add the usual headroom.
 */
const PROPOSAL_CREDITS = 70_000_000
const APPROVE_CREDITS = 45_000_000
const BROADCAST_CREDITS = 45_000_000
const MEMBER_CREDITS = 64_000_000
const SHARE_CREDITS = 61_000_000

const withHeadroom = (credits: number): number => Math.ceil(credits * HEADROOM)

function preview(writes: readonly number[]): CostPreview {
  const credits = writes.reduce((a, b) => a + b, 0)
  const largest = Math.max(0, ...writes)
  return previewCredits(credits, { budget: credits + largest, balance: credits + largest * 4 })
}

export interface OrgWriteCount {
  readonly proposals?: number
  readonly approvals?: number
  readonly broadcasts?: number
  /** The member's first write here: its `orgMember` and `orgShare` come first. */
  readonly member?: boolean
}

export function orgWritesCost({ proposals = 0, approvals = 0, broadcasts = 0, member = false }: OrgWriteCount): CostPreview {
  return preview([
    ...Array.from({ length: proposals }, () => withHeadroom(PROPOSAL_CREDITS)),
    ...Array.from({ length: approvals }, () => withHeadroom(APPROVE_CREDITS)),
    ...Array.from({ length: broadcasts }, () => withHeadroom(BROADCAST_CREDITS)),
    ...(member ? [withHeadroom(MEMBER_CREDITS), withHeadroom(SHARE_CREDITS)] : []),
  ])
}

/** A new request of `parts` writes: its proposals and the creator's own signature on each. */
export const newRequestCost = (parts: number, member = false): CostPreview => orgWritesCost({ proposals: parts, approvals: parts, member })
