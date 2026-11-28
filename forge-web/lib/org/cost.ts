import { CREDITS_PER_TEXT_BYTE, HEADROOM, previewCredits, type CostPreview } from '../sdk/cost'

/**
 * Pre-sign estimates for a member's own `forge-org` writes (§10.3: an approve about 0.0003 DASH,
 * a proposal about 0.001 DASH), priced like a document with its stored bytes. Upper bounds until
 * measured on testnet.
 */
const MESSAGE_BASE_CREDITS = 30_000_000
const MEMBER_CREDITS = 52_000_000
const SHARE_CREDITS = 46_000_000
const PROPOSAL_BYTES = 2_400
const APPROVE_BYTES = 520
const BROADCAST_BYTES = 420

const messageCredits = (bytes: number): number => Math.ceil((MESSAGE_BASE_CREDITS + bytes * CREDITS_PER_TEXT_BYTE) * HEADROOM)

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
    ...Array.from({ length: proposals }, () => messageCredits(PROPOSAL_BYTES)),
    ...Array.from({ length: approvals }, () => messageCredits(APPROVE_BYTES)),
    ...Array.from({ length: broadcasts }, () => messageCredits(BROADCAST_BYTES)),
    ...(member ? [MEMBER_CREDITS, SHARE_CREDITS] : []),
  ])
}

/** A new request of `parts` writes: its proposals and the creator's own signature on each. */
export const newRequestCost = (parts: number, member = false): CostPreview => orgWritesCost({ proposals: parts, approvals: parts, member })
